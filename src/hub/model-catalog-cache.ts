import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDeepSeekHome } from "../config.js";
import { piAgentDir } from "../codex/pi-session-store.js";
import { ompAgentDir } from "../runtime/omp-executable.js";
import { deepseekDesktopLauncher, npmShimEntrypoint, resolveEngineExecutable } from "../runtime/engine-process.js";
import { fallbackModelCatalog, readModelCatalogAnswer, type ModelCatalogOptions, type ModelCatalogRead } from "../runtime/model-catalog.js";
import type { InstanceEngine } from "../state/instance-config.js";

/** An answer this recent is served as is. */
export const MODEL_CATALOG_FRESH_MS = 5 * 60_000;
/** An older answer is still served at once, marked stale, while one background read replaces it. */
export const MODEL_CATALOG_STALE_MS = 24 * 60 * 60_000;
/** An unanswered read (signed out, too slow, missing) is retried this soon. */
export const MODEL_CATALOG_RETRY_MS = 15_000;

export type CachedModelCatalog = ModelCatalogRead & {
  /** Server clock time of the read that produced these choices. */
  readAt: number;
  /** Served from an answer older than the fresh window; a replacement is being read. */
  stale?: true;
};
export type ModelCatalogRequest = {
  /** A new read is required (DeepSeek's validation at creation): never serve a settled answer. */
  refresh?: boolean;
  /** Return an answer read after this time: creation waits for a stale answer's replacement. */
  after?: number;
};
type Reader = (engine: InstanceEngine, env: NodeJS.ProcessEnv, cwd: string | undefined, fresh: boolean, options: ModelCatalogOptions) => Promise<ModelCatalogRead>;
type Entry = { value?: ModelCatalogRead; readAt: number; retryAt: number; inflight?: Promise<ModelCatalogRead> };

const fileSignature = (file: string): unknown => {
  try { const info = statSync(file); return [file, info.size, info.mtimeMs, info.ctimeMs, info.ino]; }
  catch { return [file, null]; }
};
const homeOf = (env: NodeJS.ProcessEnv) => (process.platform === "win32" ? env.USERPROFILE ?? env.HOME : env.HOME ?? env.USERPROFILE) || os.homedir();
const claudeManagedSettings = () => process.platform === "darwin" ? "/Library/Application Support/ClaudeCode/managed-settings.json"
  : process.platform === "win32" ? path.join(process.env.ProgramData || "C:\\ProgramData", "ClaudeCode", "managed-settings.json") : "/etc/claude-code/managed-settings.json";

/** Sign-in, account and model configuration files the engine's own CLI reads.
 * A change to any of them (or to the executable) is a different cache entry,
 * so a new login or setting is read at once instead of after the fresh window.
 * Logins kept in a system keychain (Claude on macOS, a Codex keyring) have no
 * file; they are seen through the fresh window, the stale re-read and the
 * explicit reread. */
export function engineStateFiles(engine: InstanceEngine, env: NodeJS.ProcessEnv, cwd?: string): string[] {
  const home = homeOf(env), within = (dir: string, names: string[]) => names.map(name => path.join(dir, name));
  switch (engine) {
    case "codex": return within(env.CODEX_HOME?.trim() || path.join(home, ".codex"), ["auth.json", "config.toml"]);
    // ~/.claude.json is rewritten by every Claude run, so it cannot sign anything.
    case "claude": return [...within(env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude"), [".credentials.json", "settings.json", "settings.local.json"]), claudeManagedSettings()];
    case "antigravity": return [...within(path.join(home, ".gemini"), ["oauth_creds.json", "google_accounts.json"]), path.join(home, ".gemini", "antigravity-cli", "settings.json"), path.join(home, ".gemini", "config", "config.json")];
    case "pi": return [...within(piAgentDir(env, home, cwd), ["auth.json", "settings.json", "models.json"]), ...cwd ? within(path.join(cwd, ".pi"), ["settings.json", "models.json"]) : []];
    case "omp": return [...within(ompAgentDir(env, home, cwd), ["auth.json", "settings.json", "models.json", "models.yml", "config.yml"]), ...cwd ? within(path.join(cwd, ".omp"), ["settings.json", "models.yml", "config.yml"]) : []];
    case "deepseek": {
      let dsh: string; try { dsh = resolveDeepSeekHome(env); } catch { return []; }
      return within(dsh, ["cordis.patch.yml", "settings.yaml", ".credentials.yaml", "profiles/web/cordis.patch.yml", "profiles/web/package.json"]);
    }
    case "kimi": return [];
  }
}

/** The executable that would run, through symlinks, so an upgrade or a moved
 * install is a new entry. A Windows wrapper (npm's, DeepSeek Desktop's) does
 * not change on upgrade; what it starts does. */
export function executableSignature(command: string, env: NodeJS.ProcessEnv): unknown {
  const resolved = resolveEngineExecutable(command, env);
  if (!resolved) return [command, null];
  let real = resolved; try { real = realpathSync(resolved); } catch { /* keep the resolved path */ }
  const started: string[] = [];
  if (process.platform === "win32" && /\.cmd$/i.test(resolved)) {
    const desktop = deepseekDesktopLauncher(resolved), entry = desktop ? undefined : npmShimEntrypoint(resolved);
    // DeepSeek Desktop: its runtime and the archive holding the CLI.
    if (desktop) started.push(desktop.executable, desktop.entrypoint.slice(0, desktop.entrypoint.indexOf("app.asar") + "app.asar".length));
    if (entry) started.push(entry);
  }
  return [fileSignature(real), ...started.map(fileSignature)];
}

const sortedEnv = (env: NodeJS.ProcessEnv) => Object.keys(env).sort().map(key => [key, env[key]]);

/** Hub-wide engine model catalogs. Every read here bypasses the per-engine
 * discovery caches (joining a read in progress): this cache decides freshness. */
export class ModelCatalogCache {
  private entries = new Map<string, Entry>();
  constructor(private readonly options: { deepseekCatalogHome?: string } = {}, private readonly read: Reader = readModelCatalogAnswer, private readonly now: () => number = Date.now) {}

  key(engine: InstanceEngine, env: NodeJS.ProcessEnv, executable: string, cwd?: string): string {
    // Only Pi, omp, and DeepSeek read a workspace.
    const workspace = engine === "pi" || engine === "omp" || engine === "deepseek" ? cwd : undefined;
    return createHash("sha256").update(JSON.stringify([engine, workspace, sortedEnv(env), executableSignature(executable, env), engineStateFiles(engine, env, workspace).map(fileSignature)])).digest("hex");
  }

  async get(engine: InstanceEngine, env: NodeJS.ProcessEnv, executable: string, cwd: string | undefined, request: ModelCatalogRequest = {}): Promise<CachedModelCatalog> {
    // Kimi reads one local file and starts no process: nothing to save.
    if (engine === "kimi") return { ...await this.read(engine, env, cwd, false, {}), readAt: this.now() };
    const key = this.key(engine, env, executable, cwd), entry = this.entries.get(key) ?? { readAt: 0, retryAt: 0 };
    const now = this.now(), answer = (): CachedModelCatalog => ({ ...entry.value!, readAt: entry.readAt });
    if (entry.value && !request.refresh) {
      if (request.after !== undefined) {
        // A follow-up waits for the replacement once; a replacement that went
        // unanswered leaves the earlier answer, which is returned unmarked.
        if (entry.readAt > request.after || !entry.inflight && now < entry.retryAt) return answer();
      } else if (entry.value.answered ? now - entry.readAt < MODEL_CATALOG_FRESH_MS : now < entry.retryAt) return answer();
      else if (entry.value.answered && now - entry.readAt < MODEL_CATALOG_STALE_MS) {
        // An earlier answer stays usable while one replacement is read.
        if (!entry.inflight && now >= entry.retryAt) void this.start(key, entry, engine, env, executable, cwd, false);
        return { ...answer(), stale: true };
      }
    }
    const pending = entry.inflight ?? this.start(key, entry, engine, env, executable, cwd, !!request.refresh);
    const result = await pending;
    // An explicit reread reports what this read found; others what the cache now holds.
    return request.refresh || !entry.value ? { ...result, readAt: entry.readAt || this.now() } : answer();
  }

  /** At most 64 entries; the one least recently read goes first, never the one being filed. */
  private file(key: string, entry: Entry): void {
    this.entries.delete(key);
    if (this.entries.size >= 64) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, entry);
  }

  private start(key: string, entry: Entry, engine: InstanceEngine, env: NodeJS.ProcessEnv, executable: string, cwd: string | undefined, explicit: boolean): Promise<ModelCatalogRead> {
    this.file(key, entry);
    const options: ModelCatalogOptions = { reread: true, ...this.options.deepseekCatalogHome ? { deepseekCatalogHome: this.options.deepseekCatalogHome } : {} };
    const promise = this.read(engine, env, cwd, explicit, options).catch(() => fallbackModelCatalog(engine)).then(result => {
      if (entry.inflight === promise) entry.inflight = undefined;
      // An explicit reread reports what the engine says now. A passive read
      // that went unanswered keeps an earlier answer and is retried later.
      if (result.answered || explicit || !entry.value?.answered) { entry.value = result; entry.readAt = this.now(); }
      entry.retryAt = this.now() + MODEL_CATALOG_RETRY_MS;
      // A CLI may refresh its own sign-in file while answering. File the
      // answer under the state it left too, so the next request still finds it.
      const after = this.key(engine, env, executable, cwd);
      if (after !== key && !this.entries.has(after)) this.file(after, entry);
      return result;
    });
    entry.inflight = promise;
    return promise;
  }

  clear(): void { this.entries.clear(); }
}
