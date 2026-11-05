import { describe, expect, it, vi } from "vitest";
import { emptyMarkdown, markdownEditorText, markdownFromEditor, MarkdownSession, patchMarkdown, readMarkdown, type MarkdownDocument } from "../src/workbench-markdown.js";

function fixture(content = "# Plan\n\nKeep this paragraph.\n") {
  let stored = emptyMarkdown("note", content), fail = false;
  const session = new MarkdownSession(stored, async (expected, next) => {
    if (fail) throw new Error("quota_exceeded");
    if (expected !== stored.revision) throw new Error("markdown_revision_conflict");
    stored = structuredClone(next);
  });
  session.setWritable(true);
  return { session, stored: () => stored, fail: (value: boolean) => { fail = value; } };
}
describe("workbench Markdown editing", () => {
  it("keeps untouched BOM and mixed line breaks, and retains consistent CRLF or CR after edits", () => {
    for (const text of ["\ufeffA\r\nB\r\n", "A\rB\r", "A\r\nB\nC\r"]) expect(markdownFromEditor(markdownEditorText(text), text)).toBe(text);
    expect(markdownFromEditor("A\nB!\n", "A\r\nB\r\n")).toBe("A\r\nB!\r\n");
    expect(markdownFromEditor("A\nB!\n", "A\rB\r")).toBe("A\rB!\r");
  });
  it("reacquires a released writer for an emergency draft without rebasing its revision", async () => {
    let available = false, disk = emptyMarkdown("recover", "Original");
    vi.stubGlobal("navigator", { locks: { request: async (_name: string, _options: unknown, callback: (lock: unknown) => Promise<void>) => callback(available ? {} : null) } });
    const session = new MarkdownSession(disk, async (expected, next) => { if (expected !== disk.revision) throw Error("markdown_revision_conflict"); disk = structuredClone(next); }, () => {}, async () => disk);
    try {
      await session.acquire("recovery-lock"); session.restoreDraft("Recovered", 0); expect(session.readOnly).toBe(true);
      available = true; await session.refresh(); expect(session.text()).toBe("Recovered"); expect(session.readOnly).toBe(false);
      await session.flush(); expect(disk.content).toBe("Recovered");
    } finally { session.dispose(); vi.unstubAllGlobals(); }
  });
  it("applies only unique exact excerpts, including overlapping duplicates, atomically", () => {
    const original = "One\nTwo\nOne";
    expect(() => patchMarkdown(original, { edits: [{ oldText: "One", newText: "Changed" }] })).toThrow("markdown_text_ambiguous");
    expect(() => patchMarkdown("aaa", { edits: [{ oldText: "aa", newText: "b" }] })).toThrow("markdown_text_ambiguous");
    expect(() => patchMarkdown(original, { edits: [{ oldText: "Two", newText: "Changed" }, { oldText: "Missing", newText: "Oops" }] })).toThrow("markdown_text_missing");
    expect(original).toBe("One\nTwo\nOne");
    expect(patchMarkdown(original, { edits: [{ oldText: "One\nTwo", newText: "First\nSecond" }, { oldText: "Second", newText: "Done" }] })).toBe("First\nDone\nOne");
  });
  it("rejects a stale Bot replacement after unsaved local typing", async () => {
    const f = fixture(); f.session.local("My unsaved change");
    expect(await f.session.replace({ requestId: "bot", expectedRevision: 0 }, { content: "Overwrite" })).toMatchObject({ status: "conflict", error: "markdown_revision_conflict" });
    expect(f.stored().content).toBe("My unsaved change");
  });
  it("retains typing during a delayed save and rejects an already stale Bot patch", async () => {
    let release!: () => void, entered!: () => void, stored = emptyMarkdown("note", "Old");
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    const session = new MarkdownSession(stored, async (_expected, next) => { entered(); await gate; stored = structuredClone(next); }); session.setWritable(true);
    session.local("First typing"); const flush = session.flush(); await ready;
    session.local("Newest typing"); release(); await flush;
    expect(session.text()).toBe("Newest typing"); expect(session.dirty()).toBe(true);
    const patched = await session.replace({ requestId: "old-bot", expectedRevision: 1 }, { content: "Bot stale write" });
    expect(patched.status).toBe("conflict"); expect(stored.content).toBe("Newest typing");
  });
  it("does not claim saved after quota failure, and retries the same edit once", async () => {
    const f = fixture(); f.fail(true);
    const request = { requestId: "replace", expectedRevision: 0 }, payload = { content: "Saved later" };
    expect(await f.session.replace(request, payload)).toMatchObject({ status: "applied_not_saved", saved: false, revision: 1 });
    expect(f.session.text()).toBe("Saved later"); expect(f.stored().revision).toBe(0);
    f.fail(false); expect(await f.session.replace(request, payload)).toMatchObject({ status: "applied", saved: true, revision: 1, result: { duplicate: true } });
    expect(f.stored().undo).toHaveLength(1);
    expect(await f.session.replace(request, { content: "Different" })).toMatchObject({ status: "conflict", error: "markdown_request_conflict" });
  });
  it("preserves Bot edit receipts and undo/redo after reopening", async () => {
    const f = fixture("Original");
    await f.session.patch({ requestId: "patch", expectedRevision: 0 }, { edits: [{ oldText: "Original", newText: "Revised" }] });
    const reopened = new MarkdownSession(f.stored(), async () => undefined); reopened.setWritable(true);
    expect(await reopened.patch({ requestId: "patch", expectedRevision: 0 }, { edits: [{ oldText: "Original", newText: "Revised" }] })).toMatchObject({ status: "applied", revision: 1, result: { duplicate: true } });
    expect(await reopened.undo({ requestId: "undo", expectedRevision: 1 })).toMatchObject({ status: "applied", revision: 2 }); expect(reopened.text()).toBe("Original");
    expect(await reopened.redo({ requestId: "redo", expectedRevision: 2 })).toMatchObject({ status: "applied", revision: 3 }); expect(reopened.text()).toBe("Revised");
  });
  it("does not partially mutate on a later invalid patch and handles empty undo content", async () => {
    const f = fixture(""); await f.session.replace({ requestId: "first", expectedRevision: 0 }, { content: "One\nTwo" });
    expect(await f.session.patch({ requestId: "bad", expectedRevision: 1 }, { edits: [{ oldText: "One", newText: "Changed" }, { oldText: "Missing", newText: "Changed" }] })).toMatchObject({ status: "not_executed" });
    expect(f.session.text()).toBe("One\nTwo"); expect(f.session.document.revision).toBe(1);
    await f.session.undo({ requestId: "empty", expectedRevision: 1 }); expect(f.session.text()).toBe("");
  });
  it("retains the writer and unsaved draft if retirement cannot save", async () => {
    const f = fixture(); f.fail(true); f.session.local("Don't discard");
    await expect(f.session.retire()).rejects.toThrow("quota_exceeded"); expect(f.session.active).toBe(true); expect(f.session.text()).toBe("Don't discard");
    f.fail(false); await f.session.retire(); expect(f.session.active).toBe(false); expect(f.stored().content).toBe("Don't discard");
  });
  it("fences a closed/read-only session and cancelled request before mutation", async () => {
    const f = fixture(); f.session.setWritable(false);
    expect(await f.session.replace({ requestId: "readonly", expectedRevision: 0 }, { content: "Bad" })).toMatchObject({ status: "not_executed", error: "markdown_read_only" });
    f.session.setWritable(true);
    expect(await f.session.replace({ requestId: "cancelled", expectedRevision: 0, assertActive: () => { throw new Error("workbench_cancelled"); } }, { content: "Bad" })).toMatchObject({ status: "not_executed" });
    f.session.dispose(); expect(await f.session.undo({ requestId: "closed", expectedRevision: 0 })).toMatchObject({ status: "not_executed", error: "markdown_closed" }); expect(f.stored().revision).toBe(0);
  });
  it("bounds UTF-8 content and history while keeping Unicode read pages valid and forward-only", async () => {
    const f = fixture(""); expect(() => f.session.local("中".repeat(50_000))).toThrow("markdown_too_large");
    for (let i = 0; i < 16; i++) { f.session.local(`Change ${i}`); await f.session.flush(); }
    expect(f.session.document.undo).toHaveLength(12);
    const text = "😀A😀中", pages: string[] = []; let offset: number | null = 0;
    while (offset !== null) { const page = readMarkdown(text, offset, 1); pages.push(page.content); if (page.nextOffset !== null) expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset; }
    expect(pages.join("")).toBe(text); expect(pages).toEqual(["😀", "A", "😀", "中"]);
    expect(readMarkdown(text, 999, 10)).toMatchObject({ content: "", nextOffset: null, eof: true });
  });
  it("retains composition drafts and blocks Bot edits until composition ends", async () => {
    const session = new MarkdownSession(emptyMarkdown("note", "before"), async () => undefined); session.setWritable(true);
    session.setComposing(true); session.local("中文输入中"); await session.flush();
    expect(session.document.content).toBe("before"); expect(session.dirty()).toBe(true);
    await expect(session.read()).rejects.toThrow("markdown_editing");
    expect(await session.replace({ requestId: "during_ime", expectedRevision: 0 }, { content: "Bot" })).toMatchObject({ status: "not_executed", error: "markdown_editing" });
    session.setComposing(false); await session.flush(); expect(session.document.content).toBe("中文输入中");
    expect(await session.replace({ requestId: "after_ime_stale", expectedRevision: 0 }, { content: "Bot" })).toMatchObject({ status: "conflict" });
  });

  it("keeps stale editor text for export without overwriting an intervening Bot edit", async () => {
    const session = new MarkdownSession(emptyMarkdown("note", "alpha"), async () => undefined); session.setWritable(true);
    await session.replace({ requestId: "bot_first", expectedRevision: 0 }, { content: "alpha BOT" });
    session.local("alpha!", { revision: 0, content: "alpha" });
    await expect(session.flush()).rejects.toThrow("markdown_revision_conflict");
    expect(session.document.content).toBe("alpha BOT"); expect(session.text()).toBe("alpha!"); expect(session.dirty()).toBe(true);
  });

  it("does not report conflict for an emergency draft that was already saved", async () => {
    const note = { ...emptyMarkdown("same", "Already saved"), revision: 1 };
    const session = new MarkdownSession(note, async () => { throw Error("must_not_write"); }); session.setWritable(true);
    session.restoreDraft("Already saved", 0); await session.flush();
    expect(session.dirty()).toBe(false); expect(session.error).toBeUndefined(); expect(session.document.revision).toBe(1);
  });

  it("reloads disk only on explicit recovery and preserves conflict bases through teardown", async () => {
    let disk = emptyMarkdown("note", "original");
    const session = new MarkdownSession(disk, async () => { throw Error("markdown_revision_conflict"); }, () => {}, async () => disk); session.setWritable(true);
    session.local("keep mine"); await expect(session.flush()).rejects.toThrow("markdown_revision_conflict");
    expect(session.recovery()).toEqual({ content: "keep mine", revision: 0 });
    disk = { ...disk, revision: 1, content: "saved by another writer" };
    await session.reloadSaved(); expect(session.text()).toBe(disk.content); expect(session.dirty()).toBe(false);
    session.restoreDraft("stale recovered", 0); await expect(session.flush()).rejects.toThrow("markdown_revision_conflict");
    expect(session.recovery()).toEqual({ content: "stale recovered", revision: 0 });
  });

});
