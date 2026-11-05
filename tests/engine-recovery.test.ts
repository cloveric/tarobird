import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EngineCancellationUnconfirmedError, EngineIncompleteResponseError, type EngineStreamEvent } from "../src/codex/adapter.js";
import { EngineRetryableError, withEngineRetryReceipt, type EngineRetryReason } from "../src/codex/turn-retry.js";
import { ENGINE_RECOVERY_WINDOW_MS, EngineRecoveryExhaustedError, EngineRecoveryTimeoutError, recoverEngineTurn } from "../src/runtime/engine-recovery.js";
import { renderCoreUserFacingError } from "../src/core/errors.js";
import { classifyFailure, getBusErrorSemantics } from "../src/runtime/error-classification.js";
import { EngineRecoveryBudgetError, EngineRecoveryUnconfirmedError } from "../src/runtime/engine-recovery.js";

const failure = (retryAfterMs?: number) => new EngineRetryableError("Selected model is at capacity. Codex error code: serverOverloaded", {
  sessionId: "native-1", mode: "continue", reason: "capacity", retryAfterMs,
});
it.each([new EngineRecoveryExhaustedError(4, failure()), new EngineRecoveryBudgetError("Budget exhausted"), new EngineRecoveryUnconfirmedError(new Error("mismatched session"))])("never invites a delegating agent to replay a task after recovery stopped: %s", error => {
  expect(getBusErrorSemantics(classifyFailure(error)).retryable).toBe(false);
});
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0.5); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each([
  ["capacity", "模型服务暂时繁忙。", "The model service is temporarily busy."],
  ["connection", "模型服务连接中断。", "The connection to the model service was interrupted."],
  ["rate-limit", "模型服务当前触发限流。", "The model service is rate-limiting requests."],
] as const)("keeps the original %s failure visible when recovery is withheld, without inviting a replay", (retryReason, zh, en) => {
  for (const reason of ["receipt", "unfinished-work"] as const) {
    const cause = new EngineRetryableError("provider-private-diagnostic", { sessionId: "private-native-session", mode: "continue", reason: retryReason });
    const error = new EngineRecoveryUnconfirmedError(cause, reason);
    expect(error.cause).toBe(cause);
    expect(error.retryReason).toBe(retryReason);
    expect(error.message).toContain(retryReason);
    expect(error.message).toContain(reason === "unfinished-work" ? "work has not reported completion" : "receipt conflicts");
    if (reason === "unfinished-work") expect(error.message).not.toContain("receipt conflicts");
    expect(getBusErrorSemantics(classifyFailure(error)).retryable).toBe(false);
    for (const [locale, prefix] of [["zh", zh], ["en", en]] as const) {
      const text = renderCoreUserFacingError(error, "engine", locale);
      expect(text.startsWith(prefix)).toBe(true);
      expect(text).toContain(locale === "zh" ? "原会话已保留" : "conversation is preserved");
      expect(text).toContain(reason === "unfinished-work"
        ? locale === "zh" ? "以免重复执行" : "avoid starting it twice"
        : locale === "zh" ? "回执" : "receipt");
      expect(text).not.toContain("provider-private-diagnostic");
      expect(text).not.toContain("private-native-session");
    }
    expect(error.message).not.toContain("provider-private-diagnostic");
    expect(error.message).not.toContain("private-native-session");
  }
});

it.each([
  new Error("Selected model is at capacity; provider-private-diagnostic"),
  new EngineRetryableError("provider-private-diagnostic", { sessionId: "native", mode: "continue", reason: "provider-private-diagnostic" as EngineRetryReason }),
])("does not invent or expose a provider reason from an unclassified cause: %s", cause => {
  const error = new EngineRecoveryUnconfirmedError(cause, "unfinished-work");
  expect(error.retryReason).toBeUndefined();
  expect(error.message).toContain("work has not reported completion");
  expect(error.message).not.toContain("provider-private-diagnostic");
  expect(renderCoreUserFacingError(error, "engine", "zh")).toMatch(/^还有工具或后台任务/);
  expect(renderCoreUserFacingError(error, "engine", "en")).toMatch(/^Some tool or background work/);
});

it("waits with increasing backoff, respects Retry-After, and reports recovery only after real progress", async () => {
  const events: EngineStreamEvent[] = [], usage = vi.fn().mockResolvedValue(undefined);
  const execute = vi.fn(async (receipt, progress) => {
    if (execute.mock.calls.length === 1) throw failure(8_000);
    if (execute.mock.calls.length === 2) throw failure();
    expect(receipt).toMatchObject({ sessionId: "native-1", mode: "continue" });
    expect(events.at(-1)).toMatchObject({ status: "retrying" });
    await progress();
    expect(events.at(-1)).toMatchObject({ status: "resumed" });
    return "done";
  });
  const result = recoverEngineTurn(execute, { onEvent: e => { events.push(e); }, onFailure: usage });
  await vi.advanceTimersByTimeAsync(7_999);
  expect(execute).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(execute).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(execute).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toBe("done");
  expect(usage).toHaveBeenCalledTimes(2);
  expect(events.map(e => e.type === "engine_retry" && e.status)).toEqual(["waiting", "retrying", "waiting", "retrying", "resumed"]);
});

it("stops a pending retry immediately and never wakes it later", async () => {
  const abort = new AbortController(), events: EngineStreamEvent[] = [];
  const execute = vi.fn().mockRejectedValue(failure());
  const result = recoverEngineTurn(execute, { signal: abort.signal, onEvent: e => { events.push(e); } });
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(1_000);
  abort.abort(); await rejected;
  await vi.advanceTimersByTimeAsync(ENGINE_RECOVERY_WINDOW_MS);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(events.at(-1)).toMatchObject({ status: "cancelled" });
  expect(vi.getTimerCount()).toBe(0);
});

it("records a native terminal receipt but never resumes while native child work remains unconfirmed", async () => {
  const error = new EngineRetryableError("Selected model is at capacity", {
    sessionId: "native-1", mode: "continue", reason: "capacity", unfinishedWork: true,
    usage: { inputTokens: 123, outputTokens: 4 },
  });
  const execute = vi.fn().mockRejectedValue(error), account = vi.fn().mockResolvedValue(undefined), event = vi.fn();
  await expect(recoverEngineTurn(execute, { onFailure: account, onEvent: event })).rejects.toMatchObject({
    name: "EngineRecoveryUnconfirmedError", reason: "unfinished-work", retryReason: "capacity", cause: error,
  });
  expect(account).toHaveBeenCalledWith(error.retry, error, undefined);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(event).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds a persistent outage and accounts for the last failed attempt", async () => {
  const execute = vi.fn().mockRejectedValue(failure()), account = vi.fn().mockResolvedValue(undefined);
  const result = recoverEngineTurn(execute, { onFailure: account });
  const rejected = expect(result).rejects.toBeInstanceOf(EngineRecoveryExhaustedError);
  await vi.advanceTimersByTimeAsync(ENGINE_RECOVERY_WINDOW_MS);
  await rejected;
  expect(execute.mock.calls.length).toBeGreaterThan(5);
  expect(execute.mock.calls.length).toBeLessThanOrEqual(21);
  expect(account).toHaveBeenCalledTimes(execute.mock.calls.length);
  expect(vi.getTimerCount()).toBe(0);
  expect(renderCoreUserFacingError(new EngineRecoveryExhaustedError(10, failure()), "engine")).toContain("原会话和已完成的工作已保留");
});

it("does not reset backoff merely because some output resumes between failures", async () => {
  const events: EngineStreamEvent[] = [];
  const execute = vi.fn(async (_receipt, progress) => {
    if (execute.mock.calls.length === 1) throw failure();
    if (execute.mock.calls.length === 2) { await progress(); throw failure(); }
    return "done";
  });
  const result = recoverEngineTurn(execute, { onEvent: e => { events.push(e); } });
  await vi.advanceTimersByTimeAsync(7_000);
  await expect(result).resolves.toBe("done");
  expect(events.filter(e => e.type === "engine_retry" && e.status === "waiting").map(e => "delayMs" in e && e.delayMs)).toEqual([2_000, 5_000]);
});

it("has a total recovery bound even if a broken provider emits output on every attempt", async () => {
  const execute = vi.fn(async (_receipt, progress) => { await progress(); throw failure(); });
  const result = recoverEngineTurn(execute);
  const rejected = expect(result).rejects.toBeInstanceOf(EngineRecoveryExhaustedError);
  await vi.advanceTimersByTimeAsync(100 * 60_000); await rejected;
  expect(execute).toHaveBeenCalledTimes(101);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not ignore a Retry-After longer than the bounded recovery window", async () => {
  const execute = vi.fn().mockRejectedValue(failure(ENGINE_RECOVERY_WINDOW_MS + 1));
  await expect(recoverEngineTurn(execute)).rejects.toBeInstanceOf(EngineRecoveryExhaustedError);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("counts backoff against the original runtime cap without starting a second native turn", async () => {
  const execute = vi.fn().mockRejectedValue(failure());
  const result = recoverEngineTurn(execute, { runtimeBudget: () => ({ limitMs: 1500, remainingMs: 500 }) });
  const rejected = expect(result).rejects.toBeInstanceOf(EngineRecoveryTimeoutError);
  await vi.advanceTimersByTimeAsync(500); await rejected;
  expect(execute).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])("keeps the original cap during a resumed native turn and preserves cancellation uncertainty=%s", async unconfirmed => {
  const execute = vi.fn(async (_receipt, progress, signal?: AbortSignal) => {
    if (execute.mock.calls.length === 1) throw failure();
    await progress(); // Resumed work must not reset the original total cap.
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(unconfirmed ? new EngineCancellationUnconfirmedError() : new DOMException("Stopped", "AbortError")), { once: true }));
  });
  const result = recoverEngineTurn(execute, { runtimeBudget: () => ({ limitMs: 5000, remainingMs: 3000 }) });
  const rejected = expect(result).rejects.toBeInstanceOf(unconfirmed ? EngineCancellationUnconfirmedError : EngineRecoveryTimeoutError);
  await vi.advanceTimersByTimeAsync(3000); await rejected;
  expect(execute).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  new Error("fetch failed"), new Error("Selected model is at capacity"),
  new EngineCancellationUnconfirmedError(), new EngineIncompleteResponseError("empty"),
  new Error("authentication expired"), new Error("quota exceeded"),
])("never retries an unconfirmed or nonrecoverable failure: %s", async error => {
  const execute = vi.fn().mockRejectedValue(error);
  await expect(recoverEngineTurn(execute)).rejects.toBe(error);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["Selected model is at capacity", "stream disconnected before completion", "API Error: 529 overloaded", "ECONNRESET", "HTTP 503 Service Unavailable", "429 Too Many Requests"])("classifies transient provider failure only at an adapter-verified boundary: %s", message => {
  expect(withEngineRetryReceipt(new Error(message), { sessionId: "native", mode: "continue" })).toBeInstanceOf(EngineRetryableError);
});
it.each(["quota exceeded", "401 unauthorized", "content policy violation", "turn timed out after 10 minutes", "unknown error\n\n[engine diagnostics]\nSelected model is at capacity"])("does not promote permanent errors or historic diagnostics: %s", message => {
  const error = new Error(message);
  expect(withEngineRetryReceipt(error, { sessionId: "native", mode: "continue" })).toBe(error);
});
