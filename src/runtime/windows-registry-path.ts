import { execFile } from "node:child_process";
import path from "node:path";

export const WINDOWS_REGISTRY_QUERY_TIMEOUT_MS = 1500;
export const WINDOWS_REGISTRY_PATH_TTL_MS = 5000;
export const WINDOWS_REGISTRY_FAILURE_COOLDOWN_MS = 15_000;
export const WINDOWS_REGISTRY_PATH_KEYS = [
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  "HKCU\\Environment",
] as const;

const WINDOWS_ABSOLUTE_ROOT = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/;
const REG_QUERY_MAX_BUFFER = 256 * 1024;
const MAX_EXPANSION_PASSES = 4;
const MAX_EXPANDED_LENGTH = 32_768;

export type WindowsRegistryQueryFn = (key: string, timeoutMs: number, env: NodeJS.ProcessEnv) => Promise<string | undefined>;

export interface RefreshWindowsRegistryPathOptions {
  platform?: NodeJS.Platform;
  force?: boolean;
  timeoutMs?: number;
  ttlMs?: number;
  failureCooldownMs?: number;
  now?: () => number;
  query?: WindowsRegistryQueryFn;
}

type RegistryCache = {
  rawValues: string[];
  expiresAt: number;
  cooldownUntil: number;
  inflight?: Promise<void>;
};

const liveHostEnvironments = new WeakSet<NodeJS.ProcessEnv>();
let cache: RegistryCache = { rawValues: [], expiresAt: 0, cooldownUntil: 0 };
let testQueryOverride: WindowsRegistryQueryFn | undefined;

/** Mark an environment built from the real host process so Windows registry
 * PATH refresh applies to it, while synthetic/isolated test environments stay isolated. */
export function markLiveHostEnvironment<T extends NodeJS.ProcessEnv>(env: T): T {
  liveHostEnvironments.add(env);
  return env;
}

export function isLiveHostEnvironment(env: NodeJS.ProcessEnv | undefined): boolean {
  return !!env && (env === process.env || liveHostEnvironments.has(env));
}

export function envLookupCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (env[key] !== undefined) return env[key];
  const upper = key.toUpperCase();
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && name.toUpperCase() === upper) return value;
  }
  return undefined;
}

/** Validate a Windows absolute drive or UNC directory path, rejecting control
 * characters, PATH delimiters, and drive-relative paths like `\foo`. */
export function validWindowsDirectory(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  const trimmed = candidate.trim().replace(/^"(.*)"$/, "$1").trim();
  if (!trimmed || /[\x00-\x1f\x7f;]/.test(trimmed)) return undefined;
  if (!WINDOWS_ABSOLUTE_ROOT.test(trimmed)) return undefined;
  return trimmed;
}

/** Canonical case-insensitive deduplication key for Windows PATH entries. */
export function windowsPathKey(directory: string): string {
  const unquoted = directory.trim().replace(/^"(.*)"$/, "$1").trim().replace(/\//g, "\\");
  if (/^[A-Za-z]:\\+$/.test(unquoted)) return `${unquoted.slice(0, 2).toLowerCase()}\\`;
  if (/^\\\\[^\\]+\\[^\\]+\\*$/.test(unquoted)) return unquoted.replace(/\\+$/, "").toLowerCase();
  return unquoted.replace(/\\+$/, "").toLowerCase();
}

export function readWindowsPathEntries(env: NodeJS.ProcessEnv): { hasKey: boolean; entries: string[] } {
  let hasKey = false;
  const entries: string[] = [];
  const append = (raw: string | undefined) => {
    if (raw === undefined) return;
    hasKey = true;
    for (const part of raw.split(";")) {
      const trimmed = part.trim();
      if (trimmed) entries.push(trimmed);
    }
  };
  if (Object.prototype.hasOwnProperty.call(env, "PATH")) {
    hasKey = true;
    append(env.PATH);
  }
  for (const [key, value] of Object.entries(env)) {
    if (key !== "PATH" && key.toUpperCase() === "PATH") {
      hasKey = true;
      append(value);
    }
  }
  return { hasKey, entries };
}

export function mergeWindowsPathEntries(sources: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const list of sources) {
    for (const raw of list) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const key = windowsPathKey(trimmed);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(trimmed);
    }
  }
  return result;
}

/** Write canonical uppercase `PATH` on Windows, removing any duplicate
 * differently-cased `Path`/`path` keys so child processes never see competing entries. */
export function setCanonicalWindowsPath(env: NodeJS.ProcessEnv, entries: readonly string[], keepEmpty: boolean): void {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH") delete env[key];
  }
  if (entries.length > 0 || keepEmpty) env.PATH = entries.join(";");
}

/** Parse `reg.exe query <key> /v Path` stdout for a REG_SZ or REG_EXPAND_SZ Path value. */
export function parseWindowsRegistryQueryOutput(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ(?:\s+(.*))?$/i);
    if (match) return (match[1] ?? "").trim();
  }
  return undefined;
}

/** Safely expand Windows `%VAR%` placeholders using case-insensitive lookups in `env`.
 * Bounded in pass count and output length so malformed/cyclic values cannot hang. */
export function expandWindowsEnvVars(value: string, env: NodeJS.ProcessEnv): string {
  if (!value.includes("%")) return value;
  const lookup = new Map<string, string>();
  for (const [key, entry] of Object.entries(env)) {
    if (entry === undefined) continue;
    const upper = key.toUpperCase();
    // Prefer exact-uppercase key if both variants exist.
    if (!lookup.has(upper) || key === upper) lookup.set(upper, entry);
  }
  let current = value;
  for (let pass = 0; pass < MAX_EXPANSION_PASSES; pass++) {
    let changed = false;
    const next = current.replace(/%([^%\r\n\0]+)%/g, (match, name: string) => {
      const replacement = lookup.get(name.toUpperCase());
      if (replacement === undefined) return match;
      changed = true;
      return replacement;
    });
    if (!changed || next === current || next.length > MAX_EXPANDED_LENGTH) break;
    current = next;
  }
  return current;
}

/** Expand raw registry Path values against `env`, keeping only valid absolute Windows directories. */
export function parseWindowsRegistryPathEntries(rawValues: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const directories: string[] = [];
  for (const raw of rawValues) {
    if (!raw) continue;
    for (const part of raw.split(";")) {
      const expanded = expandWindowsEnvVars(part.trim(), env);
      // Skip entries with unexpanded %VAR% tokens or non-absolute/unsafe paths.
      if (/%[^%\r\n\0]+%/.test(expanded)) continue;
      const valid = validWindowsDirectory(expanded);
      if (valid) directories.push(valid);
    }
  }
  return mergeWindowsPathEntries([directories]);
}

function resolveRegExecutable(env: NodeJS.ProcessEnv): string {
  const systemRoot = validWindowsDirectory(envLookupCaseInsensitive(env, "SystemRoot") ?? envLookupCaseInsensitive(env, "WINDIR"));
  return systemRoot ? path.win32.join(systemRoot, "System32", "reg.exe") : "reg.exe";
}

function defaultWindowsRegistryQuery(key: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const regExe = resolveRegExecutable(env);
  return new Promise((resolve, reject) => {
    execFile(regExe, ["query", key, "/v", "Path"], {
      timeout: timeoutMs,
      maxBuffer: REG_QUERY_MAX_BUFFER,
      encoding: "utf8",
      windowsHide: true,
    }, (error, stdout) => {
      if (error) { reject(error); return; }
      resolve(parseWindowsRegistryQueryOutput(stdout));
    });
  });
}

/** Return the most recently cached live Windows registry PATH directories, expanded
 * against `env`. Synchronous, safe for hot paths, and isolated to live host envs. */
export function cachedWindowsRegistryPathDirectories(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "win32" || !isLiveHostEnvironment(env) || cache.rawValues.length === 0) return [];
  return parseWindowsRegistryPathEntries(cache.rawValues, env);
}

/** Asynchronously refresh the cached live Windows Machine + User registry PATH.
 * Uses bounded timeouts, TTL caching, in-flight coalescing, and failure cooldown.
 * Never throws; on failure, retains any previously cached entries. */
export async function refreshWindowsRegistryPath(
  env: NodeJS.ProcessEnv = process.env,
  options: RefreshWindowsRegistryPathOptions = {},
): Promise<string[]> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || !isLiveHostEnvironment(env)) return [];

  const now = options.now ?? Date.now;
  const currentTime = now();
  if (!options.force) {
    if (currentTime < cache.expiresAt) return parseWindowsRegistryPathEntries(cache.rawValues, env);
    if (currentTime < cache.cooldownUntil) return parseWindowsRegistryPathEntries(cache.rawValues, env);
  }

  const query = options.query ?? testQueryOverride ?? defaultWindowsRegistryQuery;
  const timeoutMs = options.timeoutMs ?? WINDOWS_REGISTRY_QUERY_TIMEOUT_MS;
  const ttlMs = options.ttlMs ?? WINDOWS_REGISTRY_PATH_TTL_MS;
  const failureCooldownMs = options.failureCooldownMs ?? WINDOWS_REGISTRY_FAILURE_COOLDOWN_MS;

  if (!cache.inflight) {
    const task = (async () => {
      const results = await Promise.allSettled(WINDOWS_REGISTRY_PATH_KEYS.map(key => query(key, timeoutMs, env)));
      const succeeded = results.some(item => item.status === "fulfilled");
      const finishedAt = now();
      if (succeeded) {
        const nextRaw: string[] = [];
        for (const item of results) {
          if (item.status === "fulfilled" && item.value) nextRaw.push(item.value);
        }
        cache.rawValues = nextRaw;
        cache.expiresAt = finishedAt + ttlMs;
        cache.cooldownUntil = 0;
      } else {
        cache.cooldownUntil = finishedAt + failureCooldownMs;
      }
    })().finally(() => {
      if (cache.inflight === task) cache.inflight = undefined;
    });
    cache.inflight = task;
  }

  await cache.inflight;
  return parseWindowsRegistryPathEntries(cache.rawValues, env);
}

/** Test helpers: clear cached registry entries or inject a stub query function. */
export function resetWindowsRegistryPathCache(): void {
  cache = { rawValues: [], expiresAt: 0, cooldownUntil: 0 };
}

export function setWindowsRegistryQueryForTest(query: WindowsRegistryQueryFn | undefined): void {
  testQueryOverride = query;
}
