import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conversationFilesQuerySchema } from "../src/client-protocol/conversation-files.js";
import { conversationFiles } from "../src/hub/conversation-files.js";
import { HubStore } from "../src/hub/store.js";

describe("shared conversation files", () => {
  let store: HubStore, directory: string, anchor: string, other: string, unrelated: string;
  let counter: number;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "conversation-files-")); store = await HubStore.open(directory); counter = 0;
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture'),('beta','Beta','fixture')");
    await store.db.run("INSERT INTO users VALUES('member','Member','member')");
    anchor = (await store.createConversation("owner", ["alpha"], "Current", "current")).id;
    other = (await store.createConversation("owner", ["alpha"], "Older", "older")).id;
    unrelated = (await store.createConversation("owner", ["beta"], "Unrelated", "unrelated")).id;
  });
  afterEach(async () => { await store.db.close(); await rm(directory, { recursive: true, force: true }); });
  async function attachment(conversationId = anchor, name = "资料.md") {
    const id = `att_${++counter}`;
    await store.db.run("INSERT INTO attachments VALUES(?,?,'owner','fixture',3,'text/markdown',?,?,1,0)", [id, conversationId, name, `${id}.blob`]);
    return id;
  }
  async function share(conversationId = anchor, botId = "alpha", name = "资料.md") {
    const id = await attachment(conversationId, name);
    return store.publishBotMessage(botId, { conversationId, blocks: [{ type: "file", attachmentId: id, name, size: 3, mime: "text/markdown" }] });
  }
  const list = (input: Record<string, string> = {}, userId = "owner") => conversationFiles(store, userId, conversationFilesQuerySchema.parse({ conversationId: anchor, ...input }));

  it("lists shared media with sender/source while excluding drafts, covers, removed files and unrelated Bots", async () => {
    const first = await share(), past = await share(other); await share(unrelated, "beta");
    const draft = await attachment();
    const sent = await store.sendMessage("owner", { conversationId: anchor, clientMsgId: "upload", text: "", attachments: [await attachment()] });
    const cover = await attachment();
    const link = await store.publishBotMessage("alpha", { conversationId: anchor, blocks: [{ type: "text", text: "https://example.org" }] });
    await store.setLinkPreview(link.id, { url: "https://example.org", status: "ready", title: "Example", siteName: "Example", imageAttachmentId: cover });
    const nested = await store.publishBotMessage("alpha", { conversationId: anchor, blocks: [{ type: "card", elements: [{ type: "columns", children: [{ type: "column", children: [{ type: "image", attachmentId: await attachment() }] }] }] }] });
    const removed = await share(); await store.publishBotMessage("alpha", { id: removed.id, conversationId: anchor, blocks: [], version: 2, status: "deleted" });
    const edited = await share(); await store.publishBotMessage("alpha", { id: edited.id, conversationId: anchor, blocks: [{ type: "text", text: "Changed" }], version: 2 });
    expect((await list()).items.map(file => file.messageId).sort()).toEqual([first.id, sent.message.id, nested.id].sort());
    expect((await list()).items.find(file => file.messageId === first.id)).toMatchObject({ name: "资料.md", authorName: "Alpha", authorType: "bot", conversationTitle: "Current" });
    expect((await list()).items.some(file => file.attachmentId === draft || file.attachmentId === cover)).toBe(false);
    const group = await store.createConversation("owner", ["alpha", "beta"], "Group", "group", { type: "group" });
    const topic = await store.createConversation("owner", [], "Topic", "topic", { parentId: group.id });
    const topicFile = await share(topic.id, "beta");
    expect((await list({ botId: "alpha" })).items.map(file => file.messageId).sort()).toEqual([first.id, sent.message.id, nested.id, past.id, topicFile.id].sort());
    expect((await list({ conversationId: group.id })).items).toEqual([]);
    expect((await list({ conversationId: topic.id })).items.map(file => file.messageId)).toEqual([topicFile.id]);
    await store.db.run("UPDATE conversations SET archived=1 WHERE id=?", [other]);
    expect((await list({ botId: "alpha" })).items.some(file => file.messageId === past.id)).toBe(true);
  });

  it("rechecks membership and the anchor Bot, including across pages", async () => {
    await share(); await share(other);
    await expect(list({}, "member")).rejects.toThrow("conversation_forbidden");
    await store.db.run("INSERT INTO conversation_members VALUES(?,'user','member',0)", [anchor]);
    expect((await list({ botId: "alpha" }, "member")).items).toHaveLength(1);
    await expect(list({ botId: "beta" }, "member")).rejects.toThrow("bot_forbidden");
    await store.db.run("INSERT INTO conversation_members VALUES(?,'user','member',0)", [other]);
    expect((await list({ botId: "alpha" }, "member")).items).toHaveLength(2);
    await store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='user' AND member_id='member'", [other]);
    expect((await list({ botId: "alpha" }, "member")).items).toHaveLength(1);
  });

  it("pages multiple files per message deterministically, with literal name search and bound cursors", async () => {
    const ids = [];
    for (let i = 0; i < 61; i++) ids.push(await attachment(anchor, i === 0 ? "预算100%_最终.MD" : `资料${i}.md`));
    await store.publishBotMessage("alpha", { conversationId: anchor, blocks: ids.map(id => ({ type: "file", attachmentId: id, name: id, size: 3, mime: "text/plain" })) });
    const first = await list(); expect(first.items).toHaveLength(50); expect(first.nextCursor).toBeTruthy();
    const second = await list({ cursor: first.nextCursor! }); expect(second.items).toHaveLength(11); expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map(file => file.attachmentId)).size).toBe(61);
    expect((await list({ q: "100%_" })).items.map(file => file.name)).toEqual(["预算100%_最终.MD"]);
    expect((await list({ q: "最终.md" })).items).toHaveLength(1);
    await expect(list({ botId: "alpha", cursor: first.nextCursor! })).rejects.toThrow("file_cursor_invalid");
    await expect(list({ q: "资料", cursor: first.nextCursor! })).rejects.toThrow("file_cursor_invalid");
    await expect(list({ cursor: "nonsense" })).rejects.toThrow("file_cursor_invalid");
    await store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='user'", [anchor]);
    await expect(list({ cursor: first.nextCursor! })).rejects.toThrow("conversation_forbidden");
    expect(conversationFilesQuerySchema.safeParse({ conversationId: anchor, path: "/tmp" }).success).toBe(false);
  });
});
