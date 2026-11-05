import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clientFrameSchema, type Block, type Message } from "../src/client-protocol/index.js";
import { HubAttachments } from "../src/hub/attachments.js";
import { HubMaintenance } from "../src/hub/maintenance.js";
import { HubStore } from "../src/hub/store.js";

describe("quoted replies and durable forwarding", () => {
  let root: string, store: HubStore, files: HubAttachments, source: string, target: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hub-forward-")); store = await HubStore.open(root); files = new HubAttachments(store, root); await files.initialize();
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Source Bot','test'),('beta','Target Bot','test')");
    await store.db.run("INSERT INTO users VALUES('member','Reader','member')");
    source = (await store.createConversation("owner", ["alpha"], "Source", "source")).id;
    const group = await store.createConversation("owner", ["beta"], "Project", "group", { type: "group" });
    target = (await store.createConversation("owner", [], "Topic", "topic", { parentId: group.id })).id;
    await store.db.run("INSERT INTO conversation_members VALUES(?,'user','member',0)", [target]);
  });
  afterEach(async () => { await store.db.close(); await rm(root, { recursive: true, force: true }); });
  async function upload(name: string, mime: string, body = "bytes") {
    const data = Buffer.from(body); const { id } = await files.create("owner", { conversationId: source, name, mime, size: data.length, sha256: createHash("sha256").update(data).digest("hex") });
    await files.putChunk("owner", id, 0, data); await files.complete("owner", id); return id;
  }
  function forward(message: Message, id = "forward", mentions: string[] = []) { return files.forward("owner", { v: 1, type: "message.forward", conversationId: target, sourceMessageId: message.id, clientMsgId: id, mentions }); }

  it("reuses a forwarded attachment during bot import without requiring upload chunk receipts", async () => {
    const bytes = Buffer.from("quarterly numbers"), name = "report.txt", mime = "text/plain";
    const originalId = await upload(name, mime, bytes.toString());
    const original = await store.publishBotMessage("alpha", { conversationId: source, blocks: [{ type: "file", attachmentId: originalId, name, mime, size: bytes.length }] });
    const copied = await forward(original);
    const copiedFile = copied.message.blocks.find(block => block.type === "file")!;
    const input = { conversationId: target, name, mime, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    expect(await files.importForBot("beta", input, bytes)).toBe(copiedFile.attachmentId);
    expect(await store.db.all("SELECT * FROM upload_chunks WHERE attachment_id=?", [copiedFile.attachmentId])).toEqual([]);
    expect(await readFile((await files.download({ botId: "beta" }, copiedFile.attachmentId)).path)).toEqual(bytes);
    expect(await files.importForBot("beta", { ...input, name: "renamed.txt" }, bytes)).not.toBe(copiedFile.attachmentId);
    await expect(files.importForBot("alpha", input, bytes)).rejects.toThrow("bot_forbidden");
  });

  it("snapshots cards and all media, scopes new attachment IDs to the destination, and deduplicates across restart", async () => {
    const file = await upload("brief.txt", "text/plain", "original bytes\n完整文件"), image = await upload("chart.png", "image/png"), audio = await upload("voice.ogg", "audio/ogg");
    const blocks: Block[] = [{ type: "text", text: "# Original report" }, { type: "file", attachmentId: file, name: "brief.txt", mime: "text/plain", size: 30 }, { type: "audio", attachmentId: audio, name: "voice.ogg" }, { type: "card", title: "Review", elements: [{ type: "columns", children: [{ type: "column", children: [{ type: "image", attachmentId: image }, { type: "input", name: "answer", extra: { default_value: "saved" } }, { type: "button", text: "Approve", actionId: "dangerous", value: { command: "run" } }] }] }] }];
    const original = await store.publishBotMessage("alpha", { conversationId: source, blocks });
    const results = await Promise.all(Array.from({ length: 6 }, () => forward(original, "forward", ["beta"])));
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1); const copied = results[0]!.message;
    expect(copied).toMatchObject({ conversationId: target, authorType: "user", authorId: "owner", status: "complete", forwardedFrom: { messageId: original.id, conversationId: source, conversationTitle: "Source", authorName: "Source Bot", createdAt: original.createdAt } });
    expect(copied.replyTo).toBeUndefined(); expect(JSON.stringify(copied.blocks)).not.toContain("dangerous");
    expect(JSON.stringify(copied.blocks)).toContain('"disabled":true'); expect(JSON.stringify(copied.blocks)).toContain('"default_value":"saved"');
    const rows = await store.db.all<{ id: string }>("SELECT id FROM attachments WHERE conversation_id=?", [target]); expect(rows).toHaveLength(3);
    for (const { id } of rows) { expect([file, image, audio]).not.toContain(id); await files.download({ userId: "member" }, id); await files.download({ botId: "beta" }, id); }
    await expect(files.download({ userId: "member" }, file)).rejects.toThrow("conversation_forbidden");
    await expect(files.download({ botId: "alpha" }, rows[0]!.id)).rejects.toThrow("bot_forbidden");
    expect(await store.pendingForBot("alpha")).toHaveLength(0); expect(await store.pendingForBot("beta")).toHaveLength(1);
    await store.publishBotMessage("alpha", { id: original.id, conversationId: source, status: "deleted", blocks: [] });
    await new HubMaintenance(store, root).collectOrphans(Date.now() + 1);
    const copiedFile = copied.blocks.find((b) => b.type === "file")!;
    expect(await readFile((await files.download({ userId: "member" }, copiedFile.attachmentId)).path, "utf8")).toBe("original bytes\n完整文件");
    await store.db.close(); store = await HubStore.open(root); files = new HubAttachments(store, root);
    expect((await forward(original, "forward", ["beta"]))).toEqual({ message: copied, duplicate: true });
    expect((await store.snapshot("member", target)).messages).toEqual([copied]);
  });

  it("keeps the original Bot attribution when an owner forwards a collaboration task", async () => {
    const original = await store.sendMessage("owner", { conversationId: source, clientMsgId: "bot_origin", text: "Delegated task", attachments: [],
      botSource: { hostId: "hub_peer", hostName: "Peer host", botId: "source_bot", botName: "Peer Bot", requestId: "origin", hops: 1 } });
    const result = await forward(original.message, "bot_forward");
    expect(result.message.forwardedFrom?.authorName).toBe("Peer Bot · Peer host");
    // This remains an explicit human forward, not a newly signed Bot request.
    expect(result.message.botSource).toBeUndefined();
    expect(result.message.forwardedFrom?.messageId).toBe(original.message.id);
    expect(await store.pendingForBot("beta")).toHaveLength(0);
  });

  it("checks both memberships, archive state and complete source; never dispatches unless requested", async () => {
    const original = await store.publishBotMessage("alpha", { conversationId: source, status: "streaming", blocks: [{ type: "text", text: "draft" }] });
    await expect(files.forward("member", { v: 1, type: "message.forward", conversationId: target, sourceMessageId: original.id, clientMsgId: "bad" })).rejects.toThrow("conversation_forbidden");
    await expect(forward(original)).rejects.toThrow("message_not_ready");
    await store.publishBotMessage("alpha", { id: original.id, conversationId: source, blocks: [{ type: "text", text: "final" }] });
    await expect(forward(original, "bad_bot", ["alpha"])).rejects.toThrow("mention_forbidden");
    const result = await forward(original); expect(await store.pendingForBot("beta")).toHaveLength(0);
    await expect(store.sendMessage("owner", { conversationId: target, clientMsgId: "forward", text: "different", attachments: [] })).rejects.toThrow("idempotency_conflict");
    await expect(forward({ ...original, id: result.message.id })).rejects.toThrow("idempotency_conflict");
    const group = (await store.conversations("owner")).find((c) => c.id === target)!.parentId!;
    await store.updateConversation("owner", group, { archived: true }); await expect(forward(original, "archived")).rejects.toThrow("conversation_archived");
    expect((await store.snapshot("owner", target)).messages).toHaveLength(1);
  });

  it("rolls back message, attachment rows and linked files when a source file is missing", async () => {
    const first = await upload("a.txt", "text/plain"), second = await upload("b.txt", "text/plain");
    const original = await store.sendMessage("owner", { conversationId: source, text: "files", attachments: [first, second], clientMsgId: "source_files" });
    await rm(path.join(files.directory, `${second}.blob`)); const before = await readdir(files.directory);
    await expect(forward(original.message)).rejects.toMatchObject({ code: "attachment_unavailable", status: 410 });
    expect(await readdir(files.directory)).toEqual(before); expect((await store.snapshot("owner", target)).messages).toHaveLength(0);
    expect(await store.db.all("SELECT id FROM attachments WHERE conversation_id=?", [target])).toHaveLength(0);
  });

  it("treats truncated source files as a permanent error for downloads and forwards", async () => {
    const id = await upload("truncated.txt", "text/plain", "complete content");
    const original = await store.sendMessage("owner", { conversationId: source, text: "file", attachments: [id], clientMsgId: "truncated_source" });
    await writeFile(path.join(files.directory, `${id}.blob`), "short");
    await expect(files.download({ userId: "owner" }, id)).rejects.toMatchObject({ code: "attachment_unavailable", status: 410 });
    await expect(forward(original.message)).rejects.toMatchObject({ code: "attachment_unavailable", status: 410 });
    expect((await store.snapshot("owner", target)).messages).toHaveLength(0);
    expect(await store.db.all("SELECT id FROM attachments WHERE conversation_id=?", [target])).toHaveLength(0);
  });

  it("quotes only available messages in the same conversation", async () => {
    const original = await store.publishBotMessage("alpha", { conversationId: source, blocks: [{ type: "text", text: "reference" }] });
    const input = { conversationId: source, clientMsgId: "reply", text: "follow up", attachments: [], replyTo: original.id };
    expect((await store.sendMessage("owner", input)).message.replyTo).toBe(original.id);
    await expect(store.sendMessage("owner", { ...input, conversationId: target, clientMsgId: "cross" })).rejects.toThrow("reply_not_found");
    await store.publishBotMessage("alpha", { id: original.id, conversationId: source, blocks: [], status: "deleted" });
    await expect(store.sendMessage("owner", { ...input, clientMsgId: "deleted" })).rejects.toThrow("reply_not_found");
  });

  it("retires recalled attachment IDs before GC without breaking forwarded copies or fresh uploads", async () => {
    const id = await upload("recalled.txt", "text/plain", "recalled bytes");
    const original = await store.publishBotMessage("alpha", { conversationId: source, blocks: [{ type: "file", attachmentId: id, name: "recalled.txt", size: 14, mime: "text/plain" }] });
    const copied = (await forward(original)).message.blocks.find(b => b.type === "file")!;
    await store.publishBotMessage("alpha", { id: original.id, conversationId: source, status: "deleted", blocks: [] });
    await expect(files.download({ userId: "owner" }, id)).rejects.toThrow("attachment_not_found");
    await expect(files.download({ botId: "alpha" }, id)).rejects.toThrow("attachment_not_found");
    await expect(store.sendMessage("owner", { conversationId: source, clientMsgId: "resurrect", text: "again", attachments: [id] })).rejects.toThrow("attachment_not_found");
    await expect(store.publishBotMessage("alpha", { conversationId: source, blocks: [{ type: "file", attachmentId: id, name: "again", size: 14, mime: "text/plain" }] })).rejects.toThrow("attachment_not_found");
    expect(await readFile((await files.download({ botId: "beta" }, copied.attachmentId)).path, "utf8")).toBe("recalled bytes");
    const fresh = await upload("recalled.txt", "text/plain", "recalled bytes");
    expect(fresh).not.toBe(id); // Actual re-upload may publish identical bytes with a new ID.
    await store.sendMessage("owner", { conversationId: source, clientMsgId: "fresh", text: "new upload", attachments: [fresh] });
    expect(await new HubMaintenance(store, root).collectOrphans(Date.now() + 1)).toBe(1);
    await files.download({ userId: "owner" }, fresh);
  });

  it("keeps an attachment available until its last already-published reference is recalled", async () => {
    const id = await upload("shared.txt", "text/plain");
    const blocks: Block[] = [{ type: "file", attachmentId: id, name: "shared.txt", size: 5, mime: "text/plain" }];
    const first = await store.publishBotMessage("alpha", { conversationId: source, blocks });
    const second = await store.publishBotMessage("alpha", { conversationId: source, blocks });
    await store.publishBotMessage("alpha", { id: first.id, conversationId: source, status: "deleted", blocks: [] });
    await files.download({ userId: "owner" }, id);
    await store.publishBotMessage("alpha", { id: second.id, conversationId: source, status: "deleted", blocks: [] });
    await expect(files.download({ userId: "owner" }, id)).rejects.toThrow("attachment_not_found");
  });

  it("migrates recalled nested-card attachments from retained v10 events and preserves the retirement across restart", async () => {
    const id = await upload("nested.png", "image/png");
    const unpublished = await upload("draft.txt", "text/plain");
    const message = await store.publishBotMessage("alpha", { conversationId: source, blocks: [{ type: "card", elements: [{ type: "column", children: [{ type: "image", attachmentId: id }, { type: "button", text: "Metadata", value: { attachmentId: unpublished } }] }] }] });
    await store.publishBotMessage("alpha", { id: message.id, conversationId: source, status: "deleted", blocks: message.blocks });
    expect((await store.messageForBot("alpha", message.id)).blocks).toEqual([]);
    await store.db.exec("DROP TABLE retired_attachments; UPDATE meta SET value='10' WHERE key='schema_version'");
    await store.db.close(); store = await HubStore.open(root); files = new HubAttachments(store, root);
    await expect(files.download({ userId: "owner" }, id)).rejects.toThrow("attachment_not_found");
    await files.download({ userId: "owner" }, unpublished);
    await store.sendMessage("owner", { conversationId: source, clientMsgId: "unrelated-draft", text: "draft", attachments: [unpublished] });
    await store.db.close(); store = await HubStore.open(root); files = new HubAttachments(store, root);
    await expect(files.status("owner", id)).rejects.toThrow("upload_not_found");
    expect(await new HubMaintenance(store, root).collectOrphans(Date.now() + 1)).toBe(1);
    expect(await store.db.all("SELECT * FROM retired_attachments")).toEqual([]);
  });

  it("validates a small source-ID forwarding request without accepting forged provenance", () => {
    const parsed = clientFrameSchema.parse({ v: 1, type: "message.forward", clientMsgId: "request", conversationId: "target", sourceMessageId: "source", forwardedFrom: { authorName: "forged" } });
    expect(parsed).not.toHaveProperty("forwardedFrom");
    expect(clientFrameSchema.safeParse({ ...parsed, sourceMessageId: "../file" }).success).toBe(false);
  });
});
