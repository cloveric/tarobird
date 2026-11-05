// Runs in the Electron renderer before HostApp mounts. The main process has
// already verified the export (electron/migration.mjs); this module rechecks
// every record it writes. Per-host databases are written first and are not
// referenced by anything until the registry commits in one transaction, so an
// interrupted import is invisible and is safely redone from the same export.
import {
  HOST_STORES, LOCAL_STORAGE, MIGRATION_DATABASE_MARKER, MIGRATION_LOCAL_KEY, MIGRATION_RECEIPT_KEY, MIGRATION_REPAIR_KEY,
  REGISTRY_DATABASE, REGISTRY_STORES, decodeValue, isExportId, isHostDatabase, parseRecordLine, type MigrationManifest,
} from "./desktop-migration-format.js";

export interface ImportSource {
  manifest: MigrationManifest;
  /** Main verified the previous snapshot before replacing it. Only its
   * uncommitted database claims may be superseded; committed data never is. */
  replacesExportId?: string;
  part(index: number): Promise<string>;
  blob(sha256: string): Promise<Uint8Array>;
}
export type StoredRecord = { key: unknown; value: unknown };
export type RegistryRecords = Record<typeof REGISTRY_STORES[number], StoredRecord[]>;
export type TargetState = { hosts: number; candidates: number; registryVersion: number; importedExportId?: string; pendingLocalStorage?: [string, string][] };
export interface ImportTarget {
  /** Registry contents relevant to merging, and an earlier committed import. */
  state(): Promise<TargetState>;
  /** Existing database contents without creating or upgrading it. */
  inspect(database: string): Promise<{ exists: boolean; records: number; marker?: string }>;
  /** Database names in this profile, if the engine can enumerate them. */
  databases(): Promise<string[] | undefined>;
  /** Creates the App's canonical schema and returns its version. */
  prepare(database: string): Promise<number>;
  /** Clears the stores and records that this export now owns the database. */
  claim(database: string, stores: readonly string[], exportId: string): Promise<void>;
  put(database: string, store: string, records: StoredRecord[]): Promise<void>;
  /** One transaction: registry stores, the import marker, the hosts needing
   * explicit repair and any localStorage entries still to be applied. */
  commitRegistry(records: RegistryRecords, exportId: string, extras: { repair: string[]; local: [string, string][] }): Promise<void>;
  setLocalStorage(entries: [string, string][]): Promise<void>;
  /** Removes the pending localStorage copy once it has been applied. */
  finishLocalStorage(): Promise<void>;
}
export type NotEmptyReason = "hosts" | "network_candidates" | "previous_import" | "legacy_identity" | "database_in_use";
export type ImportResult =
  | { state: "already_imported"; exportId: string; localStorage: "saved" | "failed" }
  | { state: "target_not_empty"; reason: NotEmptyReason; database?: string; importedExportId?: string }
  | { state: "imported"; exportId: string; records: number; requiresRepair: string[]; skipped: number; orphanDatabases: string[]; localStorage: "saved" | "failed" };

const BATCH_RECORDS = 256, BATCH_BYTES = 8 * 1024 * 1024;
const fail = (code: string): never => { throw new Error(code); };

async function applyLocalStorage(target: ImportTarget, entries: [string, string][]): Promise<"saved" | "failed"> {
  try { await target.setLocalStorage(entries); await target.finishLocalStorage(); return "saved"; }
  catch { return "failed"; } // The pending copy stays in the registry; the next start retries.
}

export async function importDesktopData(source: ImportSource, target: ImportTarget): Promise<ImportResult> {
  const manifest = source.manifest;
  if (manifest?.format !== "tarobot-desktop-migration" || manifest.version !== 1 || !isExportId(manifest.exportId)) fail("migration_manifest_invalid");
  const current = await target.state();
  if (current.importedExportId === manifest.exportId) {
    return { state: "already_imported", exportId: manifest.exportId, localStorage: current.pendingLocalStorage ? await applyLocalStorage(target, current.pendingLocalStorage) : "saved" };
  }
  // Never merge into a profile that already holds hosts, candidates, a
  // previous import, a legacy single-host identity (HostApp would import it on
  // boot) or a manifest database with contents this export does not own.
  if (current.importedExportId) return { state: "target_not_empty", reason: "previous_import", importedExportId: current.importedExportId };
  if (current.hosts > 0) return { state: "target_not_empty", reason: "hosts" };
  if (current.candidates > 0) return { state: "target_not_empty", reason: "network_candidates" };
  const expected = new Map<string, Map<string, number>>();
  for (const database of manifest.databases) {
    if (database.name !== REGISTRY_DATABASE && !isHostDatabase(database.name)) fail("migration_manifest_invalid");
    expected.set(database.name, new Map(Object.entries(database.stores)));
  }
  if (!expected.has("tarocub-v1") && (await target.inspect("tarocub-v1")).records > 0) return { state: "target_not_empty", reason: "legacy_identity", database: "tarocub-v1" };
  for (const name of expected.keys()) {
    if (name === REGISTRY_DATABASE) continue;
    const existing = await target.inspect(name);
    if (existing.records > 0 && existing.marker !== manifest.exportId
      && !(isExportId(source.replacesExportId) && existing.marker === source.replacesExportId)) return { state: "target_not_empty", reason: "database_in_use", database: name };
  }
  const registry = manifest.databases.find(database => database.name === REGISTRY_DATABASE) ?? fail("migration_manifest_invalid");
  // v10 adds workbench stores, v11 notes v12 design documents and v13 design comments/history. Existing
  // records retain their exact shape; permit only these known additive transitions.
  if (registry.version !== current.registryVersion) fail("migration_schema_mismatch");
  for (const database of manifest.databases) {
    if (database.name === REGISTRY_DATABASE) continue;
    const version = await target.prepare(database.name);
    if (version !== database.version && !([9, 10, 11, 12].includes(database.version) && version > database.version && version <= 13)) fail("migration_schema_mismatch");
  }
  // Unreferenced databases with contents (for example from an older failed
  // import) stay untouched and invisible; they are reported, not deleted.
  const orphanDatabases: string[] = [];
  for (const name of await target.databases() ?? []) {
    if (!isHostDatabase(name) || expected.has(name)) continue;
    if ((await target.inspect(name)).records > 0) orphanDatabases.push(name);
  }
  for (const database of manifest.databases) if (database.name !== REGISTRY_DATABASE) await target.claim(database.name, HOST_STORES, manifest.exportId);
  const seen = new Map<string, Map<string, number>>();
  const count = (d: string, s: string) => { const stores = seen.get(d) ?? new Map<string, number>(); seen.set(d, stores); stores.set(s, (stores.get(s) ?? 0) + 1); };
  const registryRecords: RegistryRecords = { hosts: [], meta: [], networkCandidates: [] };
  const local: [string, string][] = [];
  let pending: { d: string; s: string; records: StoredRecord[]; bytes: number } | undefined;
  const flush = async () => { if (pending?.records.length) await target.put(pending.d, pending.s, pending.records); pending = undefined; };
  const getBlob = (sha: string) => source.blob(sha);
  let records = 0;
  for (let index = 0; index < manifest.parts.length; index++) {
    const text = await source.part(index);
    if (!text.endsWith("\n")) fail("migration_record_invalid");
    for (const line of text.slice(0, -1).split("\n")) {
      const record = parseRecordLine(line);
      if (record.d !== LOCAL_STORAGE && !expected.get(record.d)?.has(record.s)) fail("migration_manifest_mismatch");
      const key = await decodeValue(record.k, getBlob), value = await decodeValue(record.v, getBlob);
      count(record.d, record.s); records++;
      if (record.d === LOCAL_STORAGE) {
        if (typeof key !== "string" || typeof value !== "string" || !/^(tarocub|tarobot)/.test(key)) fail("migration_record_invalid");
        local.push([key as string, value as string]); continue;
      }
      if (record.d === REGISTRY_DATABASE) {
        if (record.s === "meta" && [MIGRATION_RECEIPT_KEY, MIGRATION_REPAIR_KEY, MIGRATION_LOCAL_KEY].includes(key as string)) fail("migration_record_invalid");
        registryRecords[record.s as typeof REGISTRY_STORES[number]].push({ key, value }); continue;
      }
      if (record.s === "settings" && key === MIGRATION_DATABASE_MARKER) fail("migration_record_invalid");
      if (pending && (pending.d !== record.d || pending.s !== record.s || pending.records.length >= BATCH_RECORDS || pending.bytes >= BATCH_BYTES)) await flush();
      pending ??= { d: record.d, s: record.s, records: [], bytes: 0 };
      pending.records.push({ key, value }); pending.bytes += line.length;
    }
  }
  await flush();
  // Exact agreement with the verified manifest before anything becomes visible.
  if (records !== manifest.totals.records || local.length !== manifest.localStorage) fail("migration_manifest_mismatch");
  for (const [database, stores] of expected) for (const [store, total] of stores) if ((seen.get(database)?.get(store) ?? 0) !== total) fail("migration_manifest_mismatch");
  for (const [database, stores] of seen) if (database !== LOCAL_STORAGE) for (const store of stores.keys()) if (!expected.get(database)?.has(store)) fail("migration_manifest_mismatch");
  if (registryRecords.hosts.some(({ value }) => !isHostDatabase(String((value as { databaseName?: unknown })?.databaseName)))) fail("migration_host_database_invalid");
  const repair = [...manifest.requiresRepair];
  await target.commitRegistry(registryRecords, manifest.exportId, { repair, local });
  return { state: "imported", exportId: manifest.exportId, records, requiresRepair: repair, skipped: manifest.skipped.length, orphanDatabases,
    localStorage: local.length ? await applyLocalStorage(target, local) : "saved" };
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("migration_write_aborted")); });
}
/** Opens an existing database at its current version; never creates one. */
function openExisting(factory: IDBFactory, name: string): Promise<IDBDatabase | undefined> {
  return new Promise((resolve, reject) => {
    const open = factory.open(name);
    let created = false;
    open.onupgradeneeded = () => { created = true; open.transaction?.abort(); };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => { if (created) resolve(undefined); else reject(open.error ?? new Error("migration_target_unavailable")); };
  });
}
async function openCurrent(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return await openExisting(factory, name) ?? fail("migration_target_unavailable");
}
function pendingEntries(raw: unknown): [string, string][] | undefined {
  if (typeof raw !== "string") return undefined;
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string")) fail("migration_local_invalid");
  return value as [string, string][];
}

/** IndexedDB target using the App's own schema code (ClientCache and HostRegistry). */
export async function indexedDbImportTarget(factory: IDBFactory = indexedDB, storage: Storage = localStorage): Promise<ImportTarget> {
  const [{ ClientCache }, { HostRegistry }] = await Promise.all([import("./storage.js"), import("./host-registry.js")]);
  const write = async (name: string, stores: string[], work: (tx: IDBTransaction) => void) => {
    const db = await openCurrent(factory, name);
    try { const tx = db.transaction(stores, "readwrite"), complete = done(tx); work(tx); await complete; } finally { db.close(); }
  };
  const putRecords = (tx: IDBTransaction, store: string, records: StoredRecord[]) => {
    const objects = tx.objectStore(store);
    for (const { key, value } of records) { if (objects.keyPath === null) objects.put(value, key as IDBValidKey); else objects.put(value); }
  };
  return {
    async state() {
      const registry = new HostRegistry(REGISTRY_DATABASE);
      try { await registry.list(); } finally { registry.close(); }
      const db = await openCurrent(factory, REGISTRY_DATABASE);
      try {
        const tx = db.transaction(["hosts", "meta", "networkCandidates"], "readonly"), meta = tx.objectStore("meta");
        const [hosts, candidates, marker, local] = await Promise.all([request(tx.objectStore("hosts").count()), request(tx.objectStore("networkCandidates").count()),
          request(meta.get(MIGRATION_RECEIPT_KEY)), request(meta.get(MIGRATION_LOCAL_KEY))]);
        const pendingLocalStorage = pendingEntries(local);
        return { hosts, candidates, registryVersion: db.version, ...(typeof marker === "string" ? { importedExportId: marker } : {}), ...(pendingLocalStorage ? { pendingLocalStorage } : {}) };
      } finally { db.close(); }
    },
    async inspect(name) {
      const db = await openExisting(factory, name);
      if (!db) return { exists: false, records: 0 };
      try {
        const stores = [...db.objectStoreNames];
        if (!stores.length) return { exists: true, records: 0 };
        const tx = db.transaction(stores, "readonly");
        const counts = await Promise.all(stores.map(store => request(tx.objectStore(store).count())));
        const marker = stores.includes("settings") ? await request(tx.objectStore("settings").get(MIGRATION_DATABASE_MARKER)) : undefined;
        return { exists: true, records: counts.reduce((a, b) => a + b, 0), ...(typeof marker === "string" ? { marker } : {}) };
      } finally { db.close(); }
    },
    async databases() {
      if (typeof factory.databases !== "function") return undefined;
      return (await factory.databases()).map(entry => entry.name).filter((name): name is string => typeof name === "string");
    },
    async prepare(name) {
      if (!isHostDatabase(name)) fail("migration_host_database_invalid");
      const cache = new ClientCache(name);
      try { await cache.outbox(); }
      catch (error) { if (error instanceof DOMException && error.name === "VersionError") fail("migration_schema_mismatch"); throw error; }
      finally { cache.close(); }
      const db = await openCurrent(factory, name);
      try { return db.version; } finally { db.close(); }
    },
    claim: (name, stores, exportId) => write(name, [...stores], tx => {
      for (const store of stores) tx.objectStore(store).clear();
      tx.objectStore("settings").put(exportId, MIGRATION_DATABASE_MARKER);
    }),
    put: (name, store, records) => write(name, [store], tx => putRecords(tx, store, records)),
    commitRegistry: (records, exportId, { repair, local }) => write(REGISTRY_DATABASE, [...REGISTRY_STORES], tx => {
      for (const store of REGISTRY_STORES) { tx.objectStore(store).clear(); putRecords(tx, store, records[store]); }
      const meta = tx.objectStore("meta");
      meta.put(exportId, MIGRATION_RECEIPT_KEY);
      if (repair.length) meta.put(JSON.stringify(repair), MIGRATION_REPAIR_KEY);
      if (local.length) meta.put(JSON.stringify(local), MIGRATION_LOCAL_KEY);
    }),
    async setLocalStorage(entries) { for (const [key, value] of entries) storage.setItem(key, value); },
    finishLocalStorage: () => write(REGISTRY_DATABASE, ["meta"], tx => { tx.objectStore("meta").delete(MIGRATION_LOCAL_KEY); }),
  };
}
