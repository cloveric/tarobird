import { z } from "zod";
import { clientFrameSchema, idSchema, MAX_TEXT_BYTES, MAX_FRAME_BYTES, type ClientFrame } from "../../src/client-protocol/index.js";
import { t } from "./i18n.js";
import { validateReviewReferences, type RunReviewReferences } from "./diff-review-reference.js";

export const DIFF_REVIEW_MAX_NOTES = 50;
export const DIFF_REVIEW_MAX_COMMENT = 2000;
export const DIFF_REVIEW_EXCERPT_LINES = 5;
export const DIFF_REVIEW_EXCERPT_BYTES = 4096;
export const DIFF_REVIEW_EXCERPT_LINE_CHARS = 240;
const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const lines = (value: string) => value.split(/\r\n|\r|\n/);

export const diffReviewScopeSchema = z.object({ conversationId: idSchema, botId: idSchema }).strict();
export type DiffReviewScope = z.infer<typeof diffReviewScopeSchema>;
export const diffReviewNoteSchema = z.object({
  id: idSchema,
  path: z.string().min(1).max(4096).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i).nullable(),
  side: z.enum(["old", "new"]),
  start: z.number().int().positive().safe(),
  end: z.number().int().positive().safe(),
  excerpt: z.string().refine(value => lines(value).length <= DIFF_REVIEW_EXCERPT_LINES && utf8Bytes(value) <= DIFF_REVIEW_EXCERPT_BYTES, "diff_review_excerpt_too_large"),
  // Empty comments are a valid, automatically persisted editing state.
  comment: z.string().max(DIFF_REVIEW_MAX_COMMENT),
}).strict().refine(note => note.end >= note.start, "diff_review_invalid_range");
export type DiffReviewNote = z.infer<typeof diffReviewNoteSchema>;
export const diffReviewNotesSchema = z.array(diffReviewNoteSchema).max(DIFF_REVIEW_MAX_NOTES)
  .refine(notes => new Set(notes.map(note => note.id)).size === notes.length, "diff_review_duplicate_note");
export type DiffReviewFrame = Extract<ClientFrame, { type: "message.send" }>;
const diffReviewFrameSchema = z.object({
  v: z.literal(1), type: z.literal("message.send"), clientMsgId: idSchema,
  conversationId: idSchema, text: z.string().refine(value => utf8Bytes(value) <= MAX_TEXT_BYTES),
  attachments: z.array(idSchema).max(0), mentions: z.array(idSchema).length(1), previewUrl: z.null(),
}).strict();
const noteVersionsSchema = z.record(idSchema, z.string().min(1).max(128));
const versionsMatch = (notes: DiffReviewNote[], versions: Record<string, string>) => Object.keys(versions).length === notes.length
  && notes.every(note => Object.hasOwn(versions, note.id));
export const diffReviewPendingSchema = z.object({
  clientMsgId: idSchema, frame: diffReviewFrameSchema,
  snapshot: diffReviewNotesSchema, noteVersions: noteVersionsSchema,
}).strict().refine(value => value.clientMsgId === value.frame.clientMsgId
  && versionsMatch(value.snapshot, value.noteVersions), "diff_review_invalid_pending");
export type DiffReviewPending = z.infer<typeof diffReviewPendingSchema>;
export type DiffReviewPendingState = "queued" | "failed" | "uncertain";
export type DiffReviewDraft = {
  notes: DiffReviewNote[]; revision?: string; pending?: DiffReviewPending;
  references?: RunReviewReferences;
  pendingState?: DiffReviewPendingState; pendingError?: string;
};
export const storedDiffReviewDraftSchema = z.object({
  v: z.literal(1), owner: z.string().min(1), scope: diffReviewScopeSchema,
  revision: z.string().min(1).max(128), notes: diffReviewNotesSchema,
  noteVersions: noteVersionsSchema, pending: diffReviewPendingSchema.optional(),
}).strict().refine(value => versionsMatch(value.notes, value.noteVersions)
  && (!value.pending || value.pending.frame.conversationId === value.scope.conversationId
    && value.pending.frame.mentions[0] === value.scope.botId), "diff_review_invalid_draft");
export type StoredDiffReviewDraft = z.infer<typeof storedDiffReviewDraftSchema>;
export const diffReviewReceiptSchema = z.object({ owner: z.string().min(1), scope: diffReviewScopeSchema }).strict();
export const diffReviewDraftKey = (scope: DiffReviewScope) => `diff-review-draft:${JSON.stringify([scope.conversationId, scope.botId])}`;
export const diffReviewReceiptKey = (id: string) => `diff-review-pending:${id}`;

/** Bound code excerpts before saving; every shortened line has a visible mark. */
export function makeDiffReviewExcerpt(value: string | string[]): string {
  const source = typeof value === "string" ? lines(value) : value.flatMap(lines);
  return source.slice(0, DIFF_REVIEW_EXCERPT_LINES).map((line, index) => {
    const points = Array.from(line), truncatedLines = index === DIFF_REVIEW_EXCERPT_LINES - 1 && source.length > DIFF_REVIEW_EXCERPT_LINES;
    let result = points.slice(0, DIFF_REVIEW_EXCERPT_LINE_CHARS).join("");
    while (utf8Bytes(result) > 760) result = Array.from(result).slice(0, -1).join("");
    return result + (result !== line || truncatedLines ? ` … ${t("[已截断]")}` : "");
  }).join("\n");
}

export class DiffReviewTextTooLargeError extends Error {
  constructor(readonly bytes: number, readonly limit: number = MAX_TEXT_BYTES) { super(`diff_review_message_too_large:${bytes}:${limit}`); this.name = "DiffReviewTextTooLargeError"; }
}

/** The exact serialized text is pinned in the pending record, never regenerated on retry. */
export function formatDiffReviewNotes(input: DiffReviewNote[], references: RunReviewReferences = {}): string {
  const notes = diffReviewNotesSchema.parse(input);
  const refs = validateReviewReferences(notes, references);
  if (!notes.length) throw new Error("diff_review_empty");
  if (notes.some(note => !note.comment.trim())) throw new Error("diff_review_comment_required");
  const text = t("请根据以下代码审查意见检查并修改：") + "\n\n" + notes.map((note, index) => {
    const backticks = Math.max(2, ...[...note.excerpt.matchAll(/`+/g)].map(match => match[0].length));
    const fence = "`".repeat(backticks + 1);
    const location = t("{0}文件 {1} 行", note.side === "old" ? t("旧") : t("新"), `${note.start}${note.end === note.start ? "" : `–${note.end}`}`);
    const ref = refs[note.id];
    const source = ref ? t("记录来源：回复 {0}，运行 {1}，修改步骤 {2}。行号属于当时的修改，当前文件可能已变化。", ref.messageId, ref.runId, ref.operation) : t("HEAD：{0}", note.head ?? t("尚无提交"));
    return `${index + 1}. ${t("文件：{0}", JSON.stringify(note.path))}\n${source}\n${t("位置：{0}", location)}\n${t("代码摘录：")}\n${fence}\n${note.excerpt}\n${fence}\n${t("意见：")}\n${note.comment}`;
  }).join("\n\n");
  const bytes = utf8Bytes(text);
  if (bytes > MAX_TEXT_BYTES) throw new DiffReviewTextTooLargeError(bytes);
  return text;
}

export function makeDiffReviewFrame(scope: DiffReviewScope, notes: DiffReviewNote[], clientMsgId: string, references: RunReviewReferences = {}): DiffReviewFrame {
  const parsed = diffReviewScopeSchema.parse(scope);
  const frame = clientFrameSchema.parse({ v: 1, type: "message.send", clientMsgId, conversationId: parsed.conversationId,
    text: formatDiffReviewNotes(notes, references), attachments: [], mentions: [parsed.botId], previewUrl: null }) as DiffReviewFrame;
  const bytes = utf8Bytes(JSON.stringify(frame));
  if (bytes > MAX_FRAME_BYTES) throw new DiffReviewTextTooLargeError(bytes, MAX_FRAME_BYTES);
  return frame;
}

/** Per-note versions preserve edits even when their final text returns to an old value. */
export function reviseDiffReviewDraft(old: StoredDiffReviewDraft | undefined, scope: DiffReviewScope, owner: string, input: DiffReviewNote[], newId = () => crypto.randomUUID()): StoredDiffReviewDraft {
  const notes = diffReviewNotesSchema.parse(input), previous = new Map(old?.notes.map(note => [note.id, note]));
  const noteVersions = Object.fromEntries(notes.map(note => [note.id,
    old && JSON.stringify(previous.get(note.id)) === JSON.stringify(note) ? old.noteVersions[note.id]! : newId()]));
  return { v: 1, scope, owner, notes, revision: newId(), noteVersions, ...(old?.pending ? { pending: old.pending } : {}) };
}

/** Only this pending snapshot is retired; a tombstone revision remains when empty. */
export function settleDiffReviewDraft(old: StoredDiffReviewDraft, clientMsgId: string, accepted: boolean, newId = () => crypto.randomUUID()): StoredDiffReviewDraft {
  if (old.pending?.clientMsgId !== clientMsgId) return old;
  const pending = old.pending;
  const notes = accepted ? old.notes.filter(note => old.noteVersions[note.id] !== pending.noteVersions[note.id]) : old.notes;
  const { pending: _pending, ...rest } = old;
  return { ...rest, notes, revision: newId(), noteVersions: Object.fromEntries(notes.map(note => [note.id, old.noteVersions[note.id]!])) };
}
