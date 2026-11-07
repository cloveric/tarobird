import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, link, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { CHUNK_BYTES, MAX_FILE_BYTES, fileSizeSchema, uploadSchema, type Upload, type ClientFrame } from "../client-protocol/index.js";
import { HubError, HubStore, newId, type AttachmentRow } from "./store.js";
import { withFileMutex } from "../state/file-mutex.js";

/** Attachment ID of a blob, upload chunk or temporary file in the store. */
export function attachmentFileId(file: string): string | undefined { return /^(att_[A-Za-z0-9_-]+)\.(?:blob|[0-9]+\.chunk)(?:\.tmp)?$/.exec(file)?.[1]; }

export class HubAttachments {
  private tails = new Map<string, Promise<unknown>>();
  readonly directory: string;
  readonly maxFileBytes: number;
  constructor(readonly store: HubStore, stateDir: string, maxFileBytes = MAX_FILE_BYTES) {
    this.directory = path.join(stateDir, "attachments"); this.maxFileBytes = fileSizeSchema.parse(maxFileBytes);
  }
  private checkSize(size: number): void { if (size > this.maxFileBytes) throw new HubError("file_too_large", 413); }
  async initialize(): Promise<void> { await mkdir(this.directory, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700); }
  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(id) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.tails.set(id, result);
    void result.finally(() => { if (this.tails.get(id) === result) this.tails.delete(id); }).catch(() => undefined);
    return result;
  }
  async create(userId: string, raw: unknown, validateInTransaction?: () => Promise<void>): Promise<{ id: string; chunkBytes: number }> {
    const input = uploadSchema.parse(raw);
    return this.store.db.transaction(async () => {
      await validateInTransaction?.();
      await this.store.requireMember(userId, input.conversationId);
      this.checkSize(input.size);
      // Repeating upload-init is resumable by (owner, conversation, hash, size).
      const old = await this.store.db.get<AttachmentRow>("SELECT * FROM attachments a WHERE owner_id=? AND conversation_id=? AND sha256=? AND size=? AND name=? AND NOT EXISTS(SELECT 1 FROM retired_attachments r WHERE r.attachment_id=a.id)", [userId, input.conversationId, input.sha256, input.size, input.name]);
      if (old) return { id: old.id, chunkBytes: CHUNK_BYTES };
      const id = newId("att");
      await this.store.db.run("INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?,0,?)", [id, input.conversationId, userId, input.sha256, input.size, input.mime, input.name, `${id}.blob`, Date.now()]);
      return { id, chunkBytes: CHUNK_BYTES };
    });
  }
  private async owned(userId: string, id: string): Promise<AttachmentRow> {
    return this.store.db.serial(async () => {
      const row = await this.store.db.get<AttachmentRow>("SELECT * FROM attachments a WHERE id=? AND NOT EXISTS(SELECT 1 FROM retired_attachments r WHERE r.attachment_id=a.id)", [id]);
      if (!row || row.owner_id !== userId) throw new HubError("upload_not_found", 404);
      await this.store.requireMember(userId, row.conversation_id);
      return row;
    });
  }
  async status(userId: string, id: string): Promise<{ complete: boolean; chunks: number[]; size: number; sha256: string }> {
    const row = await this.owned(userId, id);
    const chunks = await this.store.db.serial(() => this.store.db.all<{ chunk_index: number }>("SELECT chunk_index FROM upload_chunks WHERE attachment_id=? ORDER BY chunk_index", [id]));
    return { complete: !!row.complete, chunks: chunks.map((c) => c.chunk_index), size: row.size, sha256: row.sha256 };
  }
  async putChunk(userId: string, id: string, index: number, data: Buffer, validate?: () => Promise<void>): Promise<void> {
    await this.serial(id, async () => {
      await validate?.();
      const row = await this.owned(userId, id);
      if (!row.complete) this.checkSize(row.size);
      if (!Number.isSafeInteger(index) || index < 0 || index >= Math.ceil(row.size / CHUNK_BYTES)) throw new HubError("invalid_chunk");
      const expected = Math.min(CHUNK_BYTES, row.size - index * CHUNK_BYTES);
      if (data.length !== expected) throw new HubError("chunk_size_mismatch");
      const hash = createHash("sha256").update(data).digest("hex");
      const previous = await this.store.db.serial(() => this.store.db.get<{ sha256: string }>("SELECT sha256 FROM upload_chunks WHERE attachment_id=? AND chunk_index=?", [id, index]));
      if (previous) { if (previous.sha256 !== hash) throw new HubError("chunk_conflict", 409); return; }
      if (row.complete) throw new HubError("upload_complete", 409);
      const file = path.join(this.directory, `${id}.${index}.chunk`);
      const temporary = `${file}.tmp`;
      const handle = await open(temporary, "w", 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      try {
        await this.store.db.transaction(async () => {
          if (!await this.store.db.get("SELECT 1 FROM attachments a WHERE id=? AND complete=0 AND NOT EXISTS(SELECT 1 FROM retired_attachments r WHERE r.attachment_id=a.id)", [id])) throw new HubError("upload_not_found", 404);
          await rename(temporary, file);
          await this.store.db.run("INSERT INTO upload_chunks VALUES(?,?,?,?)", [id, index, hash, data.length]);
        });
      } finally { await rm(temporary, { force: true }); }
    });
  }
  async complete(userId: string, id: string, validate?: () => Promise<void>): Promise<AttachmentRow> {
    return this.serial(id, async () => {
      await validate?.();
      const row = await this.owned(userId, id);
      if (row.complete) return row;
      this.checkSize(row.size);
      const chunks = await this.store.db.serial(() => this.store.db.all<{ chunk_index: number; size: number }>("SELECT chunk_index,size FROM upload_chunks WHERE attachment_id=? ORDER BY chunk_index", [id]));
      if (chunks.length !== Math.ceil(row.size / CHUNK_BYTES) || chunks.reduce((sum, c) => sum + c.size, 0) !== row.size) throw new HubError("upload_incomplete", 409);
      const target = path.join(this.directory, row.stored_name);
      const handle = await open(`${target}.tmp`, "w", 0o600);
      const hash = createHash("sha256");
      try {
        for (const chunk of chunks) {
          for await (const data of createReadStream(path.join(this.directory, `${id}.${chunk.chunk_index}.chunk`))) {
            const buffer = data as Buffer; hash.update(buffer); await handle.writeFile(buffer);
          }
        }
        await handle.sync();
      } finally { await handle.close(); }
      if (hash.digest("hex") !== row.sha256) { await rm(`${target}.tmp`, { force: true }); throw new HubError("sha256_mismatch", 422); }
      try {
        await this.store.db.transaction(async () => {
          if (!await this.store.db.get("SELECT 1 FROM attachments a WHERE id=? AND complete=0 AND NOT EXISTS(SELECT 1 FROM retired_attachments r WHERE r.attachment_id=a.id)", [id])) throw new HubError("upload_not_found", 404);
          await rename(`${target}.tmp`, target);
          await this.store.db.run("UPDATE attachments SET complete=1 WHERE id=?", [id]);
        });
      } finally { await rm(`${target}.tmp`, { force: true }); }
      // Keep tiny chunk receipts for retry idempotency, remove redundant bytes.
      for (const chunk of chunks) await rm(path.join(this.directory, `${id}.${chunk.chunk_index}.chunk`), { force: true });
      return { ...row, complete: 1 };
    });
  }
  async download(actor: { userId: string } | { botId: string }, id: string): Promise<{ row: AttachmentRow; path: string }> {
    const row = await this.store.db.serial(async () => {
      // Owner deletion (附件管理) retires the attachment but keeps its message
      // references; a recall or GC retirement has none and stays not-found.
      const found = await this.store.db.get<AttachmentRow & { retired: number; referenced: number }>(`SELECT a.*,
        EXISTS(SELECT 1 FROM retired_attachments r WHERE r.attachment_id=a.id) AS retired,
        EXISTS(SELECT 1 FROM message_attachments m WHERE m.attachment_id=a.id) AS referenced
        FROM attachments a WHERE id=? AND complete=1`, [id]);
      if (!found || found.retired && !found.referenced) throw new HubError("attachment_not_found", 404);
      if ("userId" in actor) await this.store.requireMember(actor.userId, found.conversation_id);
      else await this.store.requireBot(actor.botId, found.conversation_id);
      // Only after authorization does a member learn the owner deleted it.
      if (found.retired) throw new HubError("attachment_deleted", 410);
      const { retired: _retired, referenced: _referenced, ...row } = found;
      return row;
    });
    // Never accept a path from HTTP, from a bot, or even from stored metadata.
    const file = path.join(this.directory, `${row.id}.blob`);
    await this.requireBlob(file, row.size);
    return { row, path: file };
  }
  /** Remove the blob and upload chunks of retired attachments now, under the
   * same maintenance lock as GC and export. The rows stay as tombstones so
   * messages can say 附件已删除; daily GC sweeps anything a failure left. */
  async purge(ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    const wanted = new Set(ids);
    await withFileMutex(path.join(path.dirname(this.directory), "maintenance"), async () => {
      const retired = new Set((await this.store.db.serial(() => this.store.db.all<{ attachment_id: string }>(
        `SELECT attachment_id FROM retired_attachments WHERE attachment_id IN (${ids.map(() => "?").join(",")})`, [...ids]))).map(row => row.attachment_id));
      const files = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return [] as string[]; throw error; });
      for (const file of files) { const id = attachmentFileId(file); if (id && wanted.has(id) && retired.has(id)) await rm(path.join(this.directory, file), { force: true }); }
      await this.store.db.transaction(async () => { for (const id of retired) await this.store.db.run("DELETE FROM upload_chunks WHERE attachment_id=?", [id]); });
    });
  }
  async forward(userId: string, input: Extract<ClientFrame, { type: "message.forward" }>, validate?: () => Promise<unknown>) {
    const created: string[] = [];
    try {
      return await this.store.forwardMessage(userId, input, async (row, id) => {
        const from = path.join(this.directory, `${row.id}.blob`), to = path.join(this.directory, `${id}.blob`);
        await this.requireBlob(from, row.size);
        // Complete blobs are immutable. A new link has an independent lifetime,
        // so source cleanup cannot break forwarded attachments or their backups.
        try { await link(from, to); }
        catch (error) {
          if (["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new HubError("attachment_unavailable", 410);
          if (!["EXDEV", "EPERM", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          try { await copyFile(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE); }
          catch (copyError) {
            if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((copyError as NodeJS.ErrnoException).code ?? "")) throw new HubError("attachment_unavailable", 410);
            throw copyError;
          }
        }
        created.push(to);
      }, validate);
    } catch (error) { await Promise.all(created.map((file) => rm(file, { force: true }))); throw error; }
  }
  private async requireBlob(file: string, size: number): Promise<void> {
    try { const info = await stat(file); if (!info.isFile() || info.size !== size) throw new HubError("attachment_unavailable", 410); }
    catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new HubError("attachment_unavailable", 410);
      throw error;
    }
  }
  async importForBot(botId: string, input: Upload, data: Buffer): Promise<string> {
    await this.store.db.serial(() => this.store.requireBot(botId, input.conversationId));
    if (input.size !== data.length || createHash("sha256").update(data).digest("hex") !== input.sha256) throw new HubError("sha256_mismatch", 422);
    // Bots use this only AFTER the existing delivery preflight in the instance.
    const conv = await this.store.conversationForBot(botId, input.conversationId);
    const { id } = await this.create(conv.ownerId, input);
    // Forwarded attachments have complete bytes but no upload chunk receipts.
    if (!(await this.status(conv.ownerId, id)).complete) {
      for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) await this.putChunk(conv.ownerId, id, offset / CHUNK_BYTES, data.subarray(offset, offset + CHUNK_BYTES));
      await this.complete(conv.ownerId, id);
    }
    return id;
  }
}
