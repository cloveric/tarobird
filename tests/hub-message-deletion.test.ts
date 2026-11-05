import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it } from "vitest";
import { HubStore } from "../src/hub/store.js";
import { conversationFiles } from "../src/hub/conversation-files.js";
import { type HubEvent, type Message } from "../src/client-protocol/index.js";

let root: string, store: HubStore, conversationId: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "personal-delete-")); store = await HubStore.open(root);
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
  await store.db.run("INSERT INTO users VALUES('member','Member','member'),('outsider','Outsider','member')");
  conversationId = (await store.createConversation("owner", ["bot"], "Chat", "chat")).id;
  await store.db.run("INSERT INTO conversation_members VALUES(?,'user','member',0)", [conversationId]);
});
afterEach(async () => { await store.db.close(); await rm(root, { recursive: true, force: true }); });
const publish = (text: string, status: Message["status"] = "complete") => store.publishBotMessage("bot", { conversationId, blocks: [{ type: "text", text }], status });

it("keeps personal tombstones durable across replay, snapshot, later streaming edits, and restart without recalling shared history", async () => {
  const input = (await store.sendMessage("owner", { conversationId, clientMsgId: "input", text: "original input", attachments: [] })).message;
  const output = await publish("original answer", "streaming"), events: HubEvent[] = []; store.subscribe(event => events.push(event));
  expect(await store.deleteMessages("owner", conversationId, { messageIds: [input.id, output.id, input.id] })).toEqual({ deletedIds: [input.id, output.id] });
  expect(events.filter(event => event.kind === "message.deleted")).toHaveLength(2);
  const own = await store.eventProjections(events.find(event => event.kind === "message.deleted" && (event.payload as any).message.id === output.id)!, ["owner", "member"]);
  expect(own.get("owner")).toMatchObject({ kind: "message.updated", payload: { id: output.id, status: "deleted", blocks: [] } });
  expect(own.get("member")).toMatchObject({ kind: "message.deleted", payload: {} });
  expect((await store.pendingForBot("bot")).map(message => message.id)).toContain(input.id);
  expect(await store.messageForBot("bot", input.id)).toMatchObject({ status: "complete", blocks: input.blocks, version: 1 });
  const final = await store.publishBotMessage("bot", { id: output.id, conversationId, blocks: [{ type: "text", text: "final answer" }], status: "complete" });
  const sync = await store.sync("owner", conversationId, 0);
  for (const event of sync.events.filter(event => ["message.created", "message.updated"].includes(event.kind))) expect(event.payload).toMatchObject({ status: "deleted", blocks: [] });
  expect((await store.snapshot("member", conversationId)).messages).toEqual([input, final]);
  await expect(store.messageForUser("owner", output.id)).rejects.toThrow("message_not_found");
  expect((await store.listMessages("owner", conversationId)).messages).toEqual([]);
  const frames = []; for await (const frame of store.snapshotFrames("owner", conversationId, 0)) frames.push(frame);
  expect(frames.filter(frame => frame.type === "snapshot.message").every(frame => frame.message.status === "deleted" && !frame.message.blocks.length)).toBe(true);
  const seq = (await store.syncHead("owner", conversationId)).seq;
  await store.deleteMessages("owner", conversationId, { messageIds: [input.id, output.id] });
  expect((await store.syncHead("owner", conversationId)).seq).toBe(seq);
  await store.db.close(); store = await HubStore.open(root);
  expect((await store.snapshot("owner", conversationId)).messages.every(message => message.status === "deleted")).toBe(true);
  expect((await store.snapshot("member", conversationId)).messages).toEqual([input, final]);
});

it("checks membership, transaction-time auth, full batch validity, size and scope before any deletion", async () => {
  const message = await publish("keep"), other = await store.createConversation("owner", ["bot"], "Other", "other");
  const wrong = await store.publishBotMessage("bot", { conversationId: other.id, blocks: [] });
  for (const ids of [[message.id, "missing"], [message.id, wrong.id]]) await expect(store.deleteMessages("owner", conversationId, { messageIds: ids })).rejects.toThrow("message_not_found");
  await expect(store.deleteMessages("outsider", conversationId, { messageIds: [message.id] })).rejects.toThrow("conversation_forbidden");
  await expect(store.deleteMessages("owner", conversationId, { messageIds: [message.id] }, async () => { throw new Error("revoked"); })).rejects.toThrow("revoked");
  await expect(store.deleteMessages("owner", conversationId, { messageIds: [] })).rejects.toThrow();
  await expect(store.deleteMessages("owner", conversationId, { messageIds: Array(101).fill(message.id) })).rejects.toThrow();
  expect(await store.db.all("SELECT * FROM message_deletions")).toEqual([]);
  expect(await store.messageForUser("owner", message.id)).toEqual(message);
});

it("removes only the deleting user's search/file results and stale reply/forward sources, retaining shared attachments", async () => {
  await store.db.run("INSERT INTO attachments VALUES('attachment',?,'owner',?,3,'application/pdf','notes.pdf','attachment.blob',1,?)", [conversationId, "a".repeat(64), Date.now()]);
  const message = await store.publishBotMessage("bot", { conversationId, blocks: [{ type: "text", text: "searchable notes" }, { type: "file", attachmentId: "attachment", name: "notes.pdf", size: 3, mime: "application/pdf" }] });
  await store.deleteMessages("owner", conversationId, { messageIds: [message.id] });
  expect(await store.search("owner", "searchable")).toEqual([]);
  expect((await store.searchPage("owner", "searchable")).items).toEqual([]);
  expect(await store.search("member", "searchable")).toHaveLength(1);
  expect((await conversationFiles(store, "owner", { conversationId, q: "" })).items).toEqual([]);
  expect((await conversationFiles(store, "member", { conversationId, q: "" })).items).toHaveLength(1);
  expect(await store.db.all("SELECT * FROM retired_attachments")).toEqual([]);
  await expect(store.sendMessage("owner", { conversationId, clientMsgId: "reply", text: "reply", replyTo: message.id, attachments: [] })).rejects.toThrow("reply_not_found");
  await expect(store.forwardMessage("owner", { v: 1, type: "message.forward", conversationId, clientMsgId: "forward", sourceMessageId: message.id }, async () => {})).rejects.toThrow("message_not_found");
  expect(await store.messageForUser("member", message.id)).toEqual(message);
});

it("cancels only the deleting user's pending notifications and suppresses later pushes for hidden messages", async () => {
  const subscription = JSON.stringify({ provider: "fcm", token: "fixture_token_" + "x".repeat(40) });
  for (const user of ["owner", "member"]) await store.db.run("INSERT INTO devices VALUES(?,?,?,'android','fixture',0,1,1,?)", [`device_${user}`, user, user, subscription]);
  for (const user of ["owner", "member"]) await store.db.run("INSERT INTO device_preferences VALUES(?,?)", [`device_${user}`, JSON.stringify({ enabled: true })]);
  const first = await publish("first notification");
  expect(await store.db.all("SELECT id FROM push_outbox WHERE status='pending'")).toHaveLength(2);
  await store.deleteMessages("owner", conversationId, { messageIds: [first.id] });
  expect(await store.db.all("SELECT device_id FROM push_outbox WHERE status='pending'")).toEqual([{ device_id: "device_member" }]);
  const live = await publish("ongoing", "streaming");
  await store.deleteMessages("owner", conversationId, { messageIds: [live.id] });
  await store.publishBotMessage("bot", { id: live.id, conversationId, blocks: [], status: "complete" });
  expect(await store.db.all("SELECT device_id FROM push_outbox WHERE json_extract(payload_json,'$.messageId')=?", [live.id])).toEqual([{ device_id: "device_member" }]);
});

it("does not reinterpret unrelated legacy events, but never rediscloses hidden malformed content", async () => {
  const { personalMessageEvent } = await import("../src/client-protocol/message-deletion.js");
  const legacy: HubEvent = { v: 1, type: "event", conversationId, seq: 1, at: 1, kind: "message.updated", payload: { id: "legacy", blocks: "old format" } };
  expect(personalMessageEvent(legacy, "owner", new Set())).toBe(legacy);
  expect(personalMessageEvent(legacy, "owner", new Set(["another"]))).toBe(legacy);
  expect(personalMessageEvent(legacy, "owner", new Set(["legacy"]))).toMatchObject({ kind: "message.deleted", payload: {} });
});
