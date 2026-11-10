import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { leasedSource, type AttachmentSource } from "./download-buffer.js";

/** Downloaded files above the IndexedDB attachment cache's 16 MiB ceiling
 * (videos, mostly) stay on disk in the origin-private file system, so opening
 * them again does not download them again. Bounded by a least-recently-used
 * budget; an entry being previewed, saved or streamed is never evicted. */
const ROOT = "tarocub-attachment-cache-v1";
export const DISK_CACHE_MIN_BYTES = 16 * 1024 ** 2;
export const DISK_CACHE_BUDGET_BYTES = 500 * 1024 ** 2;
const lockName = (key: string) => `${ROOT}:${key}`;
const validKey = (name: string) => /^[0-9a-f]{64}$/.test(name);
type Meta = { size: number; type: string; accessed: number };

/** Isolated by the paired Hub, this device and the attachment. */
export function diskCacheKey(identity: { hubPublicKey?: string; deviceId?: string }, attachmentId: string): string | undefined {
  if (!identity.hubPublicKey || !identity.deviceId || !attachmentId) return;
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(["attachment-cache-v1", identity.hubPublicKey, identity.deviceId, attachmentId]))));
}

const supported = () => !!globalThis.navigator?.storage?.getDirectory && !!globalThis.navigator?.locks;
const cacheRoot = async (create: boolean) => (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create });

/** Written into an entry that was deleted while in use; it is never read again. */
const DELETED = "deleted";

async function readMeta(directory: FileSystemDirectoryHandle): Promise<Meta | undefined> {
  try {
    if (await directory.getFileHandle(DELETED).then(() => true, () => false)) return;
    const value: unknown = JSON.parse(await (await (await directory.getFileHandle("meta")).getFile()).text());
    const meta = value as Partial<Meta>;
    return typeof meta.size === "number" && typeof meta.type === "string" && typeof meta.accessed === "number" ? meta as Meta : undefined;
  } catch { return; }
}
async function writeMeta(directory: FileSystemDirectoryHandle, meta: Meta): Promise<void> {
  const writer = await (await directory.getFileHandle("meta", { create: true })).createWritable();
  await writer.write(JSON.stringify(meta)); await writer.close();
}
/** Hold a shared lock until the returned release runs. */
async function holdShared(name: string): Promise<() => void> {
  let release!: () => void, acquired!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { acquired = resolve; });
  const locking = navigator.locks.request(name, { mode: "shared" }, async () => { acquired(); await held; });
  await Promise.race([ready, locking]);
  return release;
}

/** A cached copy, or undefined. The source keeps a shared lock until every
 * lease is disposed, so eviction and clearing skip it while it is in use. */
export async function readCachedAttachment(key: string | undefined): Promise<AttachmentSource | undefined> {
  if (!key || !supported() || !validKey(key)) return;
  let release: (() => void) | undefined;
  try {
    const directory = await (await cacheRoot(false)).getDirectoryHandle(key);
    // Deleted while in use: its removal may be queued behind that lease.
    if (await directory.getFileHandle(DELETED).then(() => true, () => false)) return;
    release = await holdShared(lockName(key));
    const meta = await readMeta(directory); if (!meta) { release(); return; }
    const file = await (await directory.getFileHandle("data")).getFile();
    if (file.size !== meta.size) { release(); return; }
    await writeMeta(directory, { ...meta, accessed: Date.now() }).catch(() => undefined);
    const unlock = release; release = undefined;
    // No browserLock: the service worker only accepts temporary-download locks,
    // and the page keeps this lease until a browser save has streamed every byte.
    return leasedSource(file.slice(0, file.size, meta.type), "disk", async () => unlock());
  } catch { release?.(); return; }
}

/** Remove least-recently-used entries until `incoming` more bytes fit. Entries
 * in use (any lock held) and the one being written are skipped. */
async function makeRoom(root: FileSystemDirectoryHandle, incoming: number, keep: string, budget: number): Promise<boolean> {
  const entries: { key: string; size: number; accessed: number; complete: boolean }[] = [];
  for await (const [name, entry] of root.entries()) {
    if (entry.kind !== "directory" || !validKey(name) || name === keep) continue;
    const meta = await readMeta(entry as FileSystemDirectoryHandle);
    entries.push({ key: name, size: meta?.size ?? 0, accessed: meta?.accessed ?? 0, complete: !!meta });
  }
  let total = entries.reduce((sum, entry) => sum + entry.size, 0) + incoming;
  // Incomplete entries (a crashed writer) go first; then the oldest.
  for (const entry of entries.sort((a, b) => Number(a.complete) - Number(b.complete) || a.accessed - b.accessed)) {
    if (entry.complete && total <= budget) break;
    await navigator.locks.request(lockName(entry.key), { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      await root.removeEntry(entry.key, { recursive: true }).then(() => { total -= entry.size; }, () => undefined);
    });
  }
  return total <= budget;
}

/** Copy a finished download into the cache, disk to disk. Best effort: any
 * failure leaves no entry. Always disposes the lease it was given. `wanted` is
 * asked again under the entry's lock, before writing and before the entry is
 * marked complete: a copy whose attachment was deleted meanwhile never lands. */
export async function storeCachedAttachment(key: string | undefined, source: AttachmentSource, budget = DISK_CACHE_BUDGET_BYTES, wanted: () => boolean = () => true): Promise<void> {
  try {
    const blob = source.blob;
    if (!key || !supported() || !validKey(key) || blob.size <= DISK_CACHE_MIN_BYTES || blob.size > budget) return;
    await navigator.locks.request(lockName(key), async () => {
      if (!wanted()) return;
      const root = await cacheRoot(true);
      const existing = await root.getDirectoryHandle(key).catch(() => undefined);
      if (existing && (await readMeta(existing))?.size === blob.size) return;
      if (!await makeRoom(root, blob.size, key, budget)) return;
      const directory = await root.getDirectoryHandle(key, { create: true });
      try {
        await directory.removeEntry("meta").catch(() => undefined);
        const handle = await directory.getFileHandle("data", { create: true });
        if (typeof handle.createWritable !== "function") throw new DOMException("Unsupported storage", "NotSupportedError");
        await blob.stream().pipeTo(await handle.createWritable());
        if ((await handle.getFile()).size !== blob.size) throw new Error("attachment_cache_size_mismatch");
        if (!wanted()) throw new Error("attachment_cache_unwanted");
        // The meta file marks the entry complete; readers ignore it until then.
        await writeMeta(directory, { size: blob.size, type: blob.type, accessed: Date.now() });
      } catch (error) { await root.removeEntry(key, { recursive: true }).catch(() => undefined); throw error; }
    });
  } catch { /* Caching is optional; the download itself already succeeded. */ }
  finally { await source.dispose(); }
}

/** Remove these entries (the owner deleted the attachments on the Hub). One
 * still being previewed, saved or streamed is marked deleted at once, so no
 * later read returns it, and removed when its last lease ends; an eviction
 * pass removes it as incomplete if the page closes first. */
export async function forgetCachedAttachments(keys: readonly (string | undefined)[]): Promise<void> {
  if (!supported()) return;
  const root = await cacheRoot(false).catch(() => undefined);
  if (!root) return;
  for (const key of keys) {
    if (!key || !validKey(key)) continue;
    const removed = await navigator.locks.request(lockName(key), { ifAvailable: true }, async (lock) => {
      if (!lock) return false;
      await root.removeEntry(key, { recursive: true }).catch(() => undefined);
      return true;
    }).catch(() => false);
    if (removed) continue;
    // In use, or still being written (perhaps by another window): mark what is
    // there and remove the entry as soon as that lock is released.
    const directory = await root.getDirectoryHandle(key).catch(() => undefined);
    if (directory) await directory.getFileHandle(DELETED, { create: true }).catch(() => undefined);
    void navigator.locks.request(lockName(key), async () => { await root.removeEntry(key, { recursive: true }).catch(() => undefined); }).catch(() => undefined);
  }
}

/** Forget every cached file (identity change or revocation). If a copy is
 * still being written, the removal can fail; such entries are keyed to the old
 * identity, so no other identity can read them, and later stores evict them. */
export async function clearAttachmentDiskCache(): Promise<void> {
  if (!supported()) return;
  try { await (await navigator.storage.getDirectory()).removeEntry(ROOT, { recursive: true }); } catch { /* Missing or in use. */ }
}
