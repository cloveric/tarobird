import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewaySteering } from "../src/gateway/steering.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { buildCoreConversationKey } from "../src/core/message-normalizer.js";
import { STEERING_OUTCOME_CAPABILITY } from "../src/client-protocol/steering-outcome.js";
import { NATIVE_INPUT_CAPABILITY, type NativeInputObserver } from "../src/client-protocol/native-input.js";
import { HubStore } from "../src/hub/store.js";
import { Bridge, type AccessStoreLike } from "../src/runtime/bridge.js";
import { runSteeringCommand } from "../src/host-cli/steering.js";

describe("Claude ordinary native inputs", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "native-input-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  function fixture() {
    const runtime = createCoreServiceRuntime(), key = buildCoreConversationKey("chat");
    runtime.activeRuns.set(key, { abortController: new AbortController() });
    const capability = { sendNow: true, cancel: true, modelReceipt: true };
    const bridge = { supportsSteering: () => true, inFlightSendBehavior: () => "steer" as const,
      nativeInputCapability: vi.fn(async () => capability), controlNativeInput: vi.fn(async () => ({ outcome: "accepted" as const, result: "delivering" as const })),
      steerActiveTurn: vi.fn(async (input: { nativeInput?: NativeInputObserver }) => { input.nativeInput?.onProgress({ state: "queued" }); return true; }), handleAuthorizedMessage: vi.fn() };
    const channel = { canSteerConversation: vi.fn(async () => true), transport: { capabilities: [NATIVE_INPUT_CAPABILITY], request: vi.fn(async () => null), options: {} } };
    const create = () => gatewaySteering(bridge, runtime, channel as unknown as GatewayChannel, root);
    const run = create();
    const input = async () => ({ conversationId: "chat", userId: "owner", requestId: "input", text: "First", mode: "message", targetId: (await run("steer.status", { conversationId: "chat" }) as { targetId: string }).targetId });
    return { runtime, key, bridge, channel, create, run, input };
  }
  it("keeps ordinary admission separate from model receipt and persists at-most-once identity", async () => {
    const f = fixture(), p = await f.input();
    f.channel.transport.capabilities.push(STEERING_OUTCOME_CAPABILITY);
    expect(await f.run("steer", p)).toEqual({ outcome: "accepted" });
    expect(await f.create()("steer", p)).toEqual({ outcome: "accepted" });
    expect(f.bridge.steerActiveTurn).toHaveBeenCalledTimes(1);
    expect(f.bridge.steerActiveTurn.mock.calls[0]![0]).not.toHaveProperty("onOutcome");
    expect(f.channel.transport.request).toHaveBeenCalledWith("input.progress", expect.objectContaining({ requestId: "input", progress: { state: "queued" } }));
    expect(await f.create()("steer", { ...p, text: "Changed" })).toEqual({ outcome: "rejected", reason: "stale" });
    expect(f.bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    expect(f.runtime.chatQueue.pendingCount(f.key)).toBe(0);
  });
  it("scopes chosen client IDs to their authenticated author", async () => {
    const f = fixture(), p = await f.input();
    await f.run("steer", p); await f.run("steer", { ...p, userId: "second_user" });
    const ids = f.bridge.steerActiveTurn.mock.calls.map(([input]) => input.nativeInput!.id);
    expect(new Set(ids).size).toBe(2);
    await f.run("input.control", { conversationId: "chat", userId: "owner", requestId: "control", inputId: "input", action: "cancel" });
    expect(f.bridge.controlNativeInput).toHaveBeenCalledWith(expect.objectContaining({ inputId: ids[0] }));
  });
  it("requires both negotiated transport support and actual CLI capability", async () => {
    const f = fixture(); f.channel.transport.capabilities = [];
    expect(await f.run("steer.status", { conversationId: "chat" })).not.toHaveProperty("nativeInput");
    expect(await f.run("steer", await f.input())).toEqual({ outcome: "rejected", reason: "unsupported" });
    expect(f.bridge.steerActiveTurn).not.toHaveBeenCalled();
    expect(await f.run("input.control", { conversationId: "chat", userId: "owner", requestId: "control", inputId: "input", action: "send-now" })).toEqual({ outcome: "rejected", reason: "unsupported" });
    expect(f.bridge.controlNativeInput).not.toHaveBeenCalled();
  });
  it("rechecks completion after asynchronous native capability lookup", async () => {
    const f = fixture(), p = await f.input();
    f.bridge.nativeInputCapability.mockImplementation(async () => { f.runtime.activeRuns.delete(f.key); return { sendNow: true, cancel: true, modelReceipt: true }; });
    expect(await f.run("steer", p)).toEqual({ outcome: "rejected", reason: "stale" });
    expect(f.bridge.steerActiveTurn).not.toHaveBeenCalled();
  });
  it("does not replay send-now after timeout/restart or reuse a control ID for another input", async () => {
    const f = fixture(), p = { conversationId: "chat", userId: "owner", requestId: "control", inputId: "input", action: "send-now" };
    f.bridge.controlNativeInput.mockRejectedValueOnce(new Error("lost response"));
    expect(await f.run("input.control", p)).toEqual({ outcome: "unknown", reason: "uncertain" });
    expect(await f.create()("input.control", p)).toEqual({ outcome: "unknown", reason: "uncertain" });
    expect(f.bridge.controlNativeInput).toHaveBeenCalledTimes(1);
    const other = { ...p, requestId: "second" };
    expect(await f.run("input.control", other)).toEqual({ outcome: "accepted", result: "delivering" });
    expect(await f.run("input.control", { ...other, inputId: "other" })).toEqual({ outcome: "rejected", reason: "stale" });
    expect(await f.run("input.control", { ...other, action: "cancel" })).toEqual({ outcome: "rejected", reason: "stale" });
    expect(f.bridge.controlNativeInput).toHaveBeenCalledTimes(2);
    expect(f.runtime.activeRuns.get(f.key)?.abortController.signal.aborted).toBe(false);
  });
  it("caches a definite control rejection per request ID while a new attempt asks the CLI again", async () => {
    const f = fixture(), p = { conversationId: "chat", userId: "owner", requestId: "early", inputId: "input", action: "cancel" };
    f.bridge.controlNativeInput.mockResolvedValueOnce({ outcome: "rejected", reason: "stale" } as never);
    expect(await f.run("input.control", p)).toEqual({ outcome: "rejected", reason: "stale" });
    expect(await f.create()("input.control", p)).toEqual({ outcome: "rejected", reason: "stale" });
    expect(f.bridge.controlNativeInput).toHaveBeenCalledTimes(1);
    // The App clears a confirmed rejection and mints a new ID for the next click.
    expect(await f.run("input.control", { ...p, requestId: "later" })).toEqual({ outcome: "accepted", result: "delivering" });
    expect(f.bridge.controlNativeInput).toHaveBeenCalledTimes(2);
  });
  it("authorizes progress, retains stronger receipts and never creates a queued delivery", async () => {
    const store = await HubStore.open(root);
    try {
      await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','test'),('other','Other','test')");
      const chat = await store.createConversation("owner", ["bot", "other"], "Input", "group");
      const p = { conversationId: chat.id, botId: "bot", requestId: "input", targetId: "turn", text: "A", mode: "message" as const };
      const message = await store.beginSteering("owner", p);
      const report = { conversationId: chat.id, userId: "owner", requestId: p.requestId, targetId: p.targetId, progress: { state: "queued" } };
      await expect(store.applyNativeInputProgress("other", report)).rejects.toThrow("steering_target_mismatch");
      await expect(store.applyNativeInputProgress("bot", { ...report, targetId: "other" })).rejects.toThrow("steering_target_mismatch");
      await store.finishSteering(message.id, { outcome: "unknown", reason: "uncertain" });
      await store.applyNativeInputProgress("bot", report);
      const receipt = async () => (await store.snapshot("owner", chat.id)).messages[0]!.blocks.find(b => b.type === "steering");
      expect(await receipt()).toMatchObject({ outcome: "accepted", nativeInput: { state: "queued" } });
      await store.applyNativeInputProgress("bot", { ...report, progress: { state: "dequeued" } });
      await store.applyNativeInputProgress("bot", report);
      expect(await receipt()).toMatchObject({ nativeInput: { state: "dequeued" } });
      await store.applyNativeInputProgress("bot", { ...report, progress: { state: "unknown", reason: "withdraw_unconfirmed" } });
      await store.applyNativeInputProgress("bot", { ...report, progress: { state: "unknown", reason: "ended_without_model_receipt" } });
      expect(await receipt()).toMatchObject({ nativeInput: { state: "unknown", reason: "ended_without_model_receipt" } });
      await store.applyNativeInputProgress("bot", { ...report, progress: { state: "received" } });
      await store.applyNativeInputProgress("bot", { ...report, progress: { state: "unknown" } });
      expect(await receipt()).toMatchObject({ nativeInput: { state: "received" } });
      expect(await store.nativeInputForControl("owner", chat.id, message.id)).toEqual({ botId: "bot", inputId: "input", targetId: "turn" });
      await expect(store.nativeInputForControl("intruder", chat.id, message.id)).rejects.toThrow();
      expect((await store.beginSteering("owner", { ...p, mode: undefined })).blocks).toContainEqual(expect.objectContaining({ type: "steering", mode: "message" }));
      expect(await store.pendingForBot("bot")).toEqual([]);
    } finally { await store.db.close(); }
  });
  it("never controls a newly rebound native session", async () => {
    const sessions = { getOrCreateSession: vi.fn(), bindSession: vi.fn(), getExistingSession: vi.fn().mockResolvedValueOnce({ sessionId: "old" }).mockResolvedValue({ sessionId: "new" }) };
    const adapter = { createSession: vi.fn(), sendUserMessage: vi.fn(), controlNativeInput: vi.fn() };
    const bridge = new Bridge({ load: vi.fn(), issuePairingCode: vi.fn() } as AccessStoreLike, sessions, adapter);
    expect(await bridge.controlNativeInput({ chatId: 1, conversationKey: "lark:chat", inputId: "input", action: "cancel", isCurrentSession: async () => true })).toEqual({ outcome: "rejected", reason: "binding_changed" });
    expect(adapter.controlNativeInput).not.toHaveBeenCalled(); expect(sessions.getOrCreateSession).not.toHaveBeenCalled();
  });
  it("exposes send-now and cancel through the same headless API with caller request IDs", async () => {
    const client = { request: vi.fn(async () => ({ outcome: "accepted", result: "cancelled" })) };
    expect(await runSteeringCommand(client, "cancel", "chat", { message: "message", "request-id": "exact" })).toEqual({ outcome: "accepted", result: "cancelled" });
    expect(client.request).toHaveBeenCalledWith("/api/conversations/chat/inputs/message", "POST", { action: "cancel", requestId: "exact" });
    await expect(runSteeringCommand(client, "send-now", "chat", { message: "message", text: "Never resend text" })).rejects.toThrow();
  });
});
