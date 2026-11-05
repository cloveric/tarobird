import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { withFileMutex } from "../state/file-mutex.js";

const MAX_BYTES = 1024 * 1024, TTL = 24 * 60 * 60 * 1000, MAX_ENTRIES = 128;
const lastPruned = new Map<string, number>();
let unavailableWarned = false;

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077))) throw new Error("media_transcript_cache_unavailable");
}

async function read(file: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES || process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077))) return;
    const bytes = Buffer.alloc(MAX_BYTES + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_BYTES) return;
    const value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    if (value?.version === 1 && Number.isFinite(value.at) && value.at <= Date.now() && value.at > Date.now() - TTL && typeof value.text === "string" && value.text.trim()) return value.text;
  } catch { /* Missing, damaged or unsafe cache entries never supply a transcript. */ }
  finally { await handle?.close(); }
}

async function prune(directory: string): Promise<void> {
  const now = Date.now();
  if (now - (lastPruned.get(directory) ?? 0) < 60_000) return;
  if (lastPruned.size > 32) lastPruned.clear();
  lastPruned.set(directory, now);
  const files = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  const entries = await Promise.all(files.map(async name => ({ file: path.join(directory, name), info: await stat(path.join(directory, name)).catch(() => undefined) })));
  const sorted = entries.filter(entry => entry.info).sort((a, b) => b.info!.mtimeMs - a.info!.mtimeMs);
  await Promise.all(sorted.filter((entry, i) => i >= MAX_ENTRIES - 1 || entry.info!.mtimeMs < now - TTL).map(entry => rm(entry.file, { force: true })));
}

/** Reuse only an already-authorized attachment in this Host/conversation.
 * The file mutex works across Bot Worker processes, and never steals a live
 * owner. Cancelling a waiter cannot stop the owner; cancelling the owner frees
 * the slot so another still-active Bot may retry. Failed/partial/empty results
 * are never cached. Private results expire after one day; pruning retains 128.
 */
export async function reuseMediaTranscript(input: {
  hostDir: string; conversationId: string; attachmentId: string; file: string;
  policy: unknown; signal?: AbortSignal; waitTimeoutMs?: number;
}, work: () => Promise<string>): Promise<string> {
  input.signal?.throwIfAborted();
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(input.file, { signal: input.signal })) digest.update(bytes);
  const key = createHash("sha256").update(JSON.stringify([1, input.conversationId, input.attachmentId, digest.digest("hex"), input.policy])).digest("hex");
  const directory = path.join(input.hostDir, "media-transcripts"), file = path.join(directory, `${key}.json`);
  try { await privateDirectory(directory); }
  catch {
    // The cache adds no authority: this recording was already authorized and
    // downloaded. Refuse the unsafe cache, but preserve the original ASR path.
    // Do not apply this fallback to lock timeouts or failed transcription work.
    input.signal?.throwIfAborted();
    if (!unavailableWarned) { unavailableWarned = true; console.warn("ASR reuse unavailable; transcribing without cache"); }
    return work();
  }
  await prune(directory).catch(() => undefined);
  return withFileMutex(file, async () => {
    input.signal?.throwIfAborted();
    const previous = await read(file);
    input.signal?.throwIfAborted();
    if (previous !== undefined) return previous;
    const text = await work();
    input.signal?.throwIfAborted();
    const bytes = JSON.stringify({ version: 1, at: Date.now(), text });
    if (text.trim() && Buffer.byteLength(bytes) <= MAX_BYTES) {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 }); await rename(temporary, file); }
      catch { /* Cache persistence cannot turn a completed transcription into failure. */ }
      finally { await rm(temporary, { force: true }).catch(() => undefined); }
    }
    return text;
  }, { signal: input.signal, waitTimeoutMs: input.waitTimeoutMs ?? 20 * 60_000 });
}
