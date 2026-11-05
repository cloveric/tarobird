import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { anyRun, isRunActive, RUN_RETENTION_MS, RUN_ENTRY_LIMIT, runEntrySchema, type RunEntry } from "../client-protocol/run.js";
import { messageSchema } from "../client-protocol/index.js";
import { runChangesSchema, runChangeDetailSchema, type RunChanges, type RunChangeDetail } from "../client-protocol/run-changes.js";
import { recordedEdits, recordedFileIdentity, generatedChange, parseRecordedPatch, type RecordedEdit } from "../core/recorded-diff.js";
import { isCredentialStylePath } from "../runtime/credential-files.js";
import { HubError, type HubStore } from "./store.js";

type Query = { conversationId: string; botId: string; runId?: string; key?: string; revision?: string; operation?: string; preview?: "1" };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** Immutable run evidence. There is deliberately no filesystem/Git dependency. */
export class HubRunChanges {
  private active = 0;
  constructor(private readonly store: HubStore) {}
  async read(userId: string, messageId: string, query: Query, signal: AbortSignal, validate: () => Promise<void>): Promise<RunChanges | RunChangeDetail> {
    if (this.active >= 2) throw new HubError("run_changes_busy", 429);
    this.active++;
    const deadline = AbortSignal.timeout(10_000), combined = AbortSignal.any([signal, deadline]);
    const check = () => { if (combined.aborted) throw new HubError(deadline.aborted ? "run_changes_timeout" : "request_aborted", deadline.aborted ? 504 : 499); };
    const task = this.readSnapshot(userId, messageId, query, validate, check).finally(() => { this.active--; });
    // Admission remains held until queued DB/CPU work actually settles.
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => { abort = () => { try { check(); } catch (error) { reject(error); } }; combined.addEventListener("abort", abort, { once: true }); if (combined.aborted) abort(); });
    try { return await Promise.race([task, cancelled]); } finally { combined.removeEventListener("abort", abort); }
  }
  private async readSnapshot(userId: string, messageId: string, query: Query, validate: () => Promise<void>, check: () => void): Promise<RunChanges | RunChangeDetail> {
    await validate(); check();
    const authorize = async () => {
      const message = await this.store.messageForUser(userId, messageId);
      if (message.authorType !== "bot" || message.authorId !== query.botId || message.conversationId !== query.conversationId || message.status === "deleted") throw new HubError("run_changes_forbidden", 403);
      const card = message.blocks.find(block => block.type === "card" && anyRun(block));
      const run = card?.type === "card" ? anyRun(card) : undefined;
      if (!run || card?.type === "card" && card.extra?.scopedRun !== undefined) throw new HubError("run_changes_not_recorded", 404);
      if (query.runId && query.runId !== run.id) throw new HubError("run_changes_changed", 409);
      return run;
    };
    const run = await authorize(); check();
    const cutoff = Date.now() - RUN_RETENTION_MS;
    const expired = (run.endedAt ?? run.updatedAt) < cutoff;
    const manifest = () => this.store.db.all<{ seq: number; revision: number; updated_at: number }>("SELECT seq,revision,updated_at FROM run_journal WHERE message_id=? AND run_id=? AND bot_id=? AND conversation_id=? AND updated_at>=? ORDER BY seq LIMIT ?", [messageId, run.id, query.botId, query.conversationId, cutoff, RUN_ENTRY_LIMIT]);
    const active = isRunActive(run.phase);
    const snapshot = await this.store.db.serial(async () => {
      check(); await this.store.requireMember(userId, query.conversationId);
      const row = await this.store.db.get<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE id=? AND author_type='bot' AND author_id=? AND conversation_id=? AND status!='deleted' AND NOT EXISTS(SELECT 1 FROM message_deletions d WHERE d.message_id=messages.id AND d.user_id=?)", [messageId, query.botId, query.conversationId, userId]);
      if (!row) throw new HubError("message_not_found", 404);
      const latest = messageSchema.shape.blocks.parse(JSON.parse(row.blocks_json)).flatMap(block => block.type === "card" ? anyRun(block) ?? [] : [])[0];
      if (!latest || JSON.stringify(latest) !== JSON.stringify(run)) throw new HubError("run_changes_changed", 409);
      const headers = active || expired ? [] : await manifest();
      const children = active || expired ? undefined : await this.store.db.get<{ n: number }>("SELECT COALESCE(SUM(json_array_length(json_extract(payload,'$.changes'))),0) n FROM run_journal_scoped WHERE message_id=? AND run_id=? AND bot_id=? AND conversation_id=? AND updated_at>=?", [messageId, run.id, query.botId, query.conversationId, cutoff]);
      return { headers, childEdits: children?.n ?? 0 };
    });
    check();
    const entries: RunEntry[] = [];
    // Bounded pages release the database queue between reads, so switching
    // files cannot hold all Hub writes behind an entire run's patch payload.
    for (let offset = 0; offset < snapshot.headers.length; offset += 64) {
      const batch = snapshot.headers.slice(offset, offset + 64);
      const rows = await this.store.db.serial(async () => {
        check();
        return this.store.db.all<{ payload: string }>(`SELECT json_object('seq',seq,'revision',revision,'kind',json_extract(payload,'$.kind'),'status',json_extract(payload,'$.status'),'at',json_extract(payload,'$.at'),'name',json_extract(payload,'$.name'),'truncated',json_extract(payload,'$.truncated'),'changes',json_extract(payload,'$.changes')) AS payload FROM run_journal WHERE message_id=? AND run_id=? AND bot_id=? AND conversation_id=? AND seq>=? AND seq<=? AND updated_at>=? ORDER BY seq LIMIT 64`, [messageId, run.id, query.botId, query.conversationId, batch[0]!.seq, batch.at(-1)!.seq, cutoff]);
      });
      for (const row of rows) {
        const raw = JSON.parse(row.payload);
        for (const key of Object.keys(raw)) if (raw[key] === null) delete raw[key];
        if (raw.truncated !== undefined) raw.truncated = !!raw.truncated;
        entries.push(runEntrySchema.parse(raw));
      }
      await setImmediate(); check();
    }
    if (!active && !expired && JSON.stringify(snapshot.headers) !== JSON.stringify(await this.store.db.serial(manifest))) throw new HubError("run_changes_changed", 409);
    const evidence = recordedEdits(entries), grouped = new Map<string, RecordedEdit[]>();
    for (const edit of evidence.edits) { const key = hash(run.id + "\0" + recordedFileIdentity(edit)); const group = grouped.get(key) ?? []; group.push(edit); grouped.set(key, group); }
    const revision = hash(JSON.stringify([run.id, run.revision, run.detailsUnavailable, run.phase, snapshot.headers]));
    if (query.revision && query.revision !== revision) throw new HubError("run_changes_changed", 409);
    const partial = expired || run.startedAt < cutoff || run.truncated || !!run.detailsUnavailable || ["interrupted", "stopped", "error", "partial"].includes(run.phase) || evidence.partial;
    const base = { scope: "recorded_run" as const, messageId, conversationId: query.conversationId, botId: query.botId, runId: run.id, revision,
      state: active ? "active" as const : expired ? "expired" as const : grouped.size ? "recorded" as const : "not_recorded" as const,
      partial, unavailable: evidence.unavailable, childEdits: snapshot.childEdits };
    const item = (key: string, edits: RecordedEdit[]) => ({ key, path: edits[0]!.path, edits: edits.length, generated: generatedChange(edits[0]!.path), protected: isCredentialStylePath(edits[0]!.path), partial: edits.some(edit => edit.partial),
      additions: edits.some(edit => edit.stats.additions === null) ? null : edits.reduce((n, edit) => n + edit.stats.additions!, 0), deletions: edits.some(edit => edit.stats.deletions === null) ? null : edits.reduce((n, edit) => n + edit.stats.deletions!, 0) });
    let result: RunChanges | RunChangeDetail;
    if (!query.key) result = runChangesSchema.parse({ ...base, items: [...grouped].slice(0, 200).map(([key, edits]) => item(key, edits)), truncated: grouped.size > 200 });
    else {
      if (base.state === "active") throw new HubError("run_changes_active", 409);
      if (expired) throw new HubError("run_changes_expired", 410);
      const edits = grouped.get(query.key); if (!edits) throw new HubError("run_change_not_found", 404);
      const file = item(query.key, edits), operation = (edit: RecordedEdit) => ({ id: `${edit.entry.seq}-${edit.index}`, seq: edit.entry.seq, at: edit.entry.at, additions: edit.stats.additions, deletions: edit.stats.deletions, format: edit.stats.format, partial: edit.partial });
      const edit = query.operation ? edits.find(value => operation(value).id === query.operation) : edits[0];
      if (!edit) throw new HubError("run_change_not_found", 404);
      const preview = query.preview === "1", large = edit.stats.rows > 1000 || edit.stats.bytes > 200 * 1024;
      const reason = file.protected ? "protected" : edit.stats.format === "binary" ? "binary" : edit.stats.format === "empty" ? "unavailable" : large && !preview ? "too_large" : null;
      const parsed = reason ? undefined : parseRecordedPatch(edit.diff, preview ? 200 : 1000);
      result = runChangeDetailSchema.parse({ ...base, file, operations: edits.slice(0, 200).map(operation), operationsTruncated: edits.length > 200, operation: operation(edit),
        hunks: parsed?.hunks ?? [], reason, preview, truncated: edit.partial || large || !!parsed && parsed.rows > (preview ? 200 : 1000) });
    }
    check(); const after = await authorize(); await validate(); check();
    if (JSON.stringify(after) !== JSON.stringify(run)) throw new HubError("run_changes_changed", 409);
    return result;
  }
}
