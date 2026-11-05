import { workbenchContextSchema, type WorkbenchContext, type WorkbenchContextOmitted } from "../client-protocol/workbench.js";
import type { HubDatabase } from "./database.js";
import { createHash } from "node:crypto";

export type WorkbenchContextReceipt = { digest: string; omitted?: WorkbenchContextOmitted };
export const workbenchContextDigest = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Read inside the caller's DB queue. Omission is source-message metadata, not
 * absence of a target, and must survive both push and queued dispatch. */
export async function readWorkbenchTurnMetadata(db: HubDatabase, messageId: string): Promise<{workbench?: WorkbenchContext; workbenchContextOmitted?: WorkbenchContextOmitted}> {
  const row = await db.get<{ context_json: string | null; workbench_receipt_json: string | null }>("SELECT x.value AS context_json,m.workbench_receipt_json FROM messages m LEFT JOIN meta x ON x.key='workbench-context:'||m.id WHERE m.id=?", [messageId]);
  const receipt = row?.workbench_receipt_json ? JSON.parse(row.workbench_receipt_json) as WorkbenchContextReceipt : undefined;
  if (receipt?.omitted === "history_limit") return { workbenchContextOmitted: receipt.omitted };
  return row?.context_json ? {workbench: workbenchContextSchema.parse(JSON.parse(row.context_json))} : {};
}

const budgetKey = "workbench-history-budget-v1";
const journalPrefix = "workbench-command:*", contextPrefix = "workbench-context:*";
const retentionMs = 24 * 60 * 60 * 1000;
const cleanupIntervalMs = 60 * 60 * 1000;
const journalReservationBytes = 4096;
export const WORKBENCH_HISTORY_LIMITS = { maxEntries: 20_000, maxBytes: 32 * 1024 * 1024 };
export type WorkbenchHistoryLimits = typeof WORKBENCH_HISTORY_LIMITS;
type Budget = { entries: number; bytes: number; cleanedAt: number };
const storedBytes = "length(CAST(key AS BLOB))+length(CAST(value AS BLOB))";
const chargedBytes = `CASE WHEN key GLOB '${journalPrefix}' THEN MAX(${journalReservationBytes},${storedBytes}) ELSE ${storedBytes} END`;

/** Called inside the caller's transaction. Ordinary commands touch one small
 * accounting row, without scanning historical messages or scene bodies. */
export async function reserveWorkbenchHistory(db: HubDatabase, key: string, value: string, limits: WorkbenchHistoryLimits = WORKBENCH_HISTORY_LIMITS, now = Date.now()): Promise<boolean> {
  const stored = await db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [budgetKey]);
  let budget: Budget | undefined;
  if (stored) {
    try {
      const candidate = JSON.parse(stored.value) as Budget;
      if ([candidate.entries, candidate.bytes, candidate.cleanedAt].every(value => Number.isSafeInteger(value) && value >= 0)) budget = candidate;
    } catch { /* Older backups without accounting are reconciled once. */ }
  }
  if (!budget) {
    const inventory = await db.get<{ entries: number; bytes: number }>(`SELECT COUNT(*) AS entries,COALESCE(SUM(${chargedBytes}),0) AS bytes FROM meta WHERE key GLOB ? OR key GLOB ?`, [journalPrefix, contextPrefix]);
    budget = { entries: inventory?.entries ?? 0, bytes: inventory?.bytes ?? 0, cleanedAt: 0 };
  }
  const bytes = key.startsWith("workbench-command:") ? Math.max(journalReservationBytes, Buffer.byteLength(key) + Buffer.byteLength(value)) : Buffer.byteLength(key) + Buffer.byteLength(value);
  const exceeds = () => budget!.entries + 1 > limits.maxEntries || budget!.bytes + bytes > limits.maxBytes;
  if (now - budget.cleanedAt >= cleanupIntervalMs || exceeds()) {
    // Completed contexts can retire after one day; message-local digests keep
    // lost-ACK retries idempotent without retaining the whole context forever.
    // Keep local-user mutation deduplication. Source-bound journals can retire
    // only after all dispatches accepted the source, or after it disappeared.
    // Failed/cancelled deliveries may still be retried and must be retained.
    const predicate = `(key GLOB '${contextPrefix}' AND (
      NOT EXISTS(SELECT 1 FROM messages m WHERE m.id=substr(meta.key,19) AND m.status!='deleted' AND NOT EXISTS(SELECT 1 FROM message_deletions d WHERE d.message_id=m.id AND d.user_id=m.author_id))
      OR EXISTS(SELECT 1 FROM messages m WHERE m.id=substr(meta.key,19) AND m.created_at<? AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=m.id AND d.status!='accepted'))))
      OR (key GLOB '${journalPrefix}' AND json_valid(value) AND json_extract(value,'$.createdAt')<? AND (
        json_extract(value,'$.readOnly')=1 OR (json_extract(value,'$.sourceMessageId') IS NOT NULL AND (
          NOT EXISTS(SELECT 1 FROM messages m WHERE m.id=json_extract(meta.value,'$.sourceMessageId') AND m.status!='deleted')
          OR (EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=json_extract(meta.value,'$.sourceMessageId')) AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=json_extract(meta.value,'$.sourceMessageId') AND d.status!='accepted'))
        ))))`;
    const cutoff = [now - retentionMs, now - retentionMs];
    const removed = await db.get<{ entries: number; bytes: number }>(`SELECT COUNT(*) AS entries,COALESCE(SUM(${chargedBytes}),0) AS bytes FROM meta WHERE ${predicate}`, cutoff);
    if (removed?.entries) {
      const legacy = await db.all<{ key: string; value: string }>(`SELECT key,value FROM meta WHERE key GLOB '${contextPrefix}' AND (${predicate}) AND EXISTS(SELECT 1 FROM messages m WHERE m.id=substr(meta.key,19) AND m.workbench_receipt_json IS NULL)`, cutoff);
      for (const row of legacy) await db.run("UPDATE messages SET workbench_receipt_json=? WHERE id=? AND workbench_receipt_json IS NULL", [JSON.stringify({ digest: workbenchContextDigest(row.value) } satisfies WorkbenchContextReceipt), row.key.slice("workbench-context:".length)]);
      await db.run(`DELETE FROM meta WHERE ${predicate}`, cutoff);
      budget.entries = Math.max(0, budget.entries - removed.entries); budget.bytes = Math.max(0, budget.bytes - removed.bytes);
    }
    budget.cleanedAt = now;
  }
  const allowed = !exceeds();
  if (allowed) { budget.entries++; budget.bytes += bytes; }
  // Persist cleanup even when chat proceeds without reserving a context row.
  await db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [budgetKey, JSON.stringify(budget)]);
  return allowed;
}
