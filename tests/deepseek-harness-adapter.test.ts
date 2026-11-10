import { nativeRunProbe } from "./helpers/native-run.js";
import { runEntryTitle, runDiff, runPlan } from "../client/src/run-presentation.js";
import { summarizeRun } from "../src/core/run-record.js";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  AppPlatformTools,
  EngineApprovalRequest,
  EngineStreamEvent,
} from "../src/codex/adapter.js";
import type { DeepSeekAppToolBinding } from "../src/codex/deepseek-app-tools.js";
import {
  DEEPSEEK_HARNESS_SEARCH_TOOL_NOTE,
  DEEPSEEK_SESSION_APPROVAL_GRANT_LIMIT,
  DeepSeekHarnessAdapter,
  type DeepSeekHarnessGateway,
} from "../src/codex/deepseek-harness-adapter.js";
import { appAgentInstructions, appCapabilityInstructions } from "../src/gateway/agent-instructions.js";
import {
  DeepSeekHarnessRpcError,
  type DeepSeekHarnessProtocolHandlers,
  type DeepSeekHarnessServerRequest,
} from "../src/codex/deepseek-harness-protocol.js";

type GatewayCall = { method: string; payload: unknown };
type GatewayResponse = unknown | ((payload: unknown) => unknown | Promise<unknown>);

class FakeGateway extends EventEmitter implements DeepSeekHarnessGateway {
  readonly calls: GatewayCall[] = [];
  readonly responses = new Map<string, GatewayResponse>();
  readonly clientResponses: Array<{ rpcId: string; value: unknown }> = [];
  readonly clientErrors: Array<{
    rpcId: string;
    error: { code: string; message: string; details?: unknown };
  }> = [];
  respondReceipt: { accepted: boolean; reason?: string } = { accepted: true };
  handlers: DeepSeekHarnessProtocolHandlers | undefined;
  closed = false;
  autoOrigins = true;
  autoGoalUsage = true;
  readonly goalUsage = new Map<string, { goalId: string | null; tokensUsed: number }>();
  private readonly goalSessions = new Set<string>();

  lastPromptId(sessionId: string): string | undefined {
    return (this.calls.filter((call) => call.method === "session.prompt" && (call.payload as { sessionId: string; mode: string }).sessionId === sessionId && (call.payload as { mode: string }).mode === "queue").at(-1)?.payload as { requestId?: string } | undefined)?.requestId;
  }

  constructor() {
    super();
    this.responses.set("session.create", (payload: unknown) => ({
      sessionId: (payload as { sessionId: string }).sessionId,
      agentPreset: "standard",
    }));
    this.responses.set("session.prompt", { accepted: true });
    this.responses.set("commands/execute", {
      commandId: "command-1",
      result: { kind: "success", text: "ok" },
    });
    this.responses.set("session.cancel", { accepted: true });
    this.responses.set("native.cancelPrompt", { outcome: "cancelled" });
    this.responses.set("native.steerPrompt", { outcome: "accepted" });
    this.responses.set("native.pauseGoalForBudget", (input: any) => ({ outcome: "paused", ref: { id: input.ref.id, revision: input.ref.revision + 1 } }));
    this.responses.set("session.list", { items: [] });
    this.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: { asOfSeq: -1, values: {} },
    });
    this.responses.set("session.models", {
      current: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      routable: true,
      groups: [],
      failures: [],
    });
    this.responses.set("session.selectModel", (payload: unknown) => ({ selected: payload }));
    this.responses.set("goal.create", { ref: { id: "goal-1", revision: 1 } });
    this.responses.set("goal.clear", { cleared: true });
  }

  async connect(handlers: DeepSeekHarnessProtocolHandlers): Promise<void> {
    this.handlers = handlers;
  }

  async request(method: string, payload: unknown): Promise<unknown> {
    this.calls.push({ method, payload });
    if (method === "goal.create") this.goalSessions.add((payload as { sessionId: string }).sessionId);
    if (method === "goal.clear") this.goalSessions.delete((payload as { sessionId: string }).sessionId);
    const response = this.responses.get(method);
    if (response instanceof Error) throw response;
    const result = typeof response === "function" ? await response(payload) : response;
    // Most older routing tests are unrelated to accounting. Supply an explicit
    // zero native counter unless a test provides one or disables the fixture.
    if (method === "session.history" && this.autoGoalUsage) {
      const r = result as any, values = r?.projections?.values;
      if (values && !("tarocubGoalUsage" in values)) return { ...r, projections: { ...r.projections, values: { ...values, tarocubGoalUsage: { goalId: values.goal?.goal?.id ?? null, tokensUsed: 0 } } } };
    }
    return result;
  }

  async respond(
    rpcId: string,
    value: unknown,
  ): Promise<{ accepted: boolean; reason?: string }> {
    this.clientResponses.push({ rpcId, value });
    return this.respondReceipt;
  }

  async respondError(
    rpcId: string,
    error: { code: string; message: string; details?: unknown },
  ): Promise<{ accepted: boolean; reason?: string }> {
    this.clientErrors.push({ rpcId, error });
    return this.respondReceipt;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async pauseGoalForBudget(input: import("../src/codex/deepseek-app-tools.js").DeepSeekBudgetPauseInput) {
    return await this.request("native.pauseGoalForBudget", input) as import("../src/codex/deepseek-app-tools.js").DeepSeekBudgetPause;
  }

  async steerPrompt(input: import("../src/codex/deepseek-app-tools.js").DeepSeekSteerInput) {
    return await this.request("native.steerPrompt", input) as import("../src/codex/deepseek-app-tools.js").DeepSeekPromptSteer;
  }

  async cancelPrompt(sessionId: string, sourceRpcId: string) {
    return await this.request("native.cancelPrompt", { sessionId, sourceRpcId }) as { outcome: "cancelled" };
  }

  emitMux(payload: Record<string, unknown>, rpcId = `rpc-${Math.random()}`): Promise<void> {
    const frame: DeepSeekHarnessServerRequest = {
      type: "server-request",
      rpcId,
      method: String(payload.type),
      payload: payload as DeepSeekHarnessServerRequest["payload"],
    };
    return Promise.resolve(this.handlers?.onMuxFrame(frame));
  }

  async emitSessionEvent(
    sessionId: string,
    type: string,
    data: Record<string, unknown>,
    seq: number,
  ): Promise<void> {
    const start = this.emitMux({
      type: "session/event",
      sessionId,
      event: { type, seq, time: Date.now(), data },
    });
    if (type === "turn/start" && this.autoOrigins && !this.goalSessions.has(sessionId) && this.lastPromptId(sessionId)) {
      const origin = this.emitMux({ type: "session/event", sessionId, event: { type: "user/message", time: Date.now(), data: { source: { kind: "user", rpcId: this.lastPromptId(sessionId) } } } });
      await Promise.all([start, origin]);
    } else {
      await start;
    }
  }

  async emitProjection(sessionId: string, key: string, value: unknown, seq: number): Promise<void> {
    if (key === "tarocubGoalUsage") this.goalUsage.set(sessionId, value as { goalId: string; tokensUsed: number });
    if (key === "goal" && this.autoGoalUsage) {
      const id = (value as any)?.goal?.id ?? null;
      const usage = this.goalUsage.get(sessionId);
      if (usage?.goalId !== id) {
        const next = { goalId: id, tokensUsed: 0 }; this.goalUsage.set(sessionId, next);
        await this.emitMux({ type: "session/projection", sessionId, key: "tarocubGoalUsage", value: next, seq });
      }
    }
    return this.emitMux({
      type: "session/projection",
      sessionId,
      key,
      value,
      seq,
    });
  }

  emitHost(payload: Record<string, unknown>, rpcId = `host-${Math.random()}`): Promise<void> {
    const frame: DeepSeekHarnessServerRequest = {
      type: "server-request",
      rpcId,
      method: String(payload.type),
      payload: payload as DeepSeekHarnessServerRequest["payload"],
    };
    return Promise.resolve(this.handlers?.onHostFrame(frame));
  }
}

function createAdapter(gateway = new FakeGateway(), options: {
  searchMcpEnabled?: boolean;
  permissionPreset?: "workspace-write" | "full-auto" | "danger-full-access";
  model?: { provider: string; model: string; reasoningEffort?: string };
  configPath?: string;
  goalStatePath?: string;
  turnTimeoutMs?: number | null;
  inactivityTimeoutMs?: number | null;
  backgroundReviewGraceMs?: number;
} = {}) {
  const adapter = new DeepSeekHarnessAdapter({
    gateway,
    searchMcpEnabled: options.searchMcpEnabled,
    workspacePath: "/workspace",
    // A declared fixture timezone; never inherit the developer or CI machine's zone.
    clientTimeZone: "Asia/Shanghai",
    permissionPreset: options.permissionPreset ?? "workspace-write",
    model: options.model,
    configPath: options.configPath,
    goalStatePath: options.goalStatePath,
    turnSettleDelayMs: 1,
    backgroundReviewGraceMs: options.backgroundReviewGraceMs ?? 50,
    ...(options.turnTimeoutMs !== undefined ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    ...(options.inactivityTimeoutMs !== undefined ? { inactivityTimeoutMs: options.inactivityTimeoutMs } : {}),
  });
  return { adapter, gateway };
}

async function finishTurn(
  gateway: FakeGateway,
  sessionId: string,
  turn: number,
  firstSeq: number,
  text: string,
): Promise<void> {
  await gateway.emitSessionEvent(sessionId, "turn/start", { turn }, firstSeq);
  await gateway.emitMux({ type: "session/event", sessionId, event: { type: "user/message", data: { source: { kind: "user", rpcId: gateway.lastPromptId(sessionId) } } } });
  await gateway.emitSessionEvent(sessionId, "assistant/chunk", {
    turn,
    step: 1,
    chunk: { type: "text-delta", index: 0, text },
  }, firstSeq + 1);
  await gateway.emitSessionEvent(sessionId, "turn/end", { turn, reason: completedReason() }, firstSeq + 2);
}

async function waitForCall(gateway: FakeGateway, method: string, count = 1): Promise<void> {
  await vi.waitFor(() => {
    expect(gateway.calls.filter((call) => call.method === method)).toHaveLength(count);
  });
}

function completedReason(): { kind: "completed" } {
  return { kind: "completed" };
}

describe("DeepSeek Harness search instructions", () => {
  it("keeps the blocked-page fallback and source disclosure in the adapter note", () => {
    expect(DEEPSEEK_HARNESS_SEARCH_TOOL_NOTE).toContain("blocked or dynamic pages use Scrapling");
    expect(DEEPSEEK_HARNESS_SEARCH_TOOL_NOTE).toContain("if both direct routes fail");
    expect(DEEPSEEK_HARNESS_SEARCH_TOOL_NOTE).toContain("Disclose web use and cite source links");
  });
});

describe("DeepSeekHarnessAdapter", () => {
  it.each([false, true])("routes native compaction receipts only to the owned turn (failed=%s)", async failed => {
    const { adapter, gateway } = createAdapter(), probe = nativeRunProbe();
    const { sessionId } = await adapter.createSession(1);
    try {
      const result = adapter.sendUserMessage(sessionId, { text: "continue", files: [], onEngineEvent: probe.onEngineEvent });
      await waitForCall(gateway, "session.prompt", 1);
      await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
      await gateway.emitSessionEvent(sessionId, "compaction/start", { turn: 99, compactionId: "foreign" }, 2);
      await gateway.emitSessionEvent("foreign-session", "compaction/start", { turn: 1, compactionId: "foreign" }, 1);
      expect(probe.record.entries).toHaveLength(0);
      await gateway.emitSessionEvent(sessionId, "compaction/start", { turn: 1, compactionId: "compact" }, 3);
      expect(summarizeRun(probe.record, "running").current?.name).toBe("context_compaction");
      await gateway.emitSessionEvent(sessionId, "compaction/summary", { turn: 1, compactionId: "compact", summary: "PRIVATE_SUMMARY" }, 4);
      await gateway.emitSessionEvent(sessionId, "compaction/end", { turn: 1, compactionId: "compact", ...(failed ? { error: "failed" } : {}) }, 5);
      expect(probe.record.entries[0].status).toBe(failed ? "error" : "done");
      expect(JSON.stringify(probe.events)).not.toContain("PRIVATE_SUMMARY");
      await gateway.emitSessionEvent(sessionId, "assistant/chunk", { turn: 1, step: 1, chunk: { type: "text-delta", text: "continued" } }, 6);
      await gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 7);
      await expect(result).resolves.toMatchObject({ text: "continued" });
    } finally { await adapter.destroy(); }
  });
  it("blocks a turn before permission changes or prompts when config is corrupt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-config-safety-"));
    const configPath = path.join(root, "config.json"), gateway = new FakeGateway();
    const adapter = new DeepSeekHarnessAdapter({ gateway, workspacePath: root, configPath });
    try {
      await writeFile(configPath, "{broken-private-setting");
      await expect(adapter.sendUserMessage("s-config", { text: "hello", files: [] })).rejects.toThrow("execution blocked");
      expect(gateway.calls.some(c => c.method === "commands/execute" || c.method === "session.prompt")).toBe(false);
    } finally { await adapter.destroy(); await rm(root, { recursive: true, force: true }); }
  });

  const appTools = (): AppPlatformTools => ({ definitions: [{ name: "app_send_file", description: "file", inputSchema: { type: "object" } }], instructions: "NATIVE_APP_CONTRACT", turnInstructions: "NATIVE_TURN", isRegistered: async () => false, register: async () => {}, call: async () => ({ text: "receipt" }) });
  it.each([true, false])("refreshes App identity on every existing-session prompt with native tools=%s", async (native) => {
    const gateway = Object.assign(new FakeGateway(), { installAppTools: async () => native }), { adapter } = createAdapter(gateway);
    const sessionId = "telegram-legacy-routing-id";
    try {
      for (let turnNumber = 1; turnNumber <= 2; turnNumber++) {
        const turn = adapter.sendUserMessage(sessionId, { text: "im是什么", files: [],
          instructions: appAgentInstructions({ engine: "deepseek" }),
          appPlatformTools: { ...appTools(), instructions: appAgentInstructions({ engine: "deepseek", nativeDelivery: true }) } });
        await waitForCall(gateway, "session.prompt", turnNumber);
        const prompts = gateway.calls.filter(call => call.method === "session.prompt");
        const prompt = prompts.at(-1)!.payload as { content: Array<{ text: string }>; sessionId: string };
        const text = prompt.content[0]!.text;
        await finishTurn(gateway, sessionId, turnNumber, (turnNumber - 1) * 4, "done"); await turn;
        expect(prompt.sessionId).toBe(sessionId);
        expect(text).toContain("You are replying in TaroBird App");
        expect(text).toContain("overrides old TaroCub/Lark labels in resumed history");
        expect(text).not.toContain("TaroCub Search MCP");
        expect(text).not.toContain("Lark Docs/Calendar");
        expect(text).toContain(native ? "Deliver artifacts with app_send_file" : "Artifact delivery: [send-file:");
        expect(text).toContain("<user_message>\nim是什么\n</user_message>");
      }
    } finally { await adapter.destroy(); }
  });
  it("binds native App tools to the admitted prompt and revokes after completion", async () => {
    const installAppTools = vi.fn(async (_binding: DeepSeekAppToolBinding) => true);
    const gateway = Object.assign(new FakeGateway(), { installAppTools }), { adapter } = createAdapter(gateway);
    try {
      const { sessionId } = await adapter.createSession(101);
      const turn = adapter.sendUserMessage(sessionId, { text: "deliver", files: [], instructions: "LEGACY_CONTRACT", appPlatformTools: appTools() });
      await waitForCall(gateway, "session.prompt");
      const binding = installAppTools.mock.calls[0]![0], prompt = gateway.calls.find((call) => call.method === "session.prompt")!.payload as Record<string, unknown>;
      expect(prompt.requestId).toBe(binding.sourceRpcId); expect(binding.sessionId).toBe(sessionId); expect(binding.signal.aborted).toBe(false);
      expect(JSON.stringify(prompt.content)).toContain("NATIVE_APP_CONTRACT"); expect(JSON.stringify(prompt.content)).toContain("NATIVE_TURN"); expect(JSON.stringify(prompt.content)).not.toContain("LEGACY_CONTRACT");
      await finishTurn(gateway, sessionId, 1, 0, "finished"); await turn;
      expect(binding.signal.aborted).toBe(true);
    } finally { await adapter.destroy(); }
  });
  it("uses compatibility only before prompting and never replays a rejected native prompt", async () => {
    const installAppTools = vi.fn(async (_binding: DeepSeekAppToolBinding) => false);
    const gateway = Object.assign(new FakeGateway(), { installAppTools }), { adapter } = createAdapter(gateway), events: EngineStreamEvent[] = [];
    try {
      const { sessionId } = await adapter.createSession(102);
      const turn = adapter.sendUserMessage(sessionId, { text: "deliver", files: [], instructions: "LEGACY_CONTRACT", appPlatformTools: appTools(), onEngineEvent: (event) => { events.push(event); } });
      await waitForCall(gateway, "session.prompt");
      const prompt = gateway.calls.find((call) => call.method === "session.prompt")!.payload as Record<string, unknown>;
      expect(prompt.requestId).toEqual(expect.any(String)); expect(JSON.stringify(prompt.content)).toContain("LEGACY_CONTRACT");
      await finishTurn(gateway, sessionId, 1, 0, "only-final"); await expect(turn).resolves.toMatchObject({ text: "only-final" });
      expect(events.some((event) => event.type === "assistant_text" && event.text.includes("兼容交付"))).toBe(true);
      installAppTools.mockResolvedValue(true); gateway.responses.set("session.prompt", new Error("native rejected"));
      await expect(adapter.sendUserMessage(sessionId, { text: "second", files: [], appPlatformTools: appTools() })).rejects.toThrow("native rejected");
      expect(gateway.calls.filter((call) => call.method === "session.prompt")).toHaveLength(2);
      expect(installAppTools.mock.calls[1]![0].signal.aborted).toBe(true);
    } finally { await adapter.destroy(); }
  });
  it("cancels during native installation without ever submitting a model prompt", async () => {
    const installAppTools = vi.fn(async (binding: DeepSeekAppToolBinding) => { await new Promise<void>((resolve) => binding.signal.addEventListener("abort", () => resolve(), { once: true })); return false; });
    const gateway = Object.assign(new FakeGateway(), { installAppTools }), { adapter } = createAdapter(gateway), abort = new AbortController();
    try {
      const { sessionId } = await adapter.createSession(103);
      const turn = adapter.sendUserMessage(sessionId, { text: "cancel", files: [], appPlatformTools: appTools(), abortSignal: abort.signal });
      const rejected = expect(turn).rejects.toThrow(); await vi.waitFor(() => expect(installAppTools).toHaveBeenCalledTimes(1)); abort.abort(); await rejected;
      expect(gateway.calls.some((call) => call.method === "session.prompt")).toBe(false);
    } finally { await adapter.destroy(); }
  });
  it("cancels and rejects a DeepSeek turn that exceeds the hard runtime timeout", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, gateway } = createAdapter(undefined, {
        turnTimeoutMs: 60_000,
        inactivityTimeoutMs: null,
      });
      const { sessionId } = await adapter.createSession(1);
      const turn = adapter.sendUserMessage(sessionId, { text: "keep working", files: [] });
      const rejected = expect(turn).rejects.toThrow("DeepSeek Harness turn timed out after 1 minute");
      await waitForCall(gateway, "session.prompt", 1);

      await vi.advanceTimersByTimeAsync(60_000);
      await rejected;
      expect(gateway.calls).toContainEqual({ method: "native.cancelPrompt", payload: { sessionId, sourceRpcId: expect.any(String) } });
      await adapter.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles transient reconnect prefixes and missing tail without replaying a completed step", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(809);
    const events: EngineStreamEvent[] = [];
    const turn = adapter.sendUserMessage(sessionId, { text: "stream", files: [], onEngineEvent: (event) => { events.push(event); } });
    await waitForCall(gateway, "session.prompt");
    const prefix = (text: string, reasoning: string) => gateway.emitMux({ type: "session/assistant-stream", sessionId,
      prefix: { attemptId: "a1", startedAfterSeq: 2, turn: 1, step: 1, text, reasoning } });
    await prefix("unowned", "");
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await prefix("你", "想");
    await prefix("你好", "想好了");
    await prefix("你好", "想好了");
    expect(events.filter((e) => e.type === "assistant_text").map((e) => e.text)).toEqual(["你", "好"]);
    await gateway.emitSessionEvent(sessionId, "assistant/message", { turn: 1, step: 1, message: { content: [
      { type: "text", text: "你好世界" }, { type: "reasoning", text: "想好了。" },
    ] } }, 3);
    await prefix("late stale replay", "late stale thinking");
    await gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 4);
    await expect(turn).resolves.toMatchObject({ text: "你好世界" });
    expect(events.filter((e) => e.type === "assistant_text").map((e) => e.text)).toEqual(["你", "好", "世界"]);
    expect(events.filter((e) => e.type === "thinking").map((e) => e.text)).toEqual(["想", "好了", "。"]);
    await adapter.destroy();
  });

  it("keeps cursorless goal prefixes separate from a concurrent foreground turn", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(810);
    const controller = new AbortController();
    const goalEvents: EngineStreamEvent[] = [], userEvents: EngineStreamEvent[] = [];
    const watch = adapter.watchThreadGoal(sessionId, { objective: "Goal", abortSignal: controller.signal,
      onEngineEvent: (event) => { goalEvents.push(event); } });
    await waitForCall(gateway, "goal.create");
    expect(goalEvents).toContainEqual({ type: "session", sessionId });
    const turn = adapter.sendUserMessage(sessionId, { text: "user", files: [], onEngineEvent: (event) => { userEvents.push(event); } });
    await waitForCall(gateway, "session.prompt");
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitSessionEvent(sessionId, "user/message", { source: { kind: "goal", round: 1 } }, 2);
    await gateway.emitMux({ type: "session/assistant-stream", sessionId, prefix: { attemptId: "a1", startedAfterSeq: 2, turn: 1, step: 1, text: "goal", reasoning: "think" } });
    await gateway.emitSessionEvent(sessionId, "assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "goal done" }, { type: "reasoning", text: "think" }] } }, 3);
    await gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 4);
    expect(goalEvents.filter((e) => e.type === "assistant_text").map((e) => e.text)).toEqual(["goal", " done"]);
    expect(userEvents.filter((e) => e.type === "assistant_text")).toEqual([]);
    controller.abort(); await watch;
    await finishTurn(gateway, sessionId, 2, 5, "user answer");
    await expect(turn).resolves.toMatchObject({ text: "user answer" });
    await adapter.destroy();
  });

  it("refreshes the inactivity watchdog on activity and honors /timeout off", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, gateway } = createAdapter(undefined, {
        turnTimeoutMs: null,
        inactivityTimeoutMs: 60_000,
      });
      const { sessionId } = await adapter.createSession(2);
      const turn = adapter.sendUserMessage(sessionId, { text: "stream slowly", files: [] });
      const rejected = expect(turn).rejects.toThrow("DeepSeek Harness turn became inactive after 1 minute");
      await waitForCall(gateway, "session.prompt", 1);
      await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 0);

      await vi.advanceTimersByTimeAsync(45_000);
      gateway.emitSessionEvent(sessionId, "assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "text-delta", index: 0, text: "still active" },
      }, 1);
      await vi.advanceTimersByTimeAsync(45_000);
      expect(gateway.calls.filter((call) => ["session.cancel", "native.cancelPrompt"].includes(call.method))).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(15_000);
      await rejected;

      const disabled = adapter.sendUserMessage(sessionId, {
        text: "intentionally long",
        files: [],
        disableRuntimeTimeout: true,
      });
      await waitForCall(gateway, "session.prompt", 2);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(gateway.calls.filter((call) => call.method === "native.cancelPrompt")).toHaveLength(1);
      gateway.emitSessionEvent(sessionId, "turn/start", { turn: 2 }, 2);
      gateway.emitSessionEvent(sessionId, "assistant/chunk", {
        turn: 2,
        step: 1,
        chunk: { type: "text-delta", index: 0, text: "finished" },
      }, 3);
      gateway.emitSessionEvent(sessionId, "turn/end", { turn: 2, reason: completedReason() }, 4);
      await vi.advanceTimersByTimeAsync(1);
      await expect(disabled).resolves.toMatchObject({ text: "finished" });
      await adapter.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not declare inactivity while a DeepSeek tool call is outstanding", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, gateway } = createAdapter(undefined, {
        turnTimeoutMs: null,
        inactivityTimeoutMs: 60_000,
      });
      const { sessionId } = await adapter.createSession(3);
      const turn = adapter.sendUserMessage(sessionId, { text: "run a long tool", files: [] });
      await waitForCall(gateway, "session.prompt", 1);
      gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
      gateway.emitSessionEvent(sessionId, "tool/call", {
        turn: 1,
        step: 1,
        callId: "tool-1",
        name: "long_tool",
        arguments: "{}",
      }, 2);

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(gateway.calls.filter((call) => ["session.cancel", "native.cancelPrompt"].includes(call.method))).toHaveLength(0);
      gateway.emitSessionEvent(sessionId, "tool/result", {
        turn: 1,
        step: 1,
        message: {
          source: { callId: "tool-1" },
          content: [{ type: "text", text: "done" }],
        },
      }, 3);
      gateway.emitSessionEvent(sessionId, "assistant/chunk", {
        turn: 1,
        step: 2,
        chunk: { type: "text-delta", index: 0, text: "complete" },
      }, 4);
      gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 5);
      await vi.advanceTimersByTimeAsync(1);
      await expect(turn).resolves.toMatchObject({ text: "complete" });
      await adapter.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects on timeout even when the event delivery callback never settles", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, gateway } = createAdapter(undefined, {
        turnTimeoutMs: null,
        inactivityTimeoutMs: 60_000,
      });
      const { sessionId } = await adapter.createSession(4);
      let outcome: string | undefined;
      const eventStarted = vi.fn();
      const turn = adapter.sendUserMessage(sessionId, {
        text: "do not let a stuck card update hold the turn open",
        files: [],
        onEngineEvent: () => {
          eventStarted();
          return new Promise<void>(() => {});
        },
      });
      void turn.then(
        () => { outcome = "resolved"; },
        (error: unknown) => { outcome = error instanceof Error ? error.message : String(error); },
      );
      await vi.waitFor(() => expect(eventStarted).toHaveBeenCalledTimes(1));
      expect(gateway.calls.filter((call) => call.method === "session.prompt")).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.resolve();

      expect(outcome).toBe("DeepSeek Harness turn became inactive after 1 minute");
      expect(gateway.calls.filter((call) => ["session.cancel", "native.cancelPrompt"].includes(call.method))).toHaveLength(0);
      await adapter.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates a durable standard session and applies the configured permission preset", async () => {
    const { adapter, gateway } = createAdapter(undefined, { permissionPreset: "full-auto" });

    const session = await adapter.createSession(12345);
    expect(session.sessionId).toMatch(/^session-/);
    expect(gateway.calls[0]).toEqual({
      method: "session.create",
      payload: {
        sessionId: session.sessionId,
        cwd: "/workspace",
        agentPreset: "standard",
      },
    });

    const turn = adapter.sendUserMessage(session.sessionId, { text: "Hello", files: [] });
    await waitForCall(gateway, "session.prompt", 1);
    expect(gateway.calls).toContainEqual({
      method: "commands/execute",
      payload: {
        args: {
          agentId: session.sessionId,
          line: "/permission full-auto",
          submittedAttachments: [],
        },
      },
    });
    const prompts = gateway.calls.filter((call) => call.method === "session.prompt");
    expect(prompts[0]?.payload).toMatchObject({
      sessionId: session.sessionId,
      mode: "queue",
      content: [{ type: "text", text: expect.stringContaining("Hello") }],
    });

    gateway.emitSessionEvent(session.sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitSessionEvent(session.sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "Hi" },
    }, 2);
    gateway.emitSessionEvent(session.sessionId, "turn/end", {
      turn: 1,
      reason: completedReason(),
    }, 3);

    await expect(turn).resolves.toMatchObject({ text: "Hi", sessionId: session.sessionId });
    await adapter.destroy();
    expect(gateway.closed).toBe(true);
  });

  it("appends the DSH-only search policy inside the private bridge instructions", async () => {
    // The MCP tool names are DeepSeek-Harness-specific, so they ride in the
    // adapter's own preamble instead of the shared every-turn App prompt
    // (which has a hard character budget and serves every engine).
    const { adapter, gateway } = createAdapter(undefined, { searchMcpEnabled: true });
    const { sessionId } = await adapter.createSession(12347);
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Find the latest release notes",
      files: [],
      instructions: [
        appAgentInstructions({ engine: "deepseek", context: "chat" }),
        appCapabilityInstructions("browser", { engine: "deepseek" }),
      ].join("\n"),
    });
    await waitForCall(gateway, "session.prompt", 1);
    const prompt = gateway.calls.find((call) => call.method === "session.prompt")?.payload as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = prompt.content[0]?.text ?? "";
    expect(text).toContain("<private_bridge_instructions>");
    expect(text).toContain("You are replying in TaroBird App");
    expect(text).toContain("Login: the selected skill's declared browser/profile wins");
    expect(text).toContain("CDP/9222/9223) unless the user named that port or browser");
    expect(text).toContain("blocked/dynamic pages use an available browser or Scrapling");
    expect(text).toContain("`mcp__cctb_search__web_extract`");
    expect(text).toContain("`mcp__cctb_search__web_search`");
    expect(text).toContain("Prefer `mcp__cctb_search__web_search`");
    expect(text).toContain("latest/current state");
    expect(text).toContain("model or software versions/features/releases");
    expect(text).toContain("medical/legal/financial claims");
    expect(text).toContain("provides an exact URL");
    expect(text).toContain("inspect the local environment instead of searching the web");
    expect(text).toContain("label it unverified");
    // The note is part of the private block, not the user message.
    expect(text.indexOf("mcp__cctb_search__web_extract")).toBeLessThan(text.indexOf("<user_message>"));

    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 2);
    await turn;
    await adapter.destroy();
  });

  it("uses native search without a configured Search MCP", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(12349);
    const turn = adapter.sendUserMessage(sessionId, { text: "Find current documentation", files: [], instructions: "Follow the App contract." });
    await waitForCall(gateway, "session.prompt", 1);
    const prompt = gateway.calls.find(call => call.method === "session.prompt")?.payload as { content: Array<{text?: string}> };
    expect(prompt.content[0]?.text).toContain("Use the Harness native search/fetch tools");
    expect(prompt.content[0]?.text).not.toContain("mcp__cctb_search__");
    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 2);
    await turn; await adapter.destroy();
  });

  it("omits the DSH search note when no bridge instructions are supplied", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(12348);
    const turn = adapter.sendUserMessage(sessionId, { text: "Hello", files: [] });
    await waitForCall(gateway, "session.prompt", 1);
    const prompt = gateway.calls.find((call) => call.method === "session.prompt")?.payload as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(prompt.content[0]?.text ?? "").not.toContain("mcp__cctb_search__");
    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 2);
    await turn;
    await adapter.destroy();
  });

  it("encodes image bytes and preserves every original attachment path for native file tools", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-images-"));
    const imagePath = path.join(root, "sample.png");
    const textPath = path.join(root, "notes.txt");
    const imageBytes = Buffer.from("89504e470d0a1a0a", "hex");
    await writeFile(imagePath, imageBytes);
    await writeFile(textPath, "notes", "utf8");

    try {
      const { adapter, gateway } = createAdapter();
      const { sessionId } = await adapter.createSession(12346);
      const turn = adapter.sendUserMessage(sessionId, {
        text: "Inspect both attachments",
        files: [imagePath, textPath],
      });
      await waitForCall(gateway, "session.prompt", 1);

      const content = (gateway.calls.find((call) => call.method === "session.prompt")?.payload as {
        content: Array<{ type: string; text?: string }>;
      }).content;
      // Seeing image pixels is insufficient for edit/return-original requests:
      // native file tools need the existing path, not a guessed cwd + filename.
      expect(content[0]?.text).toContain(`Attachment: ${imagePath}`);
      expect(content[0]?.text).toContain(`Attachment: ${textPath}`);

      expect(gateway.calls.find((call) => call.method === "session.prompt")?.payload).toEqual({
        sessionId,
        requestId: expect.any(String),
        mode: "queue",
        content: [
          {
            type: "text",
            text: expect.stringContaining(`Attachment: ${textPath}`),
          },
          {
            type: "image",
            mediaType: "image/png",
            data: imageBytes.toString("base64"),
            name: "sample.png",
          },
        ],
        clientTimeZone: "Asia/Shanghai",
      });

      await finishTurn(gateway, sessionId, 1, 1, "Inspected");
      await expect(turn).resolves.toMatchObject({ text: "Inspected" });
      await adapter.destroy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("declares Harness image media types from bytes when the file extension is wrong", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-image-type-"));
    const imagePath = path.join(root, "feishu-image.png");
    const imageBytes = Buffer.from("ffd8ffe000104a464946", "hex");
    await writeFile(imagePath, imageBytes);

    try {
      const { adapter, gateway } = createAdapter();
      const { sessionId } = await adapter.createSession(12349);
      const turn = adapter.sendUserMessage(sessionId, {
        text: "Inspect this image",
        files: [imagePath],
      });
      await waitForCall(gateway, "session.prompt", 1);

      const prompt = gateway.calls.find((call) => call.method === "session.prompt")?.payload as {
        content: Array<Record<string, unknown>>;
      };
      expect(prompt.content[1]).toEqual({
        type: "image",
        mediaType: "image/jpeg",
        data: imageBytes.toString("base64"),
        name: "feishu-image.jpg",
      });

      await finishTurn(gateway, sessionId, 1, 1, "Inspected");
      await expect(turn).resolves.toMatchObject({ text: "Inspected" });
      await adapter.destroy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("releases the single-writer claim after Harness rejects a prompt", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(12347);
    gateway.responses.set("session.prompt", new Error("MODEL_DOES_NOT_SUPPORT_IMAGES"));

    await expect(adapter.sendUserMessage(sessionId, {
      text: "Inspect this image",
      files: [],
    })).rejects.toThrow("MODEL_DOES_NOT_SUPPORT_IMAGES");

    gateway.responses.set("session.prompt", { accepted: true });
    const retry = adapter.sendUserMessage(sessionId, { text: "Continue without it", files: [] });
    await waitForCall(gateway, "session.prompt", 2);
    await finishTurn(gateway, sessionId, 1, 1, "Recovered");
    await expect(retry).resolves.toMatchObject({ text: "Recovered" });
    await adapter.destroy();
  });

  it("rejects a known session when a later turn claims a different workspace", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(12348);
    gateway.responses.set("session.prompt", new Error("prompt must not be sent"));

    await expect(adapter.sendUserMessage(sessionId, {
      text: "Use another project",
      files: [],
      workspaceOverride: "/other-workspace",
    })).rejects.toThrow(
      `DeepSeek Harness session ${sessionId} belongs to /workspace, not /other-workspace`,
    );
    expect(gateway.calls.filter((call) => call.method === "session.prompt")).toHaveLength(0);
    await adapter.destroy();
  });

  it("executes /compact as a Harness command instead of exposing it to the model", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(1);
    gateway.responses.set("commands/execute", (payload: unknown) => {
      const line = ((payload as { args?: { line?: string } }).args?.line ?? "");
      return {
        commandId: `command-${line}`,
        result: { kind: "success", text: line === "/compact" ? "Compacted" : "Configured" },
      };
    });

    await expect(adapter.sendUserMessage(sessionId, { text: "/compact", files: [] }))
      .resolves.toMatchObject({ sessionId, text: "Compacted" });
    expect(gateway.calls.filter((call) => call.method === "session.prompt")).toHaveLength(0);
    expect(gateway.calls.filter((call) => call.method === "commands/execute")).toEqual([
      {
        method: "commands/execute",
        payload: { args: { agentId: sessionId, line: "/permission workspace-write", submittedAttachments: [] } },
      },
      {
        method: "commands/execute",
        payload: { args: { agentId: sessionId, line: "/compact", submittedAttachments: [] } },
      },
    ]);
  });

  it("falls back to the legacy command attachment field after a strict schema rejection", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(1);
    gateway.responses.set("commands/execute", (payload: unknown) => {
      const args = (payload as { args: Record<string, unknown> }).args;
      if ("submittedAttachments" in args) {
        throw new DeepSeekHarnessRpcError({
          code: "invalid-arguments",
          message: 'args fields do not match the descriptor: missing "images"; unexpected "submittedAttachments"',
        });
      }
      const line = String(args.line ?? "");
      return {
        commandId: `command-${line}`,
        result: { kind: "success", text: line === "/compact" ? "Compacted" : "Configured" },
      };
    });

    await expect(adapter.sendUserMessage(sessionId, { text: "/compact", files: [] }))
      .resolves.toMatchObject({ sessionId, text: "Compacted" });
    expect(gateway.calls.filter((call) => call.method === "commands/execute")).toEqual([
      {
        method: "commands/execute",
        payload: {
          args: {
            agentId: sessionId,
            line: "/permission workspace-write",
            submittedAttachments: [],
          },
        },
      },
      {
        method: "commands/execute",
        payload: { args: { agentId: sessionId, line: "/permission workspace-write", images: [] } },
      },
      {
        method: "commands/execute",
        payload: { args: { agentId: sessionId, line: "/compact", images: [] } },
      },
    ]);
  });

  it("fails closed when Harness does not recognize a required command", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(1);
    gateway.responses.set("commands/execute", undefined);

    await expect(adapter.sendUserMessage(sessionId, { text: "Hello", files: [] }))
      .rejects.toThrow("did not recognize /permission workspace-write");
    expect(gateway.calls.filter((call) => call.method === "session.prompt")).toHaveLength(0);
  });

  it("reloads permission, model, and effort between turns and restores the Harness default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-runtime-config-"));
    const configPath = path.join(root, "config.json");
    const gateway = new FakeGateway();
    const baseline = {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
    };
    let current = { ...baseline };
    const groups = [{
      id: "deepseek-official",
      name: "DeepSeek",
      models: [
        { id: "deepseek-v4-flash", name: "Flash", reasoning: { efforts: [], defaultEffort: "high" } },
        { id: "deepseek-v4-pro", name: "Pro", reasoning: { efforts: [], defaultEffort: "high" } },
      ],
    }, {
      id: "openai",
      name: "OpenAI",
      models: [{ id: "gpt-5", name: "GPT-5", reasoning: { efforts: [], defaultEffort: "medium" } }],
    }];
    gateway.responses.set("settings.describe", {
      writable: true,
      hasDocument: true,
      namespaces: [{
        ns: "agent-default-model",
        value: baseline,
        schema: {},
        applies: "live",
        secrets: [],
        revision: 0,
      }],
    });
    gateway.responses.set("session.models", () => ({ current: { ...current }, routable: true, groups, failures: [] }));
    gateway.responses.set("session.selectModel", (payload: unknown) => {
      const selection = payload as typeof current & { sessionId: string };
      current = {
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
      };
      return { selected: { ...current } };
    });

    try {
      await writeFile(configPath, JSON.stringify({
        engine: "deepseek",
        approvalMode: "normal",
        model: "deepseek-official/deepseek-v4-pro",
        effort: "max",
      }), "utf8");
      const { adapter } = createAdapter(gateway, { configPath });
      const { sessionId } = await adapter.createSession(123);

      const first = adapter.sendUserMessage(sessionId, { text: "first", files: [] });
      await waitForCall(gateway, "session.selectModel", 1);
      expect(gateway.calls).toContainEqual({
        method: "session.selectModel",
        payload: { sessionId, provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "max" },
      });
      expect(gateway.calls).toContainEqual({
        method: "commands/execute",
        payload: { args: { agentId: sessionId, line: "/permission workspace-write", submittedAttachments: [] } },
      });
      await finishTurn(gateway, sessionId, 1, 1, "one");
      await expect(first).resolves.toMatchObject({ text: "one" });

      await writeFile(configPath, JSON.stringify({
        engine: "deepseek",
        approvalMode: "full-auto",
        model: "openai/gpt-5",
        effort: "medium",
      }), "utf8");
      const second = adapter.sendUserMessage(sessionId, { text: "second", files: [] });
      await waitForCall(gateway, "session.selectModel", 2);
      expect(gateway.calls).toContainEqual({
        method: "session.selectModel",
        payload: { sessionId, provider: "openai", model: "gpt-5", reasoningEffort: "medium" },
      });
      expect(gateway.calls).toContainEqual({
        method: "commands/execute",
        payload: { args: { agentId: sessionId, line: "/permission full-auto", submittedAttachments: [] } },
      });
      await finishTurn(gateway, sessionId, 2, 4, "two");
      await expect(second).resolves.toMatchObject({ text: "two" });

      await writeFile(configPath, JSON.stringify({ engine: "deepseek", approvalMode: "bypass" }), "utf8");
      const third = adapter.sendUserMessage(sessionId, { text: "third", files: [] });
      await waitForCall(gateway, "session.selectModel", 3);
      expect(gateway.calls).toContainEqual({
        method: "session.selectModel",
        payload: { sessionId, ...baseline },
      });
      expect(gateway.calls).toContainEqual({
        method: "commands/execute",
        payload: { args: { agentId: sessionId, line: "/permission danger-full-access", submittedAttachments: [] } },
      });
      await finishTurn(gateway, sessionId, 3, 7, "three");
      await expect(third).resolves.toMatchObject({ text: "three" });

      await adapter.destroy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("selects a ticket model/effort for that Harness session only and leaves config.json unchanged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-override-"));
    const configPath = path.join(root, "config.json");
    const config = JSON.stringify({ engine: "deepseek", approvalMode: "normal", model: "deepseek-official/deepseek-v4-pro", effort: "max" });
    const gateway = new FakeGateway();
    const baseline = { provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "high" };
    const current = new Map<string, typeof baseline>();
    gateway.responses.set("settings.describe", { writable: true, hasDocument: true, namespaces: [{ ns: "agent-default-model", value: baseline, schema: {}, applies: "live", secrets: [], revision: 0 }] });
    gateway.responses.set("session.models", (payload: unknown) => ({
      current: { ...current.get((payload as { sessionId: string }).sessionId) ?? baseline }, routable: true, failures: [],
      groups: [{ id: "deepseek-official", name: "DeepSeek", models: ["deepseek-v4-flash", "deepseek-v4-pro"].map(id => ({ id, name: id, reasoning: { efforts: [], defaultEffort: "high" } })) }],
    }));
    gateway.responses.set("session.selectModel", (payload: unknown) => {
      const { sessionId, ...selection } = payload as typeof baseline & { sessionId: string };
      current.set(sessionId, selection);
      return { selected: selection };
    });
    const selected = () => gateway.calls.filter(call => call.method === "session.selectModel").map(call => call.payload);
    try {
      await writeFile(configPath, config, "utf8");
      const { adapter } = createAdapter(gateway, { configPath });
      const ticket = (await adapter.createSession(1)).sessionId, plain = (await adapter.createSession(2)).sessionId;
      const engineOverride = { model: "deepseek-official/deepseek-v4-flash", effort: "low" as const };

      const first = adapter.sendUserMessage(ticket, { text: "first", files: [], engineOverride });
      await waitForCall(gateway, "session.prompt", 1);
      await finishTurn(gateway, ticket, 1, 1, "one");
      await expect(first).resolves.toMatchObject({ text: "one" });
      const second = adapter.sendUserMessage(plain, { text: "second", files: [] });
      await waitForCall(gateway, "session.prompt", 2);
      await finishTurn(gateway, plain, 1, 1, "two");
      await expect(second).resolves.toMatchObject({ text: "two" });
      const third = adapter.sendUserMessage(ticket, { text: "third", files: [], engineOverride });
      await waitForCall(gateway, "session.prompt", 3);
      await finishTurn(gateway, ticket, 2, 4, "three");
      await expect(third).resolves.toMatchObject({ text: "three" });

      expect(selected()).toEqual([
        { sessionId: ticket, provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "low" },
        { sessionId: plain, provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "max" },
      ]);
      await expect(adapter.sendUserMessage(plain, { text: "fourth", files: [], engineOverride: { effort: "medium" } }))
        .rejects.toThrow('Invalid model selection: deepseek-official/deepseek-v4-pro has no "medium" effort (available: low, high, max)');
      expect(gateway.calls.filter(call => call.method === "session.prompt")).toHaveLength(3);
      expect(await readFile(configPath, "utf8")).toBe(config);
      await adapter.destroy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps DeepSeek todo plans and native result IDs without assuming block order", async () => {
    const { adapter, gateway } = createAdapter(), probe = nativeRunProbe();
    try {
      const { sessionId } = await adapter.createSession(1);
      const turn = adapter.sendUserMessage(sessionId, { text: "Inspect", files: [], onEngineEvent: probe.onEngineEvent });
      await waitForCall(gateway, "session.prompt", 1);
      await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
      const call = (seq: number, callId: string, name: string, args: object) => gateway.emitSessionEvent(sessionId, "tool/call", { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) }, seq);
      await call(2, "plan", "todo_write", { todos: [{ content: "Check report", status: "in_progress" }] });
      await gateway.emitSessionEvent(sessionId, "tool/result", { turn: 1, step: 1, message: { source: { callId: "plan" }, content: [{ type: "tool-result", toolCallId: "plan", content: [{ type: "text", text: "Updated" }] }] } }, 3);
      await call(4, "a", "bash", { command: "check A" });
      await call(5, "b", "bash", { command: "check B" });
      await gateway.emitSessionEvent(sessionId, "tool/result", { turn: 1, step: 1, error: null, meta: { diffs: [{ path: "/wrong", oldText: "x", newText: "y" }] }, message: { source: { callId: "a" }, content: [{ type: "text", text: "envelope" }, { type: "tool-result", toolCallId: "b", content: "B failed", isError: true }, { type: "tool-result", toolCallId: "a", content: [{ type: "text", text: "A result" }] }] } }, 6);
      expect(runPlan(probe.record.entries[0])).toEqual([{ content: "Check report", status: "in_progress" }]);
      expect(probe.record.entries.filter(entry => entry.kind === "tool")).toHaveLength(2);
      expect(probe.record.entries.find(entry => entry.callId === "a")).toMatchObject({ status: "done", output: "A result" });
      expect(probe.record.entries.find(entry => entry.callId === "b")).toMatchObject({ status: "error", output: "B failed" });
      expect(probe.record.entries.find(entry => entry.callId === "a")!.changes).toBeUndefined();
      await call(7, "edit", "str_replace_editor", { command: "str_replace", path: "/report.md", old_str: "before", new_str: "requested" });
      await gateway.emitSessionEvent(sessionId, "tool/result", { turn: 1, step: 1, meta: { diffs: [{ path: "/report.md", oldText: "before", newText: "actual" }, { path: 7, oldText: {}, newText: null }] }, message: { source: { callId: "edit" }, content: [{ type: "tool-result", toolCallId: "edit", content: [{ type: "text", text: "Updated" }] }] } }, 8);
      expect(runDiff(probe.record.entries.find(entry => entry.callId === "edit")!)).toBe("/report.md\n-before\n+actual");
      await finishTurn(gateway, sessionId, 1, 9, "Report complete"); await turn;
      expect(summarizeRun(probe.record, "done")).toMatchObject({ count: 3, failed: 1 });
    } finally { await adapter.destroy(); }
  });

  it("streams reasoning, text, correlated tool calls/results, and disjoint usage once", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(1);
    const events: EngineStreamEvent[] = [];
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Inspect",
      files: [],
      onEngineEvent: (event) => {
        events.push(event);
      },
    });
    await waitForCall(gateway, "session.prompt", 1);

    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "reasoning-delta", index: 0, text: "checking" },
    }, 2);
    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 1, text: "Found " },
    }, 3);
    gateway.emitSessionEvent(sessionId, "tool/call", {
      turn: 1,
      step: 1,
      callId: "call-1",
      name: "bash",
      arguments: "{\"command\":\"pwd\"}",
    }, 4);
    gateway.emitSessionEvent(sessionId, "tool/result", {
      turn: 1,
      step: 1,
      message: {
        id: "tool-message-1",
        role: "user",
        source: { kind: "tool", callId: "call-1" },
        content: [{
          type: "tool-result",
          toolCallId: "call-1",
          content: [{ type: "text", text: "/workspace" }],
        }],
      },
    }, 5);
    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 2,
      chunk: { type: "text-delta", index: 0, text: "it." },
    }, 6);
    gateway.emitSessionEvent(sessionId, "assistant/message", {
      turn: 1,
      step: 2,
      message: {
        id: "assistant-1",
        role: "assistant",
        source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" },
        content: [{ type: "text", text: "it." }],
      },
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 4,
        reasoningTokens: 7,
      },
    }, 7);
    gateway.emitSessionEvent(sessionId, "turn/end", {
      turn: 1,
      reason: completedReason(),
    }, 8);

    await expect(turn).resolves.toEqual({
      text: "it.",
      sessionId,
      usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 34 },
    });
    expect(events).toEqual(expect.arrayContaining([
      { type: "session", sessionId },
      { type: "thinking", text: "checking", sessionId },
      { type: "assistant_text", text: "Found ", delta: true, sessionId },
      {
        type: "tool_use",
        toolName: "bash",
        toolInput: { command: "pwd" },
        toolUseId: "call-1",
        sessionId,
      },
      {
        type: "tool_result",
        toolName: "bash",
        toolUseId: "call-1",
        output: "/workspace",
        isError: false,
        sessionId,
      },
      { type: "result", text: "it.", sessionId },
    ]));
    expect(events.filter((event) => event.type === "assistant_text").map((event) => event.text)).toEqual([
      "Found ",
      "it.",
    ]);
  });

  it("keeps finalized reasoning out of the reply without replaying streamed thinking", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(2);
    const events: EngineStreamEvent[] = [];
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Verify a rumor",
      files: [],
      onEngineEvent: (event) => {
        events.push(event);
      },
    });
    await waitForCall(gateway, "session.prompt", 1);

    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "reasoning-delta", index: 0, text: "private analysis" },
    }, 2);
    await gateway.emitSessionEvent(sessionId, "assistant/message", {
      turn: 1,
      step: 1,
      message: {
        id: "assistant-mixed-content",
        role: "assistant",
        source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" },
        content: [
          { type: "reasoning", text: "private analysis" },
          { type: "text", text: "Verified public answer" },
        ],
      },
    }, 3);
    await gateway.emitSessionEvent(sessionId, "turn/end", {
      turn: 1,
      reason: completedReason(),
    }, 4);

    await expect(turn).resolves.toMatchObject({ text: "Verified public answer", sessionId });
    expect(events.filter((event) => event.type === "thinking")).toEqual([
      { type: "thinking", text: "private analysis", sessionId },
    ]);
    expect(events.filter((event) => event.type === "assistant_text")).toEqual([
      { type: "assistant_text", text: "Verified public answer", sessionId },
    ]);
    expect(events.filter((event) => event.type === "result")).toEqual([
      { type: "result", text: "Verified public answer", sessionId },
    ]);
  });

  it("keeps tool-step narration in progress events but out of the final reply", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(2);
    const events: EngineStreamEvent[] = [];
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Generate and deliver images",
      files: [],
      onEngineEvent: (event) => {
        events.push(event);
      },
    });
    await waitForCall(gateway, "session.prompt", 1);

    const progressText = "I will validate the generated images first.";
    const finalText = [
      "The images are ready.",
      "```tool-call",
      '{"name":"send.batch","payload":{"images":[{"path":"/workspace/p1.png","caption":"P1 cover"}]}}',
      "```",
    ].join("\n");

    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: progressText },
    }, 2);
    await gateway.emitSessionEvent(sessionId, "assistant/message", {
      turn: 1,
      step: 1,
      message: {
        id: "assistant-tool-step",
        role: "assistant",
        source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" },
        content: [
          { type: "text", text: progressText },
          { type: "tool-call", toolCallId: "call-1", name: "read_image", arguments: "{}" },
        ],
      },
    }, 3);
    await gateway.emitSessionEvent(sessionId, "tool/call", {
      turn: 1,
      step: 1,
      callId: "call-1",
      name: "read_image",
      arguments: "{}",
    }, 4);
    await gateway.emitSessionEvent(sessionId, "tool/result", {
      turn: 1,
      step: 1,
      message: {
        id: "tool-message-1",
        role: "user",
        source: { kind: "tool", callId: "call-1" },
        content: [{
          type: "tool-result",
          toolCallId: "call-1",
          content: [{ type: "text", text: "valid" }],
        }],
      },
    }, 5);
    await gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 2,
      chunk: { type: "text-delta", index: 0, text: finalText },
    }, 6);
    await gateway.emitSessionEvent(sessionId, "assistant/message", {
      turn: 1,
      step: 2,
      message: {
        id: "assistant-final",
        role: "assistant",
        source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" },
        content: [{ type: "text", text: finalText }],
      },
    }, 7);
    await gateway.emitSessionEvent(sessionId, "turn/end", {
      turn: 1,
      reason: completedReason(),
    }, 8);

    await expect(turn).resolves.toMatchObject({ text: finalText, sessionId });
    expect(events.filter((event) => event.type === "assistant_text")).toEqual([
      { type: "assistant_text", text: progressText, delta: true, sessionId },
      { type: "assistant_text", text: finalText, delta: true, sessionId },
    ]);
    expect(events.filter((event) => event.type === "result")).toEqual([
      { type: "result", text: finalText, sessionId },
    ]);
  });

  it("keeps the user turn open through background completion and the automatic review turn", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(2);
    const events: EngineStreamEvent[] = [];
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Run in background",
      files: [],
      onEngineEvent: (event) => {
        events.push(event);
      },
    });
    await waitForCall(gateway, "session.prompt", 1);

    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitMux({
      type: "session/jobs",
      sessionId,
      jobs: [{
        id: "bash-1",
        kind: "bash",
        label: "sleep 1; echo done",
        status: "running",
        startedAt: Date.now(),
      }],
    });
    gateway.emitSessionEvent(sessionId, "turn/end", {
      turn: 1,
      reason: completedReason(),
    }, 2);

    let settled = false;
    void turn.finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    gateway.emitMux({
      type: "session/jobs",
      sessionId,
      jobs: [{
        id: "bash-1",
        kind: "bash",
        label: "sleep 1; echo done",
        status: "completed",
        detail: "exit code: 0",
        startedAt: Date.now() - 1_000,
        finishedAt: Date.now(),
      }],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 2 }, 3);
    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 2,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "Background result: done" },
    }, 4);
    gateway.emitSessionEvent(sessionId, "turn/end", {
      turn: 2,
      reason: completedReason(),
    }, 5);

    await expect(turn).resolves.toMatchObject({ text: "Background result: done", sessionId });
    expect(events).toEqual(expect.arrayContaining([
      {
        type: "background_task_started",
        taskId: "bash-1",
        description: "sleep 1; echo done",
        sessionId,
      },
      {
        type: "background_task_finished",
        taskId: "bash-1",
        status: "completed",
        summary: "exit code: 0",
        sessionId,
      },
    ]));
  });

  it("emits lifecycle completion when a background job outlives an aborted foreground turn", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(2);
    const controller = new AbortController();
    const events: EngineStreamEvent[] = [];
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Run in background",
      files: [],
      abortSignal: controller.signal,
      onEngineEvent: (event) => {
        events.push(event);
      },
    });
    await waitForCall(gateway, "session.prompt", 1);

    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitMux({
      type: "session/jobs",
      sessionId,
      jobs: [{
        id: "bash-after-abort",
        kind: "bash",
        label: "finish after foreground abort",
        status: "running",
        startedAt: Date.now(),
      }],
    });
    controller.abort();
    await expect(turn).rejects.toThrow("DeepSeek Harness turn was aborted");

    await gateway.emitMux({
      type: "session/jobs",
      sessionId,
      jobs: [{
        id: "bash-after-abort",
        kind: "bash",
        label: "finish after foreground abort",
        status: "completed",
        detail: "exit code: 0",
        startedAt: Date.now() - 1_000,
        finishedAt: Date.now(),
      }],
    });

    expect(events).toContainEqual({
      type: "background_task_finished",
      taskId: "bash-after-abort",
      status: "completed",
      summary: "exit code: 0",
      sessionId,
    });
  });

  it("emits one final result when a completed job snapshot arrives during card delivery", async () => {
    const { adapter, gateway } = createAdapter(undefined, { backgroundReviewGraceMs: 5 });
    const { sessionId } = await adapter.createSession(18);
    let releaseResult!: () => void;
    const blockedResult = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    const resultEvents = vi.fn();
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Wait for the background job",
      files: [],
      onEngineEvent: (event) => {
        if (event.type === "result") {
          resultEvents();
          return blockedResult;
        }
      },
    });
    await waitForCall(gateway, "session.prompt", 1);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitSessionEvent(sessionId, "user/message", {
      source: { kind: "user" },
    }, 2);
    await gateway.emitMux({
      type: "session/jobs",
      sessionId,
      jobs: [{
        id: "job-1",
        kind: "process",
        label: "Worker",
        status: "running",
        startedAt: Date.now(),
      }],
    });
    await gateway.emitSessionEvent(sessionId, "turn/end", {
      turn: 1,
      reason: completedReason(),
    }, 3);
    const completedJobs = {
      type: "session/jobs",
      sessionId,
      jobs: [{
        id: "job-1",
        kind: "process",
        label: "Worker",
        status: "completed",
        startedAt: Date.now() - 100,
        finishedAt: Date.now(),
      }],
    };
    await gateway.emitMux(completedJobs);
    await vi.waitFor(() => expect(resultEvents).toHaveBeenCalledTimes(1));

    await gateway.emitMux(completedJobs);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resultEvents).toHaveBeenCalledTimes(1);

    releaseResult();
    await expect(turn).resolves.toMatchObject({ sessionId });
    await adapter.destroy();
  });

  it("maps one-shot and session approvals and reuses a session grant", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(3);
    const approvals: EngineApprovalRequest[] = [];
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Write",
      files: [],
      onApprovalRequest: async (request) => {
        approvals.push(request);
        return { behavior: "allow", scope: "session" };
      },
    });
    await waitForCall(gateway, "session.prompt", 1);
    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitSessionEvent(sessionId, "tool/call", {
      turn: 1,
      step: 1,
      callId: "call-edit-1",
      name: "edit",
      arguments: "{\"path\":\"a.ts\"}",
    }, 2);
    gateway.emitMux({
      type: "approval/requested",
      sessionId,
      approvalId: "approval-1",
      callId: "call-edit-1",
      toolName: "edit",
      reason: "write outside current patch",
    }, "approval-rpc-1");
    await vi.waitFor(() => expect(gateway.clientResponses).toHaveLength(1));
    expect(approvals).toEqual([{
      engine: "deepseek",
      approvalScopes: { once: "once", session: "session" },
      toolName: "edit",
      toolInput: { path: "a.ts" },
      cwd: "/workspace",
      sessionId,
      abortSignal: expect.any(AbortSignal),
    }]);
    expect(gateway.clientResponses[0]).toEqual({
      rpcId: "approval-rpc-1",
      value: { sessionId, approvalId: "approval-1", outcome: "allowed-once" },
    });

    gateway.emitSessionEvent(sessionId, "tool/call", {
      turn: 1,
      step: 2,
      callId: "call-edit-2",
      name: "edit",
      arguments: "{\"path\":\"b.ts\"}",
    }, 3);
    gateway.emitMux({
      type: "approval/requested",
      sessionId,
      approvalId: "approval-2",
      callId: "call-edit-2",
      toolName: "edit",
    }, "approval-rpc-2");
    await vi.waitFor(() => expect(gateway.clientResponses).toHaveLength(2));
    expect(approvals).toHaveLength(2);
    expect(gateway.clientResponses[1]).toMatchObject({
      rpcId: "approval-rpc-2",
      value: { outcome: "allowed-once" },
    });

    gateway.emitSessionEvent(sessionId, "tool/call", {
      turn: 1, step: 3, callId: "call-edit-3", name: "edit", arguments: "{\"path\":\"a.ts\"}",
    }, 4);
    gateway.emitMux({ type: "approval/requested", sessionId, approvalId: "approval-3", callId: "call-edit-3", toolName: "edit" }, "approval-rpc-3");
    await vi.waitFor(() => expect(gateway.clientResponses).toHaveLength(3));
    expect(approvals).toHaveLength(2);
    expect(gateway.clientResponses[2]).toMatchObject({ value: { outcome: "allowed-once" } });

    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 3,
      chunk: { type: "text-delta", index: 0, text: "Edited" },
    }, 5);
    gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 6);
    await expect(turn).resolves.toMatchObject({ text: "Edited" });
  });

  it.each(["missing-input", "mismatched-tool"] as const)("offers only once and never caches a grant with %s evidence", async (kind) => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(332);
    const approve = vi.fn(async (_request: EngineApprovalRequest) => ({ behavior: "allow" as const, scope: "session" as const }));
    const turn = adapter.sendUserMessage(sessionId, { text: "Check evidence", files: [], onApprovalRequest: approve });
    void turn.catch(() => {});
    try {
      await waitForCall(gateway, "session.prompt", 1);
      await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
      if (kind === "mismatched-tool") {
        await gateway.emitSessionEvent(sessionId, "tool/call", { turn: 1, step: 1, callId: "untrusted-call", name: "read", arguments: '{"path":"a.ts"}' }, 2);
      }
      for (const suffix of ["first", "again"]) {
        await gateway.emitMux({ type: "approval/requested", sessionId, approvalId: suffix, callId: "untrusted-call", toolName: "edit" }, suffix);
      }
      expect(approve).toHaveBeenCalledTimes(2);
      for (const [request] of approve.mock.calls) {
        expect(request.approvalScopes).toEqual({ once: "once" });
        expect(request.toolInput).toBeUndefined();
      }
      // A forged callback returning session anyway still cannot create consent
      // that the subsequent correctly evidenced edit can reuse.
      await gateway.emitSessionEvent(sessionId, "tool/call", { turn: 1, step: 2, callId: "real-call", name: "edit", arguments: '{"path":"a.ts"}' }, 3);
      await gateway.emitMux({ type: "approval/requested", sessionId, approvalId: "real", callId: "real-call", toolName: "edit" }, "real");
      expect(approve).toHaveBeenCalledTimes(3);
      expect(approve.mock.calls[2]![0].approvalScopes).toEqual({ once: "once", session: "session" });
      await finishTurn(gateway, sessionId, 1, 4, "Done");
      await turn;
    } finally { await adapter.destroy(); }
  });

  it("bounds session approval grants and asks again after the oldest grant is evicted", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(333);
    const approve = vi.fn(async () => ({ behavior: "allow" as const, scope: "session" as const }));
    const turn = adapter.sendUserMessage(sessionId, { text: "Many edits", files: [], onApprovalRequest: approve });
    void turn.catch(() => {});
    let seq = 1;
    const request = async (pathId: number) => {
      const callId = `edit-${seq}`;
      await gateway.emitSessionEvent(sessionId, "tool/call", { turn: 1, step: seq, callId, name: "edit", arguments: JSON.stringify({ path: `${pathId}.ts` }) }, ++seq);
      await gateway.emitMux({ type: "approval/requested", sessionId, approvalId: callId, callId, toolName: "edit" }, callId);
    };
    try {
      await waitForCall(gateway, "session.prompt", 1);
      await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, seq);
      for (let i = 0; i <= DEEPSEEK_SESSION_APPROVAL_GRANT_LIMIT; i++) await request(i);
      expect(approve).toHaveBeenCalledTimes(DEEPSEEK_SESSION_APPROVAL_GRANT_LIMIT + 1);
      await request(DEEPSEEK_SESSION_APPROVAL_GRANT_LIMIT);
      expect(approve).toHaveBeenCalledTimes(DEEPSEEK_SESSION_APPROVAL_GRANT_LIMIT + 1);
      await request(0);
      expect(approve).toHaveBeenCalledTimes(DEEPSEEK_SESSION_APPROVAL_GRANT_LIMIT + 2);
      await finishTurn(gateway, sessionId, 1, ++seq, "Done");
      await turn;
    } finally { await adapter.destroy(); }
  });

  it.each(["unconfirmed", "confirming"] as const)("does not reuse a session grant for a late approval after a %s stop", async (stop) => {
    const { adapter, gateway } = createAdapter();
    try {
      const { sessionId } = await adapter.createSession(31);
      const first = adapter.sendUserMessage(sessionId, {
        text: "Write", files: [], onApprovalRequest: async () => ({ behavior: "allow", scope: "session" }),
      });
      await waitForCall(gateway, "session.prompt", 1);
      await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
      await gateway.emitMux({ type: "approval/requested", sessionId, approvalId: "grant", toolName: "edit" }, "grant-rpc");
      await vi.waitFor(() => expect(gateway.clientResponses).toHaveLength(1));
      await gateway.emitSessionEvent(sessionId, "assistant/chunk", { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "Granted" } }, 2);
      await gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 3);
      await expect(first).resolves.toMatchObject({ text: "Granted" });

      // The native turn can keep running after the host-side stop: settled as
      // unconfirmed, or with its exact cancellation receipt still outstanding.
      let confirm: ((receipt: { outcome: "cancelled" }) => void) | undefined;
      gateway.responses.set("native.cancelPrompt", stop === "unconfirmed"
        ? { outcome: "missing" }
        : () => new Promise((resolve) => { confirm = resolve; }));
      const abort = new AbortController();
      const prompted = vi.fn(async (_request: EngineApprovalRequest) => ({ behavior: "allow" as const, scope: "session" as const }));
      const stopped = adapter.sendUserMessage(sessionId, { text: "Stop me", files: [], abortSignal: abort.signal, onApprovalRequest: prompted });
      const rejected = expect(stopped).rejects.toMatchObject({ name: stop === "unconfirmed" ? "EngineCancellationUnconfirmedError" : "AbortError" });
      await waitForCall(gateway, "session.prompt", 2);
      await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 2 }, 4);
      abort.abort();
      if (stop === "unconfirmed") await rejected;
      else await waitForCall(gateway, "native.cancelPrompt");
      await gateway.emitMux({ type: "approval/requested", sessionId, approvalId: "late", toolName: "edit" }, "late-rpc");
      await vi.waitFor(() => expect(gateway.clientResponses).toHaveLength(2));
      expect(gateway.clientResponses[1]).toEqual({ rpcId: "late-rpc", value: { sessionId, approvalId: "late", outcome: "rejected" } });
      // The stopping turn may still see its approval UI, but only already cancelled.
      expect(prompted.mock.calls.every(([request]) => request.abortSignal?.aborted)).toBe(true);
      confirm?.({ outcome: "cancelled" });
      await rejected;
      await gateway.emitSessionEvent(sessionId, "turn/end", { turn: 2, reason: { kind: "aborted" } }, 5);

      // Missing call/input evidence is never a reusable grant, even for a live owner.
      const askAgain = vi.fn(async () => ({ behavior: "deny" as const }));
      const third = adapter.sendUserMessage(sessionId, { text: "Write again", files: [], onApprovalRequest: askAgain });
      await waitForCall(gateway, "session.prompt", 3);
      await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 3 }, 6);
      await gateway.emitMux({ type: "approval/requested", sessionId, approvalId: "owned", toolName: "edit" }, "owned-rpc");
      await vi.waitFor(() => expect(gateway.clientResponses).toHaveLength(3));
      expect(gateway.clientResponses[2]).toEqual({ rpcId: "owned-rpc", value: { sessionId, approvalId: "owned", outcome: "rejected" } });
      expect(askAgain).toHaveBeenCalledOnce();
      await gateway.emitSessionEvent(sessionId, "assistant/chunk", { turn: 3, step: 1, chunk: { type: "text-delta", index: 0, text: "Reused" } }, 7);
      await gateway.emitSessionEvent(sessionId, "turn/end", { turn: 3, reason: completedReason() }, 8);
      await expect(third).resolves.toMatchObject({ text: "Reused" });
    } finally { await adapter.destroy(); }
  });

  it("fails a broken approval UI closed without leaving Harness waiting", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(30);
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Write safely",
      files: [],
      onApprovalRequest: async () => {
        throw new Error("approval card failed");
      },
    });
    await waitForCall(gateway, "session.prompt", 1);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitMux({
      type: "approval/requested",
      sessionId,
      approvalId: "approval-ui-failure",
      toolName: "write",
    }, "approval-ui-failure-rpc");

    expect(gateway.clientResponses).toContainEqual({
      rpcId: "approval-ui-failure-rpc",
      value: {
        sessionId,
        approvalId: "approval-ui-failure",
        outcome: "rejected",
      },
    });
    await finishTurn(gateway, sessionId, 1, 2, "Denied safely");
    await expect(turn).resolves.toMatchObject({ text: "Denied safely" });
  });

  it("rejects malformed approval and question requests instead of leaving Harness waiting", async () => {
    const { adapter, gateway } = createAdapter();
    await adapter.createSession(33);

    await gateway.emitMux({
      type: "approval/requested",
      sessionId: "missing-approval-fields",
    }, "malformed-approval-rpc");
    await gateway.emitMux({
      type: "question/requested",
      sessionId: "partial-question-list",
      questions: [
        { id: "valid", question: "Valid?" },
        { id: "missing-question-text" },
      ],
    }, "malformed-question-rpc");

    expect(gateway.clientErrors).toEqual([
      {
        rpcId: "malformed-approval-rpc",
        error: {
          code: "invalid-request",
          message: "Malformed DeepSeek Harness approval request",
        },
      },
      {
        rpcId: "malformed-question-rpc",
        error: {
          code: "invalid-request",
          message: "Malformed DeepSeek Harness question request",
        },
      },
    ]);
  });

  it("rejects a pending Harness approval even when the foreground turn is aborted", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(31);
    const controller = new AbortController();
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Wait for approval",
      files: [],
      abortSignal: controller.signal,
      onApprovalRequest: async () => await new Promise(() => {}),
    });
    await waitForCall(gateway, "session.prompt", 1);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    const approval = gateway.emitMux({
      type: "approval/requested",
      sessionId,
      approvalId: "approval-aborted",
      toolName: "write",
    }, "approval-aborted-rpc");
    controller.abort();

    await approval;
    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    expect(gateway.clientResponses).toContainEqual({
      rpcId: "approval-aborted-rpc",
      value: {
        sessionId,
        approvalId: "approval-aborted",
        outcome: "rejected",
      },
    });
  });

  it("does not cache a session grant unless Harness accepts the approval response", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(32);
    let approvalCount = 0;
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Write twice",
      files: [],
      onApprovalRequest: async () => {
        approvalCount += 1;
        return { behavior: "allow", scope: "session" };
      },
    });
    await waitForCall(gateway, "session.prompt", 1);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.respondReceipt = { accepted: false, reason: "not-pending" };
    await gateway.emitMux({
      type: "approval/requested",
      sessionId,
      approvalId: "stale-approval",
      toolName: "write",
    }, "stale-approval-rpc");

    gateway.respondReceipt = { accepted: true };
    await gateway.emitMux({
      type: "approval/requested",
      sessionId,
      approvalId: "live-approval",
      toolName: "write",
    }, "live-approval-rpc");

    expect(approvalCount).toBe(2);
    await finishTurn(gateway, sessionId, 1, 2, "Done");
    await expect(turn).resolves.toMatchObject({ text: "Done" });
  });

  it("converts Feishu-style question answers back to Harness question ids", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(4);
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Ask me",
      files: [],
      onApprovalRequest: async (request) => {
        expect(request.engine).toBe("deepseek");
        expect(request.toolName).toBe("AskUserQuestion");
        return {
          behavior: "allow",
          updatedInput: {
            answers: {
              "Choose a mode": "Safe",
              "Pick tags": "One, Two",
            },
          },
        };
      },
    });
    await waitForCall(gateway, "session.prompt", 1);
    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitMux({
      type: "question/requested",
      sessionId,
      questions: [
        {
          id: "mode",
          question: "Choose a mode",
          options: [{ label: "Safe" }, { label: "Fast" }],
        },
        {
          id: "tags",
          question: "Pick tags",
          options: [{ label: "One" }, { label: "Two" }, { label: "Three" }],
          multiSelect: true,
        },
      ],
    }, "question-rpc");

    await vi.waitFor(() => expect(gateway.clientResponses).toHaveLength(1));
    expect(gateway.clientResponses[0]).toEqual({
      rpcId: "question-rpc",
      value: {
        sessionId,
        answer: {
          answers: [
            { id: "mode", selected: ["Safe"] },
            { id: "tags", selected: ["One", "Two"] },
          ],
        },
      },
    });
    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 2,
      chunk: { type: "text-delta", index: 0, text: "Thanks" },
    }, 2);
    gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 3);
    await expect(turn).resolves.toMatchObject({ text: "Thanks" });
  });

  it("keeps repeated question text answerable per native question id", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(34);
    const requests: EngineApprovalRequest[] = [];
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Ask twice",
      files: [],
      onApprovalRequest: async (request) => {
        requests.push(request);
        const keys = (request.toolInput as { questions: Array<{ question: string }> }).questions.map((question) => question.question);
        return { behavior: "allow", updatedInput: { answers: { [keys[0]!]: "Alpha", [keys[1]!]: "Beta" } } };
      },
    });
    await waitForCall(gateway, "session.prompt", 1);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    // The Harness requires distinct ids, not distinct text.
    await gateway.emitMux({
      type: "question/requested",
      sessionId,
      questions: [
        { id: "first", question: "Which file?", header: "Source", options: [{ label: "Alpha" }, { label: "Beta" }] },
        { id: "second", question: "Which file?", header: "Target", options: [{ label: "Alpha" }, { label: "Beta" }] },
      ],
    }, "repeated-question-rpc");

    await vi.waitFor(() => expect(gateway.clientResponses).toHaveLength(1));
    const presented = (requests[0]!.toolInput as { questions: Array<{ id: string; question: string }> }).questions;
    expect(presented.map((question) => question.id)).toEqual(["first", "second"]);
    expect(new Set(presented.map((question) => question.question)).size).toBe(2);
    expect(presented[0]!.question).toBe("Which file?");
    expect(gateway.clientResponses[0]).toEqual({
      rpcId: "repeated-question-rpc",
      value: {
        sessionId,
        answer: { answers: [{ id: "first", selected: ["Alpha"] }, { id: "second", selected: ["Beta"] }] },
      },
    });
    await gateway.emitSessionEvent(sessionId, "assistant/chunk", { turn: 1, step: 2, chunk: { type: "text-delta", index: 0, text: "Thanks" } }, 2);
    await gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 3);
    await expect(turn).resolves.toMatchObject({ text: "Thanks" });
  });

  it("answers a broken question UI with an explicit empty Harness answer", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(33);
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Ask safely",
      files: [],
      onApprovalRequest: async () => {
        throw new Error("question card failed");
      },
    });
    await waitForCall(gateway, "session.prompt", 1);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitMux({
      type: "question/requested",
      sessionId,
      questions: [{
        id: "choice",
        question: "Choose",
        options: [{ label: "A" }, { label: "B" }],
      }],
    }, "question-ui-failure-rpc");

    expect(gateway.clientResponses).toContainEqual({
      rpcId: "question-ui-failure-rpc",
      value: {
        sessionId,
        answer: { answers: [{ id: "choice", selected: [] }] },
      },
    });
    await finishTurn(gateway, sessionId, 1, 2, "Continued");
    await expect(turn).resolves.toMatchObject({ text: "Continued" });
  });

  it.each(["session.create", "session.prompt"])("waits for a transient writer handoff before %s without changing the request identity", async (method) => {
    vi.useFakeTimers();
    const { adapter, gateway } = createAdapter();
    const busy = (sessionId: string) => new DeepSeekHarnessRpcError({ code: "session/writer-held", message: `session "${sessionId}" is already owned by an active write handle`, details: { sessionId } });
    let attempts = 0;
    gateway.responses.set(method, (payload: any) => {
      if (++attempts === 1) throw busy(payload.sessionId);
      return method === "session.create" ? { sessionId: payload.sessionId } : { command: { kind: "success", text: "received once" } };
    });
    try {
      const turn = adapter.sendUserMessage("restored-session", { text: "im是什么", files: [] });
      const result = expect(turn).resolves.toMatchObject({ text: "received once" });
      if (method === "session.create") gateway.responses.set("session.prompt", { command: { kind: "success", text: "received once" } });
      await waitForCall(gateway, method);
      expect(gateway.calls.filter(c => c.method === "session.prompt")).toHaveLength(method === "session.create" ? 0 : 1);
      await vi.advanceTimersByTimeAsync(250);
      await result;
      const calls = gateway.calls.filter(c => c.method === method);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.payload).toEqual(calls[0]!.payload);
      expect(gateway.calls.filter(c => c.method === "session.cancel")).toHaveLength(0);
    } finally { await adapter.destroy(); vi.useRealTimers(); }
  });

  it("bounds writer recovery and releases its local claim after exhaustion", async () => {
    vi.useFakeTimers();
    const { adapter, gateway } = createAdapter();
    try {
      const { sessionId } = await adapter.createSession(909);
      const busy = new DeepSeekHarnessRpcError({ code: "session/writer-held", message: "writer is draining", details: { sessionId } });
      gateway.responses.set("session.prompt", busy);
      const rejected = expect(adapter.sendUserMessage(sessionId, { text: "first", files: [] })).rejects.toBe(busy);
      await waitForCall(gateway, "session.prompt");
      await expect(adapter.sendUserMessage(sessionId, { text: "cannot overtake", files: [] })).rejects.toThrow("already has an active turn");
      await vi.advanceTimersByTimeAsync(3_750);
      await rejected;
      expect(gateway.calls.filter(c => c.method === "session.prompt")).toHaveLength(5);
      gateway.responses.set("session.prompt", { command: { kind: "success", text: "recovered" } });
      await expect(adapter.sendUserMessage(sessionId, { text: "next", files: [] })).resolves.toMatchObject({ text: "recovered" });
    } finally { await adapter.destroy(); vi.useRealTimers(); }
  });

  it("aborts a cold session writer wait before any prompt and releases the local claim", async () => {
    vi.useFakeTimers();
    const { adapter, gateway } = createAdapter();
    const abort = new AbortController(), sessionId = "cold-session";
    try {
      gateway.responses.set("session.create", new DeepSeekHarnessRpcError({ code: "session/writer-held", message: "writer is draining", details: { sessionId } }));
      const rejected = expect(adapter.sendUserMessage(sessionId, { text: "cancel startup", files: [], abortSignal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
      await waitForCall(gateway, "session.create"); abort.abort(); await rejected;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(gateway.calls.filter(c => c.method === "session.create")).toHaveLength(1);
      expect(gateway.calls.filter(c => c.method === "session.prompt")).toHaveLength(0);
      gateway.responses.set("session.create", { sessionId });
      gateway.responses.set("session.prompt", { command: { kind: "success", text: "next admitted" } });
      await expect(adapter.sendUserMessage(sessionId, { text: "next", files: [] })).resolves.toMatchObject({ text: "next admitted" });
    } finally { await adapter.destroy(); vi.useRealTimers(); }
  });

  it("Stop during a refused prompt's writer wait prevents re-admission and preserves the known rejection", async () => {
    vi.useFakeTimers();
    const { adapter, gateway } = createAdapter();
    try {
      const { sessionId } = await adapter.createSession(910), abort = new AbortController();
      gateway.responses.set("session.prompt", new DeepSeekHarnessRpcError({ code: "session/writer-held", message: "writer is draining", details: { sessionId } }));
      gateway.responses.set("native.cancelPrompt", { outcome: "missing" });
      const rejected = expect(adapter.sendUserMessage(sessionId, { text: "stop before admission", files: [], abortSignal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
      await waitForCall(gateway, "session.prompt");
      abort.abort(); await rejected;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(gateway.calls.filter(c => c.method === "session.prompt")).toHaveLength(1);
      expect(gateway.calls.filter(c => c.method === "native.cancelPrompt")).toHaveLength(1);
      expect(gateway.calls.filter(c => c.method === "session.cancel")).toHaveLength(0);
    } finally { await adapter.destroy(); vi.useRealTimers(); }
  });

  it.each(["unknown", "different-session", "other-code"])("does not retry a %s admission result", async (kind) => {
    const { adapter, gateway } = createAdapter();
    try {
      const { sessionId } = await adapter.createSession(911);
      const error = kind === "unknown" ? new Error("session is already owned by an active write handle; transport closed") : new DeepSeekHarnessRpcError({ code: kind === "other-code" ? "session/agent-busy" : "session/writer-held", message: "writer is draining", details: { sessionId: kind === "different-session" ? "another-session" : sessionId } });
      gateway.responses.set("session.prompt", error);
      await expect(adapter.sendUserMessage(sessionId, { text: "do not replay", files: [] })).rejects.toBe(error);
      expect(gateway.calls.filter(c => c.method === "session.prompt")).toHaveLength(1);
    } finally { await adapter.destroy(); }
  });

  it("cancels an active turn on abort and never leaves its writer slot occupied", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(5);
    const controller = new AbortController();
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Long task",
      files: [],
      abortSignal: controller.signal,
    });
    await waitForCall(gateway, "session.prompt", 1);
    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    controller.abort();

    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    expect(gateway.calls).toContainEqual({
      method: "native.cancelPrompt",
      payload: { sessionId, sourceRpcId: expect.any(String) },
    });

    const second = adapter.sendUserMessage(sessionId, { text: "Next", files: [] });
    await waitForCall(gateway, "session.prompt", 2);
    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 2 }, 2);
    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 2,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "Recovered" },
    }, 3);
    gateway.emitSessionEvent(sessionId, "turn/end", { turn: 2, reason: completedReason() }, 4);
    await expect(second).resolves.toMatchObject({ text: "Recovered" });
  });

  it("waits for late prompt admission, withdraws its identity, and leaves the native goal running", async () => {
    let admitted!: (value: unknown) => void, stopped!: (value: { outcome: "removed" }) => void;
    const cancelPrompt = vi.fn((_session: string, _rpc: string) => new Promise<{ outcome: "removed" }>((resolve) => { stopped = resolve; }));
    const gateway = Object.assign(new FakeGateway(), { cancelPrompt }), { adapter } = createAdapter(gateway);
    const goalAbort = new AbortController(), ordinaryAbort = new AbortController(), goalEvents: EngineStreamEvent[] = [];
    try {
      const { sessionId } = await adapter.createSession(903);
      const goal = adapter.watchThreadGoal(sessionId, { objective: "keep writing", abortSignal: goalAbort.signal, onEngineEvent: (event) => { goalEvents.push(event); } });
      await waitForCall(gateway, "goal.create");
      await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
      await gateway.emitSessionEvent(sessionId, "user/message", { source: { kind: "goal", round: 1 } }, 2);
      gateway.responses.set("session.prompt", () => new Promise((resolve) => { admitted = resolve; }));
      const ordinary = adapter.sendUserMessage(sessionId, { text: "withdraw me", files: [], abortSignal: ordinaryAbort.signal });
      const rejected = expect(ordinary).rejects.toMatchObject({ name: "AbortError" });
      await waitForCall(gateway, "session.prompt");
      const prompt = gateway.calls.find((call) => call.method === "session.prompt")!.payload as { requestId: string };
      ordinaryAbort.abort(); await Promise.resolve(); expect(cancelPrompt).not.toHaveBeenCalled();
      admitted({ accepted: true });
      await vi.waitFor(() => expect(cancelPrompt).toHaveBeenCalledWith(sessionId, prompt.requestId));
      await expect(adapter.sendUserMessage(sessionId, { text: "too early", files: [] })).rejects.toThrow("already has an active turn");
      stopped({ outcome: "removed" }); await rejected;
      expect(gateway.calls.filter((call) => call.method === "session.cancel")).toHaveLength(0);
      await gateway.emitSessionEvent(sessionId, "assistant/chunk", { turn: 1, step: 1, chunk: { type: "text-delta", text: "goal continues" } }, 3);
      expect(goalEvents).toContainEqual(expect.objectContaining({ type: "assistant_text", text: "goal continues" }));
      goalAbort.abort(); await goal;
    } finally { goalAbort.abort(); await adapter.destroy(); }
  });

  it("surfaces an unknown exact-stop receipt without falling back to global cancellation", async () => {
    const cancelPrompt = vi.fn(async () => ({ outcome: "missing" as const }));
    const gateway = Object.assign(new FakeGateway(), { cancelPrompt }), { adapter } = createAdapter(gateway);
    try {
      const { sessionId } = await adapter.createSession(904), abort = new AbortController();
      const turn = adapter.sendUserMessage(sessionId, { text: "unknown admission", files: [], abortSignal: abort.signal });
      const rejected = expect(turn).rejects.toThrow("cancellation could not be confirmed");
      await waitForCall(gateway, "session.prompt"); abort.abort(); await rejected;
      expect(gateway.calls.filter((call) => call.method === "session.cancel")).toHaveLength(0);
      expect(gateway.calls.filter((call) => call.method === "session.prompt")).toHaveLength(1);
    } finally { await adapter.destroy(); }
  });

  it("does not replace unsupported exact cancellation with a session-wide stop", async () => {
    const gateway = new FakeGateway(); Object.defineProperty(gateway, "cancelPrompt", { value: undefined });
    const { adapter } = createAdapter(gateway);
    try {
      const { sessionId } = await adapter.createSession(905), abort = new AbortController();
      const turn = adapter.sendUserMessage(sessionId, { text: "cancel only this message", files: [], abortSignal: abort.signal });
      const rejected = expect(turn).rejects.toMatchObject({ name: "EngineCancellationUnconfirmedError" });
      await waitForCall(gateway, "session.prompt"); abort.abort(); await rejected;
      expect(gateway.calls.filter((call) => call.method === "session.cancel")).toHaveLength(0);
    } finally { await adapter.destroy(); }
  });

  it.each(["cancelled", "settled"] as const)("does not attach late %s or empty native turns to the next message", async (outcome) => {
    const { adapter, gateway } = createAdapter(); gateway.autoOrigins = false;
    gateway.responses.set("native.cancelPrompt", { outcome });
    try {
      const { sessionId } = await adapter.createSession(906), abort = new AbortController();
      const first = adapter.sendUserMessage(sessionId, { text: "first", files: [], abortSignal: abort.signal });
      const rejected = expect(first).rejects.toMatchObject({ name: outcome === "settled" ? "EngineStopTooLateError" : "AbortError" });
      await waitForCall(gateway, "session.prompt"); const oldId = gateway.lastPromptId(sessionId);
      abort.abort(); await rejected;
      let result: unknown;
      const second = adapter.sendUserMessage(sessionId, { text: "second", files: [] });
      void second.then((value) => { result = value; }, (error) => { result = error; });
      await waitForCall(gateway, "session.prompt", 2); const newId = gateway.lastPromptId(sessionId);
      await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
      await gateway.emitSessionEvent(sessionId, "user/message", { source: { kind: "user", rpcId: oldId } }, 2);
      await gateway.emitSessionEvent(sessionId, "assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "OLD OUTPUT" }] } }, 3);
      await gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: outcome === "settled" ? completedReason() : { kind: "aborted" } }, 4);
      await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 2 }, 5);
      await gateway.emitSessionEvent(sessionId, "turn/end", { turn: 2, reason: completedReason() }, 6);
      await new Promise((resolve) => setTimeout(resolve, 10)); expect(result).toBeUndefined();
      await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 3 }, 7);
      await gateway.emitSessionEvent(sessionId, "user/message", { source: { kind: "user", rpcId: "carried-steering" } }, 8);
      await gateway.emitSessionEvent(sessionId, "user/message", { source: { kind: "user", rpcId: newId } }, 9);
      await gateway.emitSessionEvent(sessionId, "assistant/message", { turn: 3, step: 1, message: { content: [{ type: "text", text: "SECOND OUTPUT" }] } }, 10);
      await gateway.emitSessionEvent(sessionId, "turn/end", { turn: 3, reason: completedReason() }, 11);
      await expect(second).resolves.toMatchObject({ text: "SECOND OUTPUT" });
    } finally { await adapter.destroy(); }
  });

  it("probes unknown admission without releasing the claim or replaying the input", async () => {
    const { adapter, gateway } = createAdapter(); let rejectAdmission!: (error: Error) => void;
    gateway.responses.set("session.prompt", () => new Promise((_resolve, reject) => { rejectAdmission = reject; }));
    let probes = 0;
    gateway.responses.set("native.cancelPrompt", () => ({ outcome: ++probes === 1 ? "missing" : "removed" }));
    try {
      const { sessionId } = await adapter.createSession(907), abort = new AbortController();
      const turn = adapter.sendUserMessage(sessionId, { text: "slow image admission", files: [], abortSignal: abort.signal });
      const rejected = expect(turn).rejects.toMatchObject({ name: "AbortError" });
      await waitForCall(gateway, "session.prompt"); abort.abort(); rejectAdmission(new Error("transport timeout"));
      await waitForCall(gateway, "native.cancelPrompt");
      await expect(adapter.sendUserMessage(sessionId, { text: "next", files: [] })).rejects.toThrow("already has an active turn");
      await rejected; expect(probes).toBe(2);
      expect(gateway.calls.filter((call) => call.method === "session.prompt")).toHaveLength(1);
    } finally { await adapter.destroy(); }
  });

  it("honors an abort that arrives while the Harness session is being created", async () => {
    const { adapter, gateway } = createAdapter();
    let resolveCreate!: (value: { sessionId: string; agentPreset: string }) => void;
    gateway.responses.set("session.create", () => new Promise((resolve) => {
      resolveCreate = resolve;
    }));
    gateway.responses.set("session.prompt", {
      command: { kind: "success", text: "should not run" },
    });
    const controller = new AbortController();
    const sessionId = "session-aborted-during-create";

    const turn = adapter.sendUserMessage(sessionId, {
      text: "Do not start this turn",
      files: [],
      abortSignal: controller.signal,
    });
    await waitForCall(gateway, "session.create", 1);
    controller.abort();
    resolveCreate({ sessionId, agentPreset: "standard" });

    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    expect(gateway.calls.filter((call) => call.method === "session.prompt")).toHaveLength(0);
  });

  it("does not let a late aborted turn end cancel the replacement foreground turn", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(5);
    const controller = new AbortController();
    const first = adapter.sendUserMessage(sessionId, {
      text: "Long task",
      files: [],
      abortSignal: controller.signal,
    });
    await waitForCall(gateway, "session.prompt", 1);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitSessionEvent(sessionId, "tool/call", {
      turn: 1,
      step: 1,
      callId: "old-call",
      name: "bash",
      arguments: JSON.stringify({ command: "sleep 30" }),
    }, 2);
    await gateway.emitMux({
      type: "session/jobs",
      sessionId,
      jobs: [{
        id: "old-job",
        kind: "bash",
        label: "sleep 30",
        status: "running",
        startedAt: Date.now(),
      }],
    });
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });

    const replacementApprovals: EngineApprovalRequest[] = [];
    const replacementEvents: EngineStreamEvent[] = [];
    const replacement = adapter.sendUserMessage(sessionId, {
      text: "Replacement",
      files: [],
      onApprovalRequest: async (request) => {
        replacementApprovals.push(request);
        return { behavior: "allow" };
      },
      onEngineEvent: (event) => {
        replacementEvents.push(event);
      },
    });
    await waitForCall(gateway, "session.prompt", 2);

    await gateway.emitMux({
      type: "approval/requested",
      sessionId,
      approvalId: "old-approval",
      callId: "old-call",
      toolName: "bash",
    }, "old-approval-rpc");
    await gateway.emitMux({
      type: "session/jobs",
      sessionId,
      jobs: [{
        id: "old-job",
        kind: "bash",
        label: "sleep 30",
        status: "killed",
        startedAt: Date.now() - 100,
        finishedAt: Date.now(),
      }],
    });
    expect(replacementApprovals).toHaveLength(0);
    expect(replacementEvents.some((event) => event.type === "background_task_finished")).toBe(false);
    expect(gateway.clientResponses).toContainEqual({
      rpcId: "old-approval-rpc",
      value: {
        sessionId,
        approvalId: "old-approval",
        outcome: "rejected",
      },
    });

    // Harness cancellation is asynchronous. The old terminal frame can arrive
    // after the bridge has released the writer and admitted the next turn.
    await gateway.emitSessionEvent(sessionId, "turn/end", {
      turn: 1,
      reason: { kind: "aborted" },
    }, 3);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 2 }, 4);
    await gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 2,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "Replacement survived" },
    }, 5);
    await gateway.emitSessionEvent(sessionId, "turn/end", {
      turn: 2,
      reason: completedReason(),
    }, 6);

    await expect(replacement).resolves.toMatchObject({ text: "Replacement survived" });
  });

  it("steers an active turn, configures model effort, and lists resumable sessions", async () => {
    const { adapter, gateway } = createAdapter(undefined, {
      model: {
        provider: "deepseek-official",
        model: "deepseek-v4",
        reasoningEffort: "high",
      },
    });
    gateway.responses.set("session.list", {
      items: [{
        sessionId: "session-existing",
        cwd: "/workspace",
        updatedAt: 1_787_000_000_000,
        running: false,
        blank: false,
        projections: {
          asOfSeq: 5,
          values: { title: { title: "Existing work" } },
        },
      }],
    });
    const { sessionId } = await adapter.createSession(6);
    const turn = adapter.sendUserMessage(sessionId, { text: "Start", files: [] });
    await waitForCall(gateway, "session.prompt", 1);
    expect(gateway.calls).toContainEqual({
      method: "session.selectModel",
      payload: {
        sessionId,
        provider: "deepseek-official",
        model: "deepseek-v4",
        reasoningEffort: "high",
      },
    });
    await expect(adapter.steerActiveTurn(sessionId, { text: "too early", throwOnError: true })).rejects.toMatchObject({ reason: "queued" });
    expect(gateway.calls.some((call) => call.method === "native.steerPrompt")).toBe(false);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await expect(adapter.steerActiveTurn(sessionId, { text: "Use the other file" })).resolves.toBe(true);
    expect(gateway.calls.at(-1)).toEqual({
      method: "native.steerPrompt",
      payload: {
        sessionId, sourceRpcId: gateway.lastPromptId(sessionId), expectedTurn: 1,
        requestId: expect.any(String), text: "Use the other file", clientTimeZone: "Asia/Shanghai",
      },
    });
    for (const outcome of ["stale", "queued", "not_ready", "unsupported"]) {
      gateway.responses.set("native.steerPrompt", { outcome });
      await expect(adapter.steerActiveTurn(sessionId, { text: "refused", throwOnError: true })).rejects.toMatchObject({ name: "EngineSteeringRejectedError", reason: outcome });
      await expect(adapter.steerActiveTurn(sessionId, { text: "automatic" })).resolves.toBe(false);
    }
    gateway.responses.set("native.steerPrompt", new Error("receipt lost"));
    await expect(adapter.steerActiveTurn(sessionId, { text: "uncertain", throwOnError: true })).rejects.toThrow("receipt lost");
    expect(gateway.calls.some((call) => call.method === "session.prompt" && (call.payload as any).mode === "steer")).toBe(false);
    await expect(adapter.listExternalSessions({ cwd: "/workspace", limit: 10 })).resolves.toEqual([{
      sessionId: "session-existing",
      cwd: "/workspace",
      title: "Existing work",
      updatedAt: new Date(1_787_000_000_000).toISOString(),
    }]);

    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "Done" },
    }, 2);
    gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 3);
    await expect(turn).resolves.toMatchObject({ text: "Done" });
  });

  it("fails closed when a resumed session is absent from the authoritative session list", async () => {
    const { adapter, gateway } = createAdapter();
    gateway.responses.set("session.list", { items: [] });
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: { asOfSeq: 0, values: {} },
    });

    await expect(adapter.validateExternalSession("unlisted-session", {
      workspaceOverride: "/workspace",
    })).rejects.toThrow("not present in session.list");
    expect(gateway.calls.some((call) => call.method === "session.history")).toBe(false);
  });

  it("rejects a listed resumed session whose workspace cannot be verified", async () => {
    const { adapter, gateway } = createAdapter();
    gateway.responses.set("session.list", {
      items: [{
        sessionId: "cwd-less-session",
        updatedAt: 1_787_000_000_000,
        running: false,
        blank: false,
      }],
    });

    await expect(adapter.validateExternalSession("cwd-less-session", {
      workspaceOverride: "/workspace",
    })).rejects.toThrow("has no verifiable workspace");
  });

  it("maps native goal projections and clears with the current CAS reference", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(7);
    const projection = {
      goal: {
        id: "goal-1",
        revision: 1,
        objective: "Finish parity",
        phase: "active",
        maxGoalRounds: 50,
      },
      roundsStarted: 2,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_010_000,
    };
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: {
        asOfSeq: 10,
        values: {
          goal: projection,
          tokenUsage: {
            uncachedInputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 30,
            cacheWriteTokens: 5,
          },
        },
      },
    });

    await expect(adapter.setThreadGoal(sessionId, {
      objective: "Finish parity",
      tokenBudget: 1_000,
    })).resolves.toMatchObject({
      sessionId,
      goal: {
        threadId: sessionId,
        objective: "Finish parity",
        status: "active",
        tokenBudget: 1_000,
        tokensUsed: 0,
      },
    });
    expect(gateway.calls).toContainEqual({
      method: "goal.create",
      payload: { sessionId, objective: "Finish parity" },
    });

    await expect(adapter.clearThreadGoal(sessionId)).resolves.toEqual({ cleared: true, sessionId });
    expect(gateway.calls.at(-1)).toEqual({
      method: "goal.clear",
      payload: { sessionId, ref: { id: "goal-1", revision: 1 } },
    });
  });

  it("pauses an active goal when goal-local usage reaches its token budget", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(19);
    const oldGoal = {
      goal: {
        id: "goal-old-budget",
        revision: 2,
        objective: "Old work",
        phase: "complete",
        maxGoalRounds: 50,
      },
      roundsStarted: 2,
      createdAt: 1_786_000_000_000,
      updatedAt: 1_786_000_100_000,
    };
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: {
        asOfSeq: 10,
        values: {
          goal: oldGoal,
          tokenUsage: {
            uncachedInputTokens: 800,
            outputTokens: 100,
            cacheReadTokens: 75,
            cacheWriteTokens: 25,
          },
        },
      },
    });
    gateway.responses.set("goal.create", { ref: { id: "goal-budget", revision: 1 } });
    gateway.responses.set("native.pauseGoalForBudget", { outcome: "paused", ref: { id: "goal-budget", revision: 2 } });
    const watch = adapter.watchThreadGoal(sessionId, {
      objective: "Budgeted work",
      tokenBudget: 100,
    });
    await waitForCall(gateway, "goal.create");
    await gateway.emitProjection(sessionId, "goal", {
      goal: {
        id: "goal-budget",
        revision: 1,
        objective: "Budgeted work",
        phase: "active",
        maxGoalRounds: 50,
      },
      roundsStarted: 1,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_001_000,
    }, 11);
    await gateway.emitProjection(sessionId, "tokenUsage", {
      uncachedInputTokens: 880,
      outputTokens: 120,
      cacheReadTokens: 80,
      cacheWriteTokens: 40,
    }, 12);

    expect(gateway.calls.some((call) => call.method === "native.pauseGoalForBudget")).toBe(false);
    await gateway.emitProjection(sessionId, "tarocubGoalUsage", { goalId: "goal-budget", tokensUsed: 120 }, 12);
    await waitForCall(gateway, "native.pauseGoalForBudget");
    expect(gateway.calls.find((call) => call.method === "native.pauseGoalForBudget")).toEqual({
      method: "native.pauseGoalForBudget",
      payload: {
        sessionId,
        ref: { id: "goal-budget", revision: 1 },
      },
    });
    await expect(watch).resolves.toMatchObject({
      goal: {
        objective: "Budgeted work",
        status: "budgetLimited",
        tokenBudget: 100,
        tokensUsed: 120,
      },
    });
  });

  it("restores a goal budget and native usage after the adapter process restarts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "deepseek-goal-state-"));
    try {
      const goalStatePath = path.join(dir, "goals.json");
      const first = createAdapter(undefined, { goalStatePath });
      const { sessionId } = await first.adapter.createSession(20);
      let firstHistoryCall = true;
      first.gateway.responses.set("session.history", () => {
        if (firstHistoryCall) {
          firstHistoryCall = false;
          return {
            events: [],
            hasMore: false,
            projections: {
              asOfSeq: 5,
              values: {
                tokenUsage: {
                  uncachedInputTokens: 400,
                  outputTokens: 50,
                  cacheReadTokens: 25,
                  cacheWriteTokens: 25,
                },
              },
            },
          };
        }
        return {
          events: [],
          hasMore: false,
          projections: {
            asOfSeq: 6,
            values: {
              goal: {
                goal: {
                  id: "goal-persisted",
                  revision: 1,
                  objective: "Persistent work",
                  phase: "active",
                  maxGoalRounds: 50,
                },
                roundsStarted: 0,
                createdAt: 1_787_000_000_000,
                updatedAt: 1_787_000_000_000,
              },
              tokenUsage: {
                uncachedInputTokens: 400,
                outputTokens: 50,
                cacheReadTokens: 25,
                cacheWriteTokens: 25,
              },
            },
          },
        };
      });
      first.gateway.responses.set("goal.create", { ref: { id: "goal-persisted", revision: 1 } });
      await first.adapter.setThreadGoal(sessionId, {
        objective: "Persistent work",
        tokenBudget: 500,
      });
      await first.adapter.destroy();

      const second = createAdapter(undefined, { goalStatePath });
      second.gateway.responses.set("session.history", {
        events: [],
        hasMore: false,
        projections: {
          asOfSeq: 7,
          values: {
            goal: {
              goal: {
                id: "goal-persisted",
                revision: 1,
                objective: "Persistent work",
                phase: "active",
                maxGoalRounds: 50,
              },
              roundsStarted: 1,
              createdAt: 1_787_000_000_000,
              updatedAt: 1_787_000_001_000,
            },
            tarocubGoalUsage: { goalId: "goal-persisted", tokensUsed: 30 },
            tokenUsage: {
              uncachedInputTokens: 42000,
              outputTokens: 55,
              cacheReadTokens: 30,
              cacheWriteTokens: 25,
            },
          },
        },
      });

      await expect(second.adapter.getThreadGoal(sessionId)).resolves.toMatchObject({
        goal: {
          tokenBudget: 500,
          tokensUsed: 30,
          status: "active",
        },
      });
      await second.adapter.destroy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails before mutating a goal when the native usage projection is unavailable", async () => {
    const { adapter, gateway } = createAdapter(); gateway.autoGoalUsage = false;
    const { sessionId } = await adapter.createSession(30);
    gateway.responses.set("session.history", { events: [], hasMore: false, projections: { asOfSeq: 1, values: {
      goal: { goal: { id: "old-goal", revision: 2, phase: "active", objective: "Old work", maxGoalRounds: 50 }, roundsStarted: 1, createdAt: 1000, updatedAt: 2000 },
    } } });
    await expect(adapter.setThreadGoal(sessionId, { objective: "Preserve old work", tokenBudget: 100 })).rejects.toThrow("usage is unavailable");
    expect(gateway.calls.some((call) => ["goal.create", "goal.clear", "goal.pause"].includes(call.method))).toBe(false);
    await adapter.destroy();
  });

  it("migrates v1 budget state without using its session-wide baseline", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "deepseek-goal-migration-"));
    const goalStatePath = path.join(dir, "goals.json"), sessionId = "migrated-session";
    const projection = { goal: { id: "migrated-goal", revision: 1, phase: "active", objective: "Migration", maxGoalRounds: 50 }, roundsStarted: 1, createdAt: 1000, updatedAt: 2000 };
    await writeFile(goalStatePath, JSON.stringify({ version: 1, sessions: { [sessionId]: { goalId: "migrated-goal", tokenBudget: 100, baselineTokens: 500 } } }));
    const { adapter, gateway } = createAdapter(undefined, { goalStatePath }); gateway.autoGoalUsage = false;
    try {
      const values = { goal: projection, tokenUsage: { uncachedInputTokens: 50000 }, tarocubGoalUsage: { goalId: "migrated-goal", tokensUsed: 30 } };
      gateway.responses.set("session.history", { events: [], hasMore: false, projections: { asOfSeq: 5, values } });
      await expect(adapter.getThreadGoal(sessionId)).resolves.toMatchObject({ goal: { tokensUsed: 30, tokenBudget: 100, status: "active", usageScope: "nativeGoalTurns" } });
      expect(gateway.calls.some((call) => /pause/i.test(call.method))).toBe(false);
      await adapter.clearThreadGoal(sessionId);
      expect(JSON.parse(await readFile(goalStatePath, "utf8"))).toEqual({ version: 2, sessions: {} });
    } finally { await adapter.destroy(); await rm(dir, { recursive: true, force: true }); }
  });

  it("reports an unavailable isolated budget pause without falling back to session-wide cancellation", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(31);
    gateway.responses.set("native.pauseGoalForBudget", { outcome: "unsupported" });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const watch = adapter.watchThreadGoal(sessionId, { objective: "Scoped pause", tokenBudget: 1 }).catch((error) => error);
    try {
      await waitForCall(gateway, "goal.create");
      await gateway.emitProjection(sessionId, "goal", { goal: { id: "goal-1", revision: 1, phase: "active", objective: "Scoped pause", maxGoalRounds: 50 }, roundsStarted: 1, createdAt: 1000, updatedAt: 2000 }, 1);
      await gateway.emitProjection(sessionId, "tarocubGoalUsage", { goalId: "goal-1", tokensUsed: 10 }, 2);
      expect(await watch).toEqual(expect.objectContaining({ message: expect.stringContaining("isolated goal budget pause unsupported") }));
      expect(gateway.calls.some((call) => ["goal.pause", "session.cancel"].includes(call.method))).toBe(false);
    } finally { errorLog.mockRestore(); await adapter.destroy(); }
  });

  it("keeps an unbounded goal usable but explicitly marks mismatched usage unavailable", async () => {
    const { adapter, gateway } = createAdapter(); gateway.autoGoalUsage = false;
    gateway.responses.set("session.history", { events: [], hasMore: false, projections: { asOfSeq: 5, values: {
      goal: { goal: { id: "new-goal", revision: 1, phase: "active", objective: "New work", maxGoalRounds: 50 }, roundsStarted: 0, createdAt: 1000, updatedAt: 2000 },
      tarocubGoalUsage: { goalId: "old-goal", tokensUsed: 9000 },
    } } });
    await expect(adapter.getThreadGoal("session")).resolves.toMatchObject({ goal: { status: "active", usageScope: "unavailable", tokenBudget: null } });
    expect(gateway.calls.some((call) => /pause/i.test(call.method))).toBe(false); await adapter.destroy();
  });

  it("keeps watching a natively paused goal until it reaches a terminal status", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(21);
    const watch = adapter.watchThreadGoal(sessionId, { objective: "Wait through pause" });
    let settled = false;
    void watch.finally(() => { settled = true; });
    await waitForCall(gateway, "goal.create");

    const projection = {
      goal: {
        id: "goal-1",
        revision: 2,
        objective: "Wait through pause",
        phase: "paused" as "paused" | "complete",
        maxGoalRounds: 50,
      },
      roundsStarted: 1,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_001_000,
    };
    await gateway.emitProjection(sessionId, "goal", projection, 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    projection.goal.phase = "complete";
    projection.goal.revision = 3;
    projection.updatedAt += 1_000;
    await gateway.emitProjection(sessionId, "goal", projection, 2);
    await expect(watch).resolves.toMatchObject({ goal: { status: "complete" } });
    await adapter.destroy();
  });

  it("prefers completion learned from a stale budget pause reply before final turn end", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(33);
    const watch = adapter.watchThreadGoal(sessionId, { objective: "Completion race", tokenBudget: 10 });
    await waitForCall(gateway, "goal.create");
    const projection = { goal: { id: "goal-1", revision: 1, phase: "active", objective: "Completion race", maxGoalRounds: 50 }, roundsStarted: 1, createdAt: 1000, updatedAt: 2000 };
    await gateway.emitProjection(sessionId, "goal", projection, 1);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 2);
    await gateway.emitSessionEvent(sessionId, "user/message", { source: { kind: "goal", goalId: "goal-1", round: 1 } }, 3);
    gateway.responses.set("native.pauseGoalForBudget", () => {
      gateway.responses.set("session.history", { events: [], hasMore: false, projections: { asOfSeq: 10, values: {
        goal: { ...projection, goal: { ...projection.goal, phase: "complete", revision: 2 } }, tarocubGoalUsage: { goalId: "goal-1", tokensUsed: 20 },
      } } });
      return { outcome: "stale" };
    });
    await gateway.emitProjection(sessionId, "tarocubGoalUsage", { goalId: "goal-1", tokensUsed: 20 }, 4);
    // No completion frame is delivered; the CAS refresh consumed its watermark.
    await gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: { kind: "completed" } }, 11);
    await expect(watch).resolves.toMatchObject({ goal: { status: "complete", tokensUsed: 20 } });
    expect(gateway.calls.some((call) => call.method === "native.pauseGoalForBudget")).toBe(true);
    expect(gateway.calls.some((call) => call.method === "goal.clear")).toBe(false);
    await adapter.destroy();
  });

  it.each(["missing-key", "missing-snapshot"])("stops owned budget continuation when a snapshot loses accounting: %s", async (failure) => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(34);
    await adapter.setThreadGoal(sessionId, { objective: "Protected work", tokenBudget: 10 });
    const projection = { goal: { id: "goal-1", revision: 1, phase: "active", objective: "Protected work", maxGoalRounds: 50 }, roundsStarted: 1, createdAt: 1000, updatedAt: 2000 };
    await gateway.emitProjection(sessionId, "goal", projection, 5);
    gateway.autoGoalUsage = false;
    gateway.responses.set("session.history", { events: [], hasMore: false, ...(failure === "missing-key" ? { projections: { asOfSeq: 5, values: { goal: projection } } } : {}) });
    await expect(adapter.getThreadGoal(sessionId)).rejects.toThrow("Goal cleared to stop automatic continuation");
    expect(gateway.calls.filter((call) => call.method === "goal.clear")).toEqual([{ method: "goal.clear", payload: { sessionId, ref: { id: "goal-1", revision: 1 } } }]);
    expect(gateway.calls.some((call) => ["goal.pause", "session.cancel"].includes(call.method))).toBe(false);
    await expect(adapter.setThreadGoal(sessionId, { objective: "Cannot meter", tokenBudget: 10 })).rejects.toThrow(/unavailable/);
    expect(gateway.calls.filter((call) => call.method === "goal.create")).toHaveLength(1);
    await adapter.destroy();
  });

  it("context snapshots enforce budget even without a goal watcher or a new frame", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(35);
    await adapter.setThreadGoal(sessionId, { objective: "Observed budget", tokenBudget: 10 });
    const projection = { goal: { id: "goal-1", revision: 1, phase: "active", objective: "Observed budget", maxGoalRounds: 50 }, roundsStarted: 1, createdAt: 1000, updatedAt: 2000 };
    gateway.responses.set("session.history", { events: [], hasMore: false, projections: { asOfSeq: 5, values: { goal: projection, tarocubGoalUsage: { goalId: "goal-1", tokensUsed: 20 } } } });
    expect(await adapter.getContextUsage(sessionId)).toBeNull();
    expect(gateway.calls.filter((call) => call.method === "native.pauseGoalForBudget")).toHaveLength(1);
    await adapter.destroy();
  });

  it("does not erase a replacement goal's state while an emergency clear reply is in flight", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "deepseek-goal-clear-race-")), goalStatePath = path.join(dir, "goals.json");
    const { adapter, gateway } = createAdapter(undefined, { goalStatePath });
    const { sessionId } = await adapter.createSession(37);
    const projection = { goal: { id: "goal-1", revision: 1, phase: "active", objective: "Old", maxGoalRounds: 50 }, roundsStarted: 1, createdAt: 1000, updatedAt: 2000 };
    gateway.responses.set("native.pauseGoalForBudget", { outcome: "unsupported" });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const watch = adapter.watchThreadGoal(sessionId, { objective: "Old", tokenBudget: 1 }).catch((error) => error);
    try {
      await waitForCall(gateway, "goal.create");
      await gateway.emitProjection(sessionId, "goal", projection, 1);
      gateway.responses.set("goal.clear", async () => {
        gateway.responses.set("session.history", { events: [], hasMore: false, projections: { asOfSeq: 10, values: {
          goal: { ...projection, goal: { ...projection.goal, id: "new-goal", objective: "New" } }, tarocubGoalUsage: { goalId: "new-goal", tokensUsed: 0 },
        } } });
        await adapter.getThreadGoal(sessionId); // Native replacement observed before the old clear receipt.
        return { cleared: true };
      });
      await gateway.emitProjection(sessionId, "tarocubGoalUsage", { goalId: "goal-1", tokensUsed: 10 }, 2);
      expect(await watch).toBeInstanceOf(Error);
      expect(JSON.parse(await readFile(goalStatePath, "utf8")).sessions[sessionId]).toEqual({ goalId: "new-goal", tokenBudget: null });
      await expect(adapter.getThreadGoal(sessionId)).resolves.toMatchObject({ goal: { objective: "New", status: "active" } });
    } finally { errorLog.mockRestore(); await adapter.destroy(); await rm(dir, { recursive: true, force: true }); }
  });

  it("allows an unbounded goal when the native usage plugin is unavailable", async () => {
    const { adapter, gateway } = createAdapter(); gateway.autoGoalUsage = false;
    const { sessionId } = await adapter.createSession(36);
    await expect(adapter.setThreadGoal(sessionId, { objective: "Unbounded compatibility" })).resolves.toMatchObject({ goal: { status: "active", tokenBudget: null, usageScope: "unavailable" } });
    expect(gateway.calls.some((call) => call.method === "goal.create")).toBe(true); await adapter.destroy();
  });

  it("does not deadlock recovery behind a budget pause waiting for the replacement host", async () => {
    const { adapter, gateway } = createAdapter(); const { sessionId } = await adapter.createSession(38);
    const projection = { goal: { id: "goal-1", revision: 1, phase: "active", objective: "Recover budget", maxGoalRounds: 50 }, roundsStarted: 1, createdAt: 1000, updatedAt: 2000 };
    const watch = adapter.watchThreadGoal(sessionId, { objective: "Recover budget", tokenBudget: 10 }).catch((error) => error);
    await waitForCall(gateway, "goal.create"); await gateway.emitProjection(sessionId, "goal", projection, 1);
    let release!: () => void; const pauseGate = new Promise<void>((resolve) => { release = resolve; });
    gateway.responses.set("native.pauseGoalForBudget", async () => { await pauseGate; return { outcome: "paused", ref: { id: "goal-1", revision: 2 } }; });
    const frame = gateway.emitProjection(sessionId, "tarocubGoalUsage", { goalId: "goal-1", tokensUsed: 20 }, 2);
    await waitForCall(gateway, "native.pauseGoalForBudget");
    gateway.responses.set("session.history", { events: [], hasMore: false, projections: { asOfSeq: 2, values: { goal: projection, tarocubGoalUsage: { goalId: "goal-1", tokensUsed: 20 } } } });
    let done = false;
    const recovery = Promise.resolve(gateway.handlers?.onReconnect?.({ reason: "host-restart" })).then(() => { done = true; });
    // Also cover the recovery drain, which cannot wait for the old frame chain.
    await gateway.emitMux({ type: "session/projection", sessionId, key: "contextPressure", value: { pressureTokens: 20 }, seq: 3 });
    try {
      await vi.waitFor(() => expect(done).toBe(true), { timeout: 500 });
      expect(gateway.calls.some((call) => call.method === "goal.resume")).toBe(false);
    } finally {
      release(); await Promise.allSettled([frame, recovery]); await adapter.destroy(); await watch;
    }
  });

  it.each(["rpc-failure", "missing-snapshot", "missing-key"])("keeps an in-budget goal when accounting recovers after %s", async (failure) => {
    const { adapter, gateway } = createAdapter(); const { sessionId } = await adapter.createSession(39);
    await adapter.setThreadGoal(sessionId, { objective: "Keep working", tokenBudget: 100 });
    const projection = { goal: { id: "goal-1", revision: 1, phase: "active", objective: "Keep working", maxGoalRounds: 50 }, roundsStarted: 1, createdAt: 1000, updatedAt: 2000 };
    await gateway.emitProjection(sessionId, "goal", projection, 1);
    await gateway.emitProjection(sessionId, "tarocubGoalUsage", { goalId: "goal-1", tokensUsed: 10 }, 2);
    gateway.autoGoalUsage = false; let calls = 0;
    gateway.responses.set("session.history", () => {
      calls++;
      if (calls === 1) {
        if (failure === "rpc-failure") throw new Error("transient read error");
        if (failure === "missing-snapshot") return { events: [], hasMore: false };
        return { events: [], hasMore: false, projections: { asOfSeq: 3, values: { goal: projection } } };
      }
      return { events: [], hasMore: false, projections: { asOfSeq: 3, values: { goal: projection, tarocubGoalUsage: { goalId: "goal-1", tokensUsed: 10 } } } };
    });
    await expect(adapter.getThreadGoal(sessionId)).resolves.toMatchObject({ goal: { status: "active", tokenBudget: 100, tokensUsed: 10, usageScope: "nativeGoalTurns" } });
    expect(calls).toBe(2);
    expect(gateway.calls.some((call) => ["goal.clear", "goal.pause", "native.pauseGoalForBudget"].includes(call.method))).toBe(false);
    await adapter.destroy();
  });

  it("settles the matching watcher when a status query must stop unmetered continuation", async () => {
    const { adapter, gateway } = createAdapter(); const { sessionId } = await adapter.createSession(40);
    const watch = adapter.watchThreadGoal(sessionId, { objective: "Observed clear", tokenBudget: 100 }).catch((error) => error);
    await waitForCall(gateway, "goal.create");
    const projection = { goal: { id: "goal-1", revision: 1, phase: "active", objective: "Observed clear", maxGoalRounds: 50 }, roundsStarted: 1, createdAt: 1000, updatedAt: 2000 };
    await gateway.emitProjection(sessionId, "goal", projection, 1);
    gateway.autoGoalUsage = false;
    gateway.responses.set("session.history", { events: [], hasMore: false, projections: { asOfSeq: 3, values: { goal: projection } } });
    await expect(adapter.getThreadGoal(sessionId)).rejects.toThrow("Goal cleared to stop automatic continuation");
    expect(await watch).toEqual(expect.objectContaining({ message: expect.stringContaining("Goal cleared to stop automatic continuation") }));
    await adapter.destroy();
  });

  it("prefers native completion when the first refresh after failed pause also fails", async () => {
    const { adapter, gateway } = createAdapter(); const { sessionId } = await adapter.createSession(41);
    const watch = adapter.watchThreadGoal(sessionId, { objective: "Late completion", tokenBudget: 1 });
    await waitForCall(gateway, "goal.create");
    const projection = { goal: { id: "goal-1", revision: 1, phase: "active", objective: "Late completion", maxGoalRounds: 50 }, roundsStarted: 1, createdAt: 1000, updatedAt: 2000 };
    await gateway.emitProjection(sessionId, "goal", projection, 1);
    gateway.responses.set("native.pauseGoalForBudget", () => {
      let reads = 0;
      gateway.responses.set("session.history", () => {
        if (++reads === 1) throw new Error("refresh unavailable");
        return { events: [], hasMore: false, projections: { asOfSeq: 5, values: { goal: { ...projection, goal: { ...projection.goal, revision: 2, phase: "complete" } }, tarocubGoalUsage: { goalId: "goal-1", tokensUsed: 10 } } } };
      });
      return { outcome: "unsupported" };
    });
    await gateway.emitProjection(sessionId, "tarocubGoalUsage", { goalId: "goal-1", tokensUsed: 10 }, 2);
    await expect(watch).resolves.toMatchObject({ goal: { status: "complete", tokensUsed: 10 } });
    expect(gateway.calls.some((call) => call.method === "goal.clear")).toBe(false);
    await adapter.destroy();
  });

  it("does not claim a cold persisted goal has stopped when all reads fail", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "deepseek-budget-unconfirmed-")), goalStatePath = path.join(dir, "goals.json");
    await writeFile(goalStatePath, JSON.stringify({ version: 2, sessions: { cold: { goalId: "cold-goal", tokenBudget: 100 } } }));
    const { adapter, gateway } = createAdapter(undefined, { goalStatePath }); gateway.responses.set("session.history", new Error("read unavailable"));
    try {
      await expect(adapter.getContextUsage("cold")).rejects.toThrow("Goal stop could not be confirmed");
      expect(gateway.calls.some((call) => call.method === "goal.clear")).toBe(false);
    } finally { await adapter.destroy(); await rm(dir, { recursive: true, force: true }); }
  });

  it("reports a completed goal as complete even when its local budget is exhausted", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(22);
    const watch = adapter.watchThreadGoal(sessionId, {
      objective: "Finish at the boundary",
      tokenBudget: 10,
    });
    await waitForCall(gateway, "goal.create");
    await gateway.emitProjection(sessionId, "tarocubGoalUsage", { goalId: "goal-1", tokensUsed: 20 }, 1);
    await gateway.emitProjection(sessionId, "tokenUsage", {
      uncachedInputTokens: 20,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }, 1);
    await gateway.emitProjection(sessionId, "goal", {
      goal: {
        id: "goal-1",
        revision: 2,
        objective: "Finish at the boundary",
        phase: "complete",
        maxGoalRounds: 50,
      },
      roundsStarted: 1,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_001_000,
    }, 2);

    await expect(watch).resolves.toMatchObject({
      goal: { status: "complete", tokenBudget: 10, tokensUsed: 20 },
    });
    expect(gateway.calls.filter((call) => ["goal.pause", "native.pauseGoalForBudget"].includes(call.method))).toHaveLength(0);
    await adapter.destroy();
  });

  it("removes persisted goal budget state when Harness removes the session", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "deepseek-removed-session-"));
    try {
      const goalStatePath = path.join(dir, "goals.json");
      const { adapter, gateway } = createAdapter(undefined, { goalStatePath });
      const { sessionId } = await adapter.createSession(23);
      gateway.responses.set("goal.create", { ref: { id: "goal-removed", revision: 1 } });
      await adapter.setThreadGoal(sessionId, {
        objective: "Will be removed",
        tokenBudget: 250,
      });
      await gateway.emitHost({ type: "host/session-removed", sessionId });

      const persisted = JSON.parse(await readFile(goalStatePath, "utf8")) as {
        sessions: Record<string, unknown>;
      };
      expect(persisted.sessions).not.toHaveProperty(sessionId);
      await adapter.destroy();

      const second = createAdapter(undefined, { goalStatePath });
      second.gateway.responses.set("session.history", {
        events: [],
        hasMore: false,
        projections: {
          asOfSeq: 1,
          values: {
            goal: {
              goal: {
                id: "goal-removed",
                revision: 1,
                objective: "External replacement",
                phase: "active",
                maxGoalRounds: 50,
              },
              roundsStarted: 1,
              createdAt: 1_787_000_000_000,
              updatedAt: 1_787_000_001_000,
            },
            tokenUsage: {
              uncachedInputTokens: 500,
              outputTokens: 25,
              cacheReadTokens: 5,
              cacheWriteTokens: 0,
            },
          },
        },
      });
      await expect(second.adapter.getThreadGoal(sessionId)).resolves.toMatchObject({
        goal: { tokenBudget: null, tokensUsed: 0, status: "active" },
      });
      await second.adapter.destroy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("streams autonomous goal turns without consuming or settling a concurrent user turn", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(8);
    let goalProjection = {
      goal: {
        id: "goal-live",
        revision: 1,
        objective: "Finish parity",
        phase: "active" as "active" | "complete",
        maxGoalRounds: 50,
      },
      roundsStarted: 0,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_000_000,
    };
    gateway.responses.set("session.history", () => ({
      events: [],
      hasMore: false,
      projections: { asOfSeq: 0, values: { goal: goalProjection } },
    }));
    gateway.responses.set("goal.create", { ref: { id: "goal-live", revision: 1 } });

    const goalEvents: EngineStreamEvent[] = [];
    const goalWatch = adapter.watchThreadGoal(sessionId, {
      objective: "Finish parity",
      onEngineEvent: (event) => {
        goalEvents.push(event);
      },
    });
    await waitForCall(gateway, "goal.create");

    const userEvents: EngineStreamEvent[] = [];
    const userTurn = adapter.sendUserMessage(sessionId, {
      text: "Give me a status update",
      files: [],
      onEngineEvent: (event) => {
        userEvents.push(event);
      },
    });
    await waitForCall(gateway, "session.prompt", 1);

    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitSessionEvent(sessionId, "user/message", {
      id: "goal-message",
      role: "user",
      content: [{ type: "text", text: "goal round" }],
      source: { kind: "goal", goalId: "goal-live", revision: 1, round: 1 },
    }, 2);
    gateway.emitSessionEvent(sessionId, "assistant/message", {
      turn: 1,
      step: 1,
      message: {
        id: "goal-assistant-message",
        role: "assistant",
        content: [
          { type: "reasoning", text: "goal-private-thinking" },
          { type: "text", text: "goal-only output" },
        ],
      },
    }, 3);
    gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 4);

    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 2 }, 5);
    gateway.emitSessionEvent(sessionId, "user/message", {
      id: "user-message",
      role: "user",
      content: [{ type: "text", text: "Give me a status update" }],
      source: { kind: "user", rpcId: gateway.lastPromptId(sessionId) },
    }, 6);
    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 2,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "user-only output" },
    }, 7);
    gateway.emitSessionEvent(sessionId, "turn/end", { turn: 2, reason: completedReason() }, 8);

    await expect(userTurn).resolves.toMatchObject({ text: "user-only output" });
    expect(userEvents.filter((event) => event.type === "assistant_text").map((event) => event.text)).toEqual([
      "user-only output",
    ]);
    expect(goalEvents.filter((event) => event.type === "assistant_text").map((event) => event.text)).toEqual([
      "goal-only output",
    ]);
    expect(goalEvents.filter((event) => event.type === "thinking").map((event) => event.text)).toEqual([
      "goal-private-thinking",
    ]);

    goalProjection = {
      ...goalProjection,
      goal: { ...goalProjection.goal, phase: "complete" },
      roundsStarted: 1,
      updatedAt: 1_787_000_001_000,
    };
    gateway.emitProjection(sessionId, "goal", goalProjection, 9);
    await expect(goalWatch).resolves.toMatchObject({
      goal: { status: "complete", objective: "Finish parity" },
    });
  });

  it("resolves an aborted goal watcher with its latest state instead of reporting a failure", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(9);
    const activeGoal = {
      goal: {
        id: "goal-abort",
        revision: 1,
        objective: "Long-running audit",
        phase: "active",
        maxGoalRounds: 50,
      },
      roundsStarted: 2,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_002_000,
    };
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: { asOfSeq: 2, values: { goal: activeGoal } },
    });
    gateway.responses.set("goal.create", { ref: { id: "goal-abort-new", revision: 1 } });
    const controller = new AbortController();
    const watch = adapter.watchThreadGoal(sessionId, {
      objective: "Long-running audit",
      abortSignal: controller.signal,
    });
    await waitForCall(gateway, "goal.create");

    controller.abort();

    await expect(watch).resolves.toMatchObject({
      sessionId,
      goal: { status: "active", objective: "Long-running audit" },
    });
  });

  it.each([false, true])("fences goal cancellation from ordinary turns (already admitted: %s)", async (alreadyAdmitted) => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(901);
    const controller = new AbortController();
    const watch = adapter.watchThreadGoal(sessionId, { objective: "long goal", abortSignal: controller.signal });
    await waitForCall(gateway, "goal.create");
    const projection = { goal: { id: "goal-1", revision: 1, objective: "long goal", phase: "active", maxGoalRounds: 50 }, roundsStarted: 1, createdAt: Date.now(), updatedAt: Date.now() };
    gateway.responses.set("session.history", { events: [], hasMore: false, projections: { asOfSeq: 3, values: { goal: projection } } });
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitSessionEvent(sessionId, "user/message", { source: { kind: "goal", round: 1 } }, 2);
    await gateway.emitProjection(sessionId, "goal", projection, 3);
    let releaseCancel!: () => void;
    gateway.responses.set("session.cancel", () => new Promise((resolve) => { releaseCancel = () => resolve({ accepted: true }); }));
    let ordinary: Promise<unknown>;
    if (alreadyAdmitted) {
      ordinary = adapter.sendUserMessage(sessionId, { text: "ordinary", files: [] });
      await waitForCall(gateway, "session.prompt");
      controller.abort(); await watch;
      expect(gateway.calls.filter((call) => call.method === "session.cancel")).toHaveLength(0);
    } else {
      controller.abort();
      await waitForCall(gateway, "session.cancel");
      const methods = gateway.calls.map((call) => call.method);
      expect(methods.lastIndexOf("goal.clear")).toBeLessThan(methods.indexOf("session.cancel"));
      ordinary = adapter.sendUserMessage(sessionId, { text: "ordinary", files: [] });
      // Let preparation finish while the real cancellation receipt is held.
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(gateway.calls.filter((call) => call.method === "session.prompt")).toHaveLength(0);
      releaseCancel(); await watch;
      await waitForCall(gateway, "session.prompt");
    }
    await gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: { kind: "aborted" } }, 4);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 2 }, 5);
    await gateway.emitSessionEvent(sessionId, "user/message", { source: { kind: "user", rpcId: gateway.lastPromptId(sessionId) } }, 6);
    await gateway.emitSessionEvent(sessionId, "assistant/message", { turn: 2, step: 1, message: { content: [{ type: "text", text: "ordinary answer survives" }] } }, 7);
    await gateway.emitSessionEvent(sessionId, "turn/end", { turn: 2, reason: completedReason() }, 8);
    await expect(ordinary).resolves.toMatchObject({ text: "ordinary answer survives" });
    await adapter.destroy();
  });

  it("keeps final goal text after the native goal is marked complete but before turn/end", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(902), events: EngineStreamEvent[] = [];
    const watch = adapter.watchThreadGoal(sessionId, { objective: "compute", onEngineEvent: (event) => { events.push(event); } });
    await waitForCall(gateway, "goal.create");
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitSessionEvent(sessionId, "user/message", { source: { kind: "goal", round: 1 } }, 2);
    let settled = false; void watch.then(() => { settled = true; });
    await gateway.emitProjection(sessionId, "goal", { goal: { id: "goal-1", revision: 2, objective: "compute", phase: "complete", maxGoalRounds: 50 }, roundsStarted: 1, createdAt: Date.now(), updatedAt: Date.now() }, 3);
    expect(settled).toBe(false);
    await gateway.emitSessionEvent(sessionId, "assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "SUM:789" }] } }, 4);
    expect(settled).toBe(false);
    await gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 5);
    await expect(watch).resolves.toMatchObject({ goal: { status: "complete" } });
    expect(events.filter((event) => event.type === "assistant_text").map((event) => event.text)).toEqual(["SUM:789"]);
    await adapter.destroy();
  });

  it("keeps watching an unbounded goal through failed fallback projection reads", async () => {
    vi.useFakeTimers();
    const { adapter, gateway } = createAdapter();
    try {
      const { sessionId } = await adapter.createSession(903);
      const active = { goal: { id: "goal-1", revision: 1, objective: "keep going", phase: "active", maxGoalRounds: 50 }, roundsStarted: 1, createdAt: 1000, updatedAt: 2000 };
      let settled = false;
      const watch = adapter.watchThreadGoal(sessionId, { objective: "keep going" });
      void watch.then(() => { settled = true; }, () => { settled = true; });
      await waitForCall(gateway, "goal.create");
      let failures = 0;
      gateway.responses.set("session.history", () => {
        failures++;
        throw new DeepSeekHarnessRpcError({ code: "transport/timeout", message: "host did not answer in time" });
      });
      await vi.advanceTimersByTimeAsync(10_000);
      // The native goal keeps running: the watch stays its owner and backs off.
      expect(settled).toBe(false);
      expect(failures).toBeGreaterThan(1);
      expect(failures).toBeLessThan(10);
      gateway.responses.set("session.history", { events: [], hasMore: false, projections: { asOfSeq: 7, values: { goal: { ...active, goal: { ...active.goal, revision: 2, phase: "complete" } } } } });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(watch).resolves.toMatchObject({ goal: { status: "complete" } });
      expect(gateway.calls.some((call) => ["goal.clear", "goal.pause", "session.cancel", "native.pauseGoalForBudget"].includes(call.method))).toBe(false);
    } finally { await adapter.destroy(); vi.useRealTimers(); }
  });

  it("keeps the budget stop for a bounded goal whose fallback reads fail", async () => {
    vi.useFakeTimers();
    const { adapter, gateway } = createAdapter();
    try {
      const { sessionId } = await adapter.createSession(904);
      const watch = adapter.watchThreadGoal(sessionId, { objective: "bounded", tokenBudget: 100 }).catch((error) => error);
      await waitForCall(gateway, "goal.create");
      await gateway.emitProjection(sessionId, "goal", { goal: { id: "goal-1", revision: 1, objective: "bounded", phase: "active", maxGoalRounds: 50 }, roundsStarted: 1, createdAt: 1000, updatedAt: 2000 }, 1);
      gateway.responses.set("session.history", new Error("read unavailable"));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await watch).toEqual(expect.objectContaining({ message: expect.stringContaining("Goal cleared to stop automatic continuation") }));
      expect(gateway.calls.some((call) => call.method === "goal.clear")).toBe(true);
    } finally { await adapter.destroy(); vi.useRealTimers(); }
  });

  it("clears a prior durable goal before creating a fresh watched goal", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(10);
    const oldGoal = {
      goal: {
        id: "goal-old",
        revision: 4,
        objective: "Old objective",
        phase: "complete",
        maxGoalRounds: 50,
      },
      roundsStarted: 17,
      createdAt: 1_786_000_000_000,
      updatedAt: 1_786_000_100_000,
    };
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: { asOfSeq: 20, values: { goal: oldGoal } },
    });
    gateway.responses.set("goal.create", { ref: { id: "goal-new", revision: 1 } });

    const watch = adapter.watchThreadGoal(sessionId, { objective: "Fresh objective" });
    await waitForCall(gateway, "goal.create");

    const clearIndex = gateway.calls.findIndex((call) => call.method === "goal.clear");
    const createIndex = gateway.calls.findIndex((call) => call.method === "goal.create");
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeGreaterThan(clearIndex);

    gateway.emitProjection(sessionId, "goal", {
      ...oldGoal,
      goal: {
        ...oldGoal.goal,
        id: "goal-new",
        revision: 1,
        objective: "Fresh objective",
        phase: "complete",
      },
      roundsStarted: 1,
      updatedAt: 1_787_000_001_000,
    }, 21);
    await expect(watch).resolves.toMatchObject({ goal: { objective: "Fresh objective" } });
  });

  it("creates a fresh active goal instead of editing a terminal goal in place", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(11);
    let projection: unknown = {
      goal: {
        id: "goal-terminal",
        revision: 3,
        objective: "Finished work",
        phase: "complete",
        maxGoalRounds: 50,
      },
      roundsStarted: 9,
      createdAt: 1_786_000_000_000,
      updatedAt: 1_786_000_100_000,
    };
    let projectionSeq = 30;
    gateway.responses.set("session.history", () => ({
      events: [],
      hasMore: false,
      projections: { asOfSeq: projectionSeq, values: { goal: projection } },
    }));
    gateway.responses.set("goal.clear", () => {
      projection = null;
      projectionSeq += 1;
      return { cleared: true };
    });
    gateway.responses.set("goal.create", () => {
      projection = {
        goal: {
          id: "goal-fresh",
          revision: 1,
          objective: "New work",
          phase: "active",
          maxGoalRounds: 50,
        },
        roundsStarted: 0,
        createdAt: 1_787_000_000_000,
        updatedAt: 1_787_000_000_000,
      };
      projectionSeq += 1;
      return { ref: { id: "goal-fresh", revision: 1 } };
    });

    await expect(adapter.setThreadGoal(sessionId, { objective: "New work" })).resolves.toMatchObject({
      goal: { objective: "New work", status: "active", tokensUsed: 0 },
    });
    const methods = gateway.calls.map((call) => call.method);
    const clearIndex = methods.indexOf("goal.clear");
    const createIndex = methods.indexOf("goal.create");
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeGreaterThan(clearIndex);
    expect(methods).not.toContain("goal.edit");
  });

  it("routes a goal approval request to the goal watcher instead of a concurrent user turn", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(12);
    const activeGoal = {
      goal: {
        id: "goal-approval",
        revision: 1,
        objective: "Use tools",
        phase: "active",
        maxGoalRounds: 50,
      },
      roundsStarted: 0,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_000_000,
    };
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: { asOfSeq: 0, values: { goal: activeGoal } },
    });
    gateway.responses.set("goal.create", { ref: { id: "goal-approval", revision: 1 } });
    const controller = new AbortController();
    const goalEvents: EngineStreamEvent[] = [];
    const goalApprovals: EngineApprovalRequest[] = [];
    const watch = adapter.watchThreadGoal(sessionId, {
      objective: "Use tools",
      abortSignal: controller.signal,
      onEngineEvent: (event) => {
        goalEvents.push(event);
      },
      onApprovalRequest: async (request) => {
        goalApprovals.push(request);
        return { behavior: "allow", scope: "session" };
      },
    });
    await waitForCall(gateway, "goal.create");

    const userApprovals: EngineApprovalRequest[] = [];
    const userTurn = adapter.sendUserMessage(sessionId, {
      text: "Status",
      files: [],
      onApprovalRequest: async (request) => {
        userApprovals.push(request);
        return { behavior: "allow" };
      },
    });
    await waitForCall(gateway, "session.prompt", 1);
    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitSessionEvent(sessionId, "user/message", {
      id: "goal-message",
      role: "user",
      content: [{ type: "text", text: "goal round" }],
      source: { kind: "goal", goalId: "goal-approval", revision: 1, round: 1 },
    }, 2);
    gateway.emitSessionEvent(sessionId, "tool/call", {
      turn: 1,
      step: 1,
      callId: "goal-tool",
      name: "outside_write",
      arguments: "{\"path\":\"/tmp/out\"}",
    }, 3);
    gateway.emitMux({
      type: "approval/requested",
      sessionId,
      approvalId: "goal-approval-request",
      callId: "goal-tool",
      toolName: "outside_write",
    }, "goal-approval-rpc");

    await vi.waitFor(() => expect(gateway.clientResponses).toHaveLength(1));
    expect(userApprovals).toHaveLength(0);
    expect(goalApprovals).toEqual([expect.objectContaining({
      engine: "deepseek",
      toolName: "outside_write",
      toolInput: { path: "/tmp/out" },
      sessionId,
    })]);
    expect(gateway.clientResponses[0]).toMatchObject({
      rpcId: "goal-approval-rpc",
      value: { outcome: "allowed-once" },
    });
    expect(goalEvents).toContainEqual({
      type: "permission_request",
      toolUseId: "goal-tool",
      toolName: "outside_write",
      toolInput: { path: "/tmp/out" },
      sessionId,
    });

    controller.abort();
    await expect(watch).resolves.toBeDefined();
    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 2 }, 4);
    gateway.emitSessionEvent(sessionId, "user/message", {
      id: "user-status-message",
      role: "user",
      content: [{ type: "text", text: "Status" }],
      source: { kind: "user", rpcId: gateway.lastPromptId(sessionId) },
    }, 5);
    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 2,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "user result" },
    }, 6);
    gateway.emitSessionEvent(sessionId, "turn/end", { turn: 2, reason: completedReason() }, 7);
    await expect(userTurn).resolves.toMatchObject({ text: "user result" });
  });

  it("keeps goal-owned background jobs out of a concurrent user turn", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(13);
    const activeGoal = {
      goal: {
        id: "goal-job",
        revision: 1,
        objective: "Run in background",
        phase: "active",
        maxGoalRounds: 50,
      },
      roundsStarted: 0,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_000_000,
    };
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: { asOfSeq: 0, values: { goal: activeGoal } },
    });
    gateway.responses.set("goal.create", { ref: { id: "goal-job", revision: 1 } });
    const controller = new AbortController();
    const goalEvents: EngineStreamEvent[] = [];
    const watch = adapter.watchThreadGoal(sessionId, {
      objective: "Run in background",
      abortSignal: controller.signal,
      onEngineEvent: (event) => {
        goalEvents.push(event);
      },
    });
    await waitForCall(gateway, "goal.create");
    const userEvents: EngineStreamEvent[] = [];
    const userTurn = adapter.sendUserMessage(sessionId, {
      text: "Status",
      files: [],
      onEngineEvent: (event) => {
        userEvents.push(event);
      },
    });
    await waitForCall(gateway, "session.prompt", 1);

    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitSessionEvent(sessionId, "user/message", {
      id: "goal-job-message",
      role: "user",
      content: [{ type: "text", text: "goal round" }],
      source: { kind: "goal", goalId: "goal-job", revision: 1, round: 1 },
    }, 2);
    gateway.emitMux({
      type: "session/jobs",
      sessionId,
      jobs: [{
        id: "goal-job-1",
        kind: "bash",
        label: "long goal job",
        status: "running",
        startedAt: Date.now(),
      }],
    });
    gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 3);
    gateway.emitMux({
      type: "session/jobs",
      sessionId,
      jobs: [{
        id: "goal-job-1",
        kind: "bash",
        label: "long goal job",
        status: "completed",
        detail: "exit code: 0",
        startedAt: Date.now() - 1_000,
        finishedAt: Date.now(),
      }],
    });

    await vi.waitFor(() => {
      expect(goalEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "background_task_started", taskId: "goal-job-1" }),
        expect.objectContaining({ type: "background_task_finished", taskId: "goal-job-1" }),
      ]));
    });
    expect(userEvents.some((event) => event.type.startsWith("background_task_"))).toBe(false);

    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 2 }, 4);
    gateway.emitSessionEvent(sessionId, "user/message", {
      id: "user-status-message",
      role: "user",
      content: [{ type: "text", text: "Status" }],
      source: { kind: "user", rpcId: gateway.lastPromptId(sessionId) },
    }, 5);
    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 2,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "user result" },
    }, 6);
    gateway.emitSessionEvent(sessionId, "turn/end", { turn: 2, reason: completedReason() }, 7);
    await expect(userTurn).resolves.toMatchObject({ text: "user result" });
    controller.abort();
    await expect(watch).resolves.toBeDefined();
  });

  it("routes a goal question request to the goal watcher instead of a concurrent user turn", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(14);
    const activeGoal = {
      goal: {
        id: "goal-question",
        revision: 1,
        objective: "Ask safely",
        phase: "active",
        maxGoalRounds: 50,
      },
      roundsStarted: 0,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_000_000,
    };
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: { asOfSeq: 0, values: { goal: activeGoal } },
    });
    gateway.responses.set("goal.create", { ref: { id: "goal-question", revision: 1 } });
    const controller = new AbortController();
    const goalEvents: EngineStreamEvent[] = [];
    const goalQuestions: EngineApprovalRequest[] = [];
    const watch = adapter.watchThreadGoal(sessionId, {
      objective: "Ask safely",
      abortSignal: controller.signal,
      onEngineEvent: (event) => {
        goalEvents.push(event);
      },
      onApprovalRequest: async (request) => {
        goalQuestions.push(request);
        return {
          behavior: "allow",
          updatedInput: { answers: { Choose: "B" } },
        };
      },
    });
    await waitForCall(gateway, "goal.create");

    const userApprovals: EngineApprovalRequest[] = [];
    const userTurn = adapter.sendUserMessage(sessionId, {
      text: "Status",
      files: [],
      onApprovalRequest: async (request) => {
        userApprovals.push(request);
        return { behavior: "allow" };
      },
    });
    await waitForCall(gateway, "session.prompt", 1);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitSessionEvent(sessionId, "user/message", {
      id: "goal-question-message",
      role: "user",
      content: [{ type: "text", text: "goal round" }],
      source: { kind: "goal", goalId: "goal-question", revision: 1, round: 1 },
    }, 2);
    await gateway.emitMux({
      type: "question/requested",
      sessionId,
      questions: [{
        id: "choice",
        question: "Choose",
        options: [{ label: "A" }, { label: "B" }],
      }],
    }, "goal-question-rpc");

    expect(userApprovals).toHaveLength(0);
    expect(goalQuestions).toEqual([expect.objectContaining({
      engine: "deepseek",
      toolName: "AskUserQuestion",
      sessionId,
    })]);
    expect(gateway.clientResponses.at(-1)).toEqual({
      rpcId: "goal-question-rpc",
      value: {
        sessionId,
        answer: { answers: [{ id: "choice", selected: ["B"] }] },
      },
    });
    expect(goalEvents).toContainEqual({
      type: "permission_request",
      toolName: "AskUserQuestion",
      toolInput: {
        questions: [{
          id: "choice",
          question: "Choose",
          options: [{ label: "A" }, { label: "B" }],
        }],
      },
      sessionId,
    });

    controller.abort();
    await expect(watch).resolves.toBeDefined();
    await finishTurn(gateway, sessionId, 2, 3, "user result");
    await expect(userTurn).resolves.toMatchObject({ text: "user result" });
  });

  it("keeps a newer live projection when an equal-seq history snapshot arrives later", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(15);
    await gateway.emitProjection(sessionId, "contextPressure", {
      pressureTokens: 20_000,
      projectedTokens: 21_000,
      contextWindow: 131_072,
    }, 10);
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: {
        asOfSeq: 10,
        values: {
          contextPressure: {
            pressureTokens: 1,
            projectedTokens: 2,
            contextWindow: 3,
          },
        },
      },
    });

    await expect(adapter.getContextUsage(sessionId)).resolves.toEqual({
      pressureTokens: 20_000,
      projectedTokens: 21_000,
      contextWindow: 131_072,
    });
  });

  it("releases a goal event callback that never settles when the watcher is aborted", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(16);
    const activeGoal = {
      goal: {
        id: "goal-hung-callback",
        revision: 1,
        objective: "Stream safely",
        phase: "active",
        maxGoalRounds: 50,
      },
      roundsStarted: 0,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_000_000,
    };
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: { asOfSeq: 0, values: { goal: activeGoal } },
    });
    gateway.responses.set("goal.create", { ref: { id: "goal-hung-callback", revision: 1 } });
    const controller = new AbortController();
    let callbackStarted = false;
    const watch = adapter.watchThreadGoal(sessionId, {
      objective: "Stream safely",
      abortSignal: controller.signal,
      onEngineEvent: (event) => {
        if (event.type === "assistant_text") {
          callbackStarted = true;
          return new Promise<void>(() => {});
        }
      },
    });
    await waitForCall(gateway, "goal.create");
    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitSessionEvent(sessionId, "user/message", {
      id: "goal-hung-message",
      role: "user",
      content: [{ type: "text", text: "goal round" }],
      source: { kind: "goal", goalId: "goal-hung-callback", revision: 1, round: 1 },
    }, 2);
    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "partial" },
    }, 3);
    await vi.waitFor(() => expect(callbackStarted).toBe(true));

    controller.abort();
    await expect(watch).resolves.toBeDefined();
    const next = adapter.sendUserMessage(sessionId, { text: "After abort", files: [] });
    await waitForCall(gateway, "session.prompt", 1);
    await finishTurn(gateway, sessionId, 2, 4, "released");
    await expect(next).resolves.toMatchObject({ text: "released" });
  });

  it("finishes a goal watcher from unseen terminal events recovered after reconnect", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(17);
    const activeGoal = {
      goal: {
        id: "goal-reconnect",
        revision: 1,
        objective: "Survive reconnect",
        phase: "active" as "active" | "complete",
        maxGoalRounds: 50,
      },
      roundsStarted: 0,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_000_000,
    };
    let reconnected = false;
    const historyEvent = (type: string, data: Record<string, unknown>, seq: number) => ({
      event: { type, data, seq, time: Date.now() },
    });
    gateway.responses.set("session.history", () => reconnected
      ? {
          events: [
            historyEvent("turn/start", { turn: 1 }, 1),
            historyEvent("user/message", {
              id: "goal-reconnect-message",
              role: "user",
              content: [{ type: "text", text: "goal round" }],
              source: { kind: "goal", goalId: "goal-reconnect", revision: 1, round: 1 },
            }, 2),
            historyEvent("assistant/chunk", {
              turn: 1,
              step: 1,
              chunk: { type: "text-delta", index: 0, text: "before disconnect" },
            }, 3),
            historyEvent("turn/end", { turn: 1, reason: completedReason() }, 4),
          ],
          hasMore: false,
          projections: {
            asOfSeq: 4,
            values: {
              goal: {
                ...activeGoal,
                goal: { ...activeGoal.goal, phase: "complete" },
                roundsStarted: 1,
                updatedAt: 1_787_000_001_000,
              },
            },
          },
        }
      : {
          events: [],
          hasMore: false,
          projections: { asOfSeq: 0, values: { goal: activeGoal } },
        });
    gateway.responses.set("goal.create", { ref: { id: "goal-reconnect", revision: 1 } });
    const events: EngineStreamEvent[] = [];
    const watch = adapter.watchThreadGoal(sessionId, {
      objective: "Survive reconnect",
      onEngineEvent: (event) => {
        events.push(event);
      },
    });
    await waitForCall(gateway, "goal.create");
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitSessionEvent(sessionId, "user/message", {
      id: "goal-reconnect-message",
      role: "user",
      content: [{ type: "text", text: "goal round" }],
      source: { kind: "goal", goalId: "goal-reconnect", revision: 1, round: 1 },
    }, 2);
    await gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "before disconnect" },
    }, 3);

    reconnected = true;
    await gateway.handlers?.onReconnect?.({ reason: "transport" });

    await expect(watch).resolves.toMatchObject({ goal: { status: "complete" } });
    expect(events.filter((event) => event.type === "assistant_text")).toHaveLength(1);
  });

  it.each(["provider connection failed", "DeepSeek Messages stream: tool input is invalid JSON"])("fails an active turn on host error and permits same-session continuation: %s", async (message) => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(18);
    const turn = adapter.sendUserMessage(sessionId, { text: "Fail fast", files: [] });
    await waitForCall(gateway, "session.prompt", 1);

    await gateway.emitHost({
      type: "host/agent-error",
      sessionId,
      message,
    });

    await expect(turn).rejects.toThrow(message);
    expect(gateway.calls.filter((call) => call.method === "session.prompt")).toHaveLength(1);
    const next = adapter.sendUserMessage(sessionId, { text: "Retry", files: [] });
    await waitForCall(gateway, "session.prompt", 2);
    await finishTurn(gateway, sessionId, 1, 1, "recovered");
    await expect(next).resolves.toMatchObject({ text: "recovered" });
  });

  it("reads the durable context pressure projection for /context", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(1);
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: {
        asOfSeq: 4,
        values: {
          contextPressure: {
            pressureTokens: 12_000,
            projectedTokens: 13_107,
            contextWindow: 131_072,
          },
        },
      },
    });

    await expect(adapter.getContextUsage(sessionId)).resolves.toEqual({
      pressureTokens: 12_000,
      projectedTokens: 13_107,
      contextWindow: 131_072,
    });
    expect(gateway.calls).toContainEqual({
      method: "session.history",
      payload: { sessionId, maxMessages: 1 },
    });
  });

  it("rejects a projection snapshot without an as-of sequence", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(2);
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: {
        values: {
          contextPressure: {
            pressureTokens: 1,
            projectedTokens: 2,
            contextWindow: 3,
          },
        },
      },
    });

    await expect(adapter.getContextUsage(sessionId)).rejects.toThrow("missing asOfSeq");
  });

  it("recovers only unseen session events after a transport reconnect", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(8);
    const events: EngineStreamEvent[] = [];
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Continue after reconnect",
      files: [],
      onEngineEvent: (event) => {
        events.push(event);
      },
    });
    await waitForCall(gateway, "session.prompt", 1);
    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "Once" },
    }, 2);
    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "assistant_text",
        text: "Once",
        delta: true,
        sessionId,
      });
    });

    const historyEvent = (type: string, data: Record<string, unknown>, seq: number) => ({
      event: { type, data, seq, time: Date.now() },
    });
    gateway.responses.set("session.history", {
      events: [
        historyEvent("turn/start", { turn: 1 }, 1),
        historyEvent("assistant/chunk", {
          turn: 1,
          step: 1,
          chunk: { type: "text-delta", index: 0, text: "Once" },
        }, 2),
        historyEvent("assistant/chunk", {
          turn: 1,
          step: 2,
          chunk: { type: "text-delta", index: 0, text: " after reconnect" },
        }, 3),
        historyEvent("turn/end", { turn: 1, reason: completedReason() }, 4),
      ],
      hasMore: false,
      projections: { asOfSeq: 4, values: {} },
    });

    await gateway.handlers?.onReconnect?.({ reason: "transport" });
    await expect(turn).resolves.toMatchObject({ text: "Once after reconnect", sessionId });
    expect(events.filter((event) => event.type === "assistant_text").map((event) => event.text)).toEqual([
      "Once",
      " after reconnect",
    ]);
  });

  it("drains reconnect frames before admitting live frames that arrive during recovery", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(8);
    const textEvents: string[] = [];
    let injectedLiveFrame = false;
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Preserve reconnect ordering",
      files: [],
      onEngineEvent: (event) => {
        if (event.type !== "assistant_text") {
          return;
        }
        textEvents.push(event.text);
        if (event.text === "buffered-1" && !injectedLiveFrame) {
          injectedLiveFrame = true;
          void gateway.emitSessionEvent(sessionId, "assistant/chunk", {
            turn: 1,
            step: 3,
            chunk: { type: "text-delta", index: 0, text: "live" },
          }, 5);
        }
      },
    });
    await waitForCall(gateway, "session.prompt", 1);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitSessionEvent(sessionId, "user/message", {
      id: "reconnect-order-user",
      role: "user",
      content: [{ type: "text", text: "Preserve reconnect ordering" }],
      source: { kind: "user" },
    }, 2);

    await gateway.handlers?.onDisconnect?.(new Error("socket closed"));
    await gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "buffered-1" },
    }, 3);
    await gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 2,
      chunk: { type: "text-delta", index: 0, text: "buffered-2" },
    }, 4);

    await gateway.handlers?.onReconnect?.({ reason: "transport" });
    await vi.waitFor(() => expect(textEvents).toEqual(["buffered-1", "buffered-2", "live"]));
    await gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 6);

    await expect(turn).resolves.toMatchObject({ text: "buffered-1buffered-2live" });
  });

  it("fails a turn the dead host can never finish instead of holding it for the 6h cap", async () => {
    // A tool call was outstanding when dsh died. Replayed history carries no
    // turn/end for it, and outstandingToolCalls kept the inactivity watchdog
    // disarmed — so the user waited out the hard cap while the session's
    // writer slot stayed held. Now the turn fails right after recovery and a
    // fresh turn is admitted.
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(21);
    gateway.responses.set("session.history", { events: [], hasMore: false, projections: { asOfSeq: 0, values: {} } });
    const turn = adapter.sendUserMessage(sessionId, { text: "run the long job", files: [] });
    await waitForCall(gateway, "session.prompt", 1);
    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitSessionEvent(sessionId, "tool/call", { turn: 1, step: 1, callId: "call-1", name: "bash", arguments: {} }, 2);

    await gateway.handlers?.onDisconnect?.(new Error("dsh exited"));
    await gateway.handlers?.onReconnect?.({ reason: "host-restart" });

    await expect(turn).rejects.toThrow(/restarted while this turn was running/);
    // Writer slot released: the next turn is admitted and prompted.
    const next = adapter.sendUserMessage(sessionId, { text: "again", files: [] });
    await waitForCall(gateway, "session.prompt", 2);
    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 2 }, 3);
    gateway.emitSessionEvent(sessionId, "turn/end", { turn: 2, reason: completedReason() }, 4);
    await expect(next).resolves.toMatchObject({ sessionId });
    await adapter.destroy();
  });

  it("recovers from a corrupt goal-state file once it is repaired instead of failing until restart", async () => {
    // ensureGoalStateLoaded cached the REJECTED load promise, so every later
    // projection frame re-threw "Invalid DeepSeek goal state JSON" until the
    // process restarted — repairing the file did nothing.
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-goal-state-"));
    const goalStatePath = path.join(root, "deepseek-goals.json");
    await writeFile(goalStatePath, "{corrupt", "utf8");
    try {
      const { adapter } = createAdapter(undefined, { goalStatePath });
      const internals = adapter as unknown as { ensureGoalStateLoaded(): Promise<void> };
      await expect(internals.ensureGoalStateLoaded()).rejects.toThrow();
      // Still broken while the file is broken (not a one-off).
      await expect(internals.ensureGoalStateLoaded()).rejects.toThrow();
      await writeFile(goalStatePath, JSON.stringify({ version: 1, sessions: {} }) + "\n", "utf8");
      await expect(internals.ensureGoalStateLoaded()).resolves.toBeUndefined();
      await adapter.destroy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("terminalizes live background jobs before wiping ledgers when the Harness removes a session", async () => {
    // A background_task_started with no matching finished event left the
    // timeline pairing open, and the restart busy-guard then refused to
    // restart the instance for six hours.
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(23);
    const events: Array<{ type?: string; taskId?: string; status?: string }> = [];
    const turn = adapter.sendUserMessage(sessionId, {
      text: "start a job",
      files: [],
      onEngineEvent: (event) => {
        events.push(event as { type?: string; taskId?: string; status?: string });
      },
    });
    await waitForCall(gateway, "session.prompt", 1);
    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitMux({
      type: "session/jobs",
      sessionId,
      jobs: [{ id: "bash-1", kind: "bash", label: "sleep 100", status: "running", startedAt: Date.now() }],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events.some((event) => event.type === "background_task_started" && event.taskId === "bash-1")).toBe(true);

    await gateway.emitHost({ type: "host/session-removed", sessionId });

    await expect(turn).rejects.toThrow(/was removed/);
    const finished = events.find((event) => event.type === "background_task_finished" && event.taskId === "bash-1");
    expect(finished).toBeDefined();
    expect(finished?.status).toBe("failed");
    await adapter.destroy();
  });

  it("re-arms a watched active goal after the Harness process restarts", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(19);
    const activeGoal = {
      goal: {
        id: "goal-host-restart",
        revision: 1,
        objective: "Survive the host restart",
        phase: "active",
        maxGoalRounds: 50,
      },
      roundsStarted: 1,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_001_000,
    };
    gateway.responses.set("goal.create", { ref: { id: "goal-host-restart", revision: 1 } });
    gateway.responses.set("goal.resume", { ref: { id: "goal-host-restart", revision: 2 } });
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: { asOfSeq: 1, values: { goal: activeGoal } },
    });

    const watch = adapter.watchThreadGoal(sessionId, {
      objective: "Survive the host restart",
    });
    await waitForCall(gateway, "goal.create");
    expect(gateway.calls.filter((call) => call.method === "goal.resume")).toHaveLength(0);

    await gateway.handlers?.onDisconnect?.(new Error("dsh exited"));
    await gateway.handlers?.onReconnect?.({ reason: "host-restart" });

    expect(gateway.calls.filter((call) => call.method === "goal.resume")).toEqual([{
      method: "goal.resume",
      payload: {
        sessionId,
        ref: { id: "goal-host-restart", revision: 1 },
      },
    }]);

    await gateway.emitProjection(sessionId, "goal", {
      ...activeGoal,
      goal: { ...activeGoal.goal, phase: "complete", revision: 2 },
      updatedAt: 1_787_000_002_000,
    }, 2);
    await expect(watch).resolves.toMatchObject({ goal: { status: "complete" } });
  });

  it("does not redundantly resume an armed goal after a transport-only reconnect", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(20);
    const activeGoal = {
      goal: {
        id: "goal-transport-reconnect",
        revision: 1,
        objective: "Stay armed",
        phase: "active",
        maxGoalRounds: 50,
      },
      roundsStarted: 1,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_001_000,
    };
    gateway.responses.set("goal.create", { ref: { id: "goal-transport-reconnect", revision: 1 } });
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: { asOfSeq: 1, values: { goal: activeGoal } },
    });

    const watch = adapter.watchThreadGoal(sessionId, { objective: "Stay armed" });
    await waitForCall(gateway, "goal.create");
    await gateway.handlers?.onDisconnect?.(new Error("socket closed"));
    await gateway.handlers?.onReconnect?.({ reason: "transport" });

    expect(gateway.calls.filter((call) => call.method === "goal.resume")).toHaveLength(0);
    await gateway.emitProjection(sessionId, "goal", {
      ...activeGoal,
      goal: { ...activeGoal.goal, phase: "complete", revision: 2 },
      updatedAt: 1_787_000_002_000,
    }, 2);
    await expect(watch).resolves.toMatchObject({ goal: { status: "complete" } });
  });

  it("does not start a new turn until reconnect history recovery has finished", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(21);
    const activeGoal = {
      goal: {
        id: "goal-recovery-barrier",
        revision: 1,
        objective: "Keep pursuing",
        phase: "active" as "active" | "complete",
        maxGoalRounds: 50,
      },
      roundsStarted: 1,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_001_000,
    };
    gateway.responses.set("goal.create", { ref: { id: "goal-recovery-barrier", revision: 1 } });
    const watch = adapter.watchThreadGoal(sessionId, { objective: "Keep pursuing" });
    await waitForCall(gateway, "goal.create");
    const historyCallsBeforeDisconnect = gateway.calls.filter((call) => call.method === "session.history").length;
    const promptCallsBeforeDisconnect = gateway.calls.filter((call) => call.method === "session.prompt").length;
    let releaseHistory!: () => void;
    const historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    gateway.responses.set("session.history", async () => {
      await historyGate;
      return {
        events: [],
        hasMore: false,
        projections: { asOfSeq: 1, values: { goal: activeGoal } },
      };
    });

    await gateway.handlers?.onDisconnect?.(new Error("socket closed"));
    const recovery = Promise.resolve(gateway.handlers?.onReconnect?.({ reason: "transport" }));
    await vi.waitFor(() => {
      expect(gateway.calls.filter((call) => call.method === "session.history").length)
        .toBeGreaterThan(historyCallsBeforeDisconnect);
    });

    const turn = adapter.sendUserMessage(sessionId, { text: "after reconnect", files: [] });
    void turn.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(gateway.calls.filter((call) => call.method === "session.prompt"))
      .toHaveLength(promptCallsBeforeDisconnect);

    releaseHistory();
    await recovery;
    await vi.waitFor(() => {
      expect(gateway.calls.filter((call) => call.method === "session.prompt").length)
        .toBeGreaterThan(promptCallsBeforeDisconnect);
    });
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 2);
    await gateway.emitSessionEvent(sessionId, "user/message", {
      id: "foreground-after-reconnect",
      role: "user",
      content: [{ type: "text", text: "after reconnect" }],
      source: { kind: "user", rpcId: gateway.lastPromptId(sessionId) },
    }, 3);
    await gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "recovered" },
    }, 4);
    await gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 5);
    await expect(turn).resolves.toMatchObject({ text: "recovered" });

    await gateway.emitProjection(sessionId, "goal", {
      ...activeGoal,
      goal: { ...activeGoal.goal, phase: "complete", revision: 2 },
      updatedAt: 1_787_000_002_000,
    }, 6);
    await expect(watch).resolves.toMatchObject({ goal: { status: "complete" } });
  });

  it("fails closed when reconnect history exceeds the pagination safety limit", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(22);
    const turn = adapter.sendUserMessage(sessionId, { text: "recover all history", files: [] });
    void turn.catch(() => {});
    await waitForCall(gateway, "session.prompt");
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitSessionEvent(sessionId, "user/message", {
      id: "history-limit-owner",
      role: "user",
      content: [{ type: "text", text: "recover all history" }],
      source: { kind: "user" },
    }, 2);

    gateway.responses.set("session.history", (payload: unknown) => {
      const beforeSeq = (payload as { beforeSeq?: number }).beforeSeq;
      const seq = beforeSeq === undefined ? 1_002 : beforeSeq - 1;
      return {
        events: [{ event: { type: "audit/noop", seq, time: Date.now(), data: {} } }],
        hasMore: true,
      };
    });

    await gateway.handlers?.onDisconnect?.(new Error("socket closed"));
    await gateway.handlers?.onReconnect?.({ reason: "transport" });

    const outcome = await Promise.race([
      turn.then(() => "resolved", (error: unknown) => String(error)),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]);
    expect(outcome).toContain("history pagination limit");
    expect(gateway.calls.filter((call) => call.method === "session.history")).toHaveLength(100);

    await adapter.destroy();
  });

  it("closes process-local background jobs as failed when the Harness host restarts", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(22);
    const events: EngineStreamEvent[] = [];
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Run a background task",
      files: [],
      onEngineEvent: (event) => {
        events.push(event);
      },
    });
    void turn.catch(() => {});
    await waitForCall(gateway, "session.prompt", 1);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitSessionEvent(sessionId, "user/message", {
      id: "foreground-message",
      role: "user",
      content: [{ type: "text", text: "Run a background task" }],
      source: { kind: "user" },
    }, 2);
    await gateway.emitMux({
      type: "session/jobs",
      sessionId,
      jobs: [{
        id: "job-before-crash",
        kind: "shell",
        label: "long command",
        status: "running",
        startedAt: Date.now(),
      }],
    });
    expect(events).toContainEqual({
      type: "background_task_started",
      taskId: "job-before-crash",
      description: "long command",
      sessionId,
    });

    gateway.responses.set("session.history", {
      events: [{
        event: {
          type: "turn/end",
          seq: 3,
          time: Date.now(),
          data: { turn: 1, reason: { kind: "interrupted" } },
        },
      }],
      hasMore: false,
      projections: { asOfSeq: 3, values: {} },
    });
    await gateway.handlers?.onDisconnect?.(new Error("dsh exited"));
    await gateway.handlers?.onReconnect?.({ reason: "host-restart" });

    expect(events).toContainEqual({
      type: "background_task_finished",
      taskId: "job-before-crash",
      status: "failed",
      summary: "DeepSeek Harness restarted before the background job reported completion",
      sessionId,
    });
    await expect(turn).rejects.toThrow("DeepSeek Harness turn ended with interrupted");
  });
});


it("does not cache a grant whose native receipt arrives after its owner was stopped", async () => {
  const { adapter, gateway } = createAdapter();
  const { sessionId } = await adapter.createSession(331);
  let release!: (receipt: { accepted: boolean }) => void;
  const original = gateway.respond.bind(gateway);
  const respond = vi.spyOn(gateway, "respond").mockImplementationOnce(async (id, value) => {
    await original(id, value);
    return await new Promise(resolve => { release = resolve; });
  });
  try {
    const abort = new AbortController();
    const first = adapter.sendUserMessage(sessionId, { text: "Approve", files: [], abortSignal: abort.signal,
      onApprovalRequest: async () => ({ behavior: "allow", scope: "session" }),
    });
    const stopped = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await waitForCall(gateway, "session.prompt", 1);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitSessionEvent(sessionId, "tool/call", { turn: 1, step: 1, callId: "edit-one", name: "edit", arguments: '{"path":"same.ts"}' }, 2);
    const approval = gateway.emitMux({ type: "approval/requested", sessionId, approvalId: "first", callId: "edit-one", toolName: "edit" }, "late-receipt");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    abort.abort(); await stopped;
    release({ accepted: true }); await approval; respond.mockRestore();
    await gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: { kind: "aborted" } }, 3);
    const askAgain = vi.fn(async () => ({ behavior: "deny" as const }));
    const second = adapter.sendUserMessage(sessionId, { text: "Try again", files: [], onApprovalRequest: askAgain });
    void second.catch(() => {});
    await waitForCall(gateway, "session.prompt", 2);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 2 }, 4);
    await gateway.emitSessionEvent(sessionId, "tool/call", { turn: 2, step: 1, callId: "edit-two", name: "edit", arguments: '{"path":"same.ts"}' }, 5);
    await gateway.emitMux({ type: "approval/requested", sessionId, approvalId: "second", callId: "edit-two", toolName: "edit" }, "fresh-approval");
    expect(askAgain).toHaveBeenCalledOnce();
    expect(gateway.clientResponses.at(-1)).toMatchObject({ rpcId: "fresh-approval", value: { outcome: "rejected" } });
    await finishTurn(gateway, sessionId, 2, 6, "Denied"); await second;
  } finally { release?.({ accepted: true }); respond.mockRestore(); await adapter.destroy(); }
});
