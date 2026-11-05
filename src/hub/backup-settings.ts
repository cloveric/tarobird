import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { backupDaysSchema, backupSettingsUpdateSchema, DEFAULT_BACKUP_DAYS, type BackupSettingsUpdate } from "../client-protocol/backup-settings.js";
import type { HubDatabase } from "./database.js";
import { HubError, type HubStore } from "./store.js";
import { withFileMutex } from "../state/file-mutex.js";

const KEY = "automatic-backup-policy:v1";
const policySchema = z.object({ format: z.literal(1), revision: z.string(), retentionDays: backupDaysSchema,
  receipts: z.array(z.object({ requestId: z.string(), revision: z.string(), digest: z.string() })).max(32) }).strict();

/** Called inside the caller's database serialization/transaction. A malformed
 * stored policy must never silently become permission to prune backups. */
export async function readBackupPolicy(db: HubDatabase) {
  const row = await db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [KEY]);
  if (!row) return { format: 1 as const, revision: "default", retentionDays: DEFAULT_BACKUP_DAYS, receipts: [] };
  try { return policySchema.parse(JSON.parse(row.value)); }
  catch { throw new HubError("backup_settings_unavailable", 503); }
}
export async function readBackupSettings(db: HubDatabase, requestId?: string) {
  const policy = await readBackupPolicy(db), receipt = requestId ? policy.receipts.find(r => r.requestId === requestId) : policy.receipts.at(-1);
  return { revision: policy.revision, retentionDays: policy.retentionDays, receipt: receipt ? { requestId: receipt.requestId, revision: receipt.revision } : null };
}
export async function updateBackupSettings(store: HubStore, directory: string, raw: BackupSettingsUpdate, actor: string, validate: () => Promise<void>) {
  const command = backupSettingsUpdateSchema.parse(raw), digest = createHash("sha256").update(JSON.stringify(command)).digest("hex");
  return withFileMutex(path.join(directory, "daily-backup"), () => store.db.transaction(async () => {
    await validate();
    const before = await readBackupPolicy(store.db), receipt = before.receipts.find(r => r.requestId === command.requestId);
    if (receipt) {
      if (receipt.digest !== digest) throw new HubError("backup_request_conflict", 409);
      return readBackupSettings(store.db, command.requestId);
    }
    if (before.revision !== command.revision) throw new HubError("backup_revision_conflict", 409);
    const revision = randomUUID();
    const next = { format: 1, revision, retentionDays: command.retentionDays,
      receipts: [...before.receipts, { requestId: command.requestId, revision, digest }].slice(-32) };
    await store.db.run("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", [KEY, JSON.stringify(next)]);
    await store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), actor, "backups.settings-updated", JSON.stringify(command)]);
    return readBackupSettings(store.db, command.requestId);
  }));
}

/** Exact valid UTC calendar dates only. Manual files, legacy names and links
 * are never part of automatic retention, even when the policy is zero. */
export function automaticBackupDay(name: string): string | undefined {
  const match = /^auto-(\d{4}-\d{2}-\d{2})\.sqlite$/.exec(name);
  if (!match) return;
  const timestamp = Date.parse(`${match[1]}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === match[1] ? match[1] : undefined;
}
export async function automaticSnapshots(directory: string) {
  const root = path.join(directory, "backups");
  const info = await lstat(root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return; throw error; });
  if (!info) return [];
  if (!info.isDirectory()) throw new HubError("backup_directory_invalid", 503);
  const result: Array<{ name: string; day: string; bytes: number }> = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const day = automaticBackupDay(entry.name);
    if (!entry.isFile() || !day) continue;
    const stat = await lstat(path.join(root, entry.name)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return; throw error; });
    if (stat?.isFile()) result.push({ name: entry.name, day, bytes: stat.size });
  }
  return result.sort((a, b) => b.day.localeCompare(a.day));
}
export async function automaticBackupSummary(directory: string) {
  const snapshots = await automaticSnapshots(directory);
  return { count: snapshots.length, bytes: snapshots.reduce((sum, item) => sum + item.bytes, 0), latestDay: snapshots[0]?.day ?? null };
}
