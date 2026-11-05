import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { extractLinks, normalizedLink, linkUrlSchema } from "../src/client-protocol/links.js";
import { isPublicPreviewAddress, readPublicResource, type PreviewTransport } from "../src/hub/public-web.js";
import { readPageMetadata, fetchLinkPreview, HubLinkPreviews } from "../src/hub/link-previews.js";
import { HubStore } from "../src/hub/store.js";
import { HubAttachments } from "../src/hub/attachments.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const html = '<title>Fallback</title><meta property="og:title" content="A &amp; B"><meta name="description" content="fallback"><meta property="og:description" content="Product overview"><meta property="og:site_name" content="Example"><meta property="og:image" content="/cover.png">';
const response = (status: number, content: string | Buffer, headers: Record<string, string> = {}) => ({ status, headers: new Headers(headers), body: (async function* () { yield Buffer.from(content); })() });
describe("public web previews", () => {
  it("omits previews whose normalized URL exceeds the protocol limit", () => {
    const long = "https://example.org/" + "中".repeat(230);
    expect(long.length).toBeLessThan(2048);
    expect(new URL(long).href.length).toBeGreaterThan(2048);
    expect(normalizedLink(long)).toBeUndefined();
    expect(extractLinks(`正文 ${long} 和 https://example.org/中文`)).toEqual([new URL("https://example.org/中文").href]);
    for (const link of extractLinks("https://example.org/中文")) expect(linkUrlSchema.safeParse(link).success).toBe(true);
  });
  it("extracts ordered distinct links without code, embedded images or trailing prose punctuation", () => {
    expect(extractLinks('看 https://example.org/a。 [B](https://example.org/b?q=1&x=2) https://example.org/a\n`https://secret.test`\n```\nhttps://code.test\n```\n![image](https://image.test/x.png)')).toEqual(["https://example.org/a", "https://example.org/b?q=1&x=2"]);
    expect(extractLinks("https://user:password@example.org/ javascript:alert(1) https://example.org/wiki/A_(B)")).toEqual(["https://example.org/wiki/A_(B)"]);
  });
  it("uses OG and standard title metadata, decodes entities, resolves cover paths and ignores script/comment metadata", () => {
    expect(readPageMetadata(html, "https://example.org/article")).toEqual({ title: "A & B", description: "Product overview", siteName: "Example", imageUrl: "https://example.org/cover.png" });
    expect(readPageMetadata('<script><meta property="og:title" content="forged"></script><!-- <title>hidden</title> --><title>真实标题 &lt;b&gt;</title>', "https://example.org").title).toBe("真实标题 <b>");
  });
  it("blocks local, reserved, mapped, CGNAT and non-global IPs while accepting public v4/v6", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.2.3", "192.168.1.1", "169.254.169.254", "100.100.100.100", "0.0.0.0", "224.1.1.1", "192.0.2.1", "198.18.0.1", "::1", "::ffff:127.0.0.1", "fd7a:115c:a1e0::1", "fe80::1", "2001:db8::1", "2002:7f00:1::"]) expect(isPublicPreviewAddress(ip), ip).toBe(false);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPublicPreviewAddress(ip), ip).toBe(true);
  });
  it("pins resolved addresses and revalidates every redirect, including mixed DNS answers", async () => {
    const request = vi.fn<PreviewTransport>(async () => response(302, "", { location: "http://127.0.0.1/private" }));
    await expect(readPublicResource("https://example.org", "text/html", 1024, AbortSignal.timeout(2000), { lookup: async () => [{ address: "8.8.8.8", family: 4 }], request })).rejects.toThrow("preview_address_blocked");
    expect(request).toHaveBeenCalledTimes(1); expect(request.mock.calls[0]![1]).toEqual({ address: "8.8.8.8", family: 4 });
    await expect(readPublicResource("https://mixed.test", "text/html", 1024, AbortSignal.timeout(2000), { lookup: async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }], request })).rejects.toThrow("preview_address_blocked");
    expect(request).toHaveBeenCalledTimes(1);
    for (const url of ["file:///etc/passwd", "http://2130706433", "http://[::1]", "https://user:password@example.org", "https://example.org:22"]) await expect(readPublicResource(url, "text/html", 1024, AbortSignal.timeout(2000), { request })).rejects.toThrow();
  });
  it("bounds response bytes, redirects and content types; a bad cover does not erase useful page metadata", async () => {
    const lookup = async () => [{ address: "8.8.8.8", family: 4 }];
    const compressed = gzipSync("x".repeat(2000));
    await expect(readPublicResource("https://example.org", "text/html", 1000, AbortSignal.timeout(2000), { lookup, request: async () => response(200, compressed, { "content-type": "text/html", "content-encoding": "gzip" }) })).rejects.toThrow("preview_too_large");
    const encoded = await readPublicResource("https://example.org", "text/html", 1024, AbortSignal.timeout(2000), { lookup, request: async () => response(200, gzipSync("<title>OK</title>"), { "content-type": "text/html; charset=gb18030", "content-encoding": "gzip" }) });
    expect(encoded.body.toString()).toBe("<title>OK</title>"); expect(encoded.charset).toBe("gb18030");
    await expect(readPublicResource("https://example.org", "text/html", 10, AbortSignal.timeout(2000), { lookup, request: async () => response(200, "too much text here", { "content-type": "text/html" }) })).rejects.toThrow("preview_too_large");
    await expect(readPublicResource("https://example.org", "text/html", 1024, AbortSignal.timeout(2000), { lookup, request: async () => response(200, "pdf", { "content-type": "application/pdf" }) })).rejects.toThrow("preview_content_type");
    await expect(readPublicResource("https://example.org", "text/html", 1024, AbortSignal.timeout(2000), { lookup, request: async () => response(302, "", { location: "/again" }) })).rejects.toThrow("preview_redirect_limit");
    const result = await fetchLinkPreview("https://example.org/article", AbortSignal.timeout(2000), async (url) => { if (url.endsWith(".png")) throw new Error("image blocked"); return { url, mime: "text/html", body: Buffer.from(html) }; });
    expect(result).toMatchObject({ status: "ready", title: "A & B", siteName: "Example" }); expect(result.image).toBeUndefined();
  });
});

let root: string | undefined, store: HubStore | undefined, previews: HubLinkPreviews | undefined;
afterEach(async () => { await previews?.stop(); await store?.db.close(); if (root) await rm(root, { recursive: true, force: true }); root = undefined; store = undefined; previews = undefined; });
it("indexes pending preview discovery on fresh and upgraded stores without scanning history", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "link-preview-index-"));
  store = await HubStore.open(root);
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
  await store.db.run("INSERT INTO users VALUES('outsider','Outsider','member')");
  const conversation = await store.createConversation("owner", ["alpha"], "Previews", "previews");
  // Historical bodies must not be visited on each 500 ms sweep, even when
  // there are no eligible previews. The query-plan assertion is speed-independent.
  await store.db.run(`WITH RECURSIVE history(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM history WHERE n<2000)
    INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at)
    SELECT 'history_'||n,?,'alpha','bot','[]','complete',1,n FROM history`, [conversation.id]);
  const completed = JSON.stringify({ url: "https://example.org/", status: "ready", title: "Existing", siteName: "Example" });
  for (const [id, author, type, status, url, preview] of [
    ["disabled", "owner", "user", "complete", "", null],
    ["no_link", "owner", "user", "complete", null, null],
    ["finished", "owner", "user", "complete", "https://example.org/", completed],
    ["deleted", "owner", "user", "deleted", "https://example.org/", null],
    ["bot_link", "alpha", "bot", "complete", "https://example.org/", null],
    ["not_member", "outsider", "user", "complete", "https://example.org/", null],
    ["first", "owner", "user", "error", "https://example.org/", null],
    ["second", "owner", "user", "complete", "https://example.org/", null],
  ] as const) {
    await store.db.run("INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at,preview_url,link_preview_json) VALUES(?,?,?,?,'[]',?,1,0,?,?)", [id, conversation.id, author, type, status, url, preview]);
  }
  const verify = async (expected: string[]) => {
    const calls = vi.spyOn(store!.db, "all");
    try {
      expect((await store!.pendingLinkPreviews()).map(message => message.id)).toEqual(expected);
      const sql = calls.mock.calls.find(([sql]) => sql.startsWith("SELECT m.* FROM messages m"))![0];
      const plan = await store!.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`);
      expect(plan.some(row => row.detail.includes("USING INDEX messages_pending_link_previews"))).toBe(true);
      expect(plan.some(row => row.detail.includes("TEMP B-TREE"))).toBe(false);
    } finally { calls.mockRestore(); }
  };
  await verify(["first", "second"]);
  // Reopening an existing schema-22 store must add the missing index, with
  // no data rewrite or protocol/schema bump.
  await store.db.exec("DROP INDEX messages_pending_link_previews");
  await store.db.close(); store = await HubStore.open(root);
  await verify(["first", "second"]);
  await store.setLinkPreview("first", { url: "https://example.org/", status: "ready", title: "Ready", siteName: "Example" });
  await store.db.run("UPDATE messages SET status='deleted' WHERE id='second'");
  await verify([]);
});
it("settles oversized covers without starving newer previews or altering message text", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "link-preview-small-limit-"));
  store = await HubStore.open(root);
  const attachments = new HubAttachments(store, root, 1);
  await attachments.initialize();
  previews = new HubLinkPreviews(store, attachments);
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
  const conversation = await store.createConversation("owner", ["alpha"], "Preview", "preview");
  previews.read = vi.fn(async (url: string) => ({ url, status: "ready" as const, title: "Title", siteName: "Example", image: { mime: "image/png", body: png } }));
  const sent = [];
  for (let i = 0; i < 5; i++) sent.push(await store.sendMessage("owner", { conversationId: conversation.id, clientMsgId: `preview-${i}`, text: `https://example.org/${i}`, attachments: [] }));
  await previews.tick(); await previews.tick();
  expect(await store.pendingLinkPreviews()).toEqual([]);
  for (const result of sent) {
    const message = await store.messageForUser("owner", result.message.id);
    expect(message.blocks).toEqual(result.message.blocks);
    expect(message.linkPreview).toMatchObject({ status: "ready", title: "Title" });
    expect(message.linkPreview?.imageAttachmentId).toBeUndefined();
  }
  expect(previews.read).toHaveBeenCalledTimes(5);
  expect(await store.pendingForBot("alpha")).toHaveLength(5);
  const text = "https://example.org/" + "中".repeat(230);
  const long = await store.sendMessage("owner", { conversationId: conversation.id, clientMsgId: "long-url", text, attachments: [] });
  expect(long.message.blocks).toEqual([{ type: "text", text }]);
  expect(await store.pendingLinkPreviews()).toEqual([]);
});
it("persists one preview across devices/restart, scopes its cover, forwards it, and never redispatches the user message", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "link-preview-")); store = await HubStore.open(root); const attachments = new HubAttachments(store, root); await attachments.initialize(); previews = new HubLinkPreviews(store, attachments);
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
  await store.db.run("INSERT INTO users VALUES('member','Member','member')");
  const source = await store.createConversation("owner", ["alpha"], "Source", "source"), target = await store.createConversation("owner", ["alpha"], "Target", "target");
  previews.read = vi.fn<HubLinkPreviews["read"]>(async (url) => ({ url, status: "ready", title: "A & B", siteName: "Example", description: "Product overview", image: { mime: "image/png", body: png } }));
  await expect(previews.prepare("member", source.id, "https://example.org/")).rejects.toThrow("conversation_forbidden"); expect(previews.read).not.toHaveBeenCalled();
  const draft = await previews.prepare("owner", source.id, "https://example.org/");
  const sent = await store.sendMessage("owner", { conversationId: source.id, clientMsgId: "link", text: "看看 https://example.org/", attachments: [], previewStyle: "inline" }); await previews.tick();
  const enriched = await store.messageForUser("owner", sent.message.id); expect(enriched.linkPreview).toEqual(draft); expect(previews.read).toHaveBeenCalledTimes(1); expect(await store.pendingForBot("alpha")).toHaveLength(1);
  expect(enriched.previewStyle).toBe("inline");
  expect((await store.sync("owner", source.id, 0)).events.map((e) => e.kind)).toEqual(["message.created", "message.updated"]);
  await expect(attachments.download({ userId: "member" }, draft.imageAttachmentId!)).rejects.toThrow("conversation_forbidden");
  const copied = await attachments.forward("owner", { v: 1, type: "message.forward", clientMsgId: "forward", sourceMessageId: enriched.id, conversationId: target.id });
  expect(copied.message.linkPreview?.title).toBe("A & B"); expect(copied.message.linkPreview?.imageAttachmentId).not.toBe(draft.imageAttachmentId);
  expect(copied.message.previewStyle).toBe("inline");
  const cover = await attachments.download({ userId: "owner" }, copied.message.linkPreview!.imageAttachmentId!); expect(await readFile(cover.path)).toEqual(png);
  expect((await previews.prepare("owner", target.id, "https://example.org/")).imageAttachmentId).toBe(copied.message.linkPreview!.imageAttachmentId);
  await store.sendMessage("owner", { conversationId: source.id, clientMsgId: "disabled", text: "https://example.org/private", attachments: [], previewUrl: null });
  await expect(store.sendMessage("owner", { conversationId: source.id, clientMsgId: "forged", text: "https://example.org", attachments: [], previewUrl: "https://other.example.org" })).rejects.toThrow("preview_url_not_in_message");
  await previews.tick(); expect(previews.read).toHaveBeenCalledTimes(1);
  const late = await store.sendMessage("owner", { conversationId: source.id, clientMsgId: "late", text: "https://example.org/late", attachments: [] });
  const latest = await store.sendMessage("owner", { conversationId: source.id, clientMsgId: "newer", text: "Newest message", attachments: [] });
  await previews.tick();
  const snapshot = []; for await (const frame of store.snapshotFrames("owner", source.id, 999)) snapshot.push(frame);
  const lateFrame = snapshot.find((frame) => frame.type === "snapshot.message" && frame.message.id === late.message.id)!;
  const latestFrame = snapshot.find((frame) => frame.type === "snapshot.message" && frame.message.id === latest.message.id)!;
  if (lateFrame.type !== "snapshot.message" || latestFrame.type !== "snapshot.message") throw new Error("missing snapshot message");
  expect(lateFrame.contentSeq).toBeLessThan(latestFrame.contentSeq);
  const lateEvents = (await store.sync("owner", source.id, 0)).events;
  expect(lateFrame.contentAt).toBe(lateEvents.find(event => event.seq === lateFrame.contentSeq)!.at);
  expect(latestFrame.contentAt).toBe(lateEvents.find(event => event.seq === latestFrame.contentSeq)!.at);
  expect((await store.search("owner", "example", { hasFile: true })).map((message) => message.id)).not.toContain(enriched.id);
  await previews.stop(); await store.db.close(); store = await HubStore.open(root); previews = undefined;
  expect((await store.messageForUser("owner", enriched.id)).linkPreview).toEqual(draft);
  expect((await store.messageForUser("owner", enriched.id)).previewStyle).toBe("inline");
});

it("migrates schema 7 previews without rewriting messages/events and rejects corrupted persisted styles", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "link-migration-")); store = await HubStore.open(root);
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
  const conversation = await store.createConversation("owner", ["alpha"], "History", "history");
  const { message } = await store.sendMessage("owner", { conversationId: conversation.id, clientMsgId: "old", text: "https://example.org/", attachments: [] });
  await store.setLinkPreview(message.id, { url: "https://example.org/", status: "ready", title: "Existing title", siteName: "Example" });
  const before = await store.snapshot("owner", conversation.id), events = await store.sync("owner", conversation.id, 0);
  await store.db.exec("ALTER TABLE messages DROP COLUMN preview_style; UPDATE meta SET value='7' WHERE key='schema_version'");
  await store.db.close(); store = await HubStore.open(root);
  expect((await store.db.get<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'"))?.value).toBe("25");
  expect(await store.snapshot("owner", conversation.id)).toEqual(before);
  expect(await store.sync("owner", conversation.id, 0)).toEqual(events);
  expect((await store.messageForUser("owner", message.id)).previewStyle).toBeUndefined();
  await store.db.run("UPDATE messages SET preview_style='iframe' WHERE id=?", [message.id]);
  await expect(store.messageForUser("owner", message.id)).rejects.toThrow();
});
