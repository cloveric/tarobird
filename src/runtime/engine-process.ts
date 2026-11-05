import { spawn, type SpawnOptions, type ChildProcess } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import path from "node:path";
import crossSpawn from "cross-spawn";

export function executableCandidates(command: string, env: NodeJS.ProcessEnv, platform = process.platform): string[] {
  const windows = platform === "win32", paths = windows ? path.win32 : path;
  const name = command.trim().replace(/^"(.*)"$/, "$1");
  const lookup = (key: string) => env[key] ?? (windows ? Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1] : undefined);
  const dirs = paths.isAbsolute(name) ? [""] : (lookup("PATH") ?? "").split(windows ? ";" : ":").map(dir => dir.replace(/^"(.*)"$/, "$1")).filter(Boolean);
  // Windows does not treat extensionless npm shims as executables. Prefer the
  // native/.cmd entries just as CreateProcess and npm do, never a cwd shadow.
  const extensions = windows && !paths.extname(name) ? (lookup("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(ext => /^\.[a-z0-9]+$/i.test(ext)) : [""];
  return dirs.flatMap(dir => extensions.map(ext => paths.join(dir, name + ext)));
}

export function resolveEngineExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return executableCandidates(command, env).find(file => {
    try { accessSync(file, process.platform === "win32" ? constants.F_OK : constants.X_OK); return statSync(file).isFile(); } catch { return false; }
  });
}

/** PATHEXT, npm shims, spaces and shell metacharacters use cross-spawn's
 * Windows escaping. Prompts stay on stdin; never enable shell: true. */
export function spawnEngine(command: string, args: string[], options: SpawnOptions): ChildProcess {
  if (process.platform !== "win32") return spawn(command, args, options);
  const resolved = resolveEngineExecutable(command, options.env);
  if (resolved && /\.cmd$/i.test(resolved)) {
    // npm's JS launcher can run directly with our bundled Node. Avoiding an
    // intermediate cmd.exe preserves DSH's additional IPC pipe handles too.
    const entry = npmShimEntrypoint(resolved);
    if (entry) return spawn(process.execPath, [entry, ...args], { ...options, shell: false, windowsHide: true });
  }
  if (/\.ps1$/i.test(command)) return spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-File", resolved ?? command, ...args], { ...options, shell: false, windowsHide: true });
  return crossSpawn(resolved ?? command, args, { ...options, shell: false, windowsHide: true });
}

export function npmShimEntrypoint(shim: string): string | undefined {
  try {
    const body = readFileSync(shim, "utf8");
    if (body.length > 16384) return;
    const match = body.match(/"%~?dp0%?[\\/]([^"\r\n]+\.(?:js|mjs|cjs))"/i);
    if (!match) return;
    const candidate = path.resolve(path.dirname(shim), ...match[1]!.split(/[\\/]/));
    if (statSync(candidate).isFile()) return candidate;
  } catch { /* Non-npm launchers use cross-spawn. */ }
}
