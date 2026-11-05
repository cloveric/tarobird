import { EngineSteeringRejectedError } from "../src/codex/adapter.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewaySteering } from "../src/gateway/steering.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { CoreGoalRunController } from "../src/core/bus.js";
import { buildCoreConversationKey } from "../src/core/message-normalizer.js";
import { blocksText } from "../src/client-protocol/index.js";
import { HubStore } from "../src/hub/store.js";
import { Bridge, type AccessStoreLike } from "../src/runtime/bridge.js";

describe("explicit App steering", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "gateway-steering-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  function fixture() {
    const runtime = createCoreServiceRuntime(), key = buildCoreConversationKey("gw_chat");
    runtime.activeRuns.set(key, { abortController: new AbortController(), startedAt: Date.now() - 100_000 });
    const bridge = { supportsSteering: vi.fn(() => true), steerActiveTurn: vi.fn(async () => true), handleAuthorizedMessage: vi.fn(async () => ({ text: "" })) };
    const channel = { canSteerConversation: vi.fn(async () => true) };
    const create = () => gatewaySteering(bridge, runtime, channel as unknown as GatewayChannel, root);
    const run = create();
    const request = async () => ({ conversationId: "gw_chat", userId: "owner", requestId: "one", text: "改变方向", targetId: (await run("steer.status", { conversationId: "gw_chat" }) as { targetId: string }).targetId });
    return { runtime, key, bridge, channel, run, request, create };
  }
  it("steers after 30 seconds with a native receipt; duplicates and restart don't inject twice", async () => {
    const f = fixture(), request = await f.request();
    const results = await Promise.all([f.run("steer", request), f.run("steer", request)]);
    expect(results).toEqual([{ outcome: "accepted" }, { outcome: "accepted" }]);
    expect(await f.create()("steer", request)).toEqual({ outcome: "accepted" });
    expect(f.bridge.steerActiveTurn).toHaveBeenCalledTimes(1);
    expect(f.bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    expect(f.runtime.chatQueue.pendingCount(f.key)).toBe(0);
  });
  it("truthfully rejects unsupported, idle, changed run and changed binding", async () => {
    const f = fixture(), request = await f.request();
    f.bridge.supportsSteering.mockReturnValue(false);
    expect(await f.run("steer.status", { conversationId: "gw_chat" })).toEqual({ supported: false, reason: "unsupported" });
    expect(await f.run("steer", request)).toEqual({ outcome: "rejected", reason: "unsupported" });
    f.bridge.supportsSteering.mockReturnValue(true); f.runtime.activeRuns.delete(f.key);
    expect(await f.run("steer.status", { conversationId: "gw_chat" })).toEqual({ supported: true, reason: "idle" });
    f.runtime.activeRuns.set(f.key, { abortController: new AbortController() });
    expect(await f.run("steer", { ...request, requestId: "stale" })).toEqual({ outcome: "rejected", reason: "stale" });
    f.channel.canSteerConversation.mockResolvedValue(false);
    expect(await f.run("steer", { ...await f.request(), requestId: "binding" })).toEqual({ outcome: "rejected", reason: "binding_changed" });
    expect(f.bridge.steerActiveTurn).not.toHaveBeenCalled();
  });
  it("doesn't inject into the next run when an async binding read races completion", async () => {
    const f = fixture(), request = await f.request();
    f.channel.canSteerConversation.mockImplementation(async () => { f.runtime.activeRuns.set(f.key, { abortController: new AbortController() }); return true; });
    expect(await f.run("steer", request)).toEqual({ outcome: "rejected", reason: "stale" });
    expect(f.bridge.steerActiveTurn).not.toHaveBeenCalled();
  });
  it("never treats an autonomous goal as a normal active task", async () => {
    const f = fixture(); f.runtime.activeRuns.set(f.key, { abortController: new CoreGoalRunController(), goalWatch: true });
    expect(await f.run("steer.status", { conversationId: "gw_chat" })).toEqual({ supported: true, reason: "idle" });
  });
  it("derives native support from the actual adapter and rechecks the run after session lookup", async () => {
    const access = { load: vi.fn(), issuePairingCode: vi.fn() } as AccessStoreLike;
    let current = true;
    const sessions = { getOrCreateSession: vi.fn(), bindSession: vi.fn(), getExistingSession: vi.fn(async () => { current = false; return { sessionId: "native" }; }) };
    const adapter = { createSession: vi.fn(), sendUserMessage: vi.fn(), steerActiveTurn: vi.fn(async () => true) };
    const bridge = new Bridge(access, sessions, adapter);
    expect(bridge.supportsSteering()).toBe(true);
    expect(new Bridge(access, sessions, { createSession: vi.fn(), sendUserMessage: vi.fn() }).supportsSteering()).toBe(false);
    await expect(bridge.steerActiveTurn({ chatId: 1, conversationKey: "lark:gw_chat", text: "stop", isCurrentTurn: () => current, throwOnError: true })).rejects.toMatchObject({ reason: "stale" });
    expect(adapter.steerActiveTurn).not.toHaveBeenCalled();
    const unsupported = new Bridge(access, { getOrCreateSession: vi.fn(), bindSession: vi.fn() }, adapter);
    await expect(unsupported.steerActiveTurn({ chatId: 1, text: "not sent", throwOnError: true })).rejects.toMatchObject({ reason: "unsupported" });
    expect(await unsupported.steerActiveTurn({ chatId: 1, text: "automatic fallback" })).toBe(false);
  });
  it.each(["queued", "stale", "unsupported", "not_ready"] as const)("preserves explicit native %s rejection without replay", async (reason) => {
    const f = fixture(), request = await f.request(); f.bridge.steerActiveTurn.mockRejectedValue(new EngineSteeringRejectedError(reason));
    expect(await f.run("steer", request)).toEqual({ outcome: "rejected", reason });
    expect(await f.run("steer", request)).toEqual({ outcome: "rejected", reason });
    expect(f.bridge.steerActiveTurn).toHaveBeenCalledTimes(1);
  });
  it("records ambiguous transport failures without queueing or retrying the side effect", async () => {
    const f = fixture(), request = await f.request(); f.bridge.steerActiveTurn.mockRejectedValue(new Error("reply lost"));
    expect(await f.run("steer", request)).toEqual({ outcome: "unknown", reason: "uncertain" });
    expect(await f.run("steer", request)).toEqual({ outcome: "unknown", reason: "uncertain" });
    expect(f.bridge.steerActiveTurn).toHaveBeenCalledTimes(1);
    expect(f.bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
  });
  it("persists cross-device receipts without deliveries; validates access, content and recovery", async () => {
    const store = await HubStore.open(root);
    try {
      await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','test')");
      const conversation = await store.createConversation("owner", ["alpha"], "Chat", "direct");
      const input = { conversationId: conversation.id, botId: "alpha", requestId: "control", targetId: "turn", text: "补充" };
      const message = await store.beginSteering("owner", input);
      expect(blocksText(message.blocks)).toBe("补充");
      expect(await store.pendingForBot("alpha")).toEqual([]);
      await expect(store.beginSteering("other", input)).rejects.toThrow("conversation_forbidden");
      await expect(store.beginSteering("owner", { ...input, text: "别的指令" })).rejects.toThrow("idempotency_conflict");
      await expect(store.sendMessage("owner", { ...input, clientMsgId: input.requestId, attachments: [] })).rejects.toThrow("idempotency_conflict");
      await store.recoverSteering();
      expect((await store.snapshot("owner", conversation.id)).messages[0]?.blocks).toContainEqual(expect.objectContaining({ type: "steering", outcome: "unknown" }));
      await store.finishSteering(message.id, { outcome: "accepted" });
      await store.finishSteering(message.id, { outcome: "unknown", reason: "uncertain" });
      const snapshot = await store.snapshot("owner", conversation.id);
      expect(snapshot.messages).toHaveLength(1);
      expect(snapshot.messages[0]?.blocks).toContainEqual(expect.objectContaining({ type: "steering", outcome: "accepted" }));
      expect(await store.pendingForBot("alpha")).toEqual([]);
    } finally { await store.db.close(); }
  });
  it("adoption receipts preserve early outcomes, authorize the addressed Bot and never enqueue work", async () => {
    const store = await HubStore.open(root);
    try {
      await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','test'),('beta','Beta','test')");
      const chat = await store.createConversation("owner", ["alpha", "beta"], "Adoption", "group");
      const input = { conversationId: chat.id, botId: "alpha", requestId: "adoption", targetId: "turn", text: "补充" };
      const message = await store.beginSteering("owner", input);
      const update = { conversationId: chat.id, userId: "owner", requestId: "adoption", targetId: "turn", application: { status: "dropped", reason: "stopped" } };
      await expect(store.applySteeringOutcome("beta", update)).rejects.toThrow("steering_target_mismatch");
      await expect(store.applySteeringOutcome("alpha", { ...update, targetId: "next" })).rejects.toThrow("steering_target_mismatch");
      await store.applySteeringOutcome("alpha", update);
      await store.finishSteering(message.id, { outcome: "accepted" });
      await store.applySteeringOutcome("alpha", { ...update, application: { status: "applied", via: "fold" } });
      const snapshot = await store.snapshot("owner", chat.id);
      expect(snapshot.messages[0]?.blocks).toContainEqual(expect.objectContaining({ type: "steering", outcome: "accepted", application: { status: "dropped", reason: "stopped" } }));
      expect(await store.pendingForBot("alpha")).toEqual([]);
    } finally { await store.db.close(); }
  });

});
