// Logical desktop data migration format shared by the Tauri transition
// exporter and the Electron importer. It mirrors the native writer
// (src-tauri/src/desktop_migration.rs) and verifier (electron/migration.mjs).
// Values are structured-clone data from IndexedDB; every supported type is
// tagged explicitly and anything else fails instead of being dropped.

export const MIGRATION_LIMITS = Object.freeze({
  line: 1024 * 1024, part: 32 * 1024 * 1024, blob: 128 * 1024 * 1024, inline: 64 * 1024,
  localStorageEntries: 10_000, localStorageValue: 1024 * 1024, skipped: 10_000, depth: 64,
});
export const REGISTRY_DATABASE = "tarocub-hosts-v1";
export const REGISTRY_STORES = ["hosts", "meta", "networkCandidates"] as const;
// Uncommitted snapshot staging (syncState/syncMessages) is never migrated.
export const HOST_STORES = ["settings", "conversations", "messages", "activity", "cursors", "outbox",
  "conversationDrafts", "attachmentData", "attachmentMeta", "downloadMeta", "downloadChunks", "workbenchLayouts", "workbenchBoards", "workbenchMarkdown", "workbenchDesign", "workbenchDesignMeta", "workbenchDesignObjects"] as const;
/** Caches whose oversized entries may be skipped; everything else is required. */
export const OPTIONAL_STORES: readonly string[] = ["attachmentData", "attachmentMeta", "downloadMeta", "downloadChunks"];
export const LOCAL_STORAGE = "localStorage";
/** Registry meta written atomically with the imported hosts. */
export const MIGRATION_RECEIPT_KEY = "desktopMigration";
/** JSON array of host IDs that must not connect until explicitly re-paired. */
export const MIGRATION_REPAIR_KEY = "desktopMigrationRepair";
/** JSON entries still to be written to localStorage; removed once applied. */
export const MIGRATION_LOCAL_KEY = "desktopMigrationLocalStorage";
/** Per-host-database settings marker: this export owns its contents. */
export const MIGRATION_DATABASE_MARKER = "desktopMigrationImport";
export const MIGRATION_LOCAL_TOTAL_BYTES = 8 * 1024 * 1024;
const EXPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;

export function isHostDatabase(name: string): boolean {
  return name === "tarocub-v1" || /^tarocub-host-hub_[0-9a-f]{64}-[A-Za-z0-9-]{1,64}$/.test(name);
}
export function allowedStore(database: string, store: string): boolean {
  if (database === REGISTRY_DATABASE) return (REGISTRY_STORES as readonly string[]).includes(store);
  if (database === LOCAL_STORAGE) return store === "items";
  return isHostDatabase(database) && (HOST_STORES as readonly string[]).includes(store);
}
export function isExportId(value: unknown): value is string { return typeof value === "string" && EXPORT_ID.test(value); }
/** Host ID owning a per-host database name, if it has one. */
export function databaseHost(name: string): string | undefined { return /^tarocub-host-(hub_[0-9a-f]{64})-/.exec(name)?.[1]; }

export type MigrationValueReason = "unsupported" | "cycle" | "too_deep" | "too_large";
export class MigrationValueError extends Error {
  constructor(readonly reason: MigrationValueReason, detail: string) { super(`migration_value_${reason}:${detail}`); }
}
export type BlobWriter = (bytes: Uint8Array) => Promise<string>;
export type BlobReader = (sha256: string) => Promise<Uint8Array>;
export type EncodeReport = { unexportable: string[] };

const BYTE_KINDS = ["ArrayBuffer", "DataView", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
  "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array"] as const;
type ByteKind = typeof BYTE_KINDS[number];
const encoder = new TextEncoder();
// Structured-clone records may legitimately contain __proto__. Assignment to
// a normal object's setter would silently discard that field during migration.
function dataProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function byteKind(value: object): ByteKind | undefined {
  if (value instanceof ArrayBuffer) return "ArrayBuffer";
  if (!ArrayBuffer.isView(value)) return undefined;
  const name = Object.getPrototypeOf(value)?.constructor?.name as ByteKind;
  return (BYTE_KINDS as readonly string[]).includes(name) ? name : undefined;
}
function plain(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function bytesField(bytes: Uint8Array, putBlob: BlobWriter): Promise<{ b64: string } | { ref: string }> {
  if (bytes.length > MIGRATION_LIMITS.blob) throw new MigrationValueError("too_large", String(bytes.length));
  return bytes.length <= MIGRATION_LIMITS.inline ? { b64: toBase64(bytes) } : { ref: await putBlob(bytes) };
}

/** Encodes one IndexedDB value. A CryptoKey cannot be exported: it becomes an
 * explicit `unexportable` marker that decodes to undefined and is reported. */
export async function encodeValue(value: unknown, putBlob: BlobWriter, report: EncodeReport = { unexportable: [] }): Promise<unknown> {
  const ancestors = new Set<object>();
  const visit = async (item: unknown, depth: number, at: string): Promise<unknown> => {
    if (depth > MIGRATION_LIMITS.depth) throw new MigrationValueError("too_deep", at);
    if (item === undefined) return { $t: "undef" };
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number") return Number.isFinite(item) && !Object.is(item, -0) ? item : { $t: "num", v: Object.is(item, -0) ? "-0" : String(item) };
    if (typeof item === "bigint") return { $t: "bigint", v: item.toString() };
    if (typeof item !== "object") throw new MigrationValueError("unsupported", `${at}:${typeof item}`);
    if (ancestors.has(item)) throw new MigrationValueError("cycle", at);
    if (typeof CryptoKey !== "undefined" && item instanceof CryptoKey) { report.unexportable.push(at); return { $t: "unexportable", kind: "CryptoKey" }; }
    if (item instanceof Date) return { $t: "date", v: Number.isNaN(item.getTime()) ? "NaN" : item.getTime() };
    if (typeof File !== "undefined" && item instanceof File) {
      return { $t: "file", name: item.name, type: item.type, lastModified: item.lastModified, size: item.size, ...await bytesField(new Uint8Array(await item.arrayBuffer()), putBlob) };
    }
    if (typeof Blob !== "undefined" && item instanceof Blob) return { $t: "blob", type: item.type, size: item.size, ...await bytesField(new Uint8Array(await item.arrayBuffer()), putBlob) };
    const kind = byteKind(item);
    if (kind) {
      const view = item instanceof ArrayBuffer ? new Uint8Array(item) : new Uint8Array((item as ArrayBufferView).buffer, (item as ArrayBufferView).byteOffset, (item as ArrayBufferView).byteLength);
      return { $t: "bytes", kind, size: view.length, ...await bytesField(view, putBlob) };
    }
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        const out: unknown[] = [];
        for (let i = 0; i < item.length; i++) out.push(await visit(item[i], depth + 1, `${at}[${i}]`));
        return out;
      }
      if (!plain(item)) throw new MigrationValueError("unsupported", `${at}:${Object.prototype.toString.call(item)}`);
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(item)) dataProperty(out, key, await visit(child, depth + 1, `${at}.${key}`));
      return Object.hasOwn(out, "$t") ? { $t: "obj", v: out } : out;
    } finally { ancestors.delete(item); }
  };
  return visit(value, 0, "$");
}

function invalid(): never { throw new Error("migration_record_invalid"); }
async function bytesOf(field: Record<string, unknown>, getBlob: BlobReader): Promise<Uint8Array> {
  const size = field.size;
  if (!Number.isSafeInteger(size) || (size as number) < 0 || (size as number) > MIGRATION_LIMITS.blob) invalid();
  let bytes: Uint8Array;
  if (typeof field.b64 === "string" && !("ref" in field)) bytes = fromBase64(field.b64);
  else if (typeof field.ref === "string" && SHA.test(field.ref) && !("b64" in field)) bytes = await getBlob(field.ref);
  else invalid();
  if (bytes.length !== size) invalid();
  return bytes;
}
const bytesConstructors: Record<Exclude<ByteKind, "ArrayBuffer" | "DataView">, new (buffer: ArrayBuffer) => ArrayBufferView> = {
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
};

export async function decodeValue(value: unknown, getBlob: BlobReader, depth = 0): Promise<unknown> {
  if (depth > MIGRATION_LIMITS.depth) invalid();
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return value;
  if (Array.isArray(value)) { const out: unknown[] = []; for (const item of value) out.push(await decodeValue(item, getBlob, depth + 1)); return out; }
  if (typeof value !== "object") invalid();
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, "$t")) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) dataProperty(out, key, await decodeValue(child, getBlob, depth + 1));
    return out;
  }
  switch (record.$t) {
    case "undef": return undefined;
    case "unexportable": return undefined;
    case "num": return record.v === "-0" ? -0 : record.v === "NaN" ? NaN : record.v === "Infinity" ? Infinity : record.v === "-Infinity" ? -Infinity : invalid();
    case "bigint": return typeof record.v === "string" && /^-?\d{1,1000}$/.test(record.v) ? BigInt(record.v) : invalid();
    case "date": return record.v === "NaN" ? new Date(NaN) : typeof record.v === "number" ? new Date(record.v) : invalid();
    case "obj": {
      if (!record.v || typeof record.v !== "object" || Array.isArray(record.v)) invalid();
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(record.v as Record<string, unknown>)) dataProperty(out, key, await decodeValue(child, getBlob, depth + 1));
      return out;
    }
    case "file": {
      if (typeof record.name !== "string" || typeof record.type !== "string" || !Number.isFinite(record.lastModified)) invalid();
      return new File([await bytesOf(record, getBlob) as BlobPart], record.name, { type: record.type, lastModified: record.lastModified as number });
    }
    case "blob": return typeof record.type === "string" ? new Blob([await bytesOf(record, getBlob) as BlobPart], { type: record.type }) : invalid();
    case "bytes": {
      const bytes = await bytesOf(record, getBlob), kind = record.kind as ByteKind;
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      if (kind === "ArrayBuffer") return buffer;
      if (kind === "DataView") return new DataView(buffer);
      const constructor = (bytesConstructors as Record<string, new (buffer: ArrayBuffer) => ArrayBufferView>)[kind];
      if (!constructor) invalid();
      return new constructor(buffer);
    }
    case "json": {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await bytesOf(record, getBlob));
      return decodeValue(JSON.parse(text), getBlob, depth + 1);
    }
    default: return invalid();
  }
}

export type MigrationRecord = { d: string; s: string; k: unknown; v: unknown };
/** JSON.stringify escapes lone UTF-16 surrogates. Rust's scalar-value JSON
 * parser rejects those escapes, although IndexedDB/JavaScript can preserve
 * them. Skip escaped backslashes so literal "\\ud800" text stays inline. */
function hasSurrogateEscape(json: string): boolean {
  for (let i = json.indexOf("\\"); i !== -1; i = json.indexOf("\\", i + 2)) {
    if (json[i + 1] === "u") {
      const code = Number.parseInt(json.slice(i + 2, i + 6), 16);
      if (code >= 0xd800 && code <= 0xdfff) return true;
    }
  }
  return false;
}
async function opaqueJson(value: unknown, putBlob: BlobWriter): Promise<unknown> {
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.length > MIGRATION_LIMITS.blob) throw new MigrationValueError("too_large", "JSON value");
  return { $t: "json", size: bytes.length, ref: await putBlob(bytes) };
}
/** One JSONL record. An oversized value moves into a blob as its JSON text. */
export async function encodeRecordLine(record: MigrationRecord, putBlob: BlobWriter): Promise<string> {
  if (!allowedStore(record.d, record.s)) throw new Error("migration_store_not_allowed");
  let line = JSON.stringify(record) + "\n";
  if (hasSurrogateEscape(line)) {
    // Reuse the existing JSON-blob format: the unmodified Electron importer
    // decodes the original UTF-16 code units, including object/IndexedDB keys.
    // No replacement character, skipped record or wire-format change.
    record = { ...record,
      k: hasSurrogateEscape(JSON.stringify(record.k)) ? await opaqueJson(record.k, putBlob) : record.k,
      v: hasSurrogateEscape(JSON.stringify(record.v)) ? await opaqueJson(record.v, putBlob) : record.v,
    };
    line = JSON.stringify(record) + "\n";
  }
  if (encoder.encode(line).length <= MIGRATION_LIMITS.line) return line;
  const json = encoder.encode(JSON.stringify(record.v));
  if (json.length > MIGRATION_LIMITS.blob) throw new MigrationValueError("too_large", `${record.d}/${record.s}`);
  line = JSON.stringify({ ...record, v: { $t: "json", size: json.length, ref: await putBlob(json) } }) + "\n";
  if (encoder.encode(line).length > MIGRATION_LIMITS.line) throw new MigrationValueError("too_large", `${record.d}/${record.s}:key`);
  return line;
}
export function parseRecordLine(line: string): MigrationRecord {
  let value: unknown;
  try { value = JSON.parse(line); } catch { invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 4 || !["d", "s", "k", "v"].every(key => Object.hasOwn(record, key))) invalid();
  if (typeof record.d !== "string" || typeof record.s !== "string" || !allowedStore(record.d, record.s)) invalid();
  return record as MigrationRecord;
}

/** Shape the native writer guarantees; the importer rechecks what it relies on. */
export type MigrationManifest = {
  format: "tarobot-desktop-migration"; version: 1; exportId: string; createdAt: number; installation: string;
  source: { app: "tauri"; appVersion: string };
  databases: { name: string; version: number; stores: Record<string, number> }[];
  localStorage: number;
  parts: { file: string; bytes: number; sha256: string; records: number }[];
  blobs: { sha256: string; bytes: number }[];
  totals: { records: number; bytes: number };
  skipped: unknown[]; requiresRepair: string[];
};
