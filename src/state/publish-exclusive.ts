import { randomUUID } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import path from "node:path";

/** Publish complete private bytes atomically, refusing to replace an existing
 * destination. A failed write only leaves a removable private temporary file. */
export async function publishExclusive(file: string, bytes: string): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes, "utf8"); await handle.sync(); await handle.close(); handle = undefined;
    await link(temporary, file);
  } finally {
    try { await handle?.close(); }
    finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
}
