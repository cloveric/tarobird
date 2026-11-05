import { t } from "./i18n.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { CHUNK_BYTES, MAX_FILE_BYTES } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";
import { HubHttpError, transientUploadError } from "./http-error.js";

export type UploadSource = Pick<File, "name" | "size" | "type"> & { readChunk(start: number, end: number): Promise<Blob> };
type UploadConnection = Pick<HubConnection, "state" | "subscribe" | "http" | "resume" | "isClosed" | "beginFileTransfer">;
export type UploadOptions = { signal?: AbortSignal; recovering?: (value: boolean) => void };
export function formatFileLimit(bytes: number): string {
  const unit = bytes >= 1024 ** 3 ? 3 : bytes >= 1024 ** 2 ? 2 : bytes >= 1024 ? 1 : 0;
  return `${Number((bytes / 1024 ** unit).toFixed(2))} ${["B", "KiB", "MiB", "GiB"][unit]}`;
}
function checkFileSize(connection: UploadConnection, file: Pick<File, "name" | "size">): void {
  const maximum = connection.state.maxFileBytes ?? MAX_FILE_BYTES;
  if (file.size > maximum) throw new Error(t("{0} 超过单个附件上限 {1}，请选择较小文件或调整 Hub 设置。", file.name, formatFileLimit(maximum)));
}
function checkUpload(connection: UploadConnection, signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error(t("上传已取消，已完成的分块会保留。"));
  if (connection.isClosed) throw new Error(connection.state.error ?? t("连接已关闭，上传已停止。"));
}
function waitOnline(connection: UploadConnection, deadline: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => { clearTimeout(timer); unsubscribe(); signal?.removeEventListener("abort", check); if (error) reject(error); else resolve(); };
    const check = () => { try { checkUpload(connection, signal); if (connection.state.status === "online") finish(); } catch (error) { finish(error); } };
    const timer = setTimeout(() => finish(new Error(t("连接恢复超时，请重试上传。"))), Math.max(0, deadline - Date.now()));
    const unsubscribe = connection.subscribe(check); signal?.addEventListener("abort", check, { once: true }); check();
  });
}
function backoff(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => { const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }; const timer = setTimeout(done, 500); signal?.addEventListener("abort", done, { once: true }); if (signal?.aborted) done(); });
}
export async function uploadFile(connection: UploadConnection, conversationId: string, file: File | UploadSource, progress: (fraction: number) => void, options: UploadOptions = {}): Promise<string> {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error(t("文件不能为空，且大小必须有效。"));
  const release = connection.beginFileTransfer();
  try {
    // Wait for the authenticated Hub policy before hashing potentially large
    // files. A reconnect can change the policy while retaining chunk receipts.
    checkUpload(connection, options.signal);
    if (connection.state.status !== "online") options.recovering?.(true);
    await waitOnline(connection, Date.now() + 300_000, options.signal);
    options.recovering?.(false); checkFileSize(connection, file);
    const read = async (start: number, end: number) => {
      try { return "readChunk" in file ? await file.readChunk(start, Math.min(file.size, end)) : file.slice(start, end); }
      catch (cause) { throw new Error(t("文件读取失败，请重新选择文件。"), { cause }); }
    };
    const hash = sha256.create();
    for (let start = 0; start < file.size; start += CHUNK_BYTES) { checkUpload(connection, options.signal); hash.update(new Uint8Array(await (await read(start, start + CHUNK_BYTES)).arrayBuffer())); }
    const metadata = JSON.stringify({ conversationId, name: file.name, mime: file.type.split(";")[0] || "application/octet-stream", size: file.size, sha256: bytesToHex(hash.digest()) });
    let id: string | undefined, failedSince: number | undefined, confirmed = 0;
    for (;;) {
      checkUpload(connection, options.signal);
      if (connection.state.status !== "online") options.recovering?.(true);
      await waitOnline(connection, (failedSince ?? Date.now()) + 300_000, options.signal);
      checkFileSize(connection, file);
      try {
        id ??= (await connection.http<{ id: string }>("/api/uploads", { method: "POST", body: metadata, signal: options.signal })).id;
        const state = await connection.http<{ complete: boolean; chunks: number[] }>(`/api/uploads/${id}`, { signal: options.signal });
        options.recovering?.(false);
        if (state.complete) { progress(1); return id; }
        // Always reconcile receipts after a failed request. The server may have
        // durably accepted a chunk even though its response was lost.
        for (let start = 0; start < file.size; start += CHUNK_BYTES) {
          checkUpload(connection, options.signal);
          if (!state.chunks.includes(start / CHUNK_BYTES)) await connection.http(`/api/uploads/${id}/${start / CHUNK_BYTES}`, { method: "PUT", body: await read(start, start + CHUNK_BYTES), signal: options.signal });
          const next = Math.min(file.size, start + CHUNK_BYTES); if (next > confirmed) { confirmed = next; failedSince = undefined; }
          progress(confirmed / file.size);
        }
        await connection.http(`/api/uploads/${id}/complete`, { method: "POST", signal: options.signal }); return id;
      } catch (error) {
        checkUpload(connection, options.signal);
        if (!transientUploadError(error)) throw error;
        failedSince ??= Date.now(); if (Date.now() - failedSince >= 300_000) throw new Error(t("连接恢复超时，请重试上传。"));
        options.recovering?.(true);
        if (error instanceof HubHttpError && error.status === 401) connection.resume(true);
        await backoff(options.signal);
      }
    }
  } finally { options.recovering?.(false); release(); }
}
