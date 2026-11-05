import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { STATE_DIR_MODE, STATE_FILE_MODE } from "./state-permissions.js";

export const DeliveryBodyRefSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive().safe(),
}).strict();
export type DeliveryBodyRef = z.infer<typeof DeliveryBodyRefSchema>;
const DIRECTORY = "delivery-bodies";

async function directory(stateDir: string, create = false): Promise<string> {
  const root = path.join(stateDir, DIRECTORY);
  if (create) await mkdir(root, { recursive: true, mode: STATE_DIR_MODE });
  if (!(await lstat(root)).isDirectory()) throw new Error("delivery_body_directory_invalid");
  if (create) await chmod(root, STATE_DIR_MODE);
  return root;
}

/** Caller holds the obligation ledger mutex until the reference is committed. */
export async function writeDeliveryBody(stateDir: string, content: string): Promise<DeliveryBodyRef> {
  const root = await directory(stateDir, true);
  // JSON preserves the exact JS string, including any unpaired surrogate. The
  // digest and size describe these stored bytes, not an estimated character count.
  const data = Buffer.from(JSON.stringify(content), "utf8");
  const ref = { sha256: createHash("sha256").update(data).digest("hex"), bytes: data.byteLength };
  const target = path.join(root, `${ref.sha256}.json`), temporary = path.join(root, `${ref.sha256}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", STATE_FILE_MODE);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target);
    // A process crash after the ledger commit must not leave a partial body.
    // Directory fsync is not supported by every platform; rename is still atomic.
    const dirHandle = await open(root, "r").catch(() => null);
    if (dirHandle) { try { await dirHandle.sync().catch(() => undefined); } finally { await dirHandle.close(); } }
    return ref;
  } finally { await unlink(temporary).catch(() => undefined); }
}

export async function readDeliveryBody(stateDir: string, rawRef: unknown): Promise<string> {
  const parsed = DeliveryBodyRefSchema.safeParse(rawRef);
  if (!parsed.success) throw new Error("delivery_body_reference_invalid");
  const ref = parsed.data, root = await directory(stateDir);
  const handle = await open(path.join(root, `${ref.sha256}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== ref.bytes) throw new Error("delivery_body_size_mismatch");
    const hash = createHash("sha256"), decoder = new TextDecoder("utf-8", { fatal: true }), parts: string[] = [];
    const buffer = Buffer.alloc(64 * 1024); let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      if (offset > ref.bytes) throw new Error("delivery_body_size_mismatch");
      const bytes = buffer.subarray(0, bytesRead); hash.update(bytes); parts.push(decoder.decode(bytes, { stream: true }));
    }
    if (offset !== ref.bytes || hash.digest("hex") !== ref.sha256) throw new Error("delivery_body_checksum_mismatch");
    parts.push(decoder.decode());
    const content: unknown = JSON.parse(parts.join(""));
    if (typeof content !== "string") throw new Error("delivery_body_content_invalid");
    return content;
  } finally { await handle.close(); }
}

/** Called under the ledger mutex only after its new index has been saved.
 * Young orphans survive a grace period so an interrupted write is recoverable
 * for inspection. Never follow links or touch files outside this owned directory. */
export async function pruneDeliveryBodies(stateDir: string, referenced: Set<string>, cutoff: number): Promise<void> {
  try {
    const root = await directory(stateDir);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9]{64}(?:\.json|\.[a-f0-9-]{36}\.tmp)$/.test(entry.name)) continue;
      if (referenced.has(entry.name.slice(0, 64))) continue;
      const file = path.join(root, entry.name), stat = await lstat(file);
      if (stat.isFile() && stat.mtimeMs < cutoff) await unlink(file);
    }
  } catch { /* A cleanup failure never changes the recorded send obligation. */ }
}
