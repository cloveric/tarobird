import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleCoreMessage } from "../src/core/message-handler.js";
import { CoreGoalRunController, claimCoreRunSlot } from "../src/core/bus.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { removeTempRoot } from "./helpers/temp-files.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(removeTempRoot)); });
const savedGoal = { threadId: "native-goal-session", objective: "Original objective", status: "paused", tokenBudget: 1000, tokensUsed: 42, timeUsedSeconds: 3, createdAt: 1, updatedAt: 2 };
async function fixture(engine = "codex", status = "paused") {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "native-goal-core-")); roots.push(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine, locale: "en" }));
  let goal: any = { ...savedGoal, status };
  const bridge = {
    checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
    handleAuthorizedMessage: vi.fn(async () => ({ text: "ordinary answer" })),
    getThreadGoal: vi.fn(async () => ({ goal })),
    setThreadGoal: vi.fn(async (input: any) => ({ goal: goal = { ...savedGoal, objective: input.objective, status: "active" } })),
    updateThreadGoal: vi.fn(async (input: any) => ({ goal: goal = { ...goal, ...Object.fromEntries(Object.entries(input).filter(([key]) => ["status", "objective", "tokenBudget"].includes(key))) } })),
    clearThreadGoal: vi.fn(async () => { goal = null; return { cleared: true }; }),
  };
  const channel = { send: vi.fn(async () => ({ messageId: "reply" })), recallMessage: vi.fn(async () => {}), addReaction: vi.fn(async () => "reaction"), removeReaction: vi.fn(async () => {}) };
  const runtime = createCoreServiceRuntime(); let seq = 0;
  const send = async (content: string) => handleCoreMessage({ stateDir, bridge: bridge as never, channel: channel as never, runtime, message: { messageId: `message-${++seq}`, chatId: "goal-chat", chatType: "p2p", senderId: "test-user", content, rawContentType: "text", resources: [], mentions: [], mentionAll: false, mentionedBot: false, createTime: Date.now() } });
  return { bridge, channel, runtime, send, getGoal: () => goal, replies: () => JSON.stringify(channel.send.mock.calls) };
}

describe("native goal command parity", () => {
  it.each([["pause", "paused"], ["resume", "active"]])("Codex %s updates state without replacing the objective or counters", async (command, status) => {
    const f = await fixture(); await f.send(`/goal ${command}`);
    expect(f.bridge.setThreadGoal).not.toHaveBeenCalled();
    expect(f.bridge.updateThreadGoal).toHaveBeenCalledWith(expect.objectContaining({ status }));
    expect(f.getGoal()).toMatchObject({ objective: savedGoal.objective, tokensUsed: 42, status });
  });
  it("Codex edit without text shows editing instructions and does not create a goal named edit", async () => {
    const f = await fixture(); await f.send("/goal edit");
    expect(f.bridge.setThreadGoal).not.toHaveBeenCalled(); expect(f.bridge.updateThreadGoal).not.toHaveBeenCalled();
    expect(f.replies()).toContain(savedGoal.objective); expect(f.replies()).toContain("/goal edit");
  });
  it("Codex edit preserves budget, status and accumulated usage", async () => {
    const f = await fixture(); await f.send("/goal edit Revised objective");
    expect(f.bridge.setThreadGoal).not.toHaveBeenCalled();
    expect(f.bridge.updateThreadGoal).toHaveBeenCalledWith(expect.objectContaining({ objective: "Revised objective" }));
    expect(f.getGoal()).toMatchObject({ objective: "Revised objective", tokenBudget: 1000, tokensUsed: 42, status: "paused" });
  });
  it("Codex budget-only edit preserves the objective", async () => {
    const f = await fixture("codex", "budgetLimited"); await f.send("/goal edit --budget 20k");
    expect(f.getGoal()).toMatchObject({ objective: savedGoal.objective, tokenBudget: 20000, tokensUsed: 42 });
    expect(f.bridge.setThreadGoal).not.toHaveBeenCalled();
  });
  it.each(["pause extra", "resume extra"])("does not replace a goal for malformed control %s", async (command) => {
    const f = await fixture(); await f.send(`/goal ${command}`);
    expect(f.bridge.setThreadGoal).not.toHaveBeenCalled(); expect(f.bridge.updateThreadGoal).not.toHaveBeenCalled();
  });
  it.each(["/goal status", "/goal clear", "/goal off", "/goal reset", "/goal stop", "/goal cancel", "/goal none"])("normalizes Claude %s to a native command", async (command) => {
    const f = await fixture("claude"); await f.send(command);
    expect(f.bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({ text: command === "/goal status" ? "/goal" : "/goal clear" }));
  });
  it("rejects unsupported Claude token limits before any model call", async () => {
    const f = await fixture("claude"); await f.send("/goal --budget 10k Work until done");
    expect(f.bridge.handleAuthorizedMessage).not.toHaveBeenCalled(); expect(f.replies()).toContain("token");
  });
  it.each(["paused", "blocked", "usageLimited", "budgetLimited", "complete"])("ordinary input preserves Codex %s state", async (status) => {
    const f = await fixture("codex", status); await f.send("Question about this work");
    expect(f.bridge.clearThreadGoal).not.toHaveBeenCalled();
    expect(f.bridge.handleAuthorizedMessage).toHaveBeenCalled();
  });
  it("pauses an orphan active Codex goal before ordinary input, preserving recovery", async () => {
    const f = await fixture("codex", "active"); await f.send("Question after reconnect");
    expect(f.bridge.clearThreadGoal).not.toHaveBeenCalled();
    expect(f.bridge.updateThreadGoal).toHaveBeenCalledWith(expect.objectContaining({ status: "paused", origin: "automatic" }));
    expect(f.replies()).toContain("/goal resume");
  });
});


describe("native goal observer lifecycle", () => {
  it.each(["paused", "blocked", "usageLimited", "budgetLimited", "complete", null])("retains native %s result and releases the active run", async (status) => {
    const f = await fixture();
    const updateCard = vi.fn(async () => {});
    Object.assign(f.channel, { updateCard });
    const watch = vi.fn(async (input: any) => {
      input.onEngineEvent?.({ type: "session", sessionId: savedGoal.threadId });
      return { sessionId: savedGoal.threadId, goal: status ? { ...savedGoal, status } : null };
    });
    Object.assign(f.bridge, { watchThreadGoal: watch });
    await f.send("/goal New task");
    await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(f.runtime.activeRuns.size).toBe(0));
    expect(f.bridge.clearThreadGoal).not.toHaveBeenCalled();
    const rendered = JSON.stringify(updateCard.mock.calls);
    expect(rendered).toContain(status === "complete" ? "Done" : "Interrupted");
    if (status) expect(rendered).toContain(status);
  });
  it("resumes with an observer without replacing goal or token budget", async () => {
    const f = await fixture(); Object.assign(f.channel, { updateCard: vi.fn(async () => {}) });
    const watch = vi.fn(async (_input: any) => ({ goal: { ...savedGoal, status: "complete" } })); Object.assign(f.bridge, { watchThreadGoal: watch });
    await f.send("/goal resume");
    await vi.waitFor(() => expect(watch).toHaveBeenCalled());
    expect(watch.mock.calls[0]?.[0]).toMatchObject({ mode: "resume", objective: savedGoal.objective });
    expect(watch.mock.calls[0]?.[0]).not.toHaveProperty("tokenBudget");
    expect(f.bridge.setThreadGoal).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.runtime.activeRuns.size).toBe(0));
  });
  it("a turn adopted by a resumed goal detaches when its original claim ends", () => {
    const runtime = createCoreServiceRuntime(), ordinary = { abortController: new AbortController() };
    const release = claimCoreRunSlot(runtime, "chat", ordinary);
    const goal = new CoreGoalRunController(); goal.attachConcurrentTurn(ordinary);
    runtime.activeRuns.set("chat", { abortController: goal, goalWatch: true });
    release(); expect(goal.liveConcurrentTurn()).toBeNull();
    expect(runtime.activeRuns.get("chat")?.abortController).toBe(goal);
    goal.abort(); expect(goal.signal.aborted).toBe(true); expect(ordinary.abortController.signal.aborted).toBe(false);
  });
  it("an unavailable goal-status read does not prevent an ordinary message", async () => {
    const f = await fixture(); f.bridge.getThreadGoal.mockRejectedValue(new Error("unsupported goal API"));
    await f.send("Ordinary question"); expect(f.bridge.handleAuthorizedMessage).toHaveBeenCalled();
  });
});
