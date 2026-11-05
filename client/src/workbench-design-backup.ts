import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { DESIGN_FILE_COUNT } from "../../src/client-protocol/workbench-design.js";
import { decodeDesignFile, designDocumentSchema, validateDesignDocument, type DesignDocument, type DesignFile } from "./workbench-design.js";
import { designCommentsSchema, importDesignComments, type DesignCommentsDoc } from "./workbench-design-comments.js";
import { DESIGN_HISTORY_BUDGET, designHistorySchema, type DesignHistoryIndex } from "./workbench-design-history.js";

/** 32 MiB current files + 64 MiB history objects, base64 and bounded metadata. */
export const DESIGN_BACKUP_MAX_BYTES = 144 * 1024 * 1024;
const HISTORY_METADATA_BYTES = 8 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const titleSchema = z.string().trim().min(1).max(128);
const envelopeV1 = z.object({ format: z.literal("tarobot-design"), version: z.literal(1), title: titleSchema, document: z.unknown() }).strict();
const envelopeV2 = z.object({ format: z.literal("tarobot-design"), version: z.literal(2), title: titleSchema, document: z.unknown(), comments: z.unknown().optional(), history: z.unknown().optional(), objects: z.record(digest, z.unknown()).optional() }).strict();
export type DesignBackupContent = { title: string; document: DesignDocument; comments?: DesignCommentsDoc; history?: DesignHistoryIndex; objects?: Record<string, DesignFile> };
export type DesignBackup = DesignBackupContent & { format: "tarobot-design"; version: 2 };
const fail = (code: string): never => { throw new Error(code); };
const encoder = new TextEncoder();
function boundedText(text: string, max: number, code: string) {
  if (text.length > max || encoder.encode(text).byteLength > max) fail(code);
}
function boundedJson(value: unknown, max: number, code: string) {
  let text: string | undefined;
  try { text = JSON.stringify(value); } catch { fail("design_invalid_backup"); }
  if (text === undefined) return fail("design_invalid_backup");
  boundedText(text, max, code); return text;
}
const tracked = (path: string) => !path.startsWith("project/assets/");
const liveManifest = (document: DesignDocument) => new Map(Object.entries(document.files).filter(([path]) => tracked(path)).map(([path, file]) => [path, file.sha256]));
function historyHead(history: DesignHistoryIndex) {
  const state = new Map(Object.entries(history.base));
  for (const version of history.versions) for (const [path, hash] of Object.entries(version.changes)) hash === null ? state.delete(path) : state.set(path, hash);
  return state;
}
function manifestChanges(before: Map<string, string>, after: Map<string, string>) {
  return Object.fromEntries([...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path)).map(path => [path, after.get(path) ?? null]));
}
function referencedObjects(history: DesignHistoryIndex) {
  return new Set([...Object.values(history.base), ...history.versions.flatMap(version => Object.values(version.changes).filter((hash): hash is string => hash !== null))]);
}

/** Validate every byte and every indexed object before exporting or importing.
 * Deliberate history gaps remain gaps; an unmarked missing object is corrupt. */
function verifyContent(input: z.infer<typeof envelopeV2>): DesignBackupContent {
  const document = validateDesignDocument(input.document);
  const comments = input.comments === undefined ? undefined : designCommentsSchema.parse(input.comments);
  let history: DesignHistoryIndex | undefined, objects: Record<string, DesignFile> | undefined;
  if (input.history === undefined) {
    if (input.objects !== undefined && Object.keys(input.objects).length) fail("design_backup_orphan_objects");
  } else {
    boundedJson(input.history, HISTORY_METADATA_BYTES, "design_backup_history_limit");
    history = designHistorySchema.parse(input.history);
    if (history.versions.length > DESIGN_HISTORY_BUDGET.maxVersions || Object.keys(history.base).length > DESIGN_FILE_COUNT) fail("design_backup_history_limit");
    let n = 0, revision = history.baseRevision;
    if (revision > document.revision) fail("design_backup_history_invalid");
    for (const version of history.versions) {
      if (version.n <= n || version.n >= history.next || version.revision < revision || version.revision > document.revision || !Number.isFinite(Date.parse(version.first)) || !Number.isFinite(Date.parse(version.at)) || Date.parse(version.first) > Date.parse(version.at) || version.restoredFrom !== undefined && version.restoredFrom >= version.n) fail("design_backup_history_invalid");
      if (Object.keys(version.changes).length > DESIGN_FILE_COUNT) fail("design_backup_history_limit");
      n = version.n; revision = version.revision;
    }
    const total = Object.values(history.objects).reduce((sum, size) => sum + size, 0);
    if (!Number.isSafeInteger(total) || total > DESIGN_HISTORY_BUDGET.maxObjectBytes) fail("design_backup_history_limit");
    const supplied = input.objects ?? {}, wanted = Object.keys(history.objects);
    if (wanted.length !== Object.keys(supplied).length || wanted.some(hash => !Object.hasOwn(supplied, hash))) fail("design_backup_object_missing");
    objects = {};
    for (const hash of wanted) {
      const file = designDocumentSchema.shape.files.valueType.parse(supplied[hash]), bytes = decodeDesignFile(file);
      if (file.sha256 !== hash || file.size !== history.objects[hash] || bytes.byteLength !== file.size || bytesToHex(sha256(bytes)) !== hash) fail("design_backup_object_corrupt");
      objects[hash] = file;
    }
    const referenced = referencedObjects(history), live = new Set(Object.values(document.files).map(file => file.sha256));
    if (wanted.some(hash => !referenced.has(hash))) fail("design_backup_orphan_objects");
    const missing = [...referenced].some(hash => !live.has(hash) && !Object.hasOwn(objects!, hash));
    if (missing && revision === document.revision && !history.versions.some(version => version.gap || version.objectsOmitted)) fail("design_backup_object_missing");
    // A newer live revision can follow the documented history-quota fallback.
    // Equal revisions with different manifests instead indicate a broken index.
    if (revision === document.revision && Object.keys(manifestChanges(historyHead(history), liveManifest(document))).length) fail("design_backup_history_invalid");
    const tail = manifestChanges(historyHead(history), liveManifest(document));
    if (Object.keys(tail).length) {
      // The latest committed files can be newer after history quota fallback.
      // Make that gap explicit in the backup, without claiming lost bytes exist.
      const at = new Date().toISOString();
      history.versions.push({ n: history.next++, first: at, at, by: "system", user: { id: "system", name: "Unrecorded changes" }, revision: document.revision, changes: tail, gap: true });
      while (history.versions.length > DESIGN_HISTORY_BUDGET.maxVersions) {
        const removed = history.versions.shift()!;
        for (const [path, hash] of Object.entries(removed.changes)) hash === null ? delete history.base[path] : history.base[path] = hash;
        history.baseRevision = removed.revision;
      }
      const keep = referencedObjects(history);
      objects = Object.fromEntries(Object.entries(objects).filter(([hash]) => keep.has(hash)));
      history.objects = Object.fromEntries(Object.entries(history.objects).filter(([hash]) => keep.has(hash)));
      history = designHistorySchema.parse(history);
    }
  }
  return { title: input.title, document, ...(comments ? { comments } : {}), ...(history ? { history, objects } : {}) };
}

/** Returns a detached, verified export. No storage or editor side effects. */
export function createDesignBackup(content: DesignBackupContent): DesignBackup {
  const envelope = envelopeV2.parse({ format: "tarobot-design", version: 2, ...content });
  const result: DesignBackup = { format: "tarobot-design", version: 2, ...verifyContent(envelope) };
  boundedJson(result, DESIGN_BACKUP_MAX_BYTES, "design_backup_too_large");
  return result;
}
export function serializeDesignBackup(content: DesignBackupContent): string {
  return boundedJson(createDesignBackup(content), DESIGN_BACKUP_MAX_BYTES, "design_backup_too_large");
}

/** Import never trusts saved user/Bot identities or command receipts. The caller
 * allocates newId; all returned stores must be committed atomically with its tab. */
export function parseDesignBackup(text: string, newId: string): DesignBackupContent {
  boundedText(text, DESIGN_BACKUP_MAX_BYTES, "design_backup_too_large");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return fail("design_invalid_backup"); }
  const legacy = envelopeV1.safeParse(raw);
  const source = legacy.success ? verifyContent({ ...legacy.data, version: 2 }) : verifyContent(envelopeV2.parse(raw));
  const document = validateDesignDocument({ ...source.document, id: newId, revision: 0, receipts: [] });
  const comments = source.comments ? importDesignComments(source.comments, newId) : undefined;
  let history: DesignHistoryIndex | undefined, objects = source.objects;
  if (source.history) {
    history = structuredClone(source.history);
    // Include a known unrecorded tail as an explicit gap before rebasing the
    // imported document revision. Version numbers themselves remain stable.
    const changes = manifestChanges(historyHead(history), liveManifest(source.document));
    if (Object.keys(changes).length) {
      const at = new Date().toISOString();
      history.versions.push({ n: history.next++, first: at, at, by: "system", user: { id: "system", name: "Imported unrecorded changes" }, revision: source.document.revision, changes, gap: true });
    }
    while (history.versions.length > DESIGN_HISTORY_BUDGET.maxVersions) {
      const removed = history.versions.shift()!;
      for (const [path, hash] of Object.entries(removed.changes)) hash === null ? delete history.base[path] : history.base[path] = hash;
    }
    history.revision = 0; history.baseRevision = 0;
    history.versions = history.versions.map(({ requestId: _requestId, ...version }) => ({ ...version, revision: 0, by: "human" as const,
      user: { id: `imported:${bytesToHex(sha256(encoder.encode(`${newId}\0${version.user.id}`))).slice(0, 32)}`, name: version.user.name } }));
    const referenced = referencedObjects(history);
    objects = Object.fromEntries(Object.entries(objects ?? {}).filter(([hash]) => referenced.has(hash)));
    history.objects = Object.fromEntries(Object.entries(history.objects).filter(([hash]) => referenced.has(hash)));
    history = designHistorySchema.parse(history);
  }
  return { title: source.title, document, ...(comments ? { comments } : {}), ...(history ? { history, objects } : {}) };
}
