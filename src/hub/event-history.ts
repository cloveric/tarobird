import { z } from 'zod';
import { HubDatabase } from './database.js';
import type { HubStore } from './store.js';

export const eventHistoryPolicySchema = z.object({
  retentionDays: z.number().int().min(1).max(365).default(7),
  maxBytes: z.number().int().min(1024*1024).max(1024**4).default(256*1024*1024),
  maxRows: z.number().int().min(128).max(10_000_000).default(50_000),
}).strict();
export type EventHistoryPolicy = z.infer<typeof eventHistoryPolicySchema>;
export const DEFAULT_EVENT_HISTORY_POLICY = eventHistoryPolicySchema.parse({});
type Accounting = { scanned_rowid: number; ready: number; rows: number; bytes: number };
const pause = () => new Promise<void>(resolve => setImmediate(resolve));

/** Updates are replay history, not canonical messages. This class never edits
 * messages, attachments, deliveries, requests, reads or backup preferences. */
export class EventHistoryRetention {
  private running?: Promise<{ removed: number; bytes: number; indexed: boolean }>;
  constructor(private readonly store: HubStore, readonly policy: EventHistoryPolicy = DEFAULT_EVENT_HISTORY_POLICY) {}
  run(now = Date.now(), budgetMs = 200): Promise<{ removed: number; bytes: number; indexed: boolean }> {
    if (this.running) return this.running;
    const work = this.collect(now, budgetMs).finally(() => { if (this.running === work) this.running = undefined; });
    this.running = work; return work;
  }
  private async collect(now: number, budgetMs: number) {
    const { db } = this.store, end = performance.now()+budgetMs;
    let removed = 0, bytes = 0;
    this.store.activityIndex.start();
    // Read sizes off the writer connection. Each transaction imports only small
    // metadata; it rechecks the checkpoint because maintenance may be concurrent.
    const reader = await HubDatabase.snapshot(db.file);
    try {
      for (;;) {
        const state = (await db.serial(() => db.get<Accounting>('SELECT * FROM event_history_state WHERE id=1')))!;
        if (state.ready) break;
        const rows = await reader.all<{ row_key: number; conversation_id: string; seq: number; at: number; bytes: number; message_id: string|null }>(
          "SELECT rowid row_key,conversation_id,seq,at,length(CAST(payload_json AS BLOB)) bytes,CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.id') END message_id FROM events WHERE rowid>? AND kind='message.updated' ORDER BY rowid LIMIT 128", [state.scanned_rowid]);
        await db.transaction(async () => {
          const current = (await db.get<Accounting>('SELECT * FROM event_history_state WHERE id=1'))!;
          if (current.ready || current.scanned_rowid !== state.scanned_rowid) return;
          for (const row of rows) await db.run('INSERT OR IGNORE INTO event_history SELECT conversation_id,seq,at,?,? FROM events WHERE conversation_id=? AND seq=?', [row.bytes,row.message_id,row.conversation_id,row.seq]);
          await db.run('UPDATE event_history_state SET scanned_rowid=?,ready=? WHERE id=1', [rows.at(-1)?.row_key ?? state.scanned_rowid, rows.length ? 0 : 1]);
        });
        if (performance.now()>=end) return {removed,bytes,indexed:false};
        await pause();
      }
    } finally { await reader.close(); }
    // Candidate scans use a separate connection: protected checkpoints or a
    // lagging conversation must not turn the whole quota scan into a write lock.
    const scan = await HubDatabase.snapshot(db.file);
    try { for (;;) {
      const total = (await scan.get<Accounting>('SELECT * FROM event_history_state WHERE id=1'))!;
      const over = total.bytes>this.policy.maxBytes || total.rows>this.policy.maxRows;
      const candidates = await scan.all<{ conversation_id:string;seq:number;bytes:number }>(`SELECT h.conversation_id,h.seq,h.bytes FROM event_history h
        JOIN conversation_activity a ON a.conversation_id=h.conversation_id
        JOIN messages m ON m.id=h.message_id AND m.conversation_id=h.conversation_id
        WHERE (? OR h.at<?) AND h.seq<(SELECT MAX(seq) FROM events WHERE conversation_id=h.conversation_id)
        AND a.through_seq=(SELECT MAX(seq) FROM events WHERE conversation_id=h.conversation_id)
        ORDER BY h.at,h.conversation_id,h.seq LIMIT 32`, [over?1:0,now-this.policy.retentionDays*86400_000]);
      if (!candidates.length) break;
      const result = await db.transaction(async () => {
        let count=0, size=0;
        for (const candidate of candidates) {
          // Recheck the small selected page after taking the writer lock. A
          // concurrent repair/pruner may have changed coverage or accounting.
          const row = await db.get<{bytes:number}>(`SELECT h.bytes FROM event_history h
            JOIN conversation_activity a ON a.conversation_id=h.conversation_id
            JOIN messages m ON m.id=h.message_id AND m.conversation_id=h.conversation_id
            WHERE h.conversation_id=? AND h.seq=?
            AND h.seq<(SELECT MAX(seq) FROM events WHERE conversation_id=h.conversation_id)
            AND a.through_seq=(SELECT MAX(seq) FROM events WHERE conversation_id=h.conversation_id)`,[candidate.conversation_id,candidate.seq]);
          if (!row) continue;
          if (count && size+row.bytes>4*1024*1024) break;
          await db.run(`INSERT INTO event_history_floor VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET seq=max(seq,excluded.seq)`,[candidate.conversation_id,candidate.seq]);
          const deletion=await db.run("DELETE FROM events WHERE conversation_id=? AND seq=? AND kind='message.updated'",[candidate.conversation_id,candidate.seq]);
          count+=deletion.changes; size+=deletion.changes*row.bytes;
        }
        return {count,size};
      });
      removed+=result.count; bytes+=result.size;
      if (!result.count || performance.now()>=end) break;
      await pause();
    } } finally { await scan.close(); }
    return {removed,bytes,indexed:true};
  }
}
