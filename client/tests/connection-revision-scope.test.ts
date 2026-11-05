import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientCache, Identity, OutboxEntry } from "../src/storage.js";
import type { ClientFrame, Message } from "../../src/client-protocol/index.js";
import { CONVERSATION_SYNC_CAPABILITY } from "../../src/client-protocol/snapshot.js";

// Outbox writes touch only the durable queue. They must refresh the affected
// conversation (receipts fence against cacheRevision) without making every
// other conversation reread its history or directory.
const io = vi.hoisted(() => ({ socket: vi.fn(), notify: vi.fn() }));
vi.mock("../src/storage.js", () => ({ cache: {}, ClientCache: class {}, defaultPreferences: {} }));
vi.mock("../src/identity.js", () => ({ randomNonce: () => "nonce", signChallenge: async () => "signature", verifyHub: async () => {} }));
vi.mock("../src/transport.js", () => ({ hubSocket: io.socket, hubFetch: vi.fn(), usesPinnedTransport: () => false }));
vi.mock("../src/native.js", () => ({ nativePlatform: () => "macos" }));
vi.mock("../src/notifications.js", () => ({ desktopNotification: io.notify }));
vi.mock("../src/share-inbox.js", () => ({ syncShareUploadLimit: async () => {} }));
import { HubConnection } from "../src/connection.js";

beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers();
  io.notify.mockResolvedValue(undefined);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "hidden", hasFocus: () => false }));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const ids = ["live", "history", "c3", "c4", "c5"];

async function connected({ independent = true, complete = true } = {}) {
  const ws = { readyState: 1, onopen: undefined as undefined | (() => void), onmessage: undefined as undefined | ((event: { data: string }) => void), send: vi.fn(), close: vi.fn() };
  io.socket.mockReturnValue(ws);
  const hubPublicKey = Buffer.from("302a300506032b6570032100" + "01".repeat(32), "hex").toString("base64");
  const identity: Identity = { deviceId: "device", name: "Fixture", publicKey: "device-key", hubPublicKey, routes: [] };
  const outbox: OutboxEntry[] = []; let order = 0;
  const frameId = (frame: ClientFrame) => "clientMsgId" in frame ? frame.clientMsgId : "clientActionId" in frame ? frame.clientActionId : "";
  const cache = {
    discardSnapshot: async () => {}, syncResume: async () => ({ cursors: {}, syncLineages: {} }), selectedConversation: async () => "live",
    saveConversations: vi.fn(async () => {}), saveProfiles: async () => {},
    outbox: vi.fn(async () => outbox.map(entry => ({ ...entry }))),
    enqueue: vi.fn(async (frame: ClientFrame) => { outbox.push({ id: frameId(frame), order: ++order, frame } as OutboxEntry); }),
    acknowledge: vi.fn(async (id: string) => { const index = outbox.findIndex(entry => entry.id === id); return index < 0 ? undefined : outbox.splice(index, 1)[0]; }),
    discardFailed: vi.fn(async (id: string) => { const index = outbox.findIndex(entry => entry.id === id && entry.error); return index < 0 ? undefined : outbox.splice(index, 1)[0]; }),
    fail: vi.fn(async (id: string, error: string) => { const entry = outbox.find(item => item.id === id); if (entry) entry.error = error; }),
    apply: vi.fn(async (event: { payload: Message }) => event.payload), claimNotification: vi.fn(async () => true),
  };
  const connection = new HubConnection(identity, cache as unknown as ClientCache);
  Reflect.set(connection, "selectRoute", async () => ({ route: { name: "Direct", url: "https://hub.example" }, latency: 1 }));
  Reflect.set(connection, "presence", () => {});
  Reflect.set(connection, "refreshNotificationPreferences", async () => {});
  const receive = async (frame: object) => { ws.onmessage!({ data: JSON.stringify({ v: 1, ...frame }) }); await vi.advanceTimersByTimeAsync(0); };
  await Reflect.get(connection, "connect").call(connection); ws.onopen!(); await vi.advanceTimersByTimeAsync(0);
  await receive({ type: "challenge", nonce: "server-nonce", signature: "server-signature", publicKey: hubPublicKey });
  await receive({ type: "ready", serverCapabilities: independent ? [CONVERSATION_SYNC_CAPABILITY] : [], sessionToken: "token", expiresAt: Date.now() + 900_000,
    user: { id: "owner", name: "Owner", role: "owner" }, bots: [], conversations: ids.map(id => ({ id, type: "direct", title: id, ownerId: "owner", botIds: [], archived: false, createdAt: 1 })) });
  expect(connection.state.status).toBe("online"); expect(ws.close).not.toHaveBeenCalled();
  if (complete) {
    if (independent) for (const id of ids) await receive({ type: "sync.conversation", conversationId: id });
    await receive({ type: "sync.complete" });
  }
  const reply = (conversationId: string, id: string, seq: number) => receive({ type: "event", conversationId, seq, kind: "message.created", at: Date.now(),
    payload: { id, conversationId, authorId: "bot", authorType: "bot", blocks: [{ type: "text", text: id }], status: "complete", version: 1, createdAt: Date.now() } });
  const revisions = () => Object.fromEntries(ids.map(id => [id, connection.conversationRevision(id)]));
  return { connection, cache, ws, outbox, receive, reply, revisions };
}

const send = (conversationId: string, clientMsgId: string): ClientFrame => ({ v: 1, type: "message.send", clientMsgId, conversationId, text: "hello", attachments: [] });
const others = (before: Record<string, number>, after: Record<string, number>, target: string) =>
  Object.fromEntries(Object.entries(after).filter(([id]) => id !== target).map(([id, value]) => [id, value - before[id]!]));

it("queues and acknowledges a message without invalidating other conversations", async () => {
  const { connection, ws, receive, revisions } = await connected();
  const changes = vi.fn(); connection.subscribe(changes);
  const queueBefore = connection.outboxRevision, before = revisions(), cacheBefore = connection.state.cacheRevision;
  await connection.send(send("live", "client_send_1"));
  // One cache publication per queue mutation; reading/flushing the queue adds none.
  expect(connection.state.cacheRevision - cacheBefore).toBe(1);
  expect(ws.send).toHaveBeenCalledWith(expect.stringContaining("client_send_1"));
  expect(connection.state.outbox).toBe(1);
  expect(connection.outboxRevision).toBe(queueBefore + 1);
  expect(changes).toHaveBeenCalled();
  const queued = revisions();
  // The queued conversation advances so its pending row and history fences refresh.
  expect(queued.live).toBeGreaterThan(before.live!);
  expect(others(before, queued, "live")).toEqual({ history: 0, c3: 0, c4: 0, c5: 0 });

  const receipts: { revision: number; messageAccepted: boolean }[] = [];
  connection.subscribeOutboxSettlement(receipt => receipts.push(receipt));
  const cacheQueued = connection.state.cacheRevision;
  await receive({ type: "message.ack", clientMsgId: "client_send_1" });
  const acknowledged = revisions();
  expect(connection.state.cacheRevision - cacheQueued).toBe(1);
  expect(connection.state.outbox).toBe(0);
  expect(connection.outboxRevision).toBe(queueBefore + 2);
  expect(receipts).toEqual([expect.objectContaining({ messageAccepted: true })]);
  // conversation-outbox clears an ACK receipt only after a read started at a
  // later revision. The acknowledged conversation must therefore advance.
  expect(acknowledged.live).toBeGreaterThan(receipts[0]!.revision);
  expect(connection.state.cacheRevision).toBeGreaterThan(receipts[0]!.revision);
  expect(others(queued, acknowledged, "live")).toEqual({ history: 0, c3: 0, c4: 0, c5: 0 });
});

it("scopes a rejected queued operation and its discard to the owning conversation", async () => {
  const { connection, receive, revisions } = await connected();
  await connection.send(send("history", "client_reject_1"));
  const before = revisions(), queueBefore = connection.outboxRevision;
  await receive({ type: "error", code: "conversation_archived", message: "archived", retryable: false, requestId: "client_reject_1" });
  const failed = revisions();
  expect(connection.outboxRevision).toBe(queueBefore + 1);
  expect(failed.history).toBeGreaterThan(before.history!);
  expect(others(before, failed, "history")).toEqual({ live: 0, c3: 0, c4: 0, c5: 0 });
  await connection.discardFailed("client_reject_1");
  const discarded = revisions();
  expect(connection.state.outbox).toBe(0);
  expect(connection.outboxRevision).toBe(queueBefore + 2);
  expect(others(failed, discarded, "history")).toEqual({ live: 0, c3: 0, c4: 0, c5: 0 });
});

it("synchronizes each conversation independently without a global history invalidation", async () => {
  const { connection, receive, reply, revisions } = await connected({ complete: false });
  const initial = revisions();
  // A committed replay for c3 may be published by the next state transition;
  // conversations without replayed changes must never advance.
  await reply("c3", "c3-replayed", 1);
  for (const id of ids) {
    const before = revisions();
    await receive({ type: "sync.conversation", conversationId: id });
    const after = revisions();
    const unchanged = ids.filter(other => other !== id && other !== "c3");
    expect(Object.fromEntries(unchanged.map(other => [other, after[other]! - before[other]!]))).toEqual(Object.fromEntries(unchanged.map(other => [other, 0])));
  }
  await receive({ type: "sync.complete" });
  const final = revisions();
  expect(final.c3).toBeGreaterThan(initial.c3!);
  // Conversations without replayed changes never reread history during sync.
  expect(others(initial, final, "c3")).toEqual({ live: 0, history: 0, c4: 0, c5: 0 });
  expect(connection.state.syncProgress).toBeUndefined();
});

it("keeps explicit and unknown-scope refreshes global", async () => {
  const { connection, receive, revisions } = await connected();
  let before = revisions();
  connection.refreshCache();
  let after = revisions();
  for (const id of ids) expect(after[id]).toBeGreaterThan(before[id]!);

  before = revisions();
  await receive({ type: "conversation.updated", conversation: { id: "c4", type: "direct", title: "Renamed", ownerId: "owner", botIds: [], archived: false, createdAt: 1 } });
  after = revisions();
  for (const id of ids) expect(after[id]).toBeGreaterThan(before[id]!);

  // A conversation creation has no existing conversation scope.
  before = revisions();
  await connection.send({ v: 1, type: "conversation.create", clientActionId: "create_1", botIds: ["bot"], title: "New" });
  after = revisions();
  for (const id of ids) expect(after[id]).toBeGreaterThan(before[id]!);
});

it("refreshes one conversation for outbox reconciliation", async () => {
  const { connection, revisions } = await connected();
  const before = revisions();
  connection.refreshConversation("c5");
  const after = revisions();
  expect(after.c5).toBeGreaterThan(before.c5!);
  expect(others(before, after, "c5")).toEqual({ live: 0, history: 0, c3: 0, c4: 0 });
});

it("coalesces empty sync markers but releases each ready conversation's queued message immediately", async () => {
  const { connection, ws, receive, reply } = await connected({ complete: false });
  await connection.send(send("c3", "queued-middle-sync"));
  const isQueuedSend = (call: unknown[]) => String(call[0]).includes('"clientMsgId":"queued-middle-sync"');
  expect(ws.send.mock.calls.filter(isQueuedSend)).toHaveLength(0);
  const before = connection.state.cacheRevision, changes = vi.fn(); connection.subscribe(changes);
  await receive({ type: "sync.conversation", conversationId: "live" });
  await receive({ type: "sync.conversation", conversationId: "history" });
  expect(changes).toHaveBeenCalledTimes(1);
  expect(connection.state.cacheRevision).toBe(before);
  expect(connection.state.syncProgress).toEqual({ completed: 1, total: 5 });
  // Pending replay must still publish even when its progress marker is coalesced.
  await reply("c3", "replayed-before-release", 1);
  expect(connection.state.cacheRevision).toBe(before);
  await receive({ type: "sync.conversation", conversationId: "c3" });
  expect(connection.state.cacheRevision).toBe(before + 1);
  expect(ws.send.mock.calls.filter(isQueuedSend)).toHaveLength(1);
  expect(connection.state.syncProgress).toEqual({ completed: 1, total: 5 });
  await receive({ type: "sync.conversation", conversationId: "c4" });
  await receive({ type: "sync.conversation", conversationId: "c5" });
  expect(connection.state.syncProgress).toEqual({ completed: 5, total: 5 });
  await receive({ type: "sync.complete" });
  expect(connection.state.syncProgress).toBeUndefined();
  expect(connection.state.cacheRevision).toBe(before + 1);
  expect(ws.send.mock.calls.filter(isQueuedSend)).toHaveLength(1);
});

it("publishes a short legacy replay at sync.complete without inventing an empty history change", async () => {
  const { connection, receive, reply, revisions } = await connected({ independent: false, complete: false });
  const before = connection.state.cacheRevision, scopedBefore = revisions();
  await reply("c3", "legacy-prefix", 1);
  expect(connection.state.cacheRevision).toBe(before);
  await receive({ type: "sync.complete" });
  expect(connection.state.cacheRevision).toBe(before + 1);
  expect(revisions().c3).toBeGreaterThan(scopedBefore.c3!);
  expect(others(scopedBefore, revisions(), "c3")).toEqual({ live: 0, history: 0, c4: 0, c5: 0 });
});


it.each(["message.created", "message.updated"])("publishes a deletion invalidation when another window already committed %s", async kind => {
  const { connection, cache, receive } = await connected();
  // Real IndexedDB apply() returns undefined when a shared cursor is ahead.
  cache.apply.mockResolvedValueOnce(undefined as never);
  const before = connection.groupDiscussionRevision;
  await receive({ type: "event", conversationId: "live", seq: 1, kind, at: Date.now(),
    payload: { id: "deleted-in-other-window", conversationId: "live", authorId: "bot", authorType: "bot", blocks: [], status: "deleted", version: 2, createdAt: Date.now() } });
  expect(connection.groupDiscussionRevision).toBe(before + 1);
});
