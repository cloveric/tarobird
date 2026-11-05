import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Bridge, type AccessStoreLike, type SessionManagerLike } from "../src/runtime/bridge.js";
import type { CodexAdapter, EngineStreamEvent } from "../src/codex/adapter.js";
import { EngineRetryableError } from "../src/codex/turn-retry.js";
import { ENGINE_RECOVERY_CONTINUATION, EngineRecoveryBudgetError, EngineRecoveryTimeoutError } from "../src/runtime/engine-recovery.js";
import type { TurnPoolLike } from "../src/runtime/turn-pool.js";
import { createRunRecord, recordRunEvent } from "../src/core/run-record.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { resolve, promise }; }
function fixture(options: ConstructorParameters<typeof Bridge>[3] = {}, turnRuntimeLimitMs?: number) {
  const id = randomUUID(), native = `native-${id}`;
  const access: AccessStoreLike = { load: vi.fn().mockResolvedValue({ policy: "allowlist", allowlist: [84], pairedUsers: [], pendingPairs: [] }), issuePairingCode: vi.fn() };
  const manager: SessionManagerLike = { getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: `provisional-${id}` }), bindSession: vi.fn().mockResolvedValue(undefined) };
  const send = vi.fn<CodexAdapter["sendUserMessage"]>(), adapter: CodexAdapter = { createSession: vi.fn(), sendUserMessage: send, turnRuntimeLimitMs };
  const waiting = deferred(), events: EngineStreamEvent[] = [];
  const input = { chatId: 84, userId: 42, chatType: "private", conversationKey: id, text: "Finish the project and deliver the file once", files: ["/input.pdf"], locale: "zh" as const,
    onEngineEvent: async (event: EngineStreamEvent) => { events.push(event); if (event.type === "engine_retry" && event.status === "waiting") waiting.resolve(); } };
  return { native, manager, send, waiting, events, input, bridge: new Bridge(access, manager, adapter, options),
    fail: (mode: "input" | "continue" = "continue") => new EngineRetryableError("Selected model is at capacity", { sessionId: native, reason: "capacity", mode, usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.1 } }) };
}
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0.5); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each([
  { prefix: "Op", chunks: ["us", " ", "认可这个方案。"] },
  { prefix: "回归", chunks: ["也通过了", " ", "25", " ", "项。"] },
  { prefix: "```ts\n", chunks: ["const", " ", "name", " ", "=", " ", "'Opus';", "\n", "\t", "run(name);", "\n", "```"] },
])("preserves concurrent text fragments and standalone whitespace: $prefix", async ({ prefix, chunks }) => {
  const f = fixture(), run = createRunRecord(), expected = prefix + chunks.join("");
  f.send.mockImplementation(async (_id, input) => {
    await input.onEngineEvent?.({ type: "assistant_text", text: prefix, delta: true });
    // Native stream adapters publish a burst without awaiting each observer.
    await Promise.all(chunks.map(text => input.onEngineEvent?.({ type: "assistant_text", text, delta: true })));
    return { text: expected };
  });
  await f.bridge.handleAuthorizedMessage({ ...f.input, onEngineEvent: async event => {
    recordRunEvent(run, event);
    await f.input.onEngineEvent(event);
  } });
  expect(f.events.filter(event => event.type === "assistant_text").map(event => event.text)).toEqual([prefix, ...chunks]);
  expect(run.entries.filter(entry => entry.kind === "text").map(entry => entry.text).join("")).toBe(expected);
});

it("forwards resumed output in native order while the recovery observer is still pending", async () => {
  const f = fixture(), resumed = deferred(), release = deferred(), published = deferred();
  const chunks = ["Op", "us", " ", "认可。"];
  f.send.mockRejectedValueOnce(f.fail()).mockImplementationOnce(async (_id, input) => {
    const pending = chunks.map(text => input.onEngineEvent?.({ type: "assistant_text", text, delta: true }));
    published.resolve();
    await Promise.all(pending);
    return { text: chunks.join("") };
  });
  const result = f.bridge.handleAuthorizedMessage({ ...f.input, onEngineEvent: async event => {
    await f.input.onEngineEvent(event);
    if (event.type === "engine_retry" && event.status === "resumed") {
      resumed.resolve();
      await release.promise;
    }
  } });
  await f.waiting.promise;
  await vi.advanceTimersByTimeAsync(2_000);
  await resumed.promise;
  await published.promise;
  try {
    expect(f.events.filter(event => event.type === "assistant_text").map(event => event.text)).toEqual(chunks);
    expect(f.events.filter(event => event.type === "engine_retry").map(event => event.status)).toEqual(["waiting", "retrying", "resumed"]);
  } finally {
    release.resolve();
    await result;
  }
});

it("keeps tool progress and terminal receipts after their preceding output", async () => {
  const f = fixture(), run = createRunRecord();
  const events: EngineStreamEvent[] = [
    { type: "assistant_text", text: "Checking…", delta: true },
    { type: "tool_use", toolUseId: "cmd-1", toolName: "Bash" },
    { type: "tool_progress", toolUseId: "cmd-1", text: "running" },
    { type: "tool_result", toolUseId: "cmd-1", toolName: "Bash", output: "done" },
    { type: "assistant_text", text: "Finished.", delta: true },
    { type: "result", text: "Finished." },
  ];
  f.send.mockImplementation(async (_id, input) => {
    await Promise.all(events.map(event => input.onEngineEvent?.(event)));
    return { text: "Finished." };
  });
  await f.bridge.handleAuthorizedMessage({ ...f.input, onEngineEvent: async event => {
    recordRunEvent(run, event);
    await f.input.onEngineEvent(event);
  } });
  expect(f.events).toEqual(events);
  expect(run.entries.map(entry => entry.kind)).toEqual(["text", "tool", "text"]);
  expect(run.phase).toBe("delivering");
});

it("does not hold subsequent output behind a pending question observer", async () => {
  const f = fixture(), release = deferred();
  f.send.mockImplementation(async (_id, input) => {
    const question = input.onEngineEvent?.({ type: "user_input_request", toolName: "request_user_input_async", toolInput: {} });
    try {
      await Promise.all(["Still", " ", "working"].map(text => input.onEngineEvent?.({ type: "assistant_text", text, delta: true })));
      expect(f.events.filter(event => event.type === "assistant_text").map(event => event.text).join("")).toBe("Still working");
    } finally {
      release.resolve();
      await question;
    }
    return { text: "Still working" };
  });
  await f.bridge.handleAuthorizedMessage({ ...f.input, onEngineEvent: async event => {
    await f.input.onEngineEvent(event);
    if (event.type === "user_input_request") await release.promise;
  } });
});

it("persists a newly confirmed native context before waiting and continues without replaying task or attachments", async () => {
  const account = vi.fn().mockResolvedValue(undefined), budget = vi.fn().mockResolvedValue(undefined);
  const f = fixture({ recordFailedAttempt: account, beforeRetry: budget });
  f.send.mockRejectedValueOnce(f.fail()).mockImplementationOnce(async (id, input) => {
    expect(id).toBe(f.native); expect(input.text).toBe(ENGINE_RECOVERY_CONTINUATION); expect(input.files).toEqual([]);
    await input.onEngineEvent?.({ type: "assistant_text", text: "Continuing remaining work", delta: true });
    return { text: "done", sessionId: id, usage: { inputTokens: 20, outputTokens: 3 } };
  });
  const result = f.bridge.handleAuthorizedMessage(f.input);
  await f.waiting.promise;
  expect(f.manager.bindSession).toHaveBeenCalledWith({ chatId: 84, conversationKey: f.input.conversationKey, messageThreadId: undefined }, f.native);
  expect(account).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(result).resolves.toMatchObject({ text: "done", usage: { inputTokens: 20 } });
  expect(account).toHaveBeenCalledTimes(1); // Success is still recorded by Core, not twice here.
  expect(budget).toHaveBeenCalledWith("zh");
  expect(f.events.filter(e => e.type === "engine_retry").map(e => e.status)).toEqual(["waiting", "retrying", "resumed"]);
});

it("resends the unadmitted input, but never reverts to the original task after a failed continuation", async () => {
  const f = fixture();
  f.send.mockRejectedValueOnce(f.fail("input")).mockRejectedValueOnce(f.fail("continue")).mockRejectedValueOnce(f.fail("input")).mockResolvedValueOnce({ text: "done" });
  const result = f.bridge.handleAuthorizedMessage(f.input); await f.waiting.promise;
  await vi.advanceTimersByTimeAsync(17_000); await result;
  expect(f.send.mock.calls.map(c => c[1].text)).toEqual([f.input.text, f.input.text, ENGINE_RECOVERY_CONTINUATION, ENGINE_RECOVERY_CONTINUATION]);
  expect(f.send.mock.calls.map(c => c[1].files)).toEqual([["/input.pdf"], ["/input.pdf"], [], []]);
  expect(f.send.mock.calls.map(c => c[1].engineRecoveryContinuation)).toEqual([undefined, undefined, true, true]);
});

it("Stop wins during recovery and retains the native context for a later manual continuation", async () => {
  const f = fixture(), abort = new AbortController(); f.send.mockRejectedValue(f.fail());
  const result = f.bridge.handleAuthorizedMessage({ ...f.input, abortSignal: abort.signal });
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  await f.waiting.promise; abort.abort(); await rejected;
  await vi.advanceTimersByTimeAsync(600_000);
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.manager.bindSession).toHaveBeenCalledTimes(1);
});

it("rechecks budget after the wait and does not start another native turn when exhausted", async () => {
  const budgetError = new EngineRecoveryBudgetError("预算已用尽");
  const f = fixture({ beforeRetry: vi.fn().mockRejectedValue(budgetError) }); f.send.mockRejectedValue(f.fail());
  const result = f.bridge.handleAuthorizedMessage(f.input), rejected = expect(result).rejects.toBe(budgetError);
  await f.waiting.promise; await vi.advanceTimersByTimeAsync(2_000); await rejected;
  expect(f.send).toHaveBeenCalledTimes(1);
});

it("keeps override sessions isolated while using their confirmed native context for recovery", async () => {
  const f = fixture(); f.send.mockRejectedValueOnce(f.fail()).mockResolvedValueOnce({ text: "done", sessionId: f.native });
  const result = f.bridge.handleAuthorizedMessage({ ...f.input, sessionIdOverride: "explicit-override" });
  await f.waiting.promise; await vi.advanceTimersByTimeAsync(2_000); await result;
  expect(f.send.mock.calls.map(c => c[0])).toEqual(["explicit-override", f.native]);
  expect(f.manager.bindSession).not.toHaveBeenCalled();
});

it("releases shared worker capacity while holding only the recovering conversation", async () => {
  let active = 0;
  const pool: TurnPoolLike = { async run(task) { expect(active).toBe(0); active++; try { return await task(); } finally { active--; } } };
  const f = fixture({ turnPool: pool }), other = fixture({ turnPool: pool });
  f.send.mockRejectedValueOnce(f.fail()).mockResolvedValueOnce({ text: "recovered" }); other.send.mockResolvedValue({ text: "other chat works" });
  const result = f.bridge.handleAuthorizedMessage(f.input); await f.waiting.promise;
  expect(active).toBe(0);
  await expect(other.bridge.handleAuthorizedMessage(other.input)).resolves.toMatchObject({ text: "other chat works" });
  expect(f.send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2_000); await result;
  expect(active).toBe(0);
});

it.each(["wrong-session", "input-after-tool", "input-after-thinking"])("refuses conflicting native recovery receipts: %s", async conflict => {
  const account = vi.fn().mockResolvedValue(undefined), f = fixture({ recordFailedAttempt: account });
  const failure = conflict === "wrong-session" ? new EngineRetryableError("overloaded", { sessionId: "unrelated-native", mode: "continue", reason: "capacity" }) : f.fail("input");
  f.send.mockImplementationOnce(async (_id, input) => {
    await input.onEngineEvent?.({ type: "session", sessionId: f.native });
    if (conflict === "wrong-session") throw failure;
    await input.onEngineEvent?.(conflict === "input-after-tool" ? { type: "tool_use", toolName: "Edit" } : { type: "thinking", text: "Planning the requested changes" });
    throw failure;
  });
  await expect(f.bridge.handleAuthorizedMessage(f.input)).rejects.toMatchObject({ name: "EngineRecoveryUnconfirmedError", reason: "receipt", retryReason: "capacity", cause: failure });
  await vi.advanceTimersByTimeAsync(600_000);
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(account).toHaveBeenCalledTimes(1);
  expect(f.manager.bindSession).toHaveBeenCalledTimes(1);
  expect(f.events.some(e => e.type === "engine_retry")).toBe(false);
});

it.each([false, true])("carries the adapter runtime cap across recovery unless explicitly disabled=%s", async disableRuntimeTimeout => {
  const f = fixture({}, 1500);
  f.send.mockRejectedValueOnce(f.fail()).mockResolvedValueOnce({ text: "done" });
  const result = f.bridge.handleAuthorizedMessage({ ...f.input, disableRuntimeTimeout });
  const checked = disableRuntimeTimeout ? expect(result).resolves.toMatchObject({ text: "done" }) : expect(result).rejects.toBeInstanceOf(EngineRecoveryTimeoutError);
  await f.waiting.promise; await vi.advanceTimersByTimeAsync(2000); await checked;
  expect(f.send).toHaveBeenCalledTimes(disableRuntimeTimeout ? 2 : 1);
});

it.each(["child", "background", "tool"] as const)("does not continue while observed %s work has no completion receipt", async kind => {
  const account = vi.fn().mockResolvedValue(undefined), f = fixture({ recordFailedAttempt: account }), failure = f.fail();
  f.send.mockImplementationOnce(async (_id, input) => {
    const event: EngineStreamEvent = kind === "child" ? { type: "subagent_activity", id: "activity", kind: "started", agentId: "child-1", label: "reviewer" }
      : kind === "background" ? { type: "background_task_started", taskId: "job-1" }
      : { type: "tool_use", toolUseId: "cmd-1", toolName: "Bash" };
    await input.onEngineEvent?.(event); throw failure;
  });
  await expect(f.bridge.handleAuthorizedMessage(f.input)).rejects.toMatchObject({ name: "EngineRecoveryUnconfirmedError", reason: "unfinished-work", retryReason: "capacity", cause: failure });
  await vi.advanceTimersByTimeAsync(600_000);
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(account).toHaveBeenCalledExactlyOnceWith(failure.retry);
  expect(f.manager.bindSession).toHaveBeenCalledTimes(1);
  expect(f.events.some(event => event.type === "engine_retry")).toBe(false);
});

it("retains native context and failed usage when the adapter reports unfinished work outside shared events", async () => {
  const account = vi.fn().mockResolvedValue(undefined), f = fixture({ recordFailedAttempt: account });
  const error = f.fail(); error.retry.unfinishedWork = true;
  f.send.mockRejectedValueOnce(error);
  await expect(f.bridge.handleAuthorizedMessage(f.input)).rejects.toMatchObject({ name: "EngineRecoveryUnconfirmedError", reason: "unfinished-work" });
  expect(account).toHaveBeenCalledWith(error.retry);
  expect(f.manager.bindSession).toHaveBeenCalledWith({ chatId: 84, conversationKey: f.input.conversationKey, messageThreadId: undefined }, f.native);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.events.some(event => event.type === "engine_retry")).toBe(false);
});

it("waits for exact command receipts then continues the same session once without replay or files", async () => {
  const account = vi.fn().mockResolvedValue(undefined), f = fixture({ recordFailedAttempt: account });
  const failure = f.fail(), started = deferred(), release = deferred();
  failure.retry.releaseTools = vi.fn();
  f.send.mockImplementationOnce(async (_id, input) => {
    await input.onEngineEvent?.({ type: "session", sessionId: f.native });
    await input.onEngineEvent?.({ type: "tool_use", toolUseId: "cmd-1", toolName: "Bash" });
    failure.retry.reconcileTools = vi.fn(async (ids, signal) => {
      expect(ids).toEqual(["cmd-1"]); signal?.throwIfAborted(); started.resolve();
      await release.promise;
      await input.onEngineEvent?.({ type: "tool_result", toolUseId: "cmd-1", toolName: "Bash", exitCode: 0 });
    });
    throw failure;
  }).mockResolvedValueOnce({ text: "completed" });
  const result = f.bridge.handleAuthorizedMessage(f.input);
  await started.promise; await vi.advanceTimersByTimeAsync(16 * 60_000);
  expect(f.send).toHaveBeenCalledTimes(1); expect(account).toHaveBeenCalledTimes(1);
  release.resolve(); await f.waiting.promise; await vi.advanceTimersByTimeAsync(2_000);
  await result;
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.send.mock.calls[1]).toEqual([f.native, expect.objectContaining({ text: ENGINE_RECOVERY_CONTINUATION, files: [], engineRecoveryContinuation: true })]);
  expect(failure.retry.releaseTools).toHaveBeenCalledTimes(1);
});

it.each(["child", "background", "native-child", "anonymous", "wrong-session"])("does not invoke reconciliation for unsafe %s work and releases its lease", async kind => {
  const f = fixture(), failure = f.fail();
  failure.retry.reconcileTools = vi.fn(); failure.retry.releaseTools = vi.fn();
  if (kind === "native-child") failure.retry.unfinishedWork = true;
  f.send.mockImplementationOnce(async (_id, input) => {
    await input.onEngineEvent?.({ type: "session", sessionId: kind === "wrong-session" ? "other" : f.native });
    await input.onEngineEvent?.({ type: "tool_use", toolUseId: kind === "anonymous" ? undefined : "cmd-1", toolName: "Bash" });
    if (kind === "child") await input.onEngineEvent?.({ type: "subagent_activity", id: "a", agentId: "child", label: "review", kind: "started" });
    if (kind === "background") await input.onEngineEvent?.({ type: "background_task_started", taskId: "job" });
    throw failure;
  });
  await expect(f.bridge.handleAuthorizedMessage(f.input)).rejects.toMatchObject({ name: "EngineRecoveryUnconfirmedError" });
  expect(failure.retry.reconcileTools).not.toHaveBeenCalled(); expect(failure.retry.releaseTools).toHaveBeenCalledTimes(1);
});

it("does not equate a resolved reconciliation promise with a completed tool", async () => {
  const f = fixture(), failure = f.fail(); failure.retry.reconcileTools = vi.fn().mockResolvedValue(undefined);
  f.send.mockImplementationOnce(async (_id, input) => { await input.onEngineEvent?.({ type: "tool_use", toolUseId: "pending", toolName: "Bash" }); throw failure; });
  await expect(f.bridge.handleAuthorizedMessage(f.input)).rejects.toMatchObject({ name: "EngineRecoveryUnconfirmedError", reason: "unfinished-work" });
  expect(f.send).toHaveBeenCalledTimes(1);
});

it.each(["stop", "budget"])("%s aborts reconciliation before any continuation and releases the adapter lease", async reason => {
  const f = fixture({}, reason === "budget" ? 1_000 : undefined), failure = f.fail(), controller = new AbortController(), started = deferred();
  failure.retry.releaseTools = vi.fn();
  failure.retry.reconcileTools = vi.fn(async (_ids, signal) => {
    await new Promise<void>((_resolve, reject) => { signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }); started.resolve(); });
  });
  f.send.mockImplementationOnce(async (_id, input) => { await input.onEngineEvent?.({ type: "tool_use", toolUseId: "pending", toolName: "Bash" }); throw failure; });
  const result = f.bridge.handleAuthorizedMessage({ ...f.input, abortSignal: controller.signal });
  const checked = expect(result).rejects.toMatchObject({ name: reason === "budget" ? "EngineRecoveryTimeoutError" : "AbortError" });
  await started.promise;
  if (reason === "stop") controller.abort(); else await vi.advanceTimersByTimeAsync(1_000);
  await checked; expect(f.send).toHaveBeenCalledTimes(1); expect(failure.retry.releaseTools).toHaveBeenCalledTimes(1);
});

it("continues after exact child, tool and background receipts, ignoring plan metadata", async () => {
  const f = fixture();
  f.send.mockImplementationOnce(async (_id, input) => {
    for (const event of [
      { type: "subagent_activity", id: "activity-1", kind: "started", agentId: "child-1", label: "reviewer" },
      { type: "subagent_activity", id: "activity-2", kind: "completed", agentId: "child-1", label: "reviewer" },
      { type: "background_task_started", taskId: "job-1" }, { type: "background_task_finished", taskId: "job-1", status: "completed" },
      { type: "tool_use", toolUseId: "cmd-1", toolName: "Bash" }, { type: "tool_use", toolUseId: "cmd-1", toolName: "Bash" },
      { type: "tool_result", toolUseId: "cmd-1", toolName: "Bash" }, { type: "tool_use", toolUseId: "plan", toolName: "update_plan" },
    ] satisfies EngineStreamEvent[]) await input.onEngineEvent?.(event);
    throw f.fail();
  }).mockResolvedValueOnce({ text: "done" });
  const result = f.bridge.handleAuthorizedMessage(f.input); await f.waiting.promise;
  await vi.advanceTimersByTimeAsync(2000); await expect(result).resolves.toMatchObject({ text: "done" });
  expect(f.send).toHaveBeenCalledTimes(2);
});
