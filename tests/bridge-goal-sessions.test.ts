import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Bridge, type AccessStoreLike } from "../src/runtime/bridge.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { SessionStore } from "../src/state/session-store.js";
import type { CodexAdapter } from "../src/codex/adapter.js";
import { handleLocalSessionCoreCommand } from "../src/core/shared/session-commands.js";
import { bridgeConversationLockId, withBridgeTurnLock } from "../src/runtime/turn-lock.js";
import { removeTempRoot } from "./helpers/temp-files.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(overrides: Partial<CodexAdapter>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-goal-session-"));
  const scope = { chatId: -84, conversationKey: `goal-fixture:${randomUUID()}` };
  const store = new SessionStore(path.join(root, "session.json"));
  const adapter: CodexAdapter = {
    createSession: vi.fn(),
    sendUserMessage: vi.fn(async (sessionId) => ({ text: "continued", sessionId })),
    ...overrides,
  };
  const manager = new SessionManager(store, adapter);
  const access = { load: vi.fn().mockResolvedValue({ policy: "allowlist", allowlist: [-84], pendingPairs: [], pairedUsers: [] }), issuePairingCode: vi.fn() } as AccessStoreLike;
  const bridge = new Bridge(access, manager, adapter);
  const message = { ...scope, userId: 42, chatType: "private", text: "continue", files: [] };
  const goal = { ...scope, objective: "test only" };
  const command = async (text: string) => await handleLocalSessionCoreCommand({
    stateDir: root, startedAt: Date.now(), locale: "en", cfg: { engine: "codex" },
    normalized: { ...scope, userId: 42, chatType: "private", text, attachments: [] },
    context: { api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) } as never },
    sessionStore: store, updateInstanceConfig: vi.fn().mockResolvedValue(undefined),
    validateCodexThread: async () => ({ sessionId: "replacement-native", cwd: root }),
  });
  return { root, scope, store, adapter, manager, bridge, message, goal, command };
}

describe("goal session establishment", () => {
  it("does not block another Bot serving the same user's conversation key", async () => {
    const entered = deferred(), finish = deferred();
    const a = await fixture({ sendUserMessage: async (sessionId) => { entered.resolve(); await finish.promise; return { text: "A", sessionId }; } });
    const b = await fixture({});
    let running: Promise<unknown> | undefined;
    try {
      running = a.bridge.handleAuthorizedMessage(a.message); await entered.promise;
      await expect(b.bridge.handleAuthorizedMessage({ ...b.message, conversationKey: a.scope.conversationKey })).resolves.toMatchObject({ text: "continued" });
      expect(await b.manager.getExistingSession(a.scope)).not.toBeNull();
      finish.resolve(); await running;
    } finally { finish.resolve(); await running; await removeTempRoot(a.root); await removeTempRoot(b.root); }
  });

  it("uses the same lock for explicit and implicit Telegram roots and topics", () => {
    for (const scope of [{ chatId: -84 }, { chatId: -84, messageThreadId: 5 }]) {
      const conversationKey = "messageThreadId" in scope ? "chat:-84:topic:5" : "chat:-84";
      expect(bridgeConversationLockId(scope)).toBe(bridgeConversationLockId({ ...scope, conversationKey }));
    }
    expect(bridgeConversationLockId({ chatId: -84 })).not.toBe(bridgeConversationLockId({ chatId: -84, messageThreadId: 5 }));
  });

  it("does not create a native goal when cancelled while waiting for the conversation lock", async () => {
    const entered = deferred(), release = deferred();
    const f = await fixture({ watchThreadGoal: vi.fn() });
    const held = withBridgeTurnLock(bridgeConversationLockId(f.scope, await f.manager.getLockNamespace()), async () => { entered.resolve(); await release.promise; });
    try {
      await entered.promise;
      const abort = new AbortController();
      const watching = f.bridge.watchThreadGoal({ ...f.goal, abortSignal: abort.signal });
      const rejected = expect(watching).rejects.toMatchObject({ name: "AbortError" });
      abort.abort(); release.resolve(); await held; await rejected;
      expect(f.adapter.watchThreadGoal).not.toHaveBeenCalled();
      expect(await f.manager.getExistingSession(f.scope)).toBeNull();
    } finally { release.resolve(); await held; await removeTempRoot(f.root); }
  });

  it("queues reset behind an active ordinary turn instead of letting its final bind revive history", async () => {
    const entered = deferred(), finish = deferred();
    const f = await fixture({ sendUserMessage: async (sessionId) => { entered.resolve(); await finish.promise; return { text: "done", sessionId }; } });
    const inspect = vi.spyOn(f.store, "inspect");
    try {
      const message = f.bridge.handleAuthorizedMessage(f.message); await entered.promise;
      inspect.mockClear();
      const resetting = f.command("/reset");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(inspect).not.toHaveBeenCalled();
      finish.resolve(); await message; await resetting;
      expect(await f.manager.getExistingSession(f.scope)).toBeNull();
    } finally { finish.resolve(); await removeTempRoot(f.root); }
  });

  it("persists an unchanged native id from goal setup before a queued message starts", async () => {
    const entered = deferred(), finish = deferred(), waiting = deferred();
    const setThreadGoal = vi.fn(async (sessionId: string) => { entered.resolve(); await finish.promise; return { goal: null, sessionId }; });
    const f = await fixture({ setThreadGoal });
    try {
      const setting = f.bridge.setThreadGoal(f.goal); await entered.promise;
      const message = f.bridge.handleAuthorizedMessage({ ...f.message, turnLockWaitNotifyAfterMs: 0, onTurnLockWait: () => waiting.resolve() });
      await waiting.promise;
      expect(f.adapter.sendUserMessage).not.toHaveBeenCalled();
      finish.resolve(); await setting; await message;
      const nativeId = setThreadGoal.mock.calls[0]![0];
      expect(f.adapter.sendUserMessage).toHaveBeenCalledWith(nativeId, expect.anything());
      expect(await f.manager.getExistingSession(f.scope)).toEqual({ sessionId: nativeId });
    } finally { finish.resolve(); await removeTempRoot(f.root); }
  });

  it("publishes a live goal session early and releases the lock for normal conversation", async () => {
    const announced = deferred(), finish = deferred();
    const f = await fixture({ watchThreadGoal: async (sessionId, input) => {
      await Promise.all([input.onEngineEvent?.({ type: "session", sessionId }), input.onEngineEvent?.({ type: "session", sessionId })]);
      announced.resolve(); await finish.promise; return { goal: null, sessionId };
    } });
    const bind = vi.spyOn(f.manager, "bindSession");
    try {
      const watching = f.bridge.watchThreadGoal(f.goal); await announced.promise;
      const saved = await f.manager.getExistingSession(f.scope); expect(saved).not.toBeNull();
      expect(bind).toHaveBeenCalledTimes(1);
      await f.bridge.handleAuthorizedMessage(f.message);
      expect(f.adapter.sendUserMessage).toHaveBeenCalledWith(saved!.sessionId, expect.anything());
      finish.resolve(); await watching;
    } finally { finish.resolve(); await removeTempRoot(f.root); }
  });

  it.each(["/reset", "/resume thread replacement-native"])("does not overwrite %s when the background goal finishes", async (command) => {
    const announced = deferred(), finish = deferred();
    const clearThreadGoal = vi.fn(async (sessionId: string) => ({ cleared: true, sessionId }));
    const f = await fixture({ watchThreadGoal: async (sessionId, input) => {
      await input.onEngineEvent?.({ type: "session", sessionId }); announced.resolve();
      await finish.promise; return { goal: null, sessionId };
    }, clearThreadGoal });
    try {
      const watching = f.bridge.watchThreadGoal(f.goal); await announced.promise;
      await expect(f.command(command)).resolves.toBe(true);
      finish.resolve(); const result = await watching;
      expect(result.sessionId).toBeTruthy();
      await f.bridge.clearThreadGoal({ ...f.scope, sessionId: result.sessionId });
      expect(clearThreadGoal).toHaveBeenCalledWith(result.sessionId, expect.anything());
      expect(await f.manager.getExistingSession(f.scope)).toEqual(command === "/reset" ? null : { sessionId: "replacement-native" });
    } finally { finish.resolve(); await removeTempRoot(f.root); }
  });

  it("queues reset during native goal setup so its late publication cannot undo reset", async () => {
    const entered = deferred(), publish = deferred(), finish = deferred();
    const f = await fixture({ watchThreadGoal: async (sessionId, input) => {
      entered.resolve(); await publish.promise; await input.onEngineEvent?.({ type: "session", sessionId });
      await finish.promise; return { goal: null, sessionId };
    } });
    try {
      const watching = f.bridge.watchThreadGoal(f.goal); await entered.promise;
      const resetting = f.command("/reset");
      publish.resolve(); await resetting; finish.resolve(); await watching;
      expect(await f.manager.getExistingSession(f.scope)).toBeNull();
    } finally { publish.resolve(); finish.resolve(); await removeTempRoot(f.root); }
  });

  it("uses a final-only confirmation for older adapters and unlocks after startup errors", async () => {
    const f = await fixture({ watchThreadGoal: vi.fn()
      .mockRejectedValueOnce(new Error("native startup failed"))
      .mockImplementationOnce(async (sessionId: string) => ({ goal: null, sessionId })) });
    try {
      await expect(f.bridge.watchThreadGoal(f.goal)).rejects.toThrow("native startup failed");
      expect(await f.manager.getExistingSession(f.scope)).toBeNull();
      await f.bridge.watchThreadGoal(f.goal);
      expect(await f.manager.getExistingSession(f.scope)).not.toBeNull();
    } finally { await removeTempRoot(f.root); }
  });
});
