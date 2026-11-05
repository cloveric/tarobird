import { EventHistoryRetention, type EventHistoryPolicy } from "./event-history.js";
import { reclaimDatabasePages } from "./storage-space.js";
import { RUN_RETENTION_MS } from "../client-protocol/run.js";
import { chmod, copyFile, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { HubStore } from "./store.js";
import { HubDatabase } from "./database.js";
import { withFileMutex } from "../state/file-mutex.js";
import { LOW_TRUST_AUDIT_KINDS } from "./audit.js";
import { retainPushReceipts } from "./push/receipts.js";
import { automaticSnapshots, readBackupPolicy } from "./backup-settings.js";

export class HubMaintenance {
  private readonly eventHistory: EventHistoryRetention;
  constructor(readonly store: HubStore, readonly directory: string, policy?: EventHistoryPolicy) { this.eventHistory = new EventHistoryRetention(store, policy); }
  async pruneEventHistory(now = Date.now()) {
    const result = await this.eventHistory.run(now);
    await reclaimDatabasePages(this.store.db);
    return result;
  }
  async backupScheduleKey(now = Date.now()): Promise<string> {
    const policy = await this.store.db.serial(() => readBackupPolicy(this.store.db));
    return `${new Date(now).toISOString().slice(0, 10)}:${policy.revision}`;
  }
  async backup(destination: string): Promise<void> {
    await this.store.flushAudit();
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    // Include everything queued before this call, but do not hold the Hub's
    // queue while copying: a separate READONLY connection reads one consistent
    // WAL snapshot (committed frames included, no checkpoint needed) while
    // other requests continue. VACUUM INTO refuses an existing nonempty target.
    await this.store.db.serial(async () => undefined);
    const snapshot = await HubDatabase.snapshot(this.store.db.file);
    try {
      await snapshot.exec("PRAGMA busy_timeout=5000");
      await snapshot.run("VACUUM INTO ?", [destination]);
      await chmod(destination, 0o600);
    } finally { await snapshot.close(); }
  }
  /** Own only the named automatic snapshots; manual/full exports and legacy
   * snapshots have no automatic deletion policy. Publish before pruning unless
   * the owner explicitly chose zero (disable and remove automatic snapshots). */
  async dailyBackup(now = Date.now()): Promise<void> {
    const day = new Date(now).toISOString().slice(0, 10);
    await withFileMutex(path.join(this.directory, "daily-backup"), async () => {
      const { retentionDays } = await this.store.db.serial(() => readBackupPolicy(this.store.db));
      const directory = path.join(this.directory, "backups");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!(await lstat(directory)).isDirectory()) throw new Error("backup_directory_invalid");
      const name = `auto-${day}.sqlite`, destination = path.join(directory, name);
      const existing = retentionDays ? await lstat(destination).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; }) : undefined;
      let valid = false;
      if (existing) {
        if (!existing.isFile()) throw new Error("automatic_backup_invalid");
        const snapshot = await HubDatabase.snapshot(destination);
        try {
          const result = await snapshot.get<{ quick_check: string }>("PRAGMA quick_check");
          valid = result?.quick_check === "ok";
        } catch (error) {
          if (!["SQLITE_NOTADB", "SQLITE_CORRUPT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        } finally { await snapshot.close(); }
      }
      if (retentionDays && !valid) {
        const temporary = path.join(directory, `.${name}-${randomUUID()}.tmp`);
        // The bad automatic snapshot stays in place if its replacement fails;
        // only publish after a complete consistent snapshot has been written.
        try { await this.backup(temporary); await rename(temporary, destination); }
        finally { await rm(temporary, { force: true }); }
      }
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !/^\.auto-\d{4}-\d{2}-\d{2}\.sqlite-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/.test(entry.name)) continue;
        const target = path.join(directory, entry.name);
        if ((await lstat(target)).mtimeMs < now - 86400_000) await rm(target);
      }
      const earliest = new Date(Date.parse(`${day}T00:00:00.000Z`) - (retentionDays - 1) * 86400_000).toISOString().slice(0, 10);
      for (const snapshot of await automaticSnapshots(this.directory)) {
        if (retentionDays === 0 || snapshot.day < earliest) await rm(path.join(directory, snapshot.name), { force: true });
      }
    });
  }
  /** Bound audit history only; message, event, attachment and trust tables are
   * deliberately outside this retention policy. Run before the daily snapshot. */
  async pruneAudit(now = Date.now()): Promise<number> {
    await this.store.flushAudit();
    return this.store.db.transaction(async () => {
      let removed = (await this.store.db.run("DELETE FROM audit_log WHERE at<?", [now - 90 * 24 * 60 * 60_000])).changes;
      const placeholders = LOW_TRUST_AUDIT_KINDS.map(() => "?").join(",");
      // Rejected traffic must never evict approval/revocation receipts by
      // filling their quota. Together these partitions retain <=100000 rows.
      for (const [operator, limit] of [["IN", 10000], ["NOT IN", 90000]] as const) {
        removed += (await this.store.db.run(`DELETE FROM audit_log WHERE kind ${operator} (${placeholders}) AND id NOT IN (SELECT id FROM audit_log WHERE kind ${operator} (${placeholders}) ORDER BY id DESC LIMIT ?)`, [...LOW_TRUST_AUDIT_KINDS, ...LOW_TRUST_AUDIT_KINDS, limit])).changes;
      }
      return removed;
    });
  }
  async pruneRunDetails(now = Date.now()): Promise<number> {
    return this.store.db.transaction(async () => {
      const root = await this.store.db.run("DELETE FROM run_journal WHERE updated_at<?", [now - RUN_RETENTION_MS]);
      const scoped = await this.store.db.run("DELETE FROM run_journal_scoped WHERE updated_at<? OR message_id IN (SELECT id FROM messages WHERE status='deleted')", [now - RUN_RETENTION_MS]);
      return root.changes + scoped.changes;
    });
  }
  /** Transport rows are operational work, not the durable request receipts.
   * Retain seven days from admission/last push attempt; pending work and the
   * actions/Bot-message idempotency receipts are never expired here. */
  async pruneDeliveryHistory(now = Date.now()): Promise<number> {
    return this.store.db.transaction(async () => {
      const before = now - 7 * 86400_000;
      await retainPushReceipts(this.store.db, before);
      const pushes = await this.store.db.run("DELETE FROM push_outbox WHERE status!='pending' AND next_at<?", [before]);
      // Revocation is permanent for this device identity. Message tombstones
      // are deliberately retained: they are not physical deletion and an old
      // compatible worker can still publish a later version of the message.
      await this.store.db.run("DELETE FROM push_receipts WHERE device_id IN (SELECT id FROM devices WHERE revoked=1)");
      const actions = await this.store.db.run("DELETE FROM action_deliveries WHERE status='complete' AND created_at<?", [before]);
      return pushes.changes + actions.changes;
    });
  }
  async export(destination: string): Promise<{ messages: number; attachments: number }> {
    return withFileMutex(path.join(this.directory, "maintenance"), async () => {
    await mkdir(destination, { recursive: false, mode: 0o700 });
    const dbFile = path.join(destination, "hub.sqlite"); await this.backup(dbFile);
    await mkdir(path.join(destination, "attachments"), { mode: 0o700 });
    const snapshot = await HubDatabase.snapshot(dbFile);
    let attachments: { id: string }[]; let messages: { count: number } | undefined;
    try { attachments = await snapshot.all("SELECT a.id FROM attachments a WHERE a.complete=1 AND NOT EXISTS(SELECT 1 FROM retired_attachments r WHERE r.attachment_id=a.id)"); messages = await snapshot.get("SELECT COUNT(*) AS count FROM messages"); }
    finally { await snapshot.close(); }
    for (const { id } of attachments) { const target = path.join(destination, "attachments", `${id}.blob`); await copyFile(path.join(this.directory, "attachments", `${id}.blob`), target); await chmod(target, 0o600); }
    await this.store.audit("hub.exported", "local-owner", { attachments: attachments.length });
    return { messages: messages?.count ?? 0, attachments: attachments.length };
    });
  }
  async collectOrphans(olderThan = Date.now() - 7 * 24 * 60 * 60_000): Promise<number> {
    return withFileMutex(path.join(this.directory, "maintenance"), async () => {
    const ids = await this.store.db.transaction(async () => {
      const rows = await this.store.db.all<{ id: string }>("SELECT id FROM attachments a WHERE created_at<? AND NOT EXISTS(SELECT 1 FROM message_attachments m WHERE m.attachment_id=a.id)", [olderThan]);
      // Persist retirement before touching files. New messages/uploads cannot
      // acquire these IDs; a failed unlink retains the row for the next pass.
      for (const { id } of rows) await this.store.db.run("INSERT OR IGNORE INTO retired_attachments VALUES(?)", [id]);
      return rows.map((r) => r.id);
    });
    const directory = path.join(this.directory, "attachments");
    const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    const fileId = (file: string) => /^(att_[A-Za-z0-9_-]+)\.(?:blob|[0-9]+\.chunk)(?:\.tmp)?$/.exec(file)?.[1];
    let removed = 0;
    for (const id of ids) {
      try {
        for (const file of files) if (fileId(file) === id) await rm(path.join(directory, file), { force: true });
        await this.store.db.transaction(async () => {
          await this.store.db.run("DELETE FROM upload_chunks WHERE attachment_id=?", [id]);
          await this.store.db.run("DELETE FROM attachments WHERE id=? AND EXISTS(SELECT 1 FROM retired_attachments r WHERE r.attachment_id=attachments.id) AND NOT EXISTS(SELECT 1 FROM message_attachments m WHERE m.attachment_id=attachments.id)", [id]);
        });
        removed++;
      } catch (error) { await this.store.audit("attachment.gc_retry", "system", { id, code: (error as NodeJS.ErrnoException).code ?? "file_cleanup_failed" }); }
    }
    // A crash after complete=1 but before unlinking upload chunks must not
    // retain a second copy forever. Only exact complete attachment IDs qualify;
    // incomplete/resumable uploads and final blobs are deliberately excluded.
    const complete = new Set((await this.store.db.serial(() => this.store.db.all<{ id: string }>("SELECT id FROM attachments WHERE complete=1"))).map(row => row.id));
    for (const file of files) {
      const match = /^(att_[A-Za-z0-9_-]+)\.[0-9]+\.chunk$/.exec(file);
      if (match && complete.has(match[1]!)) await rm(path.join(directory, file), { force: true }).catch(() => undefined);
      const id = fileId(file);
      if (id) await this.store.db.serial(async () => {
        // Recover old installations' DB-first leftovers. New uploads insert
        // their row before writing; recheck age and ownership under the guard.
        if (await this.store.db.get("SELECT 1 FROM attachments WHERE id=?", [id])) return;
        const target = path.join(directory, file), metadata = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
        if (metadata?.isFile() && metadata.mtimeMs < olderThan) await rm(target, { force: true }).catch(() => undefined);
      });
    }
    // Only new permits explicitly known never to have admitted a message can
    // expire with a physically removed upload. A used permit is still checked
    // on a duplicate send even after its message became a tombstone; legacy
    // hashed permits have no recoverable attachment/consumption provenance.
    await this.store.db.transaction(() => this.store.db.run(`DELETE FROM meta WHERE key IN (
      SELECT p.permit_key FROM bot_message_upload_permits p WHERE p.used=0
      AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.id=p.attachment_id))`));
    return removed;
    });
  }
}
