import { HubDatabase } from "./database.js";
import { HubError } from "./errors.js";
import { ACTIVITY_PARAMETER_SOURCE, activityEventColumns, foldActivitySql, foldHideSql } from "./message-activity-sql.js";

/** Snapshot metadata for one message, identical to the former journal query. */
export type MessageActivity = { contentSeq: number; contentAt: number; unreadSeq: number; lastSeq: number };
type ActivityRow = { author: string | null; firstSeq: number; firstAt: number; lastSeq: number; lastAt: number; lastStatus: string | null; unreadSeq: number };
type StoredActivityRow = { message_id: string; author: string | null; first_seq: number; first_at: number; last_seq: number; last_at: number; last_status: string | null; unread_seq: number };
type ActivityEvent = { seq: number; at: number; message_id: string | null; author: string | null; status: string | null; hide_user: string | null; hide_message: string | null };
export type ConversationActivity = {
  /** Message ID → activity. Full reads contain every message with a journal
   * history; change reads contain the changed and newly hidden messages. */
  activity: Map<string, MessageActivity>;
  /** Present only for change reads: messages to send after `after`. */
  changed?: Set<string>;
  /** Events folded in memory because durable coverage was behind `head`. */
  tail: number;
  indexed: boolean;
};

// On-demand repair (a snapshot is waiting) uses larger batches; background
// repair yields the writer more often. Each write transaction folds at most two
// batches (one prepared page plus the final in-lock gap).
const REPAIR_BATCH = 256, BACKGROUND_BATCH = 128, BACKGROUND_PAUSE_MS = 5;
const EVENT_COLUMNS = `seq,at,${activityEventColumns("payload_json", "kind")}`;
const terminal = (status: string | null) => status === "complete" || status === "error";
const toActivity = (row: ActivityRow): MessageActivity => row.author === "user"
  ? { contentSeq: row.firstSeq, contentAt: row.firstAt, unreadSeq: row.unreadSeq, lastSeq: row.lastSeq }
  : { contentSeq: row.lastSeq, contentAt: row.lastAt, unreadSeq: row.unreadSeq, lastSeq: row.lastSeq };
const fromStored = (row: StoredActivityRow): ActivityRow => ({ author: row.author, firstSeq: row.first_seq, firstAt: row.first_at, lastSeq: row.last_seq, lastAt: row.last_at, lastStatus: row.last_status, unreadSeq: row.unread_seq });

/** The in-memory twin of foldActivitySql/foldHideSql, used only for a not yet
 * durable tail inside a read transaction. Equivalence is covered by tests. */
function foldEvent(rows: Map<string, ActivityRow>, event: ActivityEvent, hidden?: { userId: string; after: number; ids: Set<string> }): void {
  if (event.message_id !== null) {
    const old = rows.get(event.message_id);
    if (!old) rows.set(event.message_id, { author: event.author, firstSeq: event.seq, firstAt: event.at, lastSeq: event.seq, lastAt: event.at, lastStatus: event.status,
      unreadSeq: event.author === "bot" && terminal(event.status) ? event.seq : 0 });
    else if (event.seq > old.lastSeq) {
      if (event.author === "bot" && terminal(event.status) && (old.lastStatus === null || old.lastStatus === "pending" || old.lastStatus === "streaming")) old.unreadSeq = event.seq;
      old.lastSeq = event.seq; old.lastAt = event.at; old.lastStatus = event.status;
    }
  }
  if (hidden && event.hide_user === hidden.userId && event.hide_message !== null && event.seq > hidden.after) hidden.ids.add(event.hide_message);
}

const jsonIds = (ids: Iterable<string>) => JSON.stringify([...ids]);
async function loadRows(db: HubDatabase, conversationId: string, ids?: Iterable<string>): Promise<Map<string, ActivityRow>> {
  const rows = ids === undefined
    ? await db.all<StoredActivityRow>("SELECT * FROM message_activity WHERE conversation_id=?", [conversationId])
    : await db.all<StoredActivityRow>("SELECT * FROM message_activity WHERE conversation_id=? AND message_id IN (SELECT value FROM json_each(?))", [conversationId, jsonIds(ids)]);
  return new Map(rows.map(row => [row.message_id, fromStored(row)]));
}

/**
 * Read exact activity inside the caller's read transaction, consistent with
 * `head` read in that same transaction. Durable coverage supplies everything up
 * to through_seq; only the uncovered tail (normally empty) is parsed. With
 * `after`, returns only messages changed after that sequence, plus messages
 * `userId` hid after it, for a merge snapshot.
 */
export async function readConversationActivity(db: HubDatabase, conversationId: string, head: number, change?: { after: number; userId: string }): Promise<ConversationActivity> {
  const stored = (await db.get<{ through_seq: number }>("SELECT through_seq FROM conversation_activity WHERE conversation_id=?", [conversationId]))?.through_seq;
  // Coverage commits atomically with events, so it never exceeds `head` in one
  // transaction. A watermark ahead of the journal (inconsistent restore or
  // damage) is not trusted at all: fold the journal instead; repair rebuilds it.
  const through = stored !== undefined && stored <= head ? stored : undefined;
  const floor = (await db.get<{ seq: number }>("SELECT seq FROM event_history_floor WHERE conversation_id=?", [conversationId]))?.seq ?? 0;
  if (floor && (through === undefined || through < floor)) throw new HubError("history_metadata_unavailable", 409);
  const covered = through ?? 0;
  const tail = covered < head ? await db.all<ActivityEvent>(`SELECT ${EVENT_COLUMNS} FROM events WHERE conversation_id=? AND seq>? AND seq<=? ORDER BY seq`, [conversationId, covered, head]) : [];
  if (!change) {
    const rows = through === undefined ? new Map<string, ActivityRow>() : await loadRows(db, conversationId);
    for (const event of tail) foldEvent(rows, event);
    return { activity: new Map([...rows].map(([id, row]) => [id, toActivity(row)])), tail: tail.length, indexed: through !== undefined && through >= head };
  }
  const hidden = { userId: change.userId, after: change.after, ids: new Set<string>() };
  const changed = new Set<string>();
  if (through !== undefined) {
    for (const row of await db.all<{ message_id: string }>("SELECT message_id FROM message_activity WHERE conversation_id=? AND last_seq>?", [conversationId, change.after])) changed.add(row.message_id);
    for (const row of await db.all<{ message_id: string }>("SELECT message_id FROM message_hide_events WHERE conversation_id=? AND seq>? AND seq<=? AND user_id=?", [conversationId, change.after, covered, change.userId])) hidden.ids.add(row.message_id);
  }
  const touched = new Set(tail.flatMap(event => event.message_id === null ? [] : [event.message_id]));
  const rows = through === undefined ? new Map<string, ActivityRow>() : await loadRows(db, conversationId, new Set([...touched, ...changed]));
  for (const event of tail) foldEvent(rows, event, hidden);
  for (const event of tail) if (event.message_id !== null && event.seq > change.after) changed.add(event.message_id);
  const wanted = new Set([...changed, ...hidden.ids]);
  const missing = [...hidden.ids].filter(id => !rows.has(id));
  if (missing.length && through !== undefined) for (const [id, row] of await loadRows(db, conversationId, missing)) rows.set(id, row);
  const activity = new Map<string, MessageActivity>();
  for (const id of wanted) { const row = rows.get(id); if (row) activity.set(id, toActivity(row)); }
  return { activity, changed: wanted, tail: tail.length, indexed: through !== undefined && through >= head };
}

/**
 * Bounded construction and repair of durable coverage. Journal bodies are read
 * on a separate read-only connection; each write transaction folds at most one
 * batch, verifies the expected watermark first, and then yields the writer.
 */
export class MessageActivityIndex {
  private readonly inflight = new Map<string, Promise<void>>();
  /** A waiting snapshot escalates an in-flight background pass to foreground pacing. */
  private readonly urgent = new Set<string>();
  private background?: Promise<void>;
  private scannedAt = -Infinity;
  private stopped = false;
  private unregister?: () => void;
  /** Observable counters for diagnostics and tests. */
  readonly stats = { batches: 0, events: 0, maxBatchEvents: 0, repairedConversations: 0, rebuiltConversations: 0, ensureFailures: 0, largeTailReads: 0, lastError: "" };
  /** Record a failed on-demand repair; the caller continues with an exact fallback. */
  failed(error: unknown): void { this.stats.ensureFailures++; this.stats.lastError = error instanceof Error ? error.message : String(error); }
  /** Count reads that had to parse more than one repair batch of journal bodies. */
  observe<T extends { tail: number }>(read: T): T { if (read.tail > REPAIR_BATCH) this.stats.largeTailReads++; return read; }
  constructor(private readonly db: HubDatabase, private readonly options: { batch?: number; backgroundBatch?: number; pauseMs?: number } = {}) {}
  private attach(): void { if (!this.unregister) this.unregister = this.db.beforeClose(() => this.stop()); }
  /** Repair every conversation whose coverage is missing or behind. Idempotent;
   * a completed scan is not repeated for 30 seconds (snapshots call this too). */
  start(): void {
    if (this.stopped || this.background || performance.now() - this.scannedAt < 30_000) return;
    this.attach(); this.scannedAt = performance.now();
    this.background = (async () => {
      for (const id of await this.lagging()) {
        if (this.stopped) return;
        await this.ensure(id, true).catch(() => undefined);
      }
    })().catch(() => undefined).finally(() => { this.background = undefined; });
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([this.background, ...this.inflight.values()]);
    this.unregister?.(); this.unregister = undefined;
  }
  /** Conversations whose durable coverage is missing, behind or (inconsistently)
   * ahead of the journal, largest gap first. Index-only. */
  async lagging(): Promise<string[]> {
    const reader = await HubDatabase.snapshot(this.db.file);
    try {
      return (await reader.all<{ id: string }>(`SELECT c.id FROM conversations c LEFT JOIN conversation_activity a ON a.conversation_id=c.id
        WHERE a.through_seq IS NOT (SELECT COALESCE(MAX(seq),0) FROM events e WHERE e.conversation_id=c.id)
        ORDER BY ABS((SELECT COALESCE(MAX(seq),0) FROM events e WHERE e.conversation_id=c.id)-COALESCE(a.through_seq,0)) DESC,c.created_at`)).map(row => row.id);
    } finally { await reader.close(); }
  }
  /** Bring one conversation's coverage to the current journal head. */
  ensure(conversationId: string, background = false): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("activity_index_stopped"));
    this.attach();
    if (!background) this.urgent.add(conversationId);
    const existing = this.inflight.get(conversationId); if (existing) return existing;
    const work = this.repair(conversationId, background).finally(() => { if (this.inflight.get(conversationId) === work) { this.inflight.delete(conversationId); this.urgent.delete(conversationId); } });
    this.inflight.set(conversationId, work); return work;
  }
  private async repair(conversationId: string, background: boolean): Promise<void> {
    const reader = await HubDatabase.snapshot(this.db.file);
    let repaired = false;
    try {
      for (;;) {
        if (this.stopped) throw new Error("activity_index_stopped");
        const paced = background && !this.urgent.has(conversationId);
        const batch = Math.max(1, paced ? this.options.backgroundBatch ?? this.options.batch ?? BACKGROUND_BATCH : this.options.batch ?? REPAIR_BATCH);
        const pause = paced ? this.options.pauseMs ?? BACKGROUND_PAUSE_MS : 0;
        const state = await reader.get<{ through_seq: number }>("SELECT through_seq FROM conversation_activity WHERE conversation_id=?", [conversationId]);
        const head = (await reader.get<{ seq: number }>("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE conversation_id=?", [conversationId]))!.seq;
        const floor = (await reader.get<{ seq: number }>("SELECT seq FROM event_history_floor WHERE conversation_id=?", [conversationId]))?.seq ?? 0;
        if (floor && (!state || state.through_seq < floor || state.through_seq > head)) throw new HubError("history_metadata_unavailable", 409);
        // A watermark ahead of the journal claims folds that never happened.
        const ahead = state !== undefined && state.through_seq > head;
        if (state && !ahead && state.through_seq === head) {
          // Covered: the trigger now folds each new event in its own transaction.
          if (repaired) this.stats.repairedConversations++;
          return;
        }
        const from = state && !ahead ? state.through_seq : 0;
        // Bodies are parsed here, outside the writer queue, one bounded page at a time.
        const events = await reader.all<ActivityEvent>(`SELECT ${EVENT_COLUMNS} FROM events WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?`, [conversationId, from, batch]);
        const folded = await this.db.transaction(async () => {
          const current = await this.db.get<{ through_seq: number }>("SELECT through_seq FROM conversation_activity WHERE conversation_id=?", [conversationId]);
          if (!state || ahead) {
            // Another pass or the conversation trigger changed it meanwhile; reread.
            if (!state ? current : current?.through_seq !== state.through_seq) return 0;
            if (!await this.db.get("SELECT 1 FROM conversations WHERE id=?", [conversationId])) return -1;
            // Rows without a trustworthy watermark are discarded and rebuilt.
            if (ahead) this.stats.rebuiltConversations++;
            await this.db.run("DELETE FROM message_activity WHERE conversation_id=?", [conversationId]);
            await this.db.run("DELETE FROM message_hide_events WHERE conversation_id=?", [conversationId]);
            await this.db.run("INSERT OR REPLACE INTO conversation_activity(conversation_id,through_seq) VALUES(?,0)", [conversationId]);
          } else if (current?.through_seq !== state.through_seq) return 0;
          let through = from, count = 0;
          const fold = async (event: ActivityEvent) => {
            const params = [conversationId, event.seq, event.at, event.message_id, event.author, event.status, event.hide_user, event.hide_message];
            // Both statements filter NULL fields themselves; skipping them is only a shortcut.
            if (event.message_id !== null) await this.db.run(foldActivitySql(ACTIVITY_PARAMETER_SOURCE), params);
            if (event.hide_user !== null && event.hide_message !== null) await this.db.run(foldHideSql(ACTIVITY_PARAMETER_SOURCE), params);
            through = event.seq; count++;
          };
          for (const event of events) await fold(event);
          // Close a small remaining gap under the write lock, so continuous new
          // writes cannot keep coverage behind; afterwards the trigger owns it.
          const live = (await this.db.get<{ seq: number }>("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE conversation_id=?", [conversationId]))!.seq;
          if (live > through && live - through <= batch) for (const event of await this.db.all<ActivityEvent>(`SELECT ${EVENT_COLUMNS} FROM events WHERE conversation_id=? AND seq>? ORDER BY seq`, [conversationId, through])) await fold(event);
          await this.db.run("UPDATE conversation_activity SET through_seq=? WHERE conversation_id=?", [through, conversationId]);
          return count;
        });
        if (folded < 0) return; // The conversation no longer exists.
        if (folded > 0) { repaired = true; this.stats.batches++; this.stats.events += folded; this.stats.maxBatchEvents = Math.max(this.stats.maxBatchEvents, folded); }
        // Yield the writer queue between batches; background repair also yields time.
        await new Promise(resolve => pause ? setTimeout(resolve, pause) : setImmediate(resolve));
      }
    } finally { await reader.close(); }
  }
}
