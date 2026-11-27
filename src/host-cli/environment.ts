import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverEngineDirectories } from "./engine-discovery.js";
import { deepseekExecutableOverride } from "../runtime/deepseek-executable.js";
import { isLiveHostEnvironment, markLiveHostEnvironment, mergeWindowsPathEntries, readWindowsPathEntries, setCanonicalWindowsPath } from "../runtime/windows-registry-path.js";

export const HOST_ENGINE_EXECUTABLE_KEYS = ["CODEX_EXECUTABLE", "CLAUDE_EXECUTABLE", "ANTIGRAVITY_EXECUTABLE", "KIMI_EXECUTABLE", "DSH_EXECUTABLE", "PI_EXECUTABLE", "OMP_EXECUTABLE"] as const;
export const HOST_CONFIG_DIRECTORY_KEYS = ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "DSH_HOME", "KIMI_CODE_HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_CONFIG_DIR", "OMP_CONFIG_DIR", "OMP_PROFILE"] as const;
export const HOST_PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;
export const HOST_PRESERVED_ENVIRONMENT_KEYS = [...HOST_ENGINE_EXECUTABLE_KEYS, ...HOST_CONFIG_DIRECTORY_KEYS, ...HOST_PROXY_KEYS] as const;
export type HostEnvironmentOptions = { platform?: NodeJS.Platform; home?: string; executable?: string; env?: NodeJS.ProcessEnv };
/** Desktop and foreground/detached CLI hosts must find the same installed CLIs,
 * even when launched with the minimal PATH supplied by macOS GUI processes. */
export function hostProcessEnvironment(options: HostEnvironmentOptions = {}): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform, windows = platform === "win32", p = windows ? path.win32 : path.posix;
  const home = options.home ?? os.homedir(), env = options.env ?? process.env;
  const lookup = (key: string) => env[key] ?? (windows ? Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1] : undefined);
  const paths = [p.dirname(options.executable ?? process.execPath), p.join(home, ".local/bin"), p.join(home, ".npm-global/bin"), p.join(home, ".kimi-code/bin")];
  if (windows) {
    if (lookup("APPDATA")) paths.push(p.join(lookup("APPDATA")!, "npm"));
    paths.push(p.join(home, ".cargo/bin"), p.join(home, "scoop/shims"));
    paths.push(...readWindowsPathEntries(env).entries);
    paths.push(...discoverEngineDirectories(home, env, platform));
    const merged = mergeWindowsPathEntries([paths]);
    const result = { ...env };
    setCanonicalWindowsPath(result, merged, true);
    if (isLiveHostEnvironment(env)) markLiveHostEnvironment(result);
    return result;
  }
  paths.push("/opt/homebrew/bin", "/usr/local/bin");
  paths.push(...(lookup("PATH") ?? "").split(":").filter(Boolean));
  paths.push(...discoverEngineDirectories(home, env, platform));
  const seen = new Set<string>();
  const search = paths.filter(value => { if (seen.has(value)) return false; seen.add(value); return true; }).join(":");
  const result = { ...env, PATH: search };
  if (isLiveHostEnvironment(env)) markLiveHostEnvironment(result);
  return result;
}
/** Native desktop_host.rs bootstraps Node; the shared Host adds manager fallbacks.
 * Only explicit engine paths,
 * configuration directories and proxy settings are retained. Proxies can have
 * credentials, so the caller must keep the result private and never log it. */
export function buildHostEnvironment(options: HostEnvironmentOptions = {}): Record<string, string> {
  const platform = options.platform ?? process.platform, windows = platform === "win32", p = windows ? path.win32 : path.posix;
  const home = options.home ?? os.homedir(), env = options.env ?? process.env;
  const lookup = (key: string) => env[key] ?? (windows ? Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1] : undefined);
  const environment: Record<string, string> = { HOME: home, PATH: hostProcessEnvironment({ ...options, home }).PATH! };
  if (windows) {
    environment.USERPROFILE = home;
    for (const key of ["APPDATA", "LOCALAPPDATA"]) if (lookup(key)) environment[key] = lookup(key)!;
    const extensions = (lookup("PATHEXT") ?? "").split(";").filter(Boolean);
    if (!extensions.every(extension => /^\.[a-z0-9]+$/i.test(extension))) throw new Error("host_service_invalid_pathext");
    if (extensions.length) environment.PATHEXT = extensions.join(";");
  }
  for (const key of HOST_ENGINE_EXECUTABLE_KEYS) if (lookup(key)) {
    const raw = lookup(key)!;
    // Match the DeepSeek worker's quoted-path support without trimming away
    // invalid control characters or changing the other engines' validation.
    const value = windows && key === "DSH_EXECUTABLE" && !/[\x00-\x1f\x7f]/.test(raw)
      ? deepseekExecutableOverride({ DSH_EXECUTABLE: raw }, platform) ?? raw : raw;
    if (!p.isAbsolute(value)) throw new Error(`host_service_engine_override_absolute_path_required: ${key}`);
    environment[key] = value;
  }
  for (const key of HOST_CONFIG_DIRECTORY_KEYS) if (lookup(key)) {
    const value = lookup(key)!;
    if (key === "OMP_PROFILE") {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(value) || value.includes("..")) throw new Error(`host_service_invalid_environment: ${key}`);
    } else if (key !== "PI_CODING_AGENT_DIR" && key !== "PI_CODING_AGENT_SESSION_DIR" && key !== "PI_CONFIG_DIR" && key !== "OMP_CONFIG_DIR" && !p.isAbsolute(value)) {
      // Pi and omp resolve tilde, file URLs and relative directory settings in
      // each worker's workspace. Preserve those native forms instead of rebasing them.
      throw new Error(`host_service_config_directory_absolute_path_required: ${key}`);
    }
    environment[key] = value;
  }
  for (const key of HOST_PROXY_KEYS) {
    if (windows && key !== key.toUpperCase()) continue;
    const variants = windows ? Object.entries(env).filter(([name, value]) => name.toUpperCase() === key && value !== undefined) : [];
    if (new Set(variants.map(([, value]) => value)).size > 1) throw new Error(`host_service_conflicting_environment: ${key}`);
    const value = windows ? lookup(key) : env[key];
    if (value) environment[key] = value;
  }
  for (const [key, value] of Object.entries(environment)) if (/[\x00-\x1f\x7f]/.test(value)) throw new Error(`host_service_invalid_environment: ${key}`);
  if (isLiveHostEnvironment(env)) markLiveHostEnvironment(environment);
  return environment;
}
export async function validateHostEnvironmentExecutables(environment: Record<string, string>, platform = process.platform): Promise<void> {
  for (const key of HOST_ENGINE_EXECUTABLE_KEYS) if (environment[key]) {
    try {
      if (!(await stat(environment[key])).isFile()) throw new Error("not_a_file");
      await access(environment[key], platform === "win32" ? constants.F_OK : constants.X_OK);
    } catch { throw new Error(`host_service_engine_override_unavailable: ${key} (${environment[key]})`); }
  }
}
