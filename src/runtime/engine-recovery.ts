import { EngineCancellationUnconfirmedError, EngineStopTooLateError, type EngineStreamEvent } from "../codex/adapter.js";
import { EngineRetryableError, type EngineRetryReason, type EngineRetryReceipt } from "../codex/turn-retry.js";

export const ENGINE_RECOVERY_WINDOW_MS = 10 * 60_000;
const BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000];

export class EngineRecoveryExhaustedError extends Error {
  constructor(readonly attempts: number, cause: EngineRetryableError) {
    super(`Automatic engine recovery exhausted after ${attempts} retries: ${cause.message}`, { cause });
    this.name = "EngineRecoveryExhaustedError";
  }
}

export class EngineRecoveryBudgetError extends Error {
  constructor(message: string) { super(message); this.name = "EngineRecoveryBudgetError"; }
}

export class EngineRecoveryTimeoutError extends Error {
  constructor(limitMs: number) {
    super(`Engine turn timed out after ${Math.max(1, Math.round(limitMs / 60_000))} minutes during automatic recovery`);
    this.name = "EngineRecoveryTimeoutError";
  }
}

export class EngineRecoveryUnconfirmedError extends Error {
  readonly retryReason?: EngineRetryReason;

  constructor(cause: unknown, readonly reason: "receipt" | "unfinished-work" = "receipt") {
    // Preserve only the adapter's known category. Provider diagnostics and
    // native session IDs must not leak into the public message or timeline.
    const candidate = cause instanceof EngineRetryableError ? cause.retry.reason : undefined;
    const retryReason = candidate === "capacity" || candidate === "connection" || candidate === "rate-limit" ? candidate : undefined;
    const detail = reason === "unfinished-work"
      ? "Engine recovery stopped because tool or background work has not reported completion"
      : "Engine recovery receipt conflicts with observed session or execution state";
    super(`${detail}${retryReason ? ` (provider failure: ${retryReason})` : ""}`, { cause });
    this.name = "EngineRecoveryUnconfirmedError";
    this.retryReason = retryReason;
  }
}

export const ENGINE_RECOVERY_CONTINUATION = "The previous model request ended with a transient service or connection error. " +
  "Continue the user's unfinished task in this same session using the existing conversation and completed work. " +
  "First reconcile any outstanding tool or background results. Do not repeat completed edits, commands, approvals, messages, " +
  "or delivered files. Do not restart the project or create a replacement session. Preserve the user's latest instructions and constraints.";

type RetryEvent = Extract<EngineStreamEvent, { type: "engine_retry" }>;

function waitForRecovery(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new DOMException("Stopped", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** The caller retains conversation/session ownership, but acquires worker capacity
 * separately for each attempt. Only an adapter's confirmed native receipt can
 * enter this loop; transport uncertainty alone never causes a replay. */
export async function recoverEngineTurn<T>(
  execute: (receipt: EngineRetryReceipt | undefined, progress: () => Promise<void>, signal?: AbortSignal) => Promise<T>,
  options: {
    signal?: AbortSignal;
    onEvent?: (event: RetryEvent) => void | Promise<void>;
    onFailure?: (receipt: EngineRetryReceipt, error: EngineRetryableError, signal?: AbortSignal) => Promise<void>;
    runtimeBudget?: () => { limitMs: number; remainingMs: number };
  } = {},
): Promise<T> {
  let receipt: EngineRetryReceipt | undefined;
  let retries = 0, consecutiveFailures = 0;
  let outageStartedAt: number | undefined;
  let activeEvent: RetryEvent | undefined;
  const deadline = options.runtimeBudget ? new AbortController() : undefined;
  const signal = deadline ? AbortSignal.any([deadline.signal, ...(options.signal ? [options.signal] : [])]) : options.signal;
  let runtimeTimer: ReturnType<typeof setTimeout> | undefined;
  const emit = async (status: RetryEvent["status"], delayMs = 0) => {
    if (!receipt) return;
    activeEvent = { type: "engine_retry", status, attempt: retries, reason: receipt.reason, delayMs, sessionId: receipt.sessionId };
    await options.onEvent?.(activeEvent);
  };
  try {
    for (;;) {
      signal?.throwIfAborted();
      try {
        const result = await execute(receipt, async () => {
          // Reset only on actual assistant/tool output, never a connection,
          // session-start, thinking indicator or the passage of wall time.
          consecutiveFailures = 0; outageStartedAt = undefined;
          if (activeEvent?.status === "retrying") await emit("resumed");
        }, signal);
        if (activeEvent?.status === "retrying") await emit("resumed");
        return result;
      } catch (error) {
        if (!(error instanceof EngineRetryableError) || !error.retry.sessionId.trim()) throw error;
        receipt = error.retry;
        // The first attempt uses its native watchdog. Once it fails, carry its
        // remaining total cap through tool reconciliation, backoff, pool waits
        // and every continuation.
        // Useful progress may reset outage backoff, never this runtime deadline.
        if (deadline && !runtimeTimer) {
          const budget = options.runtimeBudget!();
          const error = new EngineRecoveryTimeoutError(budget.limitMs);
          if (budget.remainingMs <= 0) deadline.abort(error);
          else runtimeTimer = setTimeout(() => deadline.abort(error), budget.remainingMs);
        }
        // Account even when the runtime cap was already reached. Reconciliation
        // gets the same cancellation/deadline signal as native execution.
        try { await options.onFailure?.(receipt, error, signal); }
        finally { receipt.releaseTools?.(); }
        if (receipt.unfinishedWork) throw new EngineRecoveryUnconfirmedError(error, "unfinished-work");
        signal?.throwIfAborted();
        outageStartedAt ??= performance.now();
        consecutiveFailures++;
        const remaining = ENGINE_RECOVERY_WINDOW_MS - (performance.now() - outageStartedAt);
        // A few streamed characters followed by failure must not turn this into
        // a fast reconnect loop. Useful progress resets the outage window only;
        // backoff keeps increasing across this logical run.
        const backoff = BACKOFF_MS[Math.min(retries, BACKOFF_MS.length - 1)]!;
        const retryAfter = Number.isFinite(receipt.retryAfterMs) && receipt.retryAfterMs! > 0 ? receipt.retryAfterMs! : 0;
        const delayMs = Math.max(Math.round(backoff * (0.85 + Math.random() * 0.3)), retryAfter);
        // A second total bound also prevents a provider repeatedly emitting a
        // fragment and failing from keeping a broken turn alive indefinitely.
        if (delayMs > remaining || consecutiveFailures > 20 || retries >= 100) throw new EngineRecoveryExhaustedError(retries, error);
        retries++;
        await emit("waiting", delayMs);
        await waitForRecovery(delayMs, signal);
        signal?.throwIfAborted();
        await emit("retrying");
      }
    }
  } catch (error) {
    if (activeEvent && !["resumed", "cancelled", "failed"].includes(activeEvent.status)) {
      await emit(options.signal?.aborted ? "cancelled" : "failed");
    }
    // Preserve native uncertainty: reaching our deadline does not prove a
    // cancellation succeeded, nor erase a completion that beat the stop request.
    if (deadline?.signal.aborted && !(error instanceof EngineCancellationUnconfirmedError) && !(error instanceof EngineStopTooLateError)) throw deadline.signal.reason;
    throw error;
  } finally {
    if (runtimeTimer) clearTimeout(runtimeTimer);
  }
}
