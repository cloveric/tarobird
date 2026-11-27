import os from "node:os";
import path from "node:path";
import { expandPiPath } from "../codex/pi-session-store.js";
import { executableCandidates, resolveEngineExecutable } from "./engine-process.js";

const SAFE_PROFILE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Resolve oh-my-pi's active agent directory, matching upstream `packages/utils/src/dirs.ts`:
 * - Named profile (`OMP_PROFILE`): `<ompRoot>/profiles/<profile>/agent` (supersedes `PI_CODING_AGENT_DIR`).
 * - Default profile: `PI_CODING_AGENT_DIR` if set, else `<ompRoot>/agent`, where `<ompRoot>` is
 *   `PI_CONFIG_DIR` / `OMP_CONFIG_DIR` or `~/.omp`.
 */
export function ompAgentDir(env: NodeJS.ProcessEnv, homeDir = os.homedir(), cwd?: string): string {
  const resolveDir = (raw: string) => {
    const expanded = expandPiPath(raw, homeDir);
    return cwd ? path.resolve(cwd, expanded) : path.resolve(expanded);
  };
  const baseRootRaw = env.PI_CONFIG_DIR?.trim() || env.OMP_CONFIG_DIR?.trim();
  const baseRoot = baseRootRaw ? resolveDir(baseRootRaw) : path.join(homeDir, ".omp");
  const profile = env.OMP_PROFILE?.trim();
  if (profile && SAFE_PROFILE_NAME.test(profile) && !profile.includes("..")) {
    return path.join(baseRoot, "profiles", profile, "agent");
  }
  const agentOverride = env.PI_CODING_AGENT_DIR?.trim();
  if (agentOverride) return resolveDir(agentOverride);
  return path.join(baseRoot, "agent");
}

/** Native oh-my-pi sessions directory (`<ompAgentDir>/sessions`). */
export function ompNativeSessionsDir(env: NodeJS.ProcessEnv, homeDir = os.homedir(), cwd?: string): string {
  return path.join(ompAgentDir(env, homeDir, cwd), "sessions");
}

/**
 * Resolve the file an `omp` launch executes. A bare command name is resolved
 * strictly through absolute PATH directories (never relative to the workspace).
 * An explicit absolute path is returned unchanged.
 */
export function resolveOmpLaunchCommand(command: string, env: NodeJS.ProcessEnv, platform = process.platform): string | undefined {
  const windows = platform === "win32";
  const name = command.trim().replace(/^"(.*)"$/, "$1");
  if (!name) return undefined;
  if (windows ? /[\\/]/.test(name) : name.includes("/")) return command;
  const absolute = (file: string) => windows ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(file) : path.posix.isAbsolute(file);
  for (const file of executableCandidates(name, env, platform)) {
    const found = absolute(file) ? resolveEngineExecutable(file, env, platform) : undefined;
    if (found) return found;
  }
  return undefined;
}

/**
 * Shared by launch, Doctor, Host engine settings, and availability checks.
 * Covers oh-my-pi's official install paths: explicit OMP_EXECUTABLE override,
 * PATH, omp.sh (~/.local/bin, ~/.omp/bin), Homebrew (/opt/homebrew/bin,
 * /usr/local/bin), and bun global installs ($BUN_INSTALL/bin, ~/.bun/bin).
 */
export function resolveOmpExecutable(env: NodeJS.ProcessEnv, platform = process.platform): string {
  const windows = platform === "win32", p = windows ? path.win32 : path.posix;
  const value = (key: string) => env[key] ?? (windows ? Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1] : undefined);
  const explicit = value("OMP_EXECUTABLE");
  if (explicit !== undefined && explicit !== "") return explicit.trim().replace(/^"(.*)"$/, "$1");
  if (resolveEngineExecutable("omp", env, platform)) return "omp";
  const absolute = (candidate: string | undefined) => candidate && !/[\x00-\x1f\x7f]/.test(candidate)
    && (windows ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(candidate) : p.isAbsolute(candidate)) ? candidate : undefined;
  const home = absolute(value(windows ? "USERPROFILE" : "HOME"));
  const bunInstall = absolute(value("BUN_INSTALL"));
  const roaming = absolute(value("APPDATA")) ?? (home && p.join(home, "AppData", "Roaming"));
  const binNames = windows ? ["omp.exe", "omp.cmd", "omp.ps1"] : ["omp"];
  const dirs = [
    ...(bunInstall ? [p.join(bunInstall, "bin")] : []),
    ...(home ? [p.join(home, ".bun", "bin"), p.join(home, ".local", "bin"), p.join(home, ".omp", "bin")] : []),
    ...(!windows ? ["/opt/homebrew/bin", "/usr/local/bin"] : []),
    ...(windows && roaming ? [p.join(roaming, "npm")] : []),
  ];
  for (const dir of dirs) {
    for (const bin of binNames) {
      const candidate = p.join(dir, bin);
      if (resolveEngineExecutable(candidate, env, platform)) return candidate;
    }
  }
  return "omp";
}
