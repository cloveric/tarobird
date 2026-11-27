import { createDecipheriv, createECDH, generateKeyPairSync, hkdfSync, randomBytes, sign, verify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notificationPreferencesSchema, type PushPayload } from "../src/client-protocol/push.js";
import { HubStore } from "../src/hub/store.js";
import { HubServer } from "../src/hub/server.js";
import { HubMaintenance } from "../src/hub/maintenance.js";
import { HubAuth, deviceProof, hashSecret } from "../src/hub/auth.js";
import { PushWorker } from "../src/hub/push/worker.js";
import { quietNow } from "../src/hub/push/model.js";
import { createPushSender, validatePushDestination } from "../src/hub/push/providers.js";
import { createRunRecord } from "../src/core/run-record.js";
import { initialCoreRunState, renderCoreRunCard } from "../src/core/card-renderer.js";
import { GatewayChannel } from "../src/gateway/channel.js";
import { renderCoreQueueWaitCard, renderCoreQueueLifecycleCard, renderCoreQueueCancelledCard } from "../src/core/card-renderer.js";
import { translateCard } from "../src/gateway/card-translator.js";
import type { GatewayTransport } from "../src/gateway/transport.js";

let root: string; let store: HubStore; let conversation: string; let now: number;
const subscription = { provider: "fcm", token: "test_registration_token_" + "x".repeat(40) };
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "push-test-")); store = await HubStore.open(root); now = Date.now() + 2000;
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret("test-only-secret")]);
  conversation = (await store.createConversation("owner", ["alpha"], "Private conversation", "create")).id;
  await store.db.run("INSERT INTO devices VALUES('device','owner','Test','android','unused-public-key',0,?,?,?)", [now, now, JSON.stringify(subscription)]);
  await store.db.run("INSERT INTO device_preferences VALUES('device',?)", [JSON.stringify(notificationPreferencesSchema.parse({ enabled: true }))]);
});
afterEach(async () => { await store.db.close(); await rm(root, { recursive: true, force: true }); });
async function message(text: string) { return store.publishBotMessage("alpha", { conversationId: conversation, blocks: [{ type: "text", text }] }); }

test.each([false, true])("Core queue bookkeeping never sends action/answer alerts; the actual reply alerts once (legacy=%s)", async legacy => {
  const input = await store.sendMessage("owner", { conversationId: conversation, clientMsgId: "queued", text: "Work", attachments: [] });
  const spec = { profile: "gateway" as const, taskId: input.message.id, conversationKey: `lark:${conversation}`, waitedMs: 0 };
  const card = translateCard(renderCoreQueueWaitCard(spec)); if (legacy) delete card.extra!.appQueue;
  const sent = await store.publishBotMessage("alpha", { conversationId: conversation, replyTo: input.message.id, blocks: [card] });
  expect(await store.db.all("SELECT id FROM push_outbox")).toHaveLength(0);
  for (const next of [renderCoreQueueLifecycleCard(spec, "started", "Preparing"), renderCoreQueueCancelledCard("en", spec)]) {
    await store.publishBotMessage("alpha", { id: sent.id, conversationId: conversation, replyTo: input.message.id, status: "complete", blocks: [translateCard(next)] });
    expect(await store.db.all("SELECT id FROM push_outbox")).toHaveLength(0);
  }
  for (let i = 0; i < 2; i++) await store.publishBotMessage("alpha", { id: sent.id, conversationId: conversation, replyTo: input.message.id, blocks: [{ type: "text", text: "Actual answer" }] });
  const rows = await store.db.all<{ payload_json: string }>("SELECT payload_json FROM push_outbox");
  expect(rows).toHaveLength(1); expect(JSON.parse(rows[0]!.payload_json).kind).toBe("answer");
});

test("streaming waits for completion and names the conversation, reply and files without duplicate alerts", async () => {
  const draft = await store.publishBotMessage("alpha", { conversationId: conversation, status: "streaming", blocks: [{ type: "text", text: "private draft" }] });
  expect(await store.db.all("SELECT id FROM push_outbox")).toHaveLength(0);
  const complete = await store.publishBotMessage("alpha", { id: draft.id, conversationId: conversation, status: "complete", blocks: [{ type: "text", text: "private answer" }] });
  await store.db.run("INSERT INTO attachments(id,conversation_id,owner_id,sha256,size,mime,name,stored_name,complete,created_at) VALUES('file_one',?,'owner','fixture',100,'application/octet-stream','confidential-contract.docx','fixture',1,0)", [conversation]);
  const file = await store.publishBotMessage("alpha", { conversationId: conversation, blocks: [{ type: "text", text: "confidential caption" }, { type: "file", attachmentId: "file_one", name: "confidential-contract.docx", size: 100, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }] });
  await store.publishBotMessage("alpha", { id: file.id, conversationId: conversation, blocks: file.blocks });
  const rows = await store.db.all<{ payload_json: string }>("SELECT payload_json FROM push_outbox");
  const payloads = rows.map(row => JSON.parse(row.payload_json) as PushPayload);
  expect(payloads).toHaveLength(2);
  expect(payloads.every(payload => payload.title === "TaroCub")).toBe(true); // Installed-client wire discriminator.
  expect(payloads.find(p => p.messageId === complete.id)?.body).toBe("「Private conversation」 · Alpha\n回复完成：private answer");
  expect(payloads.find(p => p.messageId === file.id)?.body).toBe("「Private conversation」 · Alpha\n收到文件：confidential-contract.docx · confidential caption");
  expect(JSON.stringify(payloads)).not.toContain("private draft");
  expect(payloads.every(p => p.conversationId === conversation && p.kind === "answer")).toBe(true);
});

test.each(["partial", "interrupted", "stopped", "error"])("a %s run cannot send a reply-completed notification", async phase => {
  const result = await store.publishBotMessage("alpha", { conversationId: conversation, status: "complete", blocks: [{ type: "card", elements: [], extra: { nativeRun: { version: 1, id: "run_one", revision: 2, phase, startedAt: 1, updatedAt: 2, count: 1, completed: 0, failed: 0, truncated: false } } }] });
  const row = await store.db.get<{ payload_json: string }>("SELECT payload_json FROM push_outbox LIMIT 1");
  expect(JSON.parse(row!.payload_json)).toMatchObject({ messageId: result.id, kind: "error", body: "「Private conversation」 · Alpha\n任务未完成：点按查看当前进展。" });
});

test("a hidden ticket conversation pushes an open approval like an ordinary one, and nothing else", async () => {
  const approval = (disabled = false) => [{ type: "card" as const, elements: [{ type: "markdown" as const, text: "Run the build?" }, { type: "button" as const, text: "Allow", actionId: "allow", disabled, value: { requestId: "req_1", cctb_lark: "approval", decision: "allow_once" } }] }];
  const payloads = async () => (await store.db.all<{ payload_json: string }>("SELECT payload_json FROM push_outbox ORDER BY rowid")).map(row => JSON.parse(row.payload_json) as PushPayload);
  const ordinary = await store.publishBotMessage("alpha", { conversationId: conversation, status: "complete", blocks: approval() });
  const [visible] = await payloads();
  expect(visible).toMatchObject({ messageId: ordinary.id, kind: "action" });
  await store.db.run("DELETE FROM push_outbox"); await store.db.run("DELETE FROM push_receipts");
  await store.db.run("UPDATE conversations SET hidden=1 WHERE id=?", [conversation]);
  // An ordinary answer in the hidden conversation still reports through the dispatcher only.
  await message("worker progress");
  expect(await payloads()).toEqual([]);
  const waiting = await store.publishBotMessage("alpha", { conversationId: conversation, status: "complete", blocks: approval() });
  const [hidden] = await payloads();
  // Same fields and wording as the ordinary approval push: kind, body shape, conversation and message only.
  expect(Object.keys(hidden!).sort()).toEqual(Object.keys(visible!).sort());
  expect(hidden).toMatchObject({ messageId: waiting.id, conversationId: conversation, kind: "action", body: visible!.body });
  // Once answered (actions disabled) nothing more is pushed.
  await store.publishBotMessage("alpha", { id: waiting.id, conversationId: conversation, status: "complete", blocks: approval(true) });
  expect(await payloads()).toHaveLength(1);
});

test.each(["thinking", "working", "answering", "waiting_approval", "waiting_answer", "stopping", "delivering"])("an older Gateway's complete envelope during %s waits for the terminal notification", async phase => {
  const summary = { version: 1, id: "run_active", revision: 1, phase, startedAt: 1, updatedAt: 2, count: 0, completed: 0, failed: 0, truncated: false };
  const sent = await store.publishBotMessage("alpha", { conversationId: conversation, status: "complete", blocks: [{ type: "card", elements: [], extra: { nativeRun: summary } }] });
  expect(await store.db.all("SELECT id FROM push_outbox")).toHaveLength(0);
  await store.publishBotMessage("alpha", { id: sent.id, conversationId: conversation, status: "complete", blocks: [{ type: "card", elements: [], extra: { nativeRun: { ...summary, phase: "done", revision: 2, endedAt: 3 } } }] });
  const rows = await store.db.all<{ payload_json: string }>("SELECT payload_json FROM push_outbox");
  expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({ messageId: sent.id, kind: "answer", body: "「Private conversation」 · Alpha\n回复完成：点按查看回复。" });
});

test.each([true, false])("Gateway retains active status through delivery and stop confirmation (native journal: %s)", async supported => {
  const transport = { capabilities: supported ? ["runs.v1"] : [], options: { stateDir: root }, request: async (method: string, input: any) => {
    if (method === "publish") return store.publishBotMessage("alpha", input);
    if (method === "run.write") return null;
    throw new Error(method);
  } };
  const channel = new GatewayChannel(transport as unknown as GatewayTransport);
  const state = initialCoreRunState("test"); state.nativeRun = createRunRecord();
  const sent = await channel.send(conversation, { card: renderCoreRunCard(state) });
  state.status = "delivering";
  await channel.updateCard(sent.messageId, renderCoreRunCard(state));
  expect((await store.messageForUser("owner", sent.messageId)).status).toBe("streaming");
  state.nativeRun.phase = "stopping";
  await channel.updateCard(sent.messageId, renderCoreRunCard(state));
  expect((await store.messageForUser("owner", sent.messageId)).status).toBe("streaming");
  expect(await store.db.all("SELECT id FROM push_outbox")).toHaveLength(0);
  state.status = "interrupted";
  await channel.updateCard(sent.messageId, renderCoreRunCard(state));
  expect((await store.messageForUser("owner", sent.messageId)).status).toBe("complete");
  expect(await store.db.all("SELECT id FROM push_outbox")).toHaveLength(1);
});

test("three reminders are atomically enqueued separately, survive restart and deduplicate updates", async () => {
  const first = await message("secret reminder one"); await message("secret reminder two"); await message("secret reminder three");
  await store.publishBotMessage("alpha", { id: first.id, conversationId: conversation, version: 2, blocks: [{ type: "text", text: "edited private content" }] });
  const rows = await store.db.all<{ payload_json: string }>("SELECT payload_json FROM push_outbox"); expect(rows).toHaveLength(3); expect(JSON.stringify(rows)).toContain("secret reminder one"); expect(JSON.stringify(rows)).not.toContain("edited private");
  await store.db.close(); store = await HubStore.open(root); const sent: PushPayload[] = [];
  const worker = new PushWorker(store, async (_subscription, payload) => { sent.push(payload); return "sent"; }, () => false, () => now);
  await worker.tick(); await worker.tick(); expect(sent).toHaveLength(3); expect(new Set(sent.map((p) => p.id)).size).toBe(3); expect(sent.map((p) => p.messageId)).toContain(first.id);
  expect(await store.db.all("SELECT id FROM push_outbox WHERE status='pending'")).toHaveLength(0); await worker.stop();
});
test.each(["sent", "suppressed", "cancelled", "failed"])("retains %s notification deduplication when old transport payloads are pruned", async status => {
  const original = await message("completed once");
  await store.db.run("UPDATE push_outbox SET status=?,next_at=?", [status, now - 8 * 86400_000]);
  await new HubMaintenance(store, root).pruneDeliveryHistory(now);
  expect(await store.db.all("SELECT id FROM push_outbox")).toHaveLength(0);
  await store.db.close(); store = await HubStore.open(root);
  await store.publishBotMessage("alpha", { id: original.id, conversationId: conversation, version: original.version + 1, blocks: [{ type: "text", text: "updated presentation of original answer" }] });
  expect(await store.db.all("SELECT id FROM push_outbox")).toHaveLength(0);
  // A genuinely different notification kind and a new message still notify.
  await store.publishBotMessage("alpha", { id: original.id, conversationId: conversation, status: "error", version: original.version + 2, blocks: [{ type: "text", text: "subsequent failure" }] });
  await message("new answer");
  expect(await store.db.all("SELECT id FROM push_outbox")).toHaveLength(2);
});
test.each(["reopen", "maintenance"])("migrates old notification identities before %s without retaining their text", async boundary => {
  const original = await message("old private notification text");
  const old = (await store.db.get<{ id: string; event_seq: number; payload_json: string }>("SELECT id,event_seq,payload_json FROM push_outbox"))!;
  // Emulate a compatible writer without the new compact receipt.
  await store.db.run("DELETE FROM push_receipts");
  await store.db.run("UPDATE push_outbox SET status='sent',next_at=?", [now - 8 * 86400_000]);
  // A corrupt legacy transport row must not break migration/maintenance.
  await store.db.run("INSERT INTO push_outbox(id,device_id,conversation_id,event_seq,payload_json,status,next_at) VALUES('invalid','device',?,?,'broken','sent',0)", [conversation, old.event_seq + 1]);
  if (boundary === "reopen") { await store.db.close(); store = await HubStore.open(root); }
  await new HubMaintenance(store, root).pruneDeliveryHistory(now);
  const receipts = await store.db.all("SELECT * FROM push_receipts");
  expect(receipts).toEqual([{ id: old.id, device_id: "device", message_id: original.id }]);
  expect(JSON.stringify(receipts)).not.toContain("private");
  // Even an older compatible writer that only INSERTs an outbox row cannot
  // resurrect a notification after its payload was removed.
  await store.db.run("INSERT OR IGNORE INTO push_outbox(id,device_id,conversation_id,event_seq,payload_json,next_at) VALUES(?,'device',?,?,?,?)", [old.id, conversation, old.event_seq + 2, old.payload_json, now]);
  expect(await store.db.all("SELECT id FROM push_outbox")).toHaveLength(0);
});

test("cleans permanently revoked device receipts without replaying notifications or losing other devices' deduplication", async () => {
  await store.db.run("INSERT INTO devices VALUES('second','owner','Second','android','second-public-key',0,?,?,?)", [now, now, JSON.stringify(subscription)]);
  await store.db.run("INSERT INTO device_preferences VALUES('second',?)", [JSON.stringify(notificationPreferencesSchema.parse({ enabled: true }))]);
  const original = await message("original answer");
  await store.db.run("UPDATE push_outbox SET status='sent',next_at=?", [now - 8 * 86400_000]);
  const auth = await HubAuth.open(store, root); await auth.revoke("device", "local-owner");
  await new HubMaintenance(store, root).pruneDeliveryHistory(now);
  expect((await store.db.all<{ device_id: string }>("SELECT device_id FROM push_receipts")).map(row => row.device_id)).toEqual(["second"]);
  await store.publishBotMessage("alpha", { id: original.id, conversationId: conversation, version: original.version + 1, blocks: original.blocks });
  expect(await store.db.all("SELECT id FROM push_outbox")).toHaveLength(0);
  await store.publishBotMessage("alpha", { id: original.id, conversationId: conversation, status: "deleted", version: original.version + 2, blocks: [] });
  await new HubMaintenance(store, root).pruneDeliveryHistory(now);
  await store.publishBotMessage("alpha", { id: original.id, conversationId: conversation, version: original.version + 3, blocks: original.blocks });
  expect(await store.db.all("SELECT id FROM push_outbox")).toHaveLength(0);
  await message("new reply");
  expect((await store.db.all<{ device_id: string }>("SELECT device_id FROM push_outbox")).map(row => row.device_id)).toEqual(["second"]);
});

test("rolls back a failed notification admission together with its message and compact receipt", async () => {
  await store.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON push_receipts BEGIN SELECT RAISE(ABORT,'receipt fixture failure'); END");
  await expect(message("must not partly commit")).rejects.toThrow("receipt fixture failure");
  expect(await store.db.all("SELECT id FROM messages")).toHaveLength(0);
  expect(await store.db.all("SELECT id FROM push_outbox")).toHaveLength(0);
  expect(await store.db.all("SELECT id FROM push_receipts")).toHaveLength(0);
  await store.db.exec("DROP TRIGGER fail_receipt");
  await message("committed reply");
  expect(await store.db.all("SELECT id FROM push_outbox")).toHaveLength(1);
  expect(await store.db.all("SELECT id FROM push_receipts")).toHaveLength(1);
});
test("failed delivery retries durably and a revoked or expired subscription is cancelled", async () => {
  await message("reply"); const sender = vi.fn().mockResolvedValueOnce("retry").mockResolvedValueOnce("gone");
  let worker = new PushWorker(store, sender, () => false, () => now); await worker.tick(); expect(sender).toHaveBeenCalledTimes(1); await worker.stop(); await store.db.close(); store = await HubStore.open(root);
  now += 2000; worker = new PushWorker(store, sender, () => false, () => now); await worker.tick(); expect(sender).toHaveBeenCalledTimes(2); expect((await store.db.get<{ push_json: string | null }>("SELECT push_json FROM devices WHERE id='device'"))?.push_json).toBeNull(); await worker.stop();
  await store.db.run("UPDATE devices SET push_json=? WHERE id='device'", [JSON.stringify(subscription)]); await message("second reply"); const auth = await HubAuth.open(store, root); await auth.revoke("device", "local-owner"); now += 2000;
  worker = new PushWorker(store, sender, () => false, () => now); await worker.tick(); expect(sender).toHaveBeenCalledTimes(2); await worker.stop();
});
test("quiet hours, per-conversation mute, foreground and read receipts suppress notifications", async () => {
  const prefs = notificationPreferencesSchema.parse({ enabled: true, quietStart: "22:00", quietEnd: "07:00", timeZone: "Asia/Shanghai" });
  expect(quietNow(prefs, Date.parse("2026-10-01T15:00:00Z"))).toBe(true); expect(quietNow(prefs, Date.parse("2026-10-01T04:00:00Z"))).toBe(false);
  await store.db.run("UPDATE conversation_members SET muted=1 WHERE member_type='user'"); await message("muted"); expect(await store.db.all("SELECT * FROM push_outbox")).toHaveLength(0);
  await store.db.run("UPDATE conversation_members SET muted=0 WHERE member_type='user'"); await message("foreground"); const sender = vi.fn().mockResolvedValue("sent"); const worker = new PushWorker(store, sender, () => true, () => now); await worker.tick(); expect(sender).not.toHaveBeenCalled(); await worker.stop();
  await message("already read"); const seq = (await store.snapshot("owner", conversation)).seq; await store.markRead("owner", conversation, seq); now += 2000;
  const next = new PushWorker(store, sender, () => false, () => now); await next.tick(); expect(sender).not.toHaveBeenCalled(); await next.stop();
});
test("device-supplied endpoints cannot redirect push to local services or another origin", () => {
  expect(() => validatePushDestination({ provider: "unifiedpush", endpoint: "https://127.0.0.1/abcdefghijklmnop" }, {})).toThrow();
  expect(() => validatePushDestination({ provider: "unifiedpush", endpoint: "https://ntfy.example.test.evil.test/abcdefghijklmnop" }, { unifiedpush: { origins: ["https://ntfy.example.test"] } })).toThrow();
  expect(validatePushDestination({ provider: "unifiedpush", endpoint: "https://ntfy.example.test/abcdefghijklmnop" }, { unifiedpush: { origins: ["https://ntfy.example.test"] } }).provider).toBe("unifiedpush");
});

test("UnifiedPush accepts real distributor endpoints (ntfy, Sunup, NextPush, Gotify) and rejects unsafe paths", () => {
  const config = {
    unifiedpush: {
      origins: [
        "https://ntfy.example.test/",
        "https://updates.example.test",
        "https://cloud.example.test",
        "https://gotify.example.test",
      ],
    },
  };
  // ntfy generates 14-char topics (`up` + 12 random chars) with `?up=1`.
  expect(validatePushDestination({ provider: "unifiedpush", endpoint: "https://ntfy.example.test/upAbCdEf123456?up=1" }, config).provider).toBe("unifiedpush");
  // Sunup / Mozilla Autopush multi-segment paths.
  expect(validatePushDestination({ provider: "unifiedpush", endpoint: "https://updates.example.test/wpush/v2/gAAAAABk_test-token" }, config).provider).toBe("unifiedpush");
  // NextPush paths containing `.` and multiple segments.
  expect(validatePushDestination({ provider: "unifiedpush", endpoint: "https://cloud.example.test/index.php/apps/uppush/push/token123" }, config).provider).toBe("unifiedpush");
  // Gotify-UP short path with query token.
  expect(validatePushDestination({ provider: "unifiedpush", endpoint: "https://gotify.example.test/UP?token=abc123" }, config).provider).toBe("unifiedpush");
  // Root, traversal, encoded slash/dot, empty segments, and http configured origins remain rejected.
  for (const bad of [
    "https://ntfy.example.test/",
    "https://ntfy.example.test/a//b",
    "https://ntfy.example.test/up/../secret",
    "https://ntfy.example.test/up/%2e%2e/secret",
    "https://ntfy.example.test/up/%2fsecret",
    "https://ntfy.example.test/up/%5csecret",
  ]) {
    expect(() => validatePushDestination({ provider: "unifiedpush", endpoint: bad }, config)).toThrow();
  }
  expect(() => validatePushDestination({ provider: "unifiedpush", endpoint: "https://ntfy.example.test/upAbCdEf123456" }, { unifiedpush: { origins: ["http://ntfy.example.test"] } })).toThrow();
});

test("Hub stops suppressing pushes when a silent foreground socket goes stale (e.g. Android Doze)", async () => {
  const hubDir = await mkdtemp(path.join(os.tmpdir(), "push-presence-"));
  const hub = await HubServer.start({ stateDir: hubDir, foregroundTimeoutMs: 120 });
  const keys = generateKeyPairSync("ed25519");
  const pair = await hub.auth.pair({ deviceId: "android_phone", name: "Phone", platform: "android", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, "local");
  await hub.auth.approve(pair.code, "local-owner");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot_presence','Alpha',?)", [hashSecret("test-secret")]);
  await hub.store.db.run("UPDATE devices SET push_json=? WHERE id='android_phone'", [JSON.stringify(subscription)]);
  await hub.store.db.run("INSERT INTO device_preferences VALUES('android_phone',?)", [JSON.stringify(notificationPreferencesSchema.parse({ enabled: true }))]);
  const chat = (await hub.store.createConversation("owner", ["bot_presence"], "Presence chat", "create")).id;
  const ws = new WebSocket(hub.url.replace(/^http/, "ws") + "/ws");
  const nonce = randomBytes(16).toString("hex");
  const ready = new Promise<void>((resolve, reject) => {
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ v: 1, type: "hello", deviceId: "android_phone", nonce, protocolVersions: [1], capabilities: [], cursors: {} })));
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { type: string; nonce?: string };
      if (frame.type === "challenge") {
        ws.send(JSON.stringify({ v: 1, type: "auth", signature: sign(null, deviceProof("android_phone", frame.nonce!, nonce), keys.privateKey).toString("base64") }));
      } else if (frame.type === "ready") {
        resolve();
      }
    });
  });
  try {
    await ready;
    ws.send(JSON.stringify({ v: 1, type: "presence", foreground: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Active foreground device suppresses push delivery.
    const first = await hub.store.publishBotMessage("bot_presence", { conversationId: chat, blocks: [{ type: "text", text: "first while active" }] });
    await hub.store.db.run("UPDATE push_outbox SET next_at=0 WHERE device_id='android_phone'");
    await (hub as unknown as { pushWorker: PushWorker }).pushWorker.tick();
    const firstRow = await hub.store.db.get<{ status: string }>("SELECT status FROM push_outbox WHERE payload_json LIKE ?", [`%${first.id}%`]);
    expect(firstRow?.status).toBe("suppressed");
    // Wait beyond foregroundTimeoutMs without sending any pings (simulates frozen background WebView).
    await new Promise((resolve) => setTimeout(resolve, 180));
    const second = await hub.store.publishBotMessage("bot_presence", { conversationId: chat, blocks: [{ type: "text", text: "second while frozen" }] });
    await hub.store.db.run("UPDATE push_outbox SET next_at=0 WHERE device_id='android_phone' AND status='pending'");
    await (hub as unknown as { pushWorker: PushWorker }).pushWorker.tick();
    const secondRow = await hub.store.db.get<{ status: string }>("SELECT status FROM push_outbox WHERE payload_json LIKE ?", [`%${second.id}%`]);
    // Because FCM isn't configured on this test Hub, a non-suppressed delivery stays pending (deferred unconfigured) instead of being permanently suppressed.
    expect(secondRow?.status).toBe("pending");
  } finally {
    ws.close();
    await hub.close();
    await rm(hubDir, { recursive: true, force: true });
  }
});
test("FCM uses signed short-lived tokens and non-collapsible data messages with independent ids", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }); const file = path.join(root, "fcm.json");
  await writeFile(file, JSON.stringify({ project_id: "test-project", client_email: "service@test-project.iam.gserviceaccount.com", private_key: keys.privateKey.export({ type: "pkcs8", format: "pem" }) }), { mode: 0o600 });
  const requests: { url: string; body: string }[] = [];
  const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: String(init?.body) });
    if (String(url).includes("oauth2")) { const params = new URLSearchParams(String(init?.body)); const parts = params.get("assertion")!.split("."); expect(verify("sha256", Buffer.from(parts.slice(0, 2).join(".")), keys.publicKey, Buffer.from(parts[2]!, "base64url"))).toBe(true); return new Response(JSON.stringify({ access_token: "test-access-token", expires_in: 3600 })); }
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-access-token"); return new Response(JSON.stringify({ name: "receipt" }));
  }) as typeof fetch;
  const sender = createPushSender({ fcm: { serviceAccountFile: file } }, request); const payload: PushPayload = { id: "push_one", title: "TaroCub", body: "新提醒", conversationId: conversation, messageId: "message_one", hostId: `hub_${"a".repeat(64)}`, kind: "answer", at: now };
  await Promise.all([sender({ provider: "fcm", token: subscription.token }, payload), sender({ provider: "fcm", token: subscription.token }, { ...payload, id: "push_two" })]);
  expect(requests.filter((r) => r.url.includes("oauth2"))).toHaveLength(1); const bodies = requests.filter((r) => r.url.includes("fcm.googleapis")).map((r) => JSON.parse(r.body) as { message: { notification?: unknown; data: { id: string; hostId?: string }; android: { collapse_key?: string } } });
  expect(bodies).toHaveLength(2); expect(bodies.map((b) => b.message.data.id).sort()).toEqual(["push_one", "push_two"]); for (const b of bodies) { expect(b.message.data.hostId).toBe(payload.hostId); expect(b.message.notification).toBeUndefined(); expect(b.message.android.collapse_key).toBeUndefined(); }
});

test("UnifiedPush encrypts independent notifications with the Android connector's Web Push keys", async () => {
  const client = createECDH("prime256v1"); const publicKey = client.generateKeys(); const auth = randomBytes(16);
  const subscription = { provider: "unifiedpush" as const, endpoint: "https://ntfy.example.test/upabcdefghijklmnop", keys: { p256dh: publicKey.toString("base64url"), auth: auth.toString("base64url") } };
  const received: PushPayload[] = [];
  const sender = createPushSender({ unifiedpush: { origins: ["https://ntfy.example.test"] } }, async (url, init) => {
    expect(String(url)).toBe(subscription.endpoint); expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers); expect(headers.get("content-encoding")).toBe("aes128gcm"); expect(headers.has("topic")).toBe(false);
    const body = Buffer.from(init?.body as Uint8Array); expect(body.includes(Buffer.from("TaroCub"))).toBe(false);
    const salt = body.subarray(0, 16); const keyLength = body[20]!; const serverKey = body.subarray(21, 21 + keyLength); const encrypted = body.subarray(21 + keyLength);
    const info = Buffer.concat([Buffer.from("WebPush: info\0"), publicKey, serverKey]);
    const ikm = Buffer.from(hkdfSync("sha256", client.computeSecret(serverKey), auth, info, 32));
    const key = hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
    const nonce = hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
    const decipher = createDecipheriv("aes-128-gcm", Buffer.from(key), Buffer.from(nonce)); decipher.setAuthTag(encrypted.subarray(-16));
    const decoded = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]); expect(decoded.at(-1)).toBe(2);
    received.push(JSON.parse(decoded.subarray(0, -1).toString()) as PushPayload); return new Response("ok");
  });
  for (let i = 0; i < 3; i++) expect(await sender(subscription, { id: `push_${i}`, title: "TaroCub", body: "新提醒", conversationId: conversation, messageId: `message_${i}`, kind: "answer", at: now })).toBe("sent");
  expect(received.map((entry) => entry.id)).toEqual(["push_0", "push_1", "push_2"]);
});

test.each(["partial", "error", "interrupted"])("scoped %s notifications preserve uncertainty without claiming routine updates failed", async phase => {
  await store.publishBotMessage("alpha", { conversationId: conversation, status: "complete", blocks: [{ type: "card", elements: [
    { type: "markdown", text: "**后台任务更新**" },
    { type: "markdown", id: "background_context", text: "后台任务回报 · 这是关联请求的后续通知。" },
    { type: "markdown", text: "构建检查仍然正常。" },
  ], extra: { backgroundTask: { version: 1, origin: "bound" }, scopedRun: { version: 1, id: "monitor", revision: 2, phase, startedAt: 1, updatedAt: 2, count: 1, completed: 1, failed: 0, truncated: false } } }] });
  const row = await store.db.get<{ payload_json: string }>("SELECT payload_json FROM push_outbox LIMIT 1");
  const payload = JSON.parse(row!.payload_json);
  expect(payload.kind).toBe(phase === "partial" ? "answer" : "error");
  expect(payload.body).toBe(`「Private conversation」 · Alpha\n${phase === "partial" ? "后台任务更新" : "任务未完成"}：构建检查仍然正常。`);
});

test.each(["后台任务失败", "后台任务已中断", "Background task failed"])("legacy static notice retains its failure status: %s", async header => {
  await store.publishBotMessage("alpha", { conversationId: conversation, blocks: [{ type: "card", elements: [{ type: "markdown", text: `**${header}**` }, { type: "markdown", id: "background_context", text: "后台任务回报 · 来源说明" }, { type: "markdown", text: "exit 1" }], extra: { backgroundTask: { version: 1, origin: "bound" } } }] });
  const row = await store.db.get<{ payload_json: string }>("SELECT payload_json FROM push_outbox LIMIT 1");
  expect(JSON.parse(row!.payload_json)).toMatchObject({ kind: "error", body: `「Private conversation」 · Alpha\n任务未完成：${header} exit 1` });
});
test("unconfirmed artifact delivery cannot become a routine background update", async () => {
  await store.publishBotMessage("alpha", { conversationId: conversation, blocks: [{ type: "card", elements: [{ type: "markdown", text: "后台任务更新" }, { type: "markdown", id: "background_context", text: "关联请求" }, { type: "markdown", text: "成片已导出：final.mp4" }], extra: { backgroundTask: { version: 1, origin: "bound", delivery: "unconfirmed", status: "unknown" }, scopedRun: { version: 1, id: "delivery", revision: 1, phase: "partial", startedAt: 1, updatedAt: 2, count: 0, completed: 0, failed: 0, truncated: false } } }] });
  const row = await store.db.get<{ payload_json: string }>("SELECT payload_json FROM push_outbox LIMIT 1");
  expect(JSON.parse(row!.payload_json)).toMatchObject({ kind: "error", body: "「Private conversation」 · Alpha\n交付未确认：成片已导出：final.mp4" });
});

test.each([false, true])("an ongoing static background notice never announces completion (structured=%s)", async structured => {
  await store.publishBotMessage("alpha", { conversationId: conversation, blocks: [{ type: "card", elements: [{ type: "markdown", text: "后台任务执行中" }, { type: "markdown", id: "background_context", text: "关联请求" }, { type: "markdown", text: "仍在处理第二批文件。" }], extra: { backgroundTask: { version: 1, origin: "bound", ...(structured ? { status: "running" } : {}) } } }] });
  const row = await store.db.get<{ payload_json: string }>("SELECT payload_json FROM push_outbox LIMIT 1");
  expect(JSON.parse(row!.payload_json)).toMatchObject({ kind: "answer", body: "「Private conversation」 · Alpha\n后台任务更新：仍在处理第二批文件。" });
});


test.each(["cancelled", "malformed", "native"] as const)("Bus cancellation notification respects validated markers and foreground evidence: %s", async kind => {
  const marker = kind === "malformed" ? { status: "cancelled" } : { runId: "abr_test", workspaceId: "ab_test", stageId: "s1", status: "cancelled" };
  const foreground = kind === "native" ? { nativeRun: { version: 1, id: "run_one", revision: 2, phase: "done", startedAt: 1, updatedAt: 2, endedAt: 2, count: 1, completed: 1, failed: 0, truncated: false } } : {};
  await store.publishBotMessage("alpha", { conversationId: conversation, status: "complete", blocks: [{ type: "card", elements: [{ type: "markdown", text: "已停止" }], extra: { agentBusStage: marker, ...foreground } }] });
  expect(await store.db.all("SELECT id FROM push_outbox")).toHaveLength(kind === "cancelled" ? 0 : 1);
});
