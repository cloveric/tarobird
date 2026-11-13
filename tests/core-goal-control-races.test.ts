import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleCoreSimpleCommand } from "../src/core/commands.js";
import { CoreGoalRunController, claimCoreRunSlot } from "../src/core/bus.js";
import { createCoreRunCardController, handleCoreMessage } from "../src/core/message-handler.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { CoreNormalizedBridgeMessage } from "../src/core/message-normalizer.js";
import type { CodexAdapter, CodexThreadGoalResponse, CodexThreadGoal } from "../src/codex/adapter.js";
import { Bridge, type AccessStoreLike } from "../src/runtime/bridge.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { SessionStore } from "../src/state/session-store.js";
import { removeTempRoot } from "./helpers/temp-files.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(removeTempRoot)); });
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function announceGoalSession(input: unknown) {
  await (input as { onEngineEvent?: (event: { type: "session"; sessionId: string }) => unknown })
    .onEngineEvent?.({ type: "session", sessionId: goal.threadId });
}
const goal: CodexThreadGoal = { threadId: "test-native-goal", objective: "Synthetic objective", status: "paused", tokenBudget: 500, tokensUsed: 42, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2 };
const key = "lark:review-chat";
function normalized(text: string): CoreNormalizedBridgeMessage {
  return { text, messageId: text, chatId: "review-chat", senderId: "review-user", bridgeChatId: 1, bridgeAccessChatId: 1, bridgeUserId: 2, bridgeChatType: "private", conversationKey: key, accessConversationKey: key, mentions: [], attachments: [] };
}
async function fixture() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "goal-control-race-")); roots.push(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en" }));
  const runtime = createCoreServiceRuntime();
  const channel = { send: vi.fn(async (_to: string, _body: unknown) => ({ messageId: "reply" })), recallMessage: vi.fn(async () => {}), addReaction: vi.fn(async () => "reaction"), removeReaction: vi.fn(async () => {}) };
  const bridge = {
    checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
    handleAuthorizedMessage: vi.fn(async () => ({ text: "ordinary answer" })),
    getThreadGoal: vi.fn(async (): Promise<CodexThreadGoalResponse> => ({ goal })),
    updateThreadGoal: vi.fn(async (_input: unknown): Promise<CodexThreadGoalResponse> => ({ goal: { ...goal, status: "active" } })),
    clearThreadGoal: vi.fn(async (_input: unknown) => ({ cleared: true })),
    watchThreadGoal: vi.fn(async (_input: unknown): Promise<CodexThreadGoalResponse> => ({ goal })),
  };
  const makeCard = () => ({ apply: vi.fn(async () => {}), interrupt: vi.fn(async (_text?: string) => {}), finish: vi.fn(async () => ({ shown: true, reason: "fit" as const })), fail: vi.fn(async () => "error" as const), resolveFinalText: vi.fn(() => ""), setPhase: vi.fn(), setGoalObjective: vi.fn() });
  const createRunCard = vi.fn(async () => makeCard());
  const input = { stateDir, runtime, bridge, channel, createRunCard, requestApproval: async () => ({ behavior: "deny" as const }) };
  const command = (text: string) => handleCoreSimpleCommand(input as never, normalized(text), text);
  return { ...input, command, makeCard };
}

describe("goal controller ownership across terminal UI work", () => {
  it("reattaches resume while the preceding suspended card is still finalizing", async () => {
    const f = await fixture();
    const cardEntered = deferred(), releaseCard = deferred(), secondGoal = deferred<CodexThreadGoalResponse>();
    const firstCard = f.makeCard();
    firstCard.interrupt.mockImplementation(async () => { cardEntered.resolve(); await releaseCard.promise; });
    f.createRunCard.mockResolvedValueOnce(firstCard);
    f.bridge.watchThreadGoal.mockResolvedValueOnce({ goal }).mockImplementationOnce(async (input) => { await announceGoalSession(input); return await secondGoal.promise; });
    try {
      await f.command("/goal synthetic");
      await cardEntered.promise;
      expect(f.runtime.activeRuns.has(key)).toBe(false);
      await f.command("/goal resume");
      const resumed = f.runtime.activeRuns.get(key);
      expect(resumed?.goalWatch).toBe(true);
      expect(f.bridge.updateThreadGoal).not.toHaveBeenCalled();
      // Native ownership is already released. Slow final-card delivery must not
      // delay the resumed observer or let a subsequent pause be undone later.
      expect(f.bridge.watchThreadGoal).toHaveBeenCalledTimes(2);
      expect(f.bridge.watchThreadGoal.mock.calls[1]?.[0]).toMatchObject({ mode: "resume", objective: goal.objective });
      expect(f.runtime.activeRuns.get(key)).toBe(resumed);
      expect(f.bridge.clearThreadGoal).not.toHaveBeenCalled();
    } finally {
      releaseCard.resolve(); secondGoal.resolve({ goal: { ...goal, status: "complete" } });
      await vi.waitFor(() => expect(f.runtime.activeRuns.has(key)).toBe(false));
    }
  });

  it("an ordinary turn adopted by resume detaches through its original release", async () => {
    const f = await fixture(), finishGoal = deferred<CodexThreadGoalResponse>();
    const ordinary = { abortController: new AbortController() };
    const releaseOrdinary = claimCoreRunSlot(f.runtime, key, ordinary);
    f.bridge.watchThreadGoal.mockImplementation(async (input) => { await announceGoalSession(input); return await finishGoal.promise; });
    try {
      await f.command("/goal resume");
      await vi.waitFor(() => expect(f.bridge.watchThreadGoal).toHaveBeenCalledOnce());
      const holder = f.runtime.activeRuns.get(key)?.abortController as CoreGoalRunController;
      expect(holder.liveConcurrentTurn()).toBe(ordinary);
      expect(ordinary.abortController.signal.aborted).toBe(false);
      releaseOrdinary();
      expect(holder.liveConcurrentTurn()).toBeNull();
      expect(f.runtime.concurrentRuns.has(key)).toBe(false);
      expect(f.runtime.activeRuns.get(key)?.abortController).toBe(holder);
    } finally {
      releaseOrdinary(); finishGoal.resolve({ goal: { ...goal, status: "complete" } });
      await vi.waitFor(() => expect(f.runtime.activeRuns.has(key)).toBe(false));
    }
  });

  it("keeps a following pause behind resume startup so the late setup cannot undo it", async () => {
    const f = await fixture(), watchEntered = deferred(), releaseSetup = deferred(), finishGoal = deferred<CodexThreadGoalResponse>();
    const calls: string[] = [];
    let status: CodexThreadGoal["status"] = "paused", resumeSettled = false;
    f.bridge.getThreadGoal.mockImplementation(async () => ({ goal: { ...goal, status } }));
    f.bridge.watchThreadGoal.mockImplementation(async (input) => {
      watchEntered.resolve(); await releaseSetup.promise;
      calls.push("resume-active"); status = "active";
      await announceGoalSession(input);
      return await finishGoal.promise;
    });
    f.bridge.updateThreadGoal.mockImplementation(async () => {
      calls.push("pause"); status = "paused";
      finishGoal.resolve({ goal: { ...goal, status } });
      return { goal: { ...goal, status } };
    });
    const resume = f.command("/goal resume").finally(() => { resumeSettled = true; });
    let pause: Promise<unknown> | undefined;
    try {
      await watchEntered.promise;
      // The watcher call is underway, but it has not registered its native
      // setup barrier yet. Returning the command here would free the goal lock.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(resumeSettled).toBe(false);
      pause = f.command("/goal pause");
      releaseSetup.resolve();
      await resume; await pause;
      expect(calls).toEqual(["resume-active", "pause"]);
      expect(status).toBe("paused");
      expect(f.bridge.watchThreadGoal).toHaveBeenCalledOnce();
    } finally {
      releaseSetup.resolve(); finishGoal.resolve({ goal });
      await resume; await pause;
      await vi.waitFor(() => expect(f.runtime.activeRuns.has(key)).toBe(false));
    }
  });

  it("acknowledges clear only after native success without aborting an attached turn", async () => {
    const f = await fixture(), clearEntered = deferred(), finishClear = deferred<{ cleared: boolean }>();
    const goalController = new CoreGoalRunController(), ordinary = { abortController: new AbortController() };
    goalController.attachConcurrentTurn(ordinary);
    f.runtime.activeRuns.set(key, { abortController: goalController, goalWatch: true });
    f.bridge.clearThreadGoal.mockImplementation(async () => { clearEntered.resolve(); return await finishClear.promise; });
    const pending = f.command("/goal clear");
    try {
      await clearEntered.promise;
      expect(f.channel.send).not.toHaveBeenCalled();
      expect(ordinary.abortController.signal.aborted).toBe(false);
      expect(goalController.signal.aborted).toBe(false);
      finishClear.resolve({ cleared: true }); await pending;
      expect(f.bridge.clearThreadGoal).toHaveBeenCalledWith(expect.objectContaining({ origin: "user" }));
      expect(JSON.stringify(f.channel.send.mock.calls)).toContain("Current goal cleared");
    } finally { finishClear.resolve({ cleared: true }); await pending; }
  });

  it("does not acknowledge a failed native clear", async () => {
    const f = await fixture();
    f.runtime.activeRuns.set(key, { abortController: new CoreGoalRunController(), goalWatch: true });
    f.bridge.clearThreadGoal.mockRejectedValue(new Error("synthetic clear failure"));
    await expect(f.command("/goal clear")).rejects.toThrow("synthetic clear failure");
    expect(f.channel.send).not.toHaveBeenCalled();
  });
});

describe("orphan recovery fencing", () => {
  it("orders resume after an in-flight recovery read instead of pausing the new pursuit", async () => {
    const f = await fixture(), enteredRead = deferred(), finishRead = deferred(), finishGoal = deferred<CodexThreadGoalResponse>();
    const calls: string[] = [];
    f.bridge.getThreadGoal.mockImplementationOnce(async () => { calls.push("read-start"); enteredRead.resolve(); await finishRead.promise; return { goal: { ...goal, status: "active" } }; });
    f.bridge.updateThreadGoal.mockImplementation(async () => { calls.push("pause"); return { goal }; });
    f.bridge.watchThreadGoal.mockImplementation(async (input) => { calls.push("watch-resume"); await announceGoalSession(input); return await finishGoal.promise; });
    const ordinary = handleCoreMessage({ ...f, channel: f.channel as never, bridge: f.bridge as never, message: { messageId: "ordinary", chatId: "review-chat", chatType: "p2p", senderId: "review-user", content: "Question after reconnect", rawContentType: "text", resources: [], mentions: [], mentionedBot: false } });
    let resume: Promise<unknown> | undefined;
    try {
      await enteredRead.promise;
      resume = f.command("/goal resume");
      finishRead.resolve();
      await ordinary; await resume;
      await vi.waitFor(() => expect(calls).toEqual(["read-start", "pause", "watch-resume"]));
      expect(f.bridge.updateThreadGoal).toHaveBeenCalledWith(expect.objectContaining({ sessionId: goal.threadId, status: "paused", origin: "automatic" }));
      expect(f.bridge.clearThreadGoal).not.toHaveBeenCalled();
    } finally {
      finishRead.resolve(); finishGoal.resolve({ goal: { ...goal, status: "complete" } });
      await ordinary; await resume;
      await vi.waitFor(() => expect(f.runtime.activeRuns.has(key)).toBe(false));
    }
  });

  it("does not apply stale orphan recovery to a newly bound native session", async () => {
    const f = await fixture(), scope = { chatId: 1, conversationKey: key };
    const store = new SessionStore(path.join(f.stateDir, "sessions.json"));
    const update = vi.fn(async () => ({ goal }));
    const adapter: CodexAdapter = { createSession: vi.fn(), sendUserMessage: vi.fn(), updateThreadGoal: update };
    const manager = new SessionManager(store, adapter);
    await manager.bindSession(scope, "replacement-native-session");
    const bridge = new Bridge({} as AccessStoreLike, manager, adapter);
    await expect(bridge.updateThreadGoal({ ...scope, sessionId: goal.threadId, status: "paused", origin: "automatic" })).resolves.toEqual({ goal: null });
    expect(update).not.toHaveBeenCalled();
    expect(await manager.getExistingSession(scope)).toEqual({ sessionId: "replacement-native-session" });
  });

  it("does not resume a different fully applied session after reading the old goal", async () => {
    const f = await fixture(), scope = { chatId: 1, conversationKey: key };
    const store = new SessionStore(path.join(f.stateDir, "sessions.json"));
    const watch = vi.fn<NonNullable<CodexAdapter["watchThreadGoal"]>>(async (sessionId) => ({ goal: { ...goal, threadId: sessionId, status: "complete" } }));
    const adapter: CodexAdapter = {
      createSession: vi.fn(), sendUserMessage: vi.fn(), watchThreadGoal: watch,
      updateThreadGoal: vi.fn(async () => ({ goal })),
      getThreadGoal: vi.fn(async () => {
        await manager.bindSession(scope, "replacement-native-session");
        return { goal };
      }),
    };
    const manager = new SessionManager(store, adapter);
    await manager.bindSession(scope, goal.threadId);
    const bridge = new Bridge({} as AccessStoreLike, manager, adapter);
    await handleCoreSimpleCommand({ ...f, bridge, isCurrentGoalSession: async () => true } as never, normalized("/goal resume"), "/goal resume");
    expect(watch).not.toHaveBeenCalled();
    expect(adapter.updateThreadGoal).not.toHaveBeenCalled();
    expect(await manager.getExistingSession(scope)).toEqual({ sessionId: "replacement-native-session" });
  });

  it("does not let a delayed goal read rebind over a newly selected native session", async () => {
    const f = await fixture(), scope = { chatId: 1, conversationKey: key };
    const store = new SessionStore(path.join(f.stateDir, "sessions.json"));
    const adapter: CodexAdapter = {
      createSession: vi.fn(), sendUserMessage: vi.fn(),
      getThreadGoal: vi.fn(async () => {
        await manager.bindSession(scope, "replacement-native-session");
        return { goal: { ...goal, threadId: "old-read-resolved-session" }, sessionId: "old-read-resolved-session" };
      }),
    };
    const manager = new SessionManager(store, adapter);
    await manager.bindSession(scope, goal.threadId);
    const bridge = new Bridge({} as AccessStoreLike, manager, adapter);
    await bridge.getThreadGoal(scope);
    expect(await manager.getExistingSession(scope)).toEqual({ sessionId: "replacement-native-session" });
  });

  it.each(["update", "resume", "clear"] as const)("fences %s at native mutation even when a replacement selection is already fully applied", async (operation) => {
    const f = await fixture(), scope = { chatId: 1, conversationKey: key };
    const store = new SessionStore(path.join(f.stateDir, "sessions.json"));
    const mutations: string[] = [], checks: boolean[] = [];
    const atMutation = async (sessionId: string, input: { isCurrentSession?: () => boolean | Promise<boolean> }) => {
      // The adapter has completed its async initialization. Another request
      // fully applied B meanwhile, so canSteer is true again, but A is stale.
      await manager.bindSession(scope, "replacement-native-session");
      const current = input.isCurrentSession ? await input.isCurrentSession() : true;
      checks.push(current);
      if (current) mutations.push(sessionId);
      return current;
    };
    const adapter: CodexAdapter = {
      createSession: vi.fn(), sendUserMessage: vi.fn(),
      updateThreadGoal: async (sessionId, input) => ({ goal: await atMutation(sessionId, input) ? goal : null }),
      watchThreadGoal: async (sessionId, input) => ({ goal: await atMutation(sessionId, input) ? goal : null }),
      clearThreadGoal: async (sessionId, input) => ({ cleared: await atMutation(sessionId, input ?? {}) }),
    };
    const manager = new SessionManager(store, adapter);
    await manager.bindSession(scope, goal.threadId);
    const bridge = new Bridge({} as AccessStoreLike, manager, adapter);
    const input = { ...scope, isCurrentSession: async () => true };
    if (operation === "update") await bridge.updateThreadGoal({ ...input, sessionId: goal.threadId, status: "paused" });
    else if (operation === "resume") await bridge.watchThreadGoal({ ...input, mode: "resume", objective: goal.objective });
    else await bridge.clearThreadGoal(input);
    expect(checks).toEqual([false]);
    expect(mutations).toEqual([]);
    expect(await manager.getExistingSession(scope)).toEqual({ sessionId: "replacement-native-session" });
  });

  it.each(["resume", "observe"] as const)("starts native %s while an ordinary Bridge turn owns its lock", async (mode) => {
    const f = await fixture(), ordinaryEntered = deferred(), finishOrdinary = deferred(), finishGoal = deferred<CodexThreadGoalResponse>();
    const scope = { chatId: 1, conversationKey: key };
    const store = new SessionStore(path.join(f.stateDir, "sessions.json"));
    const watch = vi.fn<NonNullable<CodexAdapter["watchThreadGoal"]>>(async (sessionId, input) => {
      await input.onEngineEvent?.({ type: "session", sessionId });
      return await finishGoal.promise;
    });
    const adapter: CodexAdapter = {
      createSession: vi.fn(), watchThreadGoal: watch,
      sendUserMessage: vi.fn(async (sessionId) => { ordinaryEntered.resolve(); await finishOrdinary.promise; return { text: "done", sessionId }; }),
    };
    const manager = new SessionManager(store, adapter);
    await manager.bindSession(scope, goal.threadId);
    const bind = vi.spyOn(manager, "bindSession");
    const access: AccessStoreLike = { load: vi.fn(async () => ({ multiChat: true, policy: "allowlist" as const, allowlist: [1], pendingPairs: [], pairedUsers: [] })), issuePairingCode: vi.fn() };
    const bridge = new Bridge(access, manager, adapter);
    let ordinaryFinished = false, watching: Promise<unknown> | undefined;
    const ordinary = bridge.handleAuthorizedMessage({ ...scope, userId: 2, chatType: "private", text: "ordinary work", files: [] }).finally(() => { ordinaryFinished = true; });
    try {
      await ordinaryEntered.promise;
      watching = bridge.watchThreadGoal({ ...scope, mode, objective: goal.objective });
      await vi.waitFor(() => expect(watch).toHaveBeenCalledOnce());
      expect(ordinaryFinished).toBe(false);
      expect(watch).toHaveBeenCalledWith(goal.threadId, expect.objectContaining({ mode }));
      expect(bind).not.toHaveBeenCalled();
      finishGoal.resolve({ goal }); await watching;
      expect(await manager.getExistingSession(scope)).toEqual({ sessionId: goal.threadId });
    } finally { finishGoal.resolve({ goal }); finishOrdinary.resolve(); await watching; await ordinary; }
  });
});

it("delivers a suspended goal answer when all native card patches fail", async () => {
  const f = await fixture(); let sends = 0;
  const channel = {
    profile: "gateway" as const,
    updateCard: vi.fn(async () => { throw new Error("synthetic patch rejection"); }),
    send: vi.fn(async (_to: string, body: unknown) => {
      sends++;
      // Initial card creation succeeds; fresh cards fail so the answer must
      // reach the ordinary text fallback instead of disappearing with the card.
      if (sends > 1 && typeof body === "object" && body && "card" in body) throw new Error("synthetic fresh-card rejection");
      return { messageId: `reply-${sends}` };
    }),
  };
  const card = await createCoreRunCardController({ channel: channel as never, chatId: "review-chat", conversationKey: key, bridgeChatType: "private", locale: "en", goalObjective: goal.objective });
  expect(card).toBeDefined();
  await card!.interrupt("Verified partial work. Goal paused; use /goal resume.");
  expect(JSON.stringify(channel.send.mock.calls)).toContain("Verified partial work");
  const deliveredText = channel.send.mock.calls.filter(([, body]) => typeof body === "object" && body && "markdown" in body);
  expect(deliveredText.some(([, body]) => (body as { markdown: string }).markdown.includes("Verified partial work"))).toBe(true);
});

function incoming(content: string, extras: Record<string, unknown> = {}) {
  return { messageId: `input-${content}`, chatId: "review-chat", chatType: "p2p", senderId: "review-user", content, rawContentType: "text", resources: [], mentions: [], mentionedBot: false, ...extras };
}

async function hangingOrdinary() {
  const f = await fixture(), entered = deferred(), release = deferred();
  let ordinaryFinished = false;
  f.bridge.handleAuthorizedMessage.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { text: "ordinary done" }; });
  const channel = { ...f.channel, canSteerConversation: vi.fn(async () => true), prepareConversation: vi.fn(async () => {}) };
  const send = (content: string, extras: Record<string, unknown> = {}) => handleCoreMessage({ ...f, channel: channel as never, bridge: f.bridge as never, message: incoming(content, extras) as never });
  const ordinary = send("ordinary work").finally(() => { ordinaryFinished = true; });
  await entered.promise;
  f.bridge.getThreadGoal.mockClear(); f.bridge.updateThreadGoal.mockClear(); channel.canSteerConversation.mockClear();
  return { ...f, channel, send, ordinary, release, ordinaryFinished: () => ordinaryFinished };
}

describe("Codex goal controls before the ordinary turn queue", () => {
  it.each(["pause", "status", "clear"])("runs %s before a hanging ordinary turn ends, without sending a model prompt", async (control) => {
    const f = await hangingOrdinary();
    let pending: Promise<unknown> | undefined;
    try {
      pending = f.send(`/goal ${control}`);
      const native = control === "pause" ? f.bridge.updateThreadGoal : control === "clear" ? f.bridge.clearThreadGoal : f.bridge.getThreadGoal;
      await vi.waitFor(() => expect(native).toHaveBeenCalledOnce());
      await pending;
      expect(f.ordinaryFinished()).toBe(false);
      expect(f.bridge.handleAuthorizedMessage).toHaveBeenCalledOnce();
      expect(f.runtime.chatQueue.pendingCount(key)).toBe(0);
    } finally { f.release.resolve(); await f.ordinary; await pending; }
  });

  it("does not send unauthorized goal controls to the native runtime", async () => {
    const f = await hangingOrdinary();
    try {
      f.bridge.checkAccess.mockResolvedValue({ kind: "deny", text: "Denied for this fixture" } as never);
      await f.send("/goal pause");
      expect(f.bridge.getThreadGoal).not.toHaveBeenCalled(); expect(f.bridge.updateThreadGoal).not.toHaveBeenCalled();
      expect(f.bridge.clearThreadGoal).not.toHaveBeenCalled();
      expect(f.bridge.handleAuthorizedMessage).toHaveBeenCalledOnce();
      expect(f.ordinaryFinished()).toBe(false);
      expect(JSON.stringify(f.channel.send.mock.calls)).toContain("Denied for this fixture");
    } finally { f.release.resolve(); await f.ordinary; }
  });

  it("queues controls while the App's selected native session is not applied", async () => {
    const f = await hangingOrdinary(); let pending: Promise<unknown> | undefined;
    try {
      f.channel.canSteerConversation.mockResolvedValue(false);
      pending = f.send("/goal pause");
      await vi.waitFor(() => expect(f.runtime.chatQueue.pendingTaskSnapshot(key)).toContain("input-/goal pause"));
      expect(f.bridge.getThreadGoal).not.toHaveBeenCalled(); expect(f.bridge.updateThreadGoal).not.toHaveBeenCalled();
      expect(f.ordinaryFinished()).toBe(false);
      f.channel.prepareConversation.mockImplementation(async () => { f.channel.canSteerConversation.mockResolvedValue(true); });
      f.release.resolve(); await f.ordinary; await pending;
      expect(f.bridge.updateThreadGoal).toHaveBeenCalledOnce();
      expect(f.bridge.handleAuthorizedMessage).toHaveBeenCalledOnce();
    } finally { f.release.resolve(); await f.ordinary; await pending; }
  });

  it("rechecks a selection change during the authorization await before native access", async () => {
    const f = await hangingOrdinary(), accessEntered = deferred(), releaseAccess = deferred();
    let pending: Promise<unknown> | undefined;
    try {
      f.bridge.checkAccess.mockImplementationOnce(async () => { accessEntered.resolve(); await releaseAccess.promise; return { kind: "allow" }; });
      pending = f.send("/goal pause");
      await accessEntered.promise;
      f.channel.canSteerConversation.mockResolvedValue(false);
      releaseAccess.resolve();
      await vi.waitFor(() => expect(f.runtime.chatQueue.pendingTaskSnapshot(key)).toContain("input-/goal pause"));
      expect(f.bridge.getThreadGoal).not.toHaveBeenCalled(); expect(f.bridge.updateThreadGoal).not.toHaveBeenCalled();
      f.channel.prepareConversation.mockImplementation(async () => { f.channel.canSteerConversation.mockResolvedValue(true); });
      f.release.resolve(); await f.ordinary; await pending;
    } finally { releaseAccess.resolve(); f.release.resolve(); await f.ordinary; await pending; }
  });

  it("does not mutate a newly selected session after an in-flight goal read", async () => {
    const f = await hangingOrdinary(), readEntered = deferred(), finishRead = deferred();
    let pending: Promise<unknown> | undefined;
    try {
      f.bridge.getThreadGoal.mockImplementationOnce(async () => { readEntered.resolve(); await finishRead.promise; return { goal }; });
      pending = f.send("/goal pause");
      await readEntered.promise;
      f.channel.canSteerConversation.mockResolvedValue(false);
      finishRead.resolve();
      // A late selection change is rejected explicitly; wait for the complete
      // control transaction so this cannot pass before a stale mutation runs.
      await pending;
      expect(f.bridge.updateThreadGoal).not.toHaveBeenCalled();
      expect(JSON.stringify(f.channel.send.mock.calls)).toContain("selected session changed");
      expect(f.ordinaryFinished()).toBe(false);
      f.release.resolve(); await f.ordinary;
    } finally { finishRead.resolve(); f.release.resolve(); await f.ordinary; await pending; }
  });

  it("rejects signed Bot slash input before the new control fast path", async () => {
    const f = await hangingOrdinary();
    try {
      await expect(f.send("/goal pause", { botSource: { hostId: "source-host", hostName: "Example host", botId: "source-bot", botName: "Example bot", requestId: "request-example", hops: 1 } })).rejects.toThrow("bot_message_control_forbidden");
      expect(f.channel.canSteerConversation).not.toHaveBeenCalled();
      expect(f.bridge.getThreadGoal).not.toHaveBeenCalled(); expect(f.bridge.updateThreadGoal).not.toHaveBeenCalled();
    } finally { f.release.resolve(); await f.ordinary; }
  });

  it.each([
    ["quoted text", "> /goal pause", {}],
    ["group discussion input", "/goal pause", { groupDiscussion: { runId: "discussion-run", role: "input", mode: "independent" } }],
  ] as const)("keeps %s out of the control fast path", async (_label, text, extras) => {
    const f = await hangingOrdinary(); let pending: Promise<unknown> | undefined;
    try {
      pending = f.send(text, extras);
      await vi.waitFor(() => expect(f.runtime.chatQueue.pendingTaskSnapshot(key)).toContain(`input-${text}`));
      expect(f.bridge.updateThreadGoal).not.toHaveBeenCalled();
      expect(f.bridge.clearThreadGoal).not.toHaveBeenCalled();
      f.release.resolve(); await f.ordinary; await pending;
      expect(f.bridge.updateThreadGoal).not.toHaveBeenCalled();
      expect(f.bridge.clearThreadGoal).not.toHaveBeenCalled();
      expect(f.bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(2);
    } finally { f.release.resolve(); await f.ordinary; await pending; }
  });
});
