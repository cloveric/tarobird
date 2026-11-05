import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import type { Json } from "../src/client-protocol/index.js";

let root: string, hub: HubServer;
const sockets: WebSocket[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hub-socket-revocation-"));
  hub = await HubServer.start({ stateDir: root });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('fixture','Fixture','fixture')");
});
afterEach(async () => { vi.restoreAllMocks(); sockets.splice(0).forEach((ws) => ws.terminate()); await hub.close(); await rm(root, { recursive: true, force: true }); });
async function connect(deviceId = "source", options: { waitForSync?: boolean; cursors?: Record<string, number>; capabilities?: string[] } = {}) {
  const keys = generateKeyPairSync("ed25519"), nonce = randomBytes(32).toString("base64url");
  const pair = await hub.auth.pair({ deviceId, name: deviceId, platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, deviceId);
  await hub.auth.approve(pair.code, "local-owner");
  const peer = await openPeer(hub.url.replace("http", "ws") + "/ws");
  peer.send({ type: "hello", deviceId, nonce, protocolVersions: [1], capabilities: options.capabilities ?? ["cards.v1"], cursors: options.cursors ?? {} });
  const challenge = await peer.next("challenge");
  peer.send({ type: "auth", signature: sign(null, deviceProof(deviceId, String(challenge.nonce), nonce), keys.privateKey).toString("base64") });
  const ready = await peer.next("ready"); if (options.waitForSync !== false) await peer.next("sync.complete");
  return { ...peer, token: String(ready.sessionToken) };
}
async function openPeer(url: string) {
  const ws = new WebSocket(url); sockets.push(ws);
  const frames: Record<string, Json>[] = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const send = (frame: object) => ws.send(JSON.stringify({ v: 1, ...frame }));
  const next = async (type: string) => { await vi.waitFor(() => expect(frames.some((f) => f.type === type)).toBe(true), { timeout: 3000, interval: 5 }); return frames.splice(frames.findIndex((f) => f.type === type), 1)[0]!; };
  return { ws, send, next, frames };
}
async function connectBot() {
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("UPDATE bots SET secret_hash=? WHERE id='fixture'", [hashSecret(secret)]);
  const bot = await openPeer(hub.instanceUrl.replace("http", "ws") + "/instance");
  bot.send({ type: "instance.hello", botId: "fixture", secret, engine: "codex", model: "", effort: "" }); await bot.next("instance.ready");
  return bot;
}
// Insert revocation ahead of an already-authenticated request's write in the
// real database queue. A check outside the write transaction cannot pass this.
function queuedRevocation(change: () => Promise<unknown> = () => hub.auth.revoke("source", "local-owner")) {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => { release = r; }), waiting = new Promise<void>((r) => { entered = r; });
  let settled: Promise<unknown> | undefined;
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      const blocker = hub.store.db.serial(() => gate);
      const revoke = change();
      const result = operation();
      settled = Promise.allSettled([blocker, revoke, result]); entered();
      return result;
    },
    async finish() { try { await waiting; } finally { release(); } await settled; },
  };
}

it("rejects a message whose device was revoked while its database write waited", async () => {
  const conversation = await hub.store.createConversation("owner", ["fixture"], "Fixture", "fixture");
  const trusted = await connect("trusted");
  const peer = await connect(), race = queuedRevocation(), original = hub.store.sendMessage.bind(hub.store);
  vi.spyOn(hub.store, "sendMessage").mockImplementationOnce((...args) => race.run(() => original(...args)));
  peer.send({ type: "message.send", conversationId: conversation.id, clientMsgId: "late_message", text: "must not trigger the Bot", attachments: [] });
  await race.finish();
  expect(await hub.store.db.get("SELECT 1 FROM messages WHERE client_msg_id='late_message'")).toBeUndefined();
  expect(await hub.store.pendingForBot("fixture")).toEqual([]);
  await vi.waitFor(async () => expect(await hub.store.db.get("SELECT 1 FROM audit_log WHERE kind='request.rejected' AND actor='source'")).toBeDefined());
  const valid = { type: "message.send", conversationId: conversation.id, clientMsgId: "trusted_message", text: "still allowed", attachments: [] };
  trusted.send(valid); await trusted.next("message.ack"); trusted.send(valid); await trusted.next("message.ack");
  expect(await hub.store.pendingForBot("fixture")).toHaveLength(1);
});

it("does not queue a card approval after its device loses trust in the write queue", async () => {
  const conversation = await hub.store.createConversation("owner", ["fixture"], "Fixture", "fixture");
  const message = await hub.store.publishBotMessage("fixture", { conversationId: conversation.id, blocks: [{ type: "card", elements: [{ type: "button", actionId: "approve", text: "Approve" }] }] });
  const peer = await connect(), race = queuedRevocation(), original = hub.store.enqueueAction.bind(hub.store);
  vi.spyOn(hub.store, "enqueueAction").mockImplementationOnce((...args) => race.run(() => original(...args)));
  peer.send({ type: "interaction.submit", conversationId: conversation.id, messageId: message.id, actionId: "approve", clientActionId: "late_approval", values: {} });
  await race.finish();
  expect(await hub.store.db.get("SELECT 1 FROM actions WHERE client_action_id='late_approval'")).toBeUndefined();
  expect(await hub.store.pendingActions("fixture")).toEqual([]);
  await vi.waitFor(async () => expect(await hub.store.db.get("SELECT 1 FROM audit_log WHERE kind='request.rejected' AND actor='source'")).toBeDefined());
});

it.each(["conversation.create", "topic.create"])("rejects queued %s after revocation", async (type) => {
  const group = await hub.store.createConversation("owner", ["fixture"], "Group", "group", { type: "group" });
  const peer = await connect(), race = queuedRevocation(), original = hub.store.createConversation.bind(hub.store);
  vi.spyOn(hub.store, "createConversation").mockImplementationOnce((...args) => race.run(() => original(...args)));
  peer.send({ type, clientActionId: "late_create", title: "Late", ...(type === "topic.create" ? { groupId: group.id } : { botIds: ["fixture"], conversationType: "direct" }) });
  await race.finish();
  expect(await hub.store.conversations("owner")).toHaveLength(1);
});

it.each(["conversation.rename", "conversation.archive", "conversation.bind"])("rejects queued %s after revocation", async (type) => {
  const conversation = await hub.store.createConversation("owner", ["fixture"], "Original", "fixture");
  const bound = await hub.store.updateConversation("owner", conversation.id, { sessionId: "native_session" });
  const peer = await connect(), race = queuedRevocation(), original = hub.store.updateConversation.bind(hub.store);
  vi.spyOn(hub.store, "updateConversation").mockImplementationOnce((...args) => race.run(() => original(...args)));
  peer.send({ type, conversationId: conversation.id, ...(type === "conversation.rename" ? { title: "Replaced" } : type === "conversation.archive" ? { archived: true } : { sessionId: null, expectedBindingId: bound.bindingId }) });
  await race.finish();
  expect((await hub.store.conversations("owner"))[0]).toEqual(bound);
});

it("rejects queued read marks after revocation", async () => {
  const conversation = await hub.store.createConversation("owner", ["fixture"], "Fixture", "fixture");
  await hub.store.publishBotMessage("fixture", { conversationId: conversation.id, blocks: [{ type: "text", text: "Unread" }] });
  const peer = await connect(), race = queuedRevocation(), original = hub.store.markRead.bind(hub.store);
  vi.spyOn(hub.store, "markRead").mockImplementationOnce((...args) => race.run(() => original(...args)));
  peer.send({ type: "read.mark", conversationId: conversation.id, seq: 1 }); await race.finish();
  expect(await hub.store.db.get("SELECT 1 FROM reads")).toBeUndefined();
});

it("rejects forwarding before cloning its attachments or queuing Bot delivery", async () => {
  const conversation = await hub.store.createConversation("owner", ["fixture"], "Fixture", "fixture");
  const target = await hub.store.createConversation("owner", ["fixture"], "Target", "target");
  const bytes = Buffer.from("private attachment"), sha256 = createHash("sha256").update(bytes).digest("hex");
  const attachmentId = await hub.attachments.importForBot("fixture", { conversationId: conversation.id, name: "fixture.txt", mime: "text/plain", size: bytes.length, sha256 }, bytes);
  const source = await hub.store.publishBotMessage("fixture", { conversationId: conversation.id, blocks: [{ type: "text", text: "Private original" }, { type: "file", attachmentId, name: "fixture.txt", size: bytes.length, mime: "text/plain" }] });
  const before = await readdir(hub.attachments.directory);
  const peer = await connect(), race = queuedRevocation(), original = hub.store.forwardMessage.bind(hub.store);
  vi.spyOn(hub.store, "forwardMessage").mockImplementationOnce((...args) => race.run(() => original(...args)));
  peer.send({ type: "message.forward", conversationId: target.id, clientMsgId: "late_forward", sourceMessageId: source.id, mentions: ["fixture"] }); await race.finish();
  expect(await hub.store.db.get("SELECT 1 FROM messages WHERE client_msg_id='late_forward'")).toBeUndefined();
  expect(await hub.store.pendingForBot("fixture")).toEqual([]); expect(await readdir(hub.attachments.directory)).toEqual(before);
});

it("rejects an approval when conversation membership disappears before its transaction", async () => {
  const conversation = await hub.store.createConversation("owner", ["fixture"], "Fixture", "fixture");
  const message = await hub.store.publishBotMessage("fixture", { conversationId: conversation.id, blocks: [{ type: "card", elements: [{ type: "button", actionId: "approve", text: "Approve" }] }] });
  const peer = await connect(), race = queuedRevocation(() => hub.store.db.serial(() => hub.store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='user'", [conversation.id])));
  const original = hub.store.enqueueAction.bind(hub.store);
  vi.spyOn(hub.store, "enqueueAction").mockImplementationOnce((...args) => race.run(() => original(...args)));
  peer.send({ type: "interaction.submit", conversationId: conversation.id, messageId: message.id, actionId: "approve", clientActionId: "late_approval", values: {} }); await race.finish();
  expect(await peer.next("error")).toMatchObject({ code: "conversation_forbidden" });
  expect(await hub.store.pendingActions("fixture")).toEqual([]);
});

it("does not return a private Bot RPC result after external revocation", async () => {
  const bot = await connectBot();
  const peer = await connect();
  peer.send({ type: "command.complete", botId: "fixture", query: "/private" });
  const call = await bot.next("instance.call");
  await hub.store.db.serial(() => hub.store.db.run("UPDATE devices SET revoked=1 WHERE id='source'"));
  bot.send({ type: "instance.result", id: call.id, result: ["PRIVATE_FIXTURE_RESULT"] });
  await vi.waitFor(() => expect(peer.frames.some((frame) => frame.type === "command.completions") || peer.ws.readyState !== WebSocket.OPEN).toBe(true), { timeout: 2000, interval: 5 });
  expect(peer.frames.some((frame) => frame.type === "command.completions")).toBe(false);
  expect(JSON.stringify(peer.frames)).not.toContain("PRIVATE_FIXTURE_RESULT");
});

it("rejects expiration that occurs after initial frame authentication and before its write", async () => {
  const conversation = await hub.store.createConversation("owner", ["fixture"], "Fixture", "fixture");
  const peer = await connect();
  let session: Parameters<typeof hub.auth.validateSession>[0] | undefined;
  const validate = hub.auth.validateSession.bind(hub.auth);
  vi.spyOn(hub.auth, "validateSession").mockImplementation(async (value) => { const device = await validate(value); session = value; return device; });
  const race = queuedRevocation(() => hub.store.db.serial(async () => { session!.expiresAt = 0; })), original = hub.store.sendMessage.bind(hub.store);
  vi.spyOn(hub.store, "sendMessage").mockImplementationOnce((...args) => race.run(() => original(...args)));
  peer.send({ type: "message.send", conversationId: conversation.id, clientMsgId: "expired_message", text: "expired", attachments: [] }); await race.finish();
  expect(await hub.store.pendingForBot("fixture")).toEqual([]);
  expect(await peer.next("notice")).toMatchObject({ code: "session_expired" });
});

it("filters an externally revoked subscriber before broadcasting newly committed events", async () => {
  const conversation = await hub.store.createConversation("owner", ["fixture"], "Fixture", "fixture");
  const peer = await connect(), trusted = await connect("trusted");
  await hub.store.db.serial(() => hub.store.db.run("UPDATE devices SET revoked=1 WHERE id='source'"));
  const message = await hub.store.publishBotMessage("fixture", { conversationId: conversation.id, blocks: [{ type: "text", text: "PRIVATE_NEW_EVENT" }] });
  expect(await trusted.next("event")).toMatchObject({ payload: { id: message.id } });
  expect(await peer.next("notice")).toMatchObject({ code: "device_revoked" });
  expect(JSON.stringify(peer.frames)).not.toContain("PRIVATE_NEW_EVENT");
});

it.each(["events", "snapshot"])("rechecks trust before releasing a delayed %s history page", async (mode) => {
  const conversation = await hub.store.createConversation("owner", ["fixture"], "Fixture", "fixture");
  await hub.store.publishBotMessage("fixture", { conversationId: conversation.id, blocks: [{ type: "text", text: "PRIVATE_HISTORY_PAGE" }] });
  const revoke = () => hub.store.db.serial(() => hub.store.db.run("UPDATE devices SET revoked=1 WHERE id='source'"));
  if (mode === "events") {
    const sync = hub.store.sync.bind(hub.store);
    vi.spyOn(hub.store, "sync").mockImplementationOnce(async (...args) => { const page = await sync(...args); await revoke(); return page; });
  } else {
    const frames = hub.store.snapshotFrames.bind(hub.store);
    vi.spyOn(hub.store, "snapshotFrames").mockImplementationOnce(async function* (...args) {
      for await (const frame of frames(...args)) { if (frame.type === "snapshot.message") await revoke(); yield frame; }
    });
  }
  const peer = await connect("source", { waitForSync: false, ...(mode === "snapshot" ? { capabilities: ["cards.v1", "snapshot.v1"], cursors: { [conversation.id]: 999 } } : {}) });
  expect(await peer.next("notice")).toMatchObject({ code: "device_revoked" });
  expect(JSON.stringify(peer.frames)).not.toContain("PRIVATE_HISTORY_PAGE");
  expect(peer.frames.some((frame) => frame.type === "sync.complete")).toBe(false);
});

it("does not dispatch a stop after the request loses device trust while reading its target", async () => {
  const conversation = await hub.store.createConversation("owner", ["fixture"], "Fixture", "fixture");
  const bot = await connectBot(), peer = await connect(), conversations = hub.store.conversations.bind(hub.store);
  vi.spyOn(hub.store, "conversations").mockImplementationOnce(async (...args) => {
    const values = await conversations(...args);
    await hub.auth.revoke("source", "local-owner");
    return values;
  });
  peer.send({ type: "turn.stop", conversationId: conversation.id });
  expect(await peer.next("notice")).toMatchObject({ code: "device_revoked" });
  await vi.waitFor(async () => expect(await hub.store.db.get("SELECT 1 FROM audit_log WHERE kind='request.rejected' AND actor='source'")).toBeDefined());
  expect(bot.frames.some((frame) => frame.type === "instance.call" && frame.method === "stop")).toBe(false);
});

it.each(["creation", "steering"])("guards the shared %s transaction when entered from HTTP", async (kind) => {
  const conversation = await hub.store.createConversation("owner", ["fixture"], "Fixture", "fixture");
  const peer = await connect(), race = queuedRevocation();
  if (kind === "creation") {
    const original = hub.store.createConversation.bind(hub.store);
    vi.spyOn(hub.store, "createConversation").mockImplementationOnce((...args) => race.run(() => original(...args)));
  } else {
    const original = hub.store.beginSteeringRecord.bind(hub.store);
    vi.spyOn(hub.store, "beginSteeringRecord").mockImplementationOnce((...args) => race.run(() => original(...args)));
  }
  const route = kind === "creation" ? "/api/conversations" : `/api/conversations/${conversation.id}/steer`;
  const body = kind === "creation" ? { v: 1, type: "conversation.create", title: "Late", botIds: ["fixture"], clientActionId: "late_create", conversationType: "direct" } : { botId: "fixture", requestId: "late_steer", targetId: "target", text: "Must not steer" };
  const pending = fetch(hub.url + route, { method: "POST", headers: { Authorization: `Bearer ${peer.token}` }, body: JSON.stringify(body) });
  await race.finish(); const response = await pending;
  expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "device_revoked" });
  expect(await hub.store.conversations("owner")).toHaveLength(1);
  expect(await hub.store.db.get("SELECT 1 FROM messages WHERE client_msg_id='late_steer'")).toBeUndefined();
});
