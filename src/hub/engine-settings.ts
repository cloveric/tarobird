import { resolvePiExecutable } from "../runtime/pi-executable.js";
import { resolveOmpExecutable } from "../runtime/omp-executable.js";
import { createHash, randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFileMutex } from "../state/file-mutex.js";
import { resolveEngineExecutable } from "../runtime/engine-process.js";
import { deepseekExecutableOverride, resolveDeepSeekExecutable } from "../runtime/deepseek-executable.js";
import {
  EngineSettingsReadError,
  ENGINE_COMMANDS,
  ENGINE_ENV_KEYS,
  engineSettingsFile,
  hostBaselineDirectories,
  hostEngineEnvironment,
  readEngineDiscoveryCache,
  readHostEngineSettings,
  resolveDiscoveredEngines,
  storedEngineSettingsSchema,
  writeEngineDiscoveryCache,
  type LiveEngineDiscovery,
  type StoredEngineSettings,
} from "../runtime/host-engine-settings.js";
import {
  engineSettingsUpdateSchema,
  hostEngineSchema,
  type EngineDiscoveryRule,
  type EngineSettingsState,
  type EngineSettingsUpdate,
} from "../client-protocol/engine-settings.js";
import {
  cachedExecutableVersion,
  DiscoveryAbortedError,
  diagnoseExecutableCandidates,
  lookupEnvCaseInsensitive,
  mergeTaggedDirectories,
  probeExecutableVersion,
  runEnvironmentDiscovery,
  type CommandRunner,
  type DanglingLinkInfo,
  type TaggedDirectory,
} from "../host-cli/engine-discovery.js";
import { refreshWindowsRegistryPath } from "../runtime/windows-registry-path.js";
import { HubError } from "./store.js";

export type EngineDiscoveryOptions = {
  forceRefresh?: boolean;
  /** refresh() already force-read the Windows registry PATH: a forced discovery reuses it (one query). */
  registryRefreshed?: boolean;
  probeShell?: boolean;
  probeVersions?: boolean;
  runner?: CommandRunner;
  timeoutMs?: number;
};

export class HubEngineSettings {
  private liveDiscovery?: LiveEngineDiscovery;
  private warmInFlight?: Promise<LiveEngineDiscovery>;
  private discoverySequence = 0;
  private publishedDiscoverySequence = 0;
  private closing = false;
  private readonly cacheWrites = new Set<Promise<void>>();
  /** Aborted by close(): kills running discovery children (login shell, package managers, `--version`). */
  private readonly stopDiscovery = new AbortController();
  private readonly discoveryTasks = new Set<Promise<unknown>>();
  get hasDiscoverySnapshot(): boolean { return this.liveDiscovery !== undefined; }
  private track<T>(task: Promise<T>): Promise<T> {
    this.discoveryTasks.add(task);
    void task.finally(() => this.discoveryTasks.delete(task)).catch(() => undefined);
    return task;
  }
  constructor(readonly directory: string, readonly base: () => NodeJS.ProcessEnv) {}
  private read(): StoredEngineSettings {
    try { return readHostEngineSettings(this.directory); }
    catch (error) { if (error instanceof EngineSettingsReadError) throw new HubError(error.message, 503); throw error; }
  }
  async refresh(force = true): Promise<void> {
    await refreshWindowsRegistryPath(this.base(), { force });
  }

  /** Effective Host environment combining strict manual settings, baseline PATH,
   * known manager directories, and the latest live/cached discovery snapshot. */
  environment(): NodeJS.ProcessEnv {
    return hostEngineEnvironment(this.directory, this.base(), this.read(), { liveDiscovery: this.liveDiscovery });
  }

  private buildHostTaggedDirs(base: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv, platform = process.platform): TaggedDirectory[] {
    const windows = platform === "win32", sep = windows ? ";" : ":";
    const home = windows
      ? lookupEnvCaseInsensitive(base, "USERPROFILE", "win32") ?? lookupEnvCaseInsensitive(base, "HOME", "win32") ?? os.homedir()
      : base.HOME ?? base.USERPROFILE ?? os.homedir();
    // Host PATH, cached Windows registry PATH, then known folders: the order workers use.
    const host = hostBaselineDirectories(base, home, platform);
    const envDirs = (lookupEnvCaseInsensitive(env, "PATH", platform) ?? "").split(sep).filter(Boolean).map((dir): TaggedDirectory => ({ dir, rule: "path" }));
    return mergeTaggedDirectories([
      host.pathDirs.map((dir): TaggedDirectory => ({ dir, rule: "path" })),
      host.registryDirs.map((dir): TaggedDirectory => ({ dir, rule: "windows-registry" })),
      host.knownDirs.map((dir): TaggedDirectory => ({ dir, rule: "known-directory" })),
      envDirs,
    ], platform);
  }

  private async publishDiscovery(snapshot: LiveEngineDiscovery, sequence: number, platform: NodeJS.Platform): Promise<void> {
    if (sequence < this.publishedDiscoverySequence) return;
    this.publishedDiscoverySequence = sequence;
    this.liveDiscovery = snapshot;
    // Once the owner has begun closing, the state folder is no longer ours to write.
    if (this.closing) return;
    const write = writeEngineDiscoveryCache(this.directory, {
      paths: snapshot.paths ?? {},
      searchDirs: snapshot.dirs,
    }, platform);
    this.cacheWrites.add(write);
    try { await write; } finally { this.cacheWrites.delete(write); }
  }

  /** Stop discovery for good: no new step starts, running discovery children are
   * killed and their exit awaited, and a cache write already in progress finishes,
   * so nothing writes into HOME or the state folder after the owner has closed. */
  async close(): Promise<void> {
    this.closing = true;
    this.stopDiscovery.abort();
    await Promise.allSettled([...this.discoveryTasks]);
    await Promise.allSettled([...this.cacheWrites]);
  }

  /** Run environment discovery (login shell, package managers, and cached Windows
   * registry PATH) without executing engine `--version` commands, hydrating the
   * shared live discovery snapshot and opportunistic discovery cache. */
  async warmDiscovery(options: Pick<EngineDiscoveryOptions, "forceRefresh" | "registryRefreshed" | "probeShell" | "runner" | "timeoutMs"> = {}): Promise<LiveEngineDiscovery> {
    if (this.closing) return this.liveDiscovery ?? {};
    if (!options.forceRefresh && !options.runner && this.warmInFlight) {
      return this.warmInFlight;
    }
    const sequence = ++this.discoverySequence;
    const work = this.track((async (): Promise<LiveEngineDiscovery> => {
      const base = this.base();
      const platform = process.platform, windows = platform === "win32";
      const home = windows
        ? lookupEnvCaseInsensitive(base, "USERPROFILE", "win32") ?? lookupEnvCaseInsensitive(base, "HOME", "win32") ?? os.homedir()
        : base.HOME ?? base.USERPROFILE ?? os.homedir();
      const probeShell = options.probeShell !== false;
      const probe = probeShell
        ? await runEnvironmentDiscovery({
          baseEnv: base,
          commands: Object.values(ENGINE_COMMANDS),
          home,
          platform,
          forceRefresh: options.forceRefresh,
          registryRefreshed: options.registryRefreshed,
          timeoutMs: options.timeoutMs,
          runner: options.runner,
          signal: this.stopDiscovery.signal,
        })
        : { at: Date.now(), shell: { ok: false, status: "skipped" as const, pathDirs: [], resolvedCommands: {} }, packageManagerDirs: [], windowsRegistryDirs: [] };
      let settings: StoredEngineSettings;
      try { settings = readHostEngineSettings(this.directory); }
      catch { settings = { format: 1, revision: "default", paths: {}, receipts: [] }; }
      const cache = readEngineDiscoveryCache(this.directory, platform);
      const resolved = resolveDiscoveredEngines({
        directory: this.directory,
        base,
        settings,
        cache,
        probe,
        platform,
      });
      const snapshot: LiveEngineDiscovery = {
        dirs: resolved.discoveredDirs,
        paths: resolved.discoveredPaths,
      };
      await this.publishDiscovery(snapshot, sequence, platform);
      return snapshot;
    })());

    if (!options.forceRefresh && !options.runner) {
      this.warmInFlight = work;
      void work.finally(() => {
        if (this.warmInFlight === work) this.warmInFlight = undefined;
      }).catch(() => undefined);
    }
    return work;
  }

  status(requestId?: string): EngineSettingsState {
    const settings = this.read(), base = this.base(), platform = process.platform;
    const windows = platform === "win32", p = windows ? path.win32 : path.posix;
    const cache = readEngineDiscoveryCache(this.directory, platform);
    const baselineEnv = hostEngineEnvironment(this.directory, base, settings, { skipDiscoveryCache: true });
    const env = hostEngineEnvironment(this.directory, base, settings, { discoveryCache: cache, liveDiscovery: this.liveDiscovery });
    const receipt = requestId ? settings.receipts.find(item => item.requestId === requestId) : settings.receipts.at(-1);
    const taggedDirs = this.buildHostTaggedDirs(base, env, platform);
    return {
      revision: settings.revision,
      platform,
      searchPaths: taggedDirs.map(item => item.dir),
      receipt: receipt ? { requestId: receipt.requestId, revision: receipt.revision } : null,
      engines: hostEngineSchema.options.map(id => {
        const hasManual = !!settings.paths[id];
        const explicit = id === "deepseek"
          ? deepseekExecutableOverride(base, platform) !== undefined
          : !!lookupEnvCaseInsensitive(base, ENGINE_ENV_KEYS[id], platform);
        const defaultCmd = ENGINE_COMMANDS[id];
        const remembered = !hasManual && !explicit ? (this.liveDiscovery?.paths?.[id] ?? cache.paths[id]) : undefined;
        let command: string;
        let executable: string | null = null;
        let rule: EngineDiscoveryRule | null = null;
        let danglingLinks: DanglingLinkInfo[] = [];

        if (hasManual) {
          command = settings.paths[id]!;
          const diagnosed = diagnoseExecutableCandidates(command, taggedDirs, env, platform);
          executable = diagnosed.executable ?? resolveEngineExecutable(command, env, platform) ?? null;
          rule = executable ? "setting" : null;
          danglingLinks = diagnosed.danglingLinks;
        } else if (explicit) {
          command = id === "deepseek" ? resolveDeepSeekExecutable(baselineEnv, platform) : lookupEnvCaseInsensitive(base, ENGINE_ENV_KEYS[id], platform)!;
          const diagnosed = diagnoseExecutableCandidates(command, taggedDirs, env, platform);
          executable = diagnosed.executable ?? resolveEngineExecutable(command, env, platform) ?? null;
          rule = executable ? "environment" : null;
          danglingLinks = diagnosed.danglingLinks;
        } else {
          const pathDiagnosed = diagnoseExecutableCandidates(defaultCmd, taggedDirs, env, platform);
          const autoCmd = id === "pi" ? resolvePiExecutable(baselineEnv, platform) : id === "omp" ? resolveOmpExecutable(baselineEnv, platform) : id === "deepseek" ? resolveDeepSeekExecutable(baselineEnv, platform) : defaultCmd;
          command = autoCmd;
          if (p.isAbsolute(autoCmd)) {
            const knownDiagnosed = diagnoseExecutableCandidates(autoCmd, taggedDirs, baselineEnv, platform);
            executable = knownDiagnosed.executable ?? resolveEngineExecutable(autoCmd, baselineEnv, platform) ?? null;
            rule = executable ? "known-directory" : null;
            danglingLinks = pathDiagnosed.danglingLinks.length ? pathDiagnosed.danglingLinks : knownDiagnosed.danglingLinks;
          } else {
            executable = pathDiagnosed.executable ?? resolveEngineExecutable(autoCmd, env, platform) ?? null;
            rule = executable ? (pathDiagnosed.rule ?? "path") : null;
            danglingLinks = pathDiagnosed.danglingLinks;
          }
          if (!executable && remembered && resolveEngineExecutable(remembered, env, platform)) {
            executable = remembered;
            rule = "auto-discovered";
          } else if (executable && remembered && executable === remembered && !resolveEngineExecutable(autoCmd, baselineEnv, platform)) {
            rule = "auto-discovered";
          }
        }
        return {
          id,
          override: settings.paths[id] ?? null,
          source: hasManual ? "setting" : explicit ? "environment" : "auto",
          command,
          executable,
          available: !!executable,
          rule,
          ...(danglingLinks.length ? { danglingLinks } : {}),
        };
      }),
    };
  }

  async statusAsync(requestId?: string, options: EngineDiscoveryOptions = {}): Promise<EngineSettingsState> {
    // After close() began, answer from what is known without starting any discovery child.
    if (this.closing) return this.statusWithDiscovery(requestId, { ...options, probeShell: false, probeVersions: false, forceRefresh: false });
    try { return await this.track(this.statusWithDiscovery(requestId, options)); }
    catch (error) { if (error instanceof DiscoveryAbortedError) throw new HubError("hub_draining", 503); throw error; }
  }

  private async statusWithDiscovery(requestId: string | undefined, options: EngineDiscoveryOptions): Promise<EngineSettingsState> {
    this.read();
    const base = this.base(), sequence = ++this.discoverySequence;
    const platform = process.platform, windows = platform === "win32";
    const home = windows
      ? lookupEnvCaseInsensitive(base, "USERPROFILE", "win32") ?? lookupEnvCaseInsensitive(base, "HOME", "win32") ?? os.homedir()
      : base.HOME ?? base.USERPROFILE ?? os.homedir();

    const probeShell = options.probeShell !== false;
    const probe = probeShell
      ? await runEnvironmentDiscovery({
        baseEnv: base,
        commands: Object.values(ENGINE_COMMANDS),
        home,
        platform,
        forceRefresh: options.forceRefresh,
        registryRefreshed: options.registryRefreshed,
        timeoutMs: options.timeoutMs,
        runner: options.runner,
        signal: this.stopDiscovery.signal,
      })
      : { at: Date.now(), shell: { ok: false, status: "skipped" as const, pathDirs: [], resolvedCommands: {} }, packageManagerDirs: [], windowsRegistryDirs: [] };

    const settings = this.read();
    const receipt = requestId ? settings.receipts.find(item => item.requestId === requestId) : settings.receipts.at(-1);
    const cache = readEngineDiscoveryCache(this.directory, platform);
    const resolved = resolveDiscoveredEngines({
      directory: this.directory,
      base,
      settings,
      cache,
      probe,
      platform,
    });

    await this.publishDiscovery({ dirs: resolved.discoveredDirs, paths: resolved.discoveredPaths }, sequence, platform);

    const engineRows = await Promise.all(resolved.engines.map(async (row) => {
      let version: string | null = null;
      if (row.executable && options.probeVersions !== false) {
        version = options.probeVersions || options.forceRefresh
          ? await probeExecutableVersion(row.executable, resolved.enhancedEnv, options.runner, { forceRefresh: options.forceRefresh, signal: this.stopDiscovery.signal })
          : cachedExecutableVersion(row.executable);
      }

      return {
        id: row.id,
        override: row.override,
        source: row.source,
        command: row.command,
        executable: row.executable,
        available: row.available,
        version,
        rule: row.rule,
        ...(row.danglingLinks.length ? { danglingLinks: row.danglingLinks } : {}),
        ...(row.showTerminalDiff && row.terminalExecutable ? { terminalExecutable: row.terminalExecutable } : {}),
      };
    }));

    return {
      revision: settings.revision,
      platform,
      searchPaths: resolved.mergedDirs.map(item => item.dir),
      shellProbeStatus: probe.shell.status,
      receipt: receipt ? { requestId: receipt.requestId, revision: receipt.revision } : null,
      engines: engineRows,
    };
  }

  async update(raw: EngineSettingsUpdate, commit: (apply: () => Promise<void>) => Promise<void>): Promise<EngineSettingsState> {
    const command = engineSettingsUpdateSchema.parse(raw), digest = createHash("sha256").update(JSON.stringify(command)).digest("hex"), file = engineSettingsFile(this.directory);
    if (command.path !== null && (command.path !== command.path.trim() || !path.isAbsolute(command.path))) throw new HubError("engine_path_absolute_required");
    return withFileMutex(file, async () => {
      const before = this.read(), receipt = before.receipts.find(item => item.requestId === command.requestId);
      if (receipt) { if (receipt.digest !== digest) throw new HubError("engine_request_conflict", 409); return this.status(command.requestId); }
      if (before.revision !== command.revision) throw new HubError("engine_revision_conflict", 409);
      // Presence check only: selecting a program never executes it as a probe.
      const check = () => { if (command.path !== null && !resolveEngineExecutable(command.path, this.base())) throw new HubError("engine_path_unavailable"); };
      check();
      const paths = { ...before.paths }; if (command.path === null) delete paths[command.engine]; else paths[command.engine] = command.path;
      const revision = randomUUID(), next = storedEngineSettingsSchema.parse({
        format: 1,
        revision,
        paths,
        receipts: [...before.receipts, { requestId: command.requestId, digest, revision }].slice(-32),
      });
      const temporary = `${file}.${randomUUID()}.tmp`; let handle;
      try {
        handle = await open(temporary, "wx", 0o600); await handle.writeFile(JSON.stringify(next)); await handle.sync(); await handle.close(); handle = undefined;
        await commit(async () => {
          if (this.read().revision !== before.revision) throw new HubError("engine_revision_conflict", 409);
          check(); await rename(temporary, file);
        });
      } finally { await handle?.close(); await unlink(temporary).catch(() => undefined); }
      return this.status(command.requestId);
    }, { waitTimeoutMs: 10_000 });
  }
}
