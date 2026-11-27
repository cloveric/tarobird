import { describe, expect, it, vi } from "vitest";
import type { EngineStreamEvent } from "../src/codex/adapter.js";
import {
  DeepSeekHarnessAdapter,
  type DeepSeekHarnessGateway,
} from "../src/codex/deepseek-harness-adapter.js";
import type {
  DeepSeekHarnessProtocolHandlers,
  DeepSeekHarnessServerRequest,
} from "../src/codex/deepseek-harness-protocol.js";
import { Bridge, type AccessStoreLike, type SessionManagerLike } from "../src/runtime/bridge.js";
import { runToolAction } from "../src/client-protocol/run-tools.js";
import { runEntryTitle } from "../client/src/run-presentation.js";

class FakeSubagentGateway implements DeepSeekHarnessGateway {
  readonly calls: Array<{ method: string; payload: unknown }> = [];
  handlers: DeepSeekHarnessProtocolHandlers | undefined;
  private readonly lastPromptIds = new Map<string, string>();
  cancelOutcome: "cancelled" | "removed" | "settled" | "goal-active" | "merged" = "cancelled";
  interruptHandler?: (childSessionId: string) => unknown | Promise<unknown>;
  listItems: Array<Record<string, unknown>> = [];
  historyHandler?: (payload: Record<string, unknown>) => unknown;

  async connect(handlers: DeepSeekHarnessProtocolHandlers): Promise<void> {
    this.handlers = handlers;
  }

  async request(method: string, payload: unknown): Promise<unknown> {
    this.calls.push({ method, payload });
    if (method === "session.create") {
      return { sessionId: (payload as { sessionId: string }).sessionId, agentPreset: "standard" };
    }
    if (method === "commands/execute") {
      return { commandId: "cmd-1", result: { kind: "success", text: "ok" } };
    }
    if (method === "session.prompt") {
      const p = payload as { sessionId: string; requestId: string };
      this.lastPromptIds.set(p.sessionId, p.requestId);
      return { accepted: true };
    }
    if (method === "session.followSubagent" || method === "session.unfollowSubagent") {
      return { ok: true };
    }
    if (method === "subagents.interruptByUser") {
      const childSessionId = (payload as { childSessionId: string }).childSessionId;
      if (this.interruptHandler) return await this.interruptHandler(childSessionId);
      return { accepted: true };
    }
    if (method === "session.history") {
      if (this.historyHandler) return this.historyHandler((payload ?? {}) as Record<string, unknown>);
      return {
        events: [{ event: { seq: 10, type: "turn/end", data: {} } }],
        hasMore: false,
        projections: {
          asOfSeq: 10,
          values: {
            goal: null,
            inbox: { "next-turn": [], "next-step": [] },
            userQuestions: { active: [], settled: [] },
            agentTeam: { enabled: false, tasks: [] },
          },
        },
      };
    }
    if (method === "session.list") {
      return { items: this.listItems };
    }
    if (method === "goal.create") {
      return { ref: { id: "goal-1", revision: 1 } };
    }
    if (method === "goal.clear") {
      return { cleared: true };
    }
    return {};
  }

  async cancelPrompt(sessionId: string, sourceRpcId: string) {
    this.calls.push({ method: "native.cancelPrompt", payload: { sessionId, sourceRpcId } });
    return { outcome: this.cancelOutcome };
  }

  async respond(): Promise<{ accepted: boolean }> { return { accepted: true }; }
  async respondError(): Promise<{ accepted: boolean }> { return { accepted: true }; }
  async close(): Promise<void> {}

  lastPromptId(sessionId: string): string | undefined {
    return this.lastPromptIds.get(sessionId);
  }

  async emitMux(payload: Record<string, unknown>): Promise<void> {
    const frame: DeepSeekHarnessServerRequest = {
      type: "server-request",
      rpcId: `rpc-${Math.random()}`,
      method: String(payload.type),
      payload: payload as DeepSeekHarnessServerRequest["payload"],
    };
    await this.handlers?.onMuxFrame(frame);
  }

  async emitHost(payload: Record<string, unknown>): Promise<void> {
    const frame: DeepSeekHarnessServerRequest = {
      type: "server-request",
      rpcId: `rpc-${Math.random()}`,
      method: String(payload.type),
      payload: payload as DeepSeekHarnessServerRequest["payload"],
    };
    await this.handlers?.onHostFrame(frame);
  }

  async emitEvent(sessionId: string, type: string, data: Record<string, unknown>, seq: number): Promise<void> {
    await this.emitMux({
      type: "session/event",
      sessionId,
      event: { type, seq, time: Date.now(), data },
    });
  }
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out waiting for condition");
}

describe("DeepSeek Harness subagents (#74)", () => {
  it("isolates child text and tools into scoped events, records lifecycle receipts, and lists finished subagents", async () => {
    const gateway = new FakeSubagentGateway();
    const adapter = new DeepSeekHarnessAdapter({
      gateway,
      workspacePath: "/tmp/example-workspace",
      turnSettleDelayMs: 5,
      backgroundReviewGraceMs: 200,
    });
    const events: EngineStreamEvent[] = [];
    const sessionId = "parent-session-1";
    const childId = "child-subagent-1";

    const turnPromise = adapter.sendUserMessage(sessionId, {
      text: "Delegate file read to a subagent",
      files: [],
      onEngineEvent: (event) => { events.push(event); },
    });

    await waitFor(() => Boolean(gateway.lastPromptId(sessionId)));
    const rpcId = gateway.lastPromptId(sessionId)!;

    await gateway.emitEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitEvent(sessionId, "user/message", {
      content: [{ type: "text", text: "Delegate file read to a subagent" }],
      source: { kind: "user", rpcId },
    }, 2);
    await gateway.emitEvent(sessionId, "tool/call", {
      turn: 1,
      step: 1,
      callId: "call-sub-1",
      name: "subagent",
      arguments: JSON.stringify({ name: "reader", description: "Read hello.txt", prompt: "Read hello.txt" }),
    }, 3);
    await gateway.emitEvent(sessionId, "subagent/catalog", {
      version: 3,
      childId,
      childCreatedAt: Date.now(),
      mode: "continuable",
      label: "Read hello.txt",
      name: "reader",
    }, 4);
    await gateway.emitEvent(sessionId, "tool/result", {
      turn: 1,
      step: 1,
      message: {
        role: "tool",
        toolCallId: "call-sub-1",
        content: [{ type: "text", text: "started subagent reader" }],
        isError: false,
      },
    }, 5);

    // Must follow child session with durable parent address
    await waitFor(() => gateway.calls.some((c) => c.method === "session.followSubagent"));
    expect(gateway.calls.find((c) => c.method === "session.followSubagent")?.payload).toEqual({
      parentSessionId: sessionId,
      childSessionId: childId,
      mode: "continuable",
    });

    // Task panel lists running subagent with canStop: true
    const runningTasks = await adapter.listTasks(sessionId);
    expect(runningTasks.supported).toBe(true);
    expect(runningTasks.foregroundStopScope).toBe("subagents");
    expect(runningTasks.tasks).toHaveLength(1);
    expect(runningTasks.tasks[0]).toMatchObject({
      label: "Read hello.txt",
      kind: "subagent",
      mode: "background",
      status: "running",
      canStop: true,
      owner: "bound",
    });

    // Child internal thinking, tool call, tool result, and text must be scoped, NOT mixed into parent reply
    await gateway.emitEvent(childId, "turn/start", { turn: 1 }, 1);
    await gateway.emitMux({
      type: "session/assistant-stream",
      sessionId: childId,
      prefix: { turn: 1, step: 1, attemptId: "a1", text: "Reading hello.txt now.", reasoning: "Need to inspect hello.txt" },
    });
    await gateway.emitEvent(childId, "tool/call", {
      turn: 1,
      step: 1,
      callId: "child-tool-1",
      name: "read_file",
      arguments: JSON.stringify({ path: "hello.txt" }),
    }, 2);
    await gateway.emitEvent(childId, "tool/result", {
      turn: 1,
      step: 1,
      message: {
        role: "tool",
        toolCallId: "child-tool-1",
        content: [{ type: "text", text: "Hello from workspace" }],
        isError: false,
      },
    }, 3);
    await gateway.emitEvent(childId, "assistant/message", {
      turn: 1,
      step: 2,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Child report: Hello from workspace" }],
      },
    }, 4);
    await gateway.emitEvent(childId, "turn/end", { turn: 1, reason: { kind: "completed" } }, 5);

    // Real DSH order: activation.handle.dispose() emits api-session/removed BEFORE
    // notifySettlement() delivers user/message (subagent-settled) to the parent.
    await gateway.emitHost({ type: "host/session-removed", sessionId: childId });
    await gateway.emitEvent(sessionId, "user/message", {
      content: [
        { type: "text", text: "Background subagent reader finished and will do no further work unless you send it more." },
        { type: "text", text: "Its closing message:" },
        { type: "text", text: "Child report: Hello from workspace" },
      ],
      source: {
        kind: "subagent-settled",
        form: "notice",
        summary: "Background subagent reader finished and will do no further work unless you send it more.",
        stopReason: "completed",
        senderSessionId: childId,
      },
    }, 6);
    await gateway.emitEvent(sessionId, "assistant/message", {
      turn: 1,
      step: 2,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Parent final answer: file says Hello from workspace." }],
      },
    }, 7);
    await gateway.emitEvent(sessionId, "turn/end", { turn: 1, reason: { kind: "completed" } }, 8);

    const response = await turnPromise;
    expect(response.text).toBe("Parent final answer: file says Hello from workspace.");

    // Unscoped assistant text must never include child's internal text
    const unscopedTexts = events
      .filter((e): e is Extract<EngineStreamEvent, { type: "assistant_text" }> => e.type === "assistant_text")
      .map((e) => e.text);
    expect(unscopedTexts.join("\n")).not.toContain("Reading hello.txt now.");
    expect(unscopedTexts.join("\n")).not.toContain("Child report:");

    // Scoped events must carry child thinking, tool_use, tool_result, result, and scope_status done
    const scopedEvents = events.filter((e): e is Extract<EngineStreamEvent, { type: "scoped" }> => e.type === "scoped");
    expect(scopedEvents.length).toBeGreaterThan(0);
    expect(scopedEvents.every((e) => e.detached === true && e.origin === "bound" && e.scope.kind === "subagent")).toBe(true);
    expect(scopedEvents.some((e) => e.event.type === "tool_use" && e.event.toolName === "read_file")).toBe(true);
    expect(scopedEvents.some((e) => e.event.type === "tool_result" && e.event.toolUseId === "child-tool-1")).toBe(true);
    expect(scopedEvents.some((e) => e.event.type === "result" && e.event.text.includes("Child report: Hello from workspace"))).toBe(true);
    expect(scopedEvents.some((e) => e.event.type === "scope_status" && e.event.status === "done")).toBe(true);

    // Parent lifecycle receipts recorded
    const activities = events.filter((e): e is Extract<EngineStreamEvent, { type: "subagent_activity" }> => e.type === "subagent_activity");
    expect(activities.map((a) => a.kind)).toEqual(["started", "completed"]);

    // Task panel retains recently finished subagent with canStop: false
    const finishedTasks = await adapter.listTasks(sessionId);
    expect(finishedTasks.tasks).toHaveLength(1);
    expect(finishedTasks.tasks[0]).toMatchObject({
      label: "Read hello.txt",
      status: "done",
      canStop: false,
    });
  });

  it("stops an individual running subagent via stopTask -> subagents.interruptByUser", async () => {
    const gateway = new FakeSubagentGateway();
    const adapter = new DeepSeekHarnessAdapter({ gateway, workspacePath: "/tmp/example-workspace", turnSettleDelayMs: 5 });
    const events: EngineStreamEvent[] = [];
    const sessionId = "parent-session-2";
    const childId = "child-sleeper-1";

    const turnPromise = adapter.sendUserMessage(sessionId, {
      text: "Run sleeper subagent",
      files: [],
      onEngineEvent: (event) => { events.push(event); },
    });

    await waitFor(() => Boolean(gateway.lastPromptId(sessionId)));
    const rpcId = gateway.lastPromptId(sessionId)!;

    await gateway.emitEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitEvent(sessionId, "user/message", {
      content: [{ type: "text", text: "Run sleeper subagent" }],
      source: { kind: "user", rpcId },
    }, 2);
    await gateway.emitEvent(sessionId, "subagent/catalog", {
      version: 3,
      childId,
      childCreatedAt: Date.now(),
      mode: "continuable",
      label: "Sleep 30s",
      name: "sleeper",
    }, 3);

    const snapshot = await adapter.listTasks(sessionId);
    expect(snapshot.tasks).toHaveLength(1);
    const taskId = snapshot.tasks[0]!.id;

    const stopResult = await adapter.stopTask(sessionId, { taskId });
    expect(stopResult).toEqual({ outcome: "accepted" });
    expect(gateway.calls.some((c) => c.method === "subagents.interruptByUser" && (c.payload as any).childSessionId === childId)).toBe(true);

    // Child aborts and settles
    await gateway.emitEvent(childId, "turn/end", { turn: 1, reason: { kind: "aborted" } }, 2);
    await gateway.emitEvent(sessionId, "user/message", {
      content: [{ type: "text", text: "Background subagent sleeper was stopped before it finished." }],
      source: {
        kind: "subagent-settled",
        form: "notice",
        summary: "Background subagent sleeper was stopped before it finished.",
        stopReason: "aborted",
        senderSessionId: childId,
      },
    }, 4);
    await gateway.emitEvent(sessionId, "assistant/message", {
      turn: 1,
      step: 2,
      message: { role: "assistant", content: [{ type: "text", text: "Subagent was stopped." }] },
    }, 5);
    await gateway.emitEvent(sessionId, "turn/end", { turn: 1, reason: { kind: "completed" } }, 6);

    await turnPromise;
    expect(events.some((e) => e.type === "scoped" && e.event.type === "scope_status" && e.event.status === "stopped")).toBe(true);
    expect(events.some((e) => e.type === "subagent_activity" && e.kind === "interrupted")).toBe(true);

    // Stale stop after completion is rejected
    expect(await adapter.stopTask(sessionId, { taskId })).toEqual({ outcome: "rejected", reason: "stale" });
  });

  it("interrupts all active subagents when the main turn is stopped so no orphans remain", async () => {
    const gateway = new FakeSubagentGateway();
    const adapter = new DeepSeekHarnessAdapter({ gateway, workspacePath: "/tmp/example-workspace", turnSettleDelayMs: 5 });
    const controller = new AbortController();
    const events: EngineStreamEvent[] = [];
    const sessionId = "parent-session-3";
    const childA = "child-orphan-a";
    const childB = "child-orphan-b";

    const turnPromise = adapter.sendUserMessage(sessionId, {
      text: "Start two subagents",
      files: [],
      abortSignal: controller.signal,
      onEngineEvent: (event) => { events.push(event); },
    });

    await waitFor(() => Boolean(gateway.lastPromptId(sessionId)));
    const rpcId = gateway.lastPromptId(sessionId)!;

    await gateway.emitEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitEvent(sessionId, "user/message", {
      content: [{ type: "text", text: "Start two subagents" }],
      source: { kind: "user", rpcId },
    }, 2);
    await gateway.emitEvent(sessionId, "subagent/catalog", {
      version: 3, childId: childA, childCreatedAt: Date.now(), mode: "continuable", label: "Worker A", name: "worker-a",
    }, 3);
    await gateway.emitEvent(sessionId, "subagent/catalog", {
      version: 3, childId: childB, childCreatedAt: Date.now(), mode: "continuable", label: "Worker B", name: "worker-b",
    }, 4);

    controller.abort();
    await expect(turnPromise).rejects.toThrow();

    const interrupted = gateway.calls
      .filter((c) => c.method === "subagents.interruptByUser")
      .map((c) => (c.payload as { childSessionId: string }).childSessionId)
      .sort();
    expect(interrupted).toEqual([childA, childB]);
    expect(events.filter((e) => e.type === "scoped" && e.event.type === "scope_status" && e.event.status === "stopped")).toHaveLength(2);
  });

  it("maps DSH subagent and control tools to delegate action and readable titles", () => {
    expect(runToolAction("subagent")).toBe("delegate");
    expect(runToolAction("wait_agent")).toBe("delegate");
    expect(runToolAction("send_message")).toBe("delegate");
    expect(runToolAction("interrupt_agent")).toBe("delegate");
    expect(runToolAction("list_agents")).toBe("delegate");

    const base = { seq: 1, revision: 1, at: Date.now(), kind: "tool" as const, status: "done" as const };
    expect(runEntryTitle({ ...base, name: "subagent", input: JSON.stringify({ name: "reader", description: "Read hello.txt" }) })).toContain("Read hello.txt");
    expect(runEntryTitle({ ...base, name: "wait_agent", input: "{}" })).toContain("等待子代理");
    expect(runEntryTitle({ ...base, name: "send_message", input: JSON.stringify({ agent: "reader" }) })).toContain("向子代理发送消息");
    expect(runEntryTitle({ ...base, name: "interrupt_agent", input: JSON.stringify({ agent: "sleeper" }) })).toContain("中断子代理");
    expect(runEntryTitle({ ...base, name: "list_agents", input: "{}" })).toContain("查看子代理");
  });

  it("Bug #1: waits for authoritative subagent-settled after host/session-removed even with slow event callback, and falls back to unknown (never done) if no settlement arrives", async () => {
    // Part A: slow onEngineEvent on catalog + real DSH dispose-before-settlement order
    const gatewayA = new FakeSubagentGateway();
    const adapterA = new DeepSeekHarnessAdapter({
      gateway: gatewayA,
      workspacePath: "/tmp/example-workspace",
      turnSettleDelayMs: 5,
      subagentRemovalFallbackMs: 200,
    });
    const eventsA: EngineStreamEvent[] = [];
    const sessionIdA = "parent-bug1-a";
    const childIdA = "child-bug1-a";
    let releaseCard!: () => void;
    const cardGate = new Promise<void>((r) => { releaseCard = r; });

    const turnA = adapterA.sendUserMessage(sessionIdA, {
      text: "Fast child",
      files: [],
      onEngineEvent: async (event) => {
        if (event.type === "scoped" && event.event.type === "scope_status" && event.event.status === "running") {
          await cardGate;
        }
        eventsA.push(event);
      },
    });
    await waitFor(() => Boolean(gatewayA.lastPromptId(sessionIdA)));
    await gatewayA.emitEvent(sessionIdA, "turn/start", { turn: 1 }, 1);
    await gatewayA.emitEvent(sessionIdA, "user/message", {
      content: [{ type: "text", text: "Fast child" }],
      source: { kind: "user", rpcId: gatewayA.lastPromptId(sessionIdA) },
    }, 2);
    const catalogP = gatewayA.emitEvent(sessionIdA, "subagent/catalog", {
      version: 3, childId: childIdA, childCreatedAt: Date.now(), mode: "continuable", label: "Fast worker", name: "fast",
    }, 3);
    // Child unloads while catalog card send is still in flight
    await gatewayA.emitHost({ type: "host/session-removed", sessionId: childIdA });
    releaseCard();
    await catalogP;
    // Authoritative subagent-settled arrives next with closing report
    await gatewayA.emitEvent(sessionIdA, "user/message", {
      content: [
        { type: "text", text: "Background subagent fast finished." },
        { type: "text", text: "Its closing message:" },
        { type: "text", text: "Authoritative fast report" },
      ],
      source: { kind: "subagent-settled", form: "notice", stopReason: "completed", senderSessionId: childIdA },
    }, 4);
    await gatewayA.emitEvent(sessionIdA, "assistant/message", {
      turn: 1, step: 2, message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
    }, 5);
    await gatewayA.emitEvent(sessionIdA, "turn/end", { turn: 1, reason: { kind: "completed" } }, 6);
    await turnA;

    const scopedA = eventsA.filter((e): e is Extract<EngineStreamEvent, { type: "scoped" }> => e.type === "scoped");
    expect(scopedA.some((e) => e.event.type === "result" && e.event.text === "Authoritative fast report")).toBe(true);
    expect(scopedA.flatMap((e) => (e.event.type === "scope_status" ? [e.event.status] : []))).toEqual(["running", "done"]);
    expect((await adapterA.listTasks(sessionIdA)).tasks[0]?.status).toBe("done");
    await adapterA.destroy();

    // Part B: host/session-removed with partial finalText and NO settlement falls back to "unknown"
    // and triggers background review settlement when parent turn already ended.
    const gatewayB = new FakeSubagentGateway();
    const adapterB = new DeepSeekHarnessAdapter({
      gateway: gatewayB,
      workspacePath: "/tmp/example-workspace",
      turnSettleDelayMs: 5,
      backgroundReviewGraceMs: 25,
      subagentRemovalFallbackMs: 25,
    });
    const eventsB: EngineStreamEvent[] = [];
    const sessionIdB = "parent-bug1-b";
    const childIdB = "child-bug1-b";
    const turnB = adapterB.sendUserMessage(sessionIdB, {
      text: "Disappearing child",
      files: [],
      onEngineEvent: (event) => { eventsB.push(event); },
    });
    await waitFor(() => Boolean(gatewayB.lastPromptId(sessionIdB)));
    await gatewayB.emitEvent(sessionIdB, "turn/start", { turn: 1 }, 1);
    await gatewayB.emitEvent(sessionIdB, "user/message", {
      content: [{ type: "text", text: "Disappearing child" }],
      source: { kind: "user", rpcId: gatewayB.lastPromptId(sessionIdB) },
    }, 2);
    await gatewayB.emitEvent(sessionIdB, "subagent/catalog", {
      version: 3, childId: childIdB, childCreatedAt: Date.now(), mode: "continuable", label: "Lost worker", name: "lost",
    }, 3);
    await gatewayB.emitEvent(childIdB, "assistant/message", {
      turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "Partial text before crash" }] },
    }, 1);
    await gatewayB.emitEvent(sessionIdB, "assistant/message", {
      turn: 1, step: 2, message: { role: "assistant", content: [{ type: "text", text: "Waiting on worker" }] },
    }, 4);
    await gatewayB.emitEvent(sessionIdB, "turn/end", { turn: 1, reason: { kind: "completed" } }, 5);
    await gatewayB.emitHost({ type: "host/session-removed", sessionId: childIdB });

    const responseB = await turnB;
    expect(responseB.text).toBe("Waiting on worker");
    expect((await adapterB.listTasks(sessionIdB)).tasks[0]?.status).toBe("unknown");
    const statusesB = eventsB
      .filter((e): e is Extract<EngineStreamEvent, { type: "scoped" }> => e.type === "scoped" && e.event.type === "scope_status")
      .map((e) => (e.event as { status: string }).status);
    expect(statusesB).toEqual(["running", "unknown"]);
    await adapterB.destroy();
  });

  it("Bug #2: preserves diagnostic/structured-only reports, supports continuable send_message multi-turn & cold resume, and handles nested subagents", async () => {
    const gateway = new FakeSubagentGateway();
    const adapter = new DeepSeekHarnessAdapter({
      gateway,
      workspacePath: "/tmp/example-workspace",
      turnSettleDelayMs: 5,
      backgroundReviewGraceMs: 100,
    });
    const events: EngineStreamEvent[] = [];
    const rootId = "parent-bug2";
    const errChildId = "child-err-diag";
    const contChildId = "child-continuable";
    const nestedParentId = "child-lead";
    const nestedGrandId = "child-grand-ext";

    const turnPromise = adapter.sendUserMessage(rootId, {
      text: "Complex subagent flows",
      files: [],
      onEngineEvent: (event) => { events.push(event); },
    });
    await waitFor(() => Boolean(gateway.lastPromptId(rootId)));
    await gateway.emitEvent(rootId, "turn/start", { turn: 1 }, 1);
    await gateway.emitEvent(rootId, "user/message", {
      content: [{ type: "text", text: "Complex subagent flows" }],
      source: { kind: "user", rpcId: gateway.lastPromptId(rootId) },
    }, 2);

    // (1) Error child with empty finalText whose diagnostic lives ONLY in subagent-settled
    await gateway.emitEvent(rootId, "subagent/catalog", {
      version: 3, childId: errChildId, childCreatedAt: Date.now(), mode: "continuable", label: "Diag worker", name: "diag",
    }, 3);
    await gateway.emitEvent(errChildId, "turn/start", { turn: 1 }, 1);
    await gateway.emitEvent(errChildId, "turn/end", { turn: 1, reason: { kind: "error", error: { message: "Provider 500" } } }, 2);
    await gateway.emitHost({ type: "host/session-removed", sessionId: errChildId });
    await gateway.emitEvent(rootId, "user/message", {
      content: [
        { type: "text", text: "Background subagent diag failed before it finished." },
        { type: "text", text: "It left no closing message." },
        { type: "text", text: "Diagnostic: upstream returned 500" },
      ],
      source: { kind: "subagent-settled", form: "notice", stopReason: "error", senderSessionId: errChildId },
    }, 4);
    expect(events.some((e) => e.type === "scoped" && e.taskId === errChildId && e.event.type === "result" && e.event.text.includes("Diagnostic: upstream returned 500"))).toBe(true);
    expect(events.some((e) => e.type === "scoped" && e.taskId === errChildId && e.event.type === "scope_status" && e.event.status === "error")).toBe(true);

    // (2) Continuable child: Turn 1 -> settle & remove -> cold-resume via send_message -> Turn 2 tools & settle
    await gateway.emitEvent(rootId, "subagent/catalog", {
      version: 3, childId: contChildId, childCreatedAt: Date.now(), mode: "continuable", label: "Continuable worker", name: "worker",
    }, 5);
    await gateway.emitEvent(contChildId, "turn/start", { turn: 1 }, 1);
    await gateway.emitEvent(contChildId, "assistant/message", {
      turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "Turn 1 answer" }] },
    }, 2);
    await gateway.emitEvent(contChildId, "turn/end", { turn: 1, reason: { kind: "completed" } }, 3);
    await gateway.emitHost({ type: "host/session-removed", sessionId: contChildId });
    await gateway.emitEvent(rootId, "user/message", {
      content: [
        { type: "text", text: "Background subagent worker finished." },
        { type: "text", text: "Its closing message:" },
        { type: "text", text: "Turn 1 answer" },
      ],
      source: { kind: "subagent-settled", form: "notice", stopReason: "completed", senderSessionId: contChildId },
    }, 6);
    expect((await adapter.listTasks(rootId)).tasks.find((t) => t.label === "Continuable worker")).toMatchObject({ status: "done", canStop: false });

    const followCallsBeforeResume = gateway.calls.filter((c) => c.method === "session.followSubagent" && (c.payload as { childSessionId?: string }).childSessionId === contChildId).length;
    await gateway.emitEvent(rootId, "tool/call", {
      turn: 1, step: 2, callId: "call-sm-1", name: "send_message", arguments: JSON.stringify({ agent: "worker", message: "Do step 2" }),
    }, 7);
    await gateway.emitEvent(rootId, "tool/result", {
      turn: 1, step: 2, message: { role: "tool", toolCallId: "call-sm-1", content: [{ type: "text", text: "message delivered to agent worker" }], isError: false },
    }, 8);

    // Must reopen with canStop: true, re-follow, and process Turn 2 events in a fresh scope without replaying seq <= 3
    expect((await adapter.listTasks(rootId)).tasks.find((t) => t.label === "Continuable worker")).toMatchObject({ status: "running", canStop: true });
    expect(gateway.calls.filter((c) => c.method === "session.followSubagent" && (c.payload as { childSessionId?: string }).childSessionId === contChildId).length).toBe(followCallsBeforeResume + 1);
    // Replaying seq 2 from snapshot must be ignored; seq 4+ must be processed
    await gateway.emitEvent(contChildId, "tool/call", { turn: 1, step: 1, callId: "old-replayed", name: "stale_tool", arguments: "{}" }, 2);
    await gateway.emitEvent(contChildId, "turn/start", { turn: 2 }, 4);
    await gateway.emitEvent(contChildId, "tool/call", { turn: 2, step: 1, callId: "turn2-tool", name: "read_file", arguments: JSON.stringify({ path: "b.txt" }) }, 5);
    await gateway.emitEvent(contChildId, "tool/result", {
      turn: 2, step: 1, message: { role: "tool", toolCallId: "turn2-tool", content: [{ type: "text", text: "B" }], isError: false },
    }, 6);
    await gateway.emitEvent(contChildId, "turn/end", { turn: 2, reason: { kind: "completed" } }, 7);
    await gateway.emitHost({ type: "host/session-removed", sessionId: contChildId });
    await gateway.emitEvent(rootId, "user/message", {
      content: [
        { type: "text", text: "Background subagent worker finished." },
        { type: "text", text: "Its closing message:" },
        { type: "text", text: "Turn 2 answer" },
      ],
      source: { kind: "subagent-settled", form: "notice", stopReason: "completed", senderSessionId: contChildId },
    }, 9);

    const contScoped = events.filter((e): e is Extract<EngineStreamEvent, { type: "scoped" }> => e.type === "scoped" && e.taskId === contChildId);
    expect(contScoped.some((e) => e.event.type === "tool_use" && e.event.toolUseId === "old-replayed")).toBe(false);
    const turn2Tool = contScoped.find((e) => e.event.type === "tool_use" && e.event.toolUseId === "turn2-tool");
    expect(turn2Tool).toBeDefined();
    expect(turn2Tool!.scope.id).not.toBe(contChildId); // fresh activation scope!
    expect(contScoped.some((e) => e.scope.id === turn2Tool!.scope.id && e.event.type === "result" && e.event.text === "Turn 2 answer")).toBe(true);

    // (3) Nested subagents: lead spawns external grandchild, lead Turn 1 ends, grandchild settles to lead, lead Turn 2 completes
    await gateway.emitEvent(rootId, "subagent/catalog", {
      version: 3, childId: nestedParentId, childCreatedAt: Date.now(), mode: "continuable", label: "Lead", name: "lead",
    }, 10);
    await gateway.emitEvent(nestedParentId, "turn/start", { turn: 1 }, 1);
    await gateway.emitEvent(nestedParentId, "subagent/catalog", {
      version: 3, childId: nestedGrandId, childCreatedAt: Date.now(), mode: "external", label: "External grandchild", name: "ext-grand",
    }, 2);
    await gateway.emitEvent(nestedParentId, "turn/end", { turn: 1, reason: { kind: "completed" } }, 3);
    // Lead MUST still be running after Turn 1 end!
    expect((await adapter.listTasks(rootId)).tasks.find((t) => t.label === "Lead")?.status).toBe("running");
    // Grandchild settles back to lead (via user/message inside lead's event stream)
    await gateway.emitEvent(nestedParentId, "user/message", {
      content: [
        { type: "text", text: "Background subagent ext-grand finished." },
        { type: "text", text: "Its closing message:" },
        { type: "text", text: "Grandchild output" },
      ],
      source: { kind: "subagent-settled", form: "notice", stopReason: "completed", senderSessionId: nestedGrandId },
    }, 4);
    expect((await adapter.listTasks(rootId)).tasks.find((t) => t.label === "External grandchild")?.status).toBe("done");
    // Lead runs Turn 2 and settles back to root
    await gateway.emitEvent(nestedParentId, "turn/start", { turn: 2 }, 5);
    await gateway.emitEvent(nestedParentId, "assistant/message", {
      turn: 2, step: 1, message: { role: "assistant", content: [{ type: "text", text: "Lead final combining Grandchild output" }] },
    }, 6);
    await gateway.emitEvent(nestedParentId, "turn/end", { turn: 2, reason: { kind: "completed" } }, 7);
    await gateway.emitHost({ type: "host/session-removed", sessionId: nestedParentId });
    await gateway.emitEvent(rootId, "user/message", {
      content: [
        { type: "text", text: "Background subagent lead finished." },
        { type: "text", text: "Its closing message:" },
        { type: "text", text: "Lead final combining Grandchild output" },
      ],
      source: { kind: "subagent-settled", form: "notice", stopReason: "completed", senderSessionId: nestedParentId },
    }, 11);

    await gateway.emitEvent(rootId, "assistant/message", {
      turn: 1, step: 3, message: { role: "assistant", content: [{ type: "text", text: "All done." }] },
    }, 12);
    await gateway.emitEvent(rootId, "turn/end", { turn: 1, reason: { kind: "completed" } }, 13);

    await expect(turnPromise).resolves.toMatchObject({ text: "All done." });
    expect(events.some((e) => e.type === "scoped" && e.taskId === nestedGrandId && e.event.type === "result" && e.event.text === "Grandchild output")).toBe(true);
    expect(events.some((e) => e.type === "scoped" && e.taskId === nestedParentId && e.event.type === "result" && e.event.text === "Lead final combining Grandchild output")).toBe(true);
    await adapter.destroy();
  });

  it("Bug #3: host restart terminalizes process-local running subagents as error and unblocks listTasks, stopTask, and getHistoryState/forkHistory", async () => {
    const gateway = new FakeSubagentGateway();
    const sessionId = "parent-bug3";
    const childId = "child-bug3";
    gateway.listItems = [{ sessionId, updatedAt: Date.now(), running: false, blank: false, cwd: "/tmp/example-workspace" }];
    const adapter = new DeepSeekHarnessAdapter({ gateway, workspacePath: "/tmp/example-workspace", turnSettleDelayMs: 5 });
    const events: EngineStreamEvent[] = [];

    const turnPromise = adapter.sendUserMessage(sessionId, {
      text: "Run background worker",
      files: [],
      onEngineEvent: (event) => { events.push(event); },
    });
    await waitFor(() => Boolean(gateway.lastPromptId(sessionId)));
    await gateway.emitEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitEvent(sessionId, "user/message", {
      content: [{ type: "text", text: "Run background worker" }],
      source: { kind: "user", rpcId: gateway.lastPromptId(sessionId) },
    }, 2);
    await gateway.emitEvent(sessionId, "subagent/catalog", {
      version: 3, childId, childCreatedAt: Date.now(), mode: "continuable", label: "Crash victim", name: "victim",
    }, 3);

    const beforeRestart = await adapter.listTasks(sessionId);
    expect(beforeRestart.tasks).toHaveLength(1);
    const oldToken = beforeRestart.tasks[0]!.id;

    // Simulate dsh process crash & restart
    await gateway.handlers?.onDisconnect?.(new Error("dsh exited"));
    await gateway.handlers?.onReconnect?.({ reason: "host-restart" });
    await expect(turnPromise).rejects.toThrow(/restarted/i);

    expect(events.some((e) => e.type === "scoped" && e.taskId === childId && e.event.type === "scope_status" && e.event.status === "error")).toBe(true);
    expect(events.some((e) => e.type === "subagent_activity" && e.agentId === childId && e.kind === "completed")).toBe(true);
    expect((await adapter.listTasks(sessionId)).tasks).toEqual([]);
    expect(await adapter.stopTask(sessionId, { taskId: oldToken })).toEqual({ outcome: "rejected", reason: "stale" });
    const historyState = await adapter.getHistoryState(sessionId);
    expect(historyState.blocked).toBeUndefined();
    await adapter.destroy();
  });

  it("Bug #5: cancels parent before interrupting subagents, skips subagent interrupt when parent stop is refused, and leaves subagents running when interruptByUser fails", async () => {
    // Part A: call order (cancelPrompt before interruptByUser) & failed interruptByUser keeps subagent running
    const gatewayA = new FakeSubagentGateway();
    gatewayA.interruptHandler = async (childId) => {
      if (childId === "child-fail") throw new Error("network error");
      if (childId === "child-unaccepted") return { accepted: false };
      return { accepted: true };
    };
    const adapterA = new DeepSeekHarnessAdapter({ gateway: gatewayA, workspacePath: "/tmp/example-workspace", turnSettleDelayMs: 5 });
    const controllerA = new AbortController();
    const eventsA: EngineStreamEvent[] = [];
    const sessionIdA = "parent-bug5-a";

    const turnA = adapterA.sendUserMessage(sessionIdA, {
      text: "Run three children",
      files: [],
      abortSignal: controllerA.signal,
      onEngineEvent: (event) => { eventsA.push(event); },
    });
    await waitFor(() => Boolean(gatewayA.lastPromptId(sessionIdA)));
    await gatewayA.emitEvent(sessionIdA, "turn/start", { turn: 1 }, 1);
    await gatewayA.emitEvent(sessionIdA, "user/message", {
      content: [{ type: "text", text: "Run three children" }],
      source: { kind: "user", rpcId: gatewayA.lastPromptId(sessionIdA) },
    }, 2);
    await gatewayA.emitEvent(sessionIdA, "subagent/catalog", {
      version: 3, childId: "child-ok", childCreatedAt: Date.now(), mode: "continuable", label: "OK", name: "ok",
    }, 3);
    await gatewayA.emitEvent(sessionIdA, "subagent/catalog", {
      version: 3, childId: "child-fail", childCreatedAt: Date.now(), mode: "continuable", label: "Fail", name: "fail",
    }, 4);
    await gatewayA.emitEvent(sessionIdA, "subagent/catalog", {
      version: 3, childId: "child-unaccepted", childCreatedAt: Date.now(), mode: "continuable", label: "Unaccepted", name: "unaccepted",
    }, 5);

    controllerA.abort();
    await expect(turnA).rejects.toThrow();

    const relevantMethods = gatewayA.calls
      .filter((c) => c.method === "native.cancelPrompt" || c.method === "subagents.interruptByUser")
      .map((c) => c.method);
    expect(relevantMethods[0]).toBe("native.cancelPrompt");
    expect(relevantMethods.slice(1)).toEqual([
      "subagents.interruptByUser",
      "subagents.interruptByUser",
      "subagents.interruptByUser",
    ]);

    const tasksA = (await adapterA.listTasks(sessionIdA)).tasks;
    expect(tasksA.find((t) => t.label === "OK")).toMatchObject({ status: "stopped", canStop: false });
    expect(tasksA.find((t) => t.label === "Fail")).toMatchObject({ status: "running", canStop: true });
    expect(tasksA.find((t) => t.label === "Unaccepted")).toMatchObject({ status: "running", canStop: true });
    expect(eventsA.filter((e) => e.type === "scoped" && e.event.type === "scope_status" && e.event.status === "stopped").map((e) => (e as Extract<EngineStreamEvent, { type: "scoped" }>).taskId)).toEqual(["child-ok"]);
    await adapterA.destroy();

    // Part B: when cancelPrompt refuses ("goal-active" / "settled"), subagents are NOT interrupted
    const gatewayB = new FakeSubagentGateway();
    gatewayB.cancelOutcome = "settled";
    const adapterB = new DeepSeekHarnessAdapter({ gateway: gatewayB, workspacePath: "/tmp/example-workspace", turnSettleDelayMs: 5 });
    const controllerB = new AbortController();
    const sessionIdB = "parent-bug5-b";
    const turnB = adapterB.sendUserMessage(sessionIdB, {
      text: "Settled stop",
      files: [],
      abortSignal: controllerB.signal,
    });
    await waitFor(() => Boolean(gatewayB.lastPromptId(sessionIdB)));
    await gatewayB.emitEvent(sessionIdB, "turn/start", { turn: 1 }, 1);
    await gatewayB.emitEvent(sessionIdB, "user/message", {
      content: [{ type: "text", text: "Settled stop" }],
      source: { kind: "user", rpcId: gatewayB.lastPromptId(sessionIdB) },
    }, 2);
    await gatewayB.emitEvent(sessionIdB, "subagent/catalog", {
      version: 3, childId: "child-untouched", childCreatedAt: Date.now(), mode: "continuable", label: "Untouched", name: "untouched",
    }, 3);
    controllerB.abort();
    await expect(turnB).rejects.toThrow();
    expect(gatewayB.calls.some((c) => c.method === "subagents.interruptByUser")).toBe(false);
    expect((await adapterB.listTasks(sessionIdB)).tasks[0]).toMatchObject({ status: "running", canStop: true });
    await adapterB.destroy();

    // Part C: clearThreadGoal cancels parent session BEFORE interrupting subagents
    const gatewayC = new FakeSubagentGateway();
    const sessionIdC = "parent-bug5-c";
    let goalCreated = false;
    gatewayC.historyHandler = () => {
      goalCreated = goalCreated || gatewayC.calls.some((c) => c.method === "goal.create");
      return {
        events: [],
        hasMore: false,
        projections: {
          asOfSeq: goalCreated ? 2 : 1,
          values: {
            goal: goalCreated
              ? {
                  goal: { id: "goal-1", revision: 1, objective: "Obj", phase: "active", maxGoalRounds: 5 },
                  roundsStarted: 1,
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                }
              : null,
          },
        },
      };
    };
    const adapterC = new DeepSeekHarnessAdapter({ gateway: gatewayC, workspacePath: "/tmp/example-workspace" });
    const goalPromise = adapterC.watchThreadGoal(sessionIdC, { objective: "Obj" });
    await waitFor(() => gatewayC.calls.some((c) => c.method === "goal.create"));
    await gatewayC.emitEvent(sessionIdC, "subagent/catalog", {
      version: 3, childId: "child-goal-1", childCreatedAt: Date.now(), mode: "continuable", label: "Goal worker", name: "gw",
    }, 1);
    await adapterC.clearThreadGoal(sessionIdC);
    await goalPromise;
    const goalStopOrder = gatewayC.calls
      .filter((c) => c.method === "session.cancel" || c.method === "subagents.interruptByUser")
      .map((c) => c.method);
    expect(goalStopOrder).toEqual(["session.cancel", "subagents.interruptByUser"]);
    await adapterC.destroy();
  });

  it("Bug #7: concurrent finishSubagent calls never emit scope_status before result", async () => {
    const gateway = new FakeSubagentGateway();
    const adapter = new DeepSeekHarnessAdapter({ gateway, workspacePath: "/tmp/example-workspace", turnSettleDelayMs: 5 });
    const sessionId = "parent-bug7";
    const childId = "child-bug7";
    const order: string[] = [];
    let releaseResult!: () => void;
    const resultGate = new Promise<void>((r) => { releaseResult = r; });

    const turnPromise = adapter.sendUserMessage(sessionId, {
      text: "Race test",
      files: [],
      onEngineEvent: async (event) => {
        if (event.type === "scoped" && event.taskId === childId) {
          if (event.event.type === "result") {
            order.push("result_start");
            await resultGate;
            order.push("result_done");
          } else if (event.event.type === "scope_status") {
            order.push(`scope_status:${event.event.status}`);
          }
        }
      },
    });
    await waitFor(() => Boolean(gateway.lastPromptId(sessionId)));
    await gateway.emitEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitEvent(sessionId, "user/message", {
      content: [{ type: "text", text: "Race test" }],
      source: { kind: "user", rpcId: gateway.lastPromptId(sessionId) },
    }, 2);
    await gateway.emitEvent(sessionId, "subagent/catalog", {
      version: 3, childId, childCreatedAt: Date.now(), mode: "continuable", label: "Racer", name: "racer",
    }, 3);

    // Trigger subagent-settled and concurrently simulate a competing terminal transition
    const settle1 = gateway.emitEvent(sessionId, "user/message", {
      content: [
        { type: "text", text: "Background subagent racer finished." },
        { type: "text", text: "Its closing message:" },
        { type: "text", text: "Important closing report" },
      ],
      source: { kind: "subagent-settled", form: "notice", stopReason: "completed", senderSessionId: childId },
    }, 4);
    await waitFor(() => order.includes("result_start"));
    // While result delivery is mid-await, fire another settlement / removal on the child
    await gateway.emitHost({ type: "host/session-removed", sessionId: childId });
    releaseResult();
    await settle1;
    await gateway.emitEvent(sessionId, "assistant/message", {
      turn: 1, step: 2, message: { role: "assistant", content: [{ type: "text", text: "Finished." }] },
    }, 5);
    await gateway.emitEvent(sessionId, "turn/end", { turn: 1, reason: { kind: "completed" } }, 6);
    await turnPromise;

    expect(order).toEqual(["scope_status:running", "result_start", "result_done", "scope_status:done"]);
    await adapter.destroy();
  });

  it("Bug #8: waits for Turn 2 background review in multi-subagent turns and ignores late settlements from earlier turns", async () => {
    const gateway = new FakeSubagentGateway();
    const adapter = new DeepSeekHarnessAdapter({
      gateway,
      workspacePath: "/tmp/example-workspace",
      turnSettleDelayMs: 5,
      backgroundReviewGraceMs: 200,
    });
    const sessionId = "parent-bug8";
    const childA = "child-bug8-a";
    const childB = "child-bug8-b";

    const turnPromise = adapter.sendUserMessage(sessionId, {
      text: "Run A and B",
      files: [],
    });
    await waitFor(() => Boolean(gateway.lastPromptId(sessionId)));
    await gateway.emitEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitEvent(sessionId, "user/message", {
      content: [{ type: "text", text: "Run A and B" }],
      source: { kind: "user", rpcId: gateway.lastPromptId(sessionId) },
    }, 2);
    await gateway.emitEvent(sessionId, "subagent/catalog", {
      version: 3, childId: childA, childCreatedAt: Date.now(), mode: "continuable", label: "A", name: "a",
    }, 3);
    await gateway.emitEvent(sessionId, "subagent/catalog", {
      version: 3, childId: childB, childCreatedAt: Date.now(), mode: "continuable", label: "B", name: "b",
    }, 4);
    // subA settles during Turn 1
    await gateway.emitEvent(sessionId, "user/message", {
      content: [{ type: "text", text: "A finished." }, { type: "text", text: "Its closing message:" }, { type: "text", text: "A result" }],
      source: { kind: "subagent-settled", form: "notice", stopReason: "completed", senderSessionId: childA },
    }, 5);
    // subB emits child turn/end right before parent Turn 1 ends, BEFORE subB's subagent-settled arrives
    await gateway.emitEvent(childB, "turn/end", { turn: 1, reason: { kind: "completed" } }, 1);
    await gateway.emitEvent(sessionId, "assistant/message", {
      turn: 1, step: 2, message: { role: "assistant", content: [{ type: "text", text: "Partial pre-B reply" }] },
    }, 6);
    await gateway.emitEvent(sessionId, "turn/end", { turn: 1, reason: { kind: "completed" } }, 7);
    // subB settles right after parent Turn 1 ended (while activeTurns is empty)
    await gateway.emitEvent(sessionId, "user/message", {
      content: [{ type: "text", text: "B finished." }, { type: "text", text: "Its closing message:" }, { type: "text", text: "B result" }],
      source: { kind: "subagent-settled", form: "notice", stopReason: "completed", senderSessionId: childB },
    }, 8);

    // Must NOT settle prematurely with "Partial pre-B reply" after turnSettleDelayMs (5ms)
    let settledEarly = false;
    void turnPromise.finally(() => { settledEarly = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(settledEarly).toBe(false);

    // Parent Turn 2 reviews B and finishes
    await gateway.emitEvent(sessionId, "turn/start", { turn: 2 }, 9);
    await gateway.emitEvent(sessionId, "assistant/message", {
      turn: 2, step: 1, message: { role: "assistant", content: [{ type: "text", text: "Complete A+B answer" }] },
    }, 10);
    await gateway.emitEvent(sessionId, "turn/end", { turn: 2, reason: { kind: "completed" } }, 11);

    await expect(turnPromise).resolves.toMatchObject({ text: "Complete A+B answer" });
    await adapter.destroy();
  });

  it("Bug #9: stopping a subagent via stopTask and receiving aborted settlement does not block Bridge auto-retry on a later transient parent error", async () => {
    vi.useFakeTimers();
    try {
      const gateway = new FakeSubagentGateway();
      const adapter = new DeepSeekHarnessAdapter({
        gateway,
        workspacePath: "/tmp/example-workspace",
        turnSettleDelayMs: 5,
        backgroundReviewGraceMs: 50,
      });
      const sessionId = "parent-bug9";
      const childId = "child-bug9";
      const access: AccessStoreLike = {
        load: vi.fn().mockResolvedValue({ policy: "allowlist", allowlist: [1], pairedUsers: [], pendingPairs: [] }),
        issuePairingCode: vi.fn(),
      };
      const sessionManager: SessionManagerLike = {
        getOrCreateSession: vi.fn().mockResolvedValue({ sessionId }),
        bindSession: vi.fn().mockResolvedValue(undefined),
      };
      const bridge = new Bridge(access, sessionManager, adapter);
      const events: EngineStreamEvent[] = [];

      const turnPromise = bridge.handleAuthorizedMessage({
        chatId: 1,
        userId: 1,
        chatType: "private",
        conversationKey: "conv-bug9",
        text: "Spawn sleeper then continue after transient error",
        files: [],
        locale: "en",
        onEngineEvent: (event) => { events.push(event); },
      });

      await vi.waitFor(() => expect(gateway.lastPromptId(sessionId)).toBeTruthy());
      const firstRpcId = gateway.lastPromptId(sessionId)!;

      await gateway.emitEvent(sessionId, "turn/start", { turn: 1 }, 1);
      await gateway.emitEvent(sessionId, "user/message", {
        content: [{ type: "text", text: "Spawn sleeper" }],
        source: { kind: "user", rpcId: firstRpcId },
      }, 2);
      await gateway.emitEvent(sessionId, "subagent/catalog", {
        version: 3, childId, childCreatedAt: Date.now(), mode: "continuable", label: "Sleeper", name: "sleeper",
      }, 3);

      const snapshot = await adapter.listTasks(sessionId);
      expect(await adapter.stopTask(sessionId, { taskId: snapshot.tasks[0]!.id })).toEqual({ outcome: "accepted" });

      // Child settles as aborted
      await gateway.emitHost({ type: "host/session-removed", sessionId: childId });
      await gateway.emitEvent(sessionId, "user/message", {
        content: [{ type: "text", text: "Background subagent sleeper was stopped before it finished." }],
        source: { kind: "subagent-settled", form: "notice", stopReason: "aborted", senderSessionId: childId },
      }, 4);

      // Parent turn later encounters a transient 503 SERVER error
      await gateway.emitEvent(sessionId, "turn/end", {
        turn: 1,
        reason: { kind: "error", error: { message: "Service is too busy", code: "SERVER", status: 503 } },
      }, 5);

      // Bridge must schedule automatic continuation instead of rejecting with unfinished-work
      await vi.waitFor(() => expect(events.some((e) => e.type === "engine_retry" && e.status === "waiting")).toBe(true));
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(gateway.lastPromptId(sessionId)).not.toBe(firstRpcId));
      const retryRpcId = gateway.lastPromptId(sessionId)!;

      await gateway.emitEvent(sessionId, "turn/start", { turn: 2 }, 6);
      await gateway.emitEvent(sessionId, "user/message", {
        content: [{ type: "text", text: "continue" }],
        source: { kind: "user", rpcId: retryRpcId },
      }, 7);
      await gateway.emitEvent(sessionId, "assistant/message", {
        turn: 2, step: 1, message: { role: "assistant", content: [{ type: "text", text: "Recovered after retry!" }] },
      }, 8);
      await gateway.emitEvent(sessionId, "turn/end", { turn: 2, reason: { kind: "completed" } }, 9);
      await vi.advanceTimersByTimeAsync(20);

      await expect(turnPromise).resolves.toMatchObject({ text: "Recovered after retry!" });
      await adapter.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Bug #10: matches parallel subagent parentCallIds, cleans child projections, releases turn closures, bounds ended retention, and clears state on destroy", async () => {
    const gateway = new FakeSubagentGateway();
    const adapter = new DeepSeekHarnessAdapter({ gateway, workspacePath: "/tmp/example-workspace", turnSettleDelayMs: 5 });
    const events: EngineStreamEvent[] = [];
    const sessionId = "parent-bug10";

    const turnPromise = adapter.sendUserMessage(sessionId, {
      text: "Parallel spawns",
      files: [],
      onEngineEvent: (event) => { events.push(event); },
    });
    await waitFor(() => Boolean(gateway.lastPromptId(sessionId)));
    await gateway.emitEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitEvent(sessionId, "user/message", {
      content: [{ type: "text", text: "Parallel spawns" }],
      source: { kind: "user", rpcId: gateway.lastPromptId(sessionId) },
    }, 2);

    // Emit two parallel subagent tool calls in one step before either catalog arrives
    await gateway.emitEvent(sessionId, "tool/call", {
      turn: 1, step: 1, callId: "call-alpha", name: "subagent", arguments: JSON.stringify({ name: "alpha", description: "Task A" }),
    }, 3);
    await gateway.emitEvent(sessionId, "tool/call", {
      turn: 1, step: 1, callId: "call-beta", name: "subagent", arguments: JSON.stringify({ name: "beta", description: "Task B" }),
    }, 4);
    // Catalog arrives out of order (beta first, then alpha)
    await gateway.emitEvent(sessionId, "subagent/catalog", {
      version: 3, childId: "child-beta", childCreatedAt: Date.now(), mode: "continuable", label: "Task B", name: "beta",
    }, 5);
    await gateway.emitEvent(sessionId, "subagent/catalog", {
      version: 3, childId: "child-alpha", childCreatedAt: Date.now(), mode: "continuable", label: "Task A", name: "alpha",
    }, 6);

    const betaScope = events.find((e): e is Extract<EngineStreamEvent, { type: "scoped" }> => e.type === "scoped" && e.taskId === "child-beta")?.scope;
    const alphaScope = events.find((e): e is Extract<EngineStreamEvent, { type: "scoped" }> => e.type === "scoped" && e.taskId === "child-alpha")?.scope;
    expect(betaScope?.parentCallId).toBe("call-beta");
    expect(alphaScope?.parentCallId).toBe("call-alpha");

    // Populate projection caches on child-alpha, then remove child-alpha and settle both
    await gateway.emitMux({ type: "session/projection", sessionId: "child-alpha", key: "subagentTiming", value: { settledMs: 10 }, seq: 1 });
    const internal = adapter as unknown as {
      projectionValues: Map<string, unknown>;
      projectionWatermarks: Map<string, unknown>;
      subagentByChildId: Map<string, { owner?: unknown; toolCalls: Map<string, unknown> }>;
      subagentsByRoot: Map<string, Map<string, unknown>>;
    };
    expect(internal.projectionValues.has("child-alpha")).toBe(true);
    await gateway.emitHost({ type: "host/session-removed", sessionId: "child-alpha" });
    expect(internal.projectionValues.has("child-alpha")).toBe(false);
    expect(internal.projectionWatermarks.has("child-alpha")).toBe(false);

    let seq = 7;
    for (const childId of ["child-alpha", "child-beta"]) {
      await gateway.emitEvent(sessionId, "user/message", {
        content: [{ type: "text", text: "Finished." }, { type: "text", text: "Its closing message:" }, { type: "text", text: "ok" }],
        source: { kind: "subagent-settled", form: "notice", stopReason: "completed", senderSessionId: childId },
      }, seq++);
    }
    // Finished subagent released its owner closure while still reporting owner: "bound" in listTasks
    expect(internal.subagentByChildId.get("child-alpha")?.owner).toBeUndefined();
    expect((await adapter.listTasks(sessionId)).tasks.find((t) => t.label === "Task A")?.owner).toBe("bound");

    // Spawn & finish >128 subagents and confirm retention stays bounded to 128
    for (let i = 0; i < 140; i += 1) {
      const id = `child-bulk-${i}`;
      await gateway.emitEvent(sessionId, "subagent/catalog", {
        version: 3, childId: id, childCreatedAt: Date.now(), mode: "one-shot", label: `Bulk ${i}`, name: `bulk-${i}`,
      }, seq++);
      await gateway.emitEvent(sessionId, "user/message", {
        content: [{ type: "text", text: "Done" }],
        source: { kind: "subagent-settled", form: "notice", stopReason: "completed", senderSessionId: id },
      }, seq++);
    }
    expect(internal.subagentsByRoot.get(sessionId)?.size).toBeLessThanOrEqual(128);
    expect(internal.subagentByChildId.size).toBeLessThanOrEqual(128);

    await gateway.emitEvent(sessionId, "assistant/message", {
      turn: 1, step: 2, message: { role: "assistant", content: [{ type: "text", text: "All settled" }] },
    }, seq++);
    await gateway.emitEvent(sessionId, "turn/end", { turn: 1, reason: { kind: "completed" } }, seq++);
    await turnPromise;

    await adapter.destroy();
    expect(internal.subagentsByRoot.size).toBe(0);
    expect(internal.subagentByChildId.size).toBe(0);
  });
});
