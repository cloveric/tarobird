import { z } from "zod";
import { markdownPatchSchema, markdownReplaceSchema, WORKBENCH_MARKDOWN_BYTES } from "../../src/client-protocol/workbench.js";
import { boardFingerprint, type BoardRequest, type BoardResult } from "./workbench-board.js";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const markdownContentSchema = z.string().refine(value => new TextEncoder().encode(value).length <= WORKBENCH_MARKDOWN_BYTES, "markdown_too_large");
export const markdownDocumentSchema = z.object({
  schema: z.literal(1), id, revision: z.number().int().nonnegative().safe(), content: markdownContentSchema,
  undo: z.array(markdownContentSchema).max(12), redo: z.array(markdownContentSchema).max(12),
  origin: z.string().max(128).optional(),
  receipts: z.array(z.object({ id, fingerprint: z.string().max(128), revision: z.number().int().nonnegative().safe() }).strict()).max(128),
}).strict();
export type MarkdownDocument = z.infer<typeof markdownDocumentSchema>;
export function emptyMarkdown(id: string, content = "", origin?: string): MarkdownDocument {
  return markdownDocumentSchema.parse({ schema: 1, id, revision: 0, content, undo: [], redo: [], receipts: [], ...(origin ? { origin } : {}) });
}
export function patchMarkdown(content: string, payload: unknown): string {
  const { edits } = markdownPatchSchema.parse(payload);
  for (const { oldText, newText } of edits) {
    const at = content.indexOf(oldText);
    if (at < 0) throw new Error("markdown_text_missing");
    if (content.indexOf(oldText, at + 1) >= 0) throw new Error("markdown_text_ambiguous");
    content = content.slice(0, at) + newText + content.slice(at + oldText.length);
  }
  return markdownContentSchema.parse(content);
}
/** Never return half an emoji or get stuck when limit=1 meets a surrogate pair. */
export function readMarkdown(content: string, offset: number, limit: number) {
  let start = Math.min(offset, content.length), end = Math.min(content.length, start + limit);
  const high = (at: number) => /[\uD800-\uDBFF]/.test(content[at] ?? "");
  const low = (at: number) => /[\uDC00-\uDFFF]/.test(content[at] ?? "");
  if (start > 0 && high(start - 1) && low(start)) start++;
  if (end < start) end = start;
  if (end < content.length && high(end - 1) && low(end)) end = end - start > 1 ? end - 1 : end + 1;
  return { content: content.slice(start, end), offset: start, nextOffset: end < content.length ? end : null, totalLength: content.length, totalBytes: new TextEncoder().encode(content).length, eof: end >= content.length };
}
export const markdownEditorText = (text: string) => text.replace(/\r\n?/g, "\n");
/** textarea normalizes line breaks. Keep an untouched source exact and retain
 * a consistent imported CRLF/CR convention when the user actually edits it. */
export function markdownFromEditor(text: string, previous: string) {
  if (text === markdownEditorText(previous)) return previous;
  const endings = previous.match(/\r\n|\r|\n/g);
  const ending = endings?.[0];
  return ending && endings.every(value => value === ending) ? text.replace(/\n/g, ending) : text;
}
const code = (error: unknown) => error instanceof z.ZodError ? "markdown_invalid_input" : error instanceof Error ? error.message : "markdown_save_failed";

/** Local typing and Bot edits share one revisioned save queue. A late Bot patch
 * never overwrites typing that occurred after its read, even during a save. */
export class MarkdownSession {
  document: MarkdownDocument;
  savedRevision: number;
  readOnly = true;
  active = true;
  error?: string;
  private draft?: string;
  private draftBaseRevision?: number;
  private composing = false;
  setComposing(value: boolean) { this.composing = value; }
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private listeners = new Set<() => void>();
  private snapshot!: { document: MarkdownDocument; content: string; dirty: boolean; readOnly: boolean; error?: string; ownership: string };
  private acquiring?: Promise<void>;
  private lockName?: string;
  private releaseLock?: () => void;
  ownership = "waiting";
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private emit() { this.snapshot = { document: this.document, content: this.text(), dirty: this.dirty(), readOnly: this.readOnly, error: this.error, ownership: this.ownership }; this.listeners.forEach(listener => listener()); }
  acquire(name: string): Promise<void> {
    if (this.acquiring) return this.acquiring;
    this.lockName = name;
    this.active = true;
    return this.acquiring = new Promise<void>(resolve => {
      if (!navigator.locks) { this.ownership = "unsupported"; this.emit(); resolve(); return; }
      void navigator.locks.request(name, { ifAvailable: true }, async lock => {
        if (!this.active) { resolve(); return; }
        if (!lock) { this.ownership = "other_window"; this.emit(); resolve(); return; }
        if (!this.dirty() && this.reload) { const current = await this.reload(); if (!current) { resolve(); throw new Error("markdown_not_found"); } this.document = current; this.savedRevision = current.revision; this.changed(current); }
        if (!this.active) { resolve(); return; }
        this.ownership = "owned"; this.setWritable(true);
        await new Promise<void>(release => { this.releaseLock = release; resolve(); });
      }).catch(() => { this.ownership = "failed"; this.emit(); resolve(); });
    });
  }
  async retire() { await this.flush(); if (this.dirty()) throw new Error("markdown_editing"); this.dispose(); }

  constructor(document: MarkdownDocument, private persist: (expected: number, next: MarkdownDocument) => Promise<void>, private changed: (document: MarkdownDocument) => void = () => undefined, private reload?: () => Promise<MarkdownDocument | undefined>) {
    this.document = markdownDocumentSchema.parse(structuredClone(document)); this.savedRevision = document.revision; this.emit();
  }
  setWritable(value: boolean) { if (this.readOnly !== !value) this.generation++; this.readOnly = !value; this.emit(); }
  activate() { this.active = true; this.generation++; }
  dispose() { this.active = false; this.generation++; this.setWritable(false); this.releaseLock?.(); this.releaseLock = undefined; this.acquiring = undefined; this.emit(); }
  recovery() { return { content: this.text(), revision: this.draftBaseRevision ?? this.savedRevision }; }
  text() { return this.draft ?? this.document.content; }
  dirty() { return this.draft !== undefined || this.savedRevision !== this.document.revision; }
  local(content: string, base = { revision: this.document.revision, content: this.text() }) {
    if (!this.active || this.readOnly) return;
    if (new TextEncoder().encode(content).length > WORKBENCH_MARKDOWN_BYTES) throw new Error("markdown_too_large");
    markdownContentSchema.parse(content);
    const stale = base.revision !== this.document.revision && base.content !== this.document.content;
    this.draft = content === this.document.content ? undefined : content;
    if (this.draft === undefined) this.draftBaseRevision = undefined;
    else if (stale || this.draftBaseRevision === undefined) this.draftBaseRevision = stale ? base.revision : this.document.revision;
    if (stale) this.error = "markdown_revision_conflict";
    this.emit();
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run); this.queue = result.catch(() => undefined); return result;
  }
  private async save() {
    if (this.savedRevision === this.document.revision) return;
    const next = structuredClone(this.document), expected = this.savedRevision;
    try { await this.persist(expected, next); this.savedRevision = next.revision; this.error = undefined; this.changed(this.document); this.emit(); }
    catch (error) { this.error = code(error); this.emit(); throw error; }
  }
  private async flushNow() {
    await this.save();
    const content = this.draft; if (content === undefined || this.composing) return;
    if (this.readOnly || !this.active) throw new Error("markdown_read_only");
    if (this.draftBaseRevision !== this.document.revision) { this.error = "markdown_revision_conflict"; this.emit(); throw new Error(this.error); }
    const next = markdownDocumentSchema.parse({ ...this.document, content, revision: this.document.revision + 1, undo: [...this.document.undo, this.document.content].slice(-12), redo: [] });
    this.draft = undefined; this.draftBaseRevision = undefined; this.document = next; this.changed(next); this.emit(); await this.save();
  }
  flush() { return this.serial(() => this.flushNow()); }
  async refresh() {
    if (!this.active || !this.readOnly) return;
    return this.serial(async () => {
      if (!this.active || !this.readOnly) return;
      if (this.lockName) { this.acquiring = undefined; await this.acquire(this.lockName); }
      if (this.readOnly && !this.dirty() && this.reload) { const current = await this.reload(); if (!current) throw new Error("markdown_not_found"); this.document = current; this.savedRevision = current.revision; this.changed(current); this.emit(); }
    });
  }
  restoreDraft(content: string, revision: number) { markdownContentSchema.parse(content); if (content === this.document.content) { this.draft = undefined; this.draftBaseRevision = undefined; this.error = undefined; this.emit(); return; } this.draft = content; this.draftBaseRevision = revision; if (revision !== this.document.revision) this.error = "markdown_revision_conflict"; this.emit(); }
  reloadSaved() { return this.serial(async () => {
    if (!this.reload) throw new Error("markdown_not_found");
    const current = await this.reload(); if (!current) throw new Error("markdown_not_found");
    this.document = current; this.savedRevision = current.revision; this.draft = undefined; this.draftBaseRevision = undefined; this.error = undefined; this.changed(current); this.emit();
  }); }
  async read() { await this.refresh(); if (this.composing) throw new Error("markdown_editing"); await this.flush(); if (this.composing || this.draft !== undefined) throw new Error("markdown_editing"); return { document: structuredClone(this.document), readOnly: this.readOnly || !this.active }; }
  private change(request: BoardRequest, input: unknown, apply: (next: MarkdownDocument) => MarkdownDocument): Promise<BoardResult> {
    const generation = this.generation;
    return this.serial(async () => {
      const fail = (status: BoardResult["status"], error: string): BoardResult => ({ status, revision: this.document.revision, saved: !this.dirty(), error });
      const check = () => { request.assertActive?.(); if (!this.active || generation !== this.generation) throw new Error("markdown_closed"); if (this.readOnly) throw new Error("markdown_read_only"); if (this.composing) throw new Error("markdown_editing"); };
      try {
        check(); id.parse(request.requestId);
        const fingerprint = await boardFingerprint(input); check();
        const previous = this.document.receipts.find(value => value.id === request.requestId);
        if (previous) {
          if (previous.fingerprint !== fingerprint) return fail("conflict", "markdown_request_conflict");
          try { await this.save(); } catch { return fail("applied_not_saved", this.error ?? "markdown_save_failed"); }
          return { status: "applied", revision: previous.revision, saved: true, result: { duplicate: true } };
        }
        await this.flushNow(); check();
        if (this.draft !== undefined || request.expectedRevision !== this.document.revision) return fail("conflict", "markdown_revision_conflict");
        const next = apply(structuredClone(this.document));
        next.revision = this.document.revision + 1;
        next.receipts = [...this.document.receipts, { id: request.requestId, fingerprint, revision: next.revision }].slice(-128);
        markdownDocumentSchema.parse(next); check(); this.document = next; this.changed(next); this.emit();
        try { await this.save(); return { status: "applied", revision: next.revision, saved: true }; }
        catch { return fail("applied_not_saved", this.error ?? "markdown_save_failed"); }
      } catch (error) { return fail("not_executed", code(error)); }
    });
  }
  replace(request: BoardRequest, payload: unknown) {
    return this.change(request, { type: "replace", revision: request.expectedRevision, payload }, current => ({ ...current, content: markdownReplaceSchema.parse(payload).content, undo: [...current.undo, current.content].slice(-12), redo: [] }));
  }
  patch(request: BoardRequest, payload: unknown) {
    return this.change(request, { type: "patch", revision: request.expectedRevision, payload }, current => ({ ...current, content: patchMarkdown(current.content, payload), undo: [...current.undo, current.content].slice(-12), redo: [] }));
  }
  undo(request: BoardRequest) {
    return this.change(request, { type: "undo", revision: request.expectedRevision }, current => { const content = current.undo.pop(); if (content === undefined) throw new Error("markdown_nothing_to_undo"); current.redo = [...current.redo, current.content].slice(-12); current.content = content; return current; });
  }
  redo(request: BoardRequest) {
    return this.change(request, { type: "redo", revision: request.expectedRevision }, current => { const content = current.redo.pop(); if (content === undefined) throw new Error("markdown_nothing_to_redo"); current.undo = [...current.undo, current.content].slice(-12); current.content = content; return current; });
  }
}
