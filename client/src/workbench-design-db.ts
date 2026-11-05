import { z } from "zod";
import { designPath } from "../../src/client-protocol/workbench-design.js";
import { decodeDesignFile, designTextFile, type DesignDocument } from "./workbench-design.js";

// The document store used by the upstream dashboard/motion runtimes
// (`db.doc(path).set|update|delete`, `collection(path).onSnapshot`), kept as
// `project/db/<collection>/<doc>.json` inside the same revisioned document.
// Path and merge-patch rules follow baoyu-design's local dashboard server
// (MIT, Jim Liu). A write whose `base` is the current document applies
// directly; one racing the same writer's own previous write rebases on it; a
// concurrent change by someone else merges field by field as upstream does
// (the writer's value wins where both changed a field) and the conflicting
// fields are reported, never silently dropped or retried forever.
// `data/users/<id>` belongs to that user only.

export const DESIGN_DB_LIMITS = { docBytes: 256 * 1024, segments: 16, depth: 48 } as const;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
// Upstream segment rules intersected with TaroBird's virtual path rules.
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,199}$/;
export class DesignDbError extends Error { constructor(readonly code: string, readonly status = 400, readonly current?: unknown) { super(code); } }
export type DesignDbViewer = { userId?: string; bot?: boolean; readOnly?: boolean };
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function segmentsOf(input: unknown, viewer: DesignDbViewer) {
  const clean = String(input ?? "").replace(/^\/+|\/+$/g, ""), segments = clean === "" ? [] : clean.split("/");
  if (segments[0] === "data" && segments[1] === "users" && segments[2] === "me") {
    if (!viewer.userId || !SEGMENT.test(viewer.userId)) throw new DesignDbError("design_db_user_required", 403);
    segments[2] = viewer.userId;
  }
  if (!segments.length || segments.length > DESIGN_DB_LIMITS.segments || !segments.every(part => SEGMENT.test(part) && part !== "." && part !== ".." && !RESERVED.has(part))) throw new DesignDbError("design_invalid_db_path");
  return segments;
}
/** Normalized document path and its stored file, or a refusal. */
export function designDbPath(input: unknown, viewer: DesignDbViewer): { path: string; file: string } {
  const segments = segmentsOf(input, viewer);
  if (segments.length % 2 !== 0) throw new DesignDbError("design_invalid_db_path");
  const path = segments.join("/"), file = `project/db/${path}.json`;
  if (!designPath.safeParse(file).success) throw new DesignDbError("design_invalid_db_path");
  return { path, file };
}
/** Another person's own documents are invisible; Bots read but never write them. */
function access(path: string, viewer: DesignDbViewer) {
  const [first, second, owner] = path.split("/");
  const personal = first === "data" && second === "users";
  return { read: !personal || viewer.bot === true || owner === viewer.userId, write: !viewer.readOnly && (!personal || viewer.bot !== true && owner === viewer.userId) };
}
function checkData(value: unknown, depth = 0): void {
  if (depth > DESIGN_DB_LIMITS.depth) throw new DesignDbError("design_invalid_db_document");
  if (Array.isArray(value)) { for (const item of value) checkData(item, depth + 1); return; }
  if (isObject(value)) for (const [key, item] of Object.entries(value)) { if (RESERVED.has(key)) throw new DesignDbError("design_invalid_db_document"); checkData(item, depth + 1); }
}
const isDeleteMarker = (value: unknown) => value === null || isObject(value) && value.__delete__ === true && Object.keys(value).length === 1;
const hasDeleteMarker = (value: unknown): boolean => Array.isArray(value) ? value.some(hasDeleteMarker) : isObject(value) && (value.__delete__ === true || Object.values(value).some(hasDeleteMarker));
/** RFC 7386-style merge patch with upstream's `{"__delete__": true}` marker. */
export function mergePatch(target: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (RESERVED.has(key)) throw new DesignDbError("design_invalid_db_document");
    if (isDeleteMarker(value)) delete out[key];
    else if (isObject(value)) out[key] = mergePatch(out[key], value);
    else out[key] = value;
  }
  return out;
}
/** Stable JSON for base comparison (object key order does not matter). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function readFile(document: DesignDocument, file: string): Record<string, unknown> | undefined {
  const entry = document.files[file];
  if (!entry) return undefined;
  const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeDesignFile(entry)));
  if (!isObject(data)) throw new DesignDbError("design_invalid_db_document");
  return data;
}
/** Every readable document by full path; with `{path: collection}`, only that
 * collection's documents, keyed by their id (upstream `collection.get`). */
export function designDbList(document: DesignDocument, viewer: DesignDbViewer, input: unknown = {}): { docs: Record<string, Json> } {
  const { path: wanted } = z.object({ path: z.string().max(1024).optional() }).strict().parse(input ?? {});
  let collection: string | undefined;
  if (wanted !== undefined) { const segments = segmentsOf(wanted, viewer); if (segments.length % 2 !== 1) throw new DesignDbError("design_invalid_db_path"); collection = segments.join("/"); }
  const docs: Record<string, Json> = {};
  for (const file of Object.keys(document.files)) {
    if (!file.startsWith("project/db/") || !file.endsWith(".json")) continue;
    const path = file.slice(11, -5), cut = path.lastIndexOf("/");
    try { designDbPath(path, {}); } catch { continue; }
    if (!access(path, viewer).read || collection !== undefined && path.slice(0, cut) !== collection) continue;
    try { const data = readFile(document, file); if (data) docs[collection === undefined ? path : path.slice(cut + 1)] = data as Json; } catch { /* A malformed stored file is not served. */ }
  }
  return { docs };
}
export function designDbRead(document: DesignDocument, input: unknown, viewer: DesignDbViewer): { exists: boolean; data?: Json } {
  const { path: raw } = z.object({ path: z.string().max(1024) }).strict().parse(input), { path, file } = designDbPath(raw, viewer);
  if (!access(path, viewer).read) return { exists: false };
  const data = readFile(document, file);
  return data ? { exists: true, data: data as Json } : { exists: false };
}
const writeSchema = z.object({ op: z.enum(["set", "update", "delete"]), path: z.string().max(1024), data: z.unknown().optional(), base: z.unknown().optional(), chosen: z.boolean().optional() }).strict();
export type DesignDbWrite = { path: string; file: string; op: "set" | "update" | "delete"; existed: boolean; next?: Record<string, unknown>; batch: Record<string, unknown>; merged?: true; conflicts?: string[] };
const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
function mergeValue(base: unknown, mine: unknown, current: unknown, at: string, conflicts: string[]): unknown {
  if (same(mine, base)) return current;
  if (same(current, base) || same(mine, current)) return mine;
  if (isObject(base) && isObject(mine) && isObject(current)) return mergeObject(base, mine, current, at, conflicts);
  conflicts.push(at || ".");
  return mine;
}
function mergeObject(base: Record<string, unknown>, mine: Record<string, unknown>, current: Record<string, unknown>, at: string, conflicts: string[]) {
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(mine), ...Object.keys(current), ...Object.keys(base)])) {
    if (RESERVED.has(key)) continue;
    const value = mergeValue(base[key], mine[key], current[key], at ? `${at}.${key}` : key, conflicts);
    if (value !== undefined) out[key] = value;
  }
  return out;
}
/** Three-way document merge (null = absent), as baoyu-design's dashboard server. */
export function mergeDbWrite(base: Record<string, unknown> | null, mine: Record<string, unknown> | null, current: Record<string, unknown> | null) {
  const conflicts: string[] = [];
  if (mine === null) return { result: null, conflicts: current === null || same(current, base) ? [] : ["."] };
  if (current === null) return same(mine, base) ? { result: null, conflicts } : { result: mine, conflicts: base === null ? [] : ["."] };
  return { result: mergeObject(base ?? {}, mine, current, "", conflicts), conflicts };
}
/**
 * Plans one write as a wire batch for applyDesignFiles (with the file's ifMatch).
 * `ownLast` is this writer's own last stored result for the path ("null" after a
 * delete), so a page that deletes and re-sets before it hears back is not
 * refused against its own write.
 */
export function planDesignDbWrite(document: DesignDocument, input: unknown, viewer: DesignDbViewer, ownLast?: string): DesignDbWrite | { noop: true; path: string } {
  const parsed = writeSchema.safeParse(input);
  if (!parsed.success) throw new DesignDbError("design_invalid_db_write");
  const { op, data, base } = parsed.data, { path, file } = designDbPath(parsed.data.path, viewer);
  if (!access(path, viewer).write) throw new DesignDbError(viewer.readOnly ? "not_writer" : "design_db_forbidden", 403);
  if (base !== undefined && base !== null && !isObject(base)) throw new DesignDbError("design_invalid_db_write");
  if (op !== "delete") { if (!isObject(data)) throw new DesignDbError("design_invalid_db_write"); checkData(data); if (op === "set" && hasDeleteMarker(data)) throw new DesignDbError("design_invalid_db_write"); }
  else if (data !== undefined) throw new DesignDbError("design_invalid_db_write");
  if (base !== undefined && base !== null) checkData(base);
  const current = readFile(document, file) ?? null, own = ownLast !== undefined && ownLast === canonicalJson(current);
  // A missing base (the page has not heard of this document) may create it or
  // follow its own write; it never overwrites another writer's document.
  if (base === undefined && current !== null && !own) throw new DesignDbError("conflict", 409, current);
  const fresh = base === undefined || own || same(base, current);
  let next: Record<string, unknown> | null, merged = false, conflicts: string[] = [];
  if (fresh) next = op === "delete" ? null : op === "set" ? data as Record<string, unknown> : mergePatch(current ?? {}, data as Record<string, unknown>);
  else {
    const prior = (base ?? null) as Record<string, unknown> | null, mine = op === "delete" ? null : op === "set" ? data as Record<string, unknown> : mergePatch(prior ?? {}, data as Record<string, unknown>);
    ({ result: next, conflicts } = mergeDbWrite(prior, mine, current)); merged = true;
  }
  const flags = merged ? { merged: true as const, conflicts } : {};
  if (next === null) {
    if (!current) return { noop: true, path };
    return { path, file, op: "delete", existed: true, batch: { [file]: { delete: true, ifMatch: document.files[file].sha256 } }, ...flags };
  }
  checkData(next);
  const text = JSON.stringify(next);
  if (new TextEncoder().encode(text).length > DESIGN_DB_LIMITS.docBytes) throw new DesignDbError("design_db_too_large", 413);
  const encoded = designTextFile(text, "application/json");
  return { path, file, op: op === "delete" ? "set" : op, existed: !!current, next, batch: { [file]: { base64: encoded.base64, contentType: encoded.contentType, ifMatch: document.files[file]?.sha256 ?? null } }, ...flags };
}
/** Document changes between two revisions, for the runtime's `change` event. */
export function designDbChanges(before: DesignDocument, after: DesignDocument, viewer: DesignDbViewer) {
  const changes: { path: string; data: Json | null }[] = [];
  for (const file of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
    if (!file.startsWith("project/db/") || !file.endsWith(".json") || before.files[file]?.sha256 === after.files[file]?.sha256) continue;
    const path = file.slice(11, -5);
    try { designDbPath(path, {}); } catch { continue; }
    if (!access(path, viewer).read) continue;
    let data: Json | null = null;
    try { data = (readFile(after, file) ?? null) as Json | null; } catch { data = null; }
    changes.push({ path, data });
  }
  return changes;
}
