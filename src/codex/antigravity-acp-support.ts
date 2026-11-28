import { existsSync } from "node:fs";
import path from "node:path";
import { spawnEngine } from "../runtime/engine-process.js";

const VERSION_PROBE_TIMEOUT_MS = 3_000;

/** Resolves the configured `agy` executable from `ANTIGRAVITY_EXECUTABLE` (stripping surrounding quotes) or default locations. */
export function resolveAntigravityExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ANTIGRAVITY_EXECUTABLE?.trim();
  if (configured) {
    return configured.length >= 2 && configured.startsWith("\"") && configured.endsWith("\"")
      ? configured.slice(1, -1)
      : configured;
  }
  if (process.platform === "win32") {
    const appData = env.APPDATA ?? (env.USERPROFILE ? path.join(env.USERPROFILE, "AppData", "Roaming") : undefined);
    if (appData) {
      const cmd = path.join(appData, "npm", "agy.cmd");
      if (existsSync(cmd)) return cmd;
      const ps1 = path.join(appData, "npm", "agy.ps1");
      if (existsSync(ps1)) return ps1;
    }
  }
  return "agy";
}

function parseAntigravityVersion(versionOutput: string): { major: number; minor: number; patch: number } | undefined {
  const match = versionOutput.trim().match(/\bv?(\d+)\.(\d+)\.(\d+)(?:[-+][^\s]*)?\b/);
  if (!match) return undefined;
  const major = Number(match[1]), minor = Number(match[2]), patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return undefined;
  return { major, minor, patch };
}

/**
 * Whether this version of `agy` can run a Bot through `agy acp`. The server exists since 1.5.0; the adapter
 * relies on two fixes of 1.5.10: what the agent does after a turn has ended reaches the client, and closing a
 * session ends its background work.
 */
export function antigravityVersionSupportsAcp(versionOutput: string): boolean {
  const v = parseAntigravityVersion(versionOutput);
  if (!v) return false;
  return v.major > 1 || v.major === 1 && (v.minor > 5 || v.minor === 5 && v.patch >= 10);
}

/** Whether this version of `agy` includes `/swarm` mode (added in 1.5.5). */
export function antigravityVersionSupportsSwarm(versionOutput: string): boolean {
  const v = parseAntigravityVersion(versionOutput);
  if (!v) return false;
  return v.major > 1 || v.major === 1 && (v.minor > 5 || v.minor === 5 && v.patch >= 5);
}

type VersionProbeStatus = "supported" | "timed_out" | "unavailable" | "unsupported";

function probeAntigravityVersion(executable: string, env: NodeJS.ProcessEnv, check: (output: string) => boolean): Promise<VersionProbeStatus> {
  return new Promise<VersionProbeStatus>(resolve => {
    let settled = false, output = "";
    const finish = (status: VersionProbeStatus) => { if (settled) return; settled = true; clearTimeout(timer); resolve(status); };
    let child: ReturnType<typeof spawnEngine>;
    try { child = spawnEngine(executable, ["--version"], { stdio: ["ignore", "pipe", "pipe"], shell: false, env, windowsHide: true }); }
    catch { resolve("unavailable"); return; }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } finish("timed_out"); }, VERSION_PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer | string) => { output = `${output}${String(chunk)}`.slice(-4_096); });
    child.once("error", () => finish("unavailable"));
    child.once("close", code => finish(code !== 0 ? "unavailable" : check(output) ? "supported" : "unsupported"));
  });
}

/** Asks the installed CLI for its version. A missing CLI, an error or no answer in three seconds all mean no. */
export async function antigravitySupportsAcp(executable: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return await probeAntigravityAcpVersion(executable, env) === "supported";
}

export function probeAntigravityAcpVersion(executable: string, env: NodeJS.ProcessEnv): Promise<VersionProbeStatus> {
  return probeAntigravityVersion(executable, env, antigravityVersionSupportsAcp);
}

/** Checks whether the installed `agy` CLI version supports `/swarm` (>= 1.5.5). */
export async function antigravitySupportsSwarm(executable: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return await probeAntigravityVersion(executable, env, antigravityVersionSupportsSwarm) === "supported";
}
