import { ATTACHMENT_ADMIN_PAGE_SIZE, type AttachmentAdminDelete, type AttachmentAdminDeleteResult, type AttachmentAdminList, type AttachmentAdminListQuery, type AttachmentAdminSummary } from "../client-protocol/attachment-admin.js";
import type { HubStore } from "./store.js";

/** Attachments that occupy host disk and appear in messages: complete, not yet
 * retired, and still referenced. Unreferenced uploads (drafts) are left to GC. */
const MANAGED = `a.complete=1
  AND NOT EXISTS(SELECT 1 FROM retired_attachments r WHERE r.attachment_id=a.id)
  AND EXISTS(SELECT 1 FROM message_attachments m WHERE m.attachment_id=a.id)`;
/** A Bot has not finished a message that shares the attachment. The Gateway
 * acknowledges only after its turn settles, so `pending` covers queued and
 * running inputs; a running turn has a workspace copy, a queued one does not. */
const PENDING = `EXISTS(SELECT 1 FROM message_attachments m JOIN deliveries d ON d.message_id=m.message_id
  WHERE m.attachment_id=a.id AND d.status='pending')`;

export function attachmentAdminSummary(store: HubStore, userId: string): Promise<AttachmentAdminSummary> {
  return store.db.serial(async () => {
    await store.requireOwner(userId);
    const conversations = await store.db.all<{ conversationId: string; title: string; count: number; bytes: number }>(
      `SELECT a.conversation_id AS conversationId, c.title AS title, COUNT(*) AS count, SUM(a.size) AS bytes
       FROM attachments a JOIN conversations c ON c.id=a.conversation_id WHERE ${MANAGED}
       GROUP BY a.conversation_id ORDER BY bytes DESC, c.title`);
    return { count: conversations.reduce((sum, row) => sum + row.count, 0), bytes: conversations.reduce((sum, row) => sum + row.bytes, 0), conversations };
  });
}

export function attachmentAdminList(store: HubStore, userId: string, query: AttachmentAdminListQuery): Promise<AttachmentAdminList> {
  return store.db.serial(async () => {
    await store.requireOwner(userId);
    const order = query.sort === "time" ? "a.created_at DESC, a.id" : "a.size DESC, a.created_at DESC, a.id";
    const rows = await store.db.all<{ id: string; conversationId: string; name: string; mime: string; size: number; createdAt: number; messageId: string; pending: number }>(
      `SELECT a.id AS id, a.conversation_id AS conversationId, a.name AS name, a.mime AS mime, a.size AS size, a.created_at AS createdAt,
         (SELECT m.message_id FROM message_attachments m JOIN messages x ON x.id=m.message_id WHERE m.attachment_id=a.id ORDER BY x.created_at, x.rowid LIMIT 1) AS messageId,
         ${PENDING} AS pending
       FROM attachments a WHERE a.conversation_id=? AND ${MANAGED} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [query.conversationId, ATTACHMENT_ADMIN_PAGE_SIZE, query.offset]);
    const total = (await store.db.get<{ total: number }>(`SELECT COUNT(*) AS total FROM attachments a WHERE a.conversation_id=? AND ${MANAGED}`, [query.conversationId]))?.total ?? 0;
    return { items: rows.map(row => ({ ...row, pending: !!row.pending })), total };
  });
}

/** Retire the selected attachments in one transaction. Messages keep their
 * text and references, so they render 「附件已删除」; the caller then removes
 * the blob and upload chunks (`HubAttachments.purge`). Already retired or
 * foreign IDs are ignored, so a repeated request is a no-op. */
export async function retireAttachments(store: HubStore, userId: string, input: AttachmentAdminDelete): Promise<AttachmentAdminDeleteResult> {
  return store.db.transaction(async () => {
    await store.requireOwner(userId);
    const scope = input.conversationId !== undefined ? { sql: "a.conversation_id=?", params: [input.conversationId] }
      : { sql: `a.id IN (${input.ids!.map(() => "?").join(",")})`, params: [...new Set(input.ids)] };
    const rows = await store.db.all<{ id: string; size: number; pending: number }>(
      `SELECT a.id AS id, a.size AS size, ${PENDING} AS pending FROM attachments a WHERE ${scope.sql} AND ${MANAGED}`, scope.params);
    const removable = rows.filter(row => !row.pending), pending = rows.filter(row => row.pending).map(row => row.id);
    for (const row of removable) await store.db.run("INSERT OR IGNORE INTO retired_attachments(attachment_id) VALUES(?)", [row.id]);
    const freedBytes = removable.reduce((sum, row) => sum + row.size, 0);
    if (removable.length) await store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), userId, "attachment.deleted",
      JSON.stringify({ count: removable.length, bytes: freedBytes, ...(input.conversationId ? { conversationId: input.conversationId } : {}) })]);
    return { deleted: removable.length, freedBytes, pending, ids: removable.map(row => row.id) };
  });
}
