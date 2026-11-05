import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../src/client-protocol/index.js";
import { searchPageQuerySchema, searchQuerySchema } from "../src/client-protocol/search.js";
import { HubMaintenance } from "../src/hub/maintenance.js";
import { HubDatabase } from "../src/hub/database.js";
import { HubStore } from "../src/hub/store.js";

describe("Hub literal history search", () => {
  let directory: string, store: HubStore, conversationId: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "hub-search-")); store = await HubStore.open(directory);
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture'),('beta','Beta','fixture')");
    await store.db.run("INSERT INTO users VALUES('member','Member','member')");
    conversationId = (await store.createConversation("owner", ["alpha"], "History", "history")).id;
  });
  afterEach(async () => { vi.restoreAllMocks(); await store.db.close(); await rm(directory, { recursive: true, force: true }); });
  const publish = (text: string, id = conversationId) => store.publishBotMessage(id === conversationId ? "alpha" : "beta", { conversationId: id, blocks: [{ type: "text", text }] });

  it("keeps FTS row identities aligned through streaming edits and repairs old-writer row identities on reopen", async () => {
    const first = await publish("first text"), second = await publish("second text");
    await store.publishBotMessage("alpha", { id: first.id, conversationId, blocks: [{ type: "text", text: "updated first" }], status: "streaming" });
    const aligned = () => store.db.all("SELECT m.id FROM messages m JOIN messages_fts f ON f.message_id=m.id WHERE m.rowid!=f.rowid");
    expect(await aligned()).toEqual([]);
    // A compatible older host used auto-assigned FTS rowids. Reopening the
    // newer host must repair that index without changing retained messages.
    await store.db.run("DELETE FROM messages_fts WHERE message_id=?", [first.id]);
    await store.db.run("INSERT INTO messages_fts(message_id,conversation_id,body) VALUES(?,?,?)", [first.id, conversationId, "updated first"]);
    await store.db.close(); store = await HubStore.open(directory);
    expect(await aligned()).toEqual([]);
    expect((await store.search("owner", "updated first")).map(m => m.id)).toEqual([first.id]);
    expect((await store.search("owner", "second text")).map(m => m.id)).toEqual([second.id]);
    const writes = vi.spyOn(store.db, "run");
    await store.publishBotMessage("alpha", { id: first.id, conversationId, blocks: [{ type: "text", text: "updated first" }], status: "complete" });
    expect(writes.mock.calls.filter(([sql]) => /(?:INSERT INTO|DELETE FROM) messages_fts/.test(sql))).toEqual([]);
  });

  it("preserves FTS identities and later edits after VACUUM backup and restore", async () => {
    const removed = await publish("deleted gap"), first = await publish("retained alpha"), second = await publish("retained beta");
    await store.db.run("DELETE FROM messages_fts WHERE message_id=?", [removed.id]);
    await store.db.run("DELETE FROM messages WHERE id=?", [removed.id]);
    const destination = path.join(directory, "restored"); await mkdir(destination);
    await new HubMaintenance(store, directory).backup(path.join(destination, "hub.sqlite"));
    const restored = await HubStore.open(destination);
    try {
      expect(await restored.db.all("SELECT m.id FROM messages m JOIN messages_fts f ON f.message_id=m.id WHERE m.rowid!=f.rowid")).toEqual([]);
      expect((await restored.search("owner", "retained alpha")).map(message => message.id)).toEqual([first.id]);
      expect((await restored.search("owner", "retained beta")).map(message => message.id)).toEqual([second.id]);
      await restored.publishBotMessage("alpha", { id: first.id, conversationId, blocks: [{ type: "text", text: "restored update" }] });
      expect(await restored.search("owner", "retained alpha")).toEqual([]);
      expect((await restored.search("owner", "restored update")).map(message => message.id)).toEqual([first.id]);
      expect((await restored.search("owner", "retained beta")).map(message => message.id)).toEqual([second.id]);
      const added = await restored.publishBotMessage("alpha", { conversationId, blocks: [{ type: "text", text: "new after restore" }] });
      expect((await restored.search("owner", "new after restore")).map(message => message.id)).toEqual([added.id]);
    } finally { await restored.db.close(); }
  });

  it("matches literal Unicode and punctuation, with indexed candidates for trigram terms", async () => {
    const texts = ["你好世界", "你好世外", "界", "📎附件📎", "abc%def", "abcZZdef", "abc_def", "abcZdef", String.raw`C:\abc\file_1%`, '"alpha" OR beta*', "'; DROP TABLE messages; --", "ABC case", "café", "cafe", "CAFÉ"];
    const messages: Message[] = [];
    for (const text of texts) messages.push(await publish(text));
    const snapshot = HubDatabase.snapshot.bind(HubDatabase), plans: string[] = [];
    vi.spyOn(HubDatabase, "snapshot").mockImplementation(async (file) => {
      const db = await snapshot(file), all = db.all.bind(db);
      vi.spyOn(db, "all").mockImplementation(async (sql, params) => {
        plans.push(...(await all<{ detail: string }>("EXPLAIN QUERY PLAN " + sql, params)).map((row) => row.detail));
        return all(sql, params);
      }); return db;
    });
    for (const [query, indexes] of [
      ["你好世", [0, 1]], ["你好", [0, 1]], ["界", [0, 2]], ["📎", [3]], ["📎附件", [3]],
      ["abc%def", [4]], ["abc_def", [6]], ["%", [4, 8]], ["_", [6, 8]], ["\\abc\\", [8]],
      [String.raw`\file_1%`, [8]], ['"alpha" OR beta*', [9]], ["'; DROP TABLE messages; --", [10]],
      ["abc case", [11]], ["café", [12]], ["cafe", [13]], ["CAFÉ", [14]],
    ] as const) {
      expect((await store.search("owner", query)).map((m) => m.id).sort(), query).toEqual(indexes.map((index) => messages[index]!.id).sort());
      expect((await store.searchPage("owner", query)).items.map((m) => m.id).sort(), query).toEqual(indexes.map((index) => messages[index]!.id).sort());
    }
    expect(plans.some((plan) => /messages_fts VIRTUAL TABLE INDEX .*L2/.test(plan))).toBe(true);
    expect(await store.db.get("SELECT id FROM messages LIMIT 1")).toBeDefined();
  });

  it("combines membership, Bot, inclusive date and attachment filters without old or deleted content", async () => {
    const other = await store.createConversation("owner", ["beta"], "Other", "other");
    const first = await publish("历史检索旧版"), second = await publish("历史检索删除"), third = await publish("历史检索另一个 Bot", other.id);
    await store.db.run("UPDATE messages SET created_at=100 WHERE id=?", [first.id]);
    await store.db.run("UPDATE messages SET created_at=200 WHERE id=?", [second.id]);
    await store.db.run("UPDATE messages SET created_at=300 WHERE id=?", [third.id]);
    expect((await store.search("owner", "历史检索", { botId: "alpha", from: 100, to: 100 })).map((m) => m.id)).toEqual([first.id]);
    expect((await store.search("owner", "历史检索", { botId: "beta" })).map((m) => m.id)).toEqual([third.id]);
    expect(await store.search("member", "历史检索")).toEqual([]);
    await store.db.run("INSERT INTO conversation_members VALUES(?,'user','member',0)", [other.id]);
    expect((await store.search("member", "历史检索")).map((m) => m.id)).toEqual([third.id]);
    await store.publishBotMessage("alpha", { id: first.id, conversationId, blocks: [{ type: "text", text: "历史检索新版" }], version: 2 });
    await store.publishBotMessage("alpha", { id: second.id, conversationId, blocks: [], status: "deleted", version: 2 });
    expect(await store.search("owner", "旧版")).toEqual([]); expect(await store.search("owner", "删除")).toEqual([]);
    expect((await store.search("owner", "新版")).map((m) => m.id)).toEqual([first.id]);
    // A preview image is not an attached file.
    await store.setLinkPreview(first.id, { url: "https://example.org", status: "ready", imageAttachmentId: "cover", title: "Cover", siteName: "Example" });
    expect(await store.search("owner", "", { hasFile: true })).toEqual([]);
    for (const [id, cid] of [["attachment", other.id], ["nested_image", conversationId]]) await store.db.run("INSERT INTO attachments(id,conversation_id,owner_id,sha256,size,mime,name,stored_name,complete,created_at) VALUES(?,?,'owner','fixture',3,'text/plain','fixture','fixture',1,0)", [id!, cid!]);
    await store.publishBotMessage("beta", { id: third.id, conversationId: other.id, version: 2, blocks: [{ type: "file", attachmentId: "attachment", name: "历史附件.txt", size: 3, mime: "text/plain" }] });
    const nested = await store.publishBotMessage("alpha", { conversationId, blocks: [{ type: "card", title: "包含图片", elements: [{ type: "columns", children: [{ type: "column", children: [{ type: "image", attachmentId: "nested_image" }] }] }] }] });
    expect((await store.search("owner", "", { hasFile: true })).map((m) => m.id).sort()).toEqual([third.id, nested.id].sort());
  });

  it("bounds results and consistently orders equal timestamps", async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 105; i++) messages.push(await publish(`重复命中 ${i}`));
    await store.db.run("UPDATE messages SET created_at=100");
    const expected = messages.map((m) => m.id).sort().reverse().slice(0, 100);
    expect((await store.search("owner", "重复命中")).map((m) => m.id)).toEqual(expected);
    expect((await store.search("owner", "")).map((m) => m.id)).toEqual(expected);
  });

  it("scopes both search routes and every page to one conversation, including topics and membership", async () => {
    const sameBot = await store.createConversation("owner", ["alpha"], "Same Bot", "same_bot");
    const group = await store.createConversation("owner", ["alpha"], "Group", "group", { type: "group" });
    const topic = await store.createConversation("owner", [], "Topic", "topic", { parentId: group.id });
    const expected: string[] = [];
    for (let i = 0; i < 53; i++) expected.push((await publish(`范围记录 ${i}`)).id);
    for (const chat of [sameBot, group, topic]) await store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text: "范围记录 其他对话" }] });
    const filters = { conversationId, botId: "alpha" };
    expect((await store.search("owner", "范围记录", filters)).map(m => m.id).sort()).toEqual(expected.sort());
    const first = await store.searchPage("owner", "范围记录", filters);
    const second = await store.searchPage("owner", "范围记录", filters, first.nextCursor!);
    expect(first.items).toHaveLength(50); expect(second.items).toHaveLength(3); expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map(m => m.id).sort()).toEqual(expected);
    for (const other of [{ botId: "alpha" }, { conversationId: sameBot.id, botId: "alpha" }]) {
      await expect(store.searchPage("owner", "范围记录", other, first.nextCursor!)).rejects.toMatchObject({ code: "search_cursor_mismatch" });
    }
    for (const chat of [sameBot, group, topic]) {
      const scoped = { conversationId: chat.id };
      expect((await store.search("owner", "范围记录", scoped)).map(m => m.conversationId)).toEqual([chat.id]);
      expect((await store.searchPage("owner", "范围记录", scoped)).items.map(m => m.conversationId)).toEqual([chat.id]);
    }
    expect(await store.search("member", "范围记录", filters)).toEqual([]);
    expect(await store.searchPage("member", "范围记录", filters)).toEqual({ items: [], nextCursor: null });
    await store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='user'", [conversationId]);
    expect(await store.searchPage("owner", "范围记录", filters, first.nextCursor!)).toEqual({ items: [], nextCursor: null });
    expect(await store.searchPage("owner", "范围记录", { conversationId: "missing" })).toEqual({ items: [], nextCursor: null });
  });

  it("pages beyond 100 matches without shifting older results when newer messages arrive or earlier hits are deleted", async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 125; i++) messages.push(await publish(`分页记录 ${i}`));
    await store.db.run("UPDATE messages SET created_at=100");
    const expected = messages.map((m) => m.id).sort().reverse();
    const first = await store.searchPage("owner", "分页记录");
    expect(first.items.map((m) => m.id)).toEqual(expected.slice(0, 50));
    expect(first.nextCursor).toEqual(expect.any(String));
    await publish("分页记录 新消息");
    await store.publishBotMessage("alpha", { id: first.items[0]!.id, conversationId, blocks: [], status: "deleted", version: 2 });
    const second = await store.searchPage("owner", "分页记录", {}, first.nextCursor!);
    const third = await store.searchPage("owner", "分页记录", {}, second.nextCursor!);
    expect([...first.items, ...second.items, ...third.items].map((m) => m.id)).toEqual(expected);
    expect(third.nextCursor).toBeNull();
  });

  it("binds page cursors to the query, filters and user while rechecking membership on each page", async () => {
    for (let i = 0; i < 51; i++) await publish(`权限检索 ${i}`);
    const first = await store.searchPage("owner", "权限检索", { botId: "alpha" });
    for (const [user, q, filters] of [["owner", "其他", { botId: "alpha" }], ["owner", "权限检索", {}], ["member", "权限检索", { botId: "alpha" }]] as const) {
      await expect(store.searchPage(user, q, filters, first.nextCursor!)).rejects.toMatchObject({ code: "search_cursor_mismatch" });
    }
    for (const cursor of ["bad", Buffer.from("{}").toString("base64url"), "x".repeat(1025)]) {
      await expect(store.searchPage("owner", "权限检索", { botId: "alpha" }, cursor)).rejects.toMatchObject({ code: "search_cursor_invalid" });
    }
    await store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='user'", [conversationId]);
    expect(await store.searchPage("owner", "权限检索", { botId: "alpha" }, first.nextCursor!)).toEqual({ items: [], nextCursor: null });
  });

  it("returns bounded excerpts around literal matches without transferring full long-message blocks", async () => {
    const message = await publish("前文".repeat(12000) + "abc%def 📎检索结果📎" + "后文".repeat(12000));
    const page = await store.searchPage("owner", "abc%def");
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: message.id, conversationId });
    expect(page.items[0]!.excerpt).toContain("abc%def 📎检索结果📎");
    expect(page.items[0]!.excerpt).toMatch(/^….*…$/s);
    expect(page.items[0]).not.toHaveProperty("blocks");
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(2000);
  });

  it("allows writes while a search is waiting, and closes failed readers before the next query", async () => {
    await publish("已提交的原消息");
    const snapshot = HubDatabase.snapshot.bind(HubDatabase);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { entered = resolve; });
    const closed = vi.fn(); let count = 0;
    vi.spyOn(HubDatabase, "snapshot").mockImplementation(async (file) => {
      const db = await snapshot(file), all = db.all.bind(db), close = db.close.bind(db), index = count++;
      vi.spyOn(db, "close").mockImplementation(async () => { await close(); closed(); });
      vi.spyOn(db, "all").mockImplementation(async (sql, params) => {
        if (index === 0) { entered(); await gate; }
        if (index === 1) throw new Error("read fixture failure");
        return all(sql, params);
      }); return db;
    });
    const searching = store.search("owner", "消息");
    try {
      await ready;
      await expect(publish("搜索等待期间写入的消息")).resolves.toMatchObject({ conversationId });
      await expect(store.audit("search.concurrent", "owner", {})).resolves.toBeUndefined();
    } finally { release(); await searching; }
    await expect(store.search("owner", "消息")).rejects.toThrow("read fixture failure");
    expect(await store.search("owner", "消息")).toHaveLength(2); expect(closed).toHaveBeenCalledTimes(3);
  });
});

describe("search HTTP input", () => {
  it.each(["", "bad cursor", "a".repeat(1025), "../../../", "{\"id\":1}"])("rejects malformed cursor %j", (cursor) => {
    expect(searchPageQuerySchema.safeParse({ cursor }).success).toBe(false);
  });
  it.each([{ q: "x".repeat(257) }, { q: "a\0b" }, { from: "Infinity" }, { from: "NaN" }, { from: "1.5" }, { from: "9007199254740992" }, { from: "2", to: "1" }, { hasFile: "yes" }, { botId: "../bot" }, { conversationId: "../conversation" }, { conversationId: "" }, { extra: "ignored" }])("rejects malformed input %j", (input) => {
    expect(searchQuerySchema.safeParse(input).success).toBe(false);
    expect(searchPageQuerySchema.safeParse(input).success).toBe(false);
  });
  it("retains an empty query and inclusive valid ranges", () => {
    expect(searchQuerySchema.parse({})).toEqual({ q: "", hasFile: false });
    expect(searchQuerySchema.parse({ q: "百分比%", from: "-10", to: "-10", hasFile: "true" })).toEqual({ q: "百分比%", from: -10, to: -10, hasFile: true });
  });
});
