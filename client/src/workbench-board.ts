import { z } from "zod";
import { boardDocumentSchema, boardSceneSchema, checkBoardFlush, savedBoardState, type BoardDocument, type BoardScene } from "./workbench-model.js";

type JsonObject = BoardScene["elements"][number];
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const color = z.string().max(64).regex(/^(?:#[0-9a-fA-F]{3,8}|transparent|[a-zA-Z]{1,24})$/);
const point = z.tuple([coordinate, coordinate]);
const binding = z.object({ elementId: id, focus: z.number().min(-1).max(1), gap: z.number().min(0).max(10000), fixedPoint: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).nullable().optional() }).strict().nullable();
const fields = {
  x: coordinate.optional(), y: coordinate.optional(), width: z.number().min(0).max(100000).optional(), height: z.number().min(0).max(100000).optional(),
  angle: z.number().finite().min(-100).max(100).optional(), strokeColor: color.optional(), backgroundColor: color.optional(),
  fillStyle: z.enum(["hachure", "cross-hatch", "solid", "zigzag"]).optional(), strokeWidth: z.number().min(0).max(100).optional(),
  strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(), roughness: z.number().min(0).max(3).optional(), opacity: z.number().min(0).max(100).optional(),
  text: z.string().max(16000).optional(), fontSize: z.number().min(4).max(500).optional(), fontFamily: z.number().int().refine(value => [1, 2, 3, 5, 6, 7, 8].includes(value)).optional(),
  textAlign: z.enum(["left", "center", "right"]).optional(), verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
  points: z.array(point).min(2).max(1000).optional(), startArrowhead: z.enum(["arrow", "bar", "dot", "triangle"]).nullable().optional(),
  endArrowhead: z.enum(["arrow", "bar", "dot", "triangle"]).nullable().optional(), startBinding: binding.optional(), endBinding: binding.optional(),
  groupIds: z.array(id).max(32).optional(), locked: z.boolean().optional(),
};
export const boardPatchSchema = z.array(z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), id, type: z.enum(["rectangle", "ellipse", "diamond", "text", "line", "arrow", "freedraw"]), ...fields }).strict(),
  z.object({ op: z.literal("update"), id, changes: z.object(fields).strict().refine(value => Object.keys(value).length > 0) }).strict(),
  z.object({ op: z.literal("delete"), id }).strict(),
])).min(1).max(200);
export type BoardPatch = z.infer<typeof boardPatchSchema>;
export type BoardRequest = { requestId: string; expectedRevision: number; /** Local authorization fence, never serialized. */ assertActive?: () => void };
export type BoardResult = { status: "applied" | "applied_not_saved" | "conflict" | "not_executed"; revision: number; saved: boolean; error?: string; result?: Record<string, unknown> };
export type BoardAnnotation = {
  boardId: string; baseRevision: number; originalElementId: string;
  original: { file: File; attachmentId?: string }; preview: File;
  references: { file: File; attachmentId?: string; elementId: string }[];
};
export type BoardImport = { scene: BoardScene; files: BoardDocument["files"]; title: string };
export type BoardImageRequest = BoardRequest & { file: File; attachmentId?: string; originalElementId?: string; replace?: boolean };
export interface BoardController {
  read(): Promise<{ document: BoardDocument; selection: string[]; readOnly: boolean }>;
  apply(request: BoardRequest & { ops: unknown }): Promise<BoardResult>;
  undo(request: BoardRequest): Promise<BoardResult>;
  redo(request: BoardRequest): Promise<BoardResult>;
  insertImage(request: BoardImageRequest): Promise<BoardResult>;
  flush(): Promise<void>;
  /** True while this editor holds the board's exclusive edit lock. */
  ownsEditor?(): boolean;
  selection(): string[];
}
export type BoardAdapter = {
  /** Return complete, validated Excalidraw elements with the supplied ids. */
  create(elements: JsonObject[]): JsonObject[];
  apply(document: BoardDocument): void;
  selection(): string[];
};

export function canonicalBoardJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalBoardJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalBoardJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export async function boardFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalBoardJson(value));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
}
const copy = <T,>(value: T): T => structuredClone(value);

function checkedChanges(element: JsonObject, fields: JsonObject): JsonObject {
  if (fields.text !== undefined && element.type !== "text") throw new Error("whiteboard_text_type_mismatch");
  if ((fields.points !== undefined || fields.startBinding !== undefined || fields.endBinding !== undefined) && !["arrow", "line", "freedraw"].includes(String(element.type))) throw new Error("whiteboard_line_type_mismatch");
  const next = { ...element, ...fields, version: Number(element.version ?? 1) + 1, versionNonce: Math.floor(Math.random() * 2147483647), updated: Date.now() };
  if (fields.text !== undefined) Object.assign(next, { originalText: fields.text });
  return next;
}
/** Preserve endpoints when a programmatic shape move/resize bypasses the
 * editor's pointer handlers. Intermediate line points retain their positions. */
function moveBindings(elements: JsonObject[], old: JsonObject, next: JsonObject) {
  if (!["x", "y", "width", "height", "angle"].some(key => old[key] !== next[key])) return;
  const transform = (point: number[]): number[] => {
    const width = Number(old.width) || 1, height = Number(old.height) || 1;
    const dx = point[0] - (Number(old.x) + width / 2), dy = point[1] - (Number(old.y) + height / 2), from = Number(old.angle) || 0, to = Number(next.angle) || 0;
    const x = (dx * Math.cos(from) + dy * Math.sin(from)) * Number(next.width ?? width) / width;
    const y = (-dx * Math.sin(from) + dy * Math.cos(from)) * Number(next.height ?? height) / height;
    return [Number(next.x) + Number(next.width ?? width) / 2 + x * Math.cos(to) - y * Math.sin(to), Number(next.y) + Number(next.height ?? height) / 2 + x * Math.sin(to) + y * Math.cos(to)];
  };
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i]; if (element.id === old.id) continue;
    if (element.type === "text" && element.containerId === old.id) {
      const center = transform([Number(element.x) + Number(element.width) / 2, Number(element.y) + Number(element.height) / 2]);
      elements[i] = checkedChanges(element, { x: center[0] - Number(element.width) / 2, y: center[1] - Number(element.height) / 2 });
    }
    if (!["arrow", "line"].includes(String(element.type)) || !Array.isArray(element.points)) continue;
    const matches = (key: string) => { const value = element[key]; return value && typeof value === "object" && !Array.isArray(value) && value.elementId === old.id; };
    const start = matches("startBinding"), end = matches("endBinding"); if (!start && !end) continue;
    if (Number(element.angle)) throw new Error("whiteboard_rotated_connector_requires_manual_edit");
    const points = element.points.map(point => { if (!Array.isArray(point) || point.length !== 2 || point.some(value => typeof value !== "number")) throw new Error("whiteboard_invalid_connector"); return [Number(element.x) + Number(point[0]), Number(element.y) + Number(point[1])]; });
    if (points.length < 2) throw new Error("whiteboard_invalid_connector");
    if (start) points[0] = transform(points[0]); if (end) points[points.length - 1] = transform(points[points.length - 1]);
    const origin = points[0], relative = points.map(point => [point[0] - origin[0], point[1] - origin[1]]);
    elements[i] = checkedChanges(element, { x: origin[0], y: origin[1], points: relative, width: Math.max(...relative.map(point => point[0])) - Math.min(...relative.map(point => point[0])), height: Math.max(...relative.map(point => point[1])) - Math.min(...relative.map(point => point[1])) });
  }
}
/** Atomic local patch: input is immutable and an invalid later operation cannot leave a partial drawing. */
export function patchBoardScene(scene: BoardScene, raw: unknown, create: BoardAdapter["create"]): BoardScene {
  const operations = boardPatchSchema.parse(raw), next = copy(scene), elements = next.elements;
  for (const operation of operations) {
    const index = elements.findIndex(element => element.id === operation.id);
    if (operation.op === "add") {
      if (index !== -1) throw new Error("whiteboard_element_exists");
      const { op: _, ...skeleton } = operation;
      if (skeleton.type === "text" && !skeleton.text) throw new Error("whiteboard_text_required");
      const created = create([{ x: 0, y: 0, width: 160, height: 80, ...skeleton }]);
      if (created.length !== 1 || created[0].id !== operation.id) throw new Error("whiteboard_element_identity_changed");
      elements.push(created[0]);
    } else {
      if (index === -1 || elements[index].isDeleted) throw new Error("whiteboard_element_missing");
      if (elements[index].locked === true) throw new Error("whiteboard_element_locked");
      if (operation.op === "delete") {
        elements.splice(index, 1);
        // Remove dangling native bindings without touching the remaining geometry.
        for (let i = 0; i < elements.length; i++) {
          const element = elements[i]; let modified: JsonObject = {};
          for (const key of ["startBinding", "endBinding"]) if (element[key] && typeof element[key] === "object" && !Array.isArray(element[key]) && element[key].elementId === operation.id) modified[key] = null;
          if (element.containerId === operation.id) modified.containerId = null;
          if (Array.isArray(element.boundElements)) {
            const retained = element.boundElements.filter(item => !item || typeof item !== "object" || Array.isArray(item) || item.id !== operation.id);
            if (retained.length !== element.boundElements.length) modified.boundElements = retained;
          }
          if (Object.keys(modified).length) elements[i] = checkedChanges(element, modified);
        }
      } else {
        const previous = elements[index], changed = checkedChanges(previous, operation.changes);
        elements[index] = changed; moveBindings(elements, previous, changed);
      }
    }
  }
  const ids = new Set(elements.map(element => element.id));
  for (const element of elements) for (const key of ["startBinding", "endBinding"]) {
    const value = element[key];
    if (value && typeof value === "object" && !Array.isArray(value) && (!ids.has(value.elementId) || value.elementId === element.id)) throw new Error("whiteboard_binding_missing");
  }
  // Excalidraw moves connectors with their shapes through reciprocal binding lists.
  // Reconcile just arrow bindings; keep any unrelated bound text intact.
  const bound = new Map<string, { id: string; type: "arrow" }[]>();
  for (const element of elements) if (element.type === "arrow") for (const key of ["startBinding", "endBinding"]) {
    const value = element[key]; if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.elementId !== "string") continue;
    const list = bound.get(value.elementId) ?? []; if (!list.some(item => item.id === element.id)) list.push({ id: String(element.id), type: "arrow" }); bound.set(value.elementId, list);
  }
  for (let i = 0; i < elements.length; i++) {
    const current = elements[i].boundElements, old = Array.isArray(current) ? current : [];
    const expected = bound.get(String(elements[i].id)) ?? [];
    const keep = old.filter(value => value && typeof value === "object" && !Array.isArray(value) && (value.type !== "arrow" || expected.some(item => item.id === value.id)));
    const linked = [...keep, ...expected.filter(item => !keep.some(value => value && typeof value === "object" && !Array.isArray(value) && value.id === item.id))];
    if (canonicalBoardJson(old) !== canonicalBoardJson(linked)) elements[i] = checkedChanges(elements[i], { boundElements: linked.length ? linked : null });
  }
  return boardSceneSchema.parse(next);
}

export function retainBoardFiles(document: BoardDocument): BoardDocument {
  const used = new Set([document.scene, ...document.undo, ...document.redo].flatMap(scene => scene.elements.map(element => element.fileId).filter(value => typeof value === "string")));
  document.files = Object.fromEntries(Object.entries(document.files).filter(([key]) => used.has(key)));
  return document;
}
function boardError(error: unknown): string { return error instanceof z.ZodError ? "whiteboard_invalid_input" : error instanceof Error ? error.message : "whiteboard_operation_failed"; }

/** Scene ownership and persistence live together. A successful receipt is never produced before the CAS save. */
export class BoardSession {
  document: BoardDocument;
  savedRevision: number;
  readOnly = true;
  active = true;
  error: string | undefined;
  private draft?: { scene: BoardScene; files: BoardDocument["files"] };
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private initialized = false;
  /** `savedRevision` is the revision actually stored when the document carries a
   * retained unsaved edit (an earlier save failed): the session stays unsaved and
   * its next save compares against storage, never against the unsaved revision. */
  constructor(document: BoardDocument, private persist: (expectedRevision: number, next: BoardDocument) => Promise<void>, private adapter: BoardAdapter, private changed: (document: BoardDocument) => void = () => undefined, savedRevision?: number) {
    this.document = boardDocumentSchema.parse(copy(document));
    this.savedRevision = savedRevision !== undefined && Number.isSafeInteger(savedRevision) && savedRevision >= 0 && savedRevision <= document.revision ? savedRevision : document.revision;
  }
  setWritable(value: boolean) { if (this.readOnly !== !value) this.generation++; this.readOnly = !value; }
  /** Storage confirms the current revision as saved (e.g. the previous editor's final write). */
  syncSaved(revision: number | undefined) { if (revision !== undefined && revision === this.document.revision && !this.draft) this.savedRevision = revision; }
  activate() { this.active = true; this.generation++; }
  /** Editor defaults and fractional ordering are presentation normalization,
   * not a user edit. Never consume a first callback containing changed content. */
  initializeView(scene: BoardScene, files: BoardDocument["files"]): boolean {
    if (this.initialized) return false; this.initialized = true;
    const before = this.document.scene.elements;
    if (before.length !== scene.elements.length || before.some((element, i) => Object.entries(element).some(([key, value]) => {
      if (["index", "versionNonce", "updated"].includes(key)) return false;
      const next = scene.elements[i]?.[key];
      // Excalidraw restores a hand-drawn element's empty bindings from null to
      // []. This changes no connector, geometry or content and needs no save.
      if (key === "boundElements" && value === null && Array.isArray(next) && next.length === 0) return false;
      return canonicalBoardJson(value) !== canonicalBoardJson(next);
    }))) return false;
    if (Object.entries(this.document.files).some(([id, file]) => files[id]?.dataURL !== file.dataURL)) return false;
    this.document = { ...this.document, scene: copy(scene), files: copy(files) }; this.changed(this.document); return true;
  }
  selection() { return this.adapter.selection().filter(value => this.document.scene.elements.some(element => element.id === value && !element.isDeleted)); }
  local(scene: BoardScene, files: BoardDocument["files"]) {
    if (!this.active || this.readOnly) return;
    const next = { elements: scene.elements.filter(element => !element.isDeleted), appState: savedBoardState(scene.appState) };
    if (canonicalBoardJson(next) === canonicalBoardJson(this.document.scene)) { this.draft = undefined; return; }
    this.draft = { scene: boardSceneSchema.parse(copy(next)), files: copy(files) };
  }
  dirty() { return !!this.draft || this.savedRevision !== this.document.revision; }
  restoreView() { this.adapter.apply({ ...copy(this.document), ...(this.draft ? copy(this.draft) : {}) }); }
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task); this.queue = result.catch(() => undefined); return result;
  }
  private async save() {
    if (this.savedRevision === this.document.revision) return;
    const value = copy(this.document), expected = this.savedRevision;
    try { await this.persist(expected, value); this.savedRevision = value.revision; this.error = undefined; this.changed(this.document); }
    catch (error) { this.error = boardError(error); throw error; }
  }
  private async flushNow() {
    await this.save();
    // Take the current draft once. New user input during this write remains a separate next gesture.
    const draft = this.draft; if (!draft) return;
    const previous = this.document;
    const next = retainBoardFiles({ ...copy(this.document), scene: draft.scene, files: draft.files, revision: this.document.revision + 1, undo: [...this.document.undo, copy(this.document.scene)].slice(-12), redo: [] });
    // Files and budgets are checked before the document changes; scenes were
    // validated already. Storage repeats the full schema at its boundary.
    checkBoardFlush(next); this.draft = undefined; this.document = next; this.changed(next);
    try { await this.save(); }
    catch (error) {
      // Storage refused the content itself: nothing was written. Keep the saved
      // document and the person's edit (a newer draft already contains it).
      if (error instanceof z.ZodError && this.document === next) { this.document = previous; this.draft ??= draft; this.changed(previous); }
      throw error;
    }
  }
  flush() { return this.serialize(() => this.flushNow()); }
  async read() { await this.flush(); return { document: copy(this.document), selection: this.selection(), readOnly: this.readOnly || !this.active }; }
  async change(request: BoardRequest, input: unknown, action: (current: BoardDocument) => BoardDocument): Promise<BoardResult> {
    const generation = this.generation;
    return this.serialize(async () => {
      const fail = (status: BoardResult["status"], error: string): BoardResult => ({ status, revision: this.document.revision, saved: this.savedRevision === this.document.revision && !this.draft, error });
      if (!this.active || generation !== this.generation) return fail("not_executed", "whiteboard_closed");
      if (this.readOnly) return fail("not_executed", "whiteboard_read_only");
      try {
        request.assertActive?.();
        id.parse(request.requestId);
        const fingerprint = await boardFingerprint(input);
        request.assertActive?.();
        if (!this.active || generation !== this.generation) return fail("not_executed", "whiteboard_closed");
        const old = this.document.receipts.find(receipt => receipt.id === request.requestId);
        if (old) {
          if (old.fingerprint !== fingerprint) return fail("conflict", "whiteboard_request_conflict");
          try { await this.save(); } catch { return fail("applied_not_saved", this.error ?? "whiteboard_save_failed"); }
          return { status: "applied", revision: old.revision, saved: true, result: { duplicate: true } };
        }
        await this.flushNow();
        request.assertActive?.();
        if (this.draft || request.expectedRevision !== this.document.revision) return fail("conflict", "whiteboard_revision_conflict");
        const next = action(copy(this.document));
        next.revision = this.document.revision + 1;
        next.receipts = [...this.document.receipts, { id: request.requestId, fingerprint, revision: next.revision }].slice(-128);
        boardDocumentSchema.parse(retainBoardFiles(next));
        if (!this.active || generation !== this.generation || this.readOnly) return fail("not_executed", this.active && generation === this.generation ? "whiteboard_read_only" : "whiteboard_closed");
        request.assertActive?.();
        this.adapter.apply(next); this.document = next; this.changed(next);
        try { await this.save(); return { status: "applied", revision: next.revision, saved: true }; }
        catch { return fail("applied_not_saved", this.error ?? "whiteboard_save_failed"); }
      } catch (error) { return fail("not_executed", boardError(error)); }
    });
  }
  apply(request: BoardRequest & { ops: unknown }) {
    return this.change(request, { type: "patch", revision: request.expectedRevision, ops: request.ops }, current => ({ ...current, scene: patchBoardScene(current.scene, request.ops, this.adapter.create), undo: [...current.undo, copy(current.scene)].slice(-12), redo: [] }));
  }
  undo(request: BoardRequest) {
    return this.change(request, { type: "undo", revision: request.expectedRevision }, current => {
      const scene = current.undo.pop(); if (!scene) throw new Error("whiteboard_nothing_to_undo");
      current.redo = [...current.redo, current.scene].slice(-12); current.scene = scene; return current;
    });
  }
  redo(request: BoardRequest) {
    return this.change(request, { type: "redo", revision: request.expectedRevision }, current => {
      const scene = current.redo.pop(); if (!scene) throw new Error("whiteboard_nothing_to_redo");
      current.undo = [...current.undo, current.scene].slice(-12); current.scene = scene; return current;
    });
  }
  /** Called after the owning surface's final flush, never to force through a failed save. */
  dispose() { this.active = false; this.generation++; }
}
