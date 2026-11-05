import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { EngineSideAttachment } from "../codex/adapter.js";
import type { SideAttachmentRef } from "../client-protocol/side.js";
import { detectImageMediaType } from "../runtime/image-media.js";
import { SideSessionError } from "./side-sessions.js";

/** Characters of attachment text inlined into one side question. */
export const SIDE_INLINE_TEXT_LIMIT = 100_000;
const TEXT_PROBE_BYTES = SIDE_INLINE_TEXT_LIMIT * 4 + 4;
const SIDE_DIRECTORY = /^side_[A-Za-z0-9]+$/;
const NAME_CHARS = 120, NAME_BYTES = 180;

/** Keeps the tail (extension) on whole code points. A split surrogate pair makes
 * Codex drop the whole JSON-RPC request, and many filesystems cap a name at 255
 * UTF-8 bytes; the byte bound leaves room for the index prefix and `.part`. */
const fileName = (index: number, name: string) => {
  const chars = Array.from(name.replace(/[\\/:\x00-\x1f\x7f]+/g, "_"));
  let start = chars.length, bytes = 0;
  while (start > 0 && chars.length - start < NAME_CHARS && bytes + Buffer.byteLength(chars[start - 1]!) <= NAME_BYTES) bytes += Buffer.byteLength(chars[--start]!);
  const leaf = chars.slice(start).join("");
  return `${index + 1}-${/^\.*$/.test(leaf) ? "attachment" : leaf}`;
};

/** UTF-8 text without NUL bytes; a prefix may end inside a character. */
function decodeText(bytes: Uint8Array, prefix: boolean): string | undefined {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: prefix }); }
  catch { return undefined; }
  if (text.includes("\u0000")) return undefined;
  const control = text.match(/[\x01-\x08\x0e-\x1a\x1c-\x1f]/g)?.length ?? 0;
  return control > Math.max(8, text.length / 100) ? undefined : text;
}

/** A positional write may accept fewer bytes than requested; loop until done. */
export async function writeFully(handle: Pick<FileHandle, "write">, chunk: Uint8Array, position: number): Promise<void> {
  for (let offset = 0; offset < chunk.byteLength;) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, position + offset);
    if (!(bytesWritten > 0)) throw new Error("short_write");
    offset += bytesWritten;
  }
}

async function fileDigest(file: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(file)) { size += (chunk as Buffer).length; hash.update(chunk as Buffer); }
  return { size, sha256: hash.digest("hex") };
}

async function readPrefix(file: string, length: number): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    let size = 0;
    while (size < length) { const { bytesRead } = await handle.read(buffer, size, length - size, size); if (!bytesRead) break; size += bytesRead; }
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}

/** Writes host-verified private copies of Hub-authorized uploads. The caller
 * supplies the download; IDs, sizes and hashes come only from the Hub. */
export async function materializeSideAttachments(input: {
  directory: string;
  refs: SideAttachmentRef[];
  download(id: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
  signal: AbortSignal;
}): Promise<EngineSideAttachment[]> {
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const files: EngineSideAttachment[] = [];
  let budget = SIDE_INLINE_TEXT_LIMIT;
  for (const [index, ref] of input.refs.entries()) {
    input.signal.throwIfAborted();
    const file = path.join(input.directory, fileName(index, ref.name)), temporary = `${file}.part`;
    const hash = createHash("sha256");
    let size = 0;
    const handle = await open(temporary, "w", 0o600);
    try {
      for await (const chunk of await input.download(ref.id, input.signal)) {
        if (size + chunk.byteLength > ref.size) throw new SideSessionError("attachment_unavailable");
        hash.update(chunk); await writeFully(handle, chunk, size);
        size += chunk.byteLength;
      }
    } catch (error) {
      await handle.close(); await rm(temporary, { force: true });
      input.signal.throwIfAborted();
      throw error instanceof SideSessionError ? error : new SideSessionError("attachment_unavailable");
    }
    await handle.close();
    // Verify both the received stream and the bytes the engine will read.
    const written = size === ref.size && hash.digest("hex") === ref.sha256 ? await fileDigest(temporary) : undefined;
    if (!written || written.size !== ref.size || written.sha256 !== ref.sha256) { await rm(temporary, { force: true }); throw new SideSessionError("attachment_unavailable"); }
    await rename(temporary, file);
    const head = await readPrefix(file, Math.min(size, TEXT_PROBE_BYTES));
    const base = { attachmentId: ref.id, path: file, name: ref.name, size };
    // Content decides the delivery; a declared MIME type is only a hint.
    const image = detectImageMediaType(head.subarray(0, 12));
    if (image) { files.push({ ...base, mime: image, kind: "image" }); continue; }
    const decoded = decodeText(head, head.length < size);
    if (decoded === undefined) { files.push({ ...base, mime: ref.mime, kind: "binary" }); continue; }
    const text = decoded.slice(0, budget);
    budget -= text.length;
    files.push({ ...base, mime: ref.mime, kind: "text", text, ...(text.length < decoded.length || head.length < size ? { partial: true } : {}) });
  }
  return files;
}

/** Removes one handle's copies, or one request's. Never touches Hub attachment storage. */
export async function releaseSideAttachments(root: string, sideId: string, requestId?: string): Promise<void> {
  if (!SIDE_DIRECTORY.test(sideId) || requestId !== undefined && !/^[A-Za-z0-9_-]+$/.test(requestId)) return;
  await rm(path.join(root, sideId, ...(requestId === undefined ? [] : [requestId])), { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
}

/** A worker restart loses every handle; copies older than the hard handle
 * lifetime can no longer belong to a live side conversation. */
export async function sweepSideAttachments(root: string, olderThanMs: number, now = Date.now()): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !SIDE_DIRECTORY.test(entry.name)) continue;
    const info = await stat(path.join(root, entry.name)).catch(() => undefined);
    if (info && info.mtimeMs < now - olderThanMs) await releaseSideAttachments(root, entry.name).catch(() => undefined);
  }
}
