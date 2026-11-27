import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { gatewayConversationHistory } from "../src/gateway/conversation-history.js";
import { CONVERSATION_HISTORY_CAPABILITY, historyInternalSnapshotSchema } from "../src/client-protocol/conversation-history.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { buildCoreConversationKey } from "../src/core/message-normalizer.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { ConversationHistoryController, type NativeConversationHistoryAdapter } from "../src/runtime/conversation-history.js";

let directory: string, run: ReturnType<typeof gatewayConversationHistory>, runtime: ReturnType<typeof createCoreServiceRuntime>;
const input = { userId: "owner", botId: "bot", conversationId: "chat", operationId: "operation", expectedRevision: "revision", action: { kind: "fork" as const, scope: "whole" as const } };
const native = { outcome: "applied" as const, sourceSessionId: "source", destinationSessionId: "destination" };
const bridge = { handleAuthorizedMessage: vi.fn(async () => ({ text: "unused" })), getConversationHistory: vi.fn(async () => ({ supported: true, revision: "revision", sourceSessionId: "source", bindingGeneration: "generation", capabilities: { rewind: true, fork: true, anchoredFork: true } })), applyConversationHistory: vi.fn(async () => native), finalizeConversationHistory: vi.fn(async () => ({ revision: "next_revision" })) };
const requestLive = vi.fn(async () => ({ allowed: true })), publish = vi.fn(() => ({ persisted: Promise.resolve(), response: Promise.resolve(null) }));
const channel = { transport: { capabilities: [CONVERSATION_HISTORY_CAPABILITY], requestLive, enqueue: publish }, canSteerConversation: async () => true, isConversationProcessing: () => false } as unknown as GatewayChannel;
beforeEach(async () => { vi.clearAllMocks(); directory = await mkdtemp(path.join(os.tmpdir(), "gateway-history-")); await writeFile(path.join(directory, "config.json"), "{}"); runtime = createCoreServiceRuntime(); run = gatewayConversationHistory(bridge, channel, runtime, directory, "bot"); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
it("performs native mutation once and finalizes only the persisted exact payload", async () => {
  expect(await run("history.apply", input)).toEqual(native);
  expect(await run("history.apply", input)).toEqual(native);
  expect(bridge.applyConversationHistory).toHaveBeenCalledOnce();
  expect(await run("history.finalize", { ...input, result: native, destinationConversationId: "fork" })).toEqual({ revision: "next_revision" });
  await expect(run("history.finalize", { ...input, action: { ...input.action, title: "changed" }, result: native, destinationConversationId: "fork" })).rejects.toThrow("history_request_conflict");
  expect(bridge.finalizeConversationHistory).toHaveBeenCalledOnce();
});
it("reads a completed receipt without changing files or invoking native/finalize", async () => {
  await run("history.apply", input); const folder = path.join(directory, "gateway-receipts"), files = await readdir(folder);
  const before = await Promise.all(files.map(file => readFile(path.join(folder, file), "utf8")));
  const restarted = gatewayConversationHistory(bridge, channel, runtime, directory, "bot");
  expect(await restarted("history.receipt", input)).toEqual({ result: native });
  expect(await Promise.all(files.map(file => readFile(path.join(folder, file), "utf8")))).toEqual(before);
  expect(bridge.applyConversationHistory).toHaveBeenCalledOnce(); expect(bridge.finalizeConversationHistory).not.toHaveBeenCalled();
  expect(publish).toHaveBeenCalledOnce();
});
it("records each history change and its outcome in the Bot timeline", async () => {
  await run("history.apply", input);
  bridge.applyConversationHistory.mockRejectedValueOnce(new Error("native_reply_lost"));
  await run("history.apply", { ...input, operationId: "lost" });
  const events = (await readFile(path.join(directory, "timeline.log.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(events.map(event => [event.type, event.detail, event.outcome, event.metadata])).toEqual([
    ["command.handled", "history.fork", "applied", { source: "gateway.history", operationId: "operation", scope: "whole" }],
    ["command.handled", "history.fork", "unknown", { source: "gateway.history", operationId: "lost", scope: "whole", reason: "uncertain" }],
  ]);
});
it("keeps thrown native outcomes unknown and never replays them after restart", async () => {
  bridge.applyConversationHistory.mockRejectedValueOnce(new Error("native_reply_lost"));
  expect(await run("history.apply", input)).toEqual({ outcome: "unknown", reason: "uncertain" });
  const restarted = gatewayConversationHistory(bridge, channel, runtime, directory, "bot");
  expect(await restarted("history.apply", input)).toEqual({ outcome: "unknown", reason: "uncertain" });
  expect(bridge.applyConversationHistory).toHaveBeenCalledOnce();
});
it("rejects live queue work and stale anchor generation without invoking native", async () => {
  let release!: () => void; const queue = runtime.chatQueue.enqueue(buildCoreConversationKey("chat"), () => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve();
  expect(await run("history.apply", input)).toEqual({ outcome: "rejected", reason: "busy" }); release(); await queue;
  expect(await run("history.apply", { ...input, operationId: "other", anchorGeneration: "old", anchorSessionId: "source", nativeAnchor: { inputId: "anchor" } })).toEqual({ outcome: "rejected", reason: "source_changed" });
  expect(bridge.applyConversationHistory).not.toHaveBeenCalled();
});
it("rejects a busy answer that still names its session, before App tools or native", async () => {
  // A reply in progress still names its binding so the Hub can list anchors; that is no admission.
  bridge.getConversationHistory.mockImplementationOnce(async () => ({ supported: true, blocked: "busy", sourceSessionId: "source", bindingGeneration: "generation", capabilities: { rewind: true, fork: true, anchoredFork: true } }) as never);
  expect(await run("history.apply", input)).toEqual({ outcome: "rejected", reason: "busy" });
  expect(bridge.applyConversationHistory).not.toHaveBeenCalled();
});
it("reauthorizes receipt lookup and never reveals an old result after revocation", async () => {
  await run("history.apply", input); requestLive.mockResolvedValueOnce({ allowed: false });
  await expect(run("history.receipt", input)).rejects.toThrow("history_forbidden");
  expect(bridge.applyConversationHistory).toHaveBeenCalledOnce();
});

it("finalizes a release of an operation left unconfirmed, but not while this process runs it and never as a success", async () => {
  const cancelled = { outcome: "rejected" as const, reason: "cancelled" as const };
  bridge.applyConversationHistory.mockImplementationOnce(() => new Promise(() => undefined));
  void run("history.apply", input);
  await vi.waitFor(() => expect(bridge.applyConversationHistory).toHaveBeenCalledOnce(), { timeout: 15_000 });
  await expect(run("history.finalize", { ...input, result: cancelled })).rejects.toThrow("history_operation_running");
  const restarted = gatewayConversationHistory(bridge, channel, runtime, directory, "bot");
  await expect(restarted("history.finalize", { ...input, result: native, destinationConversationId: "fork" })).rejects.toThrow("history_receipt_unconfirmed");
  expect(await restarted("history.finalize", { ...input, result: cancelled })).toEqual({ revision: "next_revision" });
  expect(bridge.finalizeConversationHistory).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: input.operationId, result: cancelled }));
  // Never admitted by this Gateway at all: nothing to clear, still finalized.
  expect(await restarted("history.finalize", { ...input, operationId: "never", result: cancelled })).toEqual({ revision: "next_revision" });
  // A recorded success is not released.
  await restarted("history.apply", { ...input, operationId: "done" });
  await expect(restarted("history.finalize", { ...input, operationId: "done", result: cancelled })).rejects.toThrow("history_receipt_unconfirmed");
}, 30_000);

it("answers a snapshot without a native read while a turn is queued, and records it", async () => {
  const read = { userId: "owner", botId: "bot", conversationId: "chat" };
  let release!: () => void; const queue = runtime.chatQueue.enqueue(buildCoreConversationKey("chat"), () => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve();
  bridge.getConversationHistory.mockImplementationOnce(async () => ({ supported: true, blocked: "busy" }) as never);
  expect(await run("history.snapshot", read)).toMatchObject({ blocked: "busy" });
  expect(bridge.getConversationHistory).toHaveBeenCalledOnce();
  expect((bridge.getConversationHistory.mock.calls[0] as unknown[])[1]).toEqual({ turnPending: true });
  release(); await queue;
  const events = (await readFile(path.join(directory, "timeline.log.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(events.map(event => [event.type, event.detail, event.outcome, event.metadata.turnPending])).toEqual([["engine.event", "history.snapshot", "busy", true]]);
});

it("reads natively when idle and records only slow reads", async () => {
  const read = { userId: "owner", botId: "bot", conversationId: "chat" };
  expect(await run("history.snapshot", read)).toMatchObject({ supported: true, revision: "revision" });
  expect((bridge.getConversationHistory.mock.calls[0] as unknown[])[1]).toBeUndefined();
  const original = bridge.getConversationHistory.getMockImplementation()!;
  bridge.getConversationHistory.mockImplementationOnce(async (...args: Parameters<typeof original>) => { await new Promise(resolve => setTimeout(resolve, 1_050)); return await original(...args); });
  await run("history.snapshot", read);
  const events = (await readFile(path.join(directory, "timeline.log.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "engine.event", detail: "history.snapshot", outcome: "read", metadata: { source: "gateway.history", turnPending: false } });
  expect(events[0].metadata.durationMs).toBeGreaterThanOrEqual(1_000);
});

const snapshotInput = { userId: "owner", botId: "bot", conversationId: "chat" };
const pendingKey = buildCoreConversationKey(snapshotInput.conversationId);

function nativeHistoryGateway() {
  const getHistoryBinding = vi.fn(async () => ({ record: {
    telegramChatId: 7, codexSessionId: "fixture-session", status: "idle" as const,
    updatedAt: "2026-01-01T00:00:00.000Z", historyGeneration: "generation", historyRevision: "revision",
  }, shared: false }));
  const getHistoryState = vi.fn<NonNullable<NativeConversationHistoryAdapter["getHistoryState"]>>(async () => ({
    head: "head", rewind: true, fork: { whole: true, anchored: true },
  }));
  const controller = new ConversationHistoryController({
    getLockNamespace: async () => directory, getHistoryBinding,
    reserveHistory: vi.fn(), releaseHistory: vi.fn(), finalizeHistory: vi.fn(),
  }, { getHistoryState });
  const getConversationHistory = vi.fn(controller.get.bind(controller));
  const call = gatewayConversationHistory({ ...bridge, getConversationHistory }, channel, runtime, directory, "bot");
  const snapshot = () => call("history.snapshot", snapshotInput);
  return { getHistoryBinding, getHistoryState, getConversationHistory, snapshot };
}

it("returns a revision in the same request when the queue drains during the cached binding read", async () => {
  const f = nativeHistoryGateway();
  const before = historyInternalSnapshotSchema.parse(await f.snapshot());
  const readBinding = f.getHistoryBinding.getMockImplementation()!;
  let release!: () => void;
  const queue = runtime.chatQueue.enqueue(pendingKey, () => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve();
  f.getHistoryBinding.mockImplementationOnce(async () => {
    release();
    await queue;
    return readBinding();
  });
  f.getHistoryState.mockResolvedValueOnce({ head: "new-head", fork: { whole: true, anchored: true } });

  const after = await f.snapshot();
  expect(after).toMatchObject({ supported: true, revision: expect.any(String) });
  expect(after).not.toHaveProperty("blocked");
  expect(after).not.toHaveProperty("cachedWhilePending");
  expect(after).not.toHaveProperty("revision", before.revision);
  expect(f.getHistoryState).toHaveBeenCalledTimes(2);
});

it("keeps a slow native read failure private and propagates the same error", async () => {
  const f = nativeHistoryGateway();
  const failure = new Error("synthetic private transcript excerpt");
  f.getHistoryState.mockImplementationOnce(async () => {
    await new Promise(resolve => setTimeout(resolve, 1_050));
    throw failure;
  });

  await expect(f.snapshot()).rejects.toBe(failure);
  const line = await readFile(path.join(directory, "timeline.log.jsonl"), "utf8");
  expect(line).not.toContain(failure.message);
  const event = JSON.parse(line);
  expect(event).toMatchObject({
    type: "engine.event", detail: "history.snapshot", outcome: "error",
    metadata: { source: "gateway.history", turnPending: false, failureCategory: "snapshot_read_failed" },
  });
  expect(event.metadata.durationMs).toBeGreaterThanOrEqual(1_000);
});


it("shares a native read when simultaneous cached snapshots see the same queue drain", async () => {
  const f = nativeHistoryGateway();
  await f.snapshot();
  const readBinding = f.getHistoryBinding.getMockImplementation()!;
  let releaseBindings!: () => void, releaseNative!: () => void;
  const bindingsHeld = new Promise<void>(resolve => { releaseBindings = resolve; });
  const nativeHeld = new Promise<void>(resolve => { releaseNative = resolve; });
  const holdBinding = async () => { await bindingsHeld; return readBinding(); };
  f.getHistoryBinding.mockClear().mockImplementationOnce(holdBinding).mockImplementationOnce(holdBinding);
  const readNative = f.getHistoryState.getMockImplementation()!;
  f.getHistoryState.mockClear().mockImplementationOnce(async () => { await nativeHeld; return readNative("fixture-session", {}); });
  requestLive.mockClear();
  runtime.activeRuns.set(pendingKey, {} as never);
  const first = f.snapshot(), second = f.snapshot();
  try {
    await vi.waitFor(() => expect(f.getHistoryBinding).toHaveBeenCalledTimes(2));
    runtime.activeRuns.delete(pendingKey);
    releaseBindings();
    await vi.waitFor(() => expect(requestLive.mock.calls.length).toBeGreaterThanOrEqual(5));
  } finally {
    releaseBindings();
    releaseNative();
  }
  const results = await Promise.all([first, second]);
  expect(results[0]).toMatchObject({ revision: expect.any(String) });
  expect(results[1]).toEqual(results[0]);
  expect(f.getHistoryState).toHaveBeenCalledTimes(1);
  await f.snapshot();
  expect(f.getHistoryState).toHaveBeenCalledTimes(2);
});

it("rechecks for a new turn during recovery and does not retry a native busy result", async () => {
  const f = nativeHistoryGateway();
  await f.snapshot();
  const readBinding = f.getHistoryBinding.getMockImplementation()!;
  runtime.activeRuns.set(pendingKey, {} as never);
  f.getHistoryBinding.mockImplementationOnce(async () => {
    runtime.activeRuns.delete(pendingKey);
    return readBinding();
  });
  f.getHistoryState.mockImplementationOnce(async () => {
    runtime.activeRuns.set(pendingKey, {} as never);
    return { head: null, blocked: "busy" };
  });
  expect(await f.snapshot()).toMatchObject({ supported: true, blocked: "busy" });
  expect(f.getHistoryState).toHaveBeenCalledTimes(2);

  // A cold read can report a busy native adapter without using the cache.
  const cold = nativeHistoryGateway();
  cold.getHistoryState.mockImplementationOnce(async () => {
    runtime.activeRuns.delete(pendingKey);
    return { head: null, blocked: "busy" };
  });
  expect(await cold.snapshot()).toMatchObject({ supported: true, blocked: "busy" });
  expect(cold.getHistoryState).toHaveBeenCalledOnce();
});
