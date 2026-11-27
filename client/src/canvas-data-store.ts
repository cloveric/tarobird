import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export const CANVAS_DATA_MAX_RECORD_BYTES = 32 * 1024 * 1024;
export const CANVAS_DATA_MAX_KEY_LENGTH = 256;
export const OFFICIAL_CANVAS_PLUGIN_ID = "tarobird.infinite-canvas";

const DATABASE = "tarobird.plugin.canvas-data.v1";
const SCOPE_USAGE_MAX = { bytes: 256 * 1024 * 1024, records: 512 };
const DEVICE_USAGE_MAX = { bytes: 2 * 1024 * 1024 * 1024, records: 8192 };
const IN_FLIGHT_MAX_BYTES = 2 * CANVAS_DATA_MAX_RECORD_BYTES;
const IN_FLIGHT_MAX_OPS = 8;
const DEVICE_USAGE_KEY: [string, string] = ["", ""];
type ScopeKey = [string, string];
type RecordKey = [string, string, string];
type Usage = { bytes: number; records: number };
const EMPTY_USAGE: Usage = { bytes: 0, records: 0 };

interface CanvasDatabase extends DBSchema {
  data: { key: RecordKey; value: Blob };
  usage: { key: ScopeKey; value: Usage };
}

export function validCanvasScope(scopeId: unknown): scopeId is string {
  return typeof scopeId === "string" && scopeId.length > 0 && scopeId.length <= 512
    && scopeId !== "default" && scopeId.trim() === scopeId && !/[\u0000-\u001f\u007f]/.test(scopeId);
}

function scopedKey(scopeId: string, pluginId: string): ScopeKey {
  if (!validCanvasScope(scopeId) || pluginId !== OFFICIAL_CANVAS_PLUGIN_ID) throw new Error("canvas_data_scope_invalid");
  return [scopeId, pluginId];
}

function recordKey(scope: ScopeKey, key: string): RecordKey {
  if (typeof key !== "string" || !key.length || key.length > CANVAS_DATA_MAX_KEY_LENGTH) {
    throw new Error("canvas_data_key_invalid");
  }
  return [...scope, key];
}

function scopeRange(scope: ScopeKey): IDBKeyRange {
  // IndexedDB sorts array keys after string keys, including strings ending in U+FFFF.
  return IDBKeyRange.bound(scope, [...scope, []], true, true);
}

function nextUsage(previous: Usage, bytes: number, records: number): Usage {
  const next = { bytes: previous.bytes + bytes, records: previous.records + records };
  if (!Number.isSafeInteger(next.bytes) || !Number.isSafeInteger(next.records) || next.bytes < 0 || next.records < 0) {
    throw new Error("canvas_data_unavailable");
  }
  return next;
}

/** The app owns this database. One transaction commits bytes and quota
 * together, including when multiple app documents try to write concurrently. */
export function createCanvasDataStore(database = DATABASE) {
  let inFlightBytes = 0;
  let inFlightOps = 0;
  function reserve(bytes: number) {
    if (inFlightOps >= IN_FLIGHT_MAX_OPS || inFlightBytes + bytes > IN_FLIGHT_MAX_BYTES) throw new Error("canvas_data_busy");
    inFlightBytes += bytes;
    inFlightOps++;
    return () => { inFlightBytes -= bytes; inFlightOps--; };
  }

  let opening: Promise<IDBPDatabase<CanvasDatabase>> | undefined;
  function open() {
    if (typeof indexedDB === "undefined") return Promise.reject(new Error("canvas_data_unavailable"));
    if (!opening) {
      opening = openDB<CanvasDatabase>(database, 1, {
        upgrade(db) {
          db.createObjectStore("data");
          db.createObjectStore("usage");
        },
        blocking(_current, _next, event) {
          (event.target as IDBDatabase).close();
          opening = undefined;
        },
        terminated() { opening = undefined; },
      }).catch(() => {
        opening = undefined;
        throw new Error("canvas_data_unavailable");
      });
    }
    return opening;
  }

  async function writeRecord(scope: ScopeKey, key: RecordKey, value?: Blob) {
    const db = await open();
    const tx = db.transaction(["data", "usage"], "readwrite");
    void tx.done.catch(() => undefined);
    const data = tx.objectStore("data"), usage = tx.objectStore("usage");
    const [previous, scopeUsage = EMPTY_USAGE, deviceUsage = EMPTY_USAGE] = await Promise.all([
      data.get(key), usage.get(scope), usage.get(DEVICE_USAGE_KEY),
    ]);
    if (value === undefined && !previous) { await tx.done; return; }
    const bytes = (value?.size ?? 0) - (previous?.size ?? 0);
    const records = Number(value !== undefined) - Number(previous !== undefined);
    const nextScope = nextUsage(scopeUsage, bytes, records);
    const nextDevice = nextUsage(deviceUsage, bytes, records);
    if (nextScope.bytes > SCOPE_USAGE_MAX.bytes || nextScope.records > SCOPE_USAGE_MAX.records
      || nextDevice.bytes > DEVICE_USAGE_MAX.bytes || nextDevice.records > DEVICE_USAGE_MAX.records) {
      await tx.done;
      throw new Error("canvas_data_quota_exceeded");
    }
    await Promise.all([
      value !== undefined ? data.put(value, key) : data.delete(key),
      nextScope.records ? usage.put(nextScope, scope) : usage.delete(scope),
      usage.put(nextDevice, DEVICE_USAGE_KEY),
      tx.done,
    ]);
  }

  return {
    async get(scopeId: string, pluginId: string, key: string): Promise<Uint8Array | null> {
      const record = recordKey(scopedKey(scopeId, pluginId), key);
      const value = await (await open()).get("data", record);
      if (value === undefined) return null;
      if (!(value instanceof Blob) || value.size > CANVAS_DATA_MAX_RECORD_BYTES) throw new Error("canvas_data_unavailable");
      const release = reserve(value.size);
      try { return new Uint8Array(await value.arrayBuffer()); }
      finally { release(); }
    },

    async put(scopeId: string, pluginId: string, key: string, value: Uint8Array): Promise<true> {
      const scope = scopedKey(scopeId, pluginId);
      const record = recordKey(scope, key);
      if (!(value instanceof Uint8Array) || value.byteLength > CANVAS_DATA_MAX_RECORD_BYTES) throw new Error("canvas_data_value_invalid");
      // Snapshot before the first await. A shared/resizable input cannot alter
      // the committed bytes or the quota after this request was validated.
      const release = reserve(value.byteLength);
      try {
        await writeRecord(scope, record, new Blob([new Uint8Array(value)]));
        return true;
      } finally { release(); }
    },

    async remove(scopeId: string, pluginId: string, key: string): Promise<true> {
      const scope = scopedKey(scopeId, pluginId);
      await writeRecord(scope, recordKey(scope, key));
      return true;
    },

    async keys(scopeId: string, pluginId: string): Promise<string[]> {
      const scope = scopedKey(scopeId, pluginId);
      const db = await open();
      return (await db.getAllKeys("data", scopeRange(scope))).map(([, , key]) => key);
    },

    async clear(scopeId: string, pluginId: string): Promise<void> {
      const scope = scopedKey(scopeId, pluginId);
      const db = await open();
      const range = scopeRange(scope);
      const tx = db.transaction(["data", "usage"], "readwrite");
      void tx.done.catch(() => undefined);
      const usage = tx.objectStore("usage");
      const [scopeUsage = EMPTY_USAGE, deviceUsage = EMPTY_USAGE] = await Promise.all([usage.get(scope), usage.get(DEVICE_USAGE_KEY)]);
      const nextDevice = nextUsage(deviceUsage, -scopeUsage.bytes, -scopeUsage.records);
      await Promise.all([
        tx.objectStore("data").delete(range),
        usage.delete(scope),
        usage.put(nextDevice, DEVICE_USAGE_KEY),
        tx.done,
      ]);
    },
  };
}

export type CanvasDataStore = ReturnType<typeof createCanvasDataStore>;
export const canvasDataStore = createCanvasDataStore();

type CanvasDataRequest =
  | { method: "canvas.data.get" | "canvas.data.remove"; key: string }
  | { method: "canvas.data.put"; key: string; value: Uint8Array }
  | { method: "canvas.data.keys" };

/** Trust and grant are supplied by the app's installed bundle record, never
 * from the iframe payload. The same narrow gate protects native credentials. */
export function requireCanvasStorageAccess(
  context: { scopeId?: string; pluginId: string; officialBundledCanvas: boolean },
  granted: boolean,
): asserts context is typeof context & { scopeId: string } {
  if (!granted || !context.officialBundledCanvas || context.pluginId !== OFFICIAL_CANVAS_PLUGIN_ID) throw new Error("capability_denied");
  if (!validCanvasScope(context.scopeId)) throw new Error("canvas_data_scope_invalid");
}

export async function handleCanvasDataRequest(
  request: CanvasDataRequest,
  context: { scopeId?: string; pluginId: string; officialBundledCanvas: boolean; storageGranted: boolean; store?: CanvasDataStore },
): Promise<Uint8Array | null | true | string[]> {
  requireCanvasStorageAccess(context, context.storageGranted);
  const { scopeId, pluginId, store = canvasDataStore } = context;
  try {
    switch (request.method) {
      case "canvas.data.get": return await store.get(scopeId, pluginId, request.key);
      case "canvas.data.put": return await store.put(scopeId, pluginId, request.key, request.value);
      case "canvas.data.remove": return await store.remove(scopeId, pluginId, request.key);
      case "canvas.data.keys": return await store.keys(scopeId, pluginId);
    }
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === "QuotaExceededError") throw new Error("canvas_data_quota_exceeded");
      if (["canvas_data_key_invalid", "canvas_data_value_invalid", "canvas_data_quota_exceeded", "canvas_data_busy"].includes(error.message)) {
        throw new Error(error.message);
      }
    }
    throw new Error("canvas_data_unavailable");
  }
}
