import { DownloadBuffer, TemporaryDownloadError, type AttachmentSource } from "./download-buffer.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { CHUNK_BYTES } from "../../src/client-protocol/index.js";
import { HubHttpError, transientUploadError } from "./http-error.js";
import { t } from "./i18n.js";
import { validDownloadCheckpoint, type DownloadCheckpointStore } from "./download-checkpoints.js";

export type DownloadOptions = { signal?: AbortSignal; progress?: (fraction: number) => void; recovering?: (value: boolean) => void };
// Scratch assembly and resume bytes share an origin. Leave room for a complete
// default-size file instead of holding two 512 MiB copies in private browsers.
const FILE_PREFIX_BYTES = 256 * 1024 ** 2;
export type DownloadConnection = {
  readonly isClosed: boolean;
  state: { status: string; error?: string };
  subscribe(listener: () => void): () => void;
  resume(force?: boolean): void;
  beginFileTransfer(): () => void;
  readonly downloadCheckpoints?: DownloadCheckpointStore;
  readAttachment<T>(id: string, headers: Record<string, string>, consume: (response: Response) => Promise<T>, signal?: AbortSignal): Promise<T>;
};
function check(connection: DownloadConnection, signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error(t("下载已取消。"));
  if (connection.isClosed) throw new Error(connection.state.error ?? t("连接已关闭，下载已停止。"));
}
function online(connection: DownloadConnection, deadline: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => { clearTimeout(timer); unsubscribe(); signal?.removeEventListener("abort", changed); if (error) reject(error); else resolve(); };
    const changed = () => { try { check(connection, signal); if (connection.state.status === "online") finish(); } catch (error) { finish(error); } };
    const timer = setTimeout(() => finish(new Error(t("连接恢复超时，请重试下载。"))), Math.max(0, deadline - Date.now()));
    const unsubscribe = connection.subscribe(changed); signal?.addEventListener("abort", changed, { once: true }); changed();
  });
}
function delay(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => { const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }; const timer = setTimeout(done, 500); signal?.addEventListener("abort", done, { once: true }); if (signal?.aborted) done(); });
}
/** Complete chunks can survive page/app restarts in a pairing-scoped journal.
 * They remain untrusted until a fresh authorized range and whole-file SHA pass. */
export async function downloadAttachment(connection: DownloadConnection, id: string, options: DownloadOptions = {}): Promise<Blob> {
  const source = await assembleAttachment(connection, id, options, false);
  try { return source.blob; } finally { await source.dispose(); }
}
/** File-card consumers explicitly release disk-backed bytes after preview/save. */
export function downloadAttachmentSource(connection: DownloadConnection, id: string, options: DownloadOptions = {}, preferDisk = true): Promise<AttachmentSource> {
  return assembleAttachment(connection, id, options, preferDisk);
}
async function assembleAttachment(connection: DownloadConnection, id: string, options: DownloadOptions, preferDisk: boolean): Promise<AttachmentSource> {
  const release = connection.beginFileTransfer(), buffer = new DownloadBuffer(preferDisk), store = connection.downloadCheckpoints;
  let hash = sha256.create(), revision: string = crypto.randomUUID(), persist = !!store;
  let offset = 0, total: number | undefined, etag: string | undefined, mime = "", failedSince: number | undefined;
  const discard = () => store?.discard(id, revision).catch(() => undefined);
  try {
    check(connection, options.signal);
    // Do not load hundreds of MiB merely to wait offline. Online here means the
    // authenticated Hub handshake completed; each range still authorizes again.
    if (connection.state.status !== "online") options.recovering?.(true);
    await online(connection, Date.now() + 300_000, options.signal);
    options.recovering?.(false);
    try {
      const saved = await store?.load(id, preferDisk ? FILE_PREFIX_BYTES : undefined);
      if (saved) {
        revision = saved.revision;
        if (!validDownloadCheckpoint(saved)) throw new Error("invalid_download_checkpoint");
        for (let index = 0; index < saved.offset / CHUNK_BYTES; index++) {
          check(connection, options.signal);
          const bytes = await store!.read(id, revision, index);
          if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== CHUNK_BYTES) throw new Error("incomplete_download_checkpoint");
          hash.update(new Uint8Array(bytes)); await buffer.append(new Blob([bytes]));
        }
        offset = saved.offset; total = saved.total; etag = saved.etag; mime = saved.mime;
        options.progress?.(offset / total);
      }
    } catch (error) {
      check(connection, options.signal);
      if (error instanceof TemporaryDownloadError) throw error;
      await discard(); await buffer.reset(); hash = sha256.create(); revision = crypto.randomUUID();
      offset = 0; total = undefined; etag = undefined; mime = "";
    }
    for (;;) {
      check(connection, options.signal);
      if (connection.state.status !== "online") options.recovering?.(true);
      await online(connection, (failedSince ?? Date.now()) + 300_000, options.signal);
      try {
        const end = Math.min(offset + CHUNK_BYTES, total ?? Infinity) - 1;
        const chunk = await connection.readAttachment(id, { Range: `bytes=${offset}-${end}`, ...(etag ? { "If-Range": etag } : {}) }, async (response) => {
          if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new HubHttpError(response.status, body.error ?? t("附件下载失败")); }
          const nextTag = response.headers.get("ETag") ?? undefined;
          const nextMime = response.headers.get("Content-Type") ?? "application/octet-stream";
          let length: number | undefined, size: number | undefined;
          if (response.status === 206) {
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") ?? "");
            if (!range || !/^"[a-f0-9]{64}"$/.test(nextTag ?? "")) throw new Error(t("附件下载校验失败，请重试。"));
            const start = Number(range[1]), last = Number(range[2]); size = Number(range[3]);
            if (![start, last, size].every(Number.isSafeInteger) || start !== offset || size <= last || last !== Math.min(end, size - 1)) throw new Error(t("附件下载校验失败，请重试。"));
            length = last - start + 1;
          } else {
            // Old Hubs can ignore Range. Preserve their one-shot download only
            // at offset zero; never append an entire entity to partial bytes.
            if (response.status !== 200 || offset) throw new Error(t("附件已变化，请重新下载。"));
            if (nextTag !== undefined && !/^"[a-f0-9]{64}"$/.test(nextTag)) throw new Error(t("附件下载校验失败，请重试。"));
            const advertised = response.headers.get("Content-Length");
            if (advertised !== null) size = length = Number(advertised);
          }
          if (length !== undefined && (!Number.isSafeInteger(length) || length <= 0) || total !== undefined && (size !== total || nextTag !== etag || nextMime !== mime)) throw new Error(t("附件已变化，请重新下载。"));
          const reader = response.body?.getReader(); if (!reader) throw new Error(t("附件下载失败"));
          const data: Uint8Array<ArrayBuffer>[] = []; let received = 0;
          // A legacy 200 body may be the entire file. Stream it into the same
          // buffer instead of accumulating an unbounded response array.
          const whole = response.status === 200, wholeHash = whole ? hash.clone() : undefined;
          try {
            for (;;) {
              const next = await reader.read(); if (next.done) break;
              received += next.value.byteLength;
              if (!Number.isSafeInteger(received) || length !== undefined && received > length) throw new Error(t("附件下载校验失败，请重试。"));
              check(connection, options.signal);
              if (whole) { wholeHash!.update(next.value); await buffer.append(new Blob([next.value])); }
              else data.push(next.value);
            }
            if (length !== undefined && received !== length) throw new TypeError("attachment_incomplete");
            if (!received) throw new Error(t("附件下载校验失败，请重试。"));
          } catch (error) { if (whole) await buffer.reset(); throw error; }
          finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
          return { data, length: received, size: size ?? received, nextTag, nextMime, wholeHash };
        }, options.signal);
        check(connection, options.signal);
        total = chunk.size; etag = chunk.nextTag; mime = chunk.nextMime;
        if (chunk.wholeHash) hash = chunk.wholeHash;
        else for (const bytes of chunk.data) hash.update(bytes);
        const part = new Blob(chunk.data), start = offset;
        if (!chunk.wholeHash) await buffer.append(part);
        offset += chunk.length; failedSince = undefined;
        // Never persist the final chunk: a resumed transfer must ask the Hub for
        // current authorization/validators before any partial bytes can escape.
        // Quota/eviction failures only disable journaling, not the verified read.
        if (preferDisk && offset > FILE_PREFIX_BYTES) persist = false;
        if (persist && offset < total && etag) {
          persist = await store!.append(id, { revision, etag, total, mime, offset, updatedAt: Date.now() }, start, await part.arrayBuffer(), preferDisk ? FILE_PREFIX_BYTES : undefined).catch(async (error: unknown) => {
            // An unexpectedly exhausted origin must not keep a large prefix at
            // the expense of message persistence. Continue with the download buffer.
            if (error instanceof Error && error.name === "QuotaExceededError") await discard();
            return false;
          });
          check(connection, options.signal);
        }
        options.recovering?.(false); options.progress?.(offset / total);
        if (offset === total) {
          if (etag && /^"[a-f0-9]{64}"$/.test(etag) && bytesToHex(hash.digest()) !== etag.slice(1, -1)) throw new Error(t("附件下载校验失败，请重试。"));
          check(connection, options.signal);
          const source = await buffer.finish(mime);
          try { await discard(); check(connection, options.signal); return source; } catch (error) { await source.dispose(); throw error; }
        }
      } catch (error) {
        check(connection, options.signal);
        // A disk failure is not a bad remote file. Preserve the committed
        // resume prefix, clean the scratch file and let the user free space.
        if (error instanceof TemporaryDownloadError) throw error;
        if (!transientUploadError(error) && !(error instanceof HubHttpError && error.status === 401 && error.code === "session_expired")) { await discard(); throw error; }
        failedSince ??= Date.now(); if (Date.now() - failedSince >= 300_000) throw new Error(t("连接恢复超时，请重试下载。"));
        options.recovering?.(true);
        if (error instanceof HubHttpError && error.status === 401) connection.resume(true);
        await delay(options.signal);
      }
    }
  } finally { await buffer.reset(); options.recovering?.(false); release(); }
}
