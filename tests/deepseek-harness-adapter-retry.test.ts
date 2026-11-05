import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { EngineStreamEvent } from "../src/codex/adapter.js";
import { DeepSeekHarnessAdapter, deepseekTransientRetryReason, type DeepSeekHarnessGateway } from "../src/codex/deepseek-harness-adapter.js";
import type { DeepSeekHarnessProtocolHandlers, DeepSeekHarnessServerRequest } from "../src/codex/deepseek-harness-protocol.js";
import { EngineRetryableError } from "../src/codex/turn-retry.js";

/** Minimal Harness gateway: the same request and mux surface as the main suite. */
class FakeGateway extends EventEmitter implements DeepSeekHarnessGateway {
  readonly calls: Array<{ method: string; payload: any }> = [];
  readonly responses = new Map<string, unknown>([
    ["session.create", (payload: any) => ({ sessionId: payload.sessionId, agentPreset: "standard" })],
    ["session.prompt", { accepted: true }],
    ["commands/execute", { commandId: "command-1", result: { kind: "success", text: "ok" } }],
    ["session.cancel", { accepted: true }],
    ["native.cancelPrompt", { outcome: "cancelled" }],
    ["session.list", { items: [] }],
    ["session.history", { events: [], hasMore: false, projections: { asOfSeq: -1, values: { tarocubGoalUsage: { goalId: null, tokensUsed: 0 } } } }],
    ["session.models", { current: { provider: "deepseek-official", model: "deepseek-v4-flash" }, routable: true, groups: [], failures: [] }],
    ["session.selectModel", (payload: unknown) => ({ selected: payload })],
    ["goal.clear", { cleared: true }],
  ]);
  handlers: DeepSeekHarnessProtocolHandlers | undefined;
  async connect(handlers: DeepSeekHarnessProtocolHandlers): Promise<void> { this.handlers = handlers; }
  async request(method: string, payload: unknown): Promise<unknown> {
    this.calls.push({ method, payload });
    const response = this.responses.get(method);
    return typeof response === "function" ? await (response as (input: unknown) => unknown)(payload) : response;
  }
  async respond(): Promise<{ accepted: boolean }> { return { accepted: true }; }
  async respondError(): Promise<{ accepted: boolean }> { return { accepted: true }; }
  async close(): Promise<void> {}
  async pauseGoalForBudget(input: any) { return await this.request("native.pauseGoalForBudget", input) as any; }
  async steerPrompt(input: any) { return await this.request("native.steerPrompt", input) as any; }
  async cancelPrompt(sessionId: string, sourceRpcId: string) { return await this.request("native.cancelPrompt", { sessionId, sourceRpcId }) as any; }
  lastPromptId(sessionId: string): string | undefined {
    return this.calls.filter((call) => call.method === "session.prompt" && call.payload.sessionId === sessionId && call.payload.mode === "queue").at(-1)?.payload.requestId;
  }
  emit2(sessionId: string, type: string, data: Record<string, unknown>, seq?: number): Promise<void> {
    const frame: DeepSeekHarnessServerRequest = {
      type: "server-request", rpcId: `rpc-${Math.random()}`, method: "session/event",
      payload: { type: "session/event", sessionId, event: { type, ...(seq === undefined ? {} : { seq }), time: Date.now(), data } } as DeepSeekHarnessServerRequest["payload"],
    };
    return Promise.resolve(this.handlers?.onMuxFrame(frame));
  }
  /** turn/start plus the durable user/message proving this prompt's admission. */
  async admit(sessionId: string, turn: number, seq: number, ownInput = true): Promise<void> {
    await this.emit2(sessionId, "turn/start", { turn }, seq);
    if (ownInput) await this.emit2(sessionId, "user/message", { source: { kind: "user", rpcId: this.lastPromptId(sessionId) } });
  }
}

function boot() {
  const gateway = new FakeGateway();
  const adapter = new DeepSeekHarnessAdapter({
    gateway, workspacePath: "/workspace", clientTimeZone: "Asia/Shanghai", permissionPreset: "workspace-write",
    turnSettleDelayMs: 1, backgroundReviewGraceMs: 50,
  });
  const start = (sessionId: string, text = "ORIGINAL PROJECT REQUEST") => {
    const events: EngineStreamEvent[] = [];
    const result = adapter.sendUserMessage(sessionId, { text, files: [], onEngineEvent: (event) => { events.push(event); } })
      .then((response) => ({ response, error: undefined as unknown }), (error: unknown) => ({ response: undefined, error }));
    return { events, result };
  };
  const prompted = (count: number) => vi.waitFor(() => expect(gateway.calls.filter((call) => call.method === "session.prompt")).toHaveLength(count));
  return { adapter, gateway, start, prompted };
}

const serverBusy = { message: "Service is too busy", code: "SERVER", status: 503, providerRetryAfterMs: 4_000 };

describe("DeepSeek Harness native transient retry receipts", () => {
  it("continues the same native session after an admitted turn ends with a structured SERVER failure", async () => {
    const { adapter, gateway, start, prompted } = boot();
    const { sessionId } = await adapter.createSession(41);
    const turn = start(sessionId);
    await prompted(1);
    await gateway.admit(sessionId, 1, 1);
    await gateway.emit2(sessionId, "assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "Partial" }] }, usage: { inputTokens: 30, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 } }, 2);
    await gateway.emit2(sessionId, "turn/end", { turn: 1, reason: { kind: "error", error: serverBusy } }, 3);
    const { error } = await turn.result;
    expect(turn.events.filter((event) => event.type === "session")).toEqual([{ type: "session", sessionId }]);
    expect(error).toBeInstanceOf(EngineRetryableError);
    expect((error as EngineRetryableError).retry).toMatchObject({ sessionId, mode: "continue", reason: "capacity", retryAfterMs: 4_000 });
    expect((error as Error).message).toBe("Service is too busy");

    // The continuation is an ordinary queued prompt on that same session.
    const resumed = start((error as EngineRetryableError).retry.sessionId, "continue");
    await prompted(2);
    expect(gateway.calls.filter((call) => call.method === "session.prompt").at(-1)?.payload.sessionId).toBe(sessionId);
    await gateway.admit(sessionId, 2, 10);
    await gateway.emit2(sessionId, "assistant/chunk", { turn: 2, step: 1, chunk: { type: "text-delta", index: 0, text: "done" } }, 11);
    await gateway.emit2(sessionId, "turn/end", { turn: 2, reason: { kind: "completed" } }, 12);
    expect((await resumed.result).response?.text).toBe("done");
    await adapter.destroy();
  });

  it.each([
    ["quota", { message: "Insufficient balance", code: "QUOTA" }],
    ["account quota", { message: "Account quota exhausted", code: "ACCOUNT_QUOTA" }],
    ["credential", { message: "Invalid API key", code: "INVALID_CREDENTIAL" }],
    ["context", { message: "Context window exceeded", code: "CONTEXT_WINDOW_EXCEEDED" }],
    ["empty response", { message: "Empty response", code: "EMPTY_RESPONSE" }],
    ["unknown", { message: "503 Service Unavailable, server overloaded", code: "UNKNOWN" }],
  ])("keeps %s failures fatal", async (_label, failure) => {
    const { adapter, gateway, start, prompted } = boot();
    const { sessionId } = await adapter.createSession(42);
    const turn = start(sessionId);
    await prompted(1);
    await gateway.admit(sessionId, 1, 1);
    await gateway.emit2(sessionId, "turn/end", { turn: 1, reason: { kind: "error", error: failure } }, 2);
    const { error } = await turn.result;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(EngineRetryableError);
    await adapter.destroy();
  });

  it("withholds the receipt while a tool call has no result", async () => {
    const { adapter, gateway, start, prompted } = boot();
    const { sessionId } = await adapter.createSession(43);
    const turn = start(sessionId);
    await prompted(1);
    await gateway.admit(sessionId, 1, 1);
    await gateway.emit2(sessionId, "tool/call", { turn: 1, step: 1, callId: "tool-1", name: "bash", arguments: "{}" }, 2);
    await gateway.emit2(sessionId, "turn/end", { turn: 1, reason: { kind: "error", error: { message: "socket hang up", code: "TRANSPORT" } } }, 3);
    expect((await turn.result).error).not.toBeInstanceOf(EngineRetryableError);
    await adapter.destroy();
  });

  it("marks a structured transport failure after completed tools as continue", async () => {
    const { adapter, gateway, start, prompted } = boot();
    const { sessionId } = await adapter.createSession(44);
    const turn = start(sessionId);
    await prompted(1);
    await gateway.admit(sessionId, 1, 1);
    await gateway.emit2(sessionId, "tool/call", { turn: 1, step: 1, callId: "tool-1", name: "bash", arguments: "{}" }, 2);
    await gateway.emit2(sessionId, "tool/result", { turn: 1, step: 1, message: { source: { callId: "tool-1" }, content: [{ type: "text", text: "ok" }] } }, 3);
    await gateway.emit2(sessionId, "turn/end", { turn: 1, reason: { kind: "error", error: { message: "socket hang up", code: "TRANSPORT" } } }, 4);
    const { error } = await turn.result;
    expect(turn.events.map((event) => event.type)).toEqual(expect.arrayContaining(["tool_use", "tool_result"]));
    expect((error as EngineRetryableError).retry).toMatchObject({ sessionId, mode: "continue", reason: "connection" });
    await adapter.destroy();
  });

  it("gives no receipt when admission of this prompt was never observed", async () => {
    const { adapter, gateway, start, prompted } = boot();
    const { sessionId } = await adapter.createSession(45);
    const turn = start(sessionId);
    await prompted(1);
    // A native agent failure ends the observation without a durable input receipt.
    await gateway.handlers?.onHostFrame({ type: "server-request", rpcId: "host-1", method: "host/agent-error", payload: { type: "host/agent-error", sessionId, error: { message: "Service is too busy", code: "SERVER" } } } as unknown as DeepSeekHarnessServerRequest);
    const settled = await Promise.race([turn.result, new Promise<{ error: unknown }>((resolve) => setTimeout(() => resolve({ error: "pending" }), 50))]);
    expect(settled.error).not.toBeInstanceOf(EngineRetryableError);
    await adapter.destroy();
  });
});

describe("deepseekTransientRetryReason", () => {
  it.each([
    [{ code: "RATE_LIMIT", status: 429 }, "rate-limit"],
    [{ code: "SERVER", status: 503 }, "capacity"],
    [{ code: "SERVER", status: 529 }, "capacity"],
    [{ code: "SERVER", status: 500 }, "connection"],
    [{ code: "SERVER" }, "connection"],
    [{ code: "TRANSPORT" }, "connection"],
    [{ code: "TIMEOUT" }, "connection"],
    [{ code: "QUOTA", status: 429 }, undefined],
    [{ code: "ACCOUNT_QUOTA" }, undefined],
    [{ code: "EMPTY_RESPONSE" }, undefined],
    [{ code: "UNKNOWN", message: "rate limit" }, undefined],
    [{}, undefined],
  ])("maps %j to %s", (failure, expected) => {
    expect(deepseekTransientRetryReason(failure)).toBe(expected);
  });
});
