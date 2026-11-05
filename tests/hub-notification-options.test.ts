import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { legacyNotificationPreferencesSchema, notificationPreferencesSchema, type PushPayload } from "../src/client-protocol/push.js";
import { HubServer } from "../src/hub/server.js";
import { HubStore } from "../src/hub/store.js";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { PushWorker } from "../src/hub/push/worker.js";

const roots: string[] = [];
const temp = async () => { const root = await mkdtemp(path.join(os.tmpdir(), "notification-options-")); roots.push(root); return root; };
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function pairedHub() {
  const hub = await HubServer.start({ stateDir: await temp() }); closers.push(() => hub.close());
  const keys = generateKeyPairSync("ed25519"), nonce = randomBytes(32).toString("base64url");
  const pair = await hub.auth.pair({ deviceId: "phone", name: "Phone", platform: "android", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, "local");
  await hub.auth.approve(pair.code, "local-owner"); const challenge = await hub.auth.challenge("phone", "phone", nonce, "local");
  const auth = (await hub.auth.authenticate("phone", sign(null, deviceProof("phone", challenge.nonce, nonce), keys.privateKey).toString("base64"))).token;
  const api = (route: string, method = "GET", body?: unknown) => fetch(hub.url + route, { method, headers: { Authorization: `Bearer ${auth}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { hub, api };
}

test("the Hub advertises customization, keeps legacy JSON parseable by older Hubs, and preserves options omitted by older clients", async () => {
  const { hub, api } = await pairedHub();
  const initial = await (await api("/api/notifications")).json() as { customization: boolean; preferences: Record<string, unknown> };
  expect(initial.customization).toBe(true);
  expect(initial.preferences).toEqual({ enabled: false, quietStart: "", quietEnd: "", timeZone: "UTC" });
  expect((await api("/api/notifications", "PUT", { enabled: true, filesReceived: false, showPreview: false })).status).toBe(200);
  // An older client only knows the original four fields.
  expect((await api("/api/notifications", "PUT", { enabled: true, quietStart: "22:00", quietEnd: "07:00", timeZone: "Asia/Shanghai" })).status).toBe(200);
  const after = await (await api("/api/notifications")).json() as { preferences: Record<string, unknown> };
  expect(after.preferences).toEqual({ enabled: true, quietStart: "22:00", quietEnd: "07:00", timeZone: "Asia/Shanghai", filesReceived: false, showPreview: false });
  // A same-schema older Hub strictly parses device_preferences; it must never see the new keys.
  const legacy = await hub.store.db.get<{ preferences_json: string }>("SELECT preferences_json FROM device_preferences WHERE device_id='phone'");
  expect(legacyNotificationPreferencesSchema.parse(JSON.parse(legacy!.preferences_json))).toMatchObject({ enabled: true, quietStart: "22:00" });
  // Explicit values replace only the named option.
  expect((await api("/api/notifications", "PUT", { ...after.preferences, filesReceived: true })).status).toBe(200);
  expect((await (await api("/api/notifications")).json() as { preferences: Record<string, unknown> }).preferences).toMatchObject({ filesReceived: true, showPreview: false });
  expect((await api("/api/notifications", "PUT", { enabled: true, unknownOption: true })).status).toBe(400);
});

async function pushStore() {
  const store = await HubStore.open(await temp()); closers.push(() => store.db.close());
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret("test-only-secret")]);
  const conversation = (await store.createConversation("owner", ["alpha"], "Private launch plan", "create")).id;
  const now = Date.now() + 2000;
  await store.db.run("INSERT INTO devices VALUES('device','owner','Test','android','unused-public-key',0,?,?,?)", [now, now, JSON.stringify({ provider: "fcm", token: "test_registration_token_" + "x".repeat(40) })]);
  await store.db.run("INSERT INTO device_preferences VALUES('device',?)", [JSON.stringify(notificationPreferencesSchema.parse({ enabled: true }))]);
  await store.db.run("INSERT INTO attachments(id,conversation_id,owner_id,sha256,size,mime,name,stored_name,complete,created_at) VALUES('att_1',?,'owner','fixture',10,'application/pdf','secret-contract.pdf','fixture',1,0)", [conversation]);
  const options = (value: Record<string, boolean>) => store.db.run("INSERT INTO device_notification_options VALUES('device',?) ON CONFLICT(device_id) DO UPDATE SET options_json=excluded.options_json", [JSON.stringify(value)]);
  const outbox = async () => (await store.db.all<{ payload_json: string; notice_class: string | null }>("SELECT payload_json,notice_class FROM push_outbox ORDER BY rowid")).map(row => ({ ...JSON.parse(row.payload_json) as PushPayload, noticeClass: row.notice_class }));
  return { store, conversation, now, options, outbox };
}
const fileBlock = { type: "file" as const, attachmentId: "att_1", name: "secret-contract.pdf", mime: "application/pdf", size: 10 };

test("topic choices filter admission; mixed replies follow either topic and attention is independent", async () => {
  const { store, conversation, options, outbox } = await pushStore();
  await options({ filesReceived: false });
  await store.publishBotMessage("alpha", { conversationId: conversation, blocks: [fileBlock] });
  expect(await outbox()).toHaveLength(0);
  await store.publishBotMessage("alpha", { conversationId: conversation, blocks: [{ type: "text", text: "Here is the report." }, fileBlock] });
  expect((await outbox()).map(row => row.noticeClass)).toEqual(["reply:replyCompleted,filesReceived"]);
  await options({ replyCompleted: false, filesReceived: false });
  await store.publishBotMessage("alpha", { conversationId: conversation, blocks: [{ type: "text", text: "plain reply" }] });
  await store.publishBotMessage("alpha", { conversationId: conversation, blocks: [{ type: "card", elements: [{ type: "markdown", text: "Approve the release?" }, { type: "button", text: "Approve", actionId: "approve" }] }] });
  expect((await outbox()).slice(1).map(row => [row.kind, row.noticeClass])).toEqual([["action", "action:needsAttention"]]);
  await options({ needsAttention: false });
  await store.publishBotMessage("alpha", { conversationId: conversation, blocks: [{ type: "card", elements: [{ type: "button", text: "Retry", actionId: "retry" }] }] });
  expect(await outbox()).toHaveLength(2);
});

test("hidden previews never store or send the conversation, Bot, file name or excerpt", async () => {
  const { store, conversation, now, options, outbox } = await pushStore();
  await options({ showPreview: false });
  await store.publishBotMessage("alpha", { conversationId: conversation, blocks: [{ type: "text", text: "Confidential merger terms" }, fileBlock] });
  await store.publishBotMessage("alpha", { conversationId: conversation, blocks: [fileBlock] });
  const rows = await outbox();
  expect(rows.map(row => row.body)).toEqual(["Bot 已完成回复，点按查看。", "Bot 发来了文件，点按查看。"]);
  const sender = vi.fn().mockResolvedValue("sent"); const worker = new PushWorker(store, sender, () => false, () => now + 5000);
  await worker.tick(); await worker.stop();
  const sent = JSON.stringify(sender.mock.calls);
  for (const secret of ["Private launch plan", "Alpha", "secret-contract", "Confidential"]) expect(sent).not.toContain(secret);
});

test("the worker re-checks topics and preview privacy before sending a queued row", async () => {
  const { store, conversation, now, options, outbox } = await pushStore();
  await store.publishBotMessage("alpha", { conversationId: conversation, blocks: [{ type: "text", text: "Confidential merger terms" }] });
  await store.publishBotMessage("alpha", { conversationId: conversation, blocks: [fileBlock] });
  expect((await outbox())[0]!.body).toContain("Confidential merger terms");
  // The user hides previews and silences file notices after both were queued.
  await options({ showPreview: false, filesReceived: false });
  const sender = vi.fn().mockResolvedValue("sent"); const worker = new PushWorker(store, sender, () => false, () => now + 5000);
  await worker.tick(); await worker.stop();
  expect(sender).toHaveBeenCalledTimes(1);
  expect(sender.mock.calls[0]![1]).toMatchObject({ kind: "answer", body: "Bot 已完成回复，点按查看。", title: "TaroCub" });
  expect(await store.db.all("SELECT status FROM push_outbox ORDER BY rowid")).toEqual([{ status: "sent" }, { status: "cancelled" }]);
});

test("rows queued by an older Hub without a class fall back to their wire kind", async () => {
  const { store, conversation, now, options } = await pushStore();
  await store.publishBotMessage("alpha", { conversationId: conversation, blocks: [{ type: "text", text: "Confidential merger terms" }] });
  await store.db.run("UPDATE push_outbox SET notice_class=NULL");
  await options({ showPreview: false });
  const sender = vi.fn().mockResolvedValue("sent"); const worker = new PushWorker(store, sender, () => false, () => now + 5000);
  await worker.tick(); await worker.stop();
  expect(sender.mock.calls[0]![1].body).toBe("收到新消息，打开 TaroBird 查看。");
});
