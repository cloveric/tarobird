import type { IDBPTransaction, StoreNames } from "idb";
import { CHUNK_BYTES } from "../../src/client-protocol/index.js";
import type { Cache, Identity } from "./storage.js";

export const DOWNLOAD_TTL_MS = 24 * 60 * 60 * 1000;
export const DOWNLOAD_CACHE_BYTES = 512 * 1024 * 1024;
export const DOWNLOAD_CACHE_COUNT = 8;
export type DownloadCheckpoint = { revision: string; etag: string; total: number; mime: string; offset: number; updatedAt: number };
export type StoredDownloadCheckpoint = DownloadCheckpoint & { scope: string };
export type DownloadChunk = { attachmentId: string; revision: string; index: number; bytes: ArrayBuffer };
export interface DownloadCheckpointStore {
  load(id: string, maxPrefixBytes?: number): Promise<DownloadCheckpoint | undefined>;
  read(id: string, revision: string, index: number): Promise<ArrayBuffer | undefined>;
  append(id: string, checkpoint: DownloadCheckpoint, start: number, bytes: ArrayBuffer, maxCacheBytes?: number): Promise<boolean>;
  discard(id: string, revision: string): Promise<void>;
}
type Transaction = IDBPTransaction<Cache, StoreNames<Cache>[], "readwrite">;
const scopeOf = (identity?: Identity) => identity ? JSON.stringify([identity.deviceId, identity.hubPublicKey, identity.publicKey]) : "";
export function validDownloadCheckpoint(candidate: unknown, now = Date.now()): candidate is DownloadCheckpoint {
  if (!candidate || typeof candidate !== "object") return false;
  const value = candidate as DownloadCheckpoint;
  return typeof value.revision === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value.revision)
    && typeof value.etag === "string" && /^"[a-f0-9]{64}"$/.test(value.etag)
    && Number.isSafeInteger(value.total) && Number.isSafeInteger(value.offset)
    && value.offset > 0 && value.offset < value.total && value.offset % CHUNK_BYTES === 0 && value.offset <= DOWNLOAD_CACHE_BYTES
    && typeof value.mime === "string" && value.mime.length <= 256
    && Number.isSafeInteger(value.updatedAt) && value.updatedAt > now - DOWNLOAD_TTL_MS && value.updatedAt <= now + 300_000;
}

/** One host cache and one pairing. All reads are fenced too: an old connection
 * cannot read a replacement pairing's prefix while a reset/revoke is pending. */
export class PersistentDownloadCheckpoints implements DownloadCheckpointStore {
  private readonly scope: string;
  constructor(private readonly transaction: () => Promise<Transaction>, private readonly identity: Identity) { this.scope = scopeOf(identity); }
  private async open(): Promise<Transaction> {
    const tx = await this.transaction(), settings = tx.objectStore("settings");
    if (scopeOf(await settings.get("identity") as Identity | undefined) !== this.scope
      || await settings.get("revokedIdentity") === JSON.stringify([this.identity.deviceId, this.identity.hubPublicKey])) {
      tx.abort(); await tx.done.catch(() => undefined); throw new Error("download_pairing_changed");
    }
    return tx;
  }
  private async remove(tx: Transaction, id: string): Promise<void> {
    await tx.objectStore("downloadMeta").delete(id);
    // Key cursors avoid loading every 8 MiB buffer just to delete a journal.
    let cursor = await tx.objectStore("downloadChunks").index("attachment").openKeyCursor(id);
    while (cursor) { await tx.objectStore("downloadChunks").delete(cursor.primaryKey); cursor = await cursor.continue(); }
  }
  private async prune(tx: Transaction, now: number) {
    const meta = tx.objectStore("downloadMeta"), entries: { id: string; value: StoredDownloadCheckpoint }[] = [];
    let cursor = await meta.openCursor();
    while (cursor) {
      if (!validDownloadCheckpoint(cursor.value, now) || cursor.value.scope !== this.scope) await this.remove(tx, cursor.key);
      else entries.push({ id: cursor.key, value: cursor.value });
      cursor = await cursor.continue();
    }
    return entries.sort((a, b) => a.value.updatedAt - b.value.updatedAt);
  }
  async load(id: string, maxPrefixBytes = DOWNLOAD_CACHE_BYTES): Promise<DownloadCheckpoint | undefined> {
    if (!Number.isSafeInteger(maxPrefixBytes) || maxPrefixBytes < CHUNK_BYTES || maxPrefixBytes % CHUNK_BYTES) throw new Error("invalid_download_prefix_limit");
    const tx = await this.open(), now = Date.now(); await this.prune(tx, now);
    let value = await tx.objectStore("downloadMeta").get(id);
    if (value && value.offset > maxPrefixBytes) {
      // New disk-backed downloads need room for their assembly too. Trim an old
      // larger prefix atomically before replay, without extending its TTL or
      // discarding the useful beginning. A concurrent old replay can restart if
      // it already observed a larger offset; no unchecked bytes are exported.
      let cursor = await tx.objectStore("downloadChunks").index("attachment").openKeyCursor(id);
      while (cursor) {
        if (cursor.primaryKey[1] !== value.revision || cursor.primaryKey[2] >= maxPrefixBytes / CHUNK_BYTES) await tx.objectStore("downloadChunks").delete(cursor.primaryKey);
        cursor = await cursor.continue();
      }
      value = { ...value, offset: maxPrefixBytes }; await tx.objectStore("downloadMeta").put(value, id);
    }
    const entries = await this.prune(tx, now); let size = entries.reduce((sum, entry) => sum + entry.value.offset, 0);
    for (const entry of entries) {
      if (size <= maxPrefixBytes) break;
      if (entry.id !== id) { await this.remove(tx, entry.id); size -= entry.value.offset; }
    }
    await tx.done; return value;
  }
  async sweep(): Promise<void> { const tx = await this.open(); await this.prune(tx, Date.now()); await tx.done; }
  async read(id: string, revision: string, index: number): Promise<ArrayBuffer | undefined> {
    const tx = await this.open(), meta = await tx.objectStore("downloadMeta").get(id);
    const chunk = meta?.revision === revision && validDownloadCheckpoint(meta) && meta.scope === this.scope
      ? await tx.objectStore("downloadChunks").get([id, revision, index]) : undefined;
    await tx.done; return chunk?.bytes;
  }
  async append(id: string, checkpoint: DownloadCheckpoint, start: number, bytes: ArrayBuffer, maxCacheBytes = DOWNLOAD_CACHE_BYTES): Promise<boolean> {
    if (!Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < CHUNK_BYTES || maxCacheBytes > DOWNLOAD_CACHE_BYTES || maxCacheBytes % CHUNK_BYTES || checkpoint.offset > maxCacheBytes) return false;
    if (!validDownloadCheckpoint(checkpoint) || !Number.isSafeInteger(start) || start < 0 || start % CHUNK_BYTES
      || !(bytes instanceof ArrayBuffer) || bytes.byteLength !== CHUNK_BYTES || checkpoint.offset !== start + bytes.byteLength) return false;
    // Estimate outside the transaction. All host databases share one origin's
    // quota; leave half of it (and at least 32 MiB) for history, drafts and outbox.
    const storage = globalThis.navigator?.storage;
    const estimate = await storage?.estimate?.().catch(() => undefined);
    if (estimate?.quota !== undefined && estimate.usage !== undefined
      && estimate.usage + bytes.byteLength > Math.min(estimate.quota / 2, estimate.quota - 32 * 1024 ** 2)) return false;
    const tx = await this.open(), entries = await this.prune(tx, Date.now()), meta = tx.objectStore("downloadMeta"), old = await meta.get(id);
    // Compare revision AND offset. A delayed tab may not recreate an evicted or
    // completed journal, overwrite another attempt, or leave orphan chunks.
    if (old ? old.revision !== checkpoint.revision || old.offset !== start || old.etag !== checkpoint.etag || old.total !== checkpoint.total || old.mime !== checkpoint.mime : start !== 0) { await tx.done; return false; }
    let size = entries.reduce((sum, entry) => sum + entry.value.offset, 0) - (old?.offset ?? 0) + checkpoint.offset;
    let count = entries.length + (old ? 0 : 1);
    for (const entry of entries) {
      if (size <= maxCacheBytes && count <= DOWNLOAD_CACHE_COUNT) break;
      if (entry.id === id) continue;
      await this.remove(tx, entry.id); size -= entry.value.offset; count--;
    }
    await tx.objectStore("downloadChunks").put({ attachmentId: id, revision: checkpoint.revision, index: start / CHUNK_BYTES, bytes });
    await meta.put({ ...checkpoint, scope: this.scope }, id); await tx.done; return true;
  }
  async discard(id: string, revision: string): Promise<void> {
    const tx = await this.open();
    if ((await tx.objectStore("downloadMeta").get(id))?.revision === revision) await this.remove(tx, id);
    await tx.done;
  }
}
