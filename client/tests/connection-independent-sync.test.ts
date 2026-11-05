import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientCache, Identity } from "../src/storage.js";
import type { Message } from "../../src/client-protocol/index.js";
import { CONVERSATION_SYNC_CAPABILITY, SYNC_LINEAGE_CAPABILITY } from "../../src/client-protocol/snapshot.js";

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

async function connected(independent: boolean, syncLineages: Record<string, string> = {}, lineageCapable = false) {
  const ws = { readyState: 1, onopen: undefined as undefined | (() => void), onmessage: undefined as undefined | ((event: { data: string }) => void), send: vi.fn(), close: vi.fn() };
  io.socket.mockReturnValue(ws);
  const hubPublicKey = Buffer.from("302a300506032b6570032100" + "01".repeat(32), "hex").toString("base64");
  const identity: Identity = { deviceId: "device", name: "Fixture", publicKey: "device-key", hubPublicKey, routes: [] };
  const cache = {
    discardSnapshot: async () => {}, syncResume: async () => ({ cursors: {}, syncLineages }), selectedConversation: async () => "live",
    saveConversations: async () => {}, saveProfiles: async () => {}, outbox: async () => [],
    activeMessages: async () => [], acceptSnapshot: vi.fn(async (frame: { type: string }, _expected?: { lineage?: string }) => frame.type === "snapshot.end"),
    apply: vi.fn(async (event: { payload: Message }, _userId?: string, _expected?: { lineage?: string }) => event.payload), claimNotification: vi.fn(async () => true),
    conversation: vi.fn(async (id: string) => ({ id, title: "Live plan" })),
  };
  const connection = new HubConnection(identity, cache as unknown as ClientCache);
  Reflect.set(connection, "selectRoute", async () => ({ route: { name: "Direct", url: "https://hub.example" }, latency: 1 }));
  Reflect.set(connection, "presence", () => {});
  Reflect.set(connection, "refreshNotificationPreferences", async () => {});
  const receive = async (frame: object) => { ws.onmessage!({ data: JSON.stringify({ v: 1, ...frame }) }); await vi.advanceTimersByTimeAsync(0); };
  await Reflect.get(connection, "connect").call(connection); ws.onopen!(); await vi.advanceTimersByTimeAsync(0);
  await receive({ type: "challenge", nonce: "server-nonce", signature: "server-signature", publicKey: hubPublicKey });
  await receive({ type: "ready", serverCapabilities: [...(independent ? [CONVERSATION_SYNC_CAPABILITY] : []), ...(lineageCapable ? [SYNC_LINEAGE_CAPABILITY] : [])], sessionToken: "token", expiresAt: Date.now() + 900_000,
    user: { id: "owner", name: "Owner", role: "owner" }, bots: [], conversations: ["live", "history"].map(id => ({ id, type: "direct", title: id, ownerId: "owner", botIds: [], archived: false, createdAt: 1 })) });
  expect(connection.state.status).toBe("online"); expect(ws.close).not.toHaveBeenCalled();
  connection.state.notifications = { preferences: { enabled: true, quietStart: "", quietEnd: "", timeZone: "UTC" }, providers: { apns: false, fcm: false, webpush: false, unifiedpush: false } };
  const reply = (conversationId: string, id: string, seq: number) => receive({ type: "event", conversationId, seq, kind: "message.created", at: Date.now(),
    payload: { id, conversationId, authorId: "bot", authorType: "bot", blocks: [{ type: "text", text: id }], status: "complete", version: 1, createdAt: Date.now() } });
  return { connection, cache, receive, reply, ws };
}

it("notifies and publishes a finished conversation while another conversation is replaying", async () => {
  const { connection, cache, receive, reply } = await connected(true);
  await reply("live", "old-live-reply", 1);
  await receive({ type: "sync.conversation", conversationId: "live" });
  await reply("history", "old-history-reply", 1);
  expect(io.notify).not.toHaveBeenCalled(); expect(cache.claimNotification).not.toHaveBeenCalled();
  const changes = vi.fn(); connection.subscribe(changes);
  // No timer advances or unrelated state changes can flush this live event.
  await reply("live", "new-live-reply", 2);
  expect(connection.state.error).toBeUndefined();
  expect(changes).toHaveBeenCalledOnce();
  expect(io.notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ conversationId: "live", messageId: "new-live-reply", kind: "answer", body: "「Live plan」\n回复完成：new-live-reply" }), expect.any(Function));
  expect(cache.claimNotification).toHaveBeenCalledExactlyOnceWith("new-live-reply");
  expect(connection.state.syncProgress).toMatchObject({ completed: 1, total: 2 });
});

it("keeps legacy history notifications suppressed until global sync completes", async () => {
  const { cache, receive, reply } = await connected(false);
  await reply("live", "legacy-history", 1);
  expect(io.notify).not.toHaveBeenCalled(); expect(cache.claimNotification).not.toHaveBeenCalled();
  await receive({ type: "sync.complete" });
  await reply("live", "legacy-live", 2);
  expect(io.notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messageId: "legacy-live" }), expect.any(Function));
});

it("keeps a damaged conversation's outbox pending while healthy conversations remain usable", async () => {
  const {connection,cache,receive,reply,ws}=await connected(true);
  Reflect.set(cache,"outbox",async()=>["history","live"].map((conversationId,order)=>({id:`pending-${conversationId}`,order,
    frame:{v:1,type:"message.send",conversationId,clientMsgId:`pending-${conversationId}`,text:"preserve draft",attachments:[]}})));
  await receive({type:"error",code:"history_metadata_unavailable",conversationId:"history",message:"同步索引不完整，请联系主机管理员恢复。",retryable:false});
  await receive({type:"sync.conversation",conversationId:"live"});
  const sends=ws.send.mock.calls.map(([raw])=>JSON.parse(raw)).filter(frame=>frame.type==="message.send");
  expect(sends).toEqual([expect.objectContaining({conversationId:"live",clientMsgId:"pending-live"})]);
  expect(connection.state.error).toContain("同步索引不完整");
  expect(connection.state.syncProgress).toMatchObject({completed:1,total:2});
  expect(ws.close).not.toHaveBeenCalled();
  await reply("live","healthy-after-error",1);
  expect(cache.apply).toHaveBeenLastCalledWith(expect.objectContaining({conversationId:"live"}),"owner",{lineage:undefined});
});


it("binds received writes to this socket's committed per-conversation lineage", async () => {
  const previous = "00000000-0000-4000-8000-000000000001", restored = "00000000-0000-4000-8000-000000000002";
  const { cache, receive, reply, ws } = await connected(true, { live: previous }, true);
  expect(JSON.parse(ws.send.mock.calls[0]![0])).toMatchObject({ syncLineages: { live: previous } });
  await reply("live", "before", 1);
  expect(cache.apply).toHaveBeenLastCalledWith(expect.any(Object), "owner", { lineage: previous });
  const beforeToken = cache.apply.mock.calls.at(-1)![2];
  const conversation = { id: "live", type: "direct", title: "Live", ownerId: "owner", botIds: [], archived: false, createdAt: 1 };
  await receive({ type: "snapshot.begin", id: "restored", conversation, after: 1, seq: 1, readSeq: 0, lineage: restored });
  expect(cache.acceptSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ lineage: restored }), { lineage: previous });
  await receive({ type: "snapshot.end", id: "restored", count: 0 });
  await reply("live", "after", 2);
  expect(cache.apply).toHaveBeenLastCalledWith(expect.any(Object), "owner", { lineage: restored });
  expect(beforeToken).toEqual({ lineage: previous });
  await reply("history", "other-conversation", 1);
  expect(cache.apply).toHaveBeenLastCalledWith(expect.any(Object), "owner", { lineage: undefined });
});


it.each(["sync_lineage_mismatch", "snapshot_lineage_mismatch"])("reconnects after %s without penalizing the route", async code => {
  const { connection, cache, reply, ws } = await connected(true);
  const failed = vi.spyOn(Reflect.get(connection, "routePerformance"), "failed");
  cache.apply.mockRejectedValueOnce(new Error(code));
  await reply("live", "discarded", 1);
  expect(ws.close).toHaveBeenCalled();
  expect(connection.state.error).toBe("聊天记录已恢复，正在重新同步。");
  Reflect.get(ws, "onclose")({ code: 1006, reason: "" });
  expect(failed).not.toHaveBeenCalled();
});

for (const boundary of ["claim", "title"] as const) it(`rechecks notification consent after the ${boundary} cache wait`, async () => {
  const { connection, cache, receive, reply } = await connected(true);
  await receive({ type: "sync.conversation", conversationId: "live" });
  let release!: () => void;
  if (boundary === "claim") cache.claimNotification.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = () => resolve(true); }));
  else cache.conversation.mockImplementationOnce(() => new Promise<{ id: string; title: string }>(resolve => { release = () => resolve({ id: "live", title: "Private plan" }); }));
  await reply("live", "private-reply", 1);
  expect(release).toBeTypeOf("function"); expect(io.notify).not.toHaveBeenCalled();
  connection.acceptNotificationPreferences({ ...connection.state.notifications!.preferences, enabled: false });
  release(); await vi.advanceTimersByTimeAsync(0);
  expect(io.notify).not.toHaveBeenCalled();
});

it("redacts a desktop reply when previews are hidden during its title read", async () => {
  const { connection, cache, receive, reply } = await connected(true);
  await receive({ type: "sync.conversation", conversationId: "live" });
  let release!: () => void;
  cache.conversation.mockImplementationOnce(() => new Promise<{ id: string; title: string }>(resolve => { release = () => resolve({ id: "live", title: "Private plan" }); }));
  await reply("live", "confidential-reply", 1);
  connection.acceptNotificationPreferences({ ...connection.state.notifications!.preferences, showPreview: false });
  release(); await vi.advanceTimersByTimeAsync(0);
  expect(io.notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ body: "Bot 已完成回复，点按查看。" }), expect.any(Function));
});

it("the pending native send resolves current event, preview and mute choices", async () => {
  const { connection, receive, reply } = await connected(true);
  await receive({ type: "sync.conversation", conversationId: "live" });
  await reply("live", "confidential-reply", 1);
  const resolve = io.notify.mock.calls[0]![1] as () => { body: string } | undefined;
  expect(resolve()?.body).toContain("confidential-reply");
  connection.acceptNotificationPreferences({ ...connection.state.notifications!.preferences, showPreview: false });
  expect(resolve()?.body).toBe("Bot 已完成回复，点按查看。");
  connection.acceptNotificationPreferences({ ...connection.state.notifications!.preferences, replyCompleted: false });
  expect(resolve()).toBeUndefined();
  connection.acceptNotificationPreferences({ ...connection.state.notifications!.preferences, replyCompleted: true });
  connection.state.notifications!.mutedConversations = ["live"];
  expect(resolve()).toBeUndefined();
});
