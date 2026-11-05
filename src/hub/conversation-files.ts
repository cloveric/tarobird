import { createHash } from "node:crypto";
import { z } from "zod";
import { idSchema } from "../client-protocol/index.js";
import { CONVERSATION_FILES_PAGE_SIZE, conversationFilesPageSchema, type ConversationFilesQuery, type ConversationFilesPage, type ConversationFile } from "../client-protocol/conversation-files.js";
import { HubError, type HubStore } from "./store.js";
import type { SqlValue } from "./database.js";

const cursorSchema = z.object({ v: z.literal(1), scope: z.string(), at: z.number().int().safe(), message: idSchema, attachment: idSchema }).strict();

/** Only attachments actually shared in messages, never drafts or workspace paths.
 * Every page rechecks the anchor and current membership in every source chat. */
export function conversationFiles(store: HubStore, userId: string, query: ConversationFilesQuery): Promise<ConversationFilesPage> {
  return store.db.serial(async () => {
    await store.requireMember(userId, query.conversationId);
    if (query.botId) await store.requireBot(query.botId, query.conversationId);
    const scope = createHash("sha256").update(JSON.stringify([userId, query.conversationId, query.botId ?? null, query.q])).digest("hex");
    let before: z.infer<typeof cursorSchema> | undefined;
    if (query.cursor) {
      let raw: unknown;
      try { raw = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")); } catch { /* Rejected below. */ }
      const parsed = cursorSchema.safeParse(raw);
      if (!parsed.success || parsed.data.scope !== scope) throw new HubError("file_cursor_invalid");
      before = parsed.data;
    }
    const conditions = [
      "m.status!='deleted'", "a.complete=1", "a.conversation_id=m.conversation_id",
      // Scheduled inputs reference shared notes for the Bot, but are not new
      // user shares. Keep the original source and its per-reader deletion.
      "NOT EXISTS(SELECT 1 FROM group_discussion_turns t WHERE t.input_message_id=m.id)",
      "NOT EXISTS(SELECT 1 FROM retired_attachments r WHERE r.attachment_id=a.id)",
      "EXISTS(SELECT 1 FROM conversation_members u WHERE u.conversation_id=m.conversation_id AND u.member_type='user' AND u.member_id=?)",
      // Link preview covers also have attachment receipts; only media blocks count.
      "EXISTS(SELECT 1 FROM json_tree(m.blocks_json) media WHERE media.key='attachmentId' AND media.atom=a.id AND json_extract(m.blocks_json,media.path||'.type') IN ('file','image','audio'))",
      "NOT EXISTS(SELECT 1 FROM message_deletions d WHERE d.user_id=? AND d.message_id=m.id)",
      "instr(lower(a.name),lower(?))>0",
    ];
    const params: SqlValue[] = [userId, userId, query.q];
    if (query.botId) {
      conditions.push("EXISTS(SELECT 1 FROM conversation_members b WHERE b.conversation_id=m.conversation_id AND b.member_type='bot' AND b.member_id=?)"); params.push(query.botId);
    } else { conditions.push("m.conversation_id=?"); params.push(query.conversationId); }
    if (before) {
      conditions.push("(m.created_at<? OR (m.created_at=? AND (m.id<? OR (m.id=? AND a.id<?))))");
      params.push(before.at, before.at, before.message, before.message, before.attachment);
    }
    const rows = await store.db.all<ConversationFile>(`SELECT a.id AS attachmentId,m.id AS messageId,m.conversation_id AS conversationId,
      c.title AS conversationTitle,a.name,a.mime,a.size,m.author_id AS authorId,m.author_type AS authorType,
      COALESCE(CASE WHEN m.author_type='bot' THEN b.name WHEN m.author_type='user' THEN u.name END,m.author_id) AS authorName,m.created_at AS createdAt
      FROM messages m JOIN message_attachments ma ON ma.message_id=m.id JOIN attachments a ON a.id=ma.attachment_id
      JOIN conversations c ON c.id=m.conversation_id LEFT JOIN bots b ON b.id=m.author_id LEFT JOIN users u ON u.id=m.author_id
      WHERE ${conditions.join(" AND ")} ORDER BY m.created_at DESC,m.id DESC,a.id DESC LIMIT ?`, [...params, CONVERSATION_FILES_PAGE_SIZE + 1]);
    const items = rows.slice(0, CONVERSATION_FILES_PAGE_SIZE), last = items.at(-1);
    const nextCursor = rows.length > CONVERSATION_FILES_PAGE_SIZE && last
      ? Buffer.from(JSON.stringify({ v: 1, scope, at: last.createdAt, message: last.messageId, attachment: last.attachmentId })).toString("base64url") : null;
    return conversationFilesPageSchema.parse({ items, nextCursor });
  });
}
