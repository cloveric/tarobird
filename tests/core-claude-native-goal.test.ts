import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleCoreMessage } from "../src/core/message-handler.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { createRunRecord } from "../src/core/run-record.js";
import { UsageStore } from "../src/state/usage-store.js";
import { initialCoreRunState, renderCoreRunCard, renderCoreRunCardCompact, renderCoreRunCardMinimal } from "../src/core/card-renderer.js";
import type { ClaudeNativeGoalReceipt, ClaudeNativeGoalUpdate } from "../src/codex/claude-native-goal.js";
import type { CoreBridgeLike } from "../src/core/types.js";
import { removeTempRoot } from "./helpers/temp-files.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(removeTempRoot)); });
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const objective = "Synthetic native completion condition";
const active: ClaudeNativeGoalReceipt = { command: "set", acknowledged: true, state: "active", objective, verifiedBy: ["command", "query"] };
async function fixture(engine = "claude", cards = true) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "claude-goal-core-")); roots.push(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine, locale: "en" }));
  const bridge = {
    checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
    handleAuthorizedMessage: vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async () => ({ text: "Native answer", nativeGoal: active })),
    // Even if a future runtime provides the optional structured lookup, Claude
    // native goal state must not enter the legacy automatic-clear path.
    getThreadGoal: vi.fn(async () => ({ goal: { threadId: "synthetic-session", objective, status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } })),
    clearThreadGoal: vi.fn(async () => ({ cleared: true })),
  };
  let sequence = 0;
  const channel = {
    profile: "gateway" as const,
    send: vi.fn(async (_to: string, _body: unknown) => ({ messageId: `reply-${++sequence}` })),
    ...(cards ? { updateCard: vi.fn(async (_messageId: string, _card: object) => {}) } : {}),
    recallMessage: vi.fn(async () => {}), addReaction: vi.fn(async () => "reaction"), removeReaction: vi.fn(async () => {}),
  };
  const runtime = createCoreServiceRuntime();
  const send = (content: string) => handleCoreMessage({ stateDir, bridge: bridge as never, channel: channel as never, runtime, message: { messageId: `input-${++sequence}`, chatId: "claude-goal-chat", chatType: "p2p", senderId: "synthetic-user", content, rawContentType: "text", resources: [], mentions: [], mentionedBot: false } });
  const all = () => JSON.stringify([channel.send.mock.calls, channel.updateCard?.mock.calls]);
  const last = () => JSON.stringify(channel.updateCard?.mock.calls.at(-1)?.[1] ?? channel.send.mock.calls.at(-1)?.[1]);
  return { stateDir, bridge, channel, runtime, send, all, last };
}

describe("Claude native goal receipts in Core", () => {
  it("does not show a goal banner until Claude accepts the command", async () => {
    const f = await fixture(), entered = deferred(), finish = deferred();
    let update: ((value: ClaudeNativeGoalUpdate) => void) | undefined;
    f.bridge.handleAuthorizedMessage.mockImplementation(async (input) => { update = input.onNativeGoal; entered.resolve(); await finish.promise; return { text: "Native answer", nativeGoal: active }; });
    const pending = f.send(`/goal ${objective}`);
    try {
      await entered.promise;
      expect(f.all()).not.toContain("run_goal_banner");
      expect(update).toBeTypeOf("function");
      update!({ state: "accepted", objective });
      await vi.waitFor(() => expect(f.all()).toContain("run_goal_banner"));
      finish.resolve(); await pending;
      expect(f.last()).not.toContain("run_goal_banner");
      expect(f.last()).toContain("Turn ended");
    } finally { finish.resolve(); await pending; }
  });

  it("never turns a rejected native command into a goal banner", async () => {
    const f = await fixture();
    f.bridge.handleAuthorizedMessage.mockImplementation(async (input) => {
      input.onNativeGoal?.({ state: "rejected", message: "Hooks are restricted" });
      return { text: "Hooks are restricted", nativeGoal: { command: "set", acknowledged: true, state: "unverified", rejection: { reason: "hooks_restricted", message: "Hooks are restricted" }, verifiedBy: ["command"] } };
    });
    await f.send(`/goal ${objective}`);
    expect(f.all()).not.toContain("run_goal_banner");
    expect(f.last()).toContain("Hooks are restricted");
    expect(f.bridge.clearThreadGoal).not.toHaveBeenCalled();
  });

  it("does not present a retained old goal as acceptance of a rejected replacement", async () => {
    const f = await fixture(), entered = deferred(), finish = deferred();
    f.bridge.handleAuthorizedMessage.mockImplementation(async (input) => {
      input.onNativeGoal?.({ state: "rejected", message: "Hooks are restricted" });
      input.onNativeGoal?.({ state: "active", objective: "Old retained condition" });
      await input.onEngineEvent?.({ type: "assistant_text", text: "Native rejection received" });
      entered.resolve(); await finish.promise;
      return { text: "Hooks are restricted", nativeGoal: { ...active, objective: "Old retained condition", rejection: { reason: "hooks_restricted", message: "Hooks are restricted" } } };
    });
    const pending = f.send(`/goal ${objective}`);
    try {
      await entered.promise;
      await vi.waitFor(() => expect(f.all()).toContain("Native rejection received"));
      expect(f.all()).not.toContain("run_goal_banner");
      finish.resolve(); await pending;
      expect(f.last()).toContain("existing native goal is still active");
      expect(f.bridge.clearThreadGoal).not.toHaveBeenCalled();
    } finally { finish.resolve(); await pending; }
  });

  it.each([
    ["active", { ...active }, "goal is still active"],
    ["capped", { ...active, capped: true, evaluations: 3 }, "goal is still active"],
    ["none", { ...active, state: "none" }, "does not confirm"],
    ["unverified", { ...active, state: "unverified" }, "could not be verified"],
  ] as const)("ends a %s receipt neutrally without claiming goal completion", async (_label, receipt, expected) => {
    const f = await fixture();
    f.bridge.handleAuthorizedMessage.mockResolvedValue({ text: "Native answer", nativeGoal: receipt as ClaudeNativeGoalReceipt });
    await f.send(`/goal ${objective}`);
    expect(f.last()).toContain("Turn ended");
    expect(f.last()).not.toContain("**Done**");
    expect(f.last()).toContain(expected);
    expect(f.last()).toContain("Native answer");
    expect(f.bridge.clearThreadGoal).not.toHaveBeenCalled();
  });

  it("reports missing receipt as unverified rather than confirming a goal from the user's text", async () => {
    const f = await fixture(); f.bridge.handleAuthorizedMessage.mockResolvedValue({ text: "Native answer" });
    await f.send(`/goal ${objective}`);
    expect(f.all()).not.toContain("run_goal_banner");
    expect(f.last()).toContain("could not be verified");
    expect(f.last()).toContain("Turn ended");
  });

  it.each(["status", "clear"] as const)("keeps %s commands as ordinary completed queries", async (command) => {
    const f = await fixture();
    f.bridge.handleAuthorizedMessage.mockResolvedValue({ text: "No goal set", nativeGoal: { command, acknowledged: true, state: "none", ...(command === "clear" ? { cleared: true } : {}), verifiedBy: ["command"] } });
    await f.send(`/goal ${command}`);
    expect(f.last()).toContain("**Done**");
    expect(f.last()).not.toContain("Turn ended");
    expect(f.all()).not.toContain("run_goal_banner");
  });

  it("shows native goal state for an ordinary turn running under a retained goal", async () => {
    const f = await fixture();
    f.bridge.handleAuthorizedMessage.mockResolvedValue({ text: "Continued answer", nativeGoal: { ...active, command: undefined } });
    await f.send("Continue the work");
    expect(f.last()).toContain("Turn ended");
    expect(f.last()).toContain("goal is still active");
    expect(f.bridge.clearThreadGoal).not.toHaveBeenCalled();
  });

  it("preserves the native goal when stopped and offers explicit query or clear controls", async () => {
    const f = await fixture();
    f.bridge.handleAuthorizedMessage.mockImplementation(async (input) => {
      input.onNativeGoal?.({ state: "accepted", objective });
      await input.onEngineEvent?.({ type: "assistant_text", text: "Verified partial answer" });
      throw new Error("stopped by user");
    });
    await f.send(`/goal ${objective}`);
    expect(f.last()).toContain("Interrupted");
    expect(f.last()).toContain("Verified partial answer");
    expect(f.last()).toContain("/goal clear");
    expect(f.bridge.clearThreadGoal).not.toHaveBeenCalled();
  });

  it("does not let a completed turn's late native goal callback affect later work", async () => {
    const f = await fixture(); let stale: ((value: ClaudeNativeGoalUpdate) => void) | undefined;
    f.bridge.handleAuthorizedMessage.mockImplementationOnce(async (input) => { stale = input.onNativeGoal; return { text: "First answer", nativeGoal: active }; });
    await f.send(`/goal ${objective}`);
    f.bridge.handleAuthorizedMessage.mockResolvedValue({ text: "Ordinary answer" });
    await f.send("Ordinary question");
    const before = f.all();
    stale?.({ state: "accepted", objective: "Late stale goal" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.all()).toBe(before);
    expect(f.last()).toContain("**Done**");
  });

  it.each(["verified", "missing"] as const)("ignores stale repair callbacks and uses the latest %s goal receipt", async (receiptKind) => {
    const f = await fixture(), repairEntered = deferred(), finishRepair = deferred();
    let stale: ((value: ClaudeNativeGoalUpdate) => void) | undefined;
    f.bridge.handleAuthorizedMessage.mockImplementationOnce(async (input) => {
      stale = input.onNativeGoal;
      return { text: "Native answer\n[send.batch=/not-a-valid-directive]", nativeGoal: active, usage: { inputTokens: 10, outputTokens: 5 } };
    }).mockImplementationOnce(async (input) => {
      stale?.({ state: "accepted", objective: "Stale attempt objective" });
      await input.onEngineEvent?.({ type: "assistant_text", text: "Repair progress" });
      repairEntered.resolve(); await finishRepair.promise;
      return { text: "No artifact was available", ...(receiptKind === "verified" ? { nativeGoal: { ...active, state: "none" as const } } : {}), usage: { inputTokens: 7, outputTokens: 3 } };
    });
    const pending = f.send(`/goal ${objective}`);
    try {
      await repairEntered.promise;
      await vi.waitFor(() => expect(f.all()).toContain("Repair progress"));
      expect(f.all()).not.toContain("Stale attempt objective");
      finishRepair.resolve(); await pending;
      expect(f.last()).toContain(receiptKind === "verified" ? "does not confirm" : "could not be verified");
      expect(f.last()).not.toContain("goal is still active");
      expect(await new UsageStore(f.stateDir).load()).toMatchObject({ totalInputTokens: 17, totalOutputTokens: 8 });
    } finally { finishRepair.resolve(); await pending; }
  });

  it("preserves ordinary metered replies without adding a goal presentation", async () => {
    const f = await fixture();
    f.bridge.handleAuthorizedMessage.mockResolvedValue({ text: "Ordinary answer", usage: { inputTokens: 11, outputTokens: 7, cachedTokens: 3, costUsd: 0.5 } });
    await f.send("Ordinary question");
    expect(f.last()).toContain("**Done**");
    expect(f.last()).not.toContain("native goal");
    expect(f.all()).not.toContain("goalTurnEnded");
    expect(await new UsageStore(f.stateDir).load()).toMatchObject({ totalInputTokens: 11, totalOutputTokens: 7, totalCachedTokens: 3, totalCostUsd: 0.5 });
  });

  it("includes the truthful receipt in the no-card text fallback", async () => {
    const f = await fixture("claude", false);
    await f.send(`/goal ${objective}`);
    expect(f.all()).toContain("goal is still active");
    expect(f.all()).toContain("Native answer");
  });

  it("keeps native-goal stop guidance in the no-card fallback", async () => {
    const f = await fixture("claude", false);
    f.bridge.handleAuthorizedMessage.mockImplementation(async (input) => {
      input.onNativeGoal?.({ state: "accepted", objective });
      throw new Error("stopped by user");
    });
    await f.send(`/goal ${objective}`);
    expect(f.all()).toContain("Stopping this turn does not clear");
    expect(f.all()).toContain("/goal clear");
    expect(f.bridge.clearThreadGoal).not.toHaveBeenCalled();
  });
});

describe("goal turn terminal presentation", () => {
  it.each([renderCoreRunCard, renderCoreRunCardCompact, renderCoreRunCardMinimal])("uses a neutral title only for a finished goal turn", (render) => {
    const state = { ...initialCoreRunState("synthetic-chat"), status: "done" as const, goalTurnEnded: true, nativeRun: createRunRecord() };
    expect(JSON.stringify(render(state, "en"))).toContain("Turn ended");
    expect(JSON.stringify(render(state, "zh"))).toContain("本轮已结束");
    expect(JSON.stringify(render({ ...state, goalTurnEnded: false }, "en"))).toContain("**Done**");
    expect(JSON.stringify(render({ ...state, status: "running" }, "en"))).not.toContain("Turn ended");
    expect(render(state).appRun).toMatchObject({ goalTurnEnded: true, summary: { phase: "done" } });
    expect(render(state).appRun).not.toHaveProperty("summary.goalTurnEnded");
    expect(render({ ...state, goalTurnEnded: false }).appRun).not.toHaveProperty("goalTurnEnded");
    expect(render({ ...state, status: "running" }).appRun).not.toHaveProperty("goalTurnEnded");
  });
});
