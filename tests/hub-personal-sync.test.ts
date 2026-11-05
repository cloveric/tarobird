import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubStore } from "../src/hub/store.js";
import { HubDatabase } from "../src/hub/database.js";
import { deletedMessage } from "../src/client-protocol/message-deletion.js";
import type { SnapshotFrame } from "../src/client-protocol/snapshot.js";

let root: string, store: HubStore, chat: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "personal-sync-")); store = await HubStore.open(root);
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
  await store.db.run("INSERT INTO users VALUES('member','Member','member')");
  chat = (await store.createConversation("owner", ["bot"], "Chat", "chat")).id;
  await store.db.run("INSERT INTO conversation_members VALUES(?,'user','member',0)", [chat]);
});
afterEach(async () => { vi.restoreAllMocks(); await store?.db.close(); await rm(root, { recursive: true, force: true }); });
const publish = (text: string) => store.publishBotMessage("bot", { conversationId: chat, blocks: [{ type: "text", text }] });
const snapshot = async (user: string, after: number) => {
  const frames: SnapshotFrame[] = [];
  for await (const frame of store.snapshotFrames(user, chat, after, { incremental: true })) frames.push(frame);
  return frames;
};

it.each([false, true])("does not load personally hidden bodies into snapshot pages (merge=%s)", async merge => {
  const hidden = await publish("x".repeat(256 * 1024));
  const after = (await store.syncHead("owner", chat)).seq;
  await store.deleteMessages("owner", chat, { messageIds: [hidden.id] });
  const visible = await publish("visible");
  const original = HubDatabase.prototype.all; let loadedBodyBytes = 0;
  vi.spyOn(HubDatabase.prototype, "all").mockImplementation(async function (this: HubDatabase, sql, params) {
    const rows = await original.call(this, sql, params);
    for (const row of rows as { blocks_json?: string }[]) if (row.blocks_json) loadedBodyBytes += Buffer.byteLength(row.blocks_json);
    return rows as never;
  });
  const frames = await snapshot("owner", merge ? after : 0);
  expect(frames[0]).toMatchObject({ type: "snapshot.begin", ...(merge ? { mode: "merge" } : {}) });
  expect(frames.flatMap(f => f.type === "snapshot.message" ? [f.message] : [])).toEqual([deletedMessage(hidden), visible]);
  expect(loadedBodyBytes).toBeLessThan(1024);
  vi.restoreAllMocks();
  const memberFrames = await snapshot("member", 0);
  expect(memberFrames.flatMap(f => f.type === "snapshot.message" ? [f.message] : [])).toEqual([hidden, visible]);
});

it("an empty replay does not read deleted history", async () => {
  const messages = await Promise.all(Array.from({ length: 20 }, (_, i) => publish(`hidden ${i}`)));
  await store.deleteMessages("owner", chat, { messageIds: messages.map(m => m.id) });
  const head = (await store.syncHead("owner", chat)).seq;
  const all = vi.spyOn(store.db, "all");
  expect(await store.sync("owner", chat, head, 1)).toEqual({ events: [], more: false });
  expect((await Promise.all(all.mock.results.map(r => r.value))).flat()).toEqual([]);
});

it("replay reads only this page's deletion markers and preserves historical versions and other members", async () => {
  const older = await Promise.all(Array.from({ length: 20 }, (_, i) => publish(`older ${i}`)));
  await store.deleteMessages("owner", chat, { messageIds: older.map(m => m.id) });
  const after = (await store.syncHead("owner", chat)).seq;
  const hidden = await publish("private older version");
  const visible = await publish("visible");
  await store.deleteMessages("owner", chat, { messageIds: [hidden.id] });
  const latest = await store.publishBotMessage("bot", { id: hidden.id, conversationId: chat, blocks: [{ type: "text", text: "private newer version" }] });
  const original = store.db.all.bind(store.db); let markers = 0;
  const get = vi.spyOn(store.db, "get");
  const markerReads = () => get.mock.calls.filter(([sql]) => sql.includes("FROM message_deletions")).length;
  vi.spyOn(store.db, "all").mockImplementation(async (sql, params) => {
    const rows = await original(sql, params);
    markers += rows.filter(r => !!r && typeof r === "object" && "message_id" in r).length;
    return rows as never;
  });
  const first = await store.sync("owner", chat, after, 2);
  expect(first.events.map(e => e.payload)).toEqual([deletedMessage(hidden), visible]);
  expect(first.more).toBe(true); expect(markers).toBeLessThanOrEqual(1);
  expect(markerReads()).toBeLessThanOrEqual(2);
  get.mockClear();
  const rest = await store.sync("owner", chat, first.events.at(-1)!.seq, 2);
  expect(rest.events.map(e => e.payload)).toEqual([deletedMessage(hidden), deletedMessage(latest)]);
  expect(rest.more).toBe(false);
  expect(markerReads()).toBeLessThanOrEqual(1);
  expect((await store.sync("member", chat, after, 2)).events.map(e => e.payload)).toEqual([hidden, visible]);
});

it.each([false, true])("snapshot tombstones retain updated versions and client IDs across pages (merge=%s)", async merge => {
  const { message: user } = await store.sendMessage("owner", { conversationId: chat, clientMsgId: "retained-client-id", text: "user text", attachments: [] });
  const messages = [user, ...await Promise.all(Array.from({ length: 19 }, (_, i) => publish(`body ${i}`)))];
  const after = (await store.syncHead("owner", chat)).seq;
  await store.deleteMessages("owner", chat, { messageIds: messages.map(m => m.id) });
  const latest = await store.publishBotMessage("bot", { id: messages[1]!.id, conversationId: chat, blocks: [{ type: "text", text: "edited after hide" }] });
  messages[1] = latest;
  const frames = await snapshot("owner", merge ? after : 0);
  const projected = frames.filter(f => f.type === "snapshot.message");
  expect(projected.map(f => f.index)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  expect(projected.map(f => f.message)).toEqual(messages.map(deletedMessage));
  expect(frames.at(-1)).toMatchObject({ type: "snapshot.end", count: 20 });
  expect((await snapshot("member", 0)).flatMap(f => f.type === "snapshot.message" ? [f.message] : [])).toEqual(messages);
});

it("replay keeps its projected-byte limit and does not prefetch the remaining large events", async () => {
  const messages = [];
  for (let n = 0; n < 4; n++) messages.push(await publish("x".repeat(3 * 1024 * 1024)));
  const get = vi.spyOn(store.db, "get");
  const first = await store.sync("owner", chat, 0);
  expect(first.events.map(e => (e.payload as { id: string }).id)).toEqual([messages[0]!.id]);
  expect(first.more).toBe(true);
  expect(get.mock.calls.filter(([sql]) => sql.startsWith("SELECT * FROM events"))).toHaveLength(2);
  await store.deleteMessages("owner", chat, { messageIds: messages.map(m => m.id) });
  const hidden = await store.sync("owner", chat, 0, 4);
  expect(hidden.events.map(e => e.payload)).toEqual(messages.map(deletedMessage));
  expect(hidden.more).toBe(true); // Personal hide receipts follow the four created events.
});
