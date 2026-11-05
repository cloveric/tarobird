import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { BotMessages, messageHostId } from "../src/hub/bot-messages.js";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import WebSocket from "ws";
import { nodeFrameReader } from "../src/client-protocol/fragments-node.js";
import { CONVERSATION_SYNC_CAPABILITY } from "../src/client-protocol/snapshot.js";
import { bootstrapTrusted } from "./helpers/pairing-invite.js";
import { networkId } from "../src/hub/private-network.js";
import { networkCanonical, networkManifestSchema } from "../src/client-protocol/private-network.js";
import { parseBotDestination, resolveBotTarget, type BotLocalRequest, type BotPassport } from "../src/client-protocol/bot-messages.js";
import { HubPromptQueue } from "../src/hub/prompt-queue.js";
import { HubMaintenance } from "../src/hub/maintenance.js";

let root: string, a: HubServer, b: HubServer, source: BotMessages;
const guard = async () => undefined;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bot-messages-"));
  a = await HubServer.start({ stateDir: path.join(root, "a") }); b = await HubServer.start({ stateDir: path.join(root, "b") });
  await a.profile.update({ name: "Mac", revision: 0 }); await b.profile.update({ name: "Windows", revision: 0 });
  for (const hub of [a, b]) for (const [id, name] of [["source", "Source"], ["target", "Target"]]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES(?,?,?,'codex')", [id!, name!, hashSecret("test-".repeat(10))]);
  const nonce = randomBytes(32).toString("base64url");
  const manifest = networkManifestSchema.parse({ v: 2, id: networkId(a.auth.publicKey, nonce), name: "Test", authorityKey: a.auth.publicKey, genesisNonce: nonce, revision: 1,
    hosts: [a, b].map((hub, index) => ({ publicKey: hub.auth.publicKey, name: index ? "Windows" : "Mac", routes: [], protocol: 2, state: "active", revoked: false })), devices: [], revokedMembers: [], blockedBindings: [] });
  const membership = { manifest, signature: a.auth.signNetworkManifest(manifest) };
  for (const hub of [a, b]) await hub.store.db.run("INSERT INTO meta(key,value) VALUES('private-network:v1',?)", [JSON.stringify({ v: 1, routes: [], membership, imported: {}, revokedMembers: [], revokedHosts: [], retiredNetworks: [], admissions: [], peers: [], proofs: [], intents: {}, lastSyncedAt: Date.now(), waiting: false })]);
  // Transport is in-process here; TLS/no-resend is exercised separately.
  source = new BotMessages(a.store, a.auth, a.network, a.attachments, async (_host, signed, body) => b.botMessages.receive(signed, signed.passport.method, signed.passport.path, body));
  await b.botMessages.grant({ sourceHost: "Mac", sourceBot: "source", targetBot: "target" }, guard);
});
afterEach(async () => { vi.restoreAllMocks(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); });
const input = (operation: BotLocalRequest["operation"], data: Record<string, unknown> = {}, conversation?: string, requestId = randomUUID()): BotLocalRequest => ({ operation, host: "Windows", bot: "target", requestId, data, ...(conversation ? { conversation } : {}) });
const call = (request: BotLocalRequest) => source.local(request, "source", guard, true) as Promise<any>;
const target = async () => call(input("resolve"));
const send = async (conversation: string, text = "Task", requestId = randomUUID(), attachments: string[] = []) => call(input("send", { text, attachments }, conversation, requestId));

it("rejects invalid passports before reading bodies and isolates their rate bucket from network sync", async () => {
  const malformed = await fetch(`${b.url}/api/bot-messages/send`, { method: "POST", headers: { "x-tarobot-message-passport": "invalid" }, body: "{}" });
  expect(malformed.status).toBe(403);
  const body = Buffer.from("{}"), passport: BotPassport = { v: 1, sourceKey: a.auth.publicKey, targetKey: b.auth.publicKey,
    source: { hostId: messageHostId(a.auth.publicKey), hostName: "Mac", botId: "source", botName: "Source", hops: 1, requestId: "headers" },
    targetBot: "target", method: "POST", path: "/api/bot-messages/send", digest: createHash("sha256").update(body).digest("hex"), expiresAt: Date.now() + 30000, nonce: "nonce" };
  const header = Buffer.from(JSON.stringify({ passport, signature: b.auth.signBotPassport(passport) })).toString("base64url");
  let finishedBody = false;
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(`${b.url}${passport.path}`, { method: "POST", headers: { "x-tarobot-message-passport": header, "content-length": "2" } }, res => {
      clearTimeout(timer); res.resume(); resolve(res.statusCode!); req.destroy();
    });
    req.on("error", reject); req.write("{");
    const timer = setTimeout(() => { finishedBody = true; req.end("}"); }, 400);
  });
  expect(status).toBe(403); expect(finishedBody).toBe(false);
  for (let i = 0; i < 70; i++) await fetch(`${b.url}/api/bot-messages/send`, { method: "POST", headers: { "x-tarobot-message-passport": "invalid" }, body: "{}" });
  // An invalid network peer body is a 400, never a consumed Bot-message 429.
  const peer = await fetch(`${b.url}/api/network/peer`, { method: "POST", body: "{}" });
  expect(peer.status).toBe(400);
});

it("retains the full allowed text size even when JSON escaping expands its wire body", async () => {
  const chat = await target();
  vi.spyOn(source, "exchange").mockImplementation(async (_host, signed, body) => {
    expect(body.length).toBeGreaterThan(1024 * 1024);
    const response = await fetch(b.url + signed.passport.path, { method: signed.passport.method, headers: { "x-tarobot-message-passport": Buffer.from(JSON.stringify(signed)).toString("base64url") }, body });
    expect(response.status).toBe(200);
    return (await response.json() as any).result;
  });
  const text = "\u0000".repeat(200 * 1024);
  const receipt = await send(chat.conversationId, text);
  expect((await b.store.messageForUser("owner", receipt.messageId)).blocks).toEqual([{ type: "text", text }]);
});

it("resolves exact unique names and stable IDs, reports missing/ambiguous candidates, and parses escaped slashes", () => {
  const candidates = [{ id: "one", name: "Same" }, { id: "two", name: "Same" }, { id: "three", name: "Unique" }];
  expect(resolveBotTarget("Unique", candidates, "bot").id).toBe("three");
  expect(resolveBotTarget("one", candidates, "bot").id).toBe("one");
  expect(() => resolveBotTarget("Same", candidates, "bot")).toThrow('"target_ambiguous"');
  expect(() => resolveBotTarget("missing", candidates, "bot")).toThrow('"candidates"');
  candidates[0]!.name = "Renamed"; expect(resolveBotTarget("one", candidates, "bot").name).toBe("Renamed");
  expect(parseBotDestination("Mac/Bot/Design%2FReview")).toEqual({ host: "Mac", bot: "Bot", conversation: "Design/Review" });
});

it("isolates default collaboration chats by caller, preserves renamed IDs and lists activity", async () => {
  const user = await b.store.createConversation("owner", ["target"], "User chat", "user");
  const first = await target(), second = await target(); expect(first.conversationId).toBe(second.conversationId); expect(first.conversationId).not.toBe(user.id);
  await b.botMessages.grant({ sourceHost: "Mac", sourceBot: "target", targetBot: "target" }, guard);
  const other: any = await source.local(input("resolve"), "target", guard, true); expect(other.conversationId).not.toBe(first.conversationId);
  await b.store.db.run("UPDATE conversations SET title='Renamed' WHERE id=?", [first.conversationId]);
  expect((await send(first.conversationId)).conversationId).toBe(first.conversationId);
  const list = await call(input("list")); expect(list.conversations.find((c: any) => c.id === first.conversationId)).toMatchObject({ name: "Renamed", lastActivityAt: expect.any(Number) });
  await b.store.createConversation("owner", ["target"], "Renamed", "duplicate");
  await expect(call(input("resolve", {}, "Renamed"))).rejects.toThrow("target_ambiguous");
  await expect(call(input("resolve", {}, "absent"))).rejects.toThrow("target_not_found");
});

it("never enumerates or resolves another user's private conversations through a Bot grant", async () => {
  await b.store.db.run("INSERT INTO users VALUES('member','Member','member')");
  await b.store.db.run("INSERT INTO bot_grants VALUES('member','target')");
  const privateChat = await b.store.createConversation("member", ["target"], "Private member chat", "member-chat");
  expect((await call(input("list"))).conversations.some((c: any) => c.id === privateChat.id)).toBe(false);
  await expect(call(input("resolve", {}, privateChat.id))).rejects.toThrow("target_not_found");
  await expect(send(privateChat.id)).rejects.toThrow("target_not_found");
});

it("bounds new collaboration conversation creation without blocking idempotent replay", async () => {
  const request = input("resolve", { newConversation: "New chat" });
  const first = await call(request);
  for (let i = 1; i < 10; i++) await call(input("resolve", { newConversation: `Chat ${i}` }));
  await expect(call(input("resolve", { newConversation: "One too many" }))).rejects.toThrow("bot_message_rate_limit");
  expect(await call(request)).toMatchObject({ conversationId: first.conversationId });
  expect(await b.store.db.all("SELECT id FROM conversations")).toHaveLength(10);
});

it.each([{ hostId: "../escape" }, { hostId: "hub_another_host" }, { botId: "../escape" }, { conversationId: "../escape" }])("rejects peer resolution metadata that redirects the resolved identity: %j", async invalid => {
  const chat = await target();
  vi.spyOn(source, "exchange").mockResolvedValue({ ...chat, ...invalid });
  await expect(target()).rejects.toThrow();
});

it("appends to the existing durable queue and never overtakes a running task", async () => {
  const chat = await target(), queue = new HubPromptQueue(b.store); await queue.registerWorker("target", true);
  const first = await b.store.sendMessage("owner", { conversationId: chat.conversationId, clientMsgId: "user", text: "Running", attachments: [] });
  expect((await queue.claim("target", true, false)).map(m => m.id)).toEqual([first.message.id]);
  const message = await send(chat.conversationId);
  expect(await queue.claim("target", true, false)).toEqual([]);
  await b.store.acknowledgeDelivery("target", first.message.id);
  const claimed = await queue.claim("target", true, false); expect(claimed.map(m => m.id)).toEqual([message.messageId]);
  expect(claimed[0]!.botSource).toMatchObject({ hostId: messageHostId(a.auth.publicKey), hostName: "Mac", botId: "source", hops: 1 });
});

it("fails unsupported Bot-origin inputs without blocking later owner messages", async () => {
  const chat = await target(), queue = new HubPromptQueue(b.store);
  const remote = await send(chat.conversationId);
  const own = await b.store.sendMessage("owner", { conversationId: chat.conversationId, clientMsgId: "owner-next", text: "Owner task", attachments: [] });
  expect((await queue.claim("target", true, false, () => true, false)).map(m => m.id)).toEqual([own.message.id]);
  expect(await b.store.db.get("SELECT status FROM deliveries WHERE message_id=?", [remote.messageId])).toEqual({ status: "failed" });
  expect(await call(input("wait", { messageId: remote.messageId }, chat.conversationId))).toMatchObject({ status: "failed" });
  expect(await b.store.db.all("SELECT * FROM audit_log WHERE kind='bot-message.worker-unsupported'")).toHaveLength(1);
});

it("refuses fresh sends to connected old workers before admission but preserves an accepted receipt", async () => {
  const chat = await target(), request = input("send", { text: "Once", attachments: [] }, chat.conversationId);
  const accepted = await call(request);
  const receiver = new BotMessages(b.store, b.auth, b.network, b.attachments, undefined, () => false);
  vi.spyOn(source, "exchange").mockImplementation(async (_host, signed, body) => receiver.receive(signed, signed.passport.method, signed.passport.path, body));
  await expect(send(chat.conversationId)).rejects.toThrow("bot_message_worker_update_required");
  expect(await call(request)).toMatchObject({ messageId: accepted.messageId, duplicate: true });
  expect(await b.store.db.all("SELECT * FROM deliveries")).toHaveLength(1);
});

it.each(["/stop", "  /approve yes", "/ask Bot task", "/q new", "/reset", "/verify task"])("rejects control input %s before queue admission", async text => {
  const chat = await target(); await expect(send(chat.conversationId, text)).rejects.toThrow("bot_message_control_forbidden");
  expect(await b.store.db.all("SELECT * FROM deliveries")).toHaveLength(0);
});

it("deduplicates identical requests, rejects changed content, and never retries a lost delivery response", async () => {
  const chat = await target(), request = input("send", { text: "Once", attachments: [] }, chat.conversationId, "same_request");
  const exchange = vi.fn(async (_host, signed, body) => { await b.botMessages.receive(signed, signed.passport.method, signed.passport.path, body); throw new Error("disconnected"); });
  const uncertain = new BotMessages(a.store, a.auth, a.network, a.attachments, exchange);
  await expect(uncertain.local(request, "source", guard, true)).rejects.toThrow("disconnected"); expect(exchange).toHaveBeenCalledTimes(1);
  const receipt = await call(request); expect(receipt.duplicate).toBe(true);
  await expect(call({ ...request, data: { text: "Changed", attachments: [] } })).rejects.toThrow("bot_message_request_conflict");
  expect(await b.store.db.all("SELECT * FROM deliveries")).toHaveLength(1);
  const kinds = await b.store.db.all<{ kind: string }>("SELECT kind FROM audit_log"); expect(kinds.filter(k => k.kind === "bot-message.send")).toHaveLength(2);
});

it("uploads through the shared upload API, returns only correlated reply text/files, and enforces grant revocation", async () => {
  const chat = await target(), bytes = Buffer.from("file content"), sha256 = createHash("sha256").update(bytes).digest("hex");
  const upload = await call(input("upload", { name: "data.txt", mime: "text/plain", size: bytes.length, sha256 }, chat.conversationId));
  await call(input("chunk", { uploadId: upload.id, index: 0, bytes: bytes.toString("base64") }, chat.conversationId));
  await call(input("complete", { uploadId: upload.id }, chat.conversationId));
  const receipt = await send(chat.conversationId, "Read attachment", randomUUID(), [upload.id]);
  expect((await b.store.messageForBot("target", receipt.messageId)).blocks[1]).toMatchObject({ type: "file", attachmentId: upload.id });
  await b.store.publishBotMessage("target", { conversationId: chat.conversationId, blocks: [{ type: "text", text: "Unrelated" }] });
  await b.store.publishBotMessage("target", { conversationId: chat.conversationId, replyTo: receipt.messageId, blocks: [{ type: "text", text: "Answer" }, { type: "file", attachmentId: upload.id, name: "data.txt", mime: "text/plain", size: bytes.length }] });
  expect((await call(input("wait", { messageId: receipt.messageId }, chat.conversationId))).status).toBe("pending");
  await b.store.acknowledgeDelivery("target", receipt.messageId);
  const reply = await call(input("wait", { messageId: receipt.messageId }, chat.conversationId)); expect(reply).toMatchObject({ status: "completed", text: expect.stringContaining("Answer"), files: [{ id: upload.id, sha256 }] }); expect(reply.text).not.toContain("Unrelated");
  const file = await call(input("download", { messageId: receipt.messageId, attachmentId: upload.id, offset: 0 }, chat.conversationId)); expect(Buffer.from(file.bytes, "base64")).toEqual(bytes);
  await b.botMessages.grant({ sourceHost: "Mac", sourceBot: "source", targetBot: "target", revoke: true }, guard);
  await expect(send(chat.conversationId)).rejects.toThrow("authorized_or_revoked");
  await expect(call(input("wait", { messageId: receipt.messageId }, chat.conversationId))).rejects.toThrow("authorized_or_revoked");
  expect(await b.store.db.all("SELECT * FROM audit_log WHERE kind='bot-message.wait'")).toHaveLength(2);
});

it("keeps waiting while the target's bound background work still replies to the same input", async () => {
  const chat = await target(), receipt = await send(chat.conversationId, "Analyse in the background");
  const run = (phase: string) => ({ version: 1, id: "run_background", revision: phase === "working" ? 1 : 2, phase, startedAt: 1, updatedAt: 2, count: 1, completed: phase === "working" ? 0 : 1, failed: 0, truncated: false });
  // Background process cards always carry a complete envelope; only the run phase is live.
  const card = (phase: string, text: string) => [{ type: "card" as const, elements: [{ type: "markdown" as const, text }], extra: { scopedRun: run(phase) } }];
  const wait = () => call(input("wait", { messageId: receipt.messageId }, chat.conversationId));
  await b.store.publishBotMessage("target", { conversationId: chat.conversationId, replyTo: receipt.messageId, blocks: [{ type: "text", text: "Started a background agent" }] });
  const background = await b.store.publishBotMessage("target", { conversationId: chat.conversationId, replyTo: receipt.messageId, status: "complete", blocks: card("working", "Background task running") });
  await b.store.acknowledgeDelivery("target", receipt.messageId);
  expect(await wait()).toMatchObject({ status: "pending", activeReplies: 1, text: expect.stringContaining("Started a background agent") });
  await b.store.publishBotMessage("target", { id: background.id, conversationId: chat.conversationId, status: "complete", blocks: card("done", "Final background report") });
  const done = await wait();
  expect(done).toMatchObject({ status: "completed", text: expect.stringContaining("Final background report") });
  expect(done).not.toHaveProperty("activeReplies");

  // A failed reply waits for still-running work before reporting failure.
  const second = await send(chat.conversationId, "Second task");
  await b.store.publishBotMessage("target", { conversationId: chat.conversationId, replyTo: second.messageId, status: "error", blocks: [{ type: "text", text: "Foreground failed" }] });
  const running = await b.store.publishBotMessage("target", { conversationId: chat.conversationId, replyTo: second.messageId, status: "streaming", blocks: [{ type: "text", text: "Still delivering" }] });
  await b.store.acknowledgeDelivery("target", second.messageId);
  const waitSecond = () => call(input("wait", { messageId: second.messageId }, chat.conversationId));
  expect(await waitSecond()).toMatchObject({ status: "pending", activeReplies: 1 });
  await b.store.publishBotMessage("target", { id: running.id, conversationId: chat.conversationId, status: "complete", blocks: [{ type: "text", text: "Delivered" }] });
  expect(await waitSecond()).toMatchObject({ status: "failed", text: expect.stringContaining("Foreground failed") });
});

it("reclaims only explicitly unused upload permits after physical attachment GC", async () => {
  const chat = await target(), bytes = Buffer.from("abandoned upload"), sha256 = createHash("sha256").update(bytes).digest("hex");
  const upload = await call(input("upload", { name: "abandoned.txt", mime: "text/plain", size: bytes.length, sha256 }, chat.conversationId));
  const permits = () => b.store.db.all<{ key: string; value: string }>("SELECT key,value FROM meta WHERE key>='bot-messages:upload:' AND key<'bot-messages:upload;'");
  expect(await permits()).toHaveLength(1);
  await b.store.db.run("UPDATE attachments SET created_at=0 WHERE id=?", [upload.id]);
  expect(await new HubMaintenance(b.store, path.join(root, "b")).collectOrphans()).toBe(1);
  expect(await permits()).toHaveLength(0);
  await expect(call(input("chunk", { uploadId: upload.id, index: 0, bytes: bytes.toString("base64") }, chat.conversationId))).rejects.toThrow("bot_message_upload_forbidden");
});

it.each(["current BotMessages", "schema19-compatible direct writer"])("keeps original receipts through re-upload, personal deletion, shared tombstones and physical GC with %s", async (writer) => {
  const chat = await target(), bytes = Buffer.from("used upload"), sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = { name: "used.txt", mime: "text/plain", size: bytes.length, sha256 };
  const uploaded = await call(input("upload", file, chat.conversationId));
  await call(input("chunk", { uploadId: uploaded.id, index: 0, bytes: bytes.toString("base64") }, chat.conversationId));
  await call(input("complete", { uploadId: uploaded.id }, chat.conversationId));
  const request = input("send", { text: "File task", attachments: [uploaded.id] }, chat.conversationId);
  if (writer === "schema19-compatible direct writer") {
    await b.close(); b = await HubServer.start({ stateDir: path.join(root, "b") });
    expect(await b.store.db.get("SELECT value FROM meta WHERE key='schema_version'")).toEqual({ value: "25" });
    // Simulate an older receiver that writes only the original meta receipt
    // and ordinary message tables. It knows nothing about permit tracking and
    // consumes the existing upload directly, without another upload-init.
    vi.spyOn(source, "exchange").mockImplementationOnce(async (_host, signed) => {
      const p = signed.passport;
      await b.botMessages.authorizePassport(signed, p.method, p.path);
      const key = `bot-messages:incoming:${hashSecret(JSON.stringify([p.sourceKey, p.source.botId, p.source.requestId]))}`;
      const data = { text: "File task", attachments: [uploaded.id] };
      const content = hashSecret(networkCanonical({ bot: "target", conversation: chat.conversationId, ...data }));
      const result = await b.store.sendMessage("owner", { ...data, conversationId: chat.conversationId, clientMsgId: `bm_${hashSecret(key)}`,
        mentions: ["target"], botSource: p.source, previewUrl: null }, async () => {
        await b.store.db.run("INSERT INTO meta(key,value) VALUES(?,?)", [key, JSON.stringify({ content, at: Date.now() })]);
      });
      return { ...chat, messageId: result.message.id, requestId: p.source.requestId, duplicate: result.duplicate, status: "queued" };
    });
  }
  const original = await call(request);
  if (writer === "schema19-compatible direct writer") vi.restoreAllMocks();
  const permits = () => b.store.db.all<{ key: string; value: string }>("SELECT key,value FROM meta WHERE key>='bot-messages:upload:' AND key<'bot-messages:upload;'");
  expect(Object.keys(JSON.parse((await permits())[0]!.value))).toEqual(["requestId"]);
  expect(await b.store.db.get("SELECT used FROM bot_message_upload_permits WHERE attachment_id=?", [uploaded.id])).toEqual({ used: 1 });
  expect((await call(input("upload", file, chat.conversationId))).id).toBe(uploaded.id);
  expect(await b.store.db.get("SELECT used FROM bot_message_upload_permits WHERE attachment_id=?", [uploaded.id])).toEqual({ used: 1 });
  await b.store.deleteMessages("owner", chat.conversationId, { messageIds: [original.messageId] });
  expect(await call(request)).toMatchObject({ messageId: original.messageId, duplicate: true });
  // Compatible/imported shared tombstones can outlive their attachment. The
  // existing duplicate path returns that old message before attachment lookup.
  await b.store.db.transaction(async () => {
    const old = await b.store.queuedMessageInTransaction(original.messageId);
    await b.store.updateQueuedMessageInTransaction({ ...old, status: "deleted", blocks: [], version: old.version + 1 });
    await b.store.db.run("UPDATE attachments SET created_at=0 WHERE id=?", [uploaded.id]);
  });
  expect(await new HubMaintenance(b.store, path.join(root, "b")).collectOrphans()).toBe(1);
  expect(await permits()).toHaveLength(1);
  expect(await b.store.db.get("SELECT used FROM bot_message_upload_permits WHERE attachment_id=?", [uploaded.id])).toEqual({ used: 1 });
  expect(await call(request)).toMatchObject({ messageId: original.messageId, duplicate: true });
  await expect(call({ ...request, data: { text: "Changed request", attachments: [uploaded.id] } })).rejects.toThrow("bot_message_request_conflict");
  expect(await b.store.db.all("SELECT id FROM messages WHERE client_msg_id IS NOT NULL")).toHaveLength(1);
  expect(await b.store.db.all("SELECT key FROM meta WHERE key>='bot-messages:incoming:' AND key<'bot-messages:incoming;'" )).toHaveLength(1);
  expect(await a.store.db.all("SELECT key FROM meta WHERE key>='bot-messages:outgoing:' AND key<'bot-messages:outgoing;'" )).toHaveLength(1);
});

it("rolls back used tracking on failed admission and retains unknown legacy permits", async () => {
  const chat = await target(), bytes = Buffer.from("not yet complete"), sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = { name: "unfinished.txt", mime: "text/plain", size: bytes.length, sha256 };
  const uploaded = await call(input("upload", file, chat.conversationId));
  const rows = () => b.store.db.all<{ key: string; value: string }>("SELECT key,value FROM meta WHERE key>='bot-messages:upload:' AND key<'bot-messages:upload;'");
  await expect(send(chat.conversationId, "Cannot send incomplete", randomUUID(), [uploaded.id])).rejects.toThrow("attachment_not_found");
  expect(await b.store.db.get("SELECT used FROM bot_message_upload_permits WHERE attachment_id=?", [uploaded.id])).toEqual({ used: 0 });
  expect(await b.store.db.all("SELECT key FROM meta WHERE key>='bot-messages:incoming:' AND key<'bot-messages:incoming;'" )).toHaveLength(0);
  // Force failure after attachment references have been inserted and their
  // trigger ran, not merely at an earlier incomplete-upload guard.
  await call(input("chunk", { uploadId: uploaded.id, index: 0, bytes: bytes.toString("base64") }, chat.conversationId));
  await call(input("complete", { uploadId: uploaded.id }, chat.conversationId));
  await b.store.db.exec("CREATE TRIGGER fail_message_event BEFORE INSERT ON events WHEN NEW.kind='message.created' BEGIN SELECT RAISE(ABORT,'failed_after_attachment'); END;");
  await expect(send(chat.conversationId, "Fails after reference", randomUUID(), [uploaded.id])).rejects.toThrow("failed_after_attachment");
  await b.store.db.exec("DROP TRIGGER fail_message_event");
  expect(await b.store.db.get("SELECT used FROM bot_message_upload_permits WHERE attachment_id=?", [uploaded.id])).toEqual({ used: 0 });
  expect(await b.store.db.all("SELECT * FROM message_attachments")).toHaveLength(0);
  expect(await b.store.db.all("SELECT key FROM meta WHERE key>='bot-messages:incoming:' AND key<'bot-messages:incoming;'" )).toHaveLength(0);
  const legacy = (await rows())[0]!;
  await b.store.db.run("DELETE FROM bot_message_upload_permits WHERE permit_key=?", [legacy.key]);
  await b.store.db.run("UPDATE meta SET value=? WHERE key=?", [JSON.stringify({ requestId: "legacy-permit" }), legacy.key]);
  expect((await call(input("upload", file, chat.conversationId))).id).toBe(uploaded.id);
  expect(await b.store.db.all("SELECT * FROM bot_message_upload_permits")).toHaveLength(0);
  await b.store.db.run("UPDATE attachments SET created_at=0 WHERE id=?", [uploaded.id]);
  await new HubMaintenance(b.store, path.join(root, "b")).collectOrphans();
  expect(await rows()).toHaveLength(1);
  expect(Object.keys(JSON.parse((await rows())[0]!.value))).toEqual(["requestId"]);
});

it("preserves source authorization and retains permits for referenced or only retired bytes", async () => {
  const chat = await target(), bytes = Buffer.from("source scoped"), sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = { name: "shared.txt", mime: "text/plain", size: bytes.length, sha256 };
  const uploaded = await call(input("upload", file, chat.conversationId));
  await b.botMessages.grant({ sourceHost: "Mac", sourceBot: "target", targetBot: "target" }, guard);
  const other = (request: BotLocalRequest) => source.local(request, "target", guard, true) as Promise<any>;
  await expect(other(input("chunk", { uploadId: uploaded.id, index: 0, bytes: bytes.toString("base64") }, chat.conversationId))).rejects.toThrow("bot_message_upload_forbidden");
  const second = await other(input("upload", file, chat.conversationId)); expect(second.id).toBe(uploaded.id);
  await call(input("chunk", { uploadId: uploaded.id, index: 0, bytes: bytes.toString("base64") }, chat.conversationId));
  await call(input("complete", { uploadId: uploaded.id }, chat.conversationId));
  await send(chat.conversationId, "one source uses the shared file", randomUUID(), [uploaded.id]);
  const rows = await b.store.db.all<{ used: number }>("SELECT used FROM bot_message_upload_permits WHERE attachment_id=?", [uploaded.id]);
  expect(rows.map(row => row.used)).toEqual([1, 1]);
  // Remove only the test tracking row to emulate a permit created after a
  // reference already exists. Re-init must classify the new permit as used.
  const otherKey = `bot-messages:upload:${hashSecret(JSON.stringify([a.auth.publicKey, "target", "target", chat.conversationId, uploaded.id]))}`;
  await b.store.db.run("DELETE FROM meta WHERE key=?", [otherKey]);
  expect(await b.store.db.all("SELECT * FROM bot_message_upload_permits WHERE permit_key=?", [otherKey])).toHaveLength(0);
  expect((await other(input("upload", file, chat.conversationId))).id).toBe(uploaded.id);
  expect(await b.store.db.get("SELECT used FROM bot_message_upload_permits WHERE permit_key=?", [otherKey])).toEqual({ used: 1 });
  // Recently retired bytes stay owned on disk; marking them does not itself
  // authorize the permit collector to change any upload/retry state.
  const orphan = await call(input("upload", { ...file, name: "retired.txt" }, chat.conversationId));
  await b.store.db.run("INSERT INTO retired_attachments VALUES(?)", [orphan.id]);
  await new HubMaintenance(b.store, path.join(root, "b")).collectOrphans(0);
  expect(await b.store.db.all("SELECT key FROM meta WHERE key>='bot-messages:upload:' AND key<'bot-messages:upload;'")).toHaveLength(3);
});

it("rejects ungranted callers, tampered/expired passports and removed network hosts", async () => {
  await expect(source.local(input("list"), "target", guard, true)).rejects.toThrow("authorized_or_revoked");
  const body = Buffer.from("{}"), passport: BotPassport = { v: 1, sourceKey: a.auth.publicKey, targetKey: b.auth.publicKey, source: { hostId: messageHostId(a.auth.publicKey), hostName: "Mac", botId: "source", botName: "Source", hops: 1, requestId: "test" }, targetBot: "target", method: "POST", path: "/api/bot-messages/conversations", digest: createHash("sha256").update(body).digest("hex"), expiresAt: Date.now() - 31_000, nonce: "nonce" };
  await expect(b.botMessages.receive({ passport, signature: a.auth.signBotPassport(passport) }, "POST", passport.path, body)).rejects.toThrow("passport_expired");
  // The physical Windows host is ~20 seconds ahead of the Mac. Accept that
  // bounded skew in either direction, but not arbitrarily long-lived tokens.
  passport.expiresAt = Date.now() + 80_000;
  await expect(b.botMessages.receive({ passport, signature: a.auth.signBotPassport(passport) }, "POST", passport.path, body)).resolves.toMatchObject({ botId: "target" });
  passport.expiresAt = Date.now() - 20_000;
  await expect(b.botMessages.receive({ passport, signature: a.auth.signBotPassport(passport) }, "POST", passport.path, body)).resolves.toMatchObject({ botId: "target" });
  passport.expiresAt = Date.now() + 91_000;
  await expect(b.botMessages.receive({ passport, signature: a.auth.signBotPassport(passport) }, "POST", passport.path, body)).rejects.toThrow("passport_expired");
  passport.expiresAt = Date.now() + 30_000;
  await expect(b.botMessages.receive({ passport, signature: b.auth.signBotPassport(passport) }, "POST", passport.path, body)).rejects.toThrow("signature_invalid");
  const row = await b.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key='private-network:v1'"); const state = JSON.parse(row!.value); state.revokedHosts.push(`${state.membership.manifest.id}:${a.auth.publicKey}`); await b.store.db.run("UPDATE meta SET value=? WHERE key='private-network:v1'", [JSON.stringify(state)]);
  await expect(call(input("list"))).rejects.toThrow("peer_revoked");
});

it("derives hops from the active source message, rejects missing context, and persists rate limits", async () => {
  const chat = await target();
  await expect(source.local(input("send", { text: "Task", attachments: [] }, chat.conversationId), "source", guard)).rejects.toThrow("context_required");
  const own = await a.store.createConversation("owner", ["source"], "Source", "source_context");
  const incoming = await a.store.sendMessage("owner", { conversationId: own.id, clientMsgId: "hop3", text: "Third hop", attachments: [], botSource: { hostId: messageHostId(b.auth.publicKey), hostName: "Windows", botId: "target", botName: "Target", hops: 3, requestId: "hop3" } });
  await a.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [incoming.message.id]);
  await expect(source.local({ ...input("send", { text: "Loop", attachments: [] }, chat.conversationId), contextMessage: incoming.message.id }, "source", guard)).rejects.toThrow("hop_limit");
  for (let i = 0; i < 10; i++) await send(chat.conversationId, `Task ${i}`);
  await expect(send(chat.conversationId)).rejects.toThrow("rate_limit");
  expect(await b.store.db.all("SELECT * FROM deliveries")).toHaveLength(10);
});

it("supports two Bots on one standalone host using the same queue and passport validation", async () => {
  await a.store.db.run("DELETE FROM meta WHERE key='private-network:v1'");
  await a.botMessages.grant({ sourceHost: "Mac", sourceBot: "source", targetBot: "target" }, guard);
  const request = { ...input("resolve"), host: "Mac" };
  const chat: any = await a.botMessages.local(request, "source", guard, true);
  const receipt: any = await a.botMessages.local({ ...input("send", { text: "Local", attachments: [] }, chat.conversationId), host: "Mac" }, "source", guard, true);
  expect(receipt.hostId).toBe(messageHostId(a.auth.publicKey)); expect(await a.store.pendingForBot("target")).toHaveLength(1);
});

it("announces a conversation created by an incoming Bot message to App sockets already connected", async () => {
  const existing = await b.store.createConversation("owner", ["target"], "Existing", "existing");
  const keys = generateKeyPairSync("ed25519");
  await bootstrapTrusted(b.auth, { deviceId: "device", name: "App", platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") });
  const ws = new WebSocket(b.url.replace("http", "ws") + "/ws"), frames: any[] = [], reader = nodeFrameReader();
  try {
    ws.on("message", (raw: Buffer) => { const frame = reader.read(raw.toString()); if (frame) frames.push(frame); });
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const next = async (type: string) => { let frame: any; await vi.waitFor(() => { const index = frames.findIndex(f => f.type === type); expect(index).toBeGreaterThanOrEqual(0); frame = frames.splice(index, 1)[0]; }); return frame; };
    const clientNonce = randomBytes(32).toString("base64url");
    ws.send(JSON.stringify({ v: 1, type: "hello", deviceId: "device", nonce: clientNonce, protocolVersions: [1], capabilities: ["cards.v1", CONVERSATION_SYNC_CAPABILITY], cursors: {} }));
    const challenge = await next("challenge");
    ws.send(JSON.stringify({ v: 1, type: "auth", signature: sign(null, deviceProof("device", challenge.nonce, clientNonce), keys.privateKey).toString("base64") }));
    expect((await next("ready")).conversations.map((c: { id: string }) => c.id)).toEqual([existing.id]);
    await next("sync.complete"); frames.length = 0;
    const created = await call(input("resolve", { newConversation: "Review" }));
    const sent = await send(created.conversationId, "Please review");
    await vi.waitFor(() => {
      expect(frames.some(f => f.type === "conversation.updated" && f.conversation.id === created.conversationId)).toBe(true);
      expect(frames.some(f => f.type === "event" && f.conversationId === created.conversationId && f.payload?.id === sent.messageId)).toBe(true);
    });
  } finally { ws.terminate(); }
});


describe("cross-Bot input and active group discussions", () => {
  // The Hub is the only scheduler of a running discussion: a delegated input
  // must not reach a participant mid-run (in the independent first round its
  // reply would not be sealed), exactly like a human mention.
  const group = async (mode: "independent" | "sequential", title = "Review group") => {
    await b.store.db.run("INSERT OR IGNORE INTO bots(id,name,secret_hash,engine) VALUES('peer','Peer',?,'codex')", [hashSecret("test-".repeat(10))]);
    const conversation = await b.store.createConversation("owner", ["target", "peer"], title, `group-${title}`, { type: "group" });
    const settings = await b.store.groupSettings("owner", conversation.id);
    await b.store.updateGroup("owner", conversation.id, { title: settings.group.title, botIds: settings.group.botIds, expectedTitle: settings.group.title, expectedBotIds: settings.group.botIds,
      policy: { mode, botOrder: settings.policy.botOrder, maxRounds: 2 }, expectedRevision: settings.revision });
    return conversation;
  };
  const start = async (conversationId: string) => (await b.groupDiscussions.start("owner", conversationId, { requestId: randomUUID(), revision: (await b.store.groupSettings("owner", conversationId)).revision, text: "Pick a database" })).run;
  const delegated = async (conversationId: string) => (await b.store.db.all("SELECT id FROM messages WHERE conversation_id=? AND bot_source_json IS NOT NULL", [conversationId])).length;

  it.each(["independent", "sequential"] as const)("rejects delegated input into a %s discussion and records nothing", async mode => {
    const chat = await group(mode), run = await start(chat.id);
    if (mode === "independent") expect(run.stage).toBe("blind");
    await expect(send(chat.id, "What did you answer?")).rejects.toThrow("group_discussion_active");
    expect(await delegated(chat.id)).toBe(0);
    expect(await b.store.db.all("SELECT 1 FROM audit_log WHERE kind='bot-message.send'")).toHaveLength(0);
  });

  it("keeps rejecting while the discussion is paused, and accepts the same request once it has ended", async () => {
    const chat = await group("independent"), run = await start(chat.id), requestId = randomUUID();
    const view = await b.groupDiscussions.control("owner", chat.id, run.id, { requestId: randomUUID(), revision: `r${(await b.store.db.get<{ revision: number }>("SELECT revision FROM group_discussions WHERE id=?", [run.id]))!.revision}`, action: "pause" });
    expect(["pausing", "paused"]).toContain(view.run?.status);
    await expect(send(chat.id, "Status?", requestId)).rejects.toThrow("group_discussion_active");
    // A rejection rolls back the request memo: after the run is over the same
    // request is a new, ordinary delivery rather than a conflict.
    await b.store.db.run("UPDATE group_discussions SET status='ended' WHERE id=?", [run.id]);
    const accepted = await send(chat.id, "Status?", requestId);
    expect(accepted).toMatchObject({ duplicate: false, status: "queued" });
    expect(await delegated(chat.id)).toBe(1);
  });

  it("still delivers into ordinary groups and replays an accepted request after a discussion starts", async () => {
    const chat = await group("independent", "Ordinary"), requestId = randomUUID();
    const first = await send(chat.id, "Before the discussion", requestId);
    expect(first.duplicate).toBe(false);
    await start(chat.id);
    const replay = await send(chat.id, "Before the discussion", requestId);
    expect(replay).toMatchObject({ duplicate: true, messageId: first.messageId });
    const direct = await target();
    expect((await send(direct.conversationId, "Direct task")).status).toBe("queued");
  });
});
