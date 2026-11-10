import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachmentAdminDeleteSchema, attachmentAdminListQuerySchema } from "../src/client-protocol/attachment-admin.js";
import { conversationFilesQuerySchema } from "../src/client-protocol/conversation-files.js";
import { attachmentAdminList, attachmentAdminSummary, retireAttachments } from "../src/hub/attachment-admin.js";
import { HubAttachments } from "../src/hub/attachments.js";
import { conversationFiles } from "../src/hub/conversation-files.js";
import { HubMaintenance } from "../src/hub/maintenance.js";
import { HubStore } from "../src/hub/store.js";

const exists = (file: string) => access(file).then(() => true, () => false);

describe("owner attachment management", () => {
  let store: HubStore, directory: string, attachments: HubAttachments, decks: string, notes: string, counter: number;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "attachment-admin-")); store = await HubStore.open(directory); counter = 0;
    attachments = new HubAttachments(store, directory); await attachments.initialize();
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
    await store.db.run("INSERT INTO users VALUES('member','Member','member')");
    decks = (await store.createConversation("owner", ["alpha"], "PPT 素材", "decks")).id;
    notes = (await store.createConversation("owner", ["alpha"], "笔记", "notes")).id;
  });
  afterEach(async () => { await store.db.close(); await rm(directory, { recursive: true, force: true }); });

  async function upload(conversationId: string, size: number, name = "deck.pptx", createdAt = ++counter) {
    const id = `att_${counter}_${size}`;
    await store.db.run("INSERT INTO attachments VALUES(?,?,'owner','fixture',?,'application/vnd.ms-powerpoint',?,?,1,?)", [id, conversationId, size, name, `${id}.blob`, createdAt]);
    await writeFile(path.join(attachments.directory, `${id}.blob`), Buffer.alloc(size));
    return id;
  }
  async function share(conversationId: string, size: number, name?: string) {
    const id = await upload(conversationId, size, name);
    await store.publishBotMessage("alpha", { conversationId, blocks: [{ type: "file", attachmentId: id, name: name ?? "deck.pptx", size, mime: "application/vnd.ms-powerpoint" }] });
    return id;
  }
  const remove = (input: Record<string, unknown>, userId = "owner") => retireAttachments(store, userId, attachmentAdminDeleteSchema.parse(input));

  it("summarizes shared attachments per conversation and lists them by size or time, owner only", async () => {
    const small = await share(decks, 10, "小.pptx"), large = await share(decks, 300, "大.pptx"); await share(notes, 50, "n.md");
    await upload(decks, 999, "draft.pptx"); // unsent upload: left to GC, not listed
    const summary = await attachmentAdminSummary(store, "owner");
    expect(summary).toEqual({ count: 3, bytes: 360, conversations: [
      { conversationId: decks, title: "PPT 素材", count: 2, bytes: 310, revision: expect.stringMatching(/^[a-f0-9]{64}$/) }, { conversationId: notes, title: "笔记", count: 1, bytes: 50, revision: expect.stringMatching(/^[a-f0-9]{64}$/) }] });
    const bySize = await attachmentAdminList(store, "owner", attachmentAdminListQuerySchema.parse({ conversationId: decks }));
    expect(bySize.total).toBe(2);
    expect(bySize.items.map(item => [item.id, item.name, item.size, item.pending])).toEqual([[large, "大.pptx", 300, false], [small, "小.pptx", 10, false]]);
    expect(bySize.items[0]!.messageId).toMatch(/^msg_/);
    const byTime = await attachmentAdminList(store, "owner", attachmentAdminListQuerySchema.parse({ conversationId: decks, sort: "time" }));
    expect(byTime.items.map(item => item.id)).toEqual([large, small]);
    await expect(attachmentAdminSummary(store, "member")).rejects.toMatchObject({ code: "owner_required" });
    await expect(remove({ conversationId: decks }, "member")).rejects.toMatchObject({ code: "owner_required" });
  });

  it("deletes selected attachments: blob and chunks go now, the message keeps a 附件已删除 tombstone", async () => {
    const keep = await share(decks, 10), gone = await share(decks, 300);
    await writeFile(path.join(attachments.directory, `${gone}.0.chunk`), "x");
    await store.db.run("INSERT INTO upload_chunks VALUES(?,0,'fixture',1)", [gone]);
    const result = await remove({ ids: [gone, gone, "att_missing"] });
    expect(result).toEqual({ deleted: 1, freedBytes: 300, ids: [gone], pending: [] });
    await attachments.purge(result.ids);
    expect(await exists(path.join(attachments.directory, `${gone}.blob`))).toBe(false);
    expect(await exists(path.join(attachments.directory, `${gone}.0.chunk`))).toBe(false);
    expect(await exists(path.join(attachments.directory, `${keep}.blob`))).toBe(true);
    expect(await store.db.get("SELECT 1 FROM upload_chunks WHERE attachment_id=?", [gone])).toBeUndefined();
    // Row and reference stay so the message can say it was deleted.
    expect(await store.db.get("SELECT 1 FROM attachments WHERE id=?", [gone])).toBeTruthy();
    expect(await store.db.get("SELECT 1 FROM message_attachments WHERE attachment_id=?", [gone])).toBeTruthy();
    await expect(attachments.download({ userId: "owner" }, gone)).rejects.toMatchObject({ code: "attachment_deleted", status: 410 });
    await expect(attachments.download({ userId: "member" }, gone)).rejects.toMatchObject({ code: "conversation_forbidden" });
    expect((await attachments.download({ userId: "owner" }, keep)).row.id).toBe(keep);
    expect((await attachmentAdminSummary(store, "owner")).conversations).toEqual([{ conversationId: decks, title: "PPT 素材", count: 1, bytes: 10, revision: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    const files = await conversationFiles(store, "owner", conversationFilesQuerySchema.parse({ conversationId: decks }));
    expect(files.items.map(item => item.attachmentId)).toEqual([keep]);
    expect(await remove({ ids: [gone] })).toEqual({ deleted: 0, freedBytes: 0, ids: [], pending: [] });
    expect((await store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE kind='attachment.deleted'"))?.n).toBe(1);
  });

  it("refuses an attachment a Bot has not finished processing, and deletes the rest of the conversation", async () => {
    const done = await share(decks, 20), queued = await upload(decks, 70);
    const sent = await store.sendMessage("owner", { conversationId: decks, clientMsgId: "queued", text: "看看这个", attachments: [queued] });
    const listed = await attachmentAdminList(store, "owner", attachmentAdminListQuerySchema.parse({ conversationId: decks }));
    expect(listed.items.find(item => item.id === queued)?.pending).toBe(true);
    const result = await remove({ conversationId: decks });
    expect(result).toEqual({ deleted: 1, freedBytes: 20, ids: [done], pending: [queued] });
    expect(await store.db.get("SELECT 1 FROM retired_attachments WHERE attachment_id=?", [queued])).toBeUndefined();
    await store.acknowledgeDelivery("alpha", sent.message.id);
    expect(await remove({ ids: [queued] })).toMatchObject({ deleted: 1, ids: [queued], pending: [] });
  });

  it("deletes all of a conversation only while it still holds what the confirmation showed", async () => {
    const first = await share(decks, 20), second = await share(decks, 30);
    const shown = (await attachmentAdminSummary(store, "owner")).conversations.find(item => item.conversationId === decks)!;
    expect(shown).toMatchObject({ count: 2, bytes: 50 });
    const late = await share(decks, 70); // arrives while the confirmation is open
    await expect(remove({ conversationId: decks, expected: { count: shown.count, bytes: shown.bytes } })).rejects.toMatchObject({ code: "attachment_set_changed", status: 409 });
    expect(await store.db.get("SELECT 1 FROM retired_attachments")).toBeUndefined();
    expect(await exists(path.join(attachments.directory, `${late}.blob`))).toBe(true);
    const again = (await attachmentAdminSummary(store, "owner")).conversations.find(item => item.conversationId === decks)!;
    const result = await remove({ conversationId: decks, expected: { count: again.count, bytes: again.bytes } });
    expect(result).toMatchObject({ deleted: 3, freedBytes: 120 });
    expect(new Set(result.ids)).toEqual(new Set([first, second, late]));
    expect(() => attachmentAdminDeleteSchema.parse({ ids: [first], expected: { count: 1, bytes: 20 } })).toThrow();
  });

  it("refuses replacing a confirmed attachment with a new one of the same size", async () => {
    const old = await share(decks, 20);
    const shown = (await attachmentAdminSummary(store, "owner")).conversations[0]!;
    await remove({ ids: [old] });
    const replacement = await share(decks, 20);
    const expected = { count: shown.count, bytes: shown.bytes, ...("revision" in shown ? { revision: shown.revision } : {}) };
    await expect(remove({ conversationId: decks, expected })).rejects.toMatchObject({ code: "attachment_set_changed", status: 409 });
    await expect(attachments.download({ userId: "owner" }, replacement)).resolves.toMatchObject({ row: { id: replacement } });
  });

  it("daily GC removes bytes left by an interrupted purge but keeps the tombstone row", async () => {
    const id = await share(notes, 40);
    await remove({ ids: [id] }); // purge never ran
    expect(await exists(path.join(attachments.directory, `${id}.blob`))).toBe(true);
    await new HubMaintenance(store, directory).collectOrphans();
    expect(await exists(path.join(attachments.directory, `${id}.blob`))).toBe(false);
    expect(await store.db.get("SELECT 1 FROM attachments WHERE id=?", [id])).toBeTruthy();
    await mkdir(path.join(directory, "unused"), { recursive: true });
  });

  it("refuses forwarding a retired attachment while an interrupted purge has left its bytes", async () => {
    const id = await upload(decks, 40);
    const file = { type: "file" as const, attachmentId: id, name: "deck.pptx", size: 40, mime: "application/vnd.ms-powerpoint" };
    const original = await store.publishBotMessage("alpha", { conversationId: decks, blocks: [file] });
    const forward = (conversationId: string, clientMsgId: string) => attachments.forward("owner", { v: 1, type: "message.forward", conversationId, clientMsgId, sourceMessageId: original.id });
    const normal = await forward(notes, "before-retirement");
    const copied = normal.message.blocks.find(block => block.type === "file")!;
    expect(copied.attachmentId).not.toBe(id);
    await remove({ ids: [id] }); // The HTTP handler commits retirement even if purge fails.
    expect(await exists(path.join(attachments.directory, `${id}.blob`))).toBe(true);
    await store.publishBotMessage("alpha", { id: original.id, conversationId: decks, blocks: [{ type: "text", text: "Updated tombstone" }, file] });
    await expect(attachments.download({ userId: "owner" }, id)).rejects.toMatchObject({ code: "attachment_deleted" });
    const before = await store.db.get("SELECT COUNT(*) AS count FROM attachments");
    for (const conversationId of [decks, notes]) {
      await expect(forward(conversationId, `after-retirement-${conversationId}`)).rejects.toMatchObject({ code: "attachment_not_found" });
    }
    expect(await store.db.get("SELECT COUNT(*) AS count FROM attachments")).toEqual(before);
    expect(await store.db.get("SELECT 1 FROM messages WHERE client_msg_id LIKE 'after-retirement-%'")).toBeUndefined();
    // Copies made before retirement keep their independent lifetime.
    await expect(attachments.download({ userId: "owner" }, copied.attachmentId)).resolves.toMatchObject({ row: { id: copied.attachmentId } });
  });

  it("updates existing messages after attachment deletion without allowing new retired references", async () => {
    const id = await upload(decks, 40);
    const file = { type: "file" as const, attachmentId: id, name: "deck.pptx", size: 40, mime: "application/vnd.ms-powerpoint" };
    const original = await store.publishBotMessage("alpha", { conversationId: decks, blocks: [file] });
    await remove({ ids: [id] }); await attachments.purge([id]);
    const updated = await store.publishBotMessage("alpha", { id: original.id, conversationId: decks, blocks: [{ type: "text", text: "Updated answer" }, file] });
    expect(updated.blocks).toHaveLength(2);
    expect(await store.db.get("SELECT 1 FROM message_attachments WHERE message_id=? AND attachment_id=?", [original.id, id])).toBeTruthy();
    await expect(attachments.download({ userId: "owner" }, id)).rejects.toMatchObject({ code: "attachment_deleted" });
    for (const conversationId of [decks, notes]) {
      await expect(store.publishBotMessage("alpha", { conversationId, blocks: [file] })).rejects.toMatchObject({ code: "attachment_not_found" });
    }
    await store.publishBotMessage("alpha", { id: original.id, conversationId: decks, blocks: [{ type: "text", text: "File removed" }] });
    await expect(store.publishBotMessage("alpha", { id: original.id, conversationId: decks, blocks: [file] })).rejects.toMatchObject({ code: "attachment_not_found" });
    expect((await store.messageForUser("owner", original.id)).blocks).toEqual([{ type: "text", text: "File removed" }]);
  });

  it("can delete a Bot whose interactive history references a deleted attachment", async () => {
    await store.db.run("INSERT INTO managed_bots(bot_id,owner_id,request_id,specification_json) VALUES('alpha','owner','managed','{}')");
    const id = await upload(decks, 40);
    const original = await store.publishBotMessage("alpha", { conversationId: decks, blocks: [
      { type: "file", attachmentId: id, name: "deck.pptx", size: 40, mime: "application/vnd.ms-powerpoint" },
      { type: "card", elements: [{ type: "button", text: "Choose", actionId: "choose" }] },
    ] });
    await remove({ ids: [id] }); await attachments.purge([id]);
    await store.deleteBot("owner", "alpha", "Alpha");
    expect(await store.db.get("SELECT deleted_at FROM bots WHERE id='alpha'")).toMatchObject({ deleted_at: expect.any(Number) });
    const saved = await store.messageForUser("owner", original.id);
    expect(saved.blocks[0]).toEqual(original.blocks[0]);
    expect(saved.blocks[1]).toMatchObject({ type: "card", elements: [{ type: "button", text: "Choose", disabled: true }] });
    expect(JSON.stringify(saved.blocks[1])).not.toContain("actionId");
    await expect(attachments.download({ userId: "owner" }, id)).rejects.toMatchObject({ code: "attachment_deleted" });
  });
});
