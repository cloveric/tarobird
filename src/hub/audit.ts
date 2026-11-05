import type { HubDatabase } from "./database.js";

type Detail = Record<string, string | number | boolean>;
type Summary = { count: number; firstAt: number; lastAt: number };
type Bucket = { start: number; samples: number; pending?: Summary };
const REJECTION_KINDS = ["http.rejected", "auth.rejected", "socket.rejected", "request.rejected", "pairing.rejected", "bot-message.rejected"] as const;
const REJECTIONS = new Set<string>(REJECTION_KINDS);
// Routine polling remains individually audited but must not displace grants,
// revocations or other durable security receipts in the protected partition.
export const LOW_TRUST_AUDIT_KINDS = [...REJECTION_KINDS, "rejections.summarized", "pairing.requested", "bot-message.wait", "bot-message.outgoing-wait"] as const;
const WINDOW_MS = 60_000;
const SAMPLES = 10;

/** Rejection input is unauthenticated. Never key buckets by a supplied device,
 * token or source: rotating those values must not multiply disk or memory use. */
export class HubAudit {
  private readonly buckets = new Map<string, Bucket>();
  private flushing?: Promise<void>;
  constructor(private readonly db: HubDatabase, private readonly now = Date.now) {}
  async write(kind: string, actor: string | null, detail: Detail): Promise<void> {
    const at = this.now();
    if (REJECTIONS.has(kind)) {
      let bucket = this.buckets.get(kind);
      if (!bucket) { bucket = { start: at, samples: 0 }; this.buckets.set(kind, bucket); }
      if (at - bucket.start >= WINDOW_MS) { bucket.start = at; bucket.samples = 0; }
      if (bucket.samples >= SAMPLES) {
        const summary = bucket.pending ??= { count: 0, firstAt: at, lastAt: at };
        summary.count++; summary.lastAt = at;
        return;
      }
      bucket.samples++;
    }
    await this.db.serial(() => this.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [at, actor, kind, JSON.stringify(detail)]));
  }
  /** The server calls this every five seconds and at shutdown. Backups flush
   * first too. A crash can lose only the as-yet unflushed aggregate counts. */
  async flush(): Promise<void> {
    if (this.flushing) await this.flushing;
    const pending: { kind: string; bucket: Bucket; summary: Summary }[] = [];
    for (const [kind, bucket] of this.buckets) {
      if (bucket.pending) { pending.push({ kind, bucket, summary: bucket.pending }); delete bucket.pending; }
    }
    if (!pending.length) return;
    const task = this.db.transaction(async () => {
      for (const { kind, summary } of pending) {
        await this.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,NULL,'rejections.summarized',?)", [summary.lastAt, JSON.stringify({ kind, ...summary })]);
      }
    });
    this.flushing = task;
    try { await task; }
    catch (error) {
      for (const { bucket, summary } of pending) {
        const newer = bucket.pending;
        bucket.pending = { count: summary.count + (newer?.count ?? 0), firstAt: summary.firstAt, lastAt: newer?.lastAt ?? summary.lastAt };
      }
      throw error;
    } finally { if (this.flushing === task) this.flushing = undefined; }
  }
}
