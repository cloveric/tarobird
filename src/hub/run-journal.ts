import { messageAttachmentIds } from "../client-protocol/forwarding.js";
import { messageSchema } from "../client-protocol/index.js";
import { RUN_BYTE_LIMIT, RUN_ENTRY_LIMIT, RUN_RETENTION_MS, anyRun, runEntrySchema, runScopeSchema, runScopeWriteSchema, runWriteSchema, type RunPage, type RunEntry } from "../client-protocol/run.js";
import { HubError, type HubStore } from "./store.js";

/** Stored with the Hub database (same backup and private file permissions).
 * No path supplied by the CLI or client is ever opened by this journal. */
export class RunJournal {
  constructor(private store: HubStore) {}
  async write(botId: string, raw: unknown): Promise<void> {
    return this.writeEntries(botId, runWriteSchema.parse(raw), false);
  }
  async writeScoped(botId: string, raw: unknown): Promise<void> {
    return this.writeEntries(botId, runScopeWriteSchema.parse(raw), true);
  }
  private async writeEntries(botId: string, input: { conversationId: string; messageId: string; runId: string; entries: RunEntry[] }, scoped: boolean): Promise<void> {
    const db = this.store.db, table = scoped ? "run_journal_scoped" : "run_journal", other = scoped ? "run_journal" : "run_journal_scoped";
    await db.transaction(async () => {
      await this.store.requireBot(botId, input.conversationId);
      const message = await db.get<{ author_id: string; conversation_id: string; status: string }>("SELECT author_id,conversation_id,status FROM messages WHERE id=?", [input.messageId]);
      if (message && (message.author_id !== botId || message.conversation_id !== input.conversationId || message.status === "deleted")) throw new HubError("run_forbidden", 403);
      const owner = await db.get<{ bot_id: string; conversation_id: string }>("SELECT bot_id,conversation_id FROM run_journal WHERE message_id=? UNION ALL SELECT bot_id,conversation_id FROM run_journal_scoped WHERE message_id=? LIMIT 1", [input.messageId, input.messageId]);
      if (owner && (owner.bot_id !== botId || owner.conversation_id !== input.conversationId)) throw new HubError("run_forbidden", 403);
      await db.run("DELETE FROM run_journal WHERE updated_at<?", [Date.now() - RUN_RETENTION_MS]);
      await db.run("DELETE FROM run_journal_scoped WHERE updated_at<?", [Date.now() - RUN_RETENTION_MS]);
      const total = await db.get<{ bytes: number; count: number }>("SELECT COALESCE(SUM(bytes),0) AS bytes,COUNT(*) AS count FROM (SELECT length(CAST(payload AS BLOB)) AS bytes FROM run_journal WHERE message_id=? UNION ALL SELECT length(CAST(payload AS BLOB))+length(CAST(scope_json AS BLOB)) AS bytes FROM run_journal_scoped WHERE message_id=?)", [input.messageId, input.messageId]);
      let bytes = total!.bytes, count = total!.count;
      for (const entry of input.entries) {
        if (entry.seq > RUN_ENTRY_LIMIT) throw new HubError("run_limit", 413);
        if (await db.get(`SELECT 1 FROM ${other} WHERE message_id=? AND run_id=? AND seq=?`, [input.messageId, input.runId, entry.seq])) throw new HubError("invalid_request", 400);
        const old = await db.get<{ revision: number; bytes: number }>(`SELECT revision,length(CAST(payload AS BLOB))${scoped ? "+length(CAST(scope_json AS BLOB))" : ""} AS bytes FROM ${table} WHERE message_id=? AND run_id=? AND seq=?`, [input.messageId, input.runId, entry.seq]);
        if (old && old.revision >= entry.revision) continue;
        const { scope, ...legacy } = entry;
        const payload = JSON.stringify(legacy), scopeJson = scoped ? JSON.stringify(scope) : "";
        bytes += Buffer.byteLength(payload) + Buffer.byteLength(scopeJson) - (old?.bytes ?? 0); count += old ? 0 : 1;
        if (bytes > RUN_BYTE_LIMIT || count > RUN_ENTRY_LIMIT) throw new HubError("run_limit", 413);
        await db.run(`INSERT INTO ${table}(message_id,run_id,bot_id,conversation_id,seq,revision,payload,updated_at${scoped ? ",scope_json" : ""}) VALUES(?,?,?,?,?,?,?,?${scoped ? ",?" : ""}) ON CONFLICT(message_id,run_id,seq) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=excluded.updated_at${scoped ? ",scope_json=excluded.scope_json" : ""}`, [input.messageId, input.runId, botId, input.conversationId, entry.seq, entry.revision, payload, Date.now(), ...(scoped ? [scopeJson] : [])]);
      }
    });
  }
  async read(userId: string, messageId: string, after: number, query = "", includeScopes = false, window: { tail?: boolean; before?: number } = {}): Promise<RunPage> {
    const message = await this.store.messageForUser(userId, messageId);
    let run = message.blocks.flatMap(b => b.type === "card" ? anyRun(b) ?? [] : [])[0];
    if (!run || message.status === "deleted") throw new HubError("run_not_found", 404);
    return this.store.db.serial(async () => {
      // Recheck membership inside the read queue; HTTP also revalidates the
      // device session immediately before returning the result.
      await this.store.requireMember(userId, message.conversationId);
      const current = await this.store.db.get<{ status: string; blocks_json: string }>("SELECT status,blocks_json FROM messages WHERE id=? AND NOT EXISTS(SELECT 1 FROM message_deletions d WHERE d.message_id=messages.id AND d.user_id=?)", [messageId, userId]);
      const latest = current ? messageSchema.shape.blocks.parse(JSON.parse(current.blocks_json)).flatMap(b => b.type === "card" ? anyRun(b) ?? [] : [])[0] : undefined;
      if (!current || current.status === "deleted" || !latest || latest.id !== run.id) throw new HubError("run_not_found", 404);
      run = latest;
      const expired = Date.now() - (run.endedAt ?? run.updatedAt) > RUN_RETENTION_MS;
      const source = includeScopes ? "(SELECT message_id,run_id,payload,seq,updated_at,NULL AS scope_json FROM run_journal UNION ALL SELECT message_id,run_id,payload,seq,updated_at,scope_json FROM run_journal_scoped)" : "(SELECT message_id,run_id,payload,seq,updated_at,NULL AS scope_json FROM run_journal)";
      const backwards = window.tail === true || window.before !== undefined;
      const cutoff = Date.now() - RUN_RETENTION_MS;
      const matches = "message_id=? AND run_id=? AND updated_at>=? AND (?='' OR instr(lower(payload || COALESCE(scope_json,'')),lower(?))>0)";
      const matchArgs = [messageId, run.id, cutoff, query, query];
      // Fetch only one bounded page. Descending selection keeps the latest
      // entries when the byte cap is reached; presentation is always ascending.
      const rows = expired ? [] : await this.store.db.all<{ payload: string; seq: number; scope_json: string | null }>(`SELECT payload,seq,scope_json FROM ${source} WHERE ${matches} AND seq${backwards ? "<" : ">"}? ORDER BY seq ${backwards ? "DESC" : "ASC"} LIMIT 41`, [...matchArgs, backwards ? window.before ?? RUN_ENTRY_LIMIT + 1 : after]);
      let bytes = 0; const entries = [];
      for (const row of rows.slice(0, 40)) {
        const size = Buffer.byteLength(row.payload) + Buffer.byteLength(row.scope_json ?? "");
        if (bytes + size > 512 * 1024 && entries.length) break;
        const entry = runEntrySchema.parse({ ...JSON.parse(row.payload), ...(row.scope_json ? { scope: runScopeSchema.parse(JSON.parse(row.scope_json)) } : {}) });
        entries.push(run.endedAt && ["running", "waiting"].includes(entry.status) ? { ...entry, status: "unknown" as const } : entry); bytes += size;
      }
      if (backwards) entries.reverse();
      let previous = backwards && rows.length > entries.length ? entries[0]!.seq : null;
      if (!backwards && entries.length && await this.store.db.get(`SELECT 1 FROM ${source} WHERE ${matches} AND seq<? LIMIT 1`, [...matchArgs, entries[0]!.seq])) previous = entries[0]!.seq;
      let next = !backwards && rows.length > entries.length ? entries.at(-1)!.seq : null;
      if (backwards && entries.length && window.before !== undefined && await this.store.db.get(`SELECT 1 FROM ${source} WHERE ${matches} AND seq>? LIMIT 1`, [...matchArgs, entries.at(-1)!.seq])) next = entries.at(-1)!.seq;
      const currentBlocks = messageSchema.shape.blocks.parse(JSON.parse(current.blocks_json));
      const scoped = currentBlocks.some(block => block.type === "card" && block.extra?.scopedRun !== undefined);
      // Old artifact messages carry a request ID, not a run ID. Only infer for
      // an exclusive foreground run; sibling/subagent overlap is not ownership.
      const sibling = message.replyTo && !scoped ? await this.store.db.get(`SELECT 1 FROM messages m,json_each(m.blocks_json) b
        WHERE m.conversation_id=? AND m.author_id=? AND m.author_type='bot' AND m.reply_to=? AND m.id!=?
        AND (json_extract(b.value,'$.extra.nativeRun.id') IS NOT NULL OR json_extract(b.value,'$.extra.scopedRun.id') IS NOT NULL) LIMIT 1`,
        [message.conversationId, message.authorId, message.replyTo, messageId]) : undefined;
      const artifacts = message.replyTo && !scoped && !sibling ? await this.store.db.all<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE conversation_id=? AND author_id=? AND author_type='bot' AND reply_to=? AND status='complete' AND created_at>=? AND created_at<=? AND NOT EXISTS(SELECT 1 FROM message_deletions d WHERE d.message_id=messages.id AND d.user_id=?) ORDER BY created_at LIMIT 50", [message.conversationId, message.authorId, message.replyTo, run.startedAt, run.endedAt ?? Date.now(), userId]) : [];
      const ids = [...new Set([...messageAttachmentIds(currentBlocks), ...artifacts.flatMap(row => [...messageAttachmentIds(messageSchema.shape.blocks.parse(JSON.parse(row.blocks_json)))])])].slice(0, 50);
      const files: RunPage["files"] = [];
      for (const id of ids) {
        const file = await this.store.db.get<{ id: string; name: string; size: number; mime: string }>("SELECT id,name,size,mime FROM attachments WHERE id=? AND conversation_id=? AND complete=1", [id, message.conversationId]);
        if (file) files.push({ type: "file", attachmentId: file.id, name: file.name, size: file.size, mime: file.mime });
      }
      return { entries, files, next, previous, expired };
    });
  }
}
