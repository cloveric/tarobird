import { describe, expect, it } from "vitest";
import { MAX_TEXT_BYTES, MAX_FRAME_BYTES } from "../src/client-protocol/index.js";
import { diffReviewNotesSchema, diffReviewPendingSchema, storedDiffReviewDraftSchema, formatDiffReviewNotes, makeDiffReviewExcerpt, makeDiffReviewFrame, reviseDiffReviewDraft, settleDiffReviewDraft, DiffReviewTextTooLargeError, type DiffReviewNote } from "../client/src/diff-review-draft.js";

const scope = { conversationId: "conversation", botId: "bot" };
const note = (id = "first", overrides: Partial<DiffReviewNote> = {}): DiffReviewNote => ({ id, path: "src/example.ts", head: "a".repeat(40), side: "new", start: 10, end: 11, excerpt: "const first = 1;\nreturn first;", comment: "请补充错误处理。", ...overrides });
const ids = () => { let id = 0; return () => `revision-${++id}`; };

describe("local diff review drafts", () => {
  it("persists incomplete comments but rejects invalid note ranges, duplicate IDs and size overflow", () => {
    expect(diffReviewNotesSchema.parse([note("first", { comment: "", head: null })])).toHaveLength(1);
    for (const notes of [[note(), note()], [note("first", { start: 12, end: 11 })], [note("first", { comment: "x".repeat(2001) })],
      [note("first", { excerpt: Array(6).fill("x").join("\n") })], [note("first", { excerpt: "界".repeat(1366) })],
      Array.from({ length: 51 }, (_, i) => note(`n-${i}`)), [note("first", { head: "untrusted" })]]) {
      expect(diffReviewNotesSchema.safeParse(notes).success).toBe(false);
    }
    expect(() => formatDiffReviewNotes([note("first", { comment: " \n " })])).toThrow("diff_review_comment_required");
  });

  it("bounds excerpt lines with visible truncation and never splits surrogate pairs", () => {
    const excerpt = makeDiffReviewExcerpt(Array(7).fill("😀界".repeat(500)));
    expect(excerpt.split("\n")).toHaveLength(5);
    expect(excerpt.split("\n").every(line => line.endsWith("… [已截断]"))).toBe(true);
    expect(new TextEncoder().encode(excerpt).byteLength).toBeLessThanOrEqual(4096);
    expect(excerpt).not.toContain("�");
    expect(diffReviewNotesSchema.safeParse([note("first", { excerpt })]).success).toBe(true);
    expect(makeDiffReviewExcerpt("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("pins full commit, path, side, line range and exact comment with a safe code fence", () => {
    const item = note("first", { path: "目录/a ` name.ts", side: "old", excerpt: "const s = `text`;\n`````\n`", comment: "保持  空格\n和换行" });
    const frame = makeDiffReviewFrame(scope, [item], "send-id");
    expect(frame).toMatchObject({ clientMsgId: "send-id", conversationId: "conversation", mentions: ["bot"], attachments: [], previewUrl: null });
    expect(frame.text).toContain('文件："目录/a ` name.ts"');
    expect(frame.text).toContain(`HEAD：${item.head}`);
    expect(frame.text).toContain("旧文件 10–11 行");
    expect(frame.text).toContain(`\n\`\`\`\`\`\`\n${item.excerpt}\n\`\`\`\`\`\`\n`);
    expect(frame.text).toContain(item.comment);
    expect(formatDiffReviewNotes([note("first", { head: null })])).toContain("尚无提交");
  });

  it("rejects the complete UTF-8 message before sending and reports actual bytes", () => {
    const notes = Array.from({ length: 50 }, (_, index) => note(`n-${index}`, { comment: "界".repeat(2000) }));
    expect(diffReviewNotesSchema.safeParse(notes).success).toBe(true);
    try { formatDiffReviewNotes(notes); throw new Error("unexpected pass"); }
    catch (error) {
      expect(error).toBeInstanceOf(DiffReviewTextTooLargeError);
      expect((error as DiffReviewTextTooLargeError).bytes).toBeGreaterThan(MAX_TEXT_BYTES);
      expect((error as DiffReviewTextTooLargeError).limit).toBe(MAX_TEXT_BYTES);
    }
  });

  it("also rejects JSON escaping overhead beyond the existing frame limit", () => {
    const notes = Array.from({ length: 50 }, (_, index) => note(`n-${index}`, { comment: "\u0001".repeat(2000), excerpt: "\u0001".repeat(1800) }));
    expect(new TextEncoder().encode(formatDiffReviewNotes(notes)).byteLength).toBeLessThan(MAX_TEXT_BYTES);
    try { makeDiffReviewFrame(scope, notes, "send"); throw new Error("unexpected pass"); }
    catch (error) {
      expect(error).toBeInstanceOf(DiffReviewTextTooLargeError);
      expect((error as DiffReviewTextTooLargeError).bytes).toBeGreaterThan(MAX_FRAME_BYTES);
      expect((error as DiffReviewTextTooLargeError).limit).toBe(MAX_FRAME_BYTES);
    }
  });

  it("clears only unchanged snapshot notes and preserves edited, added and ABA notes", () => {
    const next = ids();
    let record = reviseDiffReviewDraft(undefined, scope, "owner", [note("unchanged"), note("edited"), note("aba")], next);
    record.pending = diffReviewPendingSchema.parse({ clientMsgId: "send", frame: makeDiffReviewFrame(scope, record.notes, "send"), snapshot: record.notes, noteVersions: record.noteVersions });
    record = reviseDiffReviewDraft(record, scope, "owner", [note("unchanged"), note("edited", { comment: "changed" }), note("aba", { comment: "intermediate" }), note("new")], next);
    record = reviseDiffReviewDraft(record, scope, "owner", [note("unchanged"), note("edited", { comment: "changed" }), note("aba"), note("new")], next);
    const result = settleDiffReviewDraft(record, "send", true, next);
    expect(result.notes.map(item => item.id)).toEqual(["edited", "aba", "new"]);
    expect(result.pending).toBeUndefined();
    expect(result.revision).not.toBe(record.revision);
    expect(storedDiffReviewDraftSchema.safeParse(result).success).toBe(true);
  });

  it("retains a removed and recreated note and leaves a revision tombstone after acceptance", () => {
    const next = ids();
    let original = reviseDiffReviewDraft(undefined, scope, "owner", [note()], next);
    original.pending = diffReviewPendingSchema.parse({ clientMsgId: "send", frame: makeDiffReviewFrame(scope, original.notes, "send"), snapshot: original.notes, noteVersions: original.noteVersions });
    const removed = reviseDiffReviewDraft(original, scope, "owner", [], next);
    const readded = reviseDiffReviewDraft(removed, scope, "owner", [note()], next);
    expect(settleDiffReviewDraft(readded, "send", true, next).notes).toHaveLength(1);
    const accepted = settleDiffReviewDraft(original, "send", true, next);
    expect(accepted.notes).toEqual([]);
    expect(accepted.revision).not.toBe(original.revision);
    expect(settleDiffReviewDraft(original, "other", true, next)).toBe(original);
  });

  it("abandonment preserves all notes, and malformed snapshots cannot inherit prototype versions", () => {
    const next = ids();
    const record = reviseDiffReviewDraft(undefined, scope, "owner", [note()], next);
    record.pending = diffReviewPendingSchema.parse({ clientMsgId: "send", frame: makeDiffReviewFrame(scope, record.notes, "send"), snapshot: record.notes, noteVersions: record.noteVersions });
    expect(settleDiffReviewDraft(record, "send", false, next).notes).toEqual(record.notes);
    expect(storedDiffReviewDraftSchema.safeParse({ ...record, notes: [note("toString")], noteVersions: {} }).success).toBe(false);
  });
});
