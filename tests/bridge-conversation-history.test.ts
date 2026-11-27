import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAdapter } from "../src/codex/adapter.js";
import { ConversationHistoryController, type ConversationHistoryApply, type NativeConversationHistoryAdapter } from "../src/runtime/conversation-history.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { SessionStore } from "../src/state/session-store.js";
import { bridgeConversationLockId, withBridgeTurnLock } from "../src/runtime/turn-lock.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const scope = { chatId: 7, conversationKey: "lark:source" };
const anchor = { sessionId: "native-source", inputId: "native-input-1", rewind: true, fork: true, forkBoundary: "after-turn" as const };
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-history-")); roots.push(root);
  const store = new SessionStore(path.join(root, "session.json"));
  await store.upsert({ telegramChatId: 7, conversationKey: scope.conversationKey, codexSessionId: anchor.sessionId, status: "idle", updatedAt: "2026-01-01T00:00:00.000Z" });
  const getHistoryState = vi.fn<NonNullable<NativeConversationHistoryAdapter["getHistoryState"]>>(async () => ({ fork: { whole: true, anchored: true }, rewind: true, head: "head-1" }));
  const forkHistory = vi.fn<NonNullable<NativeConversationHistoryAdapter["forkHistory"]>>(async () => ({ outcome: "applied", sessionId: "native-fork", head: "fork-head", boundary: "whole" }));
  const rewindHistory = vi.fn<NonNullable<NativeConversationHistoryAdapter["rewindHistory"]>>(async () => ({ outcome: "applied", sessionId: anchor.sessionId, head: "head-before", boundary: "before-input", excludedInputIds: [anchor.inputId] }));
  const adapter = { getHistoryState, forkHistory, rewindHistory };
  const sessions = new SessionManager(store, adapter as unknown as CodexAdapter);
  const controller = new ConversationHistoryController(sessions, adapter);
  const snapshot = await controller.get(scope);
  const request: ConversationHistoryApply = { ...scope, operationId: "op1", expectedRevision: snapshot.revision!, action: { kind: "fork", scope: "whole" } };
  return { store, sessions, controller, adapter, request, root };
}

describe("conversation history native transaction", () => {
  it("keeps the fence when finalization authorization changes during binding readback", async () => {
    const f = await setup();
    const result = await f.controller.apply(f.request);
    let allowed = true;
    const read = f.sessions.getHistoryBinding.bind(f.sessions);
    vi.spyOn(f.sessions, "getHistoryBinding").mockImplementationOnce(async input => {
      const binding = await read(input); allowed = false; return binding;
    });
    const destination = { conversationId: "fork", chatId: 8, conversationKey: "lark:fork" };
    await expect(f.controller.finalize({ ...f.request, result, destination, isCurrentSession: async () => allowed })).rejects.toThrow("history_source_changed");
    expect((await f.store.inspectHistory(scope.conversationKey))?.record.historyFence?.operationId).toBe(f.request.operationId);
    expect(await f.store.findByConversationKey(destination.conversationKey)).toBeNull();
    expect(f.adapter.forkHistory).toHaveBeenCalledTimes(1);
  });
  it("binds only after a durable native receipt is supplied for finalization, and preserves the source", async () => {
    const f = await setup();
    const result = await f.controller.apply(f.request);
    expect(result).toMatchObject({ outcome: "applied", sourceSessionId: anchor.sessionId, destinationSessionId: "native-fork" });
    expect((await f.store.load()).chats).toHaveLength(1);
    await expect(f.sessions.getOrCreateSession(scope)).rejects.toThrow("history_outcome_pending");
    const destination = { conversationId: "new-chat", chatId: 8, conversationKey: "lark:new-chat" };
    const finalized = await f.controller.finalize({ ...f.request, result, destination });
    expect(await f.controller.finalize({ ...f.request, result, destination })).toEqual(finalized);
    expect((await f.store.findByConversationKey(scope.conversationKey))?.codexSessionId).toBe(anchor.sessionId);
    expect((await f.store.findByConversationKey(destination.conversationKey))?.codexSessionId).toBe("native-fork");
    expect(f.adapter.forkHistory).toHaveBeenCalledTimes(1);
  });

  it("rejects both local binding ABA and externally changed native heads before the write", async () => {
    const f = await setup();
    f.adapter.getHistoryState.mockResolvedValueOnce({ fork: { whole: true, anchored: true }, rewind: true, head: "external-change" });
    expect(await f.controller.apply(f.request)).toMatchObject({ outcome: "rejected", reason: "source_changed" });
    const record = (await f.store.findByConversationKey(scope.conversationKey))!;
    await f.store.upsert({ ...record, codexSessionId: "another" }); await f.store.upsert(record);
    expect(await f.controller.apply(f.request)).toMatchObject({ outcome: "rejected", reason: "source_changed" });
    expect(f.adapter.forkHistory).not.toHaveBeenCalled();
  });

  it.each(["busy", "goal_active", "background_work"] as const)("does not call native mutation when %s", async blocked => {
    const f = await setup();
    f.adapter.getHistoryState.mockResolvedValue({ fork: { whole: true, anchored: true }, rewind: true, head: "head-1", blocked });
    expect(await f.controller.apply(f.request)).toMatchObject({ outcome: "rejected", reason: blocked });
    expect(f.adapter.forkHistory).not.toHaveBeenCalled();
    expect((await f.store.inspectHistory(scope.conversationKey))?.record.historyFence).toBeUndefined();
  });

  it("invalidates a displayed revision when the effective workspace changes", async () => {
    const f = await setup();
    const original = await f.controller.get({ ...scope, workspaceOverride: "/srv/original-project" });
    expect(await f.controller.apply({ ...f.request, expectedRevision: original.revision!, workspaceOverride: "/srv/changed-project" })).toMatchObject({ outcome: "rejected", reason: "source_changed" });
    expect(f.adapter.forkHistory).not.toHaveBeenCalled();
  });

  it.each(["conversation", "native"] as const)("does not read native history during an owned %s turn", async kind => {
    const f = await setup(), entered = gate(), release = gate();
    f.adapter.getHistoryState.mockClear();
    const id = kind === "native" ? anchor.sessionId : bridgeConversationLockId(scope, await f.sessions.getLockNamespace());
    const generation = (await f.store.inspectHistory(scope.conversationKey))!.record.historyGeneration;
    const held = withBridgeTurnLock(id, async () => { entered.resolve(); await release.promise; });
    try {
      await entered.promise;
      // What the session could do when last read, so the App shows the entry disabled
      // ("wait for the current reply") instead of hiding it; no revision, so nothing can be admitted.
      // The binding lets the Hub still list this session's anchors, so message entries show disabled too.
      const busy = await f.controller.get(scope);
      expect(busy).toEqual({ supported: true, blocked: "busy", capabilities: { rewind: true, fork: true, anchoredFork: true },
        sourceSessionId: anchor.sessionId, bindingGeneration: generation });
      expect(f.adapter.getHistoryState).not.toHaveBeenCalled();
    } finally { release.resolve(); await held; }
  });

  it("rejects a busy native lock immediately without a deferred mutation", async () => {
    const f = await setup(), entered = gate(), release = gate();
    const held = withBridgeTurnLock(anchor.sessionId, async () => { entered.resolve(); await release.promise; });
    try {
      await entered.promise;
      expect(await f.controller.apply(f.request)).toMatchObject({ outcome: "rejected", reason: "busy" });
    } finally { release.resolve(); await held; }
    expect(f.adapter.forkHistory).not.toHaveBeenCalled();
  });

  it("rejects a busy logical lock without waiting or changing its binding", async () => {
    const f = await setup(), entered = gate(), release = gate();
    const held = withBridgeTurnLock(bridgeConversationLockId(scope, await f.sessions.getLockNamespace()), async () => { entered.resolve(); await release.promise; });
    try {
      await entered.promise;
      expect(await f.controller.apply(f.request)).toMatchObject({ outcome: "rejected", reason: "busy" });
    } finally { release.resolve(); await held; }
    expect(f.adapter.forkHistory).not.toHaveBeenCalled();
  });

  it("keeps an uncertain result fenced across process replacement, without executing it twice", async () => {
    const f = await setup();
    f.adapter.forkHistory.mockRejectedValueOnce(new Error("connection closed after write"));
    expect(await f.controller.apply(f.request)).toMatchObject({ outcome: "unknown" });
    const restarted = new ConversationHistoryController(new SessionManager(new SessionStore(path.join(f.root, "session.json")), f.adapter as unknown as CodexAdapter), f.adapter);
    expect(await restarted.get(scope)).toMatchObject({ blocked: "outcome_unknown", pendingOperation: "op1" });
    expect(await restarted.apply({ ...f.request, operationId: "op2" })).toMatchObject({ outcome: "rejected", reason: "outcome_unknown" });
    await expect(restarted.finalize({ ...f.request, result: { outcome: "unknown" } })).rejects.toThrow("history_outcome_pending");
    expect(f.adapter.forkHistory).toHaveBeenCalledTimes(1);
  });

  it("requires an exact native anchor and exact rewind exclusions", async () => {
    const f = await setup();
    const request: ConversationHistoryApply = { ...f.request, action: { kind: "rewind", anchorId: "app-anchor" } };
    expect(await f.controller.apply(request)).toMatchObject({ outcome: "rejected", reason: "anchor_unavailable" });
    expect(await f.controller.apply({ ...request, nativeAnchor: { ...anchor, sessionId: "foreign" } })).toMatchObject({ outcome: "rejected", reason: "anchor_unavailable" });
    f.adapter.rewindHistory.mockResolvedValueOnce({ outcome: "applied", sessionId: anchor.sessionId, head: "head-before", boundary: "before-input" });
    expect(await f.controller.apply({ ...request, nativeAnchor: anchor })).toMatchObject({ outcome: "unknown" });
    expect(f.adapter.rewindHistory).toHaveBeenCalledTimes(1);
  });

  it.each(["whole", "anchor", "rewind"] as const)("does not accept a native result with a different %s boundary", async kind => {
    const f = await setup();
    const action = kind === "rewind" ? { kind: "rewind" as const, anchorId: "app-anchor" }
      : kind === "anchor" ? { kind: "fork" as const, scope: "anchor" as const, anchorId: "app-anchor" }
        : { kind: "fork" as const, scope: "whole" as const };
    if (kind === "rewind") f.adapter.rewindHistory.mockResolvedValueOnce({ outcome: "applied", sessionId: anchor.sessionId,
      head: "head-before", boundary: "after-turn", excludedInputIds: [anchor.inputId] });
    else f.adapter.forkHistory.mockResolvedValueOnce({ outcome: "applied", sessionId: "native-fork", head: "head-fork", boundary: kind === "whole" ? "before-input" : "whole" });
    expect(await f.controller.apply({ ...f.request, action, ...(kind !== "whole" ? { nativeAnchor: anchor } : {}) })).toMatchObject({ outcome: "unknown" });
    expect((await f.store.inspectHistory(scope.conversationKey))?.record.historyFence?.operationId).toBe("op1");
  });

  it("accepts anchored-only native capability without enabling whole-session fork", async () => {
    const f = await setup();
    f.adapter.getHistoryState.mockResolvedValue({ fork: { whole: false, anchored: true }, head: "head-1" });
    f.adapter.forkHistory.mockResolvedValueOnce({ outcome: "applied", sessionId: "native-fork", head: anchor.inputId, boundary: "after-turn" });
    expect(await f.controller.apply({ ...f.request, action: { kind: "fork", scope: "anchor", anchorId: "app-anchor" }, nativeAnchor: anchor })).toMatchObject({ outcome: "applied" });
  });

  it("projects exact native cut evidence and advances revision only on finalization", async () => {
    const f = await setup();
    const request: ConversationHistoryApply = { ...f.request, action: { kind: "rewind", anchorId: "app-anchor" }, nativeAnchor: anchor };
    const before = await f.store.inspectHistory(scope.conversationKey);
    const result = await f.controller.apply(request);
    expect(result).toMatchObject({ outcome: "applied", excludedNativeInputIds: [anchor.inputId], forkBoundary: "before-input" });
    expect((await f.store.inspectHistory(scope.conversationKey))?.record.historyRevision).toBe(before?.record.historyRevision);
    await f.controller.finalize({ ...request, result });
    expect((await f.store.inspectHistory(scope.conversationKey))?.record.historyRevision).not.toBe(before?.record.historyRevision);
  });

  it("clears only the exact reservation on a native refusal and allows unsupported preflight finalization", async () => {
    const f = await setup();
    f.adapter.forkHistory.mockResolvedValueOnce({ outcome: "rejected", reason: "source_missing" });
    const result = await f.controller.apply(f.request);
    await expect(f.controller.finalize({ ...f.request, operationId: "wrong", result })).rejects.toThrow("history_source_changed");
    await f.controller.finalize({ ...f.request, result });
    expect((await f.store.inspectHistory(scope.conversationKey))?.record.historyFence).toBeUndefined();
    const unsupported = new ConversationHistoryController(f.sessions, {});
    await expect(unsupported.finalize({ ...f.request, result: { outcome: "rejected", reason: "unsupported" } })).resolves.toHaveProperty("revision");
  });

  it("does not admit two callers while a native write is pending", async () => {
    const f = await setup(), entered = gate(), release = gate();
    f.adapter.forkHistory.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { outcome: "applied", sessionId: "native-fork", head: "fork-head", boundary: "whole" }; });
    const first = f.controller.apply(f.request);
    try {
      await entered.promise;
      expect(await f.controller.apply({ ...f.request, operationId: "op2" })).toMatchObject({ outcome: "rejected", reason: "busy" });
    } finally { release.resolve(); await first; }
    expect(f.adapter.forkHistory).toHaveBeenCalledTimes(1);
  });
});

describe("conversation history reads without the native step", () => {
  it("answers busy from the last capabilities and the binding, without a native read", async () => {
    const f = await setup();
    f.adapter.getHistoryState.mockClear();
    const generation = (await f.store.inspectHistory(scope.conversationKey))!.record.historyGeneration;
    // A turn for this conversation is queued: the Gateway asks without the native step,
    // so the turn never waits behind a slow transcript read.
    expect(await f.controller.get(scope, { turnPending: true })).toEqual({ supported: true, blocked: "busy", cachedWhilePending: true,
      capabilities: { rewind: true, fork: true, anchoredFork: true }, sourceSessionId: anchor.sessionId, bindingGeneration: generation });
    expect(f.adapter.getHistoryState).not.toHaveBeenCalled();
    // An ordinary read still reads natively afterwards.
    expect(await f.controller.get(scope)).toMatchObject({ supported: true, revision: expect.any(String) });
    expect(f.adapter.getHistoryState).toHaveBeenCalledOnce();
  });
  it("reads once as usual while a turn is pending if nothing is known yet in this process", async () => {
    const f = await setup();
    const fresh = new ConversationHistoryController(f.sessions, f.adapter);
    f.adapter.getHistoryState.mockClear();
    expect(await fresh.get(scope, { turnPending: true })).toMatchObject({ supported: true, revision: expect.any(String),
      capabilities: { rewind: true, fork: true, anchoredFork: true } });
    expect(f.adapter.getHistoryState).toHaveBeenCalledOnce();
    expect(await fresh.get(scope, { turnPending: true })).toMatchObject({ supported: true, blocked: "busy" });
    expect(f.adapter.getHistoryState).toHaveBeenCalledOnce();
  });
});
