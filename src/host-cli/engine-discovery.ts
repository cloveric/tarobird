import { accessSync, closeSync, constants, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnEngine } from "../runtime/engine-process.js";
import { envLookupCaseInsensitive, mergeWindowsPathEntries, refreshWindowsRegistryPath, validWindowsDirectory } from "../runtime/windows-registry-path.js";

export type DiscoveryRule =
  | "setting"
  | "environment"
  | "auto-discovered"
  | "login-shell"
  | "package-manager"
  | "windows-registry"
  | "path"
  | "known-directory";

export type TaggedDirectory = {
  dir: string;
  rule: Exclude<DiscoveryRule, "setting" | "environment">;
};

export type DanglingLinkInfo = {
  linkPath: string;
  targetPath: string;
};

export type ShellProbeResult = {
  ok: boolean;
  timedOut?: boolean;
  status: "ok" | "timeout" | "failed" | "skipped";
  pathDirs: string[];
  resolvedCommands: Record<string, string>;
};

export type CommandRunner = (
  file: string,
  args: string[],
  options: { timeout: number; env?: NodeJS.ProcessEnv; windowsHide?: boolean; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

/** Thrown when an owner's close aborts discovery: the result must not be cached or used. */
export class DiscoveryAbortedError extends Error {
  constructor() { super("engine_discovery_aborted"); this.name = "DiscoveryAbortedError"; }
}
const throwIfAborted = (signal: AbortSignal | undefined) => { if (signal?.aborted) throw new DiscoveryAbortedError(); };

export const SHELL_ENV_PROBE_FLAG = "TAROBIRD_SHELL_ENV_PROBE";

const MAX_RUNNER_BUFFER = 2 * 1024 * 1024;

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { killed?: boolean; signal?: string; code?: string };
  return !!candidate.killed || candidate.signal === "SIGTERM" || candidate.code === "ETIMEDOUT";
}

/** Execute a discovery helper command with stdin closed (`ignore`) and Windows
 * `.cmd`/`.bat` shim support (via `spawnEngine`, avoiding Node 22+ `execFile` EINVAL). */
export const defaultCommandRunner: CommandRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let child: ReturnType<typeof spawnEngine>;
    if (options.signal?.aborted) { reject(new DiscoveryAbortedError()); return; }
    try {
      child = spawnEngine(file, args, {
        env: options.env,
        windowsHide: options.windowsHide ?? true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
    let aborted = false;
    const cleanup = () => {
      // hardKillTimer is left running: a timed-out interactive shell ignores SIGTERM
      // and must still get its SIGKILL after the promise has settled.
      if (timeoutTimer) clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve({ stdout, stderr });
    };
    const killChild = () => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          if (process.platform !== "win32") {
            hardKillTimer = setTimeout(() => {
              try {
                if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
              } catch { /* ignore */ }
            }, 250);
            hardKillTimer.unref();
          }
        }
      } catch { /* ignore */ }
    };
    // The owner is closing: terminate the child and settle only once it has exited,
    // so nothing it spawned keeps writing into HOME or the state folder.
    function onAbort() {
      aborted = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (child.exitCode !== null || child.signalCode !== null) { finish(new DiscoveryAbortedError()); return; }
      killChild();
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const timeoutTimer = options.timeout > 0
      ? setTimeout(() => {
        killChild();
        finish(Object.assign(new Error(`Command timed out after ${options.timeout}ms`), {
          killed: true,
          signal: "SIGTERM",
          code: "ETIMEDOUT",
        }));
      }, options.timeout)
      : undefined;
    timeoutTimer?.unref();

    const onData = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_RUNNER_BUFFER) {
        killChild();
        finish(Object.assign(new Error("Command maxBuffer exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }));
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };

    child.stdout?.on("data", (chunk: Buffer) => onData("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => onData("stderr", chunk));
    child.once("error", error => finish(aborted ? new DiscoveryAbortedError() : error));
    child.once("close", (code, signal) => {
      if (aborted) {
        finish(new DiscoveryAbortedError());
      } else if (code === 0 && !signal) {
        finish();
      } else {
        finish(Object.assign(new Error(`Command failed (${signal ?? code ?? "unknown"})`), {
          code: code ?? undefined,
          signal: signal ?? undefined,
          stdout,
          stderr,
        }));
      }
    });
  });

const defaultRunner: CommandRunner = defaultCommandRunner;

const directoryExists = (directory: string) => { try { return statSync(directory).isDirectory(); } catch { return false; } };
function smallAlias(file: string): string | undefined {
  try { const info = statSync(file); if (info.isFile() && info.size <= 4096) return readFileSync(file, "utf8").trim(); } catch { /* Not configured. */ }
}

/** Platform-aware wrapper over the shared Windows lookup: exact key on POSIX, case-insensitive on Windows. */
export function lookupEnvCaseInsensitive(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform = process.platform): string | undefined {
  return platform === "win32" ? envLookupCaseInsensitive(env, key) : env[key];
}

/** Read nvm's selected default only. Never add every installed Node version,
 * execute shell profiles, or guess a version when an alias cannot be resolved. */
function nvmDefault(root: string): string | undefined {
  let alias = "default";
  const seen = new Set<string>();
  for (let depth = 0; depth < 16; depth++) {
    if (seen.has(alias)) return; seen.add(alias);
    if (/^v?\d+(?:\.\d+){0,2}$/.test(alias) || alias === "node" || alias === "stable") {
      try {
        const names = readdirSync(path.join(root, "versions/node"));
        if (names.length > 1024) return;
        // nvm documents `stable` as an alias for `node`: the newest installed version.
        const prefix = alias.replace(/^v/, ""), any = alias === "node" || alias === "stable";
        const selected = names.filter(name => /^v\d+\.\d+\.\d+$/.test(name))
          .filter(name => any || name.slice(1) === prefix || name.slice(1).startsWith(`${prefix}.`))
          .sort((a, b) => { const aa = a.slice(1).split(".").map(Number), bb = b.slice(1).split(".").map(Number); return bb[0]! - aa[0]! || bb[1]! - aa[1]! || bb[2]! - aa[2]!; })[0];
        return selected ? path.join(root, "versions/node", selected, "bin") : undefined;
      } catch { return; }
    }
    if (!/^(?:[a-zA-Z0-9_-]+|lts\/(?:[a-zA-Z0-9_-]+|\*))$/.test(alias)) return;
    const next = smallAlias(path.join(root, "alias", alias)); if (!next) return; alias = next;
  }
}

/** fnm uses the first existing base directory: XDG data (also on macOS), then
 * the legacy ~/.fnm, then macOS Application Support. Mirror that order instead
 * of searching a directory fnm itself would not use. */
function fnmDirectory(home: string, data: string, platform: NodeJS.Platform): string {
  const candidates = [path.join(data, "fnm"), path.join(home, ".fnm"), ...(platform === "darwin" ? [path.join(home, "Library/Application Support/fnm")] : [])];
  return candidates.find(directoryExists) ?? candidates[0]!;
}

/** Discover common Windows CLI installation directories dynamically so CLIs
 * installed after Host startup (e.g. `%LOCALAPPDATA%\agy\bin`, `%APPDATA%\npm`,
 * `%LOCALAPPDATA%\pnpm`, WinGet/Scoop/Cargo/local shims) are found without a restart. */
export function discoverWindowsEngineDirectories(
  home: string,
  env: NodeJS.ProcessEnv,
  existsCheck: (dir: string) => boolean = directoryExists,
): string[] {
  const strictRoot = (candidate: string | undefined): string | undefined => {
    if (!candidate || /["\x00-\x1f\x7f;]/.test(candidate)) return undefined;
    return validWindowsDirectory(candidate);
  };
  const validHome = strictRoot(home) ?? strictRoot(envLookupCaseInsensitive(env, "USERPROFILE")) ?? strictRoot(envLookupCaseInsensitive(env, "HOME"));
  const appDataRoot = (key: "LOCALAPPDATA" | "APPDATA", suffix: "Local" | "Roaming"): string | undefined => {
    const configured = envLookupCaseInsensitive(env, key);
    // An explicitly configured invalid root must fail closed instead of silently
    // falling back to USERPROFILE.
    if (configured !== undefined) return strictRoot(configured);
    return validHome ? path.win32.join(validHome, "AppData", suffix) : undefined;
  };
  const envRoot = (key: string, fallback: string | undefined): string | undefined => {
    const configured = envLookupCaseInsensitive(env, key);
    if (configured !== undefined) return strictRoot(configured);
    return fallback;
  };

  const local = appDataRoot("LOCALAPPDATA", "Local");
  const roaming = appDataRoot("APPDATA", "Roaming");
  const pnpm = envRoot("PNPM_HOME", local ? path.win32.join(local, "pnpm") : undefined);
  const volta = envRoot("VOLTA_HOME", validHome ? path.win32.join(validHome, ".volta") : undefined);
  const bun = envRoot("BUN_INSTALL", validHome ? path.win32.join(validHome, ".bun") : undefined);
  const nvmSymlink = envRoot("NVM_SYMLINK", undefined);
  const scoop = envRoot("SCOOP", validHome ? path.win32.join(validHome, "scoop") : undefined);
  const cargo = envRoot("CARGO_HOME", validHome ? path.win32.join(validHome, ".cargo") : undefined);
  const piAgent = envRoot("PI_CODING_AGENT_DIR", validHome ? path.win32.join(validHome, ".pi", "agent") : undefined);
  const programFiles = envRoot("ProgramFiles", "C:\\Program Files");
  const systemRoot = envRoot("SystemRoot", "C:\\Windows");

  const candidates = [
    ...(local ? [
      path.win32.join(local, "agy", "bin"),
      path.win32.join(local, "Programs", "Antigravity", "bin"),
      path.win32.join(local, "Programs", "Antigravity"),
      path.win32.join(local, "Programs", "agy", "bin"),
      path.win32.join(local, "Programs", "agy"),
      path.win32.join(local, "Microsoft", "WinGet", "Links"),
      path.win32.join(local, "Programs"),
    ] : []),
    ...(roaming ? [path.win32.join(roaming, "npm")] : []),
    pnpm,
    ...(volta ? [path.win32.join(volta, "bin")] : []),
    ...(bun ? [path.win32.join(bun, "bin")] : []),
    nvmSymlink,
    ...(scoop ? [path.win32.join(scoop, "shims")] : []),
    ...(cargo ? [path.win32.join(cargo, "bin")] : []),
    ...(validHome ? [
      path.win32.join(validHome, ".local", "bin"),
      path.win32.join(validHome, ".npm-global", "bin"),
      path.win32.join(validHome, ".claude", "bin"),
      path.win32.join(validHome, ".claude", "local"),
      path.win32.join(validHome, ".kimi-code", "bin"),
      path.win32.join(validHome, ".kimi", "bin"),
      path.win32.join(validHome, ".dsh", "bin"),
    ] : []),
    ...(piAgent ? [path.win32.join(piAgent, "bin")] : []),
    // Volta's default per-user root, a default Scoop root next to a custom one, and
    // Git for Windows / System32 so tools engines shell out to are found too.
    ...(local ? [path.win32.join(local, "Volta", "bin")] : []),
    ...(validHome ? [path.win32.join(validHome, "scoop", "shims")] : []),
    ...(programFiles ? [path.win32.join(programFiles, "Git", "cmd"), path.win32.join(programFiles, "Git", "usr", "bin")] : []),
    ...(local ? [path.win32.join(local, "Programs", "Git", "cmd")] : []),
    ...(systemRoot ? [path.win32.join(systemRoot, "System32")] : []),
  ];

  const existing = candidates.filter((directory): directory is string => !!directory && !!validWindowsDirectory(directory) && existsCheck(directory));
  return mergeWindowsPathEntries([existing]);
}

/** Fallbacks follow the inherited PATH, preserving the operator's selection.
 * fnm's alias is a symlink to its installation; asdf/mise/Volta use stable shims. */
export function discoverEngineDirectories(
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  existsCheck: (dir: string) => boolean = directoryExists,
): string[] {
  if (platform === "win32") return discoverWindowsEngineDirectories(home, env, existsCheck);
  const root = (key: string, fallback: string) => env[key] && path.posix.isAbsolute(env[key]!) && !/[\x00-\x1f\x7f:]/.test(env[key]!) ? env[key]! : fallback;
  const data = root("XDG_DATA_HOME", path.join(home, ".local/share"));
  const fnm = root("FNM_DIR", fnmDirectory(home, data, platform));
  const candidates = [
    path.join(root("VOLTA_HOME", path.join(home, ".volta")), "bin"),
    path.join(root("BUN_INSTALL", path.join(home, ".bun")), "bin"),
    path.join(root("ASDF_DATA_DIR", path.join(home, ".asdf")), "shims"),
    path.join(root("MISE_DATA_DIR", path.join(data, "mise")), "shims"),
    path.join(fnm, "aliases/default/bin"),
    nvmDefault(root("NVM_DIR", path.join(home, ".nvm"))),
  ];
  return candidates.filter((directory): directory is string => !!directory && !/[\x00-\x1f\x7f:]/.test(directory) && existsCheck(directory));
}

const SHELL_PATH_BEGIN = "__TAROBIRD_SHELL_PATH_BEGIN__";
const SHELL_PATH_END = "__TAROBIRD_SHELL_PATH_END__";
const SHELL_CMD_PREFIX = "__TAROBIRD_CMD__:";

function safeShellPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const candidate = env.SHELL?.trim();
  if (candidate && path.posix.isAbsolute(candidate) && !/[\x00-\x1f\x7f\s]/.test(candidate)) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* fall through */ }
  }
  const sameHome = !env.HOME || path.resolve(env.HOME) === path.resolve(os.homedir());
  if (sameHome) {
    try {
      const userShell = os.userInfo().shell?.trim();
      if (userShell && path.posix.isAbsolute(userShell) && !/[\x00-\x1f\x7f\s]/.test(userShell)) {
        accessSync(userShell, constants.X_OK);
        if (statSync(userShell).isFile()) return userShell;
      }
    } catch { /* fall through */ }
  }
  return platform === "darwin" ? "/bin/zsh" : "/bin/sh";
}

function buildShellProbeInvocation(shell: string, commands: readonly string[]): { args: string[]; script: string } {
  const name = path.posix.basename(shell).toLowerCase();
  if (name === "fish") {
    const cmdChecks = commands
      .map(cmd => `set -l p (type -P -- ${cmd} 2>/dev/null); if test -n "$p"; printf '%s%s=%s\\n' '${SHELL_CMD_PREFIX}' '${cmd}' "$p"; end`)
      .join("; ");
    const script = `printf '%s\\n%s\\n%s\\n' '${SHELL_PATH_BEGIN}' (string join : -- $PATH) '${SHELL_PATH_END}'; ${cmdChecks ? `${cmdChecks}; ` : ""}true`;
    return { args: ["-ilc", script], script };
  }
  if (name === "tcsh" || name === "csh") {
    const lines = [
      'if ( $?HOME ) then',
      '  if ( -r "$HOME/.login" ) source "$HOME/.login" >& /dev/null',
      'endif',
      `printf '%s\\n%s\\n%s\\n' '${SHELL_PATH_BEGIN}' "$PATH" '${SHELL_PATH_END}'`,
      ...commands.flatMap(cmd => [
        `unalias ${cmd}`,
        `set p = "\`which ${cmd}\`"`,
        `if ( "$p" =~ /* ) printf '%s%s=%s\\n' '${SHELL_CMD_PREFIX}' '${cmd}' "$p"`,
      ]),
      "exit 0",
    ];
    const script = lines.join("\n");
    return { args: ["-ic", script], script };
  }
  if (name === "zsh") {
    const cmdChecks = commands
      .map(cmd => `p=$(whence -p -- ${cmd} 2>/dev/null || true); if [ -n "$p" ]; then printf '%s%s=%s\\n' '${SHELL_CMD_PREFIX}' '${cmd}' "$p"; fi`)
      .join("; ");
    const script = `printf '%s\\n%s\\n%s\\n' '${SHELL_PATH_BEGIN}' "$PATH" '${SHELL_PATH_END}'; ${cmdChecks ? `${cmdChecks}; ` : ""}true`;
    return { args: ["-ilc", script], script };
  }
  if (name === "bash") {
    const cmdChecks = commands
      .map(cmd => `p=$(type -P -- ${cmd} 2>/dev/null || true); if [ -n "$p" ]; then printf '%s%s=%s\\n' '${SHELL_CMD_PREFIX}' '${cmd}' "$p"; fi`)
      .join("; ");
    const script = `printf '%s\\n%s\\n%s\\n' '${SHELL_PATH_BEGIN}' "$PATH" '${SHELL_PATH_END}'; ${cmdChecks ? `${cmdChecks}; ` : ""}true`;
    return { args: ["-ilc", script], script };
  }
  const cmdChecks = commands
    .map(cmd => `unset -f ${cmd} 2>/dev/null || true; p=$(command -v ${cmd} 2>/dev/null || true); case "$p" in /*) printf '%s%s=%s\\n' '${SHELL_CMD_PREFIX}' '${cmd}' "$p" ;; esac`)
    .join("; ");
  const script = `unalias -a 2>/dev/null || true; printf '%s\\n%s\\n%s\\n' '${SHELL_PATH_BEGIN}' "$PATH" '${SHELL_PATH_END}'; ${cmdChecks ? `${cmdChecks}; ` : ""}true`;
  return { args: ["-ilc", script], script };
}

/** Probe the user's login interactive shell once (macOS / Linux) to read PATH
 * and resolve each engine command. Times out safely without failing startup. */
export async function probeLoginShellEnvironment(options: {
  commands?: readonly string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  shell?: string;
  runner?: CommandRunner;
  /** Aborted when the owner closes: the shell is killed and DiscoveryAbortedError thrown. */
  signal?: AbortSignal;
} = {}): Promise<ShellProbeResult> {
  throwIfAborted(options.signal);
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return { ok: false, status: "skipped", pathDirs: [], resolvedCommands: {} };

  const env = options.env ?? process.env;
  // A bare environment (no HOME) has no profile to source, and an explicitly
  // supplied one must not be widened by the real user's login shell.
  if (!env.HOME?.trim()) return { ok: false, status: "skipped", pathDirs: [], resolvedCommands: {} };
  if (env[SHELL_ENV_PROBE_FLAG] === "0" || env[SHELL_ENV_PROBE_FLAG] === "1") {
    return { ok: false, status: "skipped", pathDirs: [], resolvedCommands: {} };
  }
  const hasDifferentSyntheticHome = !!env.HOME && path.resolve(env.HOME) !== path.resolve(os.homedir());
  if (!options.shell && !options.runner && !env.SHELL && hasDifferentSyntheticHome) {
    return { ok: false, status: "skipped", pathDirs: [], resolvedCommands: {} };
  }
  const runner = options.runner ?? defaultRunner;
  const timeout = options.timeoutMs ?? 6000;
  const shell = options.shell ?? safeShellPath(env, platform);
  const commands = (options.commands ?? []).filter(cmd => /^[A-Za-z0-9._-]+$/.test(cmd));

  const { args } = buildShellProbeInvocation(shell, commands);
  const probeEnv: NodeJS.ProcessEnv = {
    ...env,
    [SHELL_ENV_PROBE_FLAG]: "1",
    TERM: "dumb",
    DISABLE_AUTO_UPDATE: "true",
    ZSH_TMUX_AUTOSTART: "false",
  };

  try {
    const { stdout } = await runner(shell, args, { timeout, env: probeEnv, signal: options.signal });
    const startIdx = stdout.indexOf(SHELL_PATH_BEGIN);
    const endIdx = stdout.indexOf(SHELL_PATH_END, startIdx >= 0 ? startIdx + SHELL_PATH_BEGIN.length : 0);
    if (startIdx < 0 || endIdx < 0) {
      return { ok: false, status: "failed", pathDirs: [], resolvedCommands: {} };
    }
    const rawPath = stdout.slice(startIdx + SHELL_PATH_BEGIN.length, endIdx).trim();
    const pathDirs = rawPath
      .split(":")
      .map(dir => dir.trim())
      .filter(dir => !!dir && path.posix.isAbsolute(dir) && !/[\x00-\x1f\x7f]/.test(dir));

    const resolvedCommands: Record<string, string> = {};
    const afterPath = stdout.slice(endIdx + SHELL_PATH_END.length);
    for (const line of afterPath.split(/\r?\n/)) {
      if (!line.startsWith(SHELL_CMD_PREFIX)) continue;
      const body = line.slice(SHELL_CMD_PREFIX.length);
      const eq = body.indexOf("=");
      if (eq <= 0) continue;
      const cmd = body.slice(0, eq).trim();
      const target = body.slice(eq + 1).trim();
      if (cmd && target && path.posix.isAbsolute(target) && !/[\x00-\x1f\x7f]/.test(target)) {
        resolvedCommands[cmd] = target;
      }
    }
    return { ok: true, status: "ok", pathDirs, resolvedCommands };
  } catch (error) {
    if (error instanceof DiscoveryAbortedError || options.signal?.aborted) throw new DiscoveryAbortedError();
    const timedOut = isTimeoutError(error);
    return { ok: false, timedOut, status: timedOut ? "timeout" : "failed", pathDirs: [], resolvedCommands: {} };
  }
}

function findCommandInDirs(command: string, dirs: readonly string[], platform: NodeJS.Platform): string | undefined {
  const windows = platform === "win32";
  const p = windows ? path.win32 : path.posix;
  const exts = windows ? [".exe", ".cmd", ".bat"] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = p.join(dir, command + ext);
      try {
        accessSync(candidate, windows ? constants.F_OK : constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch { /* continue */ }
    }
  }
  return undefined;
}

/** Query available package managers (`npm`, `pnpm`, `bun`, `yarn`) for their
 * global binary directories, covering manually installed Node & custom prefixes. */
export async function probePackageManagerBinDirectories(options: {
  searchDirs: readonly string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  runner?: CommandRunner;
  existsCheck?: (dir: string) => boolean;
  findTool?: (name: string) => string | undefined;
  /** Aborted when the owner closes: running package managers are killed and awaited. */
  signal?: AbortSignal;
} ): Promise<string[]> {
  throwIfAborted(options.signal);
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const p = windows ? path.win32 : path.posix;
  const env = options.env ?? process.env;
  const runner = options.runner ?? defaultRunner;
  const timeout = options.timeoutMs ?? 2500;
  const existsCheck = options.existsCheck ?? directoryExists;
  const findTool = options.findTool ?? ((name: string) => findCommandInDirs(name, options.searchDirs, platform));

  const queries: Array<{ tool: string; args: string[]; transform: (out: string) => string | undefined }> = [
    {
      tool: "npm",
      args: ["prefix", "-g"],
      transform: (out) => {
        const prefix = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1);
        if (!prefix || !p.isAbsolute(prefix)) return undefined;
        return windows ? prefix : p.join(prefix, "bin");
      },
    },
    {
      tool: "pnpm",
      args: ["bin", "-g"],
      transform: (out) => {
        const dir = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1);
        return dir && p.isAbsolute(dir) ? dir : undefined;
      },
    },
    {
      tool: "bun",
      args: ["pm", "bin", "-g"],
      transform: (out) => {
        const dir = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1);
        return dir && p.isAbsolute(dir) ? dir : undefined;
      },
    },
    {
      tool: "yarn",
      args: ["global", "bin"],
      transform: (out) => {
        const dir = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1);
        return dir && p.isAbsolute(dir) ? dir : undefined;
      },
    },
  ];

  const found = await Promise.all(queries.map(async (q) => {
    const exe = findTool(q.tool);
    if (!exe) return undefined;
    try {
      const { stdout } = await runner(exe, q.args, { timeout, env, windowsHide: true, signal: options.signal });
      const dir = q.transform(stdout);
      if (dir && !/[\x00-\x1f\x7f]/.test(dir) && existsCheck(dir)) return dir;
    } catch { /* ignore unavailable/timed-out package manager */ }
    return undefined;
  }));
  // Every query above has settled (aborted children have exited); report the abort.
  throwIfAborted(options.signal);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of found) {
    if (!dir) continue;
    const key = windows ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

/** Merge tagged search directories preserving first-occurrence priority (matching
 * terminal precedence) and deduplicating case-insensitively on Windows. */
export function mergeTaggedDirectories(lists: ReadonlyArray<readonly TaggedDirectory[]>, platform: NodeJS.Platform = process.platform): TaggedDirectory[] {
  const windows = platform === "win32";
  const seen = new Set<string>();
  const out: TaggedDirectory[] = [];
  for (const list of lists) {
    for (const entry of list) {
      const dir = entry.dir.trim().replace(/^"(.*)"$/, "$1");
      if (!dir || /[\x00-\x1f\x7f]/.test(dir)) continue;
      const key = windows ? dir.toLowerCase() : dir;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ dir, rule: entry.rule });
    }
  }
  return out;
}

/** Inspect candidates for `command` across tagged search directories, recording
 * any dangling symlinks (`linkPath -> targetPath`) instead of silently hiding them. */
export function diagnoseExecutableCandidates(
  command: string,
  taggedDirs: readonly TaggedDirectory[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { executable: string | null; rule: DiscoveryRule | null; danglingLinks: DanglingLinkInfo[] } {
  const windows = platform === "win32";
  const p = windows ? path.win32 : path.posix;
  const name = command.trim().replace(/^"(.*)"$/, "$1");
  if (!name || /[\x00-\x1f\x7f]/.test(name)) return { executable: null, rule: null, danglingLinks: [] };

  const pathext = lookupEnvCaseInsensitive(env, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD";
  const extensions = windows && !p.extname(name) ? pathext.split(";").filter(ext => /^\.[a-z0-9]+$/i.test(ext)) : [""];

  const checkFile = (file: string): "ok" | { dangling: string } | "missing" => {
    try {
      accessSync(file, windows ? constants.F_OK : constants.X_OK);
      if (statSync(file).isFile()) return "ok";
      return "missing";
    } catch {
      try {
        const link = lstatSync(file);
        if (link.isSymbolicLink()) {
          try {
            statSync(file);
            // Target exists on disk (e.g. non-executable file with EACCES); not a dangling symlink.
            return "missing";
          } catch (statError) {
            const code = (statError as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
              const rawTarget = readlinkSync(file);
              const resolvedTarget = p.isAbsolute(rawTarget) ? rawTarget : p.resolve(p.dirname(file), rawTarget);
              return { dangling: resolvedTarget };
            }
            return "missing";
          }
        }
      } catch { /* truly missing */ }
      return "missing";
    }
  };

  const danglingLinks: DanglingLinkInfo[] = [];
  if (p.isAbsolute(name)) {
    for (const ext of extensions) {
      const candidate = name + ext;
      const status = checkFile(candidate);
      if (status === "ok") return { executable: candidate, rule: null, danglingLinks };
      if (typeof status === "object") danglingLinks.push({ linkPath: candidate, targetPath: status.dangling });
    }
    return { executable: null, rule: null, danglingLinks };
  }

  for (const { dir, rule } of taggedDirs) {
    for (const ext of extensions) {
      const candidate = p.join(dir, name + ext);
      const status = checkFile(candidate);
      if (status === "ok") return { executable: candidate, rule, danglingLinks };
      if (typeof status === "object") danglingLinks.push({ linkPath: candidate, targetPath: status.dangling });
    }
  }
  return { executable: null, rule: null, danglingLinks };
}

// --- Cached probe coordinator + version cache ---

export type EnvironmentDiscoveryResult = {
  at: number;
  shell: ShellProbeResult;
  packageManagerDirs: string[];
  windowsRegistryDirs: string[];
};

type CachedProbeEntry = {
  key: string;
  runner?: CommandRunner;
  windowsRegistryKey: string;
  value: {
    at: number;
    shell: ShellProbeResult;
    packageManagerDirs: string[];
  };
};

const PROBE_CACHE_TTL_MS = 60_000;
let probeCache: CachedProbeEntry | undefined;
let probeGeneration = 0;
let inFlightProbe: { key: string; runner?: CommandRunner; signal?: AbortSignal; promise: Promise<EnvironmentDiscoveryResult> } | undefined;
const versionCache = new Map<string, { mtimeMs: number; version: string | null }>();

export function clearDiscoveryCaches(): void {
  ++probeGeneration;
  probeCache = undefined;
  inFlightProbe = undefined;
  versionCache.clear();
}

export async function runEnvironmentDiscovery(options: {
  baseEnv: NodeJS.ProcessEnv;
  commands: readonly string[];
  home?: string;
  platform?: NodeJS.Platform;
  forceRefresh?: boolean;
  /** The caller has just force-refreshed the Windows registry PATH cache: reuse it. */
  registryRefreshed?: boolean;
  timeoutMs?: number;
  runner?: CommandRunner;
  /** The owner's close signal: no step starts after it fires, running children are
   * killed and awaited, and the call rejects with DiscoveryAbortedError (nothing cached). */
  signal?: AbortSignal;
}): Promise<EnvironmentDiscoveryResult> {
  throwIfAborted(options.signal);
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const basePath = lookupEnvCaseInsensitive(options.baseEnv, "PATH", platform) ?? "";
  const cacheKey = `${platform}|${home}|${options.baseEnv.SHELL ?? ""}|${options.baseEnv.ZDOTDIR ?? ""}|${options.baseEnv[SHELL_ENV_PROBE_FLAG] ?? ""}|${options.commands.join(",")}|${basePath}`;

  // Registry PATH has its own shorter refresh interval than package-manager discovery.
  if (platform === "win32") {
    const windowsRegistryDirs = await refreshWindowsRegistryPath(options.baseEnv, { platform, force: options.forceRefresh && !options.registryRefreshed });
    const windowsRegistryKey = windowsRegistryDirs.map(dir => dir.toLowerCase()).join(";");
    if (
      !options.forceRefresh
      && probeCache
      && probeCache.key === cacheKey
      && probeCache.runner === options.runner
      && probeCache.windowsRegistryKey === windowsRegistryKey
      && Date.now() - probeCache.value.at < PROBE_CACHE_TTL_MS
    ) {
      return {
        at: probeCache.value.at,
        shell: probeCache.value.shell,
        packageManagerDirs: probeCache.value.packageManagerDirs,
        windowsRegistryDirs,
      };
    }
    const baseDirs = basePath.split(";").filter(Boolean);
    const knownDirs = discoverEngineDirectories(home, options.baseEnv, platform);
    const combinedForPm = [...new Set([...baseDirs, ...knownDirs, ...windowsRegistryDirs])];
    const generation = ++probeGeneration;
    const packageManagerDirs = await probePackageManagerBinDirectories({
      searchDirs: combinedForPm,
      env: { ...options.baseEnv, PATH: combinedForPm.join(";") },
      platform,
      runner: options.runner,
      signal: options.signal,
    });
    const shell: ShellProbeResult = { ok: false, status: "skipped", pathDirs: [], resolvedCommands: {} };
    const at = Date.now();
    if (generation === probeGeneration) probeCache = { key: cacheKey, runner: options.runner, windowsRegistryKey, value: { at, shell, packageManagerDirs } };
    return { at, shell, packageManagerDirs, windowsRegistryDirs };
  }

  if (
    !options.forceRefresh
    && probeCache
    && probeCache.key === cacheKey
    && probeCache.runner === options.runner
    && Date.now() - probeCache.value.at < PROBE_CACHE_TTL_MS
  ) {
    return {
      at: probeCache.value.at,
      shell: probeCache.value.shell,
      packageManagerDirs: probeCache.value.packageManagerDirs,
      windowsRegistryDirs: [],
    };
  }

  if (!options.forceRefresh && inFlightProbe && inFlightProbe.key === cacheKey && inFlightProbe.runner === options.runner && inFlightProbe.signal === options.signal) {
    return inFlightProbe.promise;
  }

  const generation = ++probeGeneration;
  const work = (async (): Promise<EnvironmentDiscoveryResult> => {
    const shell = await probeLoginShellEnvironment({
      commands: options.commands,
      env: options.baseEnv,
      platform,
      timeoutMs: options.timeoutMs ?? 6_000,
      runner: options.runner,
      signal: options.signal,
    });

    const baseDirs = basePath.split(":").filter(Boolean);
    const knownDirs = discoverEngineDirectories(home, options.baseEnv, platform);
    const combinedForPm = [...new Set([...shell.pathDirs, ...baseDirs, ...knownDirs])];
    const packageManagerDirs = await probePackageManagerBinDirectories({
      searchDirs: combinedForPm,
      env: { ...options.baseEnv, PATH: combinedForPm.join(":") },
      platform,
      runner: options.runner,
      signal: options.signal,
    });

    const at = Date.now();
    if (generation === probeGeneration) probeCache = { key: cacheKey, runner: options.runner, windowsRegistryKey: "", value: { at, shell, packageManagerDirs } };
    return { at, shell, packageManagerDirs, windowsRegistryDirs: [] };
  })();

  if (!options.forceRefresh) {
    const entry = { key: cacheKey, runner: options.runner, signal: options.signal, promise: work };
    inFlightProbe = entry;
    void work.finally(() => {
      if (inFlightProbe === entry) inFlightProbe = undefined;
    }).catch(() => undefined);
  }
  return work;
}

function looksLikeUnixExecutable(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY);
    const buf = Buffer.alloc(4);
    const bytes = readSync(fd, buf, 0, 4, 0);
    if (bytes < 2) return false;
    // Shebang script (#!)
    if (buf[0] === 0x23 && buf[1] === 0x21) return true;
    if (bytes < 4) return false;
    // ELF (\x7fELF)
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true;
    // Mach-O 32/64/universal magics
    const magic = buf.readUInt32BE(0);
    return magic === 0xcffaedfe || magic === 0xfeedfacf || magic === 0xcefaedfe || magic === 0xfeedface || magic === 0xcafebabe || magic === 0xbebafeca;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export function cachedExecutableVersion(executable: string): string | null {
  const cached = versionCache.get(executable);
  if (!cached) return null;
  try {
    return statSync(executable).mtimeMs === cached.mtimeMs ? cached.version : null;
  } catch {
    return null;
  }
}

/** Read an engine CLI's `--version` safely with a bounded timeout and mtime cache.
 * Never caches transient failures/timeouts, and bypasses cache on `forceRefresh`. */
export async function probeExecutableVersion(
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = defaultRunner,
  options: { forceRefresh?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string | null> {
  if (options.signal?.aborted) return null;
  let mtimeMs = 0;
  try { mtimeMs = statSync(executable).mtimeMs; } catch { return null; }

  if (options.forceRefresh) {
    versionCache.delete(executable);
  } else {
    const cached = versionCache.get(executable);
    if (cached && cached.mtimeMs === mtimeMs) return cached.version;
  }

  if (runner === defaultRunner && process.platform !== "win32" && !looksLikeUnixExecutable(executable)) {
    versionCache.set(executable, { mtimeMs, version: null });
    return null;
  }

  try {
    const { stdout, stderr } = await runner(executable, ["--version"], { timeout: options.timeoutMs ?? 4500, env, windowsHide: true, signal: options.signal });
    const raw = (stdout || stderr).split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? "";
    const version = raw ? raw.slice(0, 80) : null;
    if (version !== null) versionCache.set(executable, { mtimeMs, version });
    return version;
  } catch {
    // Do not cache transient errors or timeouts so subsequent reads can recover.
    return null;
  }
}
