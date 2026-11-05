import { execFile } from "node:child_process";

type ExecFileFn = typeof execFile;
type KillFn = (pid: number, signal?: NodeJS.Signals | number) => void;
type ReadProcessIdentityFn = (pid: number, callback: (identity: string | null) => void) => void;

// A pathological fork storm must not turn one stop into unbounded `pgrep` work.
const MAX_TREE_PROCESSES = 4096;
// A wedged `pgrep`/`ps`/`taskkill` must not stall termination or its waiters.
const EXEC_TIMEOUT_MS = 3_000;
// Waiting on a kill is bounded even when the tools misbehave. At the bound the
// call expires: it sends nothing more and its timers and tools are cleaned up.
const WAIT_MARGIN_MS = 5_000;
/** In-flight kills of this process and how to expire each early. */
const pendingKills = new Map<Promise<void>, () => void>();
/** One termination. Once its wait bound expires it is dead: no further signal
 * is sent (the PIDs may have been reused), its timers and tools are cleaned up. */
type KillContext = { live: boolean; cleanups: Set<() => void> };

/** Calls back exactly once: with the tool's result, or an error after a bound. */
function boundedExec(context: KillContext, execFileFn: ExecFileFn, command: string, args: string[], callback: (error: Error | null, stdout: string) => void): void {
  let done = false, timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { try { child?.kill?.(); } catch { /* already gone */ } };
  const finish = (error: Error | null, stdout: string) => { if (done) return; done = true; if (timer) clearTimeout(timer); context.cleanups.delete(abandon); if (context.live) callback(error, stdout); };
  const abandon = () => { stop(); finish(new Error("process_tool_abandoned"), ""); };
  const child = execFileFn(command, args, (error, stdout) => finish(error, String(stdout ?? "")));
  if (!done) { context.cleanups.add(abandon); timer = setTimeout(() => { stop(); finish(new Error("process_tool_timeout"), ""); }, EXEC_TIMEOUT_MS); }
}

function readUnixProcessIdentity(context: KillContext, execFileFn: ExecFileFn, pid: number, callback: (identity: string | null) => void): void {
  boundedExec(context, execFileFn, "ps", ["-o", "lstart=", "-p", String(pid)], (error, stdout) => {
    if (error) {
      callback(null);
      return;
    }

    const identity = stdout.trim();
    callback(identity ? identity : null);
  });
}

/** Descendants deepest-first, all listed before any signal is sent. A root that
 * forwards SIGTERM and exits would otherwise re-parent grandchildren to init
 * before their own `pgrep -P` runs, and they would never be signalled. */
function listDescendants(context: KillContext, execFileFn: ExecFileFn, pid: number, seen: Set<number>): Promise<number[]> {
  return new Promise((resolve) => {
    boundedExec(context, execFileFn, "pgrep", ["-P", String(pid)], (_, stdout) => {
      const children: number[] = [];
      for (const value of stdout.trim().split(/\s+/)) {
        const child = Number(value);
        if (Number.isInteger(child) && child > 0 && !seen.has(child) && seen.size < MAX_TREE_PROCESSES) { seen.add(child); children.push(child); }
      }
      void Promise.all(children.map((child) => listDescendants(context, execFileFn, child, seen).then((nested) => [...nested, child])))
        .then((groups) => resolve(groups.flat()), () => resolve(children));
    });
  });
}

function terminateUnixTree(context: KillContext, pid: number, execFileFn: ExecFileFn, rawKill: KillFn, graceMs: number, readIdentityFn: ReadProcessIdentityFn): Promise<void> {
  // Every signal, including liveness probes, is refused once the context expired.
  const killFn: KillFn = (target, signal) => { if (!context.live) throw new Error("process_kill_expired"); rawKill(target, signal); };
  return listDescendants(context, execFileFn, pid, new Set([pid])).then((descendants) => {
    const targets = [...descendants, pid];
    // Start times are read before any signal, while each listed PID still
    // names the process found in the tree. Escalation compares them again, so
    // a PID reused after exit is not killed. A PID reused between listing and
    // signalling is a residual race this cannot exclude.
    return Promise.all(targets.map((target) => new Promise<{ pid: number; identity: string | null }>((done) => {
      readIdentityFn(target, (identity) => done({ pid: target, identity }));
    })));
  }).then((initial) => new Promise<void>((resolve) => {
    const signalled = initial.filter(({ pid: target }) => { try { killFn(target, "SIGTERM"); return true; } catch { return false; } });
    if (!signalled.length) { resolve(); return; }
    const alive = (target: number) => { try { killFn(target, 0); return true; } catch { return false; } };
    let poll: ReturnType<typeof setInterval> | undefined;
    const finish = () => { if (poll) clearInterval(poll); clearTimeout(grace); context.cleanups.delete(finish); resolve(); };
    context.cleanups.add(finish);
    // Resolve as soon as every signalled member is gone; otherwise escalate once.
    poll = setInterval(() => { if (!signalled.some(({ pid: target }) => alive(target))) finish(); }, Math.max(10, Math.min(100, graceMs)));
    const grace = setTimeout(() => {
      if (poll) clearInterval(poll);
      void Promise.all(signalled.map(({ pid: target, identity }) => new Promise<void>((done) => {
        if (!identity) { done(); return; }
        readIdentityFn(target, (currentIdentity) => {
          if (currentIdentity && currentIdentity === identity && alive(target)) {
            try { killFn(target, "SIGKILL"); } catch { /* already gone */ }
          }
          done();
        });
      }))).then(() => resolve(), () => resolve());
    }, graceMs);
  }), () => undefined);
}

/**
 * Terminate a process and its descendants: SIGTERM, a grace period, then an
 * start-time-checked SIGKILL (Windows: `taskkill /T`). The returned promise
 * resolves once the tree is gone or escalation was sent, and in any case
 * within `graceMs` + 5 s even if the process tools hang; it never rejects.
 * After it resolves no further signal is sent for this call.
 * Callers may still fire-and-forget; a worker must `settleProcessTreeKills()`
 * before exiting, since pending escalation dies with its process.
 */
export function killProcessTree(
  pid: number | undefined,
  input?: {
    execFileFn?: ExecFileFn;
    killFn?: KillFn;
    platform?: NodeJS.Platform;
    graceMs?: number;
    readIdentityFn?: ReadProcessIdentityFn;
  },
): Promise<void> {
  if (!pid) {
    return Promise.resolve();
  }

  const execFileFn = input?.execFileFn ?? execFile;
  const killFn = input?.killFn ?? ((targetPid: number, signal?: NodeJS.Signals | number) => process.kill(targetPid, signal));
  const platform = input?.platform ?? process.platform;
  const graceMs = input?.graceMs ?? 2_000;
  const context: KillContext = { live: true, cleanups: new Set() };
  const readIdentityFn = input?.readIdentityFn ?? ((targetPid: number, callback: (identity: string | null) => void) => {
    readUnixProcessIdentity(context, execFileFn, targetPid, callback);
  });

  const work = platform === "win32"
    ? new Promise<void>((resolve) => {
      // Keep the root alive until taskkill has enumerated its descendants.
      execFileFn("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true, timeout: EXEC_TIMEOUT_MS }, (error) => {
        if (error && context.live) { try { killFn(pid, "SIGKILL"); } catch { /* already gone */ } }
        resolve();
      });
    })
    : terminateUnixTree(context, pid, execFileFn, killFn, graceMs, readIdentityFn);
  let bound: ReturnType<typeof setTimeout> | undefined, release: () => void = () => undefined;
  const expire = () => { context.live = false; for (const cleanup of [...context.cleanups]) cleanup(); context.cleanups.clear(); release(); };
  const expired = new Promise<void>((resolve) => { release = resolve; });
  bound = setTimeout(expire, graceMs + WAIT_MARGIN_MS);
  // Completion, the bound or an early expiry (settleProcessTreeKills) all end
  // the call the same way: no later signal, nothing left running.
  const tracked = Promise.race([work.catch(() => undefined), expired]).then(() => { clearTimeout(bound); expire(); });
  pendingKills.set(tracked, expire);
  void tracked.then(() => { pendingKills.delete(tracked); });
  return tracked;
}

/** Bounded wait for every tree termination started by this process, including
 * ones started while waiting. A process about to exit (or release a lock its
 * successor needs) calls this so SIGTERM and SIGKILL escalation are delivered
 * rather than abandoned. Kills still pending at the deadline are expired: once
 * this returns, none of them sends another signal. */
export async function settleProcessTreeKills(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pendingKills.size) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...pendingKills.keys()]),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining); }),
    ]);
    if (timer) clearTimeout(timer);
  }
  for (const expire of [...pendingKills.values()]) expire();
}
