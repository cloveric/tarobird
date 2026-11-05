import { redactLogMetadata } from "../state/log-redaction.js";
import { diagnosticQuerySchema, type DiagnosticPage, type DiagnosticQuery } from "../client-protocol/diagnostics.js";
import { DiagnosticAccumulator, diagnosticEvent } from "../runtime/diagnostics.js";
import type { HubStore } from "./store.js";
import { HubDatabase } from "./database.js";

// Keep at most one historical scan/SQLite reader per Hub. Its queue is separate
// from live writes/authentication and is released on either success or failure.
const readers = new WeakMap<HubStore, Promise<unknown>>();

/** One committed WAL revision supplies both the page and its complete retained
 * statistics. Independent, bounded batches never occupy the writer queue, and
 * concurrent pruning cannot remove part of the history halfway through a read. */
export async function readHubDiagnostics(store: HubStore, raw: unknown, signal?: AbortSignal): Promise<DiagnosticPage> {
  const query = diagnosticQuerySchema.parse(raw);
  signal?.throwIfAborted();
  const task = (readers.get(store) ?? Promise.resolve()).then(async () => {
    signal?.throwIfAborted();
    const db = await HubDatabase.snapshot(store.db.file);
    try {
      signal?.throwIfAborted();
      await db.exec("BEGIN");
      return await readSnapshot(db, query, signal);
    } finally { await db.close(); }
  });
  const tail = task.then(() => undefined, () => undefined);
  readers.set(store, tail);
  void tail.then(() => { if (readers.get(store) === tail) readers.delete(store); });
  return task;
}

async function readSnapshot(db: HubDatabase, query: DiagnosticQuery, signal?: AbortSignal): Promise<DiagnosticPage> {
  const result = new DiagnosticAccumulator(query);
  const upper = (await db.get<{ id: number | null }>("SELECT MAX(id) AS id FROM audit_log"))?.id ?? 0;
  let after = 0, invalid = 0;
  while (after < upper) {
    signal?.throwIfAborted();
    const rows = await db.all<{ id: number; at: number; actor: string | null; kind: string; detail_json: string }>("SELECT id,at,actor,kind,detail_json FROM audit_log WHERE id>? AND id<=? ORDER BY id LIMIT 250", [after, upper]);
    signal?.throwIfAborted();
    if (!rows.length) break;
    for (const row of rows) {
      after = row.id;
      try {
        const metadata: unknown = JSON.parse(row.detail_json);
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) { invalid++; continue; }
        const detail = metadata as Record<string, unknown>;
        const outcome = detail.ok === false || /(?:failed|rejected)$/.test(row.kind) || row.kind === "bot.worker_error" || row.kind === "bot.worker_stopped" && typeof detail.exitCode === "number" && detail.exitCode !== 0 && detail.exitCode !== 75
          ? "error" : /(?:requested|queued)$/.test(row.kind) ? "pending"
          : detail.ok === true || /(?:approved|accepted|revoked|renamed|registered|created|exported|label_updated|revealed|state_backup)$/.test(row.kind) ? "success" : "info";
        result.add(diagnosticEvent({ timestamp: new Date(row.at).toISOString(), type: row.kind, channel: "hub", actor: row.actor,
          outcome, detail: detail.reason ?? detail.code, metadata, conversationKey: detail.conversationId }, `hub_${row.id}`), undefined, query.search ? JSON.stringify(redactLogMetadata({ type: row.kind, actor: row.actor, ...detail })) : undefined);
      } catch { invalid++; }
    }
  }
  signal?.throwIfAborted();
  if (invalid) result.warnings.push(`已跳过 ${invalid} 条格式损坏的记录。`);
  return result.finish(upper === 0);
}
