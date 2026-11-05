import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { EngineApprovalDecision, EngineApprovalRequest, EngineStreamEvent } from "../src/codex/adapter.js";
import { CodexAppServerAdapter } from "../src/codex/app-server-adapter.js";
import { removeTempRoot } from "./helpers/temp-files.js";

// Server-request shapes follow codex-cli 0.162.1's generated v2 protocol. Its
// TurnStartParams documents approvalPolicy as applying to "this turn and
// subsequent turns", so an autonomous /goal turn can inherit on-request from
// an ordinary normal-mode turn and send these requests with its own turnId.

class FakeStream extends EventEmitter {
  emitData(chunk: string): void { this.emit("data", chunk); }
}

class FakeWritable {
  lines: string[] = [];
  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    const text = chunk.toString().trim();
    if (text) this.lines.push(text);
    callback?.(null);
    return true;
  }
}

class FakeChildProcess extends EventEmitter {
  stdin = new FakeWritable();
  stdout = new FakeStream();
  stderr = new FakeStream();
  kill(): void {}
  close(code: number | null): void { this.emit("close", code); }
}

type Callback = (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not met in time");
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const THREAD = "goal-thread";
const goalRecord = { threadId: THREAD, objective: "goal work", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
const question = { itemId: "question-item", isBlocking: true, questions: [{ id: "color", header: "Color", question: "Choose a color", options: [{ label: "Blue", description: "Calm" }, { label: "Green", description: "Fresh" }] }] };
const permission = { itemId: "permission-item", cwd: "/workspace", startedAtMs: 123, permissions: { fileSystem: { read: ["/tmp/native-fixture"] }, network: { enabled: true } }, reason: "Read the fixture" };
const command = { itemId: "command-item", startedAtMs: 1, command: "curl https://example.com", cwd: "/workspace", reason: "network access" };

function deferredCallback() {
  const calls: Array<{ request: EngineApprovalRequest; answer: (decision: EngineApprovalDecision) => void }> = [];
  const fn = vi.fn((request: EngineApprovalRequest) => new Promise<EngineApprovalDecision>((answer) => { calls.push({ request, answer }); }));
  return { fn, calls };
}

function harness(configPath?: string) {
  const child = new FakeChildProcess();
  const adapter = new CodexAppServerAdapter("codex", "/tmp/goal-approvals", undefined, (() => child) as never, undefined, undefined, configPath);
  const frames = () => child.stdin.lines.map((line) => JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown });
  const respond = async (method: string, result: unknown, count = 1) => {
    await waitFor(() => frames().filter((frame) => frame.method === method).length >= count);
    child.stdout.emitData(JSON.stringify({ id: frames().filter((frame) => frame.method === method)[count - 1]!.id, result }) + "\n");
  };
  const emit = (method: string, params: Record<string, unknown>) =>
    child.stdout.emitData(JSON.stringify({ method, params: { threadId: THREAD, ...params } }) + "\n");
  const request = (id: string, method: string, params: Record<string, unknown>) =>
    child.stdout.emitData(JSON.stringify({ id, method, params: { threadId: THREAD, ...params } }) + "\n");
  const responses = (id: string) => frames().filter((frame) => frame.id === id && frame.method === undefined).map((frame) => frame.result);
  return { child, adapter, frames, respond, emit, request, responses };
}

type Harness = ReturnType<typeof harness>;

/** Starts a goal on a fresh native thread and returns once its first native turn is live. */
async function startGoal(h: Harness, onApprovalRequest: Callback | undefined, options: { abortSignal?: AbortSignal; turnId?: string } = {}) {
  const events: EngineStreamEvent[] = [];
  const watch = h.adapter.watchThreadGoal("telegram-goal", {
    objective: goalRecord.objective,
    onApprovalRequest,
    abortSignal: options.abortSignal,
    onEngineEvent: (event) => { events.push(event); },
  });
  void watch.catch(() => undefined);
  await h.respond("initialize", {});
  await h.respond("thread/start", { thread: { id: THREAD } });
  await h.respond("thread/goal/clear", { cleared: false });
  await h.respond("thread/goal/set", { goal: goalRecord });
  h.emit("turn/started", { turn: { id: options.turnId ?? "goal-turn" } });
  return { watch, events };
}

async function withConfig<T>(approvalMode: string, run: (configPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-goal-approvals-"));
  const configPath = path.join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ approvalMode }));
  try { return await run(configPath); } finally { await removeTempRoot(root); }
}

describe("Codex /goal watcher interactive requests", () => {
  it("asks the goal owner instead of auto-cancelling when a goal turn inherits an ordinary turn's on-request policy", async () => {
    const h = harness();
    try {
      const ordinaryCallback = vi.fn<Callback>().mockResolvedValue({ behavior: "deny" });
      const ordinary = h.adapter.sendUserMessage("telegram-goal", { text: "hello", files: [], onApprovalRequest: ordinaryCallback });
      await h.respond("initialize", {});
      await h.respond("thread/start", { thread: { id: THREAD } });
      await waitFor(() => h.frames().some((frame) => frame.method === "turn/start"));
      expect(h.frames().find((frame) => frame.method === "turn/start")!.params!.approvalPolicy).toBe("on-request");
      await h.respond("turn/start", { turn: { id: "ordinary-turn" } });
      h.emit("turn/completed", { turn: { id: "ordinary-turn", status: "completed", items: [{ type: "agentMessage", text: "hi" }] } });
      await ordinary;

      const goalCallback = vi.fn<Callback>().mockResolvedValue({ behavior: "allow" });
      const events: EngineStreamEvent[] = [];
      const watch = h.adapter.watchThreadGoal(THREAD, { objective: goalRecord.objective, onApprovalRequest: goalCallback, onEngineEvent: (event) => { events.push(event); } });
      await h.respond("thread/goal/clear", { cleared: false });
      await h.respond("thread/goal/set", { goal: goalRecord });
      // The thread stayed loaded: no thread/resume reset its policy to never.
      expect(h.frames().map((frame) => frame.method)).not.toContain("thread/resume");
      h.emit("turn/started", { turn: { id: "goal-turn" } });
      h.request("goal-approval", "item/commandExecution/requestApproval", { turnId: "goal-turn", ...command });
      await waitFor(() => h.responses("goal-approval").length === 1);

      expect(h.responses("goal-approval")).toEqual([{ decision: "accept" }]);
      expect(goalCallback).toHaveBeenCalledWith(expect.objectContaining({ engine: "codex", toolName: "Codex command approval", sessionId: THREAD, abortSignal: expect.any(AbortSignal) }));
      expect(ordinaryCallback).not.toHaveBeenCalled();
      expect(events).toContainEqual(expect.objectContaining({ type: "permission_request", toolName: "Codex command approval", toolUseId: command.itemId }));

      h.emit("turn/completed", { turn: { id: "goal-turn", status: "completed", items: [] } });
      h.emit("thread/goal/updated", { goal: { ...goalRecord, status: "complete" } });
      await expect(watch).resolves.toMatchObject({ goal: { status: "complete" } });
    } finally { h.adapter.destroy(); }
  });

  const routed: Array<[string, Record<string, unknown>, (request: EngineApprovalRequest) => EngineApprovalDecision, string, unknown]> = [
    ["item/tool/requestUserInput", question, () => ({ behavior: "allow", updatedInput: { answers: { "Choose a color": "Blue" } } }), "AskUserQuestion", { answers: { color: { answers: ["Blue"] } } }],
    ["mcpServer/elicitation/request", { serverName: "fixture", mode: "form", _meta: null, message: "Pick", requestedSchema: { type: "object", properties: { color: { type: "string", oneOf: [{ const: "blue", title: "Blue" }] } }, required: ["color"] } },
      (request) => ({ behavior: "allow", updatedInput: { answers: { [(request.toolInput as { questions: Array<{ question: string }> }).questions[0]!.question]: "Blue" } } }), "AskUserQuestion", { action: "accept", content: { color: "blue" } }],
    ["item/permissions/requestApproval", permission, () => ({ behavior: "allow" }), "Codex additional permissions", { permissions: permission.permissions, scope: "turn" }],
    ["item/fileChange/requestApproval", { itemId: "edit-item", reason: "needs write access" }, () => ({ behavior: "allow", scope: "session" }), "Codex file change approval", { decision: "acceptForSession" }],
  ];
  it.each(routed)("routes %s from the exact goal turn to the goal owner", async (method, params, decide, toolName, expected) => {
    const h = harness();
    try {
      const goalCallback = vi.fn(async (request: EngineApprovalRequest) => decide(request));
      const { events } = await startGoal(h, goalCallback);
      h.request("goal-request", method, { turnId: "goal-turn", ...params });
      await waitFor(() => h.responses("goal-request").length === 1);
      expect(h.responses("goal-request")).toEqual([expected]);
      expect(goalCallback).toHaveBeenCalledTimes(1);
      expect(goalCallback).toHaveBeenCalledWith(expect.objectContaining({ engine: "codex", toolName, sessionId: THREAD, abortSignal: expect.any(AbortSignal) }));
      expect(events).toContainEqual(expect.objectContaining({ type: "permission_request", toolName }));
    } finally { h.adapter.destroy(); }
  });

  it.each(["bypass", "full-auto"])("does not widen goal tool approvals in %s, but still asks its questions", async (approvalMode) => {
    await withConfig(approvalMode, async (configPath) => {
      const h = harness(configPath);
      try {
        const goalCallback = vi.fn<Callback>().mockResolvedValue({ behavior: "allow", updatedInput: { answers: { "Choose a color": "Green" } } });
        await startGoal(h, goalCallback);
        h.request("goal-command", "item/commandExecution/requestApproval", { turnId: "goal-turn", ...command });
        h.request("goal-permission", "item/permissions/requestApproval", { turnId: "goal-turn", ...permission });
        await waitFor(() => h.responses("goal-command").length === 1 && h.responses("goal-permission").length === 1);
        expect(h.responses("goal-command")).toEqual([{ decision: "cancel" }]);
        expect(h.responses("goal-permission")).toEqual([{ permissions: {}, scope: "turn" }]);
        expect(goalCallback).not.toHaveBeenCalled();

        h.request("goal-question", "item/tool/requestUserInput", { turnId: "goal-turn", ...question });
        await waitFor(() => h.responses("goal-question").length === 1);
        expect(h.responses("goal-question")).toEqual([{ answers: { color: { answers: ["Green"] } } }]);
        expect(goalCallback).toHaveBeenCalledWith(expect.objectContaining({ toolName: "AskUserQuestion" }));
      } finally { h.adapter.destroy(); }
    });
  });

  it("keeps a concurrent ordinary turn's requests and the goal's requests with their own owners", async () => {
    const h = harness();
    try {
      const goalCallback = vi.fn<Callback>().mockResolvedValue({ behavior: "allow" });
      const ordinaryCallback = vi.fn<Callback>().mockResolvedValue({ behavior: "allow", scope: "session" });
      await startGoal(h, goalCallback);
      const ordinary = h.adapter.sendUserMessage(THREAD, { text: "ordinary", files: [], onApprovalRequest: ordinaryCallback });
      await h.respond("turn/start", { turn: { id: "ordinary-turn" } });

      h.request("goal-request", "item/commandExecution/requestApproval", { turnId: "goal-turn", ...command });
      h.request("ordinary-request", "item/commandExecution/requestApproval", { turnId: "ordinary-turn", ...command, itemId: "ordinary-item" });
      await waitFor(() => h.responses("goal-request").length === 1 && h.responses("ordinary-request").length === 1);
      expect(h.responses("goal-request")).toEqual([{ decision: "accept" }]);
      expect(h.responses("ordinary-request")).toEqual([{ decision: "acceptForSession" }]);
      expect(goalCallback.mock.calls.map(([request]) => (request.toolInput as { itemId?: string }).itemId)).toEqual([command.itemId]);
      expect(ordinaryCallback.mock.calls.map(([request]) => (request.toolInput as { itemId?: string }).itemId)).toEqual(["ordinary-item"]);

      // A request that names neither turn, or no turn at all, belongs to nobody.
      h.request("unknown-turn", "item/tool/requestUserInput", { turnId: "other-turn", ...question });
      h.request("no-turn", "mcpServer/elicitation/request", { serverName: "fixture", mode: "form", _meta: null, message: "Pick", requestedSchema: { type: "object", properties: { color: { type: "string" } } } });
      await waitFor(() => h.responses("unknown-turn").length === 1 && h.responses("no-turn").length === 1);
      expect(h.responses("unknown-turn")).toEqual([{ answers: {} }]);
      expect(h.responses("no-turn")).toEqual([{ action: "cancel" }]);
      expect(goalCallback).toHaveBeenCalledTimes(1);
      expect(ordinaryCallback).toHaveBeenCalledTimes(1);

      h.emit("turn/completed", { turn: { id: "ordinary-turn", status: "completed", items: [{ type: "agentMessage", text: "ordinary answer" }] } });
      await expect(ordinary).resolves.toMatchObject({ text: "ordinary answer" });
    } finally { h.adapter.destroy(); }
  });

  it("fails closed for missing, finished and retired goal turn ids", async () => {
    const h = harness();
    try {
      const goalCallback = vi.fn<Callback>().mockResolvedValue({ behavior: "allow" });
      const abort = new AbortController();
      const { watch } = await startGoal(h, goalCallback, { abortSignal: abort.signal, turnId: "goal-1" });
      h.request("missing-id", "item/commandExecution/requestApproval", { ...command });
      h.emit("turn/completed", { turn: { id: "goal-1", status: "completed", items: [] } });
      h.request("finished-turn", "item/commandExecution/requestApproval", { turnId: "goal-1", ...command });
      await waitFor(() => h.responses("missing-id").length === 1 && h.responses("finished-turn").length === 1);
      expect(h.responses("missing-id")).toEqual([{ decision: "cancel" }]);
      expect(h.responses("finished-turn")).toEqual([{ decision: "cancel" }]);

      h.emit("turn/started", { turn: { id: "goal-2" } });
      abort.abort();
      await h.respond("thread/goal/clear", { cleared: true }, 2);
      await watch;
      h.request("retired-turn", "item/tool/requestUserInput", { turnId: "goal-2", ...question });
      await waitFor(() => h.responses("retired-turn").length === 1);
      expect(h.responses("retired-turn")).toEqual([{ answers: {} }]);
      expect(goalCallback).not.toHaveBeenCalled();
    } finally { h.adapter.destroy(); }
  });

  it.each(["distinct", "shared", "aborted"])("resolves a goal request buffered behind an unidentified ordinary turn only by exact id (%s)", async (outcome) => {
    const h = harness();
    try {
      const goalCallback = vi.fn<Callback>().mockResolvedValue({ behavior: "allow" });
      const ordinaryCallback = vi.fn<Callback>().mockResolvedValue({ behavior: "allow", scope: "session" });
      await startGoal(h, goalCallback);
      const ordinaryAbort = new AbortController();
      const ordinary = h.adapter.sendUserMessage(THREAD, { text: "ordinary", files: [], onApprovalRequest: ordinaryCallback, abortSignal: ordinaryAbort.signal });
      void ordinary.catch(() => undefined);
      await waitFor(() => h.frames().some((frame) => frame.method === "turn/start"));

      // Until turn/start answers, this may be the goal's or the ordinary turn's.
      h.request("buffered", "item/commandExecution/requestApproval", { turnId: "goal-turn", ...command });
      await settle();
      expect(h.responses("buffered")).toEqual([]);

      if (outcome === "aborted") {
        ordinaryAbort.abort();
        await waitFor(() => h.responses("buffered").length === 1);
        expect(h.responses("buffered")).toEqual([{ decision: "cancel" }]);
        expect(goalCallback).not.toHaveBeenCalled();
      } else {
        // "shared": Codex added the input to the goal's active native turn.
        await h.respond("turn/start", { turn: { id: outcome === "distinct" ? "ordinary-turn" : "goal-turn" } });
        await waitFor(() => h.responses("buffered").length === 1);
        expect(goalCallback).toHaveBeenCalledTimes(outcome === "distinct" ? 1 : 0);
        expect(h.responses("buffered")).toEqual([{ decision: outcome === "distinct" ? "accept" : "acceptForSession" }]);
      }
      expect(ordinaryCallback).toHaveBeenCalledTimes(outcome === "shared" ? 1 : 0);
    } finally { h.adapter.destroy(); }
  });

  const retired: Array<[string, string, Record<string, unknown>, unknown]> = [
    ["abort", "item/tool/requestUserInput", question, { answers: {} }],
    ["abort", "item/commandExecution/requestApproval", command, { decision: "decline" }],
    ["abort", "item/permissions/requestApproval", permission, { permissions: {}, scope: "turn" }],
    ["clear", "item/tool/requestUserInput", question, { answers: {} }],
    ["complete", "item/tool/requestUserInput", question, { answers: {} }],
    ["child", "item/tool/requestUserInput", question, undefined],
  ];
  it.each(retired)("closes a pending goal request on %s (%s) and ignores the late answer", async (reason, method, params, expected) => {
    const h = harness();
    try {
      const goalCallback = deferredCallback();
      const abort = new AbortController();
      const { watch } = await startGoal(h, goalCallback.fn, { abortSignal: abort.signal });
      h.request("goal-request", method, { turnId: "goal-turn", ...params });
      await waitFor(() => goalCallback.calls.length === 1);
      const { request, answer } = goalCallback.calls[0]!;

      if (reason === "abort") abort.abort();
      else if (reason === "clear") void h.adapter.clearThreadGoal(THREAD).catch(() => undefined);
      else if (reason === "complete") {
        h.emit("thread/goal/updated", { goal: { ...goalRecord, status: "complete" } });
        h.emit("turn/completed", { turn: { id: "goal-turn", status: "completed", items: [] } });
      } else h.child.close(1);
      // Closed before any cleanup RPC answers: the card must not outlive the stop.
      await waitFor(() => request.abortSignal?.aborted === true);
      await settle();
      expect(h.responses("goal-request")).toEqual(expected === undefined ? [] : [expected]);

      answer({ behavior: "allow", scope: "session", updatedInput: { answers: { "Choose a color": "Blue" } } });
      await settle();
      expect(h.responses("goal-request")).toEqual(expected === undefined ? [] : [expected]);
      if (reason === "abort" || reason === "clear") await h.respond("thread/goal/clear", { cleared: true }, 2);
      await watch;
    } finally { h.adapter.destroy(); }
  });

  it("never lets a replaced goal's late answer reach the replacement goal", async () => {
    const h = harness();
    try {
      const first = deferredCallback();
      const second = deferredCallback();
      const firstAbort = new AbortController();
      const firstGoal = await startGoal(h, first.fn, { abortSignal: firstAbort.signal, turnId: "goal-1" });
      h.request("first-request", "item/commandExecution/requestApproval", { turnId: "goal-1", ...command });
      await waitFor(() => first.calls.length === 1);
      firstAbort.abort();
      await waitFor(() => h.responses("first-request").length === 1);
      await h.respond("thread/goal/clear", { cleared: true }, 2);
      await firstGoal.watch;

      const watch = h.adapter.watchThreadGoal(THREAD, { objective: "next goal", onApprovalRequest: second.fn });
      await h.respond("thread/goal/clear", { cleared: false }, 3);
      await h.respond("thread/goal/set", { goal: { ...goalRecord, objective: "next goal" } }, 2);
      h.emit("turn/started", { turn: { id: "goal-2" } });
      h.request("second-request", "item/commandExecution/requestApproval", { turnId: "goal-2", ...command });
      h.request("stale-turn", "item/commandExecution/requestApproval", { turnId: "goal-1", ...command });
      await waitFor(() => second.calls.length === 1 && h.responses("stale-turn").length === 1);
      expect(h.responses("stale-turn")).toEqual([{ decision: "cancel" }]);

      first.calls[0]!.answer({ behavior: "allow", scope: "session" });
      await settle();
      expect(h.responses("first-request")).toEqual([{ decision: "decline" }]);
      expect(h.responses("second-request")).toEqual([]);
      expect(second.calls[0]!.request.abortSignal?.aborted).toBe(false);
      expect(second.fn).toHaveBeenCalledTimes(1);

      second.calls[0]!.answer({ behavior: "allow" });
      await waitFor(() => h.responses("second-request").length === 1);
      expect(h.responses("second-request")).toEqual([{ decision: "accept" }]);
      h.emit("turn/completed", { turn: { id: "goal-2", status: "completed", items: [] } });
      h.emit("thread/goal/updated", { goal: { ...goalRecord, objective: "next goal", status: "complete" } });
      await watch;
    } finally { h.adapter.destroy(); }
  });
});
