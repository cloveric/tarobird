import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HubStore } from "../src/hub/store.js";
import { MessageActivityIndex, readConversationActivity } from "../src/hub/message-activity.js";
import { MESSAGE_ACTIVITY_SCHEMA } from "../src/hub/message-activity-sql.js";
import type { SnapshotFrame } from "../src/client-protocol/snapshot.js";

type Activity = { contentSeq: number; contentAt: number; unreadSeq: number };
const TRIGGER = "events_message_activity_v1";

// The former snapshot query, kept verbatim as the oracle for exact semantics.
async function legacyActivity(store: HubStore, conversationId: string): Promise<Map<string, Activity>> {
  const rows = await store.db.all<{ id: string } & Activity>(`
    WITH history AS (
      SELECT seq,at,json_extract(payload_json,'$.id') AS id,
        json_extract(payload_json,'$.authorType') AS author,
        json_extract(payload_json,'$.status') AS status,
        LAG(json_extract(payload_json,'$.status')) OVER (PARTITION BY json_extract(payload_json,'$.id') ORDER BY seq) AS previous
      FROM events WHERE conversation_id=? AND kind IN ('message.created','message.updated')
    ), activity AS (SELECT id,CASE WHEN author='user' THEN MIN(seq) ELSE MAX(seq) END AS contentSeq,
      COALESCE(MAX(CASE WHEN author='bot' AND status IN ('complete','error') AND (previous IS NULL OR previous IN ('pending','streaming')) THEN seq END),0) AS unreadSeq
      FROM history GROUP BY id)
    SELECT activity.*,history.at AS contentAt FROM activity JOIN history ON history.seq=activity.contentSeq`, [conversationId]);
  return new Map(rows.map(({ id, contentSeq, contentAt, unreadSeq }) => [id, { contentSeq, contentAt, unreadSeq }]));
}
async function legacyChanged(store: HubStore, conversationId: string, after: number, userId: string): Promise<Set<string>> {
  const rows = await store.db.all<{ id: string }>(`SELECT json_extract(payload_json,'$.id') AS id FROM events WHERE conversation_id=? AND seq>? AND kind IN ('message.created','message.updated')
    UNION SELECT json_extract(payload_json,'$.message.id') FROM events WHERE conversation_id=? AND seq>? AND kind='message.deleted' AND json_extract(payload_json,'$.userId')=?`, [conversationId, after, conversationId, after, userId]);
  return new Set(rows.map(row => row.id));
}
const strip = (map: Map<string, Activity & { lastSeq?: number }>) => new Map([...map].map(([id, { contentSeq, contentAt, unreadSeq }]) => [id, { contentSeq, contentAt, unreadSeq }]));
async function current(store: HubStore, conversationId: string) {
  const head = (await store.db.get<{ seq: number }>("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE conversation_id=?", [conversationId]))!.seq;
  return { head, ...(await readConversationActivity(store.db, conversationId, head)) };
}
async function coverage(store: HubStore, conversationId: string) {
  return (await store.db.get<{ through_seq: number }>("SELECT through_seq FROM conversation_activity WHERE conversation_id=?", [conversationId]))?.through_seq;
}

// Deterministic random journals covering every status transition, authors,
// re-streaming after completion, personal deletions, reads and other kinds.
function random(seed: number) { return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const statuses = ["pending", "streaming", "complete", "error", "deleted"] as const;
async function randomJournal(store: HubStore, conversationId: string, seed: number, steps: number, insert: (kind: string, payload: unknown, at: number) => Promise<void>) {
  const next = random(seed), pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)]!;
  const messages: { id: string; authorType: string }[] = [];
  let at = 1_700_000_000_000;
  for (let step = 0; step < steps; step++) {
    at += Math.floor(next() * 3); // includes equal timestamps
    const roll = next();
    if (!messages.length || roll < 0.2) {
      const message = { id: `m${seed}_${messages.length}`, authorType: pick(["bot", "bot", "user", "system"]) };
      messages.push(message);
      await insert("message.created", { ...message, conversationId, status: pick(statuses.slice(0, 4)), blocks: [] }, at);
    } else if (roll < 0.8) await insert("message.updated", { ...pick(messages), conversationId, status: pick(statuses), blocks: [] }, at);
    else if (roll < 0.88) await insert("message.deleted", { userId: pick(["owner", "member"]), message: { ...pick(messages), status: "deleted" } }, at);
    else if (roll < 0.94) await insert("read", { userId: "owner", seq: step }, at);
    else await insert("turn.state", { groupSettings: { revision: step } }, at);
  }
}

let root: string, store: HubStore;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "message-activity-")); store = await HubStore.open(root);
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
  await store.db.run("INSERT INTO users VALUES('member','Member','member')");
});
afterEach(async () => { await store.db.close(); await rm(root, { recursive: true, force: true }); });
// A raw journal writer, like an older Hub without this module, through the same queue.
const raw = (conversationId: string) => (kind: string, payload: unknown, at: number) => store.db.transaction(async () => {
  const { seq } = (await store.db.get<{ seq: number }>("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM events WHERE conversation_id=?", [conversationId]))!;
  await store.db.run("INSERT INTO events VALUES(?,?,?,?,?)", [conversationId, seq, kind, typeof payload === "string" ? payload : JSON.stringify(payload), at]);
});
const conversation = async (name: string) => (await store.createConversation("owner", ["bot"], name, name)).id;

describe("compact message activity", () => {
  it("matches the former journal query through the trigger, bounded repair and in-memory tail", async () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const id = await conversation(`seed-${seed}`);
      await randomJournal(store, id, seed, 400, raw(id));
      const oracle = await legacyActivity(store, id);
      // 1. Trigger-maintained coverage for every writer.
      const live = await current(store, id);
      expect(live.tail).toBe(0); expect(live.indexed).toBe(true); expect(await coverage(store, id)).toBe(live.head);
      expect(strip(live.activity)).toEqual(oracle);
      // 2. Change sets for a merge after any cursor, including personal deletions.
      for (const after of [0, 1, 37, 150, 399, live.head]) for (const userId of ["owner", "member"]) {
        const change = await readConversationActivity(store.db, id, live.head, { after, userId });
        expect(change.changed).toEqual(await legacyChanged(store, id, after, userId));
        for (const [message, value] of change.activity) expect(strip(new Map([[message, value]]))).toEqual(new Map([[message, oracle.get(message)]]));
      }
      // 3. Bounded rebuild from stale rows without a watermark.
      await store.db.run("DELETE FROM conversation_activity WHERE conversation_id=?", [id]);
      await store.db.run("UPDATE message_activity SET unread_seq=-1 WHERE conversation_id=?", [id]);
      const index = new MessageActivityIndex(store.db, { batch: 7 });
      await index.ensure(id); await index.stop();
      expect(index.stats.maxBatchEvents).toBeLessThanOrEqual(14);
      expect(await coverage(store, id)).toBe(live.head);
      expect(strip((await current(store, id)).activity)).toEqual(oracle);
    }
  }, 20_000); // Thousands of journal/repair writes also run on shared external disks.

  it("stays exact when a writer without the trigger leaves a gap, then repairs it in bounded batches", async () => {
    const id = await conversation("gap"), insert = raw(id);
    await randomJournal(store, id, 11, 150, insert);
    const covered = await coverage(store, id);
    await store.db.exec(`DROP TRIGGER ${TRIGGER}`);
    await randomJournal(store, id, 12, 300, insert);
    const gap = await current(store, id);
    expect(await coverage(store, id)).toBe(covered);
    expect(gap.tail).toBe(gap.head - covered!); expect(gap.indexed).toBe(false);
    expect(strip(gap.activity)).toEqual(await legacyActivity(store, id));
    // Reopening restores the trigger; it must not fold out of order while behind.
    await store.db.exec(MESSAGE_ACTIVITY_SCHEMA);
    await randomJournal(store, id, 13, 20, insert);
    expect(await coverage(store, id)).toBe(covered);
    expect(await store.activityIndex.lagging()).toEqual([id]);
    const index = new MessageActivityIndex(store.db, { batch: 32 });
    await index.ensure(id); await index.stop();
    expect(index.stats.maxBatchEvents).toBeLessThanOrEqual(64);
    const repaired = await current(store, id);
    expect(repaired.tail).toBe(0); expect(strip(repaired.activity)).toEqual(await legacyActivity(store, id));
    await randomJournal(store, id, 14, 30, insert);
    expect(await coverage(store, id)).toBe((await current(store, id)).head);
    expect(strip((await current(store, id)).activity)).toEqual(await legacyActivity(store, id));
  });

  it("never fails a journal insert on malformed payloads and still advances coverage", async () => {
    const id = await conversation("malformed"), insert = raw(id);
    await insert("message.updated", "{not json", 1);
    await insert("message.created", { id: "valid", authorType: "bot", status: "complete" }, 2);
    expect(await coverage(store, id)).toBe(2);
    expect(strip((await current(store, id)).activity)).toEqual(new Map([["valid", { contentSeq: 2, contentAt: 2, unreadSeq: 2 }]]));
  });

  it("serves snapshots without reparsing historical event bodies", async () => {
    const id = await conversation("bodies");
    const input = (await store.sendMessage("owner", { conversationId: id, clientMsgId: "q", text: "question", attachments: [] })).message;
    let answer = await store.publishBotMessage("bot", { conversationId: id, blocks: [{ type: "text", text: "a" }], status: "streaming" });
    for (let i = 0; i < 40; i++) answer = await store.publishBotMessage("bot", { id: answer.id, conversationId: id, blocks: [{ type: "text", text: "a".repeat(i + 2) }], status: "streaming", version: answer.version + 1 });
    answer = await store.publishBotMessage("bot", { id: answer.id, conversationId: id, blocks: [{ type: "text", text: "done" }], status: "complete", version: answer.version + 1 });
    const expected = await legacyActivity(store, id);
    const head = (await store.syncHead("owner", id)).seq;
    // Corrupt every historical body: the former query can no longer run.
    await store.db.run("UPDATE events SET payload_json='{broken' WHERE conversation_id=? AND seq<?", [id, head]);
    await expect(legacyActivity(store, id)).rejects.toThrow(/malformed JSON/);
    const frames: SnapshotFrame[] = []; for await (const frame of store.snapshotFrames("owner", id, 0)) frames.push(frame);
    const messages = frames.filter((frame): frame is Extract<SnapshotFrame, { type: "snapshot.message" }> => frame.type === "snapshot.message");
    expect(messages.map(frame => frame.message.id)).toEqual([input.id, answer.id]);
    for (const frame of messages) expect({ contentSeq: frame.contentSeq, contentAt: frame.contentAt, unreadSeq: frame.unreadSeq }).toEqual(expected.get(frame.message.id));
  });

  it("emits merge snapshots with only changed and newly hidden messages", async () => {
    const id = await conversation("merge");
    await store.db.run("INSERT INTO conversation_members VALUES(?,'user','member',0)", [id]);
    const old = await store.publishBotMessage("bot", { conversationId: id, blocks: [{ type: "text", text: "old" }] });
    const hiddenLater = await store.publishBotMessage("bot", { conversationId: id, blocks: [{ type: "text", text: "hide me" }] });
    const edited = await store.publishBotMessage("bot", { conversationId: id, blocks: [{ type: "text", text: "draft" }], status: "streaming" });
    const cursor = (await store.syncHead("owner", id)).seq;
    await store.publishBotMessage("bot", { id: edited.id, conversationId: id, blocks: [{ type: "text", text: "final" }], status: "complete", version: edited.version + 1 });
    const added = (await store.sendMessage("owner", { conversationId: id, clientMsgId: "new", text: "new", attachments: [] })).message;
    await store.deleteMessages("owner", id, { messageIds: [hiddenLater.id] });
    await store.markRead("owner", id, cursor);
    const collect = async (after: number, userId = "owner", incremental = true) => { const frames: SnapshotFrame[] = []; for await (const frame of store.snapshotFrames(userId, id, after, { incremental })) frames.push(frame); return frames; };
    const merge = await collect(cursor), begin = merge[0] as Extract<SnapshotFrame, { type: "snapshot.begin" }>;
    expect(begin).toMatchObject({ mode: "merge", after: cursor, seq: (await store.syncHead("owner", id)).seq, readSeq: cursor });
    const sent = merge.filter((frame): frame is Extract<SnapshotFrame, { type: "snapshot.message" }> => frame.type === "snapshot.message");
    expect(sent.map(frame => frame.message.id)).toEqual([hiddenLater.id, edited.id, added.id]);
    expect(sent.map(frame => frame.index)).toEqual([0, 1, 2]);
    expect(sent[0]!.message).toMatchObject({ status: "deleted", blocks: [] });
    expect(merge.at(-1)).toMatchObject({ type: "snapshot.end", count: 3 });
    const oracle = await legacyActivity(store, id);
    for (const frame of sent) expect({ contentSeq: frame.contentSeq, contentAt: frame.contentAt, unreadSeq: frame.unreadSeq }).toEqual(oracle.get(frame.message.id));
    // The other member's merge does not include the owner's personal deletion.
    expect((await collect(cursor, "member")).filter(frame => frame.type === "snapshot.message").map(frame => frame.type === "snapshot.message" && frame.message.id)).toEqual([edited.id, added.id]);
    expect(await store.catchupPlan("owner", id, cursor)).toMatchObject({ changedMessages: 3, indexed: true });
    // No usable cursor, or a non-incremental client: the full snapshot shape.
    for (const frames of [await collect(0), await collect(10_000), await collect(cursor, "owner", false)]) {
      expect((frames[0] as { mode?: string }).mode).toBeUndefined();
      expect(frames.filter(frame => frame.type === "snapshot.message").map(frame => frame.type === "snapshot.message" && frame.message.id)).toEqual([old.id, hiddenLater.id, edited.id, added.id]);
    }
  });

  it("merges user enrichments by lastSeq and falls back to a full snapshot for unprovable removals", async () => {
    const id = await conversation("enrich");
    const linked = (await store.sendMessage("owner", { conversationId: id, clientMsgId: "link", text: "https://example.org/", attachments: [] })).message;
    const reply = await store.publishBotMessage("bot", { conversationId: id, blocks: [{ type: "text", text: "reply" }] });
    const created = (await store.syncHead("owner", id)).seq;
    const contentSeq = (await legacyActivity(store, id)).get(linked.id)!.contentSeq;
    await store.setLinkPreview(linked.id, { url: "https://example.org/", status: "ready", title: "Example", siteName: "Example" });
    const collect = async () => { const frames: SnapshotFrame[] = []; for await (const frame of store.snapshotFrames("owner", id, created, { incremental: true })) frames.push(frame); return frames; };
    const merge = await collect();
    expect(merge[0]).toMatchObject({ mode: "merge" });
    const sent = merge.filter((frame): frame is Extract<SnapshotFrame, { type: "snapshot.message" }> => frame.type === "snapshot.message");
    // The enrichment is a change even though its content sequence stays put.
    expect(sent.map(frame => frame.message.id)).toEqual([linked.id]);
    expect(sent[0]).toMatchObject({ contentSeq, message: { linkPreview: { title: "Example" } } });
    expect(await store.catchupPlan("owner", id, created)).toMatchObject({ changedMessages: 1, mergeable: true });
    // A journal change whose message row is gone cannot be merged safely.
    await raw(id)("message.updated", { id: "ghost_message", authorType: "bot", status: "complete", conversationId: id, blocks: [] }, Date.now());
    const full = await collect();
    expect((full[0] as { mode?: string }).mode).toBeUndefined();
    expect(full.filter(frame => frame.type === "snapshot.message").map(frame => frame.type === "snapshot.message" && frame.message.id)).toEqual([linked.id, reply.id]);
    expect(await store.catchupPlan("owner", id, created)).toMatchObject({ changedMessages: 2, mergeable: false });
  });

  it("distrusts a watermark ahead of the journal and rebuilds it", async () => {
    const id = await conversation("ahead");
    await randomJournal(store, id, 70, 200, raw(id));
    const head = (await current(store, id)).head, expected = await legacyActivity(store, id);
    await store.db.run("UPDATE conversation_activity SET through_seq=? WHERE conversation_id=?", [head + 50, id]);
    await store.db.run("UPDATE message_activity SET unread_seq=-7 WHERE conversation_id=?", [id]);
    const read = await current(store, id);
    expect(read.indexed).toBe(false); expect(read.tail).toBe(head);
    expect(strip(read.activity)).toEqual(expected);
    expect(await store.activityIndex.lagging()).toEqual([id]);
    const index = new MessageActivityIndex(store.db, { batch: 32 });
    await index.ensure(id); await index.stop();
    expect(index.stats.rebuiltConversations).toBe(1);
    expect(await coverage(store, id)).toBe(head);
    expect(strip((await current(store, id)).activity)).toEqual(expected);
  });

  it("falls back to a full snapshot when the cursor precedes a missing journal prefix", async () => {
    const id = await conversation("prefix");
    for (let i = 0; i < 20; i++) await store.publishBotMessage("bot", { conversationId: id, blocks: [{ type: "text", text: `m${i}` }] });
    await store.db.run("DELETE FROM events WHERE conversation_id=? AND seq<=10", [id]);
    const mode = async (after: number) => { for await (const frame of store.snapshotFrames("owner", id, after, { incremental: true })) return (frame as { mode?: string }).mode; };
    expect(await mode(5)).toBeUndefined();
    expect(await store.catchupPlan("owner", id, 5)).toMatchObject({ firstSeq: 11, mergeable: false });
    expect(await mode(15)).toBe("merge");
  });

  it("authorizes before starting any derived repair work", async () => {
    const id = await conversation("private");
    await store.db.run("INSERT INTO users VALUES('outsider','Outsider','member')");
    await store.db.exec(`DROP TRIGGER ${TRIGGER}`); await store.db.run("DELETE FROM conversation_activity WHERE conversation_id=?", [id]);
    await randomJournal(store, id, 80, 50, raw(id));
    await store.db.exec(MESSAGE_ACTIVITY_SCHEMA);
    await expect((async () => { for await (const _ of store.snapshotFrames("outsider", id, 0)) break; })()).rejects.toThrow("conversation_forbidden");
    await expect(store.catchupPlan("outsider", id, 0)).rejects.toThrow("conversation_forbidden");
    expect(store.activityIndex.stats.batches).toBe(0);
    expect(await coverage(store, id)).toBeUndefined();
  });

  it("rebuilds coverage after restoring a pre-feature database and keeps writers responsive", async () => {
    const ids = [await conversation("restored-a"), await conversation("restored-b")];
    for (const [index, id] of ids.entries()) await randomJournal(store, id, 30 + index, 500, raw(id));
    const expected = await Promise.all(ids.map(id => legacyActivity(store, id)));
    await store.db.exec(`DROP TRIGGER ${TRIGGER}; DROP TRIGGER conversations_message_activity_v1; DROP TABLE message_activity; DROP TABLE message_hide_events; DROP TABLE conversation_activity;`);
    await store.db.close(); store = await HubStore.open(root);
    expect(await store.activityIndex.lagging()).toEqual(ids);
    // Snapshots are exact before repair (uncovered tail folded in memory).
    const before = await readConversationActivity(store.db, ids[0]!, (await store.syncHead("owner", ids[0]!)).seq);
    expect(before.indexed).toBe(false); expect(strip(before.activity)).toEqual(expected[0]);
    // Background repair commits bounded batches; ordinary writes interleave.
    const index = new MessageActivityIndex(store.db, { batch: 16 });
    let repaired = false; const repair = Promise.all(ids.map(id => index.ensure(id))).then(() => { repaired = true; });
    const other = await conversation("live"), interleaved: boolean[] = [];
    for (let i = 0; i < 5; i++) { await store.publishBotMessage("bot", { conversationId: other, blocks: [{ type: "text", text: `live ${i}` }] }); interleaved.push(!repaired); }
    await repair; await index.stop();
    expect(interleaved.some(Boolean)).toBe(true);
    expect(index.stats.maxBatchEvents).toBeLessThanOrEqual(32);
    expect(await store.activityIndex.lagging()).toEqual([]);
    for (const [i, id] of ids.entries()) expect(strip((await current(store, id)).activity)).toEqual(expected[i]);
    expect(await coverage(store, other)).toBe((await store.syncHead("owner", other)).seq);
  });

  it("converges while the same conversation keeps receiving writes during repair", async () => {
    const id = await conversation("busy");
    await store.db.exec(`DROP TRIGGER ${TRIGGER}`); await store.db.run("DELETE FROM conversation_activity WHERE conversation_id=?", [id]);
    await randomJournal(store, id, 40, 300, raw(id));
    await store.db.exec(MESSAGE_ACTIVITY_SCHEMA);
    const index = new MessageActivityIndex(store.db, { batch: 8 });
    const repair = index.ensure(id);
    let message = await store.publishBotMessage("bot", { conversationId: id, blocks: [{ type: "text", text: "x" }], status: "streaming" });
    for (let i = 0; i < 30; i++) message = await store.publishBotMessage("bot", { id: message.id, conversationId: id, blocks: [{ type: "text", text: `x${i}` }], status: i === 29 ? "complete" : "streaming", version: message.version + 1 });
    await repair;
    for (let i = 0; i < 5; i++) await store.publishBotMessage("bot", { conversationId: id, blocks: [{ type: "text", text: `after ${i}` }] });
    await index.stop();
    const result = await current(store, id);
    expect(await coverage(store, id)).toBe(result.head);
    expect(strip(result.activity)).toEqual(await legacyActivity(store, id));
  });

  it("escalates a paced background pass when a snapshot needs the same conversation", async () => {
    const id = await conversation("escalate");
    await store.db.exec(`DROP TRIGGER ${TRIGGER}`); await store.db.run("DELETE FROM conversation_activity WHERE conversation_id=?", [id]);
    await randomJournal(store, id, 60, 400, raw(id));
    await store.db.exec(MESSAGE_ACTIVITY_SCHEMA);
    const index = new MessageActivityIndex(store.db, { batch: 64, backgroundBatch: 4, pauseMs: 20 });
    const background = index.ensure(id, true);
    await index.ensure(id); await background; await index.stop();
    expect(index.stats.maxBatchEvents).toBeGreaterThan(8);
    expect(strip((await current(store, id)).activity)).toEqual(await legacyActivity(store, id));
  });

  it("stops background repair before the database closes", async () => {
    const id = await conversation("closing");
    await store.db.exec(`DROP TRIGGER ${TRIGGER}`); await store.db.run("DELETE FROM conversation_activity WHERE conversation_id=?", [id]);
    await randomJournal(store, id, 50, 400, raw(id));
    store.activityIndex.start();
    await store.db.close();
    await expect(store.activityIndex.ensure(id)).rejects.toThrow("activity_index_stopped");
    store = await HubStore.open(root);
  });
});
