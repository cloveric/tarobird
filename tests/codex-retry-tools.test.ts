import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CODEX_RETRY_TOOL_WAIT_MS, reconcileCodexRetryCommands } from "../src/codex/retry-tools.js";
import { EngineRecoveryTimeoutError, recoverEngineTurn } from "../src/runtime/engine-recovery.js";
import { EngineRetryableError } from "../src/codex/turn-retry.js";
import { renderCoreUserFacingError } from "../src/core/errors.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const item = (id = "command", status = "inProgress") => ({ type: "commandExecution", id, status, processId: "pty-1" });
const response = (status: string, turnId = "failed-turn", id = "command") => ({ data: [{ turnId, item: item(id, status) }] });
function fixture() {
  return { turnId: "failed-turn", ownedIds: new Set(["command"]), requestedIds: ["command"], terminalItems: [],
    read: vi.fn().mockResolvedValue(response("inProgress")), settled: vi.fn().mockResolvedValue(undefined), waiting: vi.fn().mockResolvedValue(undefined) };
}
it("waits for a real 16-minute command completion rather than the 10-minute provider window", async () => {
  const f = fixture(); let finished = false;
  const waiting = reconcileCodexRetryCommands(f).then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(16 * 60_000);
  expect(finished).toBe(false);
  expect(f.settled).not.toHaveBeenCalled();
  f.read.mockResolvedValue(response("completed"));
  await vi.advanceTimersByTimeAsync(30_000); await waiting;
  expect(f.settled).toHaveBeenCalledExactlyOnceWith(item("command", "completed"));
  expect(f.waiting).toHaveBeenCalledTimes(1);
});
it.each(["completed", "failed", "declined"])("accepts exact terminal summary %s without read or fabricated output", async status => {
  const f = fixture(); await reconcileCodexRetryCommands({ ...f, terminalItems: [item("foreign", "completed"), item("command", status)] });
  expect(f.settled).toHaveBeenCalledExactlyOnceWith(item("command", status));
  expect(f.read).not.toHaveBeenCalled(); expect(f.waiting).not.toHaveBeenCalled();
});
it.each([
  response("completed", "foreign-turn"), response("completed", "failed-turn", "foreign-command"),
  response("unknown"), {}, { data: [{ turnId: "failed-turn", item: { type: "mcpToolCall", id: "command", status: "completed" } }] },
])("leaves missing, foreign, incompatible or unknown work unresolved: %j", async reply => {
  const f = fixture(); f.read.mockResolvedValue(reply); await reconcileCodexRetryCommands(f);
  expect(f.settled).not.toHaveBeenCalled();
});
it("does not read a partly unowned set or claim callback success as completion", async () => {
  const f = fixture(); await reconcileCodexRetryCommands({ ...f, requestedIds: ["command", "unknown"] });
  expect(f.read).not.toHaveBeenCalled(); expect(f.settled).not.toHaveBeenCalled();
});
it("waits when persisted reads omit an actually-started command until it finishes", async () => {
  const f = fixture(); f.read.mockResolvedValue({ data: [] });
  const waiting = reconcileCodexRetryCommands(f);
  await vi.advanceTimersByTimeAsync(16 * 60_000);
  expect(f.settled).not.toHaveBeenCalled();
  f.read.mockResolvedValue(response("completed")); await vi.advanceTimersByTimeAsync(30_000); await waiting;
  expect(f.settled).toHaveBeenCalledTimes(1);
});
it("bounds waiting without declaring the still-running command done", async () => {
  const f = fixture(); const waiting = reconcileCodexRetryCommands(f);
  await vi.advanceTimersByTimeAsync(CODEX_RETRY_TOOL_WAIT_MS); await waiting;
  expect(f.settled).not.toHaveBeenCalled();
  const reads = f.read.mock.calls.length; await vi.advanceTimersByTimeAsync(10_000); expect(f.read).toHaveBeenCalledTimes(reads);
});
it("retries read errors then keeps unresolved work fenced", async () => {
  const f = fixture(); f.read.mockRejectedValue(new Error("RPC unavailable"));
  const waiting = reconcileCodexRetryCommands(f);
  await vi.advanceTimersByTimeAsync(20_000); await waiting;
  expect(f.read).toHaveBeenCalledTimes(3); expect(f.settled).not.toHaveBeenCalled();
});
it("recovers a transient read error without duplicating a terminal receipt", async () => {
  const f = fixture(); f.read.mockRejectedValueOnce(new Error("temporary")).mockResolvedValue(response("completed"));
  const waiting = reconcileCodexRetryCommands(f);
  await vi.advanceTimersByTimeAsync(5_000); await waiting;
  expect(f.read).toHaveBeenCalledTimes(2); expect(f.settled).toHaveBeenCalledTimes(1);
});
it("Stop aborts waiting without claiming that the native command stopped", async () => {
  const f = fixture(), controller = new AbortController();
  const waiting = reconcileCodexRetryCommands({ ...f, signal: controller.signal });
  const checked = expect(waiting).rejects.toMatchObject({ name: "EngineCancellationUnconfirmedError" });
  await vi.advanceTimersByTimeAsync(0); controller.abort(); await checked;
  const reads = f.read.mock.calls.length; await vi.advanceTimersByTimeAsync(60_000);
  expect(f.read).toHaveBeenCalledTimes(reads); expect(f.settled).not.toHaveBeenCalled();
});
it("a runtime deadline preserves command uncertainty but does not claim the user pressed Stop", async () => {
  const f = fixture();
  const execute = vi.fn().mockRejectedValue(new EngineRetryableError("busy", { sessionId: "native", reason: "capacity", mode: "continue" }));
  const run = recoverEngineTurn(execute, { runtimeBudget: () => ({ limitMs: 1000, remainingMs: 1000 }),
    onFailure: async (_receipt, _error, signal) => reconcileCodexRetryCommands({ ...f, signal }) });
  const checked = expect(run).rejects.toMatchObject({ name: "EngineCancellationUnconfirmedError", reason: "runtime-deadline", cause: expect.any(EngineRecoveryTimeoutError) });
  await vi.advanceTimersByTimeAsync(1000); await checked;
  const error = await run.catch(error => error);
  expect(renderCoreUserFacingError(error, "engine", "zh")).toContain("运行时限");
  expect(renderCoreUserFacingError(error, "engine", "en")).toContain("runtime limit");
  expect(renderCoreUserFacingError(error, "engine", "zh")).not.toContain("尚未确认停止");
  expect(execute).toHaveBeenCalledTimes(1); expect(f.settled).not.toHaveBeenCalled();
});
it("an already-exhausted runtime deadline emits no false waiting progress", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort(new EngineRecoveryTimeoutError(1000));
  await expect(reconcileCodexRetryCommands({ ...f, signal: controller.signal })).rejects.toMatchObject({ name: "EngineCancellationUnconfirmedError", reason: "runtime-deadline" });
  expect(f.waiting).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(f.settled).not.toHaveBeenCalled();
});
it("losing the native owner fails closed without retrying reads on a replacement", async () => {
  const f = fixture(); let available = true;
  f.read.mockImplementation(async () => { available = false; throw new Error("owner exited"); });
  await reconcileCodexRetryCommands({ ...f, isAvailable: () => available });
  expect(f.read).toHaveBeenCalledTimes(1); expect(f.settled).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
