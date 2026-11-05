// Runs inside the Tauri transition build's WebView, the only context that can
// read the old origin's IndexedDB. Reads are readonly; nothing in the source
// is changed or deleted. The native sink (desktop_migration.rs) computes the
// authoritative counts and hashes and commits atomically.
import {
  HOST_STORES, LOCAL_STORAGE, MIGRATION_LIMITS, MIGRATION_LOCAL_TOTAL_BYTES, OPTIONAL_STORES, REGISTRY_DATABASE, REGISTRY_STORES,
  MigrationValueError, databaseHost, encodeRecordLine, encodeValue, isExportId, isHostDatabase, type EncodeReport,
} from "./desktop-migration-format.js";
import { runtimeHostId } from "./runtime-host-id.js";

export interface ExportSource {
  /** Current schema version, or undefined when the database does not exist. */
  database(name: string): Promise<{ version: number } | undefined>;
  records(database: string, store: string): AsyncIterable<{ key: unknown; value: unknown }>;
  localStorage(): Iterable<[string, string]>;
}
export type ExportMetadata = { appVersion: string; databases: { name: string; version: number }[]; skipped: Skipped[]; requiresRepair: string[] };
export interface ExportSink {
  begin(): Promise<string>;
  part(index: number, text: string): Promise<void>;
  blob(bytes: Uint8Array): Promise<string>;
  commit(metadata: ExportMetadata): Promise<{ exportId: string; records: number; bytes: number }>;
  abort(): Promise<void>;
}
export type Skipped = { d: string; s: string; key: string; reason: string };
export type ExportResult = { state: "empty" }
  | { state: "exported"; exportId: string; records: number; bytes: number; requiresRepair: string[]; skipped: Skipped[] };

/** Tauri rejects native Result errors as strings, not Error instances. Keep
 * only bounded public reason codes; never surface native details or data. */
export function migrationExportError(error: unknown): string {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const reason = message.split(":", 1)[0]!;
  return /^(migration|legacy_source)_[a-z_]{1,100}$/.test(reason) ? reason : "migration_export_failed";
}

const keyLabel = (key: unknown) => { try { return JSON.stringify(key)?.slice(0, 200) ?? "undefined"; } catch { return "unserializable"; } };
const sizeOf = (value: unknown) => value instanceof Blob ? value.size : value instanceof ArrayBuffer ? value.byteLength
  : ArrayBuffer.isView(value) ? value.byteLength : value && typeof value === "object" && "bytes" in value && (value as { bytes: unknown }).bytes instanceof ArrayBuffer ? ((value as { bytes: ArrayBuffer }).bytes).byteLength : 0;

/** Exports registry, every registered host database and TaroBird localStorage.
 * Any unsupported value in a required store fails the whole export. */
export async function exportDesktopData(source: ExportSource, sink: ExportSink, options: { appVersion: string }): Promise<ExportResult> {
  const registry = await source.database(REGISTRY_DATABASE) ?? { version: 2 };
  const databases = new Map<string, number>(), skipped: Skipped[] = [], repair = new Set<string>();
  const hostDatabases: string[] = [], owners = new Map<string, string[]>();
  for await (const { value } of source.records(REGISTRY_DATABASE, "hosts")) {
    const host = value as { id?: unknown; databaseName?: unknown } | undefined, name = host?.databaseName;
    if (typeof name !== "string" || !isHostDatabase(name) || typeof host?.id !== "string" || !/^hub_[0-9a-f]{64}$/.test(host.id)) throw new Error("migration_host_database_invalid");
    if (!hostDatabases.includes(name)) hostDatabases.push(name);
    owners.set(name, [...owners.get(name) ?? [], host.id]);
  }
  // Pre-multi-host installations can have only the legacy database. Preserve
  // it too; HostRegistry performs the existing import after the startup gate.
  if (!hostDatabases.includes("tarocub-v1") && await source.database("tarocub-v1")) hostDatabases.push("tarocub-v1");
  if (hostDatabases.length > 1024) throw new Error("migration_too_many_hosts");
  const exportId = await sink.begin();
  if (!isExportId(exportId)) throw new Error("migration_sink_invalid");
  let index = 0, buffer = "", bufferBytes = 0, records = 0;
  const encoder = new TextEncoder();
  const flush = async () => { if (!buffer) return; await sink.part(index++, buffer); buffer = ""; bufferBytes = 0; };
  const putBlob = (bytes: Uint8Array) => sink.blob(bytes);
  const add = async (d: string, s: string, key: unknown, value: unknown) => {
    const report: EncodeReport = { unexportable: [] };
    let line: string;
    try {
      line = await encodeRecordLine({ d, s, k: await encodeValue(key, putBlob), v: await encodeValue(value, putBlob, report) }, putBlob);
    } catch (error) {
      if (error instanceof MigrationValueError && error.reason === "too_large" && OPTIONAL_STORES.includes(s)) {
        skipped.push({ d, s, key: keyLabel(key), reason: "too_large" }); return;
      }
      throw error;
    }
    if (report.unexportable.length) {
      // A non-extractable WebCrypto key cannot move to another engine. Keep
      // the record, mark the key absent, and require explicit re-pairing.
      let host = d === REGISTRY_DATABASE ? (value as { id?: unknown } | undefined)?.id : databaseHost(d);
      if (!host && d === "tarocub-v1" && value && typeof value === "object" && "hubPublicKey" in value && typeof value.hubPublicKey === "string") {
        host = runtimeHostId(value.hubPublicKey);
      }
      if (typeof host === "string" && /^hub_[0-9a-f]{64}$/.test(host)) repair.add(host); else throw new Error("migration_unexportable_key");
      skipped.push({ d, s, key: keyLabel(key), reason: "crypto_key_removed" });
    }
    const bytes = encoder.encode(line).length;
    if (bufferBytes + bytes > MIGRATION_LIMITS.part) await flush();
    buffer += line; bufferBytes += bytes; records++;
    if (d !== LOCAL_STORAGE) databases.set(d, d === REGISTRY_DATABASE ? registry.version : databases.get(d) ?? 0);
  };
  try {
    for (const store of REGISTRY_STORES) for await (const { key, value } of source.records(REGISTRY_DATABASE, store)) await add(REGISTRY_DATABASE, store, key, value);
    // A valid empty source still needs a signed export. This harmless meta
    // record is generated in the snapshot, never written into the old profile.
    if (!databases.has(REGISTRY_DATABASE)) await add(REGISTRY_DATABASE, "meta", "desktopMigrationEmpty", "1");
    for (const name of hostDatabases) {
      const database = await source.database(name);
      // A registered host without its database cannot work in the source
      // either. Preserve the record, but never report it as a usable host.
      if (!database) { skipped.push({ d: name, s: "*", key: "", reason: "database_missing" }); owners.get(name)?.forEach(id => repair.add(id)); continue; }
      for (const store of HOST_STORES) {
        for await (const { key, value } of source.records(name, store)) {
          if (OPTIONAL_STORES.includes(store) && sizeOf(value) > MIGRATION_LIMITS.blob) { skipped.push({ d: name, s: store, key: keyLabel(key), reason: "too_large" }); continue; }
          await add(name, store, key, value);
        }
      }
      if (databases.has(name)) databases.set(name, database.version);
      else if (owners.has(name)) { skipped.push({ d: name, s: "*", key: "", reason: "database_empty" }); owners.get(name)?.forEach(id => repair.add(id)); }
    }
    let local = 0, localBytes = 0;
    for (const [key, value] of source.localStorage()) {
      if (!/^(tarocub|tarobot)/.test(key)) continue;
      const bytes = (key.length + value.length) * 2;
      if (value.length > MIGRATION_LIMITS.localStorageValue || local + 1 > MIGRATION_LIMITS.localStorageEntries || localBytes + bytes > MIGRATION_LOCAL_TOTAL_BYTES) {
        skipped.push({ d: LOCAL_STORAGE, s: "items", key: keyLabel(key), reason: "too_large" }); continue;
      }
      local++; localBytes += bytes;
      await add(LOCAL_STORAGE, "items", key, value);
    }
    if (!databases.has(REGISTRY_DATABASE)) { await sink.abort(); return { state: "empty" }; }
    await flush();
    if (skipped.length > MIGRATION_LIMITS.skipped) throw new Error("migration_too_many_skipped");
    const summary = await sink.commit({ appVersion: options.appVersion, databases: [...databases].map(([name, version]) => ({ name, version })), skipped, requiresRepair: [...repair].sort() });
    if (summary.exportId !== exportId || summary.records !== records) throw new Error("migration_commit_mismatch");
    return { state: "exported", exportId, records, bytes: summary.bytes, requiresRepair: [...repair].sort(), skipped };
  } catch (error) {
    await sink.abort().catch(() => undefined);
    throw error;
  }
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
}
/** Opens only existing databases at their current version: an absent database
 * is never created (its upgrade transaction is aborted). */
function openExisting(factory: IDBFactory, name: string): Promise<IDBDatabase | undefined> {
  return new Promise((resolve, reject) => {
    const open = factory.open(name);
    let created = false;
    open.onupgradeneeded = () => { created = true; open.transaction?.abort(); };
    open.onsuccess = () => resolve(open.result);
    // Aborting the creating upgrade discards the new, empty database.
    open.onerror = () => { if (created) resolve(undefined); else reject(open.error); };
    open.onblocked = () => reject(new Error("migration_source_blocked"));
  });
}

/** Readonly IndexedDB source, batched so large drafts are held one at a time. */
export function indexedDbExportSource(factory: IDBFactory = indexedDB, storage: Storage = localStorage): ExportSource {
  const batch = (store: string) => ["conversationDrafts", "attachmentData", "downloadChunks", "workbenchBoards", "workbenchMarkdown", "workbenchDesign", "workbenchDesignMeta", "workbenchDesignObjects"].includes(store) ? 1 : 200;
  return {
    async database(name) {
      const db = await openExisting(factory, name);
      if (!db) return undefined;
      try { return { version: db.version }; } finally { db.close(); }
    },
    async *records(name, store) {
      const db = await openExisting(factory, name);
      if (!db) return;
      try {
        if (!db.objectStoreNames.contains(store)) return;
        let after: IDBValidKey | undefined;
        for (;;) {
          const tx = db.transaction(store, "readonly"), objects = tx.objectStore(store);
          const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true);
          const [keys, values] = await Promise.all([request(objects.getAllKeys(range, batch(store))), request(objects.getAll(range, batch(store)))]);
          if (keys.length !== values.length) throw new Error("migration_source_changed");
          for (let i = 0; i < keys.length; i++) yield { key: keys[i], value: values[i] };
          if (keys.length < batch(store)) return;
          after = keys.at(-1);
        }
      } finally { db.close(); }
    },
    *localStorage() {
      for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key !== null) { const value = storage.getItem(key); if (value !== null) yield [key, value]; } }
    },
  };
}

/** Command contract for the root agent's Tauri wrappers in main.rs (main
 * window only). `invoke` is injected so this module adds no Tauri import. */
export const TAURI_MIGRATION_COMMANDS = Object.freeze({
  begin: "desktop_migration_begin", part: "desktop_migration_part", blob: "desktop_migration_blob",
  commit: "desktop_migration_commit", abort: "desktop_migration_abort", status: "desktop_migration_status",
});
/** Same shape as Tauri v2 `invoke(cmd, args, { headers })`. */
export type MigrationInvoke = <T>(command: string, args?: Record<string, unknown> | Uint8Array, options?: { headers?: Record<string, string> }) => Promise<T>;
export const EXPORT_ID_HEADER = "x-tarobot-export-id";
/** Every request names the export returned by `begin`; the native wrapper
 * rejects any other ID, so a delayed request from an earlier page or run
 * cannot write into a newer session (see phase2-export-contract.md). */
export function tauriExportSink(invoke: MigrationInvoke): ExportSink {
  let exportId: string | undefined;
  const current = async () => exportId ?? Promise.reject(new Error("migration_export_not_started"));
  return {
    async begin() {
      const value = await invoke<string>(TAURI_MIGRATION_COMMANDS.begin, {});
      if (!isExportId(value)) throw new Error("migration_sink_invalid");
      return exportId = value;
    },
    part: async (index, text) => invoke<void>(TAURI_MIGRATION_COMMANDS.part, { exportId: await current(), index, text }),
    // Raw IPC body; the wrapper reads `Request::body()` and this header.
    blob: async bytes => invoke<string>(TAURI_MIGRATION_COMMANDS.blob, bytes, { headers: { [EXPORT_ID_HEADER]: await current() } }),
    commit: async metadata => invoke(TAURI_MIGRATION_COMMANDS.commit, { exportId: await current(), metadata: JSON.stringify(metadata) }),
    async abort() { if (exportId) await invoke<void>(TAURI_MIGRATION_COMMANDS.abort, { exportId }); },
  };
}
