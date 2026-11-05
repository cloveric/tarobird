import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { Bridge } from "../src/runtime/bridge.js";
import { ENGINE_RECOVERY_CONTINUATION } from "../src/runtime/engine-recovery.js";
import { createRunRecord, recordRunEvent } from "../src/core/run-record.js";
import type { EngineStreamEvent } from "../src/codex/adapter.js";
import { CodexAppServerAdapter, codexTransientRetryReason } from "../src/codex/app-server-adapter.js";
import { EngineRetryableError } from "../src/codex/turn-retry.js";

type Frame = { id?: number | string; method?: string; params?: Record<string, any>; result?: unknown; error?: unknown };
type Notify = (method: string, params?: Record<string, unknown>) => void;
/** Scripts the native turn after an accepted turn/start; returning false leaves it open. */
type TurnScript = (notify: Notify, ids: { threadId: string; turnId: string }, child: FakeChild) => void;
type StartScript =
  | { error: { code: number; message: string; data?: unknown } }
  /** Adversarial order: native turn notifications arrive before the request's error answer. */
  | { startedThenError: { code: number; message: string; data?: unknown }; withExecution?: boolean }
  | { turn: TurnScript };

class FakeStream extends EventEmitter {
  emitData(chunk: string) { this.emit("data", chunk); }
}

/** In-memory `codex app-server`: answers JSON-RPC requests and replays the
 * scripted notifications for each turn/start. */
class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  frames: Frame[] = [];
  starts: StartScript[] = [];
  readItems?: (frame: Frame) => void;
  beforeStartReply?: (threadId: string) => void;
  private threads = 0;
  private turns = 0;
  stdin = {
    write: (chunk: string, callback?: (error?: Error | null) => void) => {
      callback?.(null);
      for (const line of chunk.split("\n").filter(Boolean)) this.receive(JSON.parse(line) as Frame);
      return true;
    },
    on() {},
  };
  kill() {}
  send(frame: Frame) { setImmediate(() => this.stdout.emitData(`${JSON.stringify(frame)}\n`)); }
  methods() { return this.frames.filter((frame) => frame.method).map((frame) => `${frame.method}${frame.params?.threadId ? `(${frame.params.threadId})` : ""}`); }
  private receive(frame: Frame) {
    this.frames.push(frame);
    if (frame.method === "initialize") return this.send({ id: frame.id, result: { platformOs: "macos" } });
    if (frame.method === "thread/start") return this.send({ id: frame.id, result: { thread: { id: `thr-${++this.threads}` } } });
    if (frame.method === "thread/resume") return this.send({ id: frame.id, result: { thread: { id: frame.params!.threadId } } });
    if (frame.method === "thread/items/read" && this.readItems) return this.readItems(frame);
    if (frame.method !== "turn/start") return this.send({ id: frame.id, result: {} });
    const script = this.starts.shift();
    if (!script) throw new Error("unscripted turn/start");
    if ("error" in script) return this.send({ id: frame.id, error: script.error });
    const threadId = frame.params!.threadId as string;
    const turnId = `turn-${++this.turns}`;
    this.beforeStartReply?.(threadId);
    if ("startedThenError" in script) {
      const notify: Notify = (method, params = {}) => this.send({ method, params: { threadId, turnId, ...params } });
      notify("turn/started", { turn: { id: turnId, status: "inProgress", items: [] } });
      if (script.withExecution) notify("item/started", { item: { type: "commandExecution", id: "cmd-early", command: "touch out.txt", status: "inProgress" } });
      return this.send({ id: frame.id, error: script.startedThenError });
    }
    this.send({ id: frame.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
    const notify: Notify = (method, params = {}) => this.send({ method, params: { threadId, turnId, ...params } });
    notify("turn/started", { turn: { id: turnId, status: "inProgress", items: [] } });
    script.turn(notify, { threadId, turnId }, this);
  }
}

const capacity = { message: "Selected model is at capacity. Please try a different model.", codexErrorInfo: "serverOverloaded", additionalDetails: null };

function failTurn(error: Record<string, unknown>, options: { notification?: boolean; usage?: boolean } = {}): TurnScript {
  return (notify, { turnId }) => {
    if (options.usage) notify("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 120, outputTokens: 7, totalTokens: 127 }, modelContextWindow: 1000 } });
    if (options.notification !== false) notify("error", { error, willRetry: false });
    notify("turn/completed", { turn: { id: turnId, status: "failed", error, items: [] } });
  };
}

function boot() {
  const child = new FakeChild();
  const adapter = new CodexAppServerAdapter("codex", process.cwd(), undefined, () => child as never);
  const send = async (sessionId: string, text = "ORIGINAL PROJECT REQUEST") => {
    const events: EngineStreamEvent[] = [];
    try {
      const response = await adapter.sendUserMessage(sessionId, { text, files: [], onEngineEvent: (event) => { events.push(event); } });
      return { response, events, error: undefined as unknown };
    } catch (error) {
      return { response: undefined, events, error };
    }
  };
  return { adapter, child, send };
}

function expectReceipt(error: unknown, expected: Record<string, unknown>) {
  expect(error).toBeInstanceOf(EngineRetryableError);
  expect((error as EngineRetryableError).retry).toMatchObject(expected);
  return error as EngineRetryableError;
}

const yieldedCommand: TurnScript = (notify, { turnId }) => {
  notify("item/started", { item: { type: "commandExecution", id: "cmd-yielded", command: "long build", status: "inProgress", processId: "73941" } });
  notify("item/commandExecution/outputDelta", { itemId: "cmd-yielded", delta: "original command log\n" });
  notify("turn/completed", { turn: { id: turnId, status: "failed", error: capacity, items: [] } });
};
const terminalCommand = (status = "completed", exitCode = 0) => ({ type: "commandExecution", id: "cmd-yielded", status, exitCode, durationMs: 973375 });

describe("Codex yielded command recovery", () => {
  it("the actual adapter and shared bridge wait, reconcile, then send only one continuation", async () => {
    const { adapter, child } = boot(); child.starts.push({ turn: yieldedCommand });
    child.starts.push({ turn: (notify, { turnId }) => notify("turn/completed", { turn: { id: turnId, status: "completed", items: [{ type: "agentMessage", id: "m", text: "finished" }] } }) });
    let firstRead!: () => void, retryWaiting!: () => void;
    const readStarted = new Promise<void>(resolve => { firstRead = resolve; });
    const backoff = new Promise<void>(resolve => { retryWaiting = resolve; });
    let reads = 0;
    child.readItems = frame => { reads++; child.send({ id: frame.id, result: { data: reads === 1 ? [] : [{ turnId: "turn-1", item: terminalCommand() }] } }); firstRead(); };
    const bridge = new Bridge({ load: vi.fn().mockResolvedValue({ policy: "allowlist", allowlist: [84], pairedUsers: [], pendingPairs: [] }), issuePairingCode: vi.fn() },
      { getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "thread-existing" }), bindSession: vi.fn().mockResolvedValue(undefined) }, adapter);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const events: EngineStreamEvent[] = [];
      const result = bridge.handleAuthorizedMessage({ chatId: 84, userId: 42, chatType: "private", conversationKey: "recovery-integration", text: "ORIGINAL", files: [], locale: "zh",
        onEngineEvent: event => { events.push(event); if (event.type === "engine_retry" && event.status === "waiting") retryWaiting(); } });
      await readStarted; await new Promise(resolve => setImmediate(resolve));
      expect(child.frames.filter(frame => frame.method === "turn/start")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_000); await backoff;
      await vi.advanceTimersByTimeAsync(3_000); await result;
      const starts = child.frames.filter(frame => frame.method === "turn/start");
      expect(starts).toHaveLength(2); expect(starts[1].params?.threadId).toBe("thread-existing");
      expect(JSON.stringify(starts[1].params?.input)).toContain(ENGINE_RECOVERY_CONTINUATION);
      expect(JSON.stringify(starts[1].params?.input)).not.toContain("ORIGINAL");
      expect(events.filter(event => event.type === "tool_result")).toHaveLength(1);
      expect(events.some(event => event.type === "tool_progress" && event.text.includes("随后自动继续"))).toBe(true);
    } finally { adapter.destroy(); vi.useRealTimers(); }
  });
  it("pins the native owner and reads only the exact failed turn and command, publishing one truthful result", async () => {
    const { adapter, child, send } = boot(); child.starts.push({ turn: yieldedCommand });
    child.readItems = frame => child.send({ id: frame.id, result: { data: [{ turnId: "turn-1", item: terminalCommand() }] } });
    const result = await send("thread-existing"), failure = expectReceipt(result.error, { mode: "continue" });
    const idle = () => (adapter as unknown as { isIdle(): boolean }).isIdle();
    expect(idle()).toBe(false);
    const methods = child.frames.length;
    await failure.retry.reconcileTools!(["cmd-yielded"]);
    expect(child.frames.slice(methods)).toEqual([expect.objectContaining({ method: "thread/items/read", params: { threadId: "thread-existing", turnId: "turn-1", itemIds: ["cmd-yielded"] } })]);
    expect(result.events.filter(event => event.type === "tool_result")).toEqual([expect.objectContaining({ toolUseId: "cmd-yielded", toolName: "Bash", exitCode: 0, durationMs: 973375, output: undefined, isError: false })]);
    const record = createRunRecord(); for (const event of result.events) recordRunEvent(record, event);
    const command = record.entries.find(entry => entry.callId === "cmd-yielded");
    expect(command?.status).toBe("done"); expect(command?.output).toContain("original command log");
    expect(command?.output).toMatch(/Confirmed command status: completed; exit code 0\.$/);
    expect(idle()).toBe(true);
    await failure.retry.reconcileTools!(["cmd-yielded"]);
    expect(result.events.filter(event => event.type === "tool_result")).toHaveLength(1);
    adapter.destroy();
  });
  it.each(["completed", "failed", "declined"])("uses authoritative terminal summary %s without another read", async status => {
    const { adapter, child, send } = boot();
    child.starts.push({ turn: (notify, { turnId }) => {
      notify("item/started", { item: { ...terminalCommand(), status: "inProgress" } });
      notify("turn/completed", { turn: { id: turnId, status: "failed", error: capacity, items: [terminalCommand(status, status === "failed" ? 2 : 0)] } });
    } });
    const result = await send("thread-existing"), failure = expectReceipt(result.error, { mode: "continue" });
    await failure.retry.reconcileTools!(["cmd-yielded"]);
    expect(child.frames.some(frame => frame.method === "thread/items/read")).toBe(false);
    expect(result.events.filter(event => event.type === "tool_result")).toEqual([expect.objectContaining({ toolUseId: "cmd-yielded", isError: status !== "completed" })]);
    adapter.destroy();
  });
  it("does not route old completion notifications into a continuation waiting for its own turn ID", async () => {
    const { adapter, child, send } = boot(); child.starts.push({ turn: yieldedCommand });
    child.readItems = frame => child.send({ id: frame.id, result: { data: [{ turnId: "turn-1", item: terminalCommand() }] } });
    const first = await send("thread-existing"), failure = expectReceipt(first.error, { mode: "continue" });
    await failure.retry.reconcileTools!(["cmd-yielded"]);
    child.beforeStartReply = threadId => {
      child.beforeStartReply = undefined;
      child.send({ method: "item/completed", params: { threadId, turnId: "turn-1", item: terminalCommand() } });
      child.send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed", items: [{ type: "agentMessage", id: "old", text: "stale answer" }] } } });
    };
    child.starts.push({ turn: (notify, { turnId }) => notify("turn/completed", { turn: { id: turnId, status: "completed", items: [{ type: "agentMessage", id: "new", text: "continued safely" }] } }) });
    const second = await send("thread-existing", "continue");
    expect(second.response?.text).toBe("continued safely");
    expect(second.events.filter(event => event.type === "tool_result")).toHaveLength(0);
    expect(first.events.filter(event => event.type === "tool_result")).toHaveLength(1);
    adapter.destroy();
  });
  it("cannot release an unowned item or a wrong-turn read as completed", async () => {
    const { adapter, child, send } = boot(); child.starts.push({ turn: yieldedCommand });
    child.readItems = frame => child.send({ id: frame.id, result: { data: [{ turnId: "other-turn", item: terminalCommand() }] } });
    const result = await send("thread-existing"), failure = expectReceipt(result.error, { mode: "continue" });
    await failure.retry.reconcileTools!(["cmd-yielded"]);
    expect(result.events.filter(event => event.type === "tool_result")).toHaveLength(0);
    adapter.destroy();
  });
  it("cancels a pending read immediately and ignores its late result, retaining command uncertainty", async () => {
    const { adapter, child, send } = boot(); child.starts.push({ turn: yieldedCommand });
    let readFrame!: Frame; let readStarted!: () => void;
    const started = new Promise<void>(resolve => { readStarted = resolve; });
    child.readItems = frame => { readFrame = frame; readStarted(); };
    const result = await send("thread-existing"), failure = expectReceipt(result.error, { mode: "continue" }), controller = new AbortController();
    const waiting = failure.retry.reconcileTools!(["cmd-yielded"], controller.signal);
    const checked = expect(waiting).rejects.toMatchObject({ name: "EngineCancellationUnconfirmedError" });
    await started; controller.abort(); await checked;
    child.send({ id: readFrame.id, result: { data: [{ turnId: "turn-1", item: terminalCommand() }] } });
    await new Promise(resolve => setImmediate(resolve));
    expect(result.events.filter(event => event.type === "tool_result")).toHaveLength(0);
    expect((adapter as unknown as { isIdle(): boolean }).isIdle()).toBe(true);
    adapter.destroy();
  });
  it("release without reconciliation frees a rejected receipt and cannot be reused later", async () => {
    const { adapter, child, send } = boot(); child.starts.push({ turn: yieldedCommand });
    const result = await send("thread-existing"), failure = expectReceipt(result.error, { mode: "continue" });
    failure.retry.releaseTools!(); await failure.retry.reconcileTools!(["cmd-yielded"]);
    expect((adapter as unknown as { isIdle(): boolean }).isIdle()).toBe(true);
    expect(child.frames.some(frame => frame.method === "thread/items/read")).toBe(false);
    expect(result.events.filter(event => event.type === "tool_result")).toHaveLength(0);
    adapter.destroy();
  });
  it("late successful-turn answer and usage cannot contaminate the following turn", async () => {
    const { adapter, child, send } = boot();
    const success: TurnScript = (notify, { turnId }) => {
      notify("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 10, outputTokens: 2 }, modelContextWindow: 100000 } });
      notify("turn/completed", { turn: { id: turnId, status: "completed", items: [{ type: "agentMessage", id: "m", text: turnId }] } });
    };
    child.starts.push({ turn: success }, { turn: success });
    const first = await send("thread-existing");
    child.beforeStartReply = threadId => {
      child.beforeStartReply = undefined;
      child.send({ method: "item/completed", params: { threadId, turnId: "turn-1", item: { type: "agentMessage", id: "late", text: "wrong answer" } } });
      child.send({ method: "thread/tokenUsage/updated", params: { threadId, turnId: "turn-1", tokenUsage: { last: { inputTokens: 9000, outputTokens: 9000 }, modelContextWindow: 100000 } } });
    };
    const second = await send("thread-existing");
    expect(first.response).toMatchObject({ text: "turn-1", usage: { inputTokens: 10, outputTokens: 2 } });
    expect(second.response).toMatchObject({ text: "turn-2", usage: { inputTokens: 10, outputTokens: 2 } });
    expect(second.events.some(event => event.type === "assistant_text" && event.text.includes("wrong"))).toBe(false);
    adapter.destroy();
  });
});

describe("Codex native transient retry receipts", () => {
  it("marks the observed serverOverloaded turn/completed failure as continue on the event-bound thread", async () => {
    const { adapter, child, send } = boot();
    child.starts.push({ turn: failTurn(capacity, { usage: true }) });
    const first = await send("tarobot-101");
    const sessions = first.events.filter((event) => event.type === "session").map((event) => (event as { sessionId?: string }).sessionId);
    expect(sessions).toEqual(["thr-1"]);
    const error = expectReceipt(first.error, {
      sessionId: "thr-1",
      mode: "continue",
      reason: "capacity",
      usage: { inputTokens: 120, outputTokens: 7 },
    });
    // The user-visible message is unchanged; only the typed receipt is new.
    expect(error.message).toContain("Selected model is at capacity. Please try a different model.\nCodex error code: serverOverloaded");
    expect(error.cause).toBeInstanceOf(Error);

    // Recovery addressed to the receipt's native thread continues that thread;
    // the logical id would have created a replacement thread instead.
    child.starts.push({ turn: (notify, { turnId }) => notify("turn/completed", { turn: { id: turnId, status: "completed", items: [{ type: "agentMessage", id: "m", text: "continued" }] } }) });
    const before = child.frames.length;
    const resumed = await send(error.retry.sessionId, "continue");
    expect(resumed.response?.text).toBe("continued");
    expect(child.frames.slice(before).map((frame) => frame.method)).toEqual(["turn/start"]);
    expect(child.frames.at(-1)?.params?.threadId).toBe("thr-1");
    adapter.destroy();
  });

  it("never offers input replay after tools or answer text already ran", async () => {
    const { adapter, child, send } = boot();
    child.starts.push({
      turn: (notify, ids, fake) => {
        notify("item/started", { item: { type: "commandExecution", id: "cmd-1", command: "touch out.txt", status: "inProgress" } });
        notify("item/completed", { item: { type: "commandExecution", id: "cmd-1", command: "touch out.txt", status: "completed", exitCode: 0, aggregatedOutput: "" } });
        notify("item/agentMessage/delta", { itemId: "msg-1", delta: "Working" });
        failTurn(capacity)(notify, ids, fake);
      },
    });
    const result = await send("thread-existing");
    expect(result.events.map((event) => event.type)).toEqual(expect.arrayContaining(["tool_use", "assistant_text"]));
    expectReceipt(result.error, { sessionId: "thread-existing", mode: "continue", reason: "capacity" });
    adapter.destroy();
  });

  it("covers stream retries exhausted after native willRetry reconnects", async () => {
    const { adapter, child, send } = boot();
    const exhausted = { message: "stream disconnected before completion: error sending request", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } };
    child.starts.push({
      turn: (notify, { turnId }) => {
        for (const attempt of [1, 2, 3, 4, 5]) notify("error", { error: { message: `Reconnecting... ${attempt}/5`, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } }, willRetry: true });
        notify("error", { error: exhausted, willRetry: false });
        notify("turn/completed", { turn: { id: turnId, status: "failed", error: exhausted, items: [] } });
      },
    });
    child.starts.push({ turn: failTurn({ message: "exceeded retry limit, last status: 503 Service Unavailable", codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 503 } } }) });
    expectReceipt((await send("thread-a")).error, { sessionId: "thread-a", mode: "continue", reason: "connection" });
    expectReceipt((await send("thread-a")).error, { mode: "continue", reason: "connection" });
    adapter.destroy();
  });

  it.each([
    ["usage quota", { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" }],
    ["session budget", { message: "Session budget exceeded.", codexErrorInfo: "sessionBudgetExceeded" }],
    ["authentication", { message: "unexpected status 401 Unauthorized", codexErrorInfo: "unauthorized" }],
    ["context window", { message: "Codex ran out of room in the model's context window.", codexErrorInfo: "contextWindowExceeded" }],
    ["policy", { message: "This request was blocked.", codexErrorInfo: "cyberPolicy" }],
    ["bad request", { message: "Invalid request.", codexErrorInfo: "badRequest" }],
    ["client HTTP status", { message: "unexpected status 400 Bad Request", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 400 } } }],
    ["flex tier", { message: "Flex processing is unavailable.", codexErrorInfo: "flexUnavailable" }],
    ["future code", { message: "Selected model is at capacity.", codexErrorInfo: "somethingNew" }],
  ])("keeps %s failures fatal even when the text looks transient", async (_label, error) => {
    const { adapter, child, send } = boot();
    child.starts.push({ turn: failTurn(error) });
    const result = await send("thread-b");
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error).not.toBeInstanceOf(EngineRetryableError);
    adapter.destroy();
  });

  it("ignores reconnect lines in stderr diagnostics and non-final notifications", async () => {
    const { adapter, child, send } = boot();
    child.starts.push({
      turn: (notify, { turnId }, fake) => {
        fake.stderr.emitData("Reconnecting... 2/5 (stream disconnected before completion)\n");
        notify("turn/completed", { turn: { id: turnId, status: "failed", error: { message: "Codex ran out of room in the model's context window.", codexErrorInfo: "contextWindowExceeded" }, items: [] } });
      },
    });
    child.starts.push({
      turn: (notify, { turnId }) => {
        notify("error", { error: { message: "Reconnecting... 3/5", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } }, willRetry: true });
        notify("turn/completed", { turn: { id: turnId, status: "failed", items: [] } });
      },
    });
    child.starts.push({ turn: (notify, { turnId }) => notify("turn/completed", { turn: { id: turnId, status: "failed", items: [] } }) });
    for (let index = 0; index < 3; index++) {
      const result = await send("thread-c");
      expect(result.error).not.toBeInstanceOf(EngineRetryableError);
      expect(result.error).toBeInstanceOf(Error);
    }
    adapter.destroy();
  });

  it("uses only the provider message when an older Codex omits codexErrorInfo", async () => {
    const { adapter, child, send } = boot();
    child.starts.push({ turn: failTurn({ message: "stream disconnected before completion: error sending request for url" }) });
    child.starts.push({ turn: failTurn({ message: "Codex ran out of room in the model's context window." }) });
    expectReceipt((await send("thread-d")).error, { mode: "continue", reason: "connection" });
    expect((await send("thread-d")).error).not.toBeInstanceOf(EngineRetryableError);
    adapter.destroy();
  });

  it("does not resume interrupted turns that carry a transient error", async () => {
    const { adapter, child, send } = boot();
    child.starts.push({ turn: (notify, { turnId }) => notify("turn/completed", { turn: { id: turnId, status: "interrupted", error: capacity, items: [] } }) });
    const result = await send("thread-e");
    expect(result.error).not.toBeInstanceOf(EngineRetryableError);
    adapter.destroy();
  });

  it("does not infer safe input replay from a turn/start JSON-RPC error without a terminal receipt", async () => {
    const { adapter, child, send } = boot();
    child.starts.push({ error: { code: -32001, message: "Server overloaded", data: { codexErrorInfo: "serverOverloaded" } } });
    child.starts.push({ error: { code: -32001, message: "Selected model is at capacity. Please try a different model." } });
    child.starts.push({ error: { code: -32600, message: "thread not loaded", data: { codexErrorInfo: "badRequest" } } });
    child.starts.push({ error: { code: -32603, message: "internal error" } });
    const structured = await send("tarobot-202");
    expect(structured.events.filter((event) => event.type === "session")).toEqual([{ type: "session", sessionId: "thr-1" }]);
    expect(structured.error).not.toBeInstanceOf(EngineRetryableError);
    expect((await send("thr-1")).error).not.toBeInstanceOf(EngineRetryableError);
    expect((await send("thr-1")).error).not.toBeInstanceOf(EngineRetryableError);
    expect((await send("thr-1")).error).not.toBeInstanceOf(EngineRetryableError);
    adapter.destroy();
  });

  it.each([false, true])("never replays a turn/start JSON-RPC error that follows turn/started (execution event: %s)", async (withExecution) => {
    const { adapter, child, send } = boot();
    child.starts.push({ startedThenError: { code: -32001, message: "Server overloaded", data: { codexErrorInfo: "serverOverloaded" } }, withExecution });
    const result = await send("thread-h");
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error).not.toBeInstanceOf(EngineRetryableError);
    if (withExecution) expect(result.events.map((event) => event.type)).toContain("tool_use");
    // The adapter itself never re-sends the request either.
    expect(child.frames.filter((frame) => frame.method === "turn/start")).toHaveLength(1);
    // The turn that turn/started announced is interrupted, not left running.
    await new Promise((resolve) => setImmediate(resolve));
    expect(child.frames.filter((frame) => frame.method === "turn/interrupt").map((frame) => frame.params)).toEqual([{ threadId: "thread-h", turnId: "turn-1" }]);
    adapter.destroy();
  });

  it("gives no receipt when the app-server exits before or during a turn", async () => {
    const { adapter, child, send } = boot();
    child.starts.push({ turn: (_notify, _ids, fake) => { setTimeout(() => fake.emit("close", 1), 5); } });
    const result = await send("thread-f");
    expect(String((result.error as Error).message)).toContain("codex app-server exited with code 1");
    expect(result.error).not.toBeInstanceOf(EngineRetryableError);
    adapter.destroy();
  });

  it("gives no receipt to a user stop", async () => {
    const { adapter, child } = boot();
    const controller = new AbortController();
    child.starts.push({ turn: () => { setTimeout(() => controller.abort(), 5); } });
    const error = await adapter.sendUserMessage("thread-g", { text: "work", files: [], abortSignal: controller.signal }).catch((reason: unknown) => reason);
    expect(String((error as Error).message)).toContain("aborted");
    expect(error).not.toBeInstanceOf(EngineRetryableError);
    adapter.destroy();
  });
});

describe("Codex live child agent guard", () => {
  // Frame shapes recorded from the real Codex 0.163 app-server (isolated probe):
  // the spawn call completes immediately with agentsStates=pendingInit while the
  // child thread keeps running and executing commands after the parent fails.
  const PARENT = "thread-parent";
  type Call = { tool: string; status: string; receivers?: string[]; states?: Record<string, string>; id?: string };
  const collab = ({ tool, status, receivers = [], states = {}, id = `call_${tool}` }: Call) => ({
    type: "collabAgentToolCall", id, tool, status, senderThreadId: PARENT, receiverThreadIds: receivers,
    prompt: tool === "spawnAgent" ? "create two step files" : null, model: null, reasoningEffort: null,
    agentsStates: Object.fromEntries(Object.entries(states).map(([agent, state]) => [agent, { status: state, message: null }])),
  });
  type Step = { item?: ["started" | "completed", Call]; child?: ["started" | "completed", string, string?]; summary?: Call[] };
  const scripted = (steps: Step[]): TurnScript => (notify, { turnId }, fake) => {
    let summary: unknown[] = [];
    for (const step of steps) {
      if (step.item) notify(`item/${step.item[0]}`, { item: collab(step.item[1]) });
      if (step.child) {
        const [phase, childTurn, thread = "child-1"] = step.child;
        fake.send({ method: `turn/${phase}`, params: { threadId: thread, turn: { id: childTurn, status: phase === "started" ? "inProgress" : "completed", items: [] } } });
      }
      if (step.summary) summary = step.summary.map(collab);
    }
    notify("error", { error: capacity, willRetry: false });
    notify("turn/completed", { turn: { id: turnId, status: "failed", error: capacity, items: summary } });
  };
  const spawnStarted: Step = { item: ["started", { tool: "spawnAgent", status: "inProgress" }] };
  const spawnCompleted: Step = { item: ["completed", { tool: "spawnAgent", status: "completed", receivers: ["child-1"], states: { "child-1": "pendingInit" } }] };
  const run = async (steps: Step[]) => {
    const { adapter, child, send } = boot();
    child.starts.push({ turn: scripted(steps) });
    const result = await send(PARENT);
    adapter.destroy();
    return result;
  };
  // The typed receipt keeps the native context and failed usage for the host,
  // but marks child work as unfinished so no continuation is attempted.
  const blocked = (error: unknown) => {
    expectReceipt(error, { sessionId: PARENT, mode: "continue", reason: "capacity", unfinishedWork: true });
    expect(String((error as Error).message)).not.toContain("child-1");
  };
  const released = (error: unknown) => {
    expectReceipt(error, { sessionId: PARENT, mode: "continue", reason: "capacity" });
    expect((error as EngineRetryableError).retry.unfinishedWork).toBeUndefined();
  };

  it("withholds recovery when the spawn call completed but the child is still running", async () => {
    blocked((await run([spawnStarted, spawnCompleted, { child: ["started", "child-turn-1"] }])).error);
  });

  it("continues once the child's own turn reached a terminal state", async () => {
    released((await run([spawnStarted, spawnCompleted, { child: ["started", "child-turn-1"] }, { child: ["completed", "child-turn-1"] }])).error);
  });

  it("continues after an explicit terminal agent state reported by a later wait", async () => {
    released((await run([spawnStarted, spawnCompleted,
      { item: ["started", { tool: "wait", status: "inProgress", receivers: ["child-1"] }] },
      { item: ["completed", { tool: "wait", status: "completed", receivers: ["child-1"], states: { "child-1": "completed" } }] }])).error);
  });

  it("stays blocked when a wait still reports the child running", async () => {
    blocked((await run([spawnStarted, spawnCompleted,
      { item: ["completed", { tool: "wait", status: "completed", receivers: ["child-1"], states: { "child-1": "running" } }] }])).error);
  });

  it("does not let an earlier child turn release work resumed by a later sendInput", async () => {
    const relaunch: Step[] = [
      { item: ["started", { tool: "sendInput", status: "inProgress", receivers: ["child-1"], states: { "child-1": "completed" } }] },
      { item: ["completed", { tool: "sendInput", status: "completed", receivers: ["child-1"], states: { "child-1": "completed" } }] },
    ];
    blocked((await run([spawnStarted, spawnCompleted, { child: ["started", "child-turn-1"] }, { child: ["completed", "child-turn-1"] }, ...relaunch])).error);
    // A late completion of the old child turn arriving after the relaunch does not release it either.
    blocked((await run([spawnStarted, spawnCompleted, { child: ["started", "child-turn-1"] }, ...relaunch, { child: ["completed", "child-turn-1"] }])).error);
    // A completion for a child turn that was never seen starting after the relaunch does not count.
    blocked((await run([spawnStarted, spawnCompleted, ...relaunch, { child: ["completed", "child-turn-9"] }])).error);
  });

  it("re-blocks when a released child starts a new turn", async () => {
    const firstTurnDone: Step[] = [spawnStarted, spawnCompleted, { child: ["started", "child-turn-1"] }, { child: ["completed", "child-turn-1"] }];
    blocked((await run([...firstTurnDone, { child: ["started", "child-turn-2"] }])).error);
    blocked((await run([...firstTurnDone, { child: ["started", "child-turn-2"] }, { child: ["completed", "child-turn-1"] }])).error);
    released((await run([...firstTurnDone, { child: ["started", "child-turn-2"] }, { child: ["completed", "child-turn-2"] }])).error);
  });

  it("re-blocks on a later non-terminal wait report, which an older child turn cannot release", async () => {
    const waitRunning: Step = { item: ["completed", { tool: "wait", status: "completed", receivers: ["child-1"], states: { "child-1": "running" }, id: "call_wait_running" }] };
    const listPending: Step = { item: ["completed", { tool: "listAgents", status: "completed", states: { "child-1": "pendingInit" }, id: "call_list" }] };
    blocked((await run([spawnStarted, spawnCompleted, { child: ["started", "child-turn-1"] }, { child: ["completed", "child-turn-1"] }, waitRunning])).error);
    blocked((await run([spawnStarted, spawnCompleted, { child: ["started", "child-turn-1"] }, { child: ["completed", "child-turn-1"] }, listPending])).error);
    blocked((await run([spawnStarted, spawnCompleted, { child: ["started", "child-turn-1"] }, waitRunning, { child: ["completed", "child-turn-1"] }])).error);
    released((await run([spawnStarted, spawnCompleted, waitRunning, { child: ["started", "child-turn-2"] }, { child: ["completed", "child-turn-2"] }])).error);
  });

  it("attributes a child that starts before its spawn call reports completion", async () => {
    released((await run([spawnStarted, { child: ["started", "child-turn-1"] }, { child: ["completed", "child-turn-1"] }, spawnCompleted])).error);
    blocked((await run([spawnStarted, { child: ["started", "child-turn-1"] }, spawnCompleted])).error);
  });

  it("stays blocked while a launch is in flight or its child cannot be attributed", async () => {
    blocked((await run([spawnStarted])).error);
    blocked((await run([spawnStarted, { item: ["completed", { tool: "spawnAgent", status: "completed" }] }])).error);
    blocked((await run([{ item: ["completed", { tool: "followupTask", status: "completed", receivers: ["child-1"] }] }])).error);
    blocked((await run([{ item: ["completed", { tool: "futureCollabTool", status: "completed", receivers: ["child-1"] }] }])).error);
  });

  it("treats a failed spawn without a receiver as having started nothing", async () => {
    released((await run([spawnStarted, { item: ["completed", { tool: "spawnAgent", status: "failed" }] }])).error);
  });

  it("counts a launch seen only in the terminal summary, but never releases from it", async () => {
    blocked((await run([{ summary: [{ tool: "spawnAgent", status: "completed", receivers: ["child-1"], states: { "child-1": "pendingInit" } }] }])).error);
    blocked((await run([spawnStarted, spawnCompleted, { summary: [{ tool: "wait", status: "completed", receivers: ["child-1"], states: { "child-1": "completed" }, id: "call_summary_wait" }] }])).error);
  });

  it("keeps a non-transient failure on the plain error path even with live child work", async () => {
    const { adapter, child, send } = boot();
    child.starts.push({ turn: (notify, { turnId }) => {
      notify("item/completed", { item: collab({ tool: "spawnAgent", status: "completed", receivers: ["child-1"], states: { "child-1": "pendingInit" } }) });
      const quota = { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" };
      notify("turn/completed", { turn: { id: turnId, status: "failed", error: quota, items: [] } });
    } });
    const { error } = await send(PARENT);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(EngineRetryableError);
    adapter.destroy();
  });

  it("leaves an ordinary transient failure without collab calls recoverable", async () => {
    released((await run([{ child: ["started", "unrelated-turn", "other-thread"] }])).error);
  });
});

describe("codexTransientRetryReason", () => {
  it.each([
    ["serverOverloaded", "capacity"],
    ["rateLimitExceeded", "rate-limit"],
    ["internalServerError", "connection"],
    [{ httpConnectionFailed: { httpStatusCode: null } }, "connection"],
    [{ httpConnectionFailed: {} }, "connection"],
    [{ responseStreamConnectionFailed: { httpStatusCode: 502 } }, "connection"],
    [{ responseStreamDisconnected: { httpStatusCode: 529 } }, "capacity"],
    [{ responseTooManyFailedAttempts: { httpStatusCode: 429 } }, "rate-limit"],
    [{ httpConnectionFailed: { httpStatusCode: 401 } }, undefined],
    [{ httpConnectionFailed: { httpStatusCode: 413 } }, undefined],
    [{ activeTurnNotSteerable: { turnKind: "review" } }, undefined],
    [{ httpConnectionFailed: { httpStatusCode: 503 }, extra: true }, undefined],
    ["usageLimitExceeded", undefined],
    ["unauthorized", undefined],
    ["other", undefined],
    [null, undefined],
  ])("maps %j to %s", (info, expected) => {
    expect(codexTransientRetryReason(info)).toBe(expected);
  });
});
