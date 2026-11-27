import { CodexAppServerAdapter, type AppServerSpawnCodex } from "./app-server-adapter.js";
import { AdapterQuotaCache, type AdapterQuotaScope, type EngineQuotaReadOptions, type EngineQuotaReadResult } from "./adapter-account-quota.js";

type OwnedRead = { abort: AbortController; closed: Promise<void> };
const owned = new WeakMap<AdapterQuotaCache, Set<OwnedRead>>();
export async function cancelOwnedQuotaReads(cache: AdapterQuotaCache): Promise<void> {
  const reads = [...(owned.get(cache) ?? [])];
  if (reads.length === 0) return;
  for (const read of reads) read.abort.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.all(reads.map(read => read.closed)), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("quota_process_close_timeout")), 2000); })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Dedicated, no-session helper only. Unlike a shared worker it may be terminated on timeout. */
export async function readOwnedCodexQuota(input: {
  executable: string; cwd: string; env: NodeJS.ProcessEnv; spawn: AppServerSpawnCodex;
  cache: AdapterQuotaCache; scope: AdapterQuotaScope; options: EngineQuotaReadOptions; captureScope: () => AdapterQuotaScope;
}): Promise<EngineQuotaReadResult> {
  if (owned.get(input.cache)?.size) return input.cache.failure(input.scope, "timeout");
  if (input.options.signal?.aborted) return input.cache.failure(input.scope, "cancelled");
  const timeoutMs = Math.max(1, Math.min(7000, input.options.timeoutMs ?? 7000));
  const abort = new AbortController();
  let timedOut = false, started = false, didClose = false, didStop = false;
  let closedResolve!: () => void;
  let stoppedResolve!: () => void;
  const childClosed = new Promise<void>(resolve => { closedResolve = resolve; });
  const treeStopped = new Promise<void>(resolve => { stoppedResolve = resolve; });
  const closed = Promise.all([childClosed, treeStopped]).then(() => undefined);
  const entry = { abort, closed };
  const reads = owned.get(input.cache) ?? new Set<OwnedRead>();
  owned.set(input.cache, reads); reads.add(entry);
  void closed.then(() => reads.delete(entry));
  const adapter = new CodexAppServerAdapter(input.executable, input.cwd, input.env, (command, args, options) => {
    if (abort.signal.aborted) throw new Error("quota_cancelled");
    const child = input.spawn(command, args, options);
    started = true;
    child.once("close", () => { didClose = true; closedResolve(); });
    return child;
  });
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= adapter.stopOwnedAccountQuotaProcess().then(() => { didStop = true; stoppedResolve(); });
  const cancel = () => { abort.abort(); void stop(); };
  const abortOwned = () => { void stop(); };
  abort.signal.addEventListener("abort", abortOwned, { once: true });
  input.options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
  const began = performance.now();
  let result: EngineQuotaReadResult;
  try {
    const native = await adapter.readAccountQuotaFromOwnedProcess({ signal: abort.signal, timeoutMs, proofKey: input.options.accountProofKey ?? input.cache.proofKey,
      captureScope: () => input.captureScope().revision,
      remainingMs: () => Math.max(1, timeoutMs - (performance.now() - began)),
    });
    const after = input.captureScope();
    result = abort.signal.aborted ? input.cache.failure(after, timedOut ? "timeout" : "cancelled")
      : after.revision !== input.scope.revision ? input.cache.failure(after, "auth_changed")
      : { revision: input.scope.revision, ...native };
  } catch {
    result = input.cache.failure(input.captureScope(), abort.signal.aborted ? timedOut ? "timeout" : "cancelled" : "native_error");
  } finally {
    clearTimeout(timer);
    input.options.signal?.removeEventListener("abort", cancel);
    abort.signal.removeEventListener("abort", abortOwned);
    void stop();
    if (!started) { didClose = true; closedResolve(); }
  }
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([closed, new Promise<void>(resolve => { closeTimer = setTimeout(resolve, 2000); })]);
  if (closeTimer) clearTimeout(closeTimer);
  if (!didClose || !didStop) return input.cache.failure(input.captureScope(), "native_error");
  // A read is not complete while its owned process is still alive.
  const after = input.captureScope();
  if (after.revision !== input.scope.revision) return input.cache.failure(after, "auth_changed");
  return input.cache.store(after, { snapshot: result.snapshot, ...(result.proof ? { proof: { ...result.proof, scopeStamp: after.revision } } : {}) }, input.options.accountProofKey);
}
