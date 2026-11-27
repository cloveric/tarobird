import { StringDecoder } from "node:string_decoder";
import { ENGINE_QUOTA_REFRESH_MS, type QuotaReason } from "../client-protocol/engine-quota.js";
import {
  isAntigravityQuotaSupportedVersion,
  parseAntigravityQuota,
  QuotaReadError,
  unavailableQuota,
} from "./account-quota.js";
import {
  AdapterQuotaCache,
  type AdapterQuotaScope,
  type EngineQuotaReadOptions,
  type EngineQuotaReadResult,
} from "./adapter-account-quota.js";
import { probeAntigravityLocalServerQuota, type AntigravityLocalProbeDeps } from "./antigravity-local-server.js";
import { killProcessTree } from "./process-tree.js";

export type AntigravityQuotaSpawnOptions = {
  stdio: ["pipe", "pipe", "pipe"];
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  windowsHide?: boolean;
};

export type AntigravityQuotaChildLike = {
  pid?: number;
  stdin?: {
    end(chunk?: string): void;
    on?(event: "error", listener: (error: Error) => void): void;
  };
  stdout?: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  kill?: (signal?: string) => void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null, signal?: NodeJS.Signals | null) => void): void;
};

export type AntigravityQuotaSpawn = (
  command: string,
  args: string[],
  options: AntigravityQuotaSpawnOptions,
) => AntigravityQuotaChildLike;

const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const LOGIN_REQUIRED_PATTERN = /Authentication required|Please visit the URL to log in/i;
const RATE_LIMITED_PATTERN = /429 Too Many Requests|\bRESOURCE_EXHAUSTED\b/i;

type OwnedRead = { abort: AbortController; closed: Promise<void> };
const owned = new WeakMap<AdapterQuotaCache, Set<OwnedRead>>();

export async function cancelOwnedAntigravityQuotaReads(cache: AdapterQuotaCache): Promise<void> {
  const reads = [...(owned.get(cache) ?? [])];
  if (reads.length === 0) return;
  for (const read of reads) read.abort.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(reads.map(read => read.closed)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("quota_process_close_timeout")), 2000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildQuotaInvocation(command: string, args: string[]): { command: string; args: string[]; shell?: boolean } {
  const trimmed = command.trim();
  const normalized = trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")
    ? trimmed.slice(1, -1)
    : trimmed;
  if (process.platform === "win32") return { command: normalized, args, shell: false };
  if (/\.(cmd|bat)$/i.test(normalized)) {
    return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", normalized, ...args] };
  }
  if (/\.ps1$/i.test(normalized)) {
    return { command: "pwsh", args: ["-NoProfile", "-File", normalized, ...args] };
  }
  return { command: normalized, args, shell: false };
}

function stopChild(child: AntigravityQuotaChildLike): Promise<void> {
  if (child.pid) return killProcessTree(child.pid, { graceMs: 300 });
  try { child.kill?.("SIGTERM"); } catch { /* already gone */ }
  return Promise.resolve();
}

type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  overflow: boolean;
  loginRequired: boolean;
  didClose: boolean;
  didStop: boolean;
  errorCode?: string;
};

async function runBoundedQuotaCommand(input: {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawn: AntigravityQuotaSpawn;
  signal: AbortSignal;
  detectInteractiveLogin?: boolean;
}): Promise<RunResult> {
  if (input.signal.aborted) {
    return { code: null, stdout: "", stderr: "", overflow: false, loginRequired: false, didClose: true, didStop: true };
  }
  const invocation = buildQuotaInvocation(input.executable, input.args);
  let child: AntigravityQuotaChildLike;
  try {
    child = input.spawn(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: invocation.shell,
      env: input.env,
      cwd: input.cwd,
      windowsHide: true,
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
    return { code: null, stdout: "", stderr: "", overflow: false, loginRequired: false, didClose: true, didStop: true, errorCode: code };
  }

  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflow = false;
  let loginRequired = false;
  let didClose = false;
  let didStop = true;
  let exitCode: number | null = null;
  let errorCode: string | undefined;
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  let stopping: Promise<void> | undefined;
  // Only the first call stops the child; a later one (more stderr, the abort) must not undo a finished stop.
  const terminate = () => {
    if (!stopping) { didStop = false; stopping = stopChild(child).then(() => { didStop = true; }); }
    return stopping;
  };

  const closed = new Promise<void>(resolve => {
    const finish = () => {
      if (didClose) return;
      didClose = true;
      resolve();
    };
    child.once("error", error => {
      errorCode = error && typeof error === "object" && "code" in error ? String(error.code) : "error";
      finish();
    });
    child.once("close", code => {
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      exitCode = code;
      finish();
    });
  });

  const onAbort = () => { void terminate(); };
  input.signal.addEventListener("abort", onAbort, { once: true });

  child.stdout?.on("data", chunk => {
    const text = typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk);
    const size = Buffer.byteLength(text, "utf8");
    if (stdoutBytes + size > MAX_STDOUT_BYTES) {
      overflow = true;
      void terminate();
      return;
    }
    stdoutBytes += size;
    stdout += text;
  });

  child.stderr?.on("data", chunk => {
    const text = typeof chunk === "string" ? chunk : stderrDecoder.write(chunk);
    const size = Buffer.byteLength(text, "utf8");
    if (stderrBytes + size <= MAX_STDERR_BYTES) {
      stderrBytes += size;
      stderr += text;
    }
    // Unauthenticated `agy -p /usage` prints an OAuth URL on stderr and blocks waiting for browser auth.
    // Kill immediately so the read never hangs or exposes the URL.
    if (input.detectInteractiveLogin && LOGIN_REQUIRED_PATTERN.test(stderr)) {
      loginRequired = true;
      void terminate();
    }
  });

  child.stdin?.on?.("error", () => undefined);
  try { child.stdin?.end(); } catch { /* ignore */ }

  // Waiting for the stop and the close after an abort shares one 2 s allowance (three separate ones added up to
  // 6 s), so a read ends within its limit plus 2 s and the Hub, which waits longer, gets this answer.
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let allowance: Promise<void> | undefined;
  const allow = () => allowance ??= new Promise<void>(resolve => { closeTimer = setTimeout(resolve, 2000); });
  let onSignal: (() => void) | undefined;
  try {
    if (input.signal.aborted) void terminate();
    await Promise.race([closed, input.signal.aborted ? allow() : new Promise<void>(resolve => {
      onSignal = () => { void allow().then(resolve); };
      input.signal.addEventListener("abort", onSignal, { once: true });
    })]);
    if (stopping) await Promise.race([stopping, allow()]);
    if (!didClose) await Promise.race([closed, allow()]);
  } finally {
    if (closeTimer) clearTimeout(closeTimer);
    if (onSignal) input.signal.removeEventListener("abort", onSignal);
    input.signal.removeEventListener("abort", onAbort);
  }

  return { code: exitCode, stdout, stderr, overflow, loginRequired, didClose, didStop, errorCode };
}

/** Dedicated reader: queries a running `agy acp` / local Antigravity language server
 * over loopback first (no new `agy` process), falling back to `agy --version` (>= 1.1.11)
 * + `agy -p /usage --output-format json` when no local server answers. */
export async function readOwnedAntigravityQuota(input: {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawn: AntigravityQuotaSpawn;
  cache: AdapterQuotaCache;
  scope: AdapterQuotaScope;
  options: EngineQuotaReadOptions;
  captureScope: () => AdapterQuotaScope;
  preferredPids?: readonly number[];
  localProbe?: boolean | Partial<AntigravityLocalProbeDeps>;
  now?: () => number;
}): Promise<EngineQuotaReadResult> {
  if (owned.get(input.cache)?.size) return input.cache.failure(input.scope, "timeout");
  if (input.options.signal?.aborted) return input.cache.failure(input.scope, "cancelled");
  const now = input.now ?? Date.now;
  const timeoutMs = Math.max(1, Math.min(ENGINE_QUOTA_REFRESH_MS, input.options.timeoutMs ?? ENGINE_QUOTA_REFRESH_MS));
  const abort = new AbortController();
  let timedOut = false;
  let closedResolve!: () => void;
  const closed = new Promise<void>(resolve => { closedResolve = resolve; });
  const entry: OwnedRead = { abort, closed };
  const reads = owned.get(input.cache) ?? new Set<OwnedRead>();
  owned.set(input.cache, reads);
  reads.add(entry);
  void closed.then(() => reads.delete(entry));

  const cancel = () => abort.abort();
  input.options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, timeoutMs);

  const fail = (reason: QuotaReason): EngineQuotaReadResult => {
    const after = input.captureScope();
    if (after.revision !== input.scope.revision) return input.cache.failure(after, "auth_changed");
    return input.cache.store(after, { snapshot: unavailableQuota("antigravity", reason, now(), after.authMode) });
  };

  try {
    if (input.localProbe && input.preferredPids?.length) {
      const localDeps = typeof input.localProbe === "object" ? input.localProbe : undefined;
      const localSnapshot = await probeAntigravityLocalServerQuota({
        preferredPids: input.preferredPids,
        signal: abort.signal,
        now,
        deps: localDeps,
      });
      if (abort.signal.aborted) return fail(timedOut ? "timeout" : "cancelled");
      const afterLocal = input.captureScope();
      if (afterLocal.revision !== input.scope.revision) return input.cache.failure(afterLocal, "auth_changed");
      if (localSnapshot) {
        return input.cache.store(afterLocal, { snapshot: localSnapshot });
      }
    }

    const versionRun = await runBoundedQuotaCommand({
      executable: input.executable,
      args: ["--version"],
      cwd: input.cwd,
      env: input.env,
      spawn: input.spawn,
      signal: abort.signal,
    });
    if (abort.signal.aborted) return fail(timedOut ? "timeout" : "cancelled");
    if (!versionRun.didClose || !versionRun.didStop) return fail("native_error");
    if (versionRun.errorCode === "ENOENT") return fail("cli_unavailable");
    if (versionRun.errorCode || versionRun.overflow || versionRun.code !== 0 || !isAntigravityQuotaSupportedVersion(versionRun.stdout)) {
      return fail("native_unverified");
    }
    if (input.captureScope().revision !== input.scope.revision) {
      return input.cache.failure(input.captureScope(), "auth_changed");
    }

    const usageRun = await runBoundedQuotaCommand({
      executable: input.executable,
      args: ["-p", "/usage", "--output-format", "json"],
      cwd: input.cwd,
      env: input.env,
      spawn: input.spawn,
      signal: abort.signal,
      detectInteractiveLogin: true,
    });
    if (usageRun.loginRequired) {
      if (!usageRun.didClose || !usageRun.didStop) return fail("native_error");
      return fail("login_required");
    }
    if (abort.signal.aborted) return fail(timedOut ? "timeout" : "cancelled");
    if (!usageRun.didClose || !usageRun.didStop) return fail("native_error");
    if (usageRun.errorCode === "ENOENT") return fail("cli_unavailable");
    if (usageRun.overflow) return fail("invalid_response");
    if (usageRun.code !== 0) {
      if (LOGIN_REQUIRED_PATTERN.test(usageRun.stderr)) return fail("login_required");
      if (RATE_LIMITED_PATTERN.test(usageRun.stderr)) return fail("rate_limited");
      return fail("native_error");
    }

    const after = input.captureScope();
    if (after.revision !== input.scope.revision) return input.cache.failure(after, "auth_changed");

    let parsed: unknown;
    try {
      parsed = JSON.parse(usageRun.stdout);
    } catch {
      return fail("invalid_response");
    }
    try {
      const snapshot = parseAntigravityQuota(parsed, now());
      return input.cache.store(after, { snapshot });
    } catch (error) {
      const reason = error instanceof QuotaReadError ? error.reason : "invalid_response";
      return fail(reason);
    }
  } finally {
    clearTimeout(timer);
    input.options.signal?.removeEventListener("abort", cancel);
    closedResolve();
  }
}
