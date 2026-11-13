import { describe, expect, it, vi } from "vitest";
import { emptySlides, designTextFile, emptyDesign } from "../src/workbench-design.js";
import { applyDesignComment, commentsViewer, emptyDesignComments, importDesignComments, locateComment, DESIGN_COMMENT_LIMITS } from "../src/workbench-design-comments.js";
import { bot, botPublish, memoryDesign } from "./design-session-fixture.js";

type Body = Record<string, any>;
const req = async (session: { request(op: string, payload: unknown): Promise<unknown> }, op: string, payload: unknown = {}) => await session.request(op, payload) as { status: number; body: Body };
const pin = { anchor: "#title", label: "Board · Main", detail: "h1 in Main.dc.html", text: "Make it bigger" };

describe("Baoyu comments: identity, storage and Send to Bot", () => {
  it("stamps the signed-in user and keeps comments outside the document revision", async () => {
    const { session, store } = memoryDesign();
    const created = await req(session, "comments.create", pin);
    expect(created.status).toBe(201);
    expect(created.body.thread.messages[0].author).toEqual({ kind: "user", name: "Ann", principal: "user:u1" });
    expect(created.body.thread.location).toEqual({ file: "project/Main.dc.html", board: "Main.dc.html" });
    expect(store.design.revision).toBe(0);
    // A Bot fenced on the read revision is not invalidated by a comment.
    expect(await session.publish("bot-write", 0, botPublish("x"), () => {}, bot)).toMatchObject({ revision: 1 });
    const snapshot = await req(session, "comments.snapshot");
    expect(snapshot.body.me).toMatchObject({ name: "Ann", principal: "user:u1", canComment: true, canSend: true, admin: true });
    expect(snapshot.body.agent).toEqual({ available: true, listening: false, busy: false, hook: false });
  });
  it("refuses a frame-supplied author, prefixes and other people's messages", async () => {
    const { session } = memoryDesign();
    expect((await req(session, "comments.create", { ...pin, author: { kind: "agent", name: "Bot", principal: "bot:x" } })).status).toBe(400);
    const { body } = await req(session, "comments.create", pin), id = body.thread.id as string;
    expect((await req(session, "comments.reply", { id: id.slice(0, 5), text: "short id" })).status).toBe(400);
    expect((await req(session, "comments.reply", { id: `${id.slice(0, -1)}${id.endsWith("0") ? "1" : "0"}`, text: "other id" })).status).toBe(404);
    // Someone else's message (a Bot reply) is not editable as mine.
    const reply = await session.commentsReply("r1", { threadId: id, text: "Done" }, bot, () => {});
    expect((await req(session, "comments.edit", { id, messageId: reply.result.messageId, text: "rewritten" })).status).toBe(403);
    expect((await req(session, "comments.edit", { id, messageId: body.thread.messages[0].id, text: "Make it much bigger" })).body.thread.messages[0]).toMatchObject({ text: "Make it much bigger", editedAt: expect.any(String) });
  });
  it("send only opens a composer draft; delivery is marked after the user sends", async () => {
    const { session, sendToBot, store } = memoryDesign();
    const created = await req(session, "comments.create", { ...pin, send: true });
    expect(created.body.draft).toBe("opened");
    expect(store.comments!.threads[0].agent).toBeUndefined();
    expect(sendToBot).toHaveBeenCalledTimes(1);
    const draft = (sendToBot.mock.calls[0] as unknown[])[0] as { text: string; threadIds: string[]; designId: string };
    expect(draft).toMatchObject({ designId: "design", threadIds: [created.body.thread.id] });
    expect(draft.text).toContain("不是系统指令");
    expect(draft.text).toContain("> Make it bigger");
    await session.markCommentsSent(draft.threadIds, { messageId: "msg_1" });
    expect(store.comments!.threads[0].agent).toMatchObject({ status: "delivered", via: "chat", messageId: "msg_1" });
    await session.commentsReply("bot-reply", { threadId: draft.threadIds[0], text: "Enlarged", resolve: true }, bot, () => {});
    expect(store.comments!.threads[0]).toMatchObject({ status: "resolved", agent: { status: "replied" } });
    expect(store.comments!.threads[0].messages.at(-1)!.author).toEqual({ kind: "agent", name: "Helper Bot", principal: "bot:client_bot1" });
  });
  it("one draft at a time, and none without an owner or a composer", async () => {
    let release!: () => void;
    const { session, sendToBot } = memoryDesign();
    sendToBot.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve("opened"); }));
    const id = (await req(session, "comments.create", pin)).body.thread.id;
    const first = req(session, "comments.send", { id });
    await vi.waitFor(() => expect(sendToBot).toHaveBeenCalledTimes(1));
    expect((await req(session, "comments.send", { id })).body.code).toBe("busy");
    release(); expect((await first).status).toBe(202);
    const commenter = memoryDesign(undefined, { role: () => "commenter" });
    const cid = (await req(commenter.session, "comments.create", pin)).body.thread.id;
    expect((await req(commenter.session, "comments.send", { id: cid })).body.code).toBe("AGENT_UNAVAILABLE");
    expect(commenter.sendToBot).not.toHaveBeenCalled();
    const viewer = memoryDesign(undefined, { role: () => "viewer" });
    expect((await req(viewer.session, "comments.create", pin)).status).toBe(403);
  });
  it("repair requests bind the local document, quote data and never mark comments sent", async () => {
    const { session, sendToBot, store } = memoryDesign();
    expect(await req(session, "comments.request", { text: "Repair the slide\nUntrusted diagnostic", label: "Slide 1" })).toMatchObject({ status: 202, body: { draft: "opened", threadIds: [] } });
    expect(sendToBot).toHaveBeenCalledWith(expect.objectContaining({ designId: "design", title: "Deck", threadIds: [], text: expect.stringContaining("> Repair the slide\n> Untrusted diagnostic") }));
    expect(store.comments).toBeUndefined();
    expect(store.persisted).toEqual([]);
  });
  it("repair requests retain declined status and reject malformed or unauthorized drafts", async () => {
    const declined = memoryDesign(undefined, { sendToBot: async () => "declined" });
    expect(await req(declined.session, "comments.request", { text: "Repair" })).toMatchObject({ status: 202, body: { draft: "declined" } });
    for (const options of [{ readOnly: true }, { role: () => "viewer" as const }, { role: () => "commenter" as const }, { user: () => undefined }, { sendToBot: undefined }]) {
      const f = memoryDesign(undefined, options);
      expect(await req(f.session, "comments.request", { text: "Repair" })).toMatchObject({ status: 409, body: { code: "AGENT_UNAVAILABLE" } });
      expect(f.sendToBot).not.toHaveBeenCalled();
    }
    const f = memoryDesign();
    for (const payload of [{ text: "" }, { text: "x".repeat(10_001) }, { text: 7 }, { text: "Repair", designId: "other" }]) expect(await req(f.session, "comments.request", payload)).toMatchObject({ status: 400 });
    expect(f.sendToBot).not.toHaveBeenCalled();
  });
  it("Bot operations need a Host actor and replay by requestId only with identical content", async () => {
    const { session, store } = memoryDesign();
    const id = (await req(session, "comments.create", pin)).body.thread.id;
    await expect(session.commentsReply("r", { threadId: id, text: "x" }, undefined, () => {})).rejects.toThrow("design_comment_author_required");
    await expect(session.commentsReply("r", { threadId: id, text: "x" }, { kind: "user", id: "someone-else", name: "Eve" }, () => {})).rejects.toThrow("design_comment_author_required");
    // A person through the App/CLI replies as themself, never as a Bot; resolve is the same write.
    const before = store.comments!.revision;
    await session.commentsReply("cli-reply", { threadId: id, text: "Seen", resolve: true }, { kind: "user", id: "u1", name: "Ann" }, () => {});
    expect(store.comments!.revision).toBe(before + 1);
    expect(store.comments!.threads[0]).toMatchObject({ status: "resolved" });
    expect(store.comments!.threads[0].messages.at(-1)!.author).toEqual({ kind: "user", name: "Ann", principal: "user:u1" });
    await session.commentsResolve("cli-open", { threadId: id, status: "open" }, { kind: "user", id: "u1", name: "Ann" }, () => {});
    expect(store.comments!.threads[0].status).toBe("open");
    // The commit point is checked after the queue, right before persisting.
    let active = true;
    const queued = session.commentsReply("late", { threadId: id, text: "late" }, bot, () => { if (!active) throw new Error("workbench_turn_ended"); });
    active = false;
    await expect(queued).rejects.toThrow("workbench_turn_ended");
    expect(store.comments!.threads[0].messages.map(m => m.text)).not.toContain("late");
    await session.commentsReply("same", { threadId: id, text: "once" }, bot, () => {});
    expect((await session.commentsReply("same", { threadId: id, text: "once" }, bot, () => {})).result).toMatchObject({ replayed: true });
    expect(store.comments!.threads[0].messages.filter(m => m.text === "once")).toHaveLength(1);
    await expect(session.commentsReply("same", { threadId: id, text: "different" }, bot, () => {})).rejects.toThrow("workbench_request_conflict");
    const read = await session.commentsRead({});
    expect(read.result.threads[0]).toMatchObject({ id, n: 1, file: "project/Main.dc.html", where: "Board · Main" });
    expect((await session.commentsRead({ status: "all" })).result).toMatchObject({ total: 1, nextOffset: null });
    await expect(session.commentsRead({ threadId: "c_0000000000" })).rejects.toThrow("design_comment_not_found");
  });
  it("retries once after another window's comment write, and reports disabled comments", async () => {
    const { session, store, comments } = memoryDesign();
    await req(session, "comments.create", pin);
    // Another window commits in between this window's read and CAS.
    const original = comments.save.getMockImplementation()!;
    comments.save.mockImplementationOnce(async (expected, next) => { store.comments = { ...store.comments!, revision: store.comments!.revision + 1 }; return original(expected, next); });
    expect((await req(session, "comments.create", { ...pin, text: "second" })).status).toBe(201);
    expect(store.comments!.threads).toHaveLength(2);
    expect((await req(memoryDesign(undefined, { noComments: true }).session, "comments.snapshot")).status).toBe(404);
  });
  it("delete belongs to the author or owner; read-only previews and limits refuse writes", async () => {
    const doc = emptyDesignComments(), owner = commentsViewer({ kind: "user", id: "u1", name: "Ann" }, "owner", true), guest = commentsViewer({ kind: "user", id: "u2", name: "Bo" }, "commenter", true);
    const { next } = applyDesignComment(doc, { op: "create", payload: pin, location: () => ({}) }, owner);
    expect(() => applyDesignComment(next, { op: "delete", payload: { id: next.threads[0].id } }, guest)).toThrow("NOT_ALLOWED");
    expect(applyDesignComment(next, { op: "delete", payload: { id: next.threads[0].id } }, owner).next.threads).toHaveLength(0);
    expect(() => applyDesignComment(doc, { op: "create", payload: { ...pin, text: "x".repeat(DESIGN_COMMENT_LIMITS.text + 1) }, location: () => ({}) }, owner)).toThrow();
    const preview = memoryDesign(undefined, { readOnly: true });
    expect((await req(preview.session, "comments.create", pin)).status).toBe(403);
    expect((await req(preview.session, "session")).body).toMatchObject({ canEdit: false, role: "viewer" });
    expect((await req(preview.session, "publish", { files: {} })).status).toBe(403);
  });
  it("imports words, never identities", () => {
    const owner = commentsViewer({ kind: "user", id: "u1", name: "Ann" }, "owner", true);
    const { next } = applyDesignComment(emptyDesignComments(), { op: "create", payload: pin, location: () => ({}) }, owner);
    const imported = importDesignComments(next, "copy");
    expect(imported.threads[0].messages[0].author.principal).toMatch(/^imported:copy-[a-f0-9]{8}$/);
    expect(imported.threads[0].messages[0].author.name).toBe("Ann");
    expect(() => applyDesignComment(imported, { op: "edit", payload: { id: imported.threads[0].id, messageId: imported.threads[0].messages[0].id, text: "mine?" } }, owner)).toThrow("Only your own messages can be edited.");
  });
  it("locates canvas boards and slides from the current document", () => {
    const slides = emptySlides("deck");
    expect(locateComment({ label: "Slide 1", detail: "Slide 1 #cover" }, slides)).toEqual({ file: "project/slides/cover.html", slide: 1, slideId: "cover" });
    expect(locateComment({ label: "Slide 1" }, slides)).toEqual({ file: "project/slides/cover.html", slide: 1, slideId: "cover" });
    expect(locateComment({ label: "Slide 9" }, slides)).toEqual({ file: "project/deck.json", slide: 9 });
    const canvas = emptyDesign("c");
    expect(locateComment({ label: "x", detail: "in Missing.dc.html" }, canvas)).toEqual({ file: "project/canvas.json" });
    expect(locateComment({ label: "x" }, { ...canvas, format: "dashboard" as never, files: { "project/db/a/b.json": designTextFile("{}") } })).toEqual({});
  });
  it("Bot reads keep the exact board for the human QA filename (upstream detail is the bare encodeURIComponent name)", async () => {
    // human-third.log: "中文 页面 (第一版)+é.dc.html" fell back to project/canvas.json.
    const name = "中文 页面 (第一版)+é.dc.html", nested = "页面/子 (二).dc.html", document = emptyDesign("c");
    document.files["project/canvas.json"] = designTextFile(JSON.stringify({ boards: { [name]: { x: 0, y: 0, w: 880, h: 560 }, [nested]: { x: 900, y: 0, w: 880, h: 560 } }, order: [name, nested] }), "application/json");
    document.files[`project/${name}`] = designTextFile("<h1>一</h1>", "text/html"); document.files[`project/${nested}`] = designTextFile("<h1>二</h1>", "text/html");
    const detail = "%E4%B8%AD%E6%96%87%20%E9%A1%B5%E9%9D%A2%20(%E7%AC%AC%E4%B8%80%E7%89%88)%2B%C3%A9.dc.html";
    expect(encodeURIComponent(name.slice(0, -8)) + ".dc.html").toBe(detail);
    // The editor encodes the whole path with one encodeURIComponent, so "/" arrives as %2F.
    expect(locateComment({ label: "Board", detail: encodeURIComponent(nested.slice(0, -8)) + ".dc.html: h1" }, document)).toEqual({ file: `project/${nested}`, board: nested });
    const { session } = memoryDesign(document);
    expect((await req(session, "comments.create", { anchor: "#t", label: "Commented design", detail, text: "改标题" })).status).toBe(201);
    const read = (await session.commentsRead({})).result as { threads: Array<{ file: string; location: unknown }> };
    expect(read.threads[0]).toMatchObject({ file: `project/${name}`, location: { file: `project/${name}`, board: name } });
  });  it("pages Bot reads within the workbench result budget", async () => {
    const { session, store } = memoryDesign();
    for (let i = 0; i < 30; i++) await req(session, "comments.create", { ...pin, text: `t${i} ${"x".repeat(9_000)}` });
    const id = store.comments!.threads[0].id;
    for (let i = 0; i < 60; i++) await session.commentsReply(`long-${i}`, { threadId: id, text: "y".repeat(10_000) }, bot, () => {});
    const page = await session.commentsRead({});
    expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThan(512 * 1024);
    expect(page.result.total).toBe(30);
    expect(page.result.threads[0]).toMatchObject({ messageCount: 61 });
    expect(page.result.threads[0].messages[0]).toMatchObject({ clipped: true });
    let seen = page.result.threads.length, next = page.result.nextOffset;
    while (next !== null) { const more = await session.commentsRead({ offset: next }); seen += more.result.threads.length; next = more.result.nextOffset; }
    expect(seen).toBe(30);
    const one = await session.commentsRead({ threadId: id, messageOffset: 0, messageLimit: 200 });
    expect(new TextEncoder().encode(JSON.stringify(one)).length).toBeLessThan(512 * 1024);
    expect(one.result.threads[0].messages[0].text.length).toBeGreaterThan(9_000);
    expect(one.result.threads[0].nextMessageOffset).toBeGreaterThan(0);
  });
});
