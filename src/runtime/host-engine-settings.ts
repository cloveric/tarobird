import { randomUUID } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  enginePathSchema,
  hostEngineSchema,
  type EngineDiscoveryRule,
  type HostEngine,
} from "../client-protocol/engine-settings.js";
import {
  diagnoseExecutableCandidates,
  discoverEngineDirectories,
  lookupEnvCaseInsensitive,
  mergeTaggedDirectories,
  type DanglingLinkInfo,
  type EnvironmentDiscoveryResult,
  type TaggedDirectory,
} from "../host-cli/engine-discovery.js";
import { withFileMutex } from "../state/file-mutex.js";
import { deepseekExecutableOverride, resolveDeepSeekExecutable } from "./deepseek-executable.js";
import { resolveEngineExecutable } from "./engine-process.js";
import { resolveOmpExecutable } from "./omp-executable.js";
import { resolvePiExecutable } from "./pi-executable.js";
import {
  cachedWindowsRegistryPathDirectories,
  envLookupCaseInsensitive,
  mergeWindowsPathEntries,
  readWindowsPathEntries,
  setCanonicalWindowsPath,
} from "./windows-registry-path.js";

export const ENGINE_COMMANDS = { codex: "codex", claude: "claude", antigravity: "agy", kimi: "kimi", deepseek: "dsh", pi: "pi", omp: "omp" } as const;
export const ENGINE_ENV_KEYS = { codex: "CODEX_EXECUTABLE", claude: "CLAUDE_EXECUTABLE", antigravity: "ANTIGRAVITY_EXECUTABLE", kimi: "KIMI_EXECUTABLE", deepseek: "DSH_EXECUTABLE", pi: "PI_EXECUTABLE", omp: "OMP_EXECUTABLE" } as const;
export const engineSettingsFile = (directory: string) => path.join(directory, "engine-settings.json");
export const engineDiscoveryCacheFile = (directory: string) => path.join(directory, "engine-discovery-cache.json");
export const storedEngineSettingsSchema = z.object({
  format: z.literal(1),
  revision: z.string().min(1).max(100),
  paths: z.partialRecord(hostEngineSchema, enginePathSchema),
  receipts: z.array(z.object({ requestId: z.string(), digest: z.string(), revision: z.string() })).max(32),
}).strict();
export type StoredEngineSettings = z.infer<typeof storedEngineSettingsSchema>;

export const engineDiscoveryCacheSchema = z.object({
  format: z.literal(1),
  updatedAt: z.number().int().nonnegative().optional(),
  paths: z.partialRecord(hostEngineSchema, enginePathSchema),
  searchDirs: z.array(enginePathSchema).max(256).optional(),
}).strict();
export type EngineDiscoveryCache = z.infer<typeof engineDiscoveryCacheSchema>;

export type LiveEngineDiscovery = {
  dirs?: readonly string[];
  paths?: Partial<Record<HostEngine, string>>;
};

export type HostEngineEnvironmentOptions = {
  discoveryCache?: EngineDiscoveryCache;
  skipDiscoveryCache?: boolean;
  liveDiscovery?: LiveEngineDiscovery;
  platform?: NodeJS.Platform;
};

export class EngineSettingsReadError extends Error {
  constructor() { super("engine_settings_unavailable"); this.name = "EngineSettingsReadError"; }
}
/** Private local state. An invalid/unreadable file must not silently select a
 * different executable. No shell evaluation, credentials, or profile loading. */
export function readHostEngineSettings(directory: string): StoredEngineSettings {
  let fd: number, expected;
  try {
    const file = engineSettingsFile(directory); expected = lstatSync(file);
    if (!expected.isFile() || expected.isSymbolicLink()) throw new Error();
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { format: 1, revision: "default", paths: {}, receipts: [] }; throw new EngineSettingsReadError(); }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.ino !== expected.ino || info.dev !== expected.dev || info.size > 65536 || (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077)))) throw new Error();
    const bytes = Buffer.alloc(65537), size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 65536) throw new Error();
    const value = storedEngineSettingsSchema.parse(JSON.parse(bytes.subarray(0, size).toString("utf8")));
    if (Object.values(value.paths).some(file => !path.isAbsolute(file!) || file !== file!.trim())) throw new Error();
    return value;
  } catch { throw new EngineSettingsReadError(); }
  finally { closeSync(fd); }
}

const EMPTY_DISCOVERY_CACHE: EngineDiscoveryCache = { format: 1, paths: {}, searchDirs: [] };

function isSafeAbsoluteDir(dir: string | undefined, platform: NodeJS.Platform = process.platform): dir is string {
  if (!dir || dir !== dir.trim() || dir.length > 4096) return false;
  const p = platform === "win32" ? path.win32 : path.posix;
  const delim = platform === "win32" ? ";" : ":";
  if (!p.isAbsolute(dir) || /[\x00-\x1f\x7f]/.test(dir) || dir.includes(delim)) return false;
  return true;
}

function isSafeAbsoluteFile(file: string | undefined, platform: NodeJS.Platform = process.platform): file is string {
  if (!file || file !== file.trim() || file.length > 4096) return false;
  const p = platform === "win32" ? path.win32 : path.posix;
  if (!p.isAbsolute(file) || /[\x00-\x1f\x7f]/.test(file)) return false;
  return true;
}

/** Non-fail-closed cache of auto-discovered paths and search directories.
 * Stored separately from strict `engine-settings.json` so older runtimes can
 * roll back cleanly and corrupt/unreadable cache files are safely regenerated. */
export function readEngineDiscoveryCache(directory: string, platform: NodeJS.Platform = process.platform): EngineDiscoveryCache {
  let fd: number, expected;
  try {
    const file = engineDiscoveryCacheFile(directory); expected = lstatSync(file);
    if (!expected.isFile() || expected.isSymbolicLink()) return { format: 1, paths: {}, searchDirs: [] };
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return { format: 1, paths: {}, searchDirs: [] };
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.ino !== expected.ino || info.dev !== expected.dev || info.size > 65536 || (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077)))) {
      return { format: 1, paths: {}, searchDirs: [] };
    }
    const bytes = Buffer.alloc(65537), size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 65536) return { format: 1, paths: {}, searchDirs: [] };
    const parsed = engineDiscoveryCacheSchema.parse(JSON.parse(bytes.subarray(0, size).toString("utf8")));
    const paths: Partial<Record<HostEngine, string>> = {};
    for (const id of hostEngineSchema.options) {
      const value = parsed.paths[id];
      if (isSafeAbsoluteFile(value, platform)) paths[id] = value;
    }
    const searchDirs = (parsed.searchDirs ?? []).filter(dir => isSafeAbsoluteDir(dir, platform));
    return { format: 1, ...(parsed.updatedAt !== undefined ? { updatedAt: parsed.updatedAt } : {}), paths, searchDirs };
  } catch {
    return { format: 1, paths: {}, searchDirs: [] };
  } finally {
    closeSync(fd);
  }
}

export async function writeEngineDiscoveryCache(
  directory: string,
  input: { paths: Partial<Record<HostEngine, string>>; searchDirs?: readonly string[] },
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const file = engineDiscoveryCacheFile(directory);
  const nextPaths: Partial<Record<HostEngine, string>> = {};
  for (const id of hostEngineSchema.options) {
    const val = input.paths[id];
    if (isSafeAbsoluteFile(val, platform)) nextPaths[id] = val;
  }
  const seen = new Set<string>();
  const windows = platform === "win32";
  const nextSearchDirs: string[] = [];
  for (const dir of input.searchDirs ?? []) {
    if (!isSafeAbsoluteDir(dir, platform)) continue;
    const key = windows ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    nextSearchDirs.push(dir);
    if (nextSearchDirs.length >= 256) break;
  }
  try {
    await withFileMutex(file, async () => {
      const prev = readEngineDiscoveryCache(directory, platform);
      if (
        JSON.stringify(prev.paths) === JSON.stringify(nextPaths)
        && JSON.stringify(prev.searchDirs ?? []) === JSON.stringify(nextSearchDirs)
      ) {
        return;
      }
      const next = engineDiscoveryCacheSchema.parse({
        format: 1,
        updatedAt: Date.now(),
        paths: nextPaths,
        ...(nextSearchDirs.length ? { searchDirs: nextSearchDirs } : {}),
      });
      const temporary = `${file}.${randomUUID()}.tmp`;
      let handle;
      try {
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(JSON.stringify(next));
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, file);
      } finally {
        await handle?.close();
        await unlink(temporary).catch(() => undefined);
      }
    }, { waitTimeoutMs: 3_000 });
  } catch {
    /* Auto-discovered cache is opportunistic and never fails a status read or startup. */
  }
}

/** Order-preserving dedup; on Windows it uses the shared PATH key (case and trailing separators). */
function dedupDirs(dirs: readonly string[], windows: boolean): string[] {
  if (windows) return mergeWindowsPathEntries([dirs]);
  return [...new Set(dirs.filter(Boolean))];
}

/** Host search folders shared by workers and the settings page, in launch order:
 * inherited PATH, then (Windows) the cached live registry PATH from #180's reader,
 * then known engine folders. Registry folders are merged here only. */
export function hostBaselineDirectories(
  base: NodeJS.ProcessEnv,
  home: string | undefined,
  platform: NodeJS.Platform,
): { pathDirs: string[]; registryDirs: string[]; knownDirs: string[]; hasPathKey: boolean } {
  if (platform === "win32") {
    const inherited = readWindowsPathEntries(base);
    return {
      pathDirs: inherited.entries,
      registryDirs: cachedWindowsRegistryPathDirectories(base, "win32"),
      knownDirs: discoverEngineDirectories(home ?? "", base, "win32"),
      hasPathKey: inherited.hasKey,
    };
  }
  return {
    pathDirs: (base.PATH ?? "").split(":").filter(Boolean),
    registryDirs: [],
    knownDirs: home ? discoverEngineDirectories(home, base, platform) : [],
    hasPathKey: base.PATH !== undefined,
  };
}

function setSearchPath(env: NodeJS.ProcessEnv, dirs: readonly string[], windows: boolean, keepEmpty: boolean): void {
  if (windows) setCanonicalWindowsPath(env, dirs, keepEmpty);
  else env.PATH = dirs.join(":");
}

export function hostEngineEnvironment(
  directory: string,
  base: NodeJS.ProcessEnv,
  settings = readHostEngineSettings(directory),
  options: HostEngineEnvironmentOptions | NodeJS.Platform = {},
): NodeJS.ProcessEnv {
  const opts: HostEngineEnvironmentOptions = typeof options === "string" ? { platform: options } : options;
  // The entrypoint already built the baseline PATH. Do not prepend the desktop
  // defaults again: callers can deliberately supply an isolated environment.
  const env = { ...base }, platform = opts.platform ?? process.platform, windows = platform === "win32", p = windows ? path.win32 : path.posix;
  const home = windows
    ? envLookupCaseInsensitive(base, "USERPROFILE") ?? envLookupCaseInsensitive(base, "HOME")
    : base.HOME ?? base.USERPROFILE;
  if (windows) {
    // Canonicalize only a real inherited override, never an auto-discovered
    // path. Worker-local bot.env must not outrank a differently-cased Host key.
    const explicit = lookupEnvCaseInsensitive(base, "DSH_EXECUTABLE", "win32");
    for (const key of Object.keys(env)) if (key !== "DSH_EXECUTABLE" && key.toUpperCase() === "DSH_EXECUTABLE") delete env[key];
    if (explicit !== undefined) env.DSH_EXECUTABLE = explicit;
  }

  // Windows always rewrites one canonical PATH key (no competing Path/PATH in
  // child processes); POSIX extends PATH only when a home directory is known.
  const host = hostBaselineDirectories(base, home, platform);
  const baselineDirs = dedupDirs([...host.pathDirs, ...host.registryDirs, ...host.knownDirs], windows);
  const writePath = windows || !!home;

  const baselineEnv: NodeJS.ProcessEnv = { ...env };
  if (writePath) setSearchPath(baselineEnv, baselineDirs, windows, host.hasPathKey);

  const cache = opts.skipDiscoveryCache
    ? EMPTY_DISCOVERY_CACHE
    : (opts.discoveryCache ?? readEngineDiscoveryCache(directory, platform));
  const liveDirs = (opts.liveDiscovery?.dirs ?? []).filter(dir => isSafeAbsoluteDir(dir, platform));
  const cachedDirs = (cache.searchDirs ?? []).filter(dir => isSafeAbsoluteDir(dir, platform));
  const discoveredDirs = liveDirs.length > 0 ? liveDirs : cachedDirs;

  const probeEnv: NodeJS.ProcessEnv = { ...baselineEnv };
  if (writePath || discoveredDirs.length > 0) setSearchPath(probeEnv, dedupDirs([...baselineDirs, ...discoveredDirs], windows), windows, host.hasPathKey);

  const extraBinDirs: string[] = [];
  for (const engine of hostEngineSchema.options) {
    const envKey = ENGINE_ENV_KEYS[engine];
    if (settings.paths[engine]) {
      const manual = settings.paths[engine]!;
      if (windows) for (const existing of Object.keys(env)) if (existing !== envKey && existing.toUpperCase() === envKey) delete env[existing];
      env[envKey] = manual;
      const binDir = p.dirname(manual);
      if (isSafeAbsoluteDir(binDir, platform)) extraBinDirs.push(binDir);
    } else if (!lookupEnvCaseInsensitive(base, envKey, platform)) {
      // Only fall back to remembered/discovered auto paths when normal PATH + known-directory
      // resolution does not already find the command, avoiding stale binary pinning.
      const baselineCmd = engineCommandFor(engine, baselineEnv, platform);
      const foundInBaseline = !!resolveEngineExecutable(baselineCmd, baselineEnv, platform);
      if (!foundInBaseline) {
        const candidates = [opts.liveDiscovery?.paths?.[engine], cache.paths[engine]].filter(
          (candidate): candidate is string => isSafeAbsoluteFile(candidate, platform),
        );
        const chosen = candidates.find(candidate => !!resolveEngineExecutable(candidate, probeEnv, platform));
        if (chosen) {
          env[envKey] = chosen;
          const binDir = p.dirname(chosen);
          if (isSafeAbsoluteDir(binDir, platform)) extraBinDirs.push(binDir);
        }
      }
    }
  }

  if (writePath || discoveredDirs.length > 0 || extraBinDirs.length > 0) {
    setSearchPath(env, dedupDirs([...baselineDirs, ...discoveredDirs, ...extraBinDirs], windows), windows, host.hasPathKey);
  }
  return env;
}

/** Auto command an engine launches with: Pi, oh-my-pi and DeepSeek resolve their
 * own install locations; the rest use their bare command on PATH. */
function engineCommandFor(engine: HostEngine, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return engine === "pi"
    ? resolvePiExecutable(env, platform)
    : engine === "omp"
      ? resolveOmpExecutable(env, platform)
      : engine === "deepseek"
        ? resolveDeepSeekExecutable(env, platform)
        : ENGINE_COMMANDS[engine];
}

export type ResolvedDiscoveredEngine = {
  id: HostEngine;
  override: string | null;
  source: "setting" | "environment" | "auto";
  command: string;
  executable: string | null;
  available: boolean;
  rule: EngineDiscoveryRule | null;
  danglingLinks: DanglingLinkInfo[];
  terminalExecutable: string | null;
  showTerminalDiff: boolean;
  cacheablePath?: string;
};

function dedupDanglingLinks(links: readonly DanglingLinkInfo[]): DanglingLinkInfo[] {
  const seen = new Set<string>();
  const out: DanglingLinkInfo[] = [];
  for (const link of links) {
    const key = `${link.linkPath}=>${link.targetPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out;
}

/** Shared discovery resolution used by HubEngineSettings, BotManager warm-up,
 * and `tarobot doctor` so every engine follows identical precedence, rule
 * labeling, dangling-symlink reporting, and fallback semantics. */
export function resolveDiscoveredEngines(options: {
  directory: string;
  base: NodeJS.ProcessEnv;
  settings: StoredEngineSettings;
  cache: EngineDiscoveryCache;
  probe: EnvironmentDiscoveryResult;
  platform?: NodeJS.Platform;
}): {
  hostTaggedDirs: TaggedDirectory[];
  discoveredDirs: string[];
  mergedDirs: TaggedDirectory[];
  enhancedEnv: NodeJS.ProcessEnv;
  engines: ResolvedDiscoveredEngine[];
  discoveredPaths: Partial<Record<HostEngine, string>>;
} {
  const { directory, base, settings, cache, probe } = options;
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32", sep = windows ? ";" : ":", p = windows ? path.win32 : path.posix;
  const home = windows
    ? envLookupCaseInsensitive(base, "USERPROFILE") ?? envLookupCaseInsensitive(base, "HOME")
    : base.HOME ?? base.USERPROFILE;

  // Baseline env excludes cached discovered paths so fresh discovery always outranks stale cache.
  const baselineEnv = hostEngineEnvironment(directory, base, settings, { skipDiscoveryCache: true, platform });
  // Same Host folders, in the same order, that hostEngineEnvironment gives workers.
  // Windows registry folders come only from the cached reader used there.
  const host = hostBaselineDirectories(base, home, platform);
  const envDirs = (lookupEnvCaseInsensitive(baselineEnv, "PATH", platform) ?? "").split(sep).filter(Boolean).map((dir): TaggedDirectory => ({ dir, rule: "path" }));
  const hostTaggedDirs = mergeTaggedDirectories([
    host.pathDirs.map((dir): TaggedDirectory => ({ dir, rule: "path" })),
    host.registryDirs.map((dir): TaggedDirectory => ({ dir, rule: "windows-registry" })),
    host.knownDirs.map((dir): TaggedDirectory => ({ dir, rule: "known-directory" })),
  ], platform);

  const discoveredTaggedDirs = mergeTaggedDirectories([
    probe.shell.pathDirs.map((dir): TaggedDirectory => ({ dir, rule: "login-shell" })),
    probe.packageManagerDirs.map((dir): TaggedDirectory => ({ dir, rule: "package-manager" })),
  ], platform).filter(({ dir }) => isSafeAbsoluteDir(dir, platform));
  const discoveredDirs = discoveredTaggedDirs.map(item => item.dir);
  const fallbackDirs = (cache.searchDirs ?? []).filter(dir => isSafeAbsoluteDir(dir, platform)).map((dir): TaggedDirectory => ({ dir, rule: "auto-discovered" }));
  const mergedDirs = mergeTaggedDirectories([
    hostTaggedDirs, discoveredDirs.length ? discoveredTaggedDirs : fallbackDirs, envDirs,
  ], platform);

  const enhancedEnv: NodeJS.ProcessEnv = { ...baselineEnv };
  if (windows) for (const key of Object.keys(enhancedEnv)) if (key.toUpperCase() === "PATH") delete enhancedEnv[key];
  enhancedEnv.PATH = mergedDirs.map(item => item.dir).join(sep);

  const discoveredPaths: Partial<Record<HostEngine, string>> = {};
  const engines: ResolvedDiscoveredEngine[] = hostEngineSchema.options.map(id => {
    const explicit = id === "deepseek"
      ? deepseekExecutableOverride(base, platform) !== undefined
      : !!lookupEnvCaseInsensitive(base, ENGINE_ENV_KEYS[id], platform);
    const hasManual = !!settings.paths[id];
    const defaultCmd = ENGINE_COMMANDS[id];
    const remembered = !hasManual && !explicit ? cache.paths[id] : undefined;
    const rememberedValid = remembered && resolveEngineExecutable(remembered, enhancedEnv, platform) ? remembered : undefined;

    let hostBaselineExecutable: string | null = null;
    if (!hasManual && !explicit) {
      const baselineCommand = engineCommandFor(id, baselineEnv, platform);
      hostBaselineExecutable = resolveEngineExecutable(baselineCommand, baselineEnv, platform) ?? null;
    }

    const shellCmdHit = probe.shell.resolvedCommands[defaultCmd];
    const terminalExecutable = shellCmdHit && resolveEngineExecutable(shellCmdHit, enhancedEnv, platform)
      ? shellCmdHit
      : null;

    let command: string;
    let executable: string | null = null;
    let rule: EngineDiscoveryRule | null = null;
    let danglingLinks: DanglingLinkInfo[] = [];

    if (hasManual) {
      command = settings.paths[id]!;
      const diagnosed = diagnoseExecutableCandidates(command, mergedDirs, enhancedEnv, platform);
      executable = diagnosed.executable ?? resolveEngineExecutable(command, enhancedEnv, platform) ?? null;
      rule = executable ? "setting" : null;
      danglingLinks = diagnosed.danglingLinks;
    } else if (explicit) {
      command = id === "deepseek"
        ? resolveDeepSeekExecutable(baselineEnv, platform)
        : lookupEnvCaseInsensitive(base, ENGINE_ENV_KEYS[id], platform)!;
      const diagnosed = diagnoseExecutableCandidates(command, mergedDirs, enhancedEnv, platform);
      executable = diagnosed.executable ?? resolveEngineExecutable(command, enhancedEnv, platform) ?? null;
      rule = executable ? "environment" : null;
      danglingLinks = diagnosed.danglingLinks;
    } else {
      // Always scan mergedDirs for defaultCmd first so fresh discovery outranks stale cache
      // and dangling symlinks remain visible across reads.
      const pathDiagnosed = diagnoseExecutableCandidates(defaultCmd, mergedDirs, enhancedEnv, platform);
      const autoCmd = engineCommandFor(id, enhancedEnv, platform);
      command = autoCmd;

      if (p.isAbsolute(autoCmd)) {
        const knownDiagnosed = diagnoseExecutableCandidates(autoCmd, mergedDirs, enhancedEnv, platform);
        executable = knownDiagnosed.executable ?? resolveEngineExecutable(autoCmd, enhancedEnv, platform) ?? null;
        rule = executable ? "known-directory" : null;
        danglingLinks = dedupDanglingLinks([...pathDiagnosed.danglingLinks, ...knownDiagnosed.danglingLinks]);
      } else {
        executable = pathDiagnosed.executable ?? resolveEngineExecutable(autoCmd, enhancedEnv, platform) ?? null;
        rule = executable ? (pathDiagnosed.rule ?? "path") : null;
        danglingLinks = pathDiagnosed.danglingLinks;
      }

      if (!executable && terminalExecutable) {
        executable = terminalExecutable;
        rule = "login-shell";
      }

      // Only fall back to the remembered auto-discovered cache when live discovery did not find a binary.
      if (!executable && rememberedValid) {
        executable = rememberedValid;
        rule = "auto-discovered";
      }
    }

    const cacheablePath = !hasManual && !explicit && executable && isSafeAbsoluteFile(executable, platform)
      ? executable
      : undefined;
    if (cacheablePath) discoveredPaths[id] = cacheablePath;

    const showTerminalDiff = !hasManual && !explicit && !!terminalExecutable && hostBaselineExecutable !== terminalExecutable;

    return {
      id,
      override: settings.paths[id] ?? null,
      source: hasManual ? "setting" : explicit ? "environment" : "auto",
      command,
      executable,
      available: !!executable,
      rule,
      danglingLinks,
      terminalExecutable,
      showTerminalDiff,
      ...(cacheablePath ? { cacheablePath } : {}),
    };
  });

  return { hostTaggedDirs, discoveredDirs, mergedDirs, enhancedEnv, engines, discoveredPaths };
}
