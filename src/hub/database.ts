import { chmod, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import sqlite3 from "sqlite3";
import { randomUUID } from "node:crypto";
import { pushSubscriptionSchema } from "../client-protocol/push.js";
import { messageSchema } from "../client-protocol/index.js";
import { messageAttachmentIds } from "../client-protocol/forwarding.js";
import { retainPushReceipts } from "./push/receipts.js";
import { EVENT_HISTORY_SCHEMA } from "./event-history-sql.js";
import { MESSAGE_ACTIVITY_SCHEMA } from "./message-activity-sql.js";

export type SqlValue = string | number | Buffer | null;
export class HubDatabase {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly closing = new Set<() => Promise<void>>();
  private constructor(private readonly db: sqlite3.Database, readonly file: string) {}
  static async snapshot(file: string): Promise<HubDatabase> {
    const db = await new Promise<sqlite3.Database>((resolve, reject) => {
      const connection = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (error) => error ? reject(error) : resolve(connection));
    });
    return new HubDatabase(db, file);
  }
  /** Called only after an offline restore has validated every copied member.
   * Sequence numbers can be reused on the restored timeline; its lineage must
   * be new even when restoring a backup that already contains a lineage. */
  static async markRestored(file: string): Promise<void> {
    const db = await new Promise<sqlite3.Database>((resolve, reject) => {
      const connection = new sqlite3.Database(file, sqlite3.OPEN_READWRITE, (error) => error ? reject(error) : resolve(connection));
    });
    const restored = new HubDatabase(db, file);
    try {
      await restored.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      await restored.run("INSERT OR REPLACE INTO meta(key,value) VALUES('sync_lineage',?)", [randomUUID()]);
    } finally { await restored.close(); }
  }
  static async open(directory: string): Promise<HubDatabase> {
    const incomplete = await lstat(path.join(directory, "restore.incomplete.json")).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
    if (incomplete) throw new Error("hub_restore_incomplete");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const file = path.join(directory, "hub.sqlite");
    const db = await new Promise<sqlite3.Database>((resolve, reject) => {
      const connection = new sqlite3.Database(file, (error) => error ? reject(error) : resolve(connection));
    });
    const result = new HubDatabase(db, file);
    try {
      // Permissions are fixed BEFORE enabling WAL so sidecars inherit 0600.
      await chmod(file, 0o600);
      if (!await result.get("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1")) await result.exec("PRAGMA auto_vacuum=INCREMENTAL");
      await result.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA journal_size_limit=8388608;");
      await result.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      const version = await result.get<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'");
      if (version && !["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25"].includes(version.value)) throw new Error("unsupported_hub_schema_version");
      await result.transaction(async () => {
        await result.exec(SCHEMA);
        if (version && Number(version.value) < 21) {
          // Extend the policy CHECK atomically; existing runs keep their mode.
          await result.exec(`ALTER TABLE group_discussion_settings RENAME TO group_discussion_settings_v20;
            ${GROUP_SETTINGS_SCHEMA};
            INSERT INTO group_discussion_settings SELECT * FROM group_discussion_settings_v20;
            DROP TABLE group_discussion_settings_v20;`);
        }
        await retainPushReceipts(result);
        // A rolled-back Hub cannot remove optional rows when recalling a reply.
        // Reconcile its tombstones when returning to a scopes-aware host.
        await result.run("DELETE FROM run_journal_scoped WHERE message_id IN (SELECT id FROM messages WHERE status='deleted')");
        // Additive: older writers name their columns, so queued rows simply lack a class.
        const pushColumns = await result.all<{ name: string }>("PRAGMA table_info(push_outbox)");
        if (!pushColumns.some(c => c.name === "notice_class")) await result.exec("ALTER TABLE push_outbox ADD COLUMN notice_class TEXT");
        const botColumns = await result.all<{ name: string }>("PRAGMA table_info(bots)");
        if (!botColumns.some(c => c.name === "deleted_at")) await result.exec("ALTER TABLE bots ADD COLUMN deleted_at INTEGER");
        if (!botColumns.some(c => c.name === "role")) await result.exec("ALTER TABLE bots ADD COLUMN role TEXT NOT NULL DEFAULT ''");
        const messageColumns = await result.all<{ name: string }>("PRAGMA table_info(messages)");
        if (!messageColumns.some(c => c.name === "bot_source_json")) await result.exec("ALTER TABLE messages ADD COLUMN bot_source_json TEXT");
        if (!messageColumns.some(c => c.name === "discussion_json")) await result.exec("ALTER TABLE messages ADD COLUMN discussion_json TEXT");
        // Additive receipt survives context retirement and old writers, which
        // name their columns. It contains a digest/omission reason, never content.
        if (!messageColumns.some(c => c.name === "workbench_receipt_json")) await result.exec("ALTER TABLE messages ADD COLUMN workbench_receipt_json TEXT");
        const turnColumns = await result.all<{ name: string }>("PRAGMA table_info(group_discussion_turns)");
        if (!turnColumns.some(c => c.name === "attention")) await result.exec("ALTER TABLE group_discussion_turns ADD COLUMN attention TEXT");
        if (!turnColumns.some(c => c.name === "started")) await result.exec("ALTER TABLE group_discussion_turns ADD COLUMN started INTEGER NOT NULL DEFAULT 0");
        if (!messageColumns.some((c) => c.name === "mentions_json")) await result.exec("ALTER TABLE messages ADD COLUMN mentions_json TEXT NOT NULL DEFAULT '[]'");
        if (!messageColumns.some((c) => c.name === "forwarded_json")) await result.exec("ALTER TABLE messages ADD COLUMN forwarded_json TEXT");
        if (!messageColumns.some((c) => c.name === "preview_url")) await result.exec("ALTER TABLE messages ADD COLUMN preview_url TEXT");
        if (!messageColumns.some((c) => c.name === "link_preview_json")) await result.exec("ALTER TABLE messages ADD COLUMN link_preview_json TEXT");
        if (!messageColumns.some((c) => c.name === "preview_style")) await result.exec("ALTER TABLE messages ADD COLUMN preview_style TEXT");
        // The 500 ms preview sweep shares the send/auth queue. Index only its
        // pending candidates so an empty sweep never scans historical bodies.
        // Create after the additive columns for old stores; the implicit rowid
        // suffix preserves the sweep's created_at,rowid ordering.
        await result.exec(`CREATE INDEX IF NOT EXISTS messages_pending_link_previews ON messages(created_at)
          WHERE author_type='user' AND status IN ('complete','error')
          AND preview_url IS NOT NULL AND preview_url!='' AND link_preview_json IS NULL`);
        const conversationColumns = await result.all<{ name: string }>("PRAGMA table_info(conversations)");
        if (!conversationColumns.some((c) => c.name === "parent_id")) await result.exec("ALTER TABLE conversations ADD COLUMN parent_id TEXT REFERENCES conversations(id)");
        if (!conversationColumns.some((c) => c.name === "binding_id")) await result.exec("ALTER TABLE conversations ADD COLUMN binding_id TEXT");
        if (!conversationColumns.some((c) => c.name === "hidden")) await result.exec("ALTER TABLE conversations ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
        if (!conversationColumns.some((c) => c.name === "ticket_json")) await result.exec("ALTER TABLE conversations ADD COLUMN ticket_json TEXT");
        if (version && Number(version.value) < 11) {
          // Old tombstones have empty blocks. Read their own retained events
          // in small pages, using the protocol's attachment traversal so button
          // values/metadata named "attachmentId" cannot retire unrelated drafts.
          let after = 0;
          for (;;) {
            const rows = await result.all<{ row_key: number; conversation_id: string; payload_json: string }>(`SELECT e.rowid AS row_key,e.conversation_id,e.payload_json FROM events e
              WHERE e.rowid>? AND e.kind IN ('message.created','message.updated')
              AND EXISTS(SELECT 1 FROM messages m WHERE m.id=json_extract(e.payload_json,'$.id') AND m.conversation_id=e.conversation_id AND m.status='deleted')
              ORDER BY e.rowid LIMIT 16`, [after]);
            if (!rows.length) break;
            for (const row of rows) {
              const message = messageSchema.parse(JSON.parse(row.payload_json));
              const ids = new Set(messageAttachmentIds(message.blocks));
              if (message.linkPreview?.imageAttachmentId) ids.add(message.linkPreview.imageAttachmentId);
              for (const id of ids) await result.run(`INSERT OR IGNORE INTO retired_attachments(attachment_id)
                SELECT a.id FROM attachments a WHERE a.id=? AND a.conversation_id=?
                AND NOT EXISTS(SELECT 1 FROM message_attachments r WHERE r.attachment_id=a.id)`, [id, row.conversation_id]);
              after = row.row_key;
            }
          }
        }
        if (Number(version?.value ?? 0) < 12) {
          const devices = await result.all<{ id: string; push_json: string }>("SELECT id,push_json FROM devices WHERE revoked=0 AND push_json IS NOT NULL");
          for (const device of devices) {
            let value: unknown; try { value = JSON.parse(device.push_json); } catch { continue; }
            const sub = pushSubscriptionSchema.safeParse(value);
            if (sub.success) await result.run("INSERT OR IGNORE INTO push_bindings VALUES(?,?,?)", [device.id, sub.data.provider, randomUUID()]);
          }
        }
        const deliveryColumns = await result.all<{ name: string }>("PRAGMA table_info(deliveries)");
        if (!deliveryColumns.some(c => c.name === "queue_position")) {
          await result.exec("ALTER TABLE deliveries ADD COLUMN queue_position INTEGER NOT NULL DEFAULT 0; ALTER TABLE deliveries ADD COLUMN dispatched INTEGER NOT NULL DEFAULT 0;");
          // The old Hub may already have sent every pending input to a worker.
          // Preserve that uncertainty: migration must never make it editable.
          await result.exec("UPDATE deliveries SET queue_position=rowid,dispatched=1");
        }
        if (!deliveryColumns.some(c => c.name === "queue_paused")) {
          await result.exec("ALTER TABLE deliveries ADD COLUMN queue_paused INTEGER NOT NULL DEFAULT 0 CHECK(queue_paused IN (0,1))");
        }
        await result.exec("CREATE INDEX IF NOT EXISTS deliveries_queue ON deliveries(bot_id,status,queue_position)");
        // Appending must not scan all historical deliveries of a long-lived
        // Bot just to find the last queue position (status is unconstrained).
        await result.exec("CREATE INDEX IF NOT EXISTS deliveries_queue_tail ON deliveries(bot_id,queue_position)");
        // FTS5 cannot index UNINDEXED message_id. Keep its integer key aligned
        // with messages so each streaming update is a point lookup. Older
        // compatible hosts can still write this index; check once at open and
        // repair their auto-assigned keys, without changing message history.
        if (await result.get("SELECT 1 FROM messages_fts f LEFT JOIN messages m ON m.rowid=f.rowid WHERE m.id IS NOT f.message_id LIMIT 1")) {
          await result.exec(`CREATE TEMP TABLE fts_rekey AS SELECT m.rowid AS id,f.message_id,f.conversation_id,f.body FROM messages_fts f JOIN messages m ON m.id=f.message_id;
            DELETE FROM messages_fts;
            INSERT INTO messages_fts(rowid,message_id,conversation_id,body) SELECT id,message_id,conversation_id,body FROM fts_rekey;
            DROP TABLE fts_rekey;`);
        }
        // 18: Agent Bus run inputs are ordinary queued messages whose meaning
        // lives in agent_bus_runs. An older Hub would dispatch them as chat
        // (or as a pending question's answer), so it must refuse this state
        // and roll back only through the existing backup/restore path.
        // 19: per-slot Agent Bus tasks live inside strict configuration/snapshot JSON.
        // Older Hubs must refuse this state rather than silently losing tasks.
        // 20: group discussion inputs are ordinary queued messages whose meaning
        // lives in group_discussion_turns, and unmentioned group messages are no
        // longer broadcast. A schema-19 Hub would dispatch them as plain chat.
        // 21: parallel group replies add a policy value older Hubs cannot read.
        // 22: sparse update-history reclamation adds a durable replay floor.
        // Old Hosts using MIN(seq) would silently skip reclaimed updates; they
        // must refuse this state. Activity coverage becomes durable metadata.
        // 23: dispatcher tickets run in hidden worker conversations. An older
        // Host would list them, count them as unread and notify every reply.
        // 24: a ticket's helper attempt returns to its parent through the
        // assistance ledger. An older Host would settle the helper's answer as
        // the ticket result and drop the parent's continuation.
        // 25: per-message pause must survive restarts. Older Hosts would ignore
        // this bit and dispatch held inputs, so downgrades need a state backup.
        await result.run("INSERT OR REPLACE INTO meta VALUES('schema_version','25')");
      });
      return result;
    } catch (error) { await result.close().catch(() => undefined); throw error; }
  }
  run(sql: string, params: SqlValue[] = []): Promise<{ changes: number; lastID: number }> {
    return new Promise((resolve, reject) => this.db.run(sql, params, function (error) { error ? reject(error) : resolve({ changes: this.changes, lastID: this.lastID }); }));
  }
  get<T>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
    return new Promise((resolve, reject) => this.db.get(sql, params, (error, row: T | undefined) => error ? reject(error) : resolve(row)));
  }
  all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => this.db.all(sql, params, (error, rows: T[]) => error ? reject(error) : resolve(rows)));
  }
  exec(sql: string): Promise<void> { return new Promise((resolve, reject) => this.db.exec(sql, (error) => error ? reject(error) : resolve())); }
  // Store operations on this connection enter this queue. Independent snapshot
  // readers use their own connections; reads here must never see another
  // request's uncommitted transaction.
  serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
  transaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try { const result = await operation(); await this.exec("COMMIT"); return result; }
      catch (error) { await this.exec("ROLLBACK"); throw error; }
    });
  }
  /** Background derived-state work registers here and is stopped before close. */
  beforeClose(hook: () => Promise<void>): () => void { this.closing.add(hook); return () => { this.closing.delete(hook); }; }
  async close(): Promise<void> {
    for (const hook of [...this.closing]) await hook().catch(() => undefined);
    await this.tail; await new Promise<void>((resolve, reject) => this.db.close((error) => error ? reject(error) : resolve()));
  }
}

const GROUP_SETTINGS_SCHEMA = "CREATE TABLE IF NOT EXISTS group_discussion_settings (group_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('mentions','parallel','sequential','independent')), order_json TEXT NOT NULL, max_rounds INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL)";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run_journal (
 message_id TEXT NOT NULL, run_id TEXT NOT NULL, bot_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(message_id,run_id,seq)
);
CREATE INDEX IF NOT EXISTS run_journal_expiry ON run_journal(updated_at);

-- Optional negotiated evidence is additive to schema 15. Older Hubs ignore
-- this table and continue parsing only strict v1 payloads in run_journal.
CREATE TABLE IF NOT EXISTS run_journal_scoped (
 message_id TEXT NOT NULL, run_id TEXT NOT NULL, bot_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, scope_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(message_id,run_id,seq)
);
CREATE INDEX IF NOT EXISTS run_journal_scoped_expiry ON run_journal_scoped(updated_at);

-- Agent Bus workspaces (schema 18). No foreign keys to core tables; the
-- version bump, not the table layout, keeps older Hubs from misreading them.
CREATE TABLE IF NOT EXISTS agent_buses (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, revision TEXT NOT NULL, config_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agent_bus_requests (owner_id TEXT NOT NULL, request_id TEXT NOT NULL, kind TEXT NOT NULL, payload_hash TEXT NOT NULL, result_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner_id,request_id));
CREATE TABLE IF NOT EXISTS agent_bus_runs (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, coordinator_id TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE, snapshot_json TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, error TEXT, stop_requested INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER);
CREATE INDEX IF NOT EXISTS agent_bus_runs_workspace ON agent_bus_runs(workspace_id,created_at);
CREATE INDEX IF NOT EXISTS agent_bus_runs_status ON agent_bus_runs(status);
CREATE TABLE IF NOT EXISTS agent_bus_stages (run_id TEXT NOT NULL, id TEXT NOT NULL, bot_id TEXT NOT NULL, conversation_id TEXT NOT NULL, status TEXT NOT NULL, message_id TEXT, started_at INTEGER NOT NULL, finished_at INTEGER, error TEXT, seq INTEGER NOT NULL, PRIMARY KEY(run_id,id));

-- Group discussion modes (schema 20). A root group without a settings row
-- uses the ordinary mention mode. Runs and turns are keyed by the ordinary
-- queued input message; their meaning is never inferred from message text.
${GROUP_SETTINGS_SCHEMA};
CREATE TABLE IF NOT EXISTS group_discussions (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, conversation_id TEXT NOT NULL, topic_message_id TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, settings_revision TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('sequential','independent')), participants_json TEXT NOT NULL, left_json TEXT NOT NULL DEFAULT '[]', max_rounds INTEGER NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('blind','discussion')), round INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','pausing','paused','ending','completed','ended','failed')), pause_reason TEXT, pause_turn_id TEXT, outcome TEXT, conclusion TEXT, proposal_json TEXT, proposal_seq INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS group_discussions_active ON group_discussions(group_id) WHERE status IN ('running','pausing','paused','ending');
CREATE INDEX IF NOT EXISTS group_discussions_conversation ON group_discussions(conversation_id,created_at);
CREATE TABLE IF NOT EXISTS group_discussion_turns (id TEXT PRIMARY KEY, discussion_id TEXT NOT NULL, seq INTEGER NOT NULL, round INTEGER NOT NULL, position INTEGER NOT NULL, attempt INTEGER NOT NULL, bot_id TEXT NOT NULL, blind INTEGER NOT NULL, input_message_id TEXT NOT NULL UNIQUE, context_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','settled')), result TEXT, acknowledged INTEGER NOT NULL DEFAULT 0, report_text TEXT, report_truncated INTEGER NOT NULL DEFAULT 0, stance_json TEXT, stop_requested INTEGER NOT NULL DEFAULT 0, stop_sent INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, settled_at INTEGER, UNIQUE(discussion_id,seq), UNIQUE(discussion_id,round,position,attempt));
CREATE INDEX IF NOT EXISTS group_discussion_turns_active ON group_discussion_turns(bot_id,state);
CREATE TABLE IF NOT EXISTS group_discussion_requests (user_id TEXT NOT NULL, request_id TEXT NOT NULL, kind TEXT NOT NULL, payload_hash TEXT NOT NULL, result_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(user_id,request_id));

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta VALUES ('schema_version', '1');
CREATE TABLE IF NOT EXISTS profile_avatars (kind TEXT NOT NULL CHECK(kind IN ('user','bot','group')), target_id TEXT NOT NULL, revision INTEGER NOT NULL, png BLOB, PRIMARY KEY(kind,target_id));
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','member')));
CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, platform TEXT NOT NULL, public_key TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, push_json TEXT);
CREATE TABLE IF NOT EXISTS device_preferences (device_id TEXT PRIMARY KEY REFERENCES devices(id), preferences_json TEXT NOT NULL);
-- Optional notification customization. Kept apart from device_preferences:
-- same-schema older Hubs strictly parse that JSON and ignore this table.
CREATE TABLE IF NOT EXISTS device_notification_options (device_id TEXT PRIMARY KEY REFERENCES devices(id), options_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS push_bindings (device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE, provider TEXT NOT NULL, revision TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pairing_requests (code_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, platform TEXT NOT NULL, public_key TEXT NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, name TEXT NOT NULL, secret_hash TEXT NOT NULL, engine TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', effort TEXT NOT NULL DEFAULT '', online INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS managed_bots (bot_id TEXT PRIMARY KEY REFERENCES bots(id), owner_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL, specification_json TEXT NOT NULL, UNIQUE(owner_id,request_id));
CREATE TABLE IF NOT EXISTS bot_grants (user_id TEXT NOT NULL REFERENCES users(id), bot_id TEXT NOT NULL REFERENCES bots(id), PRIMARY KEY(user_id,bot_id));
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('direct','group')), title TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), session_id TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, client_action_id TEXT, UNIQUE(owner_id,client_action_id));
CREATE TABLE IF NOT EXISTS conversation_members (conversation_id TEXT NOT NULL REFERENCES conversations(id), member_type TEXT NOT NULL CHECK(member_type IN ('user','bot')), member_id TEXT NOT NULL, muted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(conversation_id,member_type,member_id));
CREATE TABLE IF NOT EXISTS events (conversation_id TEXT NOT NULL REFERENCES conversations(id), seq INTEGER NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(conversation_id,seq));
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), author_id TEXT NOT NULL, author_type TEXT NOT NULL, blocks_json TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, client_msg_id TEXT, reply_to TEXT, created_at INTEGER NOT NULL, UNIQUE(author_id,client_msg_id));
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(message_id UNINDEXED, conversation_id UNINDEXED, body, tokenize='trigram');
CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), owner_id TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, name TEXT NOT NULL, stored_name TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS retired_attachments (attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS upload_chunks (attachment_id TEXT NOT NULL REFERENCES attachments(id), chunk_index INTEGER NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(attachment_id,chunk_index));
CREATE TABLE IF NOT EXISTS message_deletions (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, deleted_at INTEGER NOT NULL, PRIMARY KEY(user_id,message_id));
CREATE INDEX IF NOT EXISTS message_deletions_message ON message_deletions(message_id,user_id);
CREATE TABLE IF NOT EXISTS message_attachments (message_id TEXT NOT NULL REFERENCES messages(id), attachment_id TEXT NOT NULL REFERENCES attachments(id), PRIMARY KEY(message_id,attachment_id));
CREATE INDEX IF NOT EXISTS message_attachments_attachment ON message_attachments(attachment_id);
-- Keep authority in its original meta representation. This optional index
-- records only permits created with known provenance; it is not a receipt TTL.
-- No attachment FK: used permits must survive physical GC for duplicate sends.
CREATE TABLE IF NOT EXISTS bot_message_upload_permits (permit_key TEXT PRIMARY KEY REFERENCES meta(key) ON DELETE CASCADE, attachment_id TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0 CHECK(used IN (0,1)));
CREATE INDEX IF NOT EXISTS bot_message_upload_permits_attachment ON bot_message_upload_permits(attachment_id);
CREATE INDEX IF NOT EXISTS bot_message_upload_permits_unused ON bot_message_upload_permits(used,attachment_id);
-- Old schema19-compatible writers also insert message_attachments, so rollback
-- cannot accidentally classify a consumed permit as an abandoned upload.
CREATE TRIGGER IF NOT EXISTS bot_message_upload_permits_used AFTER INSERT ON message_attachments
 BEGIN UPDATE bot_message_upload_permits SET used=1 WHERE attachment_id=NEW.attachment_id AND used=0; END;
CREATE TABLE IF NOT EXISTS reads (user_id TEXT NOT NULL REFERENCES users(id), conversation_id TEXT NOT NULL REFERENCES conversations(id), seq INTEGER NOT NULL, PRIMARY KEY(user_id,conversation_id));
CREATE TABLE IF NOT EXISTS actions (user_id TEXT NOT NULL, client_action_id TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(user_id,client_action_id));
CREATE TABLE IF NOT EXISTS action_deliveries (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_action_id TEXT NOT NULL, bot_id TEXT NOT NULL REFERENCES bots(id), conversation_id TEXT NOT NULL REFERENCES conversations(id), params_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result_json TEXT, created_at INTEGER NOT NULL, UNIQUE(user_id,client_action_id), FOREIGN KEY(user_id,client_action_id) REFERENCES actions(user_id,client_action_id));
CREATE TABLE IF NOT EXISTS deliveries (message_id TEXT NOT NULL REFERENCES messages(id), bot_id TEXT NOT NULL REFERENCES bots(id), status TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(message_id,bot_id));
CREATE TABLE IF NOT EXISTS prompt_queue_workers (bot_id TEXT PRIMARY KEY REFERENCES bots(id), supported INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS conversation_batch_requests (user_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, receipt_json TEXT NOT NULL, PRIMARY KEY(user_id,request_id));
CREATE TABLE IF NOT EXISTS prompt_queue_mutations (user_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, PRIMARY KEY(user_id,request_id));
CREATE TABLE IF NOT EXISTS push_outbox (id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), conversation_id TEXT NOT NULL, event_seq INTEGER NOT NULL, payload_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', next_at INTEGER NOT NULL, UNIQUE(device_id,conversation_id,event_seq));
CREATE INDEX IF NOT EXISTS push_outbox_pending ON push_outbox(status,next_at);
CREATE INDEX IF NOT EXISTS push_outbox_device_pending ON push_outbox(device_id,status);
CREATE TABLE IF NOT EXISTS push_receipts (id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS push_receipts_device ON push_receipts(device_id);
CREATE INDEX IF NOT EXISTS push_receipts_message ON push_receipts(message_id);
-- Compatible older writers only know the outbox. They must still respect a
-- compact receipt after this host has retired the original transport payload.
CREATE TRIGGER IF NOT EXISTS push_outbox_receipt_guard BEFORE INSERT ON push_outbox
 WHEN EXISTS(SELECT 1 FROM push_receipts WHERE id=NEW.id)
 BEGIN SELECT RAISE(IGNORE); END;
CREATE INDEX IF NOT EXISTS action_deliveries_pending ON action_deliveries(bot_id,status,created_at);
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT, kind TEXT NOT NULL, detail_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,created_at);
-- Ticket settlement checks one input's replies repeatedly, not the worker
-- conversation's full history. Keep the result order in the same small range.
CREATE INDEX IF NOT EXISTS messages_bot_replies ON messages(conversation_id,reply_to,author_id,created_at,id) WHERE author_type='bot' AND status!='deleted';
-- Personal history is ordered by SQLite insertion order, not created_at. The
-- implicit rowid suffix avoids sorting every historical body for each page.
CREATE INDEX IF NOT EXISTS messages_personal_history ON messages(conversation_id) WHERE status!='deleted';
CREATE INDEX IF NOT EXISTS attachments_conversation ON attachments(conversation_id);
-- Dispatcher Bots: owner-editable settings, the ticket ledger, the Host-wide
-- engine availability learned from worker failures and hidden engine workers.
CREATE TABLE IF NOT EXISTS dispatcher_settings (bot_id TEXT PRIMARY KEY REFERENCES bots(id), settings_json TEXT NOT NULL, revision TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS dispatch_tickets (id TEXT PRIMARY KEY, dispatcher_bot_id TEXT NOT NULL REFERENCES bots(id), conversation_id TEXT NOT NULL REFERENCES conversations(id), request_id TEXT NOT NULL, title TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0, attempts_json TEXT NOT NULL DEFAULT '[]', result TEXT, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(dispatcher_bot_id,request_id));
CREATE INDEX IF NOT EXISTS dispatch_tickets_status ON dispatch_tickets(dispatcher_bot_id,status);
CREATE INDEX IF NOT EXISTS dispatch_tickets_sweep ON dispatch_tickets(status,id);
-- Additive list visibility only; retained tickets keep execution history and request deduplication.
CREATE TABLE IF NOT EXISTS dispatch_ticket_removals (ticket_id TEXT PRIMARY KEY REFERENCES dispatch_tickets(id) ON DELETE CASCADE, removed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS dispatch_requests (actor_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(actor_id,request_id));
CREATE TABLE IF NOT EXISTS engine_health (engine TEXT PRIMARY KEY, state TEXT NOT NULL, until INTEGER, reason TEXT, updated_at INTEGER NOT NULL);
-- Each dispatcher's hidden worker Bot per engine CLI, created on first use.
CREATE TABLE IF NOT EXISTS dispatch_workers (dispatcher_bot_id TEXT NOT NULL REFERENCES bots(id), engine TEXT NOT NULL, bot_id TEXT NOT NULL REFERENCES bots(id), PRIMARY KEY(dispatcher_bot_id,engine));
-- A worker's bounded request for another model inside its own ticket. Helper
-- and continuation inputs are ordinary attempts; only this ledger relates them.
CREATE TABLE IF NOT EXISTS dispatch_assists (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES dispatch_tickets(id), worker_bot_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
  parent_attempt_id TEXT NOT NULL, parent_json TEXT NOT NULL, engine TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL, text TEXT NOT NULL, note TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('requested','starting','running','returned','cancelled')), child_attempt_id TEXT, continuation_attempt_id TEXT, outcome TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(worker_bot_id,request_id));
CREATE INDEX IF NOT EXISTS dispatch_assists_ticket ON dispatch_assists(ticket_id,created_at);
CREATE INDEX IF NOT EXISTS dispatch_assists_parent ON dispatch_assists(parent_attempt_id);
CREATE INDEX IF NOT EXISTS dispatch_assists_child ON dispatch_assists(child_attempt_id) WHERE child_attempt_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS dispatch_assists_continuation ON dispatch_assists(continuation_attempt_id) WHERE continuation_attempt_id IS NOT NULL;
-- Assistance allowed since the ticket's latest dispatch; continuations keep it.
CREATE TABLE IF NOT EXISTS dispatch_assist_windows (ticket_id TEXT PRIMARY KEY REFERENCES dispatch_tickets(id), attempt_id TEXT NOT NULL, remaining INTEGER NOT NULL);
${MESSAGE_ACTIVITY_SCHEMA}
${EVENT_HISTORY_SCHEMA}
`;
