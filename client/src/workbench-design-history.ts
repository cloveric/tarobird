import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { designPath } from "../../src/client-protocol/workbench-design.js";
import { decodeDesignFile, type DesignDocument, type DesignFile } from "./workbench-design.js";

// Bounded version history for one Baoyu document. Semantics follow the
// upstream baoyu-design local history (MIT, Jim Liu): a base plus per-version
// changes (path → sha256 | null), one person's nearby edits join a version,
// and a restore is written as a new version. Storage is the App's own
// content-addressed object store, written in the same transaction as the
// document. Only bytes that left the live document are stored; assets are
// immutable and never part of a restore. History must never block a save.

export const DESIGN_HISTORY_BUDGET = { maxVersions: 200, maxObjectBytes: 64 * 1024 * 1024, idleMs: 30_000, spanMs: 5 * 60_000 } as const;
export type DesignHistoryBudget = { maxVersions: number; maxObjectBytes: number; idleMs: number; spanMs: number };
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const tracked = (path: string) => !path.startsWith("project/assets/");
const pathKey = designPath.refine(tracked, "design_history_untracked");
const iso = z.string().max(40);
const versionSchema = z.object({
  n: z.number().int().positive().safe(), first: iso, at: iso, by: z.enum(["human", "agent", "system"]),
  user: z.object({ id: z.string().min(1).max(200), name: z.string().max(100) }).strict(), revision: z.number().int().nonnegative().safe(),
  changes: z.record(pathKey, sha.nullable()), requestId: z.string().max(128).optional(), restoredFrom: z.number().int().positive().optional(),
  restoredPart: z.literal(true).optional(), gap: z.literal(true).optional(), objectsOmitted: z.literal(true).optional(),
  /** The files as they were when the history began (upstream's first, system version). */
  initial: z.literal(true).optional(),
}).strict();
export const designHistorySchema = z.object({
  schema: z.literal(1), revision: z.number().int().nonnegative().safe(), baseRevision: z.number().int().nonnegative().safe(),
  base: z.record(pathKey, sha), versions: z.array(versionSchema).max(1000), next: z.number().int().positive().safe(), objects: z.record(sha, z.number().int().nonnegative()),
}).strict();
export type DesignHistoryIndex = z.infer<typeof designHistorySchema>;
export type DesignHistoryVersion = DesignHistoryIndex["versions"][number];
export type DesignHistoryAuthor = { by: "human" | "agent" | "system"; user: { id: string; name: string }; requestId?: string };
export type DesignHistoryPlan = { expected: number; next: DesignHistoryIndex; put: Record<string, DesignFile>; drop: string[] };
export class DesignHistoryError extends Error { constructor(readonly code: string, readonly status = 409) { super(code); } }
export const designRestoreSchema = z.object({ version: z.number().int().positive().safe(), paths: z.array(designPath).min(1).max(512).optional() }).strict();
export const designHistoryListSchema = z.object({ limit: z.number().int().min(1).max(50).optional(), before: z.number().int().positive().optional() }).strict();
export const designHistoryDiffSchema = z.object({ version: z.number().int().positive().safe(), path: designPath }).strict();

const manifest = (document: DesignDocument) => new Map(Object.entries(document.files).filter(([path]) => tracked(path)).map(([path, file]) => [path, file.sha256]));
const liveShas = (document: DesignDocument) => new Set(Object.values(document.files).map(file => file.sha256));
function fold(index: DesignHistoryIndex, upto: number) {
  const state = new Map(Object.entries(index.base));
  for (const version of index.versions) {
    if (version.n > upto) break;
    for (const [path, value] of Object.entries(version.changes)) value === null ? state.delete(path) : state.set(path, value);
  }
  return state;
}
function changesBetween(before: Map<string, string>, after: Map<string, string>) {
  const changes: Record<string, string | null> = {};
  for (const path of new Set([...before.keys(), ...after.keys()])) if ((before.get(path) ?? null) !== (after.get(path) ?? null)) changes[path] = after.get(path) ?? null;
  return changes;
}
const objectBytes = (index: DesignHistoryIndex) => Object.values(index.objects).reduce((sum, size) => sum + size, 0);

/** Plans the history sidecar for one document save; undefined when nothing tracked changed. */
export function planDesignHistory(input: { index?: DesignHistoryIndex; before: DesignDocument; after: DesignDocument; author: DesignHistoryAuthor; restoredFrom?: number; restoredPart?: boolean; now?: Date; budget?: Partial<DesignHistoryBudget> }): DesignHistoryPlan | undefined {
  const budget = { ...DESIGN_HISTORY_BUDGET, ...input.budget }, now = input.now ?? new Date(), at = now.toISOString();
  const before = manifest(input.before), after = manifest(input.after), live = liveShas(input.after);
  // A new history starts with the document as it is now, as its own version, so
  // the state before the first recorded change can be restored too.
  const index: DesignHistoryIndex = input.index ? structuredClone(input.index)
    : { schema: 1, revision: 0, baseRevision: input.before.revision, base: {}, versions: before.size ? [{ n: 1, first: at, at, by: "system", user: { id: "system", name: "" }, revision: input.before.revision, changes: Object.fromEntries(before), initial: true }] : [], next: before.size ? 2 : 1, objects: {} };
  const put: Record<string, DesignFile> = {}, dropped = new Set<string>();
  // A save made without history (another window, quota fallback) leaves a gap.
  // Record it honestly; content lost in the gap cannot be restored.
  const head = fold(index, Infinity), gap = changesBetween(head, before);
  let changed = false;
  if (input.index && Object.keys(gap).length) {
    index.versions.push({ n: index.next++, first: at, at, by: "system", user: { id: "system", name: "" }, revision: input.before.revision, changes: gap, gap: true }); changed = true;
  }
  const changes = changesBetween(before, after);
  if (Object.keys(changes).length) {
    changed = true;
    for (const [path, value] of Object.entries(changes)) {
      const old = before.get(path);
      if (old && old !== value && !live.has(old) && !(old in index.objects)) { put[old] = input.before.files[path]; index.objects[old] = input.before.files[path].size; }
    }
    const last = index.versions.at(-1), stamp = now.getTime();
    const joins = !!last && input.author.by === "human" && last.by === "human" && !input.author.requestId && !last.requestId && last.user.id === input.author.user.id
      && last.restoredFrom === undefined && input.restoredFrom === undefined && !last.gap && stamp - Date.parse(last.at) < budget.idleMs && stamp - Date.parse(last.first) < budget.spanMs;
    if (joins) { Object.assign(last.changes, changes); last.at = at; last.revision = input.after.revision; if (input.author.user.name) last.user = { ...input.author.user }; }
    else index.versions.push({ n: index.next++, first: at, at, by: input.author.by, user: { id: input.author.user.id.slice(0, 200) || "unknown", name: input.author.user.name.slice(0, 100) }, revision: input.after.revision, changes,
      ...(input.author.requestId ? { requestId: input.author.requestId } : {}), ...(input.restoredFrom !== undefined ? { restoredFrom: input.restoredFrom } : {}), ...(input.restoredFrom !== undefined && input.restoredPart ? { restoredPart: true as const } : {}) });
  }
  if (!changed) return undefined;
  const collect = () => {
    const keep = new Set(Object.values(index.base));
    for (const version of index.versions) for (const value of Object.values(version.changes)) if (value) keep.add(value);
    for (const key of Object.keys(index.objects)) if (live.has(key) || !keep.has(key)) { delete index.objects[key]; if (key in put) delete put[key]; else dropped.add(key); }
  };
  collect();
  while (index.versions.length > budget.maxVersions || objectBytes(index) > budget.maxObjectBytes) {
    if (index.versions.length > 1) {
      const oldest = index.versions.shift()!;
      for (const [path, value] of Object.entries(oldest.changes)) value === null ? delete index.base[path] : index.base[path] = value;
      index.baseRevision = oldest.revision; collect(); continue;
    }
    // One version larger than the whole budget: keep its record, not its old bytes.
    const only = index.versions[0];
    if (only) only.objectsOmitted = true;
    for (const key of Object.keys(index.objects)) { delete index.objects[key]; if (key in put) delete put[key]; else dropped.add(key); }
    break;
  }
  const expected = input.index?.revision ?? -1;
  index.revision = expected + 1;
  return { expected, next: designHistorySchema.parse(index), put, drop: [...dropped] };
}

type ReadObject = (sha: string) => Promise<DesignFile | undefined>;
const verified = (file: DesignFile | undefined, want: string) => {
  if (!file) return undefined;
  const bytes = decodeDesignFile(file);
  return bytes.length === file.size && bytesToHex(sha256(bytes)) === want && file.sha256 === want ? file : undefined;
};
async function content(want: string, current: DesignDocument, read: ReadObject) {
  const live = Object.values(current.files).find(file => file.sha256 === want);
  return verified(live ?? await read(want), want);
}
/** Files to write to bring version `n` (or chosen paths of it) back, where they differ from now. */
export async function planDesignRestore(index: DesignHistoryIndex | undefined, input: z.infer<typeof designRestoreSchema>, current: DesignDocument, read: ReadObject): Promise<Record<string, DesignFile | null>> {
  const version = index?.versions.find(item => item.n === input.version);
  if (!index || !version) throw new DesignHistoryError("design_history_version_not_found", 404);
  const target = fold(index, version.n), now = manifest(current), out: Record<string, DesignFile | null> = {};
  if (input.paths?.some(path => !tracked(path) || !target.has(path) && !now.has(path))) throw new DesignHistoryError("design_history_path_not_found", 404);
  for (const path of input.paths ? [...new Set(input.paths)] : [...new Set([...target.keys(), ...now.keys()])]) {
    const want = target.get(path) ?? null;
    if ((now.get(path) ?? null) === want) continue;
    if (want === null) { out[path] = null; continue; }
    const file = await content(want, current, read);
    if (!file) throw new DesignHistoryError("design_history_object_missing", 409);
    out[path] = file;
  }
  return out;
}
/** The whole document as it was right after version `n` (for a read-only preview). */
export async function designAtVersion(index: DesignHistoryIndex | undefined, n: number, current: DesignDocument, read: ReadObject): Promise<DesignDocument> {
  const version = index?.versions.find(item => item.n === n);
  if (!index || !version) throw new DesignHistoryError("design_history_version_not_found", 404);
  const files: DesignDocument["files"] = Object.fromEntries(Object.entries(current.files).filter(([path]) => !tracked(path)));
  for (const [path, want] of fold(index, n)) {
    const file = await content(want, current, read);
    if (!file) throw new DesignHistoryError("design_history_object_missing", 409);
    files[path] = file;
  }
  return { ...current, files, receipts: [] };
}
export type DesignHistoryRowView = { n: number; first: string; at: string; by: DesignHistoryVersion["by"]; name: string; userId: string; revision: number; files: { path: string; op: "added" | "edited" | "deleted" }[];
  requestId?: string; restoredFrom?: number; restoredPart?: boolean; gap?: boolean; objectsOmitted?: boolean; initial?: boolean; current?: boolean };
/** Newest first, with each version's files as added/edited/deleted. */
export function designHistoryRows(index: DesignHistoryIndex | undefined, input: z.infer<typeof designHistoryListSchema> = {}): { rows: DesignHistoryRowView[]; more: boolean } {
  if (!index) return { rows: [], more: false };
  const state = new Map(Object.entries(index.base)), all = index.versions.map((version): DesignHistoryRowView => {
    const files = Object.entries(version.changes).map(([path, value]) => { const op = value === null ? "deleted" as const : state.has(path) ? "edited" as const : "added" as const; value === null ? state.delete(path) : state.set(path, value); return { path, op }; });
    return { n: version.n, first: version.first, at: version.at, by: version.by, name: version.user.name, userId: version.user.id, revision: version.revision, files,
      ...(version.requestId ? { requestId: version.requestId } : {}), ...(version.restoredFrom !== undefined ? { restoredFrom: version.restoredFrom } : {}),
      ...(version.restoredPart ? { restoredPart: true } : {}), ...(version.gap ? { gap: true } : {}), ...(version.objectsOmitted ? { objectsOmitted: true } : {}), ...(version.initial ? { initial: true } : {}) };
  }).reverse();
  const newest = all[0]?.n, from = input.before === undefined ? all : all.filter(row => row.n < input.before!), limit = input.limit ?? 50;
  return { rows: from.slice(0, limit).map(row => row.n === newest ? { ...row, current: true } : row), more: from.length > limit };
}
export async function designHistoryDiff(index: DesignHistoryIndex | undefined, input: z.infer<typeof designHistoryDiffSchema>, current: DesignDocument, read: ReadObject) {
  const version = index?.versions.find(item => item.n === input.version);
  if (!index || !version || !(input.path in version.changes)) throw new DesignHistoryError("design_history_version_not_found", 404);
  const beforeSha = fold(index, version.n - 1).get(input.path) ?? null, afterSha = version.changes[input.path];
  const load = async (want: string | null) => want === null ? null : await content(want, current, read);
  const [a, b] = await Promise.all([load(beforeSha), load(afterSha)]);
  if (beforeSha && !a || afterSha && !b) return { path: input.path, missing: true, added: 0, removed: 0, lines: [] as [string, string][] };
  return { path: input.path, ...diffText(a ? decodeDesignFile(a) : null, b ? decodeDesignFile(b) : null) };
}

const MAX_DIFF_BYTES = 1024 * 1024, MAX_EDIT = 2000, MAX_DIFF_LINES = 3000, MAX_LINE = 2000, CONTEXT = 3;
/** Myers O(ND) shortest edit script; null past MAX_EDIT. */
export function editScript(a: string[], b: string[], maxEdit = MAX_EDIT): ("=" | "+" | "-")[] | null {
  const n = a.length, m = b.length, max = Math.min(n + m, maxEdit), offset = max + 1, v = new Int32Array(2 * max + 3), trace: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || k !== d && v[offset + k - 1] < v[offset + k + 1] ? v[offset + k + 1] : v[offset + k - 1] + 1, y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break outer; }
    }
  }
  if (found < 0) return null;
  const ops: ("=" | "+" | "-")[] = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const previous = trace[d], at = (k: number) => previous[k + d + 1], k = x - y;
    const prior = k === -d || k !== d && at(k - 1) < at(k + 1) ? k + 1 : k - 1, px = at(prior), py = px - prior;
    while (x > px && y > py) { ops.push("="); x--; y--; }
    ops.push(x === px ? "+" : "-"); x = px; y = py;
  }
  while (x > 0 && y > 0) { ops.push("="); x--; y--; }
  return ops.reverse();
}
const decoder = new TextDecoder("utf-8", { fatal: true });
const textOf = (bytes: Uint8Array | null) => { if (bytes === null) return null; if (bytes.includes(0)) return undefined; try { return decoder.decode(bytes); } catch { return undefined; } };
const lines = (text: string | null) => text === null || text === "" ? [] : text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
/** A bounded line diff, rendered by callers as text only. */
export function diffText(before: Uint8Array | null, after: Uint8Array | null) {
  type Line = [" " | "+" | "-" | "~", string];
  if ((before?.length ?? 0) > MAX_DIFF_BYTES || (after?.length ?? 0) > MAX_DIFF_BYTES) return { tooLarge: true, added: 0, removed: 0, lines: [] as Line[] };
  const a = textOf(before), b = textOf(after);
  if (a === undefined || b === undefined) return { binary: true, added: 0, removed: 0, lines: [] as Line[] };
  const left = lines(a), right = lines(b);
  let head = 0, tail = 0;
  while (head < left.length && head < right.length && left[head] === right[head]) head++;
  while (tail < left.length - head && tail < right.length - head && left[left.length - 1 - tail] === right[right.length - 1 - tail]) tail++;
  const middle = editScript(left.slice(head, left.length - tail), right.slice(head, right.length - tail));
  if (!middle) return { tooLarge: true, added: 0, removed: 0, lines: [] as Line[] };
  const ops = [...Array<"=">(head).fill("="), ...middle, ...Array<"=">(tail).fill("=")], all: Line[] = [], cut = (text: string) => text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text;
  let i = 0, j = 0, added = 0, removed = 0;
  for (const op of ops) {
    if (op === "=") { all.push([" ", cut(right[j++])]); i++; }
    else if (op === "-") { all.push(["-", cut(left[i++])]); removed++; }
    else { all.push(["+", cut(right[j++])]); added++; }
  }
  const keep = new Uint8Array(all.length);
  all.forEach(([kind], at) => { if (kind !== " ") for (let x = Math.max(0, at - CONTEXT); x <= Math.min(all.length - 1, at + CONTEXT); x++) keep[x] = 1; });
  const out: Line[] = [];
  let skipped = 0, truncated = false;
  for (let at = 0; at < all.length; at++) {
    if (!keep[at]) { skipped++; continue; }
    if (skipped) out.push(["~", String(skipped)]);
    skipped = 0;
    if (out.length >= MAX_DIFF_LINES) { truncated = true; break; }
    out.push(all[at]);
  }
  if (skipped && !truncated) out.push(["~", String(skipped)]);
  return { added, removed, lines: out, ...(truncated ? { truncated: true } : {}) };
}
