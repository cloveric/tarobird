import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Writable } from "node:stream";
import {
  terminalConfigureSchema,
  terminalConfigureText,
  terminalCreateSchema,
  terminalInputSchema,
  terminalOutputSchema,
  terminalPolicySchema,
  terminalResizeSchema,
  terminalStatusSchema,
  type TerminalConfigure,
  type TerminalCreate,
  type TerminalOutput,
  type TerminalPolicy,
  type TerminalSessionInfo,
  type TerminalStatus,
} from "../client-protocol/host-terminal.js";
import type { DeviceActionProof } from "../client-protocol/device-actions.js";
import { killProcessTree } from "../codex/process-tree.js";
import { loadInstanceConfig, resolveInstanceWorkspacePath } from "../state/instance-config.js";
import { hashSecret, type AuthSession, type HubAuth } from "./auth.js";
import { HubError, type Device, type HubStore } from "./store.js";

const TERMINAL_POLICY_KEY = "terminal-policy:v1";
const TERMINAL_LAST_COMMAND_KEY = "terminal-command:v1";
const MAX_TERMINALS_PER_CONVERSATION = 8;
const MAX_TOTAL_TERMINALS = 24;
const MAX_EXITED_TERMINALS = 32;
const EXITED_SESSION_TTL_MS = 5 * 60_000;
const MAX_SCROLLBACK_BYTES = 256 * 1024;
const MAX_LONG_POLL_MS = 8_000;
export const DEFAULT_TERMINAL_IDLE_TIMEOUT_MS = 2 * 60 * 60_000;
export const MIN_TERMINAL_IDLE_TIMEOUT_MS = 60_000;
export const MAX_TERMINAL_IDLE_TIMEOUT_MS = 24 * 60 * 60_000;

export function resolveTerminalIdleTimeoutMs(explicit?: number, env: NodeJS.ProcessEnv = process.env): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return Math.min(Math.trunc(explicit), MAX_TERMINAL_IDLE_TIMEOUT_MS);
  }
  const raw = env.TAROBOT_TERMINAL_IDLE_TIMEOUT_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(Math.max(Math.trunc(parsed), MIN_TERMINAL_IDLE_TIMEOUT_MS), MAX_TERMINAL_IDLE_TIMEOUT_MS);
    }
  }
  return DEFAULT_TERMINAL_IDLE_TIMEOUT_MS;
}

const PTY_BRIDGE_PY = `
import errno, fcntl, os, pty, select, signal, struct, sys, termios

cols = int(sys.argv[1])
rows = int(sys.argv[2])
cmd = sys.argv[3:]

def write_all(fd, data):
    view = memoryview(data)
    while view:
        try:
            written = os.write(fd, view)
            if written <= 0:
                return False
            view = view[written:]
        except InterruptedError:
            continue
        except OSError as exc:
            if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                select.select([], [fd], [], 0.05)
                continue
            return False
    return True

master, slave = pty.openpty()
try:
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
except OSError:
    pass

pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    try:
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    except OSError:
        pass
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    if slave > 2:
        os.close(slave)
    try:
        os.close(3)
    except OSError:
        pass
    os.execvp(cmd[0], cmd)
    os._exit(127)

os.close(slave)

def forward_term(signum, frame):
    try:
        os.killpg(pid, signal.SIGTERM)
    except OSError:
        pass

signal.signal(signal.SIGTERM, forward_term)
signal.signal(signal.SIGHUP, forward_term)

ctrl_fd = 3
try:
    os.fstat(ctrl_fd)
except OSError:
    ctrl_fd = None

stdin_open = True
ctrl_buf = b""

def exit_from_status(status):
    if os.WIFEXITED(status):
        sys.exit(os.WEXITSTATUS(status))
    if os.WIFSIGNALED(status):
        sys.exit(128 + os.WTERMSIG(status))
    sys.exit(0)

while True:
    rfds = [master]
    if stdin_open:
        rfds.append(0)
    if ctrl_fd is not None:
        rfds.append(ctrl_fd)
    try:
        readable, _, _ = select.select(rfds, [], [], 0.2)
    except InterruptedError:
        continue
    if master in readable:
        try:
            data = os.read(master, 4096)
        except OSError:
            data = b""
        if not data:
            break
        if not write_all(1, data):
            break
    if stdin_open and 0 in readable:
        try:
            data = os.read(0, 4096)
        except OSError:
            data = b""
        if not data:
            stdin_open = False
        else:
            if not write_all(master, data):
                break
    if ctrl_fd is not None and ctrl_fd in readable:
        try:
            chunk = os.read(ctrl_fd, 1024)
        except OSError:
            chunk = b""
        if not chunk:
            ctrl_fd = None
        else:
            ctrl_buf += chunk
            while b"\\n" in ctrl_buf:
                line, ctrl_buf = ctrl_buf.split(b"\\n", 1)
                parts = line.decode("ascii", "ignore").strip().split()
                if len(parts) == 3 and parts[0] == "resize":
                    try:
                        c = max(10, min(400, int(parts[1])))
                        r = max(4, min(200, int(parts[2])))
                        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
                        os.killpg(pid, signal.SIGWINCH)
                    except (OSError, ValueError):
                        pass
    wpid, status = os.waitpid(pid, os.WNOHANG)
    if wpid == pid:
        while True:
            r2, _, _ = select.select([master], [], [], 0.05)
            if not r2:
                break
            try:
                data = os.read(master, 4096)
            except OSError:
                break
            if not data:
                break
            write_all(1, data)
        exit_from_status(status)

_, status = os.waitpid(pid, 0)
exit_from_status(status)
`;

export interface TerminalProcessHandle {
  pid?: number;
  shell: string;
  backend: "node-pty" | "pty-script" | "pipe";
  write(data: string): void;
  resize?(cols: number, rows: number): void;
  kill(): Promise<void>;
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
}

export interface HostTerminalOptions {
  store: HubStore;
  auth: HubAuth;
  stateDir: string;
  defaultWorkspace?: string;
  resolveBotStateDir?: (botId: string) => Promise<string | undefined>;
  spawnProcess?: (options: { cwd: string; cols: number; rows: number }) => Promise<TerminalProcessHandle>;
  idleTimeoutMs?: number;
  now?: () => number;
}

interface LiveTerminal {
  id: string;
  conversationId: string;
  ownerDeviceId: string;
  ownerPublicKey: string;
  userId: string;
  title: string;
  cwd: string;
  shell: string;
  backend: "node-pty" | "pty-script" | "pipe";
  cols: number;
  rows: number;
  running: boolean;
  exitCode: number | null;
  exitedAt: number | null;
  createdAt: number;
  lastActivityAt: number;
  seq: number;
  chunks: Array<{ seq: number; data: string; bytes: number }>;
  totalBytes: number;
  waiters: Set<() => void>;
  handle: TerminalProcessHandle;
  closedAudited: boolean;
}

function defaultShell(platform: NodeJS.Platform): { command: string; args: string[]; label: string } {
  if (platform === "win32") {
    const comspec = process.env.ComSpec || "powershell.exe";
    if (/powershell|pwsh/i.test(comspec)) return { command: comspec, args: ["-NoLogo"], label: "powershell" };
    return { command: comspec, args: [], label: path.basename(comspec) };
  }
  const shell = process.env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  return { command: shell, args: ["-i"], label: path.basename(shell) };
}

function createBufferedProcessEmitter() {
  const dataListeners = new Set<(chunk: string) => void>();
  const exitListeners = new Set<(code: number | null) => void>();
  const earlyChunks: string[] = [];
  let earlyBytes = 0;
  let exited = false;
  let exitCode: number | null = null;

  return {
    emitData(text: string): void {
      if (!text) return;
      if (dataListeners.size === 0) {
        const bytes = Buffer.byteLength(text, "utf8");
        earlyChunks.push(text);
        earlyBytes += bytes;
        while (earlyBytes > MAX_SCROLLBACK_BYTES && earlyChunks.length > 1) {
          earlyBytes -= Buffer.byteLength(earlyChunks.shift()!, "utf8");
        }
        return;
      }
      for (const cb of dataListeners) cb(text);
    },
    emitExit(code: number | null): void {
      if (exited) return;
      exited = true;
      exitCode = code;
      for (const cb of exitListeners) cb(code);
    },
    onData(cb: (chunk: string) => void): void {
      dataListeners.add(cb);
      if (earlyChunks.length > 0) {
        const buffered = earlyChunks.splice(0);
        earlyBytes = 0;
        for (const chunk of buffered) cb(chunk);
      }
    },
    onExit(cb: (code: number | null) => void): void {
      exitListeners.add(cb);
      if (exited) cb(exitCode);
    },
  };
}

let cachedPython3Path: string | null | undefined;

async function resolveRealPython3(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  if (cachedPython3Path !== undefined) return cachedPython3Path ?? undefined;
  const search = env.PATH ?? "";
  for (const dir of search.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    try {
      let candidate = await realpath(path.join(dir, "python3"));
      if (process.platform === "darwin" && candidate === "/usr/bin/python3") {
        // Avoid invoking Apple's xcrun stub directly (which can trigger a GUI
        // Command Line Tools install dialog when CLT is not installed).
        const devDir = await new Promise<string>((resolve, reject) => {
          execFile("/usr/bin/xcode-select", ["-p"], { timeout: 1000, maxBuffer: 4096, encoding: "utf8" }, (err, out) =>
            err ? reject(err) : resolve(out.trim()),
          );
        });
        if (!devDir || !path.isAbsolute(devDir)) continue;
        candidate = await realpath(path.join(devDir, "usr", "bin", "python3"));
        if (candidate === "/usr/bin/python3") continue;
      }
      const info = await lstat(candidate);
      if (!info.isFile()) continue;
      await access(candidate, fsConstants.X_OK);
      cachedPython3Path = candidate;
      return candidate;
    } catch { /* try next PATH entry */ }
  }
  cachedPython3Path = null;
  return undefined;
}

function signalDirectDescendants(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid || process.platform === "win32") return;
  execFile("pgrep", ["-P", String(pid)], { timeout: 1000, maxBuffer: 16384, encoding: "utf8" }, (_err, stdout) => {
    for (const token of String(stdout ?? "").trim().split(/\s+/)) {
      const childPid = Number(token);
      if (Number.isInteger(childPid) && childPid > 0) {
        try { process.kill(childPid, signal); } catch { /* already gone */ }
      }
    }
  });
}

async function trySpawnNodePty(cwd: string, cols: number, rows: number): Promise<TerminalProcessHandle | undefined> {
  try {
    const specifier = "node-pty";
    const mod = await import(/* @vite-ignore */ specifier) as {
      spawn?: (file: string, args: string[], opts: Record<string, unknown>) => {
        pid: number;
        write(data: string): void;
        resize(cols: number, rows: number): void;
        kill(): void;
        onData(cb: (data: string) => void): void;
        onExit(cb: (ev: { exitCode: number }) => void): void;
      };
    };
    if (typeof mod.spawn !== "function") return undefined;
    const { command, args, label } = defaultShell(process.platform);
    const pty = mod.spawn(command, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    const emitter = createBufferedProcessEmitter();
    pty.onData((chunk) => emitter.emitData(chunk));
    pty.onExit(({ exitCode }) => emitter.emitExit(exitCode));
    return {
      pid: pty.pid,
      shell: label,
      backend: "node-pty",
      write: (data) => pty.write(data),
      resize: (c, r) => pty.resize(c, r),
      kill: async () => {
        if (pty.pid) {
          await killProcessTree(pty.pid).catch(() => undefined);
        }
        try { pty.kill(); } catch { /* already gone */ }
      },
      onData: (cb) => emitter.onData(cb),
      onExit: (cb) => emitter.onExit(cb),
    };
  } catch {
    return undefined;
  }
}

export async function trySpawnPtyScript(cwd: string, cols: number, rows: number): Promise<TerminalProcessHandle | undefined> {
  if (process.platform === "win32") return undefined;
  const python3 = await resolveRealPython3();
  if (!python3) return undefined;
  const { command, args, label } = defaultShell(process.platform);
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    COLUMNS: String(cols),
    LINES: String(rows),
  };
  const child: ChildProcess = spawn(python3, ["-u", "-c", PTY_BRIDGE_PY, String(cols), String(rows), command, ...args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const ctrl = child.stdio[3] as Writable | null | undefined;
  const emitter = createBufferedProcessEmitter();
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  child.stdout?.on("data", (buf: Buffer) => emitter.emitData(stdoutDecoder.write(buf)));
  child.stderr?.on("data", (buf: Buffer) => emitter.emitData(stderrDecoder.write(buf)));
  const flushAndExit = (code: number | null) => {
    const outTail = stdoutDecoder.end();
    if (outTail) emitter.emitData(outTail);
    const errTail = stderrDecoder.end();
    if (errTail) emitter.emitData(errTail);
    emitter.emitExit(code);
  };
  child.once("close", (code) => flushAndExit(code));
  child.once("error", () => flushAndExit(1));

  return {
    pid: child.pid,
    shell: label,
    backend: "pty-script",
    write: (data) => {
      if (!child.killed && child.stdin?.writable) child.stdin.write(data);
    },
    resize: (c, r) => {
      if (!child.killed && ctrl?.writable) {
        try { ctrl.write(`resize ${c} ${r}\n`); } catch { /* ignore */ }
      }
    },
    kill: async () => {
      try { ctrl?.end(); } catch { /* ignore */ }
      if (child.pid) {
        await killProcessTree(child.pid).catch(() => undefined);
      } else {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }
    },
    onData: (cb) => emitter.onData(cb),
    onExit: (cb) => emitter.onExit(cb),
  };
}

export async function spawnPipeShell(cwd: string, cols: number, rows: number): Promise<TerminalProcessHandle> {
  const { command, label } = defaultShell(process.platform);
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    COLUMNS: String(cols),
    LINES: String(rows),
  };
  const isWin = process.platform === "win32";
  const spawnArgs = isWin
    ? (/powershell|pwsh/i.test(command) ? ["-NoLogo", "-NoExit", "-Command", "-"] : [])
    : [];
  const child: ChildProcess = spawn(command, spawnArgs, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    ...(isWin ? { windowsHide: true } : {}),
  });

  const emitter = createBufferedProcessEmitter();
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  child.stdout?.on("data", (buf: Buffer) => emitter.emitData(stdoutDecoder.write(buf)));
  child.stderr?.on("data", (buf: Buffer) => emitter.emitData(stderrDecoder.write(buf)));
  const flushAndExit = (code: number | null) => {
    const outTail = stdoutDecoder.end();
    if (outTail) emitter.emitData(outTail);
    const errTail = stderrDecoder.end();
    if (errTail) emitter.emitData(errTail);
    emitter.emitExit(code);
  };
  child.once("close", (code) => flushAndExit(code));
  child.once("error", () => flushAndExit(1));

  return {
    pid: child.pid,
    shell: label,
    backend: "pipe",
    write: (data) => {
      if (child.killed || !child.stdin?.writable) return;
      let payload = data;
      if (!isWin && payload.includes("\x03")) {
        signalDirectDescendants(child.pid, "SIGINT");
        payload = payload.replaceAll("\x03", "");
      }
      const eofIndex = payload.indexOf("\x04");
      const shouldEnd = eofIndex >= 0;
      if (shouldEnd) payload = payload.slice(0, eofIndex);
      if (payload) {
        const normalized = isWin
          ? payload.replace(/\r\n|\r|\n/g, "\r\n")
          : payload.replace(/\r\n|\r/g, "\n");
        child.stdin.write(normalized);
      }
      if (shouldEnd) child.stdin.end();
    },
    kill: async () => {
      if (child.pid) {
        await killProcessTree(child.pid).catch(() => undefined);
      } else {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }
    },
    onData: (cb) => emitter.onData(cb),
    onExit: (cb) => emitter.onExit(cb),
  };
}

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function abortReasonError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new HubError("request_aborted", 499);
}

export class HubHostTerminal {
  private readonly sessions = new Map<string, LiveTerminal>();
  private readonly reservedByConversation = new Map<string, number>();
  private totalReserved = 0;
  private readonly pendingSpawns = new Set<Promise<void>>();
  private readonly pendingWork = new Set<Promise<void>>();
  private policy?: TerminalPolicy;
  private policyLoading?: Promise<TerminalPolicy>;
  private serialCount = 0;
  private disposed = false;
  readonly idleTimeoutMs: number;

  constructor(private readonly options: HostTerminalOptions) {
    this.idleTimeoutMs = resolveTerminalIdleTimeoutMs(options.idleTimeoutMs);
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private trackPending(work: Promise<unknown>): void {
    const wrapped = work.then(() => undefined, () => undefined);
    this.pendingWork.add(wrapped);
    void wrapped.finally(() => this.pendingWork.delete(wrapped));
  }

  private wakeSessionWaiters(term: LiveTerminal): void {
    for (const resolve of term.waiters) resolve();
    term.waiters.clear();
  }

  private wakeAllWaiters(): void {
    for (const term of this.sessions.values()) this.wakeSessionWaiters(term);
  }

  private pruneExitedSessions(): void {
    const cutoff = this.now() - EXITED_SESSION_TTL_MS;
    const exited: LiveTerminal[] = [];
    for (const term of this.sessions.values()) {
      if (!term.running) {
        if (term.exitedAt !== null && term.exitedAt <= cutoff) {
          this.sessions.delete(term.id);
          this.wakeSessionWaiters(term);
        } else {
          exited.push(term);
        }
      }
    }
    if (exited.length > MAX_EXITED_TERMINALS) {
      exited.sort((a, b) => (a.exitedAt ?? a.lastActivityAt) - (b.exitedAt ?? b.lastActivityAt));
      for (const stale of exited.slice(0, exited.length - MAX_EXITED_TERMINALS)) {
        this.sessions.delete(stale.id);
        this.wakeSessionWaiters(stale);
      }
    }
  }

  private async readPolicy(): Promise<TerminalPolicy> {
    if (this.policy) return this.policy;
    this.policyLoading ??= this.options.store.db.serial(async () => {
      const row = await this.options.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [TERMINAL_POLICY_KEY]);
      try {
        const parsed = row ? terminalPolicySchema.parse(JSON.parse(row.value)) : { revision: 0, enabled: false, grants: [] };
        if (!this.policy || parsed.revision > this.policy.revision) this.policy = parsed;
        return this.policy;
      } catch {
        throw new HubError("terminal_policy_invalid", 503);
      }
    }).finally(() => { this.policyLoading = undefined; });
    return this.policyLoading;
  }

  private async principal(session: AuthSession): Promise<{ device: { id: string; name: string; platform: string; public_key: string; user_id: string }; canManage: boolean }> {
    return this.options.store.db.serial(async () => {
      const device = await this.options.auth.validateSessionInTransaction(session);
      const canManage = (await this.options.auth.localDesktopControllersInTransaction()).has(device.id);
      return { device, canManage };
    });
  }

  private isGranted(policy: TerminalPolicy, device: { id: string; public_key: string }): boolean {
    return policy.enabled && policy.grants.some((g) => g.deviceId === device.id && g.publicKey === device.public_key);
  }

  private async requireAuthorized(session: AuthSession): Promise<{ device: { id: string; name: string; platform: string; public_key: string; user_id: string }; policy: TerminalPolicy }> {
    const [{ device }, policy] = await Promise.all([this.principal(session), this.readPolicy()]);
    if (!this.isGranted(policy, device)) throw new HubError("terminal_not_authorized", 403);
    return { device, policy };
  }

  private toInfo(term: LiveTerminal): TerminalSessionInfo {
    return {
      id: term.id,
      conversationId: term.conversationId,
      title: term.title,
      cwd: term.cwd,
      shell: term.shell,
      backend: term.backend,
      running: term.running,
      exitCode: term.exitCode,
      createdAt: term.createdAt,
      lastActivityAt: term.lastActivityAt,
      cols: term.cols,
      rows: term.rows,
    };
  }

  async status(session: AuthSession): Promise<TerminalStatus> {
    this.pruneExitedSessions();
    const [{ device, canManage }, policy] = await Promise.all([this.principal(session), this.readPolicy()]);
    const allowed = this.isGranted(policy, device);
    let devices: TerminalStatus["devices"];
    if (canManage) {
      const rows = await this.options.store.db.serial(() =>
        this.options.store.db.all<{ id: string; name: string; platform: string; public_key: string }>(
          "SELECT id, name, platform, public_key FROM devices WHERE revoked=0 ORDER BY created_at ASC LIMIT 256",
        ),
      );
      devices = rows.map((r) => ({ id: r.id, name: r.name, platform: r.platform, publicKey: r.public_key }));
    }
    const visibleSessions = allowed
      ? [...this.sessions.values()].filter((t) => t.userId === session.userId).map((t) => this.toInfo(t))
      : [];
    return terminalStatusSchema.parse({
      supported: true,
      enabled: policy.enabled,
      allowed,
      canManage,
      ...(canManage ? { policy: structuredClone(policy), devices } : {}),
      sessions: visibleSessions,
    });
  }

  async configure(session: AuthSession, rawCommand: unknown, proof: DeviceActionProof | undefined): Promise<TerminalPolicy> {
    const command: TerminalConfigure = terminalConfigureSchema.parse(rawCommand);
    const digest = hashSecret(terminalConfigureText(command));
    await this.readPolicy();

    const { policy: next, replayed } = await this.options.store.db.transaction(async () => {
      await this.options.auth.validateSessionInTransaction(session);
      await this.options.store.requireOwner(session.userId);
      if (!(await this.options.auth.localDesktopControllersInTransaction()).has(session.deviceId)) {
        throw new HubError("local_controller_required", 403);
      }
      const stored = await this.options.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [TERMINAL_POLICY_KEY]);
      const current = stored ? terminalPolicySchema.parse(JSON.parse(stored.value)) : { revision: 0, enabled: false, grants: [] };
      const previous = await this.options.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [TERMINAL_LAST_COMMAND_KEY]);
      const receipt = previous ? JSON.parse(previous.value) as { deviceId?: string; requestId?: string; digest?: string } : undefined;
      if (receipt?.deviceId === session.deviceId && receipt?.requestId === command.requestId) {
        if (receipt.digest !== digest) throw new HubError("terminal_request_conflict", 409);
        return { policy: current, replayed: true };
      }

      await this.options.auth.consumeTerminalGrant(session, digest, proof);
      if (command.expectedRevision !== current.revision) throw new HubError("terminal_policy_changed", 409);

      const grants: TerminalPolicy["grants"] = [];
      for (const grant of command.grants) {
        const device = await this.options.store.db.get<{ public_key: string; revoked: number }>(
          "SELECT public_key, revoked FROM devices WHERE id=?",
          [grant.deviceId],
        );
        if (!device || device.revoked || device.public_key !== grant.publicKey) {
          // Retire an unchanged stale grant so unpairing cannot lock out disabling;
          // reject any newly added or key-mismatched grant.
          if (current.grants.some((saved) => saved.deviceId === grant.deviceId && saved.publicKey === grant.publicKey)) {
            continue;
          }
          throw new HubError("terminal_device_changed", 409);
        }
        grants.push(grant);
      }
      const updated = terminalPolicySchema.parse({
        revision: current.revision + 1,
        enabled: command.enabled,
        grants,
      });
      await this.options.store.db.run("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", [TERMINAL_POLICY_KEY, JSON.stringify(updated)]);
      await this.options.store.db.run(
        "INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)",
        [TERMINAL_LAST_COMMAND_KEY, JSON.stringify({ deviceId: session.deviceId, requestId: command.requestId, digest })],
      );
      return { policy: updated, replayed: false };
    });

    if (!this.policy || next.revision > this.policy.revision) this.policy = next;
    const effective = this.policy;

    // Wake all in-flight long-polls immediately (including non-owner readers whose
    // grant may have just been revoked) before awaiting audit/process teardown.
    this.wakeAllWaiters();

    if (!replayed) {
      await this.options.store.audit("terminal.policy", session.deviceId, {
        revision: next.revision,
        enabled: next.enabled,
        grants: next.grants.length,
      });
    }

    const revokedTerms = [...this.sessions.values()].filter(
      (term) => !effective.enabled || !effective.grants.some((g) => g.deviceId === term.ownerDeviceId && g.publicKey === term.ownerPublicKey),
    );
    if (revokedTerms.length > 0) {
      await this.terminateSessions(revokedTerms, session.deviceId, "permission_revoked");
    }
    return structuredClone(next);
  }

  private async isSafeWorkspaceDir(candidate: string | undefined): Promise<string | undefined> {
    if (!candidate || !path.isAbsolute(candidate)) return undefined;
    const isDir = await stat(candidate).then((s) => s.isDirectory(), () => false);
    if (!isDir) return undefined;
    const [resolvedCandidate, resolvedStateDir] = await Promise.all([
      realpath(candidate).catch(() => path.resolve(candidate)),
      realpath(this.options.stateDir).catch(() => path.resolve(this.options.stateDir)),
    ]);
    if (resolvedCandidate === resolvedStateDir) return undefined;
    return candidate;
  }

  private async resolveBotWorkspace(botId: string): Promise<string | undefined> {
    const botDir = this.options.resolveBotStateDir
      ? await this.options.resolveBotStateDir(botId)
      : path.join(this.options.stateDir, "bots", botId);
    if (!botDir || !path.isAbsolute(botDir)) return undefined;
    try {
      const config = await loadInstanceConfig(botDir);
      const configured = await this.isSafeWorkspaceDir(resolveInstanceWorkspacePath(config));
      if (configured) return configured;
    } catch { /* fall through to bot workspace dir */ }
    return this.isSafeWorkspaceDir(path.join(botDir, "workspace"));
  }

  private async resolveWorkspace(userId: string, conversationId: string): Promise<string> {
    const conversations = await this.options.store.conversations(userId);
    const conversation = conversations.find((c) => c.id === conversationId);
    if (!conversation) throw new HubError("conversation_forbidden", 403);
    const parent = conversation.parentId ? conversations.find((c) => c.id === conversation.parentId) : undefined;
    if (conversation.archived || parent?.archived) throw new HubError("conversation_archived", 409);

    if (conversation.ticket?.workspace) {
      const ticketWs = conversation.ticket.workspace;
      if (path.isAbsolute(ticketWs)) {
        const verified = await this.isSafeWorkspaceDir(ticketWs);
        if (verified) return verified;
      } else {
        const dispatcherWs = await this.resolveBotWorkspace(conversation.ticket.dispatcherBotId);
        if (dispatcherWs) {
          const joined = path.resolve(dispatcherWs, ticketWs);
          if (isWithin(dispatcherWs, joined)) {
            const verified = await this.isSafeWorkspaceDir(joined);
            if (verified) return verified;
          }
        }
      }
    }

    for (const botId of conversation.botIds) {
      const workspace = await this.resolveBotWorkspace(botId);
      if (workspace) return workspace;
    }

    const fallbackDefault = await this.isSafeWorkspaceDir(this.options.defaultWorkspace);
    if (fallbackDefault) return fallbackDefault;

    throw new HubError("terminal_workspace_unavailable", 409);
  }

  async list(session: AuthSession, conversationId: string): Promise<TerminalSessionInfo[]> {
    this.pruneExitedSessions();
    await this.requireAuthorized(session);
    const conversations = await this.options.store.conversations(session.userId);
    if (!conversations.some((c) => c.id === conversationId)) throw new HubError("conversation_forbidden", 403);
    return [...this.sessions.values()]
      .filter((t) => t.userId === session.userId && t.conversationId === conversationId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((t) => this.toInfo(t));
  }

  async create(session: AuthSession, raw: unknown): Promise<TerminalSessionInfo> {
    if (this.disposed) throw new HubError("hub_stopping", 503);
    const input: TerminalCreate = terminalCreateSchema.parse(raw);
    const { device } = await this.requireAuthorized(session);
    if (this.disposed) throw new HubError("hub_stopping", 503);
    this.pruneExitedSessions();

    const activeTotal = [...this.sessions.values()].filter((t) => t.running).length;
    if (activeTotal + this.totalReserved >= MAX_TOTAL_TERMINALS) throw new HubError("terminal_limit_reached", 429);
    const activeConv = [...this.sessions.values()].filter((t) => t.running && t.conversationId === input.conversationId).length;
    const reservedConv = this.reservedByConversation.get(input.conversationId) ?? 0;
    if (activeConv + reservedConv >= MAX_TERMINALS_PER_CONVERSATION) throw new HubError("terminal_limit_reached", 429);

    this.totalReserved += 1;
    this.reservedByConversation.set(input.conversationId, reservedConv + 1);

    let settleSpawn!: () => void;
    const spawnMarker = new Promise<void>((resolve) => { settleSpawn = resolve; });
    this.pendingSpawns.add(spawnMarker);

    try {
      const cwd = await this.resolveWorkspace(session.userId, input.conversationId);
      if (this.disposed) throw new HubError("hub_stopping", 503);
      await this.requireAuthorized(session);

      const handle = this.options.spawnProcess
        ? await this.options.spawnProcess({ cwd, cols: input.cols, rows: input.rows })
        : (await trySpawnNodePty(cwd, input.cols, input.rows))
          ?? (await trySpawnPtyScript(cwd, input.cols, input.rows))
          ?? (await spawnPipeShell(cwd, input.cols, input.rows));

      let registeredId: string | undefined;
      try {
        if (this.disposed) throw new HubError("hub_stopping", 503);
        const latest = await this.requireAuthorized(session);
        if (latest.device.public_key !== device.public_key) throw new HubError("device_revoked", 401);
        if (this.disposed) throw new HubError("hub_stopping", 503);

        const id = `term_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
        const now = this.now();
        const index = ++this.serialCount;
        const term: LiveTerminal = {
          id,
          conversationId: input.conversationId,
          ownerDeviceId: device.id,
          ownerPublicKey: device.public_key,
          userId: session.userId,
          title: input.title ?? `${handle.shell} #${index}`,
          cwd,
          shell: handle.shell,
          backend: handle.backend,
          cols: input.cols,
          rows: input.rows,
          running: true,
          exitCode: null,
          exitedAt: null,
          createdAt: now,
          lastActivityAt: now,
          seq: 0,
          chunks: [],
          totalBytes: 0,
          waiters: new Set(),
          handle,
          closedAudited: false,
        };

        handle.onData((chunk) => {
          if (!chunk) return;
          const bytes = Buffer.byteLength(chunk, "utf8");
          term.seq += 1;
          term.lastActivityAt = this.now();
          term.chunks.push({ seq: term.seq, data: chunk, bytes });
          term.totalBytes += bytes;
          while (term.totalBytes > MAX_SCROLLBACK_BYTES && term.chunks.length > 1) {
            const dropped = term.chunks.shift()!;
            term.totalBytes -= dropped.bytes;
          }
          this.wakeSessionWaiters(term);
        });

        handle.onExit((code) => {
          const exitedAt = this.now();
          term.running = false;
          term.exitCode = code ?? 0;
          term.exitedAt = exitedAt;
          term.lastActivityAt = exitedAt;
          this.wakeSessionWaiters(term);
          if (!term.closedAudited) {
            term.closedAudited = true;
            this.trackPending(
              this.options.store.audit("terminal.closed", term.ownerDeviceId, {
                terminalId: term.id,
                conversationId: term.conversationId,
                reason: "process_exited",
                exitCode: term.exitCode,
              }),
            );
          }
        });

        this.sessions.set(id, term);
        registeredId = id;
        await this.options.store.audit("terminal.opened", device.id, {
          terminalId: id,
          conversationId: input.conversationId,
          cwd,
          shell: handle.shell,
          backend: handle.backend,
        });
        return this.toInfo(term);
      } catch (error) {
        if (registeredId) {
          const added = this.sessions.get(registeredId);
          this.sessions.delete(registeredId);
          if (added) {
            added.running = false;
            added.closedAudited = true;
            this.wakeSessionWaiters(added);
          }
        }
        await handle.kill().catch(() => undefined);
        throw error;
      }
    } finally {
      this.totalReserved -= 1;
      const nextConv = (this.reservedByConversation.get(input.conversationId) ?? 1) - 1;
      if (nextConv <= 0) this.reservedByConversation.delete(input.conversationId);
      else this.reservedByConversation.set(input.conversationId, nextConv);
      this.pendingSpawns.delete(spawnMarker);
      settleSpawn();
    }
  }

  private async requireOwnedTerminal(session: AuthSession, id: string): Promise<LiveTerminal> {
    await this.requireAuthorized(session);
    const term = this.sessions.get(id);
    if (!term || term.userId !== session.userId) throw new HubError("terminal_not_found", 404);
    return term;
  }

  async readOutput(session: AuthSession, id: string, after: number, waitMs = 0, signal?: AbortSignal): Promise<TerminalOutput> {
    if (this.disposed) throw new HubError("hub_stopping", 503);
    if (signal?.aborted) throw abortReasonError(signal);
    const term = await this.requireOwnedTerminal(session, id);
    const boundedWait = Math.min(Math.max(0, waitMs), MAX_LONG_POLL_MS);
    if (term.seq <= after && term.running && boundedWait > 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          term.waiters.delete(done);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, boundedWait);
        timer.unref?.();
        term.waiters.add(done);
        if (signal) {
          if (signal.aborted) { done(); return; }
          signal.addEventListener("abort", done, { once: true });
        }
      });
    }
    if (signal?.aborted) throw abortReasonError(signal);
    if (this.disposed) throw new HubError("hub_stopping", 503);
    // Re-check device & terminal authorization after waiting so a device revoked
    // mid-poll never receives post-revocation output.
    await this.requireAuthorized(session);
    if (this.sessions.get(id) !== term) throw new HubError("terminal_not_found", 404);
    const chunks = term.chunks.filter((c) => c.seq > after).map(({ seq, data }) => ({ seq, data }));
    return terminalOutputSchema.parse({
      id: term.id,
      seq: term.seq,
      running: term.running,
      exitCode: term.exitCode,
      chunks,
    });
  }

  async writeInput(session: AuthSession, id: string, raw: unknown): Promise<{ ok: true }> {
    const term = await this.requireOwnedTerminal(session, id);
    const { data } = terminalInputSchema.parse(raw);
    if (!term.running) throw new HubError("terminal_closed", 409);
    term.lastActivityAt = this.now();
    term.handle.write(data);
    return { ok: true };
  }

  async resize(session: AuthSession, id: string, raw: unknown): Promise<{ ok: true }> {
    const term = await this.requireOwnedTerminal(session, id);
    const { cols, rows } = terminalResizeSchema.parse(raw);
    term.cols = cols;
    term.rows = rows;
    if (term.running) term.lastActivityAt = this.now();
    term.handle.resize?.(cols, rows);
    return { ok: true };
  }

  private terminateSessions(terms: LiveTerminal[], actor: string, reason: string): Promise<void> {
    if (terms.length === 0) return Promise.resolve();
    const prepared = terms.map((term) => {
      this.sessions.delete(term.id);
      const wasRunning = term.running;
      term.running = false;
      const shouldAudit = !term.closedAudited;
      term.closedAudited = true;
      this.wakeSessionWaiters(term);
      return { term, wasRunning, shouldAudit };
    });
    const work = Promise.allSettled(
      prepared.map(async ({ term, wasRunning, shouldAudit }) => {
        if (wasRunning) {
          await term.handle.kill().catch(() => undefined);
        }
        if (shouldAudit) {
          await this.options.store.audit("terminal.closed", actor, {
            terminalId: term.id,
            conversationId: term.conversationId,
            reason,
            ...(term.exitCode !== null ? { exitCode: term.exitCode } : {}),
          }).catch(() => undefined);
        }
      }),
    ).then(() => undefined);
    this.trackPending(work);
    return work;
  }

  async close(session: AuthSession, id: string): Promise<{ ok: true }> {
    const term = await this.requireOwnedTerminal(session, id);
    await this.terminateSessions([term], session.deviceId, "tab_closed");
    return { ok: true };
  }

  async revokeDevice(deviceId: string): Promise<void> {
    // Wake all waiters immediately so revoked non-owner readers exit promptly too.
    this.wakeAllWaiters();
    const owned = [...this.sessions.values()].filter((term) => term.ownerDeviceId === deviceId);
    if (owned.length > 0) {
      await this.terminateSessions(owned, "hub", "device_revoked");
    }
  }

  async sweep(): Promise<void> {
    if (this.disposed) return;
    this.pruneExitedSessions();
    if (this.sessions.size === 0) return;
    const policy = await this.readPolicy().catch(() => undefined);
    const ownerIds = [...new Set([...this.sessions.values()].map((term) => term.ownerDeviceId))];
    let devicesById: Map<string, Device | undefined>;
    try {
      devicesById = await this.options.store.db.serial(async () => {
        const map = new Map<string, Device | undefined>();
        for (const deviceId of ownerIds) {
          map.set(deviceId, await this.options.store.db.get<Device>("SELECT * FROM devices WHERE id=?", [deviceId]));
        }
        return map;
      });
    } catch {
      return;
    }
    if (this.disposed) return;
    const now = this.now();
    const byReason = new Map<string, LiveTerminal[]>();
    for (const term of [...this.sessions.values()]) {
      let reason: string | undefined;
      if (policy && !this.isGranted(policy, { id: term.ownerDeviceId, public_key: term.ownerPublicKey })) {
        reason = "permission_revoked";
      } else if (devicesById.has(term.ownerDeviceId)) {
        const device = devicesById.get(term.ownerDeviceId);
        if (!device || device.revoked || device.user_id !== term.userId || device.public_key !== term.ownerPublicKey) {
          reason = "device_revoked";
        } else if (term.running && now - term.lastActivityAt >= this.idleTimeoutMs) {
          reason = "idle_timeout";
        }
      }
      if (reason) {
        const list = byReason.get(reason) ?? [];
        list.push(term);
        byReason.set(reason, list);
      }
    }
    if (byReason.size > 0) {
      this.wakeAllWaiters();
      await Promise.allSettled(
        [...byReason.entries()].map(([reason, terms]) => this.terminateSessions(terms, "hub", reason)),
      );
    }
  }

  beginShutdown(): void {
    this.disposed = true;
    this.wakeAllWaiters();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.wakeAllWaiters();
    while (this.sessions.size > 0 || this.pendingSpawns.size > 0 || this.pendingWork.size > 0) {
      if (this.sessions.size > 0) {
        await this.terminateSessions([...this.sessions.values()], "hub", "hub_shutdown");
      }
      if (this.pendingSpawns.size > 0) {
        await Promise.allSettled([...this.pendingSpawns]);
      }
      if (this.pendingWork.size > 0) {
        await Promise.allSettled([...this.pendingWork]);
      }
    }
  }
}
