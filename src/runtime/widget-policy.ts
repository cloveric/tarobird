import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

export const widgetPolicyFile = (hostDir: string) => path.join(hostDir, "widget-settings.json");
export const hostWidgetPolicySchema = z.object({
  format: z.literal(1), revision: z.string(), enabled: z.boolean(),
  receipts: z.array(z.object({ requestId: z.string(), digest: z.string(), revision: z.string() })).max(32),
}).strict();
export type HostWidgetPolicy = z.infer<typeof hostWidgetPolicySchema>;
export class WidgetPolicyReadError extends Error {
  constructor(readonly recoveryRevision?: string) { super("widget_settings_unavailable"); }
}
/** Tiny bounded host policy, read at turn/call boundaries. Never poll or cache a
 * stale enable decision across processes. Missing preserves the existing default. */
export function readHostWidgetPolicy(hostDir: string): HostWidgetPolicy | undefined {
  let fd: number, expected;
  try {
    const file = widgetPolicyFile(hostDir); expected = lstatSync(file);
    if (!expected.isFile() || expected.isSymbolicLink()) throw new WidgetPolicyReadError();
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new WidgetPolicyReadError(); }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.ino !== expected.ino || info.dev !== expected.dev || info.size > 32768) throw new WidgetPolicyReadError();
    if (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077))) throw new WidgetPolicyReadError();
    const bytes = Buffer.alloc(32769), length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > 32768) throw new WidgetPolicyReadError();
    const content = bytes.subarray(0, length);
    try {
      const raw = JSON.parse(content.toString("utf8"));
      // Never overwrite a newer or unknown policy format through this client.
      if (raw?.format !== undefined && raw.format !== 1) throw new WidgetPolicyReadError();
      return hostWidgetPolicySchema.parse(raw);
    } catch (error) {
      if (error instanceof WidgetPolicyReadError) throw error;
      throw new WidgetPolicyReadError(`damaged-${createHash("sha256").update(content).digest("hex")}`);
    }
  } catch (error) { throw error instanceof WidgetPolicyReadError ? error : new WidgetPolicyReadError(); }
  finally { closeSync(fd); }
}
export function widgetsEnabled(hostDir = process.env.TAROBOT_HOST_DIR): boolean {
  if (!hostDir) return true;
  try { return readHostWidgetPolicy(hostDir)?.enabled ?? true; }
  catch { return false; }
}
