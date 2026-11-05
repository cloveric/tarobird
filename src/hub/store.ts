import { workbenchContextSchema, type WorkbenchContext } from "../client-protocol/workbench.js";
import { reserveWorkbenchHistory, workbenchContextDigest, type WorkbenchContextReceipt } from "./workbench-history.js";
import { BOT_AVATAR_DEFAULT_PREFIX } from "./bot-avatar-default.js";
import { botAvatarById } from "../client-protocol/bot-avatar-catalog.js";
import { botRoleSchema, conversationTicketSchema, type BotRole } from "../client-protocol/dispatch.js";
import { nativeInputProgressSchema } from "../client-protocol/native-input.js";
import { steeringApplicationSchema } from "../client-protocol/steering-outcome.js";
import { deletedMessage, deleteMessagesSchema, personalMessageEvent, messageEventId } from "../client-protocol/message-deletion.js";
import { MAX_CLEAR_MESSAGES, MESSAGE_CLEAR_ACTIVE, clearMessagesInputSchema, hasPendingCardAction, type ClearMessagesInput, type ClearMessagesPlan, type ClearMessagesResult } from "../client-protocol/message-clear.js";
import { isRunActive, anyRun, runSummarySchema } from "../client-protocol/run.js";
import { backgroundTaskGroup } from "../client-protocol/background-task-group.js";
import { answerFollowup, activeAnswerFollowup } from "../client-protocol/answer-followup.js";
import { queueNotice } from "../client-protocol/queue-notice.js";
import { SEARCH_EXCERPT_CHARS, SEARCH_PAGE_SIZE, searchCursorSchema, searchPageSchema, type SearchFilters, type SearchPage } from "../client-protocol/search.js";
import { steerResultSchema, type SteerResult } from "../client-protocol/steering.js";
import { extractLinks, normalizedLink, linkPreviewSchema, linkPreviewStyleSchema, type LinkPreview, type LinkPreviewStyle } from "../client-protocol/links.js";
import { forwardedBlocks, messageAttachmentIds } from "../client-protocol/forwarding.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { MAX_FRAME_BYTES, idSchema, blocksText, conversationSchema, eventSchema, messageSchema, type Block, type CardElement, type ClientFrame, type Conversation, type HubEvent, type Json, type Message } from "../client-protocol/index.js";
import type { SnapshotFrame } from "../client-protocol/snapshot.js";
import { enqueueEventPush } from "./push/model.js";
import { HubDatabase, type SqlValue } from "./database.js";
import { replayHeadSql } from "./event-history-sql.js";
import { MessageActivityIndex, readConversationActivity, type MessageActivity } from "./message-activity.js";
import { HubAudit } from "./audit.js";
import { localDesktopControllersInTransaction } from "./local-controller.js";
import { groupSettingsSchema, type GroupSettingsInput } from "../client-protocol/groups.js";
import { GROUP_DISCUSSION_MAX_MEMBERS, GROUP_DISCUSSION_MIN_MEMBERS, automaticGroupDiscussion, defaultGroupDiscussionPolicy, groupDiscussionPolicySchema, type GroupDiscussionPolicy, type GroupSettingsSnapshot } from "../client-protocol/group-discussion.js";
import { renameBotSchema, type RenameBotInput } from "../client-protocol/bots.js";

import { HubError } from "./errors.js";
export { HubError } from "./errors.js";
export type User = { id: string; name: string; role: "owner" | "member" };
export type Device = { id: string; user_id: string; name: string; platform: string; public_key: string; revoked: number; created_at: number; last_seen: number };
export type DeviceSummary = Omit<Device, "public_key"> & { nameSource?: "host" };
export type Bot = { id: string; name: string; engine: string; model: string; effort: string; online: number; managed?: number; deletedAt?: number; defaultAvatar?: string; role?: BotRole };
type ConversationRow = { id: string; type: "direct" | "group"; title: string; owner_id: string; parent_id: string | null; session_id: string | null; binding_id: string | null; archived: number; created_at: number; hidden: number; ticket_json: string | null };
type MessageRow = { workbench_receipt_json?: string | null; discussion_json?: string | null; bot_source_json?: string | null; preview_style: string | null; preview_url: string | null; link_preview_json: string | null; forwarded_json: string | null; mentions_json: string; id: string; conversation_id: string; author_id: string; author_type: "user" | "bot" | "system"; blocks_json: string; status: Message["status"]; version: number; client_msg_id: string | null; reply_to: string | null; created_at: number };
type MessageHeader = Pick<MessageRow, "id" | "conversation_id" | "author_id" | "author_type" | "created_at" | "version" | "client_msg_id">;
function deletedMessageRow(row: MessageHeader): Message {
  return deletedMessage({ id: row.id, conversationId: row.conversation_id, authorId: row.author_id, authorType: row.author_type,
    createdAt: row.created_at, status: "complete", version: row.version, blocks: [], ...(row.client_msg_id ? { clientMsgId: row.client_msg_id } : {}) });
}
const activeRunPhases = runSummarySchema.shape.phase.options.filter(isRunActive);
const activeRunPhaseParams = activeRunPhases.map(() => "?").join(",");
export type AttachmentRow = { id: string; conversation_id: string; owner_id: string; sha256: string; size: number; mime: string; name: string; stored_name: string; complete: number; created_at: number };
export type StoredEvent = { conversation_id: string; seq: number; kind: HubEvent["kind"]; payload_json: string; at: number };
/** Runs inside an already-owned write transaction; must not reenter db.serial. */
export type TransactionGuard = () => Promise<unknown>;
/** Frozen-context digest, plus (on a run source) later inputs that may have reached that run. */
type SteeringInputReceipt = Partial<WorkbenchContextReceipt> & { inputs?: string[]; inputsTruncated?: true };
const MAX_RUN_INPUTS = 8;
export type SendMessageInput = { workbench?: WorkbenchContext; groupReplyGuard?: import("../client-protocol/index.js").GroupReplyGuard; parallelCapable?: boolean; groupDiscussion?: Message["groupDiscussion"]; botSource?: Message["botSource"]; conversationId: string; clientMsgId: string; text: string; attachments: string[]; replyTo?: string; mentions?: string[]; previewUrl?: string | null; previewStyle?: LinkPreviewStyle };
export type BotPublishInput = { id?: string; conversationId: string; blocks: Block[]; status?: Message["status"]; replyTo?: string; version?: number };
export function newId(prefix: string): string { return `${prefix}_${randomUUID().replaceAll("-", "")}`; }
const historyCursorSchema = z.object({ v: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/), at: z.number().int().safe(), id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/) }).strict();
function historySearchWhere(userId: string, query: string, filters: SearchFilters, joined = false): { conditions: string[]; params: SqlValue[] } {
  const conditions = ["m.status!='deleted'", "EXISTS(SELECT 1 FROM conversation_members c WHERE c.conversation_id=m.conversation_id AND c.member_type='user' AND c.member_id=?)"];
  conditions.push("NOT EXISTS(SELECT 1 FROM message_deletions d WHERE d.user_id=? AND d.message_id=m.id)");
  // Scheduler inputs only borrow note resources; they are not searchable shares.
  conditions.push("NOT EXISTS(SELECT 1 FROM group_discussion_turns t WHERE t.input_message_id=m.id)");
  const params: SqlValue[] = [userId, userId];
  // LIKE without ESCAPE lets FTS5 use trigrams. With literal wildcards, first
  // select indexed candidates and then apply the escaped exact substring filter.
  const wildcard = /[%_]/.test(query), body = joined ? "f.body" : "body";
  const match = `${body} LIKE ?${wildcard ? ` AND ${body} LIKE ? ESCAPE '\\'` : ""}`;
  conditions.push(joined ? `(${match})` : `m.id IN (SELECT message_id FROM messages_fts WHERE ${match})`);
  params.push(`%${query}%`);
  if (wildcard) params.push(`%${query.replace(/[\\%_]/g, (s) => `\\${s}`)}%`);
  if (filters.botId) { conditions.push("EXISTS(SELECT 1 FROM conversation_members b WHERE b.conversation_id=m.conversation_id AND b.member_type='bot' AND b.member_id=?)"); params.push(filters.botId); }
  if (filters.conversationId) { conditions.push("m.conversation_id=?"); params.push(filters.conversationId); }
  if (filters.from !== undefined) { conditions.push("m.created_at>=?"); params.push(filters.from); }
  if (filters.to !== undefined) { conditions.push("m.created_at<=?"); params.push(filters.to); }
  if (filters.hasFile) conditions.push("EXISTS(SELECT 1 FROM json_tree(m.blocks_json) media WHERE media.key='attachmentId' AND media.type='text')");
  return { conditions, params };
}
export class HubStore {
  private listeners = new Set<(event: HubEvent) => void>();
  private searchTail: Promise<unknown> = Promise.resolve();
  private readonly auditLog: HubAudit;
  constructor(readonly db: HubDatabase) { this.auditLog = new HubAudit(db); }
  static async open(directory: string): Promise<HubStore> {
    const store = new HubStore(await HubDatabase.open(directory));
    try {
      await store.db.serial(async () => {
        await store.db.run("INSERT OR IGNORE INTO users VALUES ('owner', 'Owner', 'owner')");
      });
      return store;
    } catch (error) { await store.db.close().catch(() => undefined); throw error; }
  }
  subscribe(listener: (event: HubEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: HubEvent): void { for (const listener of this.listeners) { try { listener(event); } catch { /* A socket failure cannot roll back a committed event. */ } } }
  async audit(kind: string, actor: string | null, detail: Record<string, string | number | boolean> = {}): Promise<void> {
    await this.auditLog.write(kind, actor, detail);
  }
  flushAudit(): Promise<void> { return this.auditLog.flush(); }
  // Called only while holding db.serial/transaction.
  async requireMember(userId: string, conversationId: string): Promise<void> {
    if (!await this.db.get("SELECT 1 FROM conversation_members WHERE conversation_id=? AND member_type='user' AND member_id=?", [conversationId, userId])) throw new HubError("conversation_forbidden", 403);
  }
  async requireBot(botId: string, conversationId: string): Promise<void> {
    if (!await this.db.get("SELECT 1 FROM bots WHERE id=? AND deleted_at IS NULL", [botId])) throw new HubError("bot_deleted", 410);
    if (!await this.db.get("SELECT 1 FROM conversation_members WHERE conversation_id=? AND member_type='bot' AND member_id=?", [conversationId, botId])) throw new HubError("bot_forbidden", 403);
  }
  async requireOwner(userId: string): Promise<void> {
    if ((await this.db.get<User>("SELECT * FROM users WHERE id=?", [userId]))?.role !== "owner") throw new HubError("owner_required", 403);
  }
  user(userId: string): Promise<User | undefined> { return this.db.serial(() => this.db.get<User>("SELECT * FROM users WHERE id=?", [userId])); }
  device(deviceId: string): Promise<Device | undefined> { return this.db.serial(() => this.db.get<Device>("SELECT * FROM devices WHERE id=?", [deviceId])); }
  devices(userId: string): Promise<DeviceSummary[]> {
    return this.db.serial(async () => {
      await this.requireOwner(userId);
      const linked = await localDesktopControllersInTransaction(this.db, true);
      const devices = await this.db.all<DeviceSummary>("SELECT id,user_id,name,platform,revoked,created_at,last_seen FROM devices ORDER BY created_at");
      return devices.map(device => linked.has(device.id) ? { ...device, nameSource: "host" } : device);
    });
  }
  bots(userId: string, includeDeleted = false): Promise<Bot[]> {
    return this.db.serial(async () => {
      const rows = await this.db.all<Omit<Bot, "role"> & { role: string; deleted_at: number | null; assigned_avatar: string | null }>(`SELECT id,name,engine,model,effort,online,role,deleted_at,(SELECT value FROM meta WHERE key=?||bots.id) AS assigned_avatar,EXISTS(SELECT 1 FROM managed_bots m WHERE m.bot_id=bots.id) AS managed FROM bots WHERE (? OR deleted_at IS NULL) AND (EXISTS(SELECT 1 FROM users WHERE id=? AND role='owner') OR id IN (SELECT bot_id FROM bot_grants WHERE user_id=?)) ORDER BY id`, [BOT_AVATAR_DEFAULT_PREFIX, Number(includeDeleted), userId, userId]);
      return rows.map(({ deleted_at, assigned_avatar, role, ...bot }) => {
        const assigned = botAvatarById(assigned_avatar), known = botRoleSchema.safeParse(role);
        return { ...bot, ...(known.success ? { role: known.data } : {}), ...(assigned ? { defaultAvatar: assigned.id } : {}), ...(deleted_at ? { online: 0, managed: 0, deletedAt: deleted_at } : {}) };
      });
    });
  }
  async botStatus(id: string, status: Partial<Pick<Bot, "engine" | "model" | "effort" | "online">>): Promise<void> {
    await this.db.serial(async () => { if (!await this.db.get("SELECT 1 FROM bots WHERE id=? AND deleted_at IS NULL", [id])) throw new HubError("bot_deleted", 410); for (const field of ["engine", "model", "effort", "online"] as const) if (status[field] !== undefined) await this.db.run(`UPDATE bots SET ${field}=? WHERE id=?`, [status[field]!, id]); });
  }
  botName(userId: string, id: string): Promise<{ name: string }> {
    return this.db.serial(async () => {
      await this.requireOwner(userId);
      const bot = await this.db.get<{ name: string }>("SELECT name FROM bots WHERE id=? AND deleted_at IS NULL", [id]);
      if (!bot) throw new HubError("bot_not_found", 404);
      return bot;
    });
  }
  renameBot(userId: string, id: string, input: RenameBotInput, validate?: TransactionGuard): Promise<{ name: string }> {
    const { name, expectedName } = renameBotSchema.parse(input);
    return this.db.transaction(async () => {
      await validate?.(); await this.requireOwner(userId);
      const bot = await this.db.get<{ name: string }>("SELECT name FROM bots WHERE id=? AND deleted_at IS NULL", [id]);
      if (!bot) throw new HubError("bot_not_found", 404);
      // Retrying a lost receipt is safe; a stale edit must not overwrite a newer name.
      if (bot.name === name) return bot;
      if (bot.name !== expectedName) throw new HubError("bot_name_conflict", 409);
      await this.db.run("UPDATE bots SET name=? WHERE id=?", [name, id]);
      return { name };
    });
  }
  /** Keep durable history and files; revoke execution and admission atomically. */
  async deleteBot(userId: string, botId: string, expectedName: string, validate?: TransactionGuard): Promise<Conversation[]> {
    const result = await this.db.transaction(async () => {
      await validate?.(); await this.requireOwner(userId);
      const bot = await this.db.get<{ name: string; deleted_at: number | null }>("SELECT name,deleted_at FROM bots WHERE id=?", [botId]);
      if (!bot) throw new HubError("bot_not_found", 404);
      if (!await this.db.get("SELECT 1 FROM managed_bots WHERE bot_id=?", [botId])) throw new HubError("bot_delete_unmanaged", 409);
      // A lost response can be retried; the tombstone also blocks replayed creates.
      if (bot.deleted_at) return { conversations: [], events: [] as HubEvent[] };
      if (bot.name !== expectedName) throw new HubError("bot_name_conflict", 409);
      await this.db.run("UPDATE bots SET deleted_at=?,online=0 WHERE id=?", [Date.now(), botId]);
      await this.db.run("UPDATE deliveries SET status='failed' WHERE bot_id=? AND status='pending'", [botId]);
      await this.db.run("UPDATE action_deliveries SET status='complete',result_json=? WHERE bot_id=? AND status='pending'", [JSON.stringify({ ok: false, error: "bot_deleted" }), botId]);
      const rows = await this.db.all<MessageRow>(`SELECT * FROM messages WHERE author_type='bot' AND author_id=? AND status!='deleted'
        AND (status IN ('pending','streaming') OR blocks_json LIKE '%"actionId"%' OR EXISTS
          (SELECT 1 FROM json_each(blocks_json) b WHERE json_extract(b.value,'$.extra.nativeRun.phase') IN (${activeRunPhaseParams})
            OR json_extract(b.value,'$.extra.scopedRun.phase') IN (${activeRunPhaseParams})
            OR json_extract(b.value,'$.extra.answerFollowup.phase') IN ('queued','processing')))`, [botId, ...activeRunPhases, ...activeRunPhases]);
      const events: HubEvent[] = [];
      const actionable = (elements: CardElement[]): boolean => elements.some(e => !!e.actionId || actionable(e.children ?? []));
      const disable = (element: CardElement): CardElement => {
        const { actionId, confirm, ...preserved } = element;
        // Web links open locally, without a Bot callback. Retire the obsolete
        // action ID but preserve their original enabled state and confirmation.
        const webLink = element.type === "button" && !!element.url && /^https?:\/\//i.test(element.url);
        return { ...preserved, ...(webLink && confirm ? { confirm } : {}), ...(actionId && !webLink ? { disabled: true } : {}), ...(element.children ? { children: element.children.map(disable) } : {}) };
      };
      for (const row of rows) {
        const old = this.decodeMessage(row);
        const running = ["pending", "streaming"].includes(old.status) || old.blocks.some(b => b.type === "card" && ((anyRun(b) && isRunActive(anyRun(b)!.phase)) || activeAnswerFollowup(answerFollowup(b)) || ["queued", "started"].includes(queueNotice(b, old)?.state ?? "")));
        if (!running && !old.blocks.some(b => b.type === "card" && actionable(b.elements))) continue;
        // Old choices/configuration cards are durable history, not failed runs.
        // Keep their values, titles, terminal metadata and status; retire actions only.
        const message: Message = running ? this.interruptedRunMessage(old, "interrupted", "此 Bot 已删除，任务与待确认操作已停止，已有内容保留。") : {
          ...old, version: old.version + 1, blocks: old.blocks.map(block => block.type === "card" ? { ...block, elements: block.elements.map(disable) } : block),
        };
        await this.saveMessage(message); events.push(await this.append(message.conversationId, "message.updated", message, false));
      }
      const chats = await this.db.all<{ id: string; type: string }>("SELECT c.id,c.type FROM conversations c JOIN conversation_members m ON c.id=m.conversation_id WHERE m.member_type='bot' AND m.member_id=?", [botId]);
      for (const chat of chats) {
        if (chat.type === "group") await this.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='bot' AND member_id=?", [chat.id, botId]);
        if (chat.type === "direct" || !await this.db.get("SELECT 1 FROM conversation_members WHERE conversation_id=? AND member_type='bot'", [chat.id])) await this.db.run("UPDATE conversations SET archived=1 WHERE id=?", [chat.id]);
      }
      await this.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), userId, "bot.deleted", JSON.stringify({ botId, retainedHistory: true, retainedFiles: true })]);
      return { conversations: await Promise.all(chats.map(c => this.conversationRow(c.id))), events };
    });
    for (const event of result.events) this.emit(event);
    return result.conversations;
  }
  private async conversationRow(id: string): Promise<Conversation> {
    const row = await this.db.get<ConversationRow>("SELECT * FROM conversations WHERE id=?", [id]);
    if (!row) throw new HubError("conversation_not_found", 404);
    const bots = await this.db.all<{ member_id: string }>("SELECT member_id FROM conversation_members WHERE conversation_id=? AND member_type='bot' ORDER BY member_id", [id]);
    return conversationSchema.parse({ id: row.id, type: row.type, title: row.title, ownerId: row.owner_id, ...(row.parent_id ? { parentId: row.parent_id } : {}), botIds: bots.map((b) => b.member_id), archived: !!row.archived, ...(row.session_id ? { sessionId: row.session_id } : {}), ...(row.binding_id ? { bindingId: row.binding_id } : {}), createdAt: row.created_at,
      ...(row.hidden ? { hidden: true } : {}), ...(row.ticket_json ? { ticket: conversationTicketSchema.parse(JSON.parse(row.ticket_json)) } : {}) });
  }
  /** Pass `hidden: false` where a listing reaches a client without dispatch.v1:
   * it would show dispatcher worker conversations as ordinary chats. */
  conversations(userId: string, options: { hidden?: boolean } = {}): Promise<Conversation[]> {
    return this.db.serial(async () => {
      const rows = await this.db.all<{ id: string }>(`SELECT c.id FROM conversations c JOIN conversation_members m ON c.id=m.conversation_id WHERE m.member_type='user' AND m.member_id=?${options.hidden === false ? " AND c.hidden=0" : ""} ORDER BY c.created_at`, [userId]);
      return Promise.all(rows.map((r) => this.conversationRow(r.id)));
    });
  }
  conversationForBot(botId: string, conversationId: string): Promise<Conversation> { return this.db.serial(async () => { await this.requireBot(botId, conversationId); return this.conversationRow(conversationId); }); }
  async createConversation(userId: string, botIds: string[], title: string, clientActionId: string, options: { type?: "direct" | "group"; parentId?: string; dispatchWorker?: true } = {}, validate?: TransactionGuard): Promise<Conversation> {
    return this.db.transaction(async () => {
      await validate?.();
      return this.createConversationInTransaction(userId, botIds, title, clientActionId, options);
    });
  }
  /** Caller holds db.transaction; Agent Bus creates its dedicated chats atomically with the workspace. */
  async createConversationInTransaction(userId: string, botIds: string[], title: string, clientActionId: string, options: { type?: "direct" | "group"; parentId?: string; dispatchWorker?: true } = {}): Promise<Conversation> {
    const existing = await this.db.get<{ id: string }>("SELECT id FROM conversations WHERE owner_id=? AND client_action_id=?", [userId, clientActionId]);
    if (existing) {
      const conversation = await this.conversationRow(existing.id);
      if (conversation.parentId !== options.parentId) throw new HubError("idempotency_conflict", 409);
      return conversation;
    }
    let parent: Conversation | undefined;
    if (options.parentId) {
      await this.requireMember(userId, options.parentId); parent = await this.conversationRow(options.parentId);
      if (parent.type !== "group" || parent.parentId) throw new HubError("topic_requires_group");
      if (parent.archived) throw new HubError("conversation_archived", 409);
      botIds = parent.botIds;
    }
    const user = await this.db.get<User>("SELECT * FROM users WHERE id=?", [userId]);
    const ids = [...new Set(botIds)];
    if (ids.length === 0) throw new HubError("bots_required");
    let dispatcher = false;
    for (const id of ids) {
      const bot = await this.db.get<{ role: string }>("SELECT role FROM bots WHERE id=? AND deleted_at IS NULL", [id]);
      if (!bot) throw new HubError("bot_not_found", 404);
      if (!parent && user?.role !== "owner" && !await this.db.get("SELECT 1 FROM bot_grants WHERE user_id=? AND bot_id=?", [userId, id])) throw new HubError("bot_forbidden", 403);
      dispatcher ||= bot.role === "dispatcher";
      // A dispatcher's engine worker only runs its hidden ticket conversations.
      if (bot.role === "worker" && !options.dispatchWorker) throw new HubError("dispatch_worker_internal", 409);
    }
    const id = newId("gw");
    const type = parent ? "group" : options.type ?? (ids.length === 1 ? "direct" : "group");
    if (type === "direct" && ids.length !== 1) throw new HubError("direct_requires_one_bot");
    // A dispatcher works through exactly one conversation and is never a group member.
    if (dispatcher && type === "group") throw new HubError("dispatcher_group_forbidden", 409);
    if (dispatcher && await this.db.get("SELECT 1 FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id WHERE m.member_type='bot' AND m.member_id=? AND c.type='direct'", [ids[0]!])) throw new HubError("dispatcher_single_conversation", 409);
    await this.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id,parent_id) VALUES(?,?,?,?,?,?,?)", [id, type, title, userId, Date.now(), clientActionId, parent?.id ?? null]);
    if (parent) await this.db.run("INSERT INTO conversation_members SELECT ?,'user',member_id,0 FROM conversation_members WHERE conversation_id=? AND member_type='user'", [id, parent.id]);
    else await this.db.run("INSERT INTO conversation_members VALUES(?,'user',?,0)", [id, userId]);
    for (const bot of ids) await this.db.run("INSERT INTO conversation_members VALUES(?,'bot',?,0)", [id, bot]);
    return this.conversationRow(id);
  }
  async updateConversation(userId: string, id: string, changes: { title?: string; archived?: boolean; sessionId?: string | null; expectedBindingId?: string | null }, validate?: TransactionGuard): Promise<Conversation> {
    return this.db.transaction(async () => { await validate?.(); return this.updateConversationInTransaction(userId, id, changes); });
  }
  /** Caller owns the database transaction and has validated its session. */
  async updateConversationInTransaction(userId: string, id: string, changes: { title?: string; archived?: boolean; sessionId?: string | null; expectedBindingId?: string | null }): Promise<Conversation> {
      await this.requireMember(userId, id);
      const current = await this.conversationRow(id);
      if (current.ownerId !== userId) throw new HubError("conversation_owner_required", 403);
      if (changes.archived === false && (!current.botIds.length || await this.db.get("SELECT 1 FROM bots WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NOT NULL", [JSON.stringify(current.botIds)]))) throw new HubError("bot_deleted", 410);
      if (changes.sessionId !== undefined) await this.requireOwner(userId);
      if (changes.sessionId === null && changes.expectedBindingId === undefined) throw new HubError("binding_revision_required", 409);
      if (changes.expectedBindingId !== undefined && changes.expectedBindingId !== (current.bindingId ?? null)) throw new HubError("binding_conflict", 409);
      await this.db.run("UPDATE conversations SET title=?,archived=?,session_id=? WHERE id=?", [changes.title ?? current.title, Number(changes.archived ?? current.archived), changes.sessionId === undefined ? current.sessionId ?? null : changes.sessionId, id]);
      if (changes.sessionId !== undefined) await this.db.run("UPDATE conversations SET binding_id=? WHERE id=?", [changes.sessionId === null ? null : newId("bind"), id]);
      return this.conversationRow(id);
  }
  /** Effective discussion policy of a root group. The saved order follows the
   * current membership: removed Bots drop out and new members are appended. */
  async groupPolicyInTransaction(group: Conversation): Promise<GroupDiscussionPolicy> {
    const row = await this.db.get<{ mode: GroupDiscussionPolicy["mode"]; order_json: string; max_rounds: number }>("SELECT mode,order_json,max_rounds FROM group_discussion_settings WHERE group_id=?", [group.id]);
    if (!row) return defaultGroupDiscussionPolicy(group.botIds);
    const saved = z.array(z.string()).catch([]).parse(JSON.parse(row.order_json));
    const order = [...saved.filter(id => group.botIds.includes(id)), ...group.botIds.filter(id => !saved.includes(id))];
    return groupDiscussionPolicySchema.parse({ mode: row.mode, botOrder: order, maxRounds: row.max_rounds });
  }
  /** Caller holds the queue. Settings revision covers everything a start depends on. */
  async groupSettingsInTransaction(groupId: string): Promise<GroupSettingsSnapshot> {
    const group = await this.conversationRow(groupId);
    if (group.type !== "group" || group.parentId) throw new HubError("group_required");
    const policy = await this.groupPolicyInTransaction(group);
    const revision = `gs_${createHash("sha256").update(JSON.stringify([group.title, [...group.botIds].sort(), policy.mode, policy.botOrder, policy.maxRounds])).digest("hex").slice(0, 40)}`;
    return { group, policy, revision };
  }
  groupSettings(userId: string, groupId: string, validate?: TransactionGuard): Promise<GroupSettingsSnapshot> {
    return this.db.serial(async () => { await validate?.(); await this.requireMember(userId, groupId); return this.groupSettingsInTransaction(groupId); });
  }
  async updateGroup(userId: string, id: string, input: GroupSettingsInput, validate?: TransactionGuard): Promise<Conversation[]> {
    const change = groupSettingsSchema.parse(input);
    let event: HubEvent | undefined;
    const result = await this.db.transaction(async () => {
      await validate?.();
      await this.requireMember(userId, id);
      const current = await this.conversationRow(id);
      if (current.ownerId !== userId) throw new HubError("conversation_owner_required", 403);
      if (current.type !== "group" || current.parentId) throw new HubError("group_required");
      if (current.archived) throw new HubError("conversation_archived", 409);
      const same = (a: string[], b: string[]) => a.length === b.length && a.every(value => b.includes(value));
      const rows = await this.db.all<{ id: string }>("SELECT id FROM conversations WHERE id=? OR parent_id=?", [id, id]);
      const settings = await this.groupSettingsInTransaction(id);
      const samePolicy = !change.policy || JSON.stringify(change.policy) === JSON.stringify(settings.policy);
      // A repeated request after a lost response is a read, not a second edit.
      if (current.title === change.title && same(current.botIds, change.botIds) && samePolicy) return Promise.all(rows.map(row => this.conversationRow(row.id)));
      // Requests without a policy keep the original title/member comparison and
      // can never reset a saved discussion mode. A policy edit compares the full
      // settings revision, so a stale mode/order/round view cannot overwrite.
      if (current.title !== change.expectedTitle || !same(current.botIds, change.expectedBotIds) || change.policy && change.expectedRevision !== settings.revision) throw new HubError("group_settings_conflict", 409);
      if (change.policy) {
        if (change.policy.botOrder.length !== change.botIds.length || !same(change.policy.botOrder, change.botIds)) throw new HubError("group_discussion_order_invalid");
        if (automaticGroupDiscussion(change.policy.mode) && (change.botIds.length < GROUP_DISCUSSION_MIN_MEMBERS || change.botIds.length > GROUP_DISCUSSION_MAX_MEMBERS)) throw new HubError("group_discussion_member_count");
      }
      const user = await this.db.get<User>("SELECT * FROM users WHERE id=?", [userId]);
      for (const bot of change.botIds.filter(bot => !current.botIds.includes(bot))) {
        const added = await this.db.get<{ role: string }>("SELECT role FROM bots WHERE id=? AND deleted_at IS NULL", [bot]);
        if (!added) throw new HubError("bot_not_found", 404);
        if (added.role === "dispatcher") throw new HubError("dispatcher_group_forbidden", 409);
        if (added.role === "worker") throw new HubError("dispatch_worker_internal", 409);
        if (user?.role !== "owner" && !await this.db.get("SELECT 1 FROM bot_grants WHERE user_id=? AND bot_id=?", [userId, bot])) throw new HubError("bot_forbidden", 403);
      }
      // A running discussion keeps its participant snapshot; removing one of
      // them would strand its next turn. Mode/order/round edits apply next time.
      const active = await this.db.get<{ participants_json: string }>("SELECT participants_json FROM group_discussions WHERE group_id=? AND status IN ('running','pausing','paused','ending')", [id]);
      if (active && change.policy?.mode === "parallel") throw new HubError("group_parallel_discussion_active", 409);
      if (active && z.array(z.object({ botId: z.string() }).passthrough()).parse(JSON.parse(active.participants_json)).some(participant => !change.botIds.includes(participant.botId))) throw new HubError("group_discussion_active", 409);
      // Topics inherit membership, including archived topics when restored.
      // Never remove access while a queued/active delivery still needs it.
      for (const row of rows) for (const bot of (await this.conversationRow(row.id)).botIds.filter(bot => !change.botIds.includes(bot))) {
        if (await this.db.get("SELECT 1 FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE m.conversation_id=? AND d.bot_id=? AND d.status='pending' UNION ALL SELECT 1 FROM action_deliveries WHERE conversation_id=? AND bot_id=? AND status='pending' UNION ALL SELECT 1 FROM messages WHERE conversation_id=? AND author_type='bot' AND author_id=? AND status IN ('pending','streaming') LIMIT 1", [row.id, bot, row.id, bot, row.id, bot])) throw new HubError("group_bot_busy", 409);
      }
      await this.db.run("UPDATE conversations SET title=? WHERE id=?", [change.title, id]);
      for (const row of rows) {
        await this.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='bot' AND member_id NOT IN (SELECT value FROM json_each(?))", [row.id, JSON.stringify(change.botIds)]);
        for (const bot of change.botIds) await this.db.run("INSERT OR IGNORE INTO conversation_members VALUES(?,'bot',?,0)", [row.id, bot]);
      }
      if (change.policy) {
        await this.db.run("INSERT INTO group_discussion_settings VALUES(?,?,?,?,?,?) ON CONFLICT(group_id) DO UPDATE SET mode=excluded.mode,order_json=excluded.order_json,max_rounds=excluded.max_rounds,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
          [id, change.policy.mode, JSON.stringify(change.policy.botOrder), change.policy.maxRounds, userId, Date.now()]);
        await this.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), userId, "group.discussion_policy", JSON.stringify({ groupId: id, mode: change.policy.mode, members: change.policy.botOrder.length, maxRounds: change.policy.maxRounds })]);
      }
      // Policy-only edits do not change the Conversation; tell other devices.
      event = await this.append(id, "turn.state", { groupSettings: { groupId: id, revision: (await this.groupSettingsInTransaction(id)).revision } }, false);
      return Promise.all(rows.map(row => this.conversationRow(row.id)));
    });
    if (event) this.emit(event);
    return result;
  }
  conversationInTransaction(id: string): Promise<Conversation> { return this.conversationRow(id); }
  /** Caller holds db.transaction. Durable notice to clients that a discussion changed. */
  discussionEventInTransaction(conversationId: string, payload: { runId: string; revision: string }): Promise<HubEvent> {
    return this.append(conversationId, "turn.state", { groupDiscussion: payload }, false);
  }
  /** Caller holds db.transaction. One ordinary queued input addressed to one
   * Bot, authored by the discussion's initiator. Its meaning lives in the
   * caller's turn record, never in this message's text or fields. */
  async insertDiscussionInputInTransaction(input: { userId: string; conversationId: string; clientMsgId: string; botId: string; text: string; replyTo: string; resources?: Block[]; marker: NonNullable<Message["groupDiscussion"]> }): Promise<{ message: Message; event: HubEvent }> {
    if (await this.db.get("SELECT 1 FROM messages WHERE author_id=? AND client_msg_id=?", [input.userId, input.clientMsgId])) throw new HubError("idempotency_conflict", 409);
    const message: Message = { groupDiscussion: input.marker, id: newId("msg"), conversationId: input.conversationId, authorId: input.userId, authorType: "user", blocks: [{ type: "text", text: input.text }, ...input.resources ?? []], previewUrl: null,
      status: "complete", version: 1, clientMsgId: input.clientMsgId, mentions: [input.botId], replyTo: input.replyTo, createdAt: Date.now() };
    await this.saveMessage(message);
    await this.db.run("INSERT INTO deliveries(message_id,bot_id,queue_position) SELECT ?,?,COALESCE(MAX(queue_position),0)+1 FROM deliveries WHERE bot_id=?", [message.id, input.botId, input.botId]);
    return { message, event: await this.append(input.conversationId, "message.created", message) };
  }
  private async append(conversationId: string, kind: HubEvent["kind"], payload: unknown, notify = true): Promise<HubEvent> {
    const { seq } = (await this.db.get<{ seq: number }>("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM events WHERE conversation_id=?", [conversationId]))!;
    const event = eventSchema.parse({ v: 1, type: "event", conversationId, seq, kind, payload, at: Date.now() });
    if (!["message.created", "message.updated", "message.deleted"].includes(kind) && Buffer.byteLength(JSON.stringify(event)) > MAX_FRAME_BYTES) throw new HubError("event_frame_too_large", 413);
    await this.db.run("INSERT INTO events VALUES(?,?,?,?,?)", [conversationId, seq, kind, JSON.stringify(event.payload), event.at]);
    if (notify) await enqueueEventPush(this.db, event);
    return event;
  }
  private async saveMessage(message: Message): Promise<void> {
    const m = messageSchema.parse(message);
    if (m.status === "deleted") {
      // A queued input may be recalled before claim. Once handed to a worker,
      // deletion cannot pretend to undo it or release the execution fence.
      if (await this.db.get("SELECT 1 FROM deliveries WHERE message_id=? AND status='pending' AND dispatched=1", [m.id])) throw new HubError("queue_already_dispatched", 409);
      await this.db.run("UPDATE deliveries SET status='cancelled' WHERE message_id=? AND status='pending' AND dispatched=0", [m.id]);
    }
    const recalled = m.status === "deleted" ? await this.db.all<{ attachment_id: string }>("SELECT attachment_id FROM message_attachments WHERE message_id=?", [m.id]) : [];
    // Store the complete logical message. Socket framing handles the physical
    // byte limit, including historical replay and full conversation snapshots.
    // The discussion marker is written once, at creation; updates never change it.
    await this.db.run("INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,client_msg_id,reply_to,created_at,mentions_json,forwarded_json,preview_url,link_preview_json,preview_style,bot_source_json,discussion_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET blocks_json=excluded.blocks_json,status=excluded.status,version=excluded.version,link_preview_json=excluded.link_preview_json", [m.id, m.conversationId, m.authorId, m.authorType, JSON.stringify(m.blocks), m.status, m.version, m.clientMsgId ?? null, m.replyTo ?? null, m.createdAt, JSON.stringify(m.mentions ?? []), m.forwardedFrom ? JSON.stringify(m.forwardedFrom) : null, m.previewUrl === null ? "" : m.previewUrl ?? null, m.linkPreview ? JSON.stringify(m.linkPreview) : null, m.previewStyle ?? null, m.botSource ? JSON.stringify(m.botSource) : null, m.groupDiscussion ? JSON.stringify(m.groupDiscussion) : null]);
    if (m.status === "deleted") {
      await this.db.run("DELETE FROM run_journal WHERE message_id=?", [m.id]);
      await this.db.run("DELETE FROM run_journal_scoped WHERE message_id=?", [m.id]);
    }
    const rowid = (await this.db.get<{ rowid: number }>("SELECT rowid FROM messages WHERE id=?", [m.id]))!.rowid;
    const indexed = await this.db.get<{ body: string }>("SELECT body FROM messages_fts WHERE rowid=?", [rowid]);
    const body = m.status === "deleted" ? undefined : blocksText(m.blocks);
    if (indexed?.body !== body) {
      await this.db.run("DELETE FROM messages_fts WHERE rowid=?", [rowid]);
      if (body !== undefined) await this.db.run("INSERT INTO messages_fts(rowid,message_id,conversation_id,body) VALUES(?,?,?,?)", [rowid, m.id, m.conversationId, body]);
    }
    await this.db.run("DELETE FROM message_attachments WHERE message_id=?", [m.id]);
    const ids = new Set<string>();
    if (m.linkPreview?.imageAttachmentId) ids.add(m.linkPreview.imageAttachmentId);
    const walk = (elements: import("../client-protocol/index.js").CardElement[]): void => { for (const element of elements) { if (element.attachmentId) ids.add(element.attachmentId); walk(element.children ?? []); } };
    for (const block of m.blocks) { if ("attachmentId" in block) ids.add(block.attachmentId); if (block.type === "card") walk(block.elements); }
    for (const id of ids) {
      if (!await this.db.get("SELECT 1 FROM attachments a WHERE id=? AND conversation_id=? AND complete=1 AND NOT EXISTS(SELECT 1 FROM retired_attachments r WHERE r.attachment_id=a.id)", [id, m.conversationId])) throw new HubError("attachment_not_found", 404);
      await this.db.run("INSERT INTO message_attachments VALUES(?,?)", [m.id, id]);
    }
    for (const { attachment_id: id } of recalled) await this.db.run("INSERT OR IGNORE INTO retired_attachments SELECT ? WHERE NOT EXISTS(SELECT 1 FROM message_attachments WHERE attachment_id=?)", [id, id]);
  }
  private decodeMessage(row: MessageRow): Message {
    return messageSchema.parse({ ...(row.discussion_json ? { groupDiscussion: JSON.parse(row.discussion_json) } : {}), ...(row.bot_source_json ? { botSource: JSON.parse(row.bot_source_json) } : {}), ...(row.preview_style != null ? { previewStyle: row.preview_style } : {}), ...(row.preview_url !== null && row.preview_url !== undefined ? { previewUrl: row.preview_url || null } : {}), ...(row.link_preview_json ? { linkPreview: JSON.parse(row.link_preview_json) } : {}), id: row.id, conversationId: row.conversation_id, authorId: row.author_id, authorType: row.author_type, blocks: JSON.parse(row.blocks_json), status: row.status, version: row.version, ...(row.client_msg_id ? { clientMsgId: row.client_msg_id } : {}), ...(row.reply_to ? { replyTo: row.reply_to } : {}), createdAt: row.created_at, ...(row.forwarded_json ? { forwardedFrom: JSON.parse(row.forwarded_json) } : {}), ...(JSON.parse(row.mentions_json ?? "[]").length ? { mentions: JSON.parse(row.mentions_json) } : {}) });
  }
  async sendMessage(userId: string, input: SendMessageInput, validate?: TransactionGuard): Promise<{ message: Message; duplicate: boolean; workbenchContextOmitted?: "history_limit" }> {
    const result = await this.db.transaction(async () => {
      await validate?.();
      return this.sendMessageInTransaction(userId, input);
    });
    if (result.event) this.emit(result.event);
    return { message: result.message, duplicate: result.duplicate, ...(result.workbenchContextOmitted ? { workbenchContextOmitted: result.workbenchContextOmitted } : {}) };
  }
  /** Caller holds db.transaction and passes the returned event to emitCommitted after commit. */
  async sendMessageInTransaction(userId: string, input: SendMessageInput): Promise<{ message: Message; duplicate: boolean; event?: HubEvent; workbenchContextOmitted?: "history_limit" }> {
    await this.requireMember(userId, input.conversationId);
    const context = input.workbench ? workbenchContextSchema.parse(input.workbench) : undefined;
    if (context && (input.botSource || input.groupDiscussion)) throw new HubError("workbench_context_forbidden", 403);
    const old = await this.db.get<MessageRow>("SELECT * FROM messages WHERE author_id=? AND client_msg_id=?", [userId, input.clientMsgId]);
    if (old) {
      const previous = await this.db.get<{value:string}>("SELECT value FROM meta WHERE key=?", [`workbench-context:${old.id}`]);
      const receipt = old.workbench_receipt_json ? JSON.parse(old.workbench_receipt_json) as WorkbenchContextReceipt : undefined;
      const digest = context ? workbenchContextDigest(JSON.stringify(context)) : undefined;
      if ((receipt?.digest ?? (previous ? workbenchContextDigest(previous.value) : undefined)) !== digest) throw new HubError("idempotency_conflict", 409);
      const origin = old.bot_source_json ? JSON.parse(old.bot_source_json) as Message["botSource"] : undefined;
      if (!!origin !== !!input.botSource || origin && input.botSource && (origin.hostId !== input.botSource.hostId || origin.botId !== input.botSource.botId || origin.requestId !== input.botSource.requestId)) throw new HubError("idempotency_conflict", 409);
      if (old.conversation_id !== input.conversationId || old.forwarded_json || this.decodeMessage(old).blocks.some((b) => b.type === "steering")) throw new HubError("idempotency_conflict", 409);
      return { message: this.decodeMessage(old), duplicate: true, ...(receipt?.omitted ? { workbenchContextOmitted: receipt.omitted } : {}) };
    }
    const conv = await this.conversationRow(input.conversationId);
    if (conv.archived || conv.parentId && (await this.conversationRow(conv.parentId)).archived) throw new HubError("conversation_archived", 409);
    if (input.groupReplyGuard) {
      if (conv.type !== "group" || input.botSource || input.groupDiscussion) throw new HubError("group_reply_mode_changed", 409);
      const settings = await this.groupSettingsInTransaction(conv.parentId ?? conv.id);
      if (settings.revision !== input.groupReplyGuard.revision || settings.policy.mode !== input.groupReplyGuard.mode
        || await this.db.get("SELECT 1 FROM group_discussions WHERE group_id=? AND status IN ('running','pausing','paused','ending')", [settings.group.id])) {
        throw new HubError("group_reply_mode_changed", 409);
      }
    }
    if (!input.botSource && !input.groupDiscussion) await this.requireDiscussionAddressing(conv, input.mentions ?? [], input.groupReplyGuard?.mode);
    // A delegated cross-Bot input obeys the same boundary as a human mention:
    // while a discussion runs here, only the Hub chooses who speaks and what
    // they see (a reply to it would escape first-round sealing). Replays of
    // already accepted requests returned above; rejection rolls back the caller.
    if (input.botSource && conv.type === "group" && await this.db.get("SELECT 1 FROM group_discussions WHERE conversation_id=? AND status IN ('running','pausing','paused','ending')", [conv.id])) throw new HubError("group_discussion_active", 409);
    if (input.groupReplyGuard && automaticGroupDiscussion(input.groupReplyGuard.mode) && new Set(input.mentions ?? []).size !== 1) throw new HubError("group_discussion_start_required", 409);
    // Only ordinary human input may fan out. Explicit recipients always win;
    // delegated Bot tasks and scheduler inputs never become broadcasts.
    const parallel = conv.type === "group" && !input.mentions?.length && !input.botSource && !input.groupDiscussion
      && (await this.groupPolicyInTransaction(conv.parentId ? await this.conversationRow(conv.parentId) : conv)).mode === "parallel";
    if (parallel && input.parallelCapable === false) throw new HubError("group_parallel_client_update_required", 409);
    const targets = input.mentions?.length ? [...new Set(input.mentions)] : conv.type === "direct" || parallel ? conv.botIds : [];
    for (const bot of targets) { if (!conv.botIds.includes(bot)) throw new HubError("mention_forbidden", 403); await this.requireBot(bot, conv.id); }
    const previewStyle = linkPreviewStyleSchema.optional().parse(input.previewStyle);
    const links = extractLinks(input.text);
    const previewUrl = input.previewUrl === null ? null : input.previewUrl === undefined ? links[0] : normalizedLink(input.previewUrl);
    if (input.previewUrl && (!previewUrl || !links.includes(previewUrl))) throw new HubError("preview_url_not_in_message");
    const blocks: Block[] = input.text ? [{ type: "text", text: input.text }] : [];
    for (const id of input.attachments) {
      const file = await this.db.get<AttachmentRow>("SELECT * FROM attachments WHERE id=? AND complete=1 AND conversation_id=?", [id, conv.id]);
      if (!file) throw new HubError("attachment_not_found", 404);
      blocks.push(file.mime.startsWith("image/") ? { type: "image", attachmentId: id, title: file.name } : file.mime.startsWith("audio/") ? { type: "audio", attachmentId: id, name: file.name } : { type: "file", attachmentId: id, name: file.name, size: file.size, mime: file.mime });
    }
    if (!blocks.length) throw new HubError("empty_message");
    if (input.replyTo && !await this.db.get("SELECT 1 FROM messages WHERE id=? AND conversation_id=? AND status!='deleted' AND NOT EXISTS(SELECT 1 FROM message_deletions d WHERE d.message_id=messages.id AND d.user_id=?)", [input.replyTo, conv.id, userId])) throw new HubError("reply_not_found", 404);
    // Freeze the addressed recipients in the existing message contract. This
    // also makes default @-only workers and explicit retries use the same set.
    const mentions = parallel ? targets : input.mentions;
    const message: Message = { ...(input.groupDiscussion ? { groupDiscussion: input.groupDiscussion } : {}), ...(input.botSource ? { botSource: input.botSource } : {}), id: newId("msg"), conversationId: conv.id, authorId: userId, authorType: "user", blocks, ...(previewUrl !== undefined ? { previewUrl } : {}), ...(previewUrl && previewStyle ? { previewStyle } : {}), status: "complete", version: 1, clientMsgId: input.clientMsgId, ...(mentions?.length ? { mentions } : {}), ...(input.replyTo ? { replyTo: input.replyTo } : {}), createdAt: Date.now() };
    await this.saveMessage(message);
    let workbenchContextOmitted: "history_limit" | undefined;
    if (context) {
      const key = `workbench-context:${message.id}`, value = JSON.stringify(context);
      if (await reserveWorkbenchHistory(this.db, key, value)) await this.db.run("INSERT INTO meta(key,value) VALUES(?,?)", [key, value]);
      else workbenchContextOmitted = "history_limit";
      await this.db.run("UPDATE messages SET workbench_receipt_json=? WHERE id=?", [JSON.stringify({ digest: workbenchContextDigest(value), ...(workbenchContextOmitted ? { omitted: workbenchContextOmitted } : {}) } satisfies WorkbenchContextReceipt), message.id]);
    }
    for (const id of input.attachments) await this.db.run("INSERT OR IGNORE INTO message_attachments VALUES(?,?)", [message.id, id]);
    for (const bot of targets) await this.db.run("INSERT INTO deliveries(message_id,bot_id,queue_position) SELECT ?,?,COALESCE(MAX(queue_position),0)+1 FROM deliveries WHERE bot_id=?", [message.id, bot, bot]);
    return { message, duplicate: false, event: await this.append(conv.id, "message.created", message), ...(workbenchContextOmitted ? { workbenchContextOmitted } : {}) };
  }
  /** Headless author publication: transcript-only, never impersonates a Bot or
   * schedules an engine turn. Uses the same durable card as the native tool. */
  async publishUserWidget(userId: string, conversationId: string, requestId: string, block: Extract<Block, { type: "card" }>, validate?: TransactionGuard, validatePublication?: () => void): Promise<Message> {
    const result = await this.db.transaction(async () => {
      await validate?.(); await this.requireMember(userId, conversationId);
      const old = await this.db.get<MessageRow>("SELECT * FROM messages WHERE author_id=? AND client_msg_id=?", [userId, requestId]);
      if (old) {
        const message = this.decodeMessage(old);
        if (message.conversationId !== conversationId || JSON.stringify(message.blocks) !== JSON.stringify([block])) throw new HubError("idempotency_conflict", 409);
        return { message };
      }
      validatePublication?.();
      const conv = await this.conversationRow(conversationId);
      if (conv.archived || conv.parentId && (await this.conversationRow(conv.parentId)).archived) throw new HubError("conversation_archived", 409);
      const message: Message = { id: newId("msg"), conversationId, authorId: userId, authorType: "user", blocks: [block], status: "complete", version: 1, clientMsgId: requestId, createdAt: Date.now() };
      await this.saveMessage(message);
      return { message, event: await this.append(conversationId, "message.created", message) };
    });
    if (result.event) this.emit(result.event);
    return result.message;
  }
  /** Emit events whose transaction has committed. */
  emitCommitted(events: HubEvent[]): void { for (const event of events) this.emit(event); }
  /** Durable transcript only: explicit controls must never enter deliveries. */
  async beginSteering(userId: string, input: { conversationId: string; botId: string; requestId: string; targetId: string; text: string; mode?: "message" }, validate?: TransactionGuard): Promise<Message> {
    return (await this.beginSteeringRecord(userId, input, validate)).message;
  }
  /** `workbench` is the caller-validated opener-only context of a new input.
   * A retry is matched by digest only: a vanished opener cannot fail it. */
  async beginSteeringRecord(userId: string, input: { conversationId: string; botId: string; requestId: string; targetId: string; text: string; mode?: "message"; workbench?: WorkbenchContext }, validate?: (created: boolean) => Promise<unknown>): Promise<{ message: Message; created: boolean }> {
    const context = input.workbench ? workbenchContextSchema.parse(input.workbench) : undefined;
    const result = await this.db.transaction(async () => {
      await this.requireMember(userId, input.conversationId);
      await this.requireBot(input.botId, input.conversationId);
      const old = await this.db.get<MessageRow>("SELECT * FROM messages WHERE author_id=? AND client_msg_id=?", [userId, input.requestId]);
      // Only a new record revalidates the live opener; retries keep the original.
      await validate?.(!old);
      if (old) {
        const message = this.decodeMessage(old), control = message.blocks.find((block) => block.type === "steering");
        if (message.conversationId !== input.conversationId || !control || control.botId !== input.botId || control.targetId !== input.targetId || (input.mode !== undefined && control.mode !== input.mode) || blocksText(message.blocks) !== input.text) throw new HubError("idempotency_conflict", 409);
        const receipt = old.workbench_receipt_json ? JSON.parse(old.workbench_receipt_json) as SteeringInputReceipt : undefined;
        if (receipt?.digest !== (context ? workbenchContextDigest(JSON.stringify(context)) : undefined)) throw new HubError("idempotency_conflict", 409);
        return { message, created: false };
      }
      const conv = await this.conversationRow(input.conversationId);
      if (conv.archived || conv.parentId && (await this.conversationRow(conv.parentId)).archived) throw new HubError("conversation_archived", 409);
      const message: Message = { id: newId("msg"), conversationId: conv.id, authorId: userId, authorType: "user", clientMsgId: input.requestId, mentions: [input.botId],
        status: "complete", version: 1, createdAt: Date.now(), blocks: [{ type: "text", text: input.text }, { type: "steering", botId: input.botId, targetId: input.targetId, outcome: "pending", ...(input.mode ? { mode: input.mode } : {}) }] };
      await this.saveMessage(message);
      if (context) {
        const key = `workbench-context:${message.id}`, value = JSON.stringify(context), stored = await reserveWorkbenchHistory(this.db, key, value);
        if (stored) await this.db.run("INSERT INTO meta(key,value) VALUES(?,?)", [key, value]);
        await this.db.run("UPDATE messages SET workbench_receipt_json=? WHERE id=?", [JSON.stringify({ digest: workbenchContextDigest(value), ...(stored ? {} : { omitted: "history_limit" as const }) } satisfies SteeringInputReceipt), message.id]);
      }
      return { message, created: true, event: await this.append(conv.id, "message.created", message) };
    });
    if (result.event) this.emit(result.event);
    return { message: result.message, created: result.created };
  }
  /** A Bot reported that a user input may have reached the live run of
   * `sourceMessageId`. Kept on that source row: a keyed, bounded lookup that
   * survives reconnects. Overflow is remembered so lookups fail closed. */
  async bindRunInput(sourceMessageId: string, inputId: string): Promise<void> {
    if (sourceMessageId === inputId) return;
    await this.db.transaction(async () => {
      const row = await this.db.get<{ workbench_receipt_json: string | null }>("SELECT workbench_receipt_json FROM messages WHERE id=?", [sourceMessageId]);
      if (!row) return;
      const receipt: SteeringInputReceipt = row.workbench_receipt_json ? JSON.parse(row.workbench_receipt_json) : {}, inputs = receipt.inputs ?? [];
      if (inputs.includes(inputId)) return;
      const next = [...inputs, inputId];
      await this.db.run("UPDATE messages SET workbench_receipt_json=? WHERE id=?", [JSON.stringify({ ...receipt, inputs: next.slice(-MAX_RUN_INPUTS), ...(receipt.inputsTruncated || next.length > MAX_RUN_INPUTS ? { inputsTruncated: true } : {}) } satisfies SteeringInputReceipt), sourceMessageId]);
    });
  }
  /** Inputs bound to a run source, oldest first, including deleted ones. */
  async runInputs(sourceMessageId: string): Promise<{ inputs: Message[]; truncated: boolean }> {
    return this.db.serial(async () => {
      const row = await this.db.get<{ workbench_receipt_json: string | null }>("SELECT workbench_receipt_json FROM messages WHERE id=?", [sourceMessageId]);
      const receipt: SteeringInputReceipt = row?.workbench_receipt_json ? JSON.parse(row.workbench_receipt_json) : {}, inputs: Message[] = [];
      for (const id of receipt.inputs ?? []) { const input = await this.db.get<MessageRow>("SELECT * FROM messages WHERE id=?", [id]); if (input) inputs.push(this.decodeMessage(input)); }
      return { inputs, truncated: receipt.inputsTruncated === true || inputs.length !== (receipt.inputs ?? []).length };
    });
  }
  async recoverSteering(): Promise<void> {
    const rows = await this.db.serial(() => this.db.all<MessageRow>("SELECT * FROM messages WHERE author_type='user' AND blocks_json LIKE '%\"type\":\"steering\"%'"));
    for (const row of rows) if (this.decodeMessage(row).blocks.some((block) => block.type === "steering" && block.outcome === "pending")) await this.finishSteering(row.id, { outcome: "unknown", reason: "uncertain" });
  }
  /** Only the Bot addressed by this user's original input may report adoption. */
  async applySteeringOutcome(botId: string, raw: unknown): Promise<void> {
    const input = z.object({ conversationId: idSchema, userId: idSchema, requestId: idSchema, targetId: idSchema, application: steeringApplicationSchema }).strict().parse(raw);
    const event = await this.db.transaction(async () => {
      await this.requireMember(input.userId, input.conversationId);
      await this.requireBot(botId, input.conversationId);
      const row = await this.db.get<MessageRow>("SELECT * FROM messages WHERE author_type='user' AND conversation_id=? AND author_id=? AND client_msg_id=?", [input.conversationId, input.userId, input.requestId]);
      if (!row) throw new HubError("message_not_found", 404);
      const message = this.decodeMessage(row), control = message.blocks.find(block => block.type === "steering");
      if (message.conversationId !== input.conversationId || !control || control.botId !== botId || control.targetId !== input.targetId) throw new HubError("steering_target_mismatch", 409);
      if (control.application || control.outcome === "rejected") return;
      message.blocks = message.blocks.map(block => block.type === "steering" ? { ...block, application: input.application } : block);
      message.version++;
      await this.saveMessage(message);
      return this.append(message.conversationId, "message.updated", message);
    });
    if (event) this.emit(event);
  }
  /** A model receipt is distinct from native admission and turn completion. */
  async applyNativeInputProgress(botId: string, raw: unknown): Promise<void> {
    const input = z.object({ conversationId: idSchema, userId: idSchema, requestId: idSchema, targetId: idSchema, progress: nativeInputProgressSchema }).strict().parse(raw);
    const event = await this.db.transaction(async () => {
      await this.requireMember(input.userId, input.conversationId);
      await this.requireBot(botId, input.conversationId);
      const row = await this.db.get<MessageRow>("SELECT * FROM messages WHERE author_type='user' AND conversation_id=? AND author_id=? AND client_msg_id=?", [input.conversationId, input.userId, input.requestId]);
      if (!row) throw new HubError("message_not_found", 404);
      const message = this.decodeMessage(row), control = message.blocks.find(block => block.type === "steering");
      if (!control || control.botId !== botId || control.targetId !== input.targetId || control.mode !== "message") throw new HubError("steering_target_mismatch", 409);
      const previous = control.nativeInput?.state, next = input.progress.state;
      // Duplicate journal delivery and delayed lifecycle ACKs cannot regress a
      // stronger observation. Unknown remains upgradable after reconnect, but
      // an engine exit cannot be re-queued by an old worker's replayed journal.
      if (previous === next && control.nativeInput?.reason === input.progress.reason || previous === "received" || previous === "cancelled" || previous === "dropped" || previous === "dequeued" && next === "queued"
        || previous === "unknown" && control.nativeInput?.reason === "engine_exit" && (next === "queued" || next === "dequeued")) return;
      if (control.outcome === "rejected") return;
      const admitted = ["queued", "dequeued", "received", "cancelled"].includes(next);
      message.blocks = message.blocks.map(block => {
        if (block.type !== "steering") return block;
        const { reason: _reason, ...withoutReason } = block;
        return { ...(admitted ? { ...withoutReason, outcome: "accepted" as const } : block), nativeInput: input.progress };
      });
      message.version++;
      await this.saveMessage(message);
      return this.append(message.conversationId, "message.updated", message);
    });
    if (event) this.emit(event);
  }
  /** A worker attached at `before` runs a new native process: inputs admitted
   * earlier can no longer be received, sent now or withdrawn. Its final report
   * may have been lost with the old worker. `before` is the worker's stable
   * attach time, so a socket reconnect of the same worker retires nothing.
   * A send still pending on the replaced socket is retired too: its outcome is
   * settled later from evidence, but no admission can make it controllable.
   * Model receipts and other terminal observations are never downgraded. */
  async retireNativeInputs(botId: string, before: number): Promise<void> {
    const events = await this.db.transaction(async () => {
      const rows = await this.db.all<MessageRow>(`SELECT m.* FROM messages m WHERE m.author_type='user' AND m.created_at < ?
        AND m.conversation_id IN (SELECT conversation_id FROM conversation_members WHERE member_type='bot' AND member_id=?)
        AND m.blocks_json LIKE '%"type":"steering"%'
        AND EXISTS (SELECT 1 FROM json_each(m.blocks_json) b WHERE json_extract(b.value,'$.type')='steering'
          AND json_extract(b.value,'$.botId')=? AND json_extract(b.value,'$.mode')='message'
          AND json_extract(b.value,'$.outcome') IN ('pending','accepted','unknown')
          AND COALESCE(json_extract(b.value,'$.nativeInput.state'),'queued') IN ('queued','dequeued'))`, [before, botId, botId]);
      const events: HubEvent[] = [];
      for (const row of rows) {
        const message = this.decodeMessage(row);
        let changed = false;
        message.blocks = message.blocks.map(block => {
          if (block.type !== "steering" || block.botId !== botId || block.mode !== "message" || !["pending", "accepted", "unknown"].includes(block.outcome)
            || !["queued", "dequeued", undefined].includes(block.nativeInput?.state)) return block;
          changed = true;
          return { ...block, nativeInput: { state: "unknown" as const, reason: "engine_exit" } };
        });
        if (!changed) continue;
        message.version++;
        await this.saveMessage(message);
        events.push(await this.append(message.conversationId, "message.updated", message));
      }
      return events;
    });
    this.emitCommitted(events);
  }
  async nativeInputForControl(userId: string, conversationId: string, messageId: string): Promise<{ botId: string; inputId: string; targetId: string }> {
    await this.requireMember(userId, conversationId);
    const row = await this.db.get<MessageRow>("SELECT * FROM messages WHERE id=? AND conversation_id=? AND author_id=? AND author_type='user'", [messageId, conversationId, userId]);
    if (!row) throw new HubError("message_not_found", 404);
    const message = this.decodeMessage(row), control = message.blocks.find(block => block.type === "steering");
    if (control?.mode !== "message" || !message.clientMsgId) throw new HubError("not_native_input", 409);
    await this.requireBot(control.botId, conversationId);
    return { botId: control.botId, inputId: message.clientMsgId, targetId: control.targetId };
  }
  async finishSteering(id: string, result: SteerResult): Promise<Message> {
    const update = await this.db.transaction(async () => {
      const row = await this.db.get<MessageRow>("SELECT * FROM messages WHERE id=?", [id]);
      if (!row) throw new HubError("message_not_found", 404);
      const old = this.decodeMessage(row), control = old.blocks.find((block) => block.type === "steering");
      if (!control) throw new HubError("not_steering");
      // A late timeout or duplicate caller may not downgrade a definitive receipt.
      if (control.outcome === "accepted" || control.outcome === "rejected") return { message: old };
      const receipt = steerResultSchema.parse(result);
      // A definite rejection proves a retired input never entered the CLI.
      const retired = (block: Extract<Block, { type: "steering" }>) => receipt.outcome === "rejected" && block.nativeInput?.reason === "engine_exit";
      const message = { ...old, version: old.version + 1, blocks: old.blocks.map((block) => block.type !== "steering" ? block : retired(block) ? (({ nativeInput: _retired, ...rest }) => ({ ...rest, ...receipt }))(block) : { ...block, ...receipt }) };
      await this.saveMessage(message);
      return { message, event: await this.append(message.conversationId, "message.updated", message) };
    });
    if (update.event) this.emit(update.event);
    return update.message;
  }
  /** Human sends and forwards share discussion addressing. A no-reply share
   * has no recipients; it never creates a parallel scheduler bypass. Replays
   * are returned before this guard, even if a run started after delivery. */
  private async requireDiscussionAddressing(conv: Conversation, mentions: string[], mode?: GroupDiscussionPolicy["mode"]): Promise<void> {
    if (conv.type !== "group" || !mentions.length) return;
    if (await this.db.get("SELECT 1 FROM group_discussions WHERE conversation_id=? AND status IN ('running','pausing','paused','ending')", [conv.id])) throw new HubError("group_discussion_active", 409);
    const policyMode = mode ?? (await this.groupPolicyInTransaction(conv.parentId ? await this.conversationRow(conv.parentId) : conv)).mode;
    if (automaticGroupDiscussion(policyMode) && new Set(mentions).size > 1) throw new HubError("group_discussion_start_required", 409);
  }
  // The file layer links immutable bytes while this transaction holds authorization
  // and the source snapshot stable. It removes any new links on rollback.
  async forwardMessage(userId: string, input: Extract<ClientFrame, { type: "message.forward" }>, copy: (file: AttachmentRow, id: string) => Promise<void>, validate?: TransactionGuard): Promise<{ message: Message; duplicate: boolean }> {
    const result = await this.db.transaction(async () => {
      await validate?.();
      await this.requireMember(userId, input.conversationId);
      const old = await this.db.get<MessageRow>("SELECT * FROM messages WHERE author_id=? AND client_msg_id=?", [userId, input.clientMsgId]);
      if (old) {
        const message = this.decodeMessage(old);
        if (message.conversationId !== input.conversationId || message.forwardedFrom?.messageId !== input.sourceMessageId || JSON.stringify(message.mentions ?? []) !== JSON.stringify([...new Set(input.mentions ?? [])])) throw new HubError("idempotency_conflict", 409);
        return { message, duplicate: true };
      }
      const row = await this.db.get<MessageRow>("SELECT * FROM messages WHERE id=? AND NOT EXISTS(SELECT 1 FROM message_deletions d WHERE d.message_id=messages.id AND d.user_id=?)", [input.sourceMessageId, userId]);
      if (!row) throw new HubError("message_not_found", 404);
      await this.requireMember(userId, row.conversation_id);
      const original = this.decodeMessage(row);
      if (!["complete", "error"].includes(original.status)) throw new HubError("message_not_ready", 409);
      const conv = await this.conversationRow(input.conversationId), source = await this.conversationRow(original.conversationId);
      if (conv.archived || conv.parentId && (await this.conversationRow(conv.parentId)).archived) throw new HubError("conversation_archived", 409);
      const mentions = [...new Set(input.mentions ?? [])];
      for (const bot of mentions) if (!conv.botIds.includes(bot)) throw new HubError("mention_forbidden", 403);
      await this.requireDiscussionAddressing(conv, mentions);
      const remapped = new Map<string, string>();
      const attachmentIds = new Set(messageAttachmentIds(original.blocks));
      if (original.linkPreview?.imageAttachmentId) attachmentIds.add(original.linkPreview.imageAttachmentId);
      for (const sourceId of attachmentIds) {
        const file = await this.db.get<AttachmentRow>("SELECT * FROM attachments WHERE id=? AND conversation_id=? AND complete=1", [sourceId, source.id]);
        if (!file) throw new HubError("attachment_not_found", 404);
        const id = newId("att"); await copy(file, id);
        await this.db.run("INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?,1,?)", [id, conv.id, userId, file.sha256, file.size, file.mime, file.name, `${id}.blob`, Date.now()]);
        remapped.set(sourceId, id);
      }
      const author = original.authorType === "bot" ? await this.db.get<{ name: string }>("SELECT name FROM bots WHERE id=?", [original.authorId]) : await this.db.get<{ name: string }>("SELECT name FROM users WHERE id=?", [original.authorId]);
      const originalAuthor = original.botSource ? `${original.botSource.botName} · ${original.botSource.hostName}` : author?.name ?? original.authorId;
      const title = source.parentId ? `${(await this.conversationRow(source.parentId)).title} / ${source.title}` : source.title;
      const message: Message = { id: newId("msg"), conversationId: conv.id, authorId: userId, authorType: "user", blocks: forwardedBlocks(original.blocks, remapped), status: "complete", version: 1, clientMsgId: input.clientMsgId, ...(mentions.length ? { mentions } : {}), createdAt: Date.now(), forwardedFrom: { messageId: original.id, conversationId: source.id, conversationTitle: title, authorName: originalAuthor.slice(0, 256), createdAt: original.createdAt } };
      if (original.previewUrl !== undefined) message.previewUrl = original.previewUrl;
      if (original.previewStyle) message.previewStyle = original.previewStyle;
      if (original.linkPreview) message.linkPreview = { ...original.linkPreview, ...(original.linkPreview.imageAttachmentId ? { imageAttachmentId: remapped.get(original.linkPreview.imageAttachmentId)! } : {}) };
      await this.saveMessage(message);
      for (const bot of mentions) await this.db.run("INSERT INTO deliveries(message_id,bot_id,queue_position) SELECT ?,?,COALESCE(MAX(queue_position),0)+1 FROM deliveries WHERE bot_id=?", [message.id, bot, bot]);
      return { message, duplicate: false, event: await this.append(conv.id, "message.created", message) };
    });
    if (result.event) this.emit(result.event);
    return { message: result.message, duplicate: result.duplicate };
  }
  pendingLinkPreviews(): Promise<Message[]> {
    return this.db.serial(async () => (await this.db.all<MessageRow>("SELECT m.* FROM messages m WHERE author_type='user' AND status IN ('complete','error') AND preview_url IS NOT NULL AND preview_url!='' AND link_preview_json IS NULL AND EXISTS(SELECT 1 FROM conversation_members c WHERE c.conversation_id=m.conversation_id AND c.member_type='user' AND c.member_id=m.author_id) ORDER BY created_at,rowid LIMIT 4")).map((row) => this.decodeMessage(row)));
  }
  async setLinkPreview(id: string, input: LinkPreview): Promise<void> {
    const preview = linkPreviewSchema.parse(input);
    const event = await this.db.transaction(async () => {
      const row = await this.db.get<MessageRow>("SELECT * FROM messages WHERE id=?", [id]);
      if (!row || row.author_type !== "user" || !["complete", "error"].includes(row.status) || row.link_preview_json || row.preview_url !== preview.url) return;
      const message = { ...this.decodeMessage(row), linkPreview: preview, version: row.version + 1 };
      await this.saveMessage(message); return this.append(message.conversationId, "message.updated", message);
    });
    if (event) this.emit(event);
  }
  async publishBotMessage(botId: string, input: BotPublishInput, validatePublication?: (blocks: Block[], previous: Block[]) => void): Promise<Message> {
    const result = await this.db.transaction(() => this.publishBotMessageInTransaction(botId, input, validatePublication));
    if (result.event) this.emit(result.event);
    return result.message;
  }
  /** Caller holds db.transaction and passes the returned event to emitCommitted after commit. */
  async publishBotMessageInTransaction(botId: string, input: BotPublishInput, validatePublication?: (blocks: Block[], previous: Block[]) => void): Promise<{ message: Message; event?: HubEvent }> {
    await this.requireBot(botId, input.conversationId);
    const row = input.id ? await this.db.get<MessageRow>("SELECT * FROM messages WHERE id=?", [input.id]) : undefined;
    if (row && (row.author_id !== botId || row.author_type !== "bot" || row.conversation_id !== input.conversationId)) throw new HubError("message_forbidden", 403);
    const old = row ? this.decodeMessage(row) : undefined;
    if (old && input.version !== undefined && input.version <= old.version) return { message: old };
    const replyTo = input.replyTo ?? old?.replyTo;
    if (replyTo && await this.db.get("SELECT 1 FROM deliveries WHERE message_id=? AND bot_id=? AND status='failed'", [replyTo, botId])) {
      if (old) return { message: old };
      throw new HubError("delivery_already_failed", 409);
    }
    const message = messageSchema.parse({ id: input.id ?? newId("msg"), conversationId: input.conversationId, authorId: botId, authorType: "bot", blocks: input.status === "deleted" ? [] : input.blocks, status: input.status ?? "complete", version: input.version ?? ((old?.version ?? 0) + 1), ...(replyTo ? { replyTo } : {}), createdAt: old?.createdAt ?? Date.now() });
    validatePublication?.(message.blocks, old?.blocks ?? []);
    await this.saveMessage(message);
    return { message, event: await this.append(input.conversationId, old ? "message.updated" : "message.created", message) };
  }
  messageForBot(botId: string, id: string): Promise<Message> { return this.db.serial(async () => { const row = await this.db.get<MessageRow>("SELECT * FROM messages WHERE id=?", [id]); if (!row) throw new HubError("message_not_found", 404); await this.requireBot(botId, row.conversation_id); await this.requireUnsealedInTransaction(botId, [id]); return this.decodeMessage(row); }); }
  /** Independent first round: until the Hub reveals it, no other Bot (member
   * or later-added) can read a participant's reply (or its files) to a blind
   * input. Decided by joining the Hub's turn records, never by message fields. */
  async requireUnsealedInTransaction(botId: string, messageIds: string[]): Promise<void> {
    if (!messageIds.length) return;
    const sealed = await this.db.get(`SELECT 1 FROM messages m JOIN group_discussion_turns t ON t.input_message_id=m.reply_to AND t.bot_id=m.author_id AND t.blind=1
      JOIN group_discussions d ON d.id=t.discussion_id AND d.stage='blind' AND d.status IN ('running','pausing','paused','ending')
      WHERE m.id IN (SELECT value FROM json_each(?)) AND m.author_type='bot' AND m.author_id!=? LIMIT 1`, [JSON.stringify(messageIds), botId]);
    if (sealed) throw new HubError("group_discussion_sealed", 403);
  }
  async requireAttachmentUnsealed(botId: string, attachmentId: string): Promise<void> {
    await this.db.serial(async () => {
      const rows = await this.db.all<{ message_id: string }>("SELECT message_id FROM message_attachments WHERE attachment_id=?", [attachmentId]);
      await this.requireUnsealedInTransaction(botId, rows.map(row => row.message_id));
    });
  }
  messageForUser(userId: string, id: string): Promise<Message> { return this.db.serial(async () => { const row = await this.db.get<MessageRow>("SELECT * FROM messages WHERE id=? AND NOT EXISTS(SELECT 1 FROM message_deletions d WHERE d.message_id=messages.id AND d.user_id=?)", [id, userId]); if (!row) throw new HubError("message_not_found", 404); await this.requireMember(userId, row.conversation_id); return this.decodeMessage(row); }); }
  /** Queue operations already hold the database transaction and emit only after commit. */
  async queuedMessageInTransaction(id: string): Promise<Message> {
    const row = await this.db.get<MessageRow>("SELECT * FROM messages WHERE id=?", [id]);
    if (!row) throw new HubError("message_not_found", 404);
    return this.decodeMessage(row);
  }
  async updateQueuedMessageInTransaction(message: Message): Promise<HubEvent> {
    await this.saveMessage(message);
    return this.append(message.conversationId, "message.updated", message, false);
  }
  queueEventInTransaction(conversationId: string, botId: string): Promise<HubEvent> {
    return this.append(conversationId, "turn.state", { promptQueue: { botId, changed: true } }, false);
  }
  emitQueueEvents(events: HubEvent[]): void { for (const event of events) this.emit(event); }
  pendingForBot(botId: string): Promise<Message[]> { return this.db.serial(async () => (await this.db.all<MessageRow>("SELECT m.* FROM messages m JOIN deliveries d ON m.id=d.message_id WHERE d.bot_id=? AND d.status='pending' ORDER BY m.created_at,m.rowid", [botId])).map((r) => this.decodeMessage(r))); }
  async acknowledgeDelivery(botId: string, id: string): Promise<void> { await this.db.serial(() => this.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=? AND status='pending'", [id, botId])); }
  /** Close one failed input atomically. A disconnected socket alone is not a
   * failed turn: only its owning instance's durable receipt takes this path. */
  async failDelivery(botId: string, messageId: string, reason: "interrupted" | "failed"): Promise<void> {
    const events = await this.db.transaction(async () => {
      const input = await this.db.get<MessageRow & { delivery_status: string }>("SELECT m.*,d.status AS delivery_status FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE m.id=? AND d.bot_id=?", [messageId, botId]);
      if (!input) throw new HubError("delivery_forbidden", 403);
      await this.requireBot(botId, input.conversation_id);
      if (input.delivery_status !== "pending") return [];
      const events: HubEvent[] = [];
      const note = reason === "interrupted" ? "处理因实例重启而中断，以上内容已保留，待确认操作已关闭。" : "处理未完成，以上内容已保留，待确认操作已关闭。";
      const actionable = (elements: CardElement[]): boolean => elements.some((e) => Boolean(e.actionId && !e.disabled) || actionable(e.children ?? []));
      const rows = await this.db.all<MessageRow>("SELECT * FROM messages WHERE conversation_id=? AND reply_to=? AND author_id=? AND author_type='bot' AND status!='deleted'", [input.conversation_id, messageId, botId]);
      for (const row of rows) {
        const old = this.decodeMessage(row);
        if (!["pending", "streaming"].includes(old.status) && !old.blocks.some((b) => b.type === "card" && (actionable(b.elements) || activeAnswerFollowup(answerFollowup(b)) || (anyRun(b) && isRunActive(anyRun(b)!.phase))))) continue;
        const message = this.interruptedRunMessage(old, reason, note);
        await this.saveMessage(message); events.push(await this.append(message.conversationId, "message.updated", message));
      }
      const id = `recovery_${createHash("sha256").update(`${botId}:${messageId}`).digest("hex").slice(0, 32)}`;
      // A durable Stop is not a request to retry after worker recovery. Match
      // the admitted input, never client-controlled message/card metadata.
      const stoppedBus = await this.db.get("SELECT 1 FROM agent_bus_runs WHERE message_id=? AND coordinator_id=? AND stop_requested=1", [messageId, botId]);
      const recoveryText = stoppedBus ? "协作已按停止请求结束，收到的结果已保留，不会自动重试。"
        : reason === "interrupted" ? "实例在处理此消息时重启。已保留收到的结果；为避免重复执行，已停止自动重试。请检查结果后重新发送。" : "此消息未处理完成，请检查已收到的结果和实例状态后重新发送。";
      const message: Message = { id, conversationId: input.conversation_id, authorId: botId, authorType: "bot", replyTo: messageId, version: 1, status: "error", createdAt: Date.now(), blocks: [{ type: "text", text: recoveryText }] };
      await this.saveMessage(message); events.push(await this.append(message.conversationId, "message.created", message));
      await this.db.run("UPDATE deliveries SET status='failed' WHERE message_id=? AND bot_id=?", [messageId, botId]);
      await this.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), botId, "delivery.failed", JSON.stringify({ messageId, reason, settled: events.length - 1 })]);
      return events;
    });
    for (const event of events) this.emit(event);
  }
  private interruptedRunMessage(old: Message, reason: "interrupted" | "failed", note: string, orphanQueue = false): Message {
    const attachments = new Map([...messageAttachmentIds(old.blocks)].map((id) => [id, id]));
    const preserved = old.blocks.flatMap(original => forwardedBlocks([original], attachments).map((block): Block => {
      const run = original.type === "card" ? anyRun(original) : undefined;
      // Forwarding strips grouping; an interrupted member keeps its validated
      // original record, still bound to the same scoped run ID.
      const group = original.type === "card" && original.extra?.scopedRun !== undefined && run && backgroundTaskGroup(original, run) ? original.extra.backgroundTaskGroup : undefined;
      const answer = original.type === "card" ? answerFollowup(original) : undefined;
      const queue = original.type === "card" ? queueNotice(original, old) : undefined;
      if (block.type === "card" && queue && ["queued", "started"].includes(queue.state)) {
        const { cancel: _cancel, ...data } = queue;
        const state = orphanQueue ? "expired" : reason === "failed" ? "failed" : "interrupted";
        const summary = orphanQueue ? "排队提示已失效" : reason === "failed" ? "排队任务未能执行" : "排队已中断";
        return { ...block, summary, extra: { ...block.extra, appQueue: { ...data, state } },
          elements: [{ type: "markdown", text: orphanQueue ? "排队提示已失效，实际结果请查看本对话的后续回复。" : note }] };
      }
      if (block.type === "card" && answer && activeAnswerFollowup(answer)) {
        const text = answer.locale === "en" ? "Follow-up interrupted. Your answer is kept here; check the conversation before retrying." : "后续处理已中断，你的答案保留在此，请查看对话后再决定是否重试。";
        return { ...block, title: answer.locale === "en" ? "Answer follow-up interrupted" : "补答处理已中断", extra: { ...block.extra, answerFollowup: { ...answer, phase: "interrupted" } },
          elements: block.elements.filter(element => element.type !== "button").map(element => element.id === "answer_followup_status" ? { ...element, text } : element) };
      }
      return block.type === "card" ? { ...block,
      ...(run ? { extra: { ...block.extra, ...(group !== undefined ? { backgroundTaskGroup: group } : {}), [original.type === "card" && original.extra?.scopedRun !== undefined ? "scopedRun" : "nativeRun"]: { ...JSON.parse(JSON.stringify(run)), phase: reason === "interrupted" ? "interrupted" : "error", revision: run.revision + 1, updatedAt: Date.now(), endedAt: Date.now() } } } : {}),
      title: reason === "interrupted" ? "处理已中断" : "处理未完成", template: "orange",
      elements: run ? [...block.elements, { type: "markdown", text: note }] : [{ type: "markdown", text: note }, { type: "collapsible", text: block.title ? `中断前：${block.title}` : "查看中断前的内容", open: false, children: block.elements }],
    } : block; }));
    const expiredNoticeOnly = orphanQueue && old.blocks.length > 0 && old.blocks.every(block => block.type === "card" && ["queued", "started"].includes(queueNotice(block, old)?.state ?? ""));
    return { ...old, version: old.version + 1, status: expiredNoticeOnly ? "complete" : "error", blocks: preserved.length && preserved.every((b) => b.type === "card") ? preserved : [{ type: "text", text: note }, ...preserved] };
  }
  /** Only a new worker attachment invokes this, never an ordinary reconnect.
   * Pending input deliveries have their own durable receipt recovery. Scheduled
   * and autonomous runs need an explicit terminal record after their worker dies. */
  async recoverOrphanRuns(botId: string, before: number): Promise<void> {
    const events = await this.db.transaction(async () => {
      const rows = await this.db.all<MessageRow>(`SELECT m.* FROM messages m JOIN conversation_members cm
        ON cm.conversation_id=m.conversation_id AND cm.member_type='bot' AND cm.member_id=m.author_id
        WHERE m.author_id=? AND m.author_type='bot' AND m.status IN ('pending','streaming','complete')
        AND EXISTS (SELECT 1 FROM json_each(m.blocks_json) b
          WHERE json_extract(b.value,'$.type')='card'
          AND ((json_extract(b.value,'$.extra.nativeRun.phase') IN (${activeRunPhaseParams})
            AND json_extract(b.value,'$.extra.nativeRun.startedAt') < ?)
            OR (json_extract(b.value,'$.extra.scopedRun.phase') IN (${activeRunPhaseParams})
            AND json_extract(b.value,'$.extra.scopedRun.startedAt') < ?)
            OR (json_extract(b.value,'$.extra.answerFollowup.phase') IN ('queued','processing')
            AND json_extract(b.value,'$.extra.answerFollowup.startedAt') < ?)
            OR (json_extract(b.value,'$.extra.appQueue.state') IN ('queued','started') AND json_extract(b.value,'$.extra.appQueue.at') < ?)
            OR (json_type(b.value,'$.extra.appQueue') IS NULL AND m.created_at < ?
              AND json_extract(b.value,'$.extra.schema')='2.0' AND json_extract(b.value,'$.layout.padding')='8px 12px 8px 12px'
              AND json_array_length(b.value,'$.elements')=2 AND json_extract(b.value,'$.elements[1].value.cctb_lark')='stop')))
        AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id=m.reply_to AND d.bot_id=m.author_id AND d.status='pending')`, [botId, ...activeRunPhases, before, ...activeRunPhases, before, before, before, before]);
      const events: HubEvent[] = [];
      for (const row of rows) {
        const old = this.decodeMessage(row);
        // A first publication replayed from the old worker's outbox receives a
        // new Hub createdAt. The run's own start time identifies its attachment.
        if (!old.blocks.some(block => {
          if (block.type !== "card") return false;
          const run = anyRun(block), answer = answerFollowup(block);
          const queue = queueNotice(block, old);
          return (run && run.startedAt < before && isRunActive(run.phase)) || (answer && answer.startedAt < before && activeAnswerFollowup(answer)) || (queue && ["queued", "started"].includes(queue.state) && queue.at < before);
        })) continue;
        const message = this.interruptedRunMessage(old, "interrupted", "处理因实例重启而中断，以上内容已保留，待确认操作已关闭。", true);
        await this.saveMessage(message); events.push(await this.append(message.conversationId, "message.updated", message));
      }
      if (events.length) await this.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), botId, "runs.recovered", JSON.stringify({ before, settled: events.length })]);
      return events;
    });
    for (const event of events) this.emit(event);
  }
  async appendBotEvent(botId: string, conversationId: string, kind: "turn.state" | "reaction", payload: unknown): Promise<void> { const event = await this.db.transaction(async () => { await this.requireBot(botId, conversationId); return this.append(conversationId, kind, payload); }); this.emit(event); }
  async markRead(userId: string, conversationId: string, seq: number, validate?: TransactionGuard): Promise<void> {
    const event = await this.db.transaction(async () => {
      await validate?.();
      await this.requireMember(userId, conversationId);
      const max = (await this.db.get<{ seq: number }>("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE conversation_id=?", [conversationId]))!.seq;
      const previous = (await this.db.get<{ seq: number }>("SELECT seq FROM reads WHERE user_id=? AND conversation_id=?", [userId, conversationId]))?.seq ?? 0;
      const next = Math.max(previous, Math.min(seq, max));
      if (next === previous) return;
      await this.db.run("INSERT INTO reads VALUES(?,?,?) ON CONFLICT(user_id,conversation_id) DO UPDATE SET seq=excluded.seq", [userId, conversationId, next]);
      return this.append(conversationId, "read", { userId, seq: next });
    });
    if (event) this.emit(event);
  }
  /** Personal history deletion never recalls delivery or changes engine context. */
  async deleteMessages(userId: string, conversationId: string, input: { messageIds: string[] }, validate?: TransactionGuard): Promise<{ deletedIds: string[] }> {
    const ids = [...new Set(deleteMessagesSchema.parse(input).messageIds)];
    const events = await this.db.transaction(async () => {
      await validate?.(); await this.requireMember(userId, conversationId);
      const rows = await this.db.all<MessageRow>(`SELECT * FROM messages WHERE conversation_id=? AND id IN (${ids.map(() => "?").join(",")})`, [conversationId, ...ids]);
      if (rows.length !== ids.length) throw new HubError("message_not_found", 404);
      const events: HubEvent[] = [];
      for (const row of rows) events.push(...await this.hideMessageInTransaction(userId, conversationId, row.id, () => deletedMessage(this.decodeMessage(row))));
      return events;
    });
    for (const event of events) this.emit(event);
    return { deletedIds: ids };
  }
  /** One personal deletion inside the caller's write transaction. Repeating it
   * appends nothing; the shared message and its deliveries are never changed. */
  private async hideMessageInTransaction(userId: string, conversationId: string, messageId: string, tombstone: () => Message): Promise<HubEvent[]> {
    const events: HubEvent[] = [];
    const inserted = await this.db.run("INSERT OR IGNORE INTO message_deletions VALUES(?,?,?)", [userId, messageId, Date.now()]);
    if (inserted.changes) {
      events.push(await this.append(conversationId, "message.deleted", { userId, message: tombstone() }, false));
      for (const delivery of await this.db.all<{ bot_id: string }>("SELECT bot_id FROM deliveries WHERE message_id=? AND status='pending'", [messageId]))
        events.push(await this.queueEventInTransaction(conversationId, delivery.bot_id));
    }
    await this.db.run("UPDATE push_outbox SET status='cancelled' WHERE status='pending' AND device_id IN (SELECT id FROM devices WHERE user_id=?) AND json_extract(payload_json,'$.messageId')=?", [userId, messageId]);
    return events;
  }
  /** Visible messages up to a rowid resolved inside the caller's transaction.
   * Rowids are never persisted as a cutoff: offline VACUUM may renumber them. */
  private async visibleThrough(userId: string, conversationId: string, through: number): Promise<number> {
    return (await this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE conversation_id=? AND rowid<=? AND status!='deleted' AND NOT EXISTS(SELECT 1 FROM message_deletions d WHERE d.message_id=messages.id AND d.user_id=?)", [conversationId, through, userId]))!.count;
  }
  /** Index-only: the newest visible message becomes the fixed cutoff. */
  planClearMessages(userId: string, conversationId: string): Promise<ClearMessagesPlan> {
    return this.db.serial(async () => {
      await this.requireMember(userId, conversationId);
      const last = await this.db.get<{ id: string; rowid: number }>("SELECT id,rowid FROM messages WHERE conversation_id=? AND status!='deleted' AND NOT EXISTS(SELECT 1 FROM message_deletions d WHERE d.message_id=messages.id AND d.user_id=?) ORDER BY rowid DESC LIMIT 1", [conversationId, userId]);
      return last ? { throughId: last.id, count: await this.visibleThrough(userId, conversationId, last.rowid) } : { count: 0 };
    });
  }
  /** One bounded page of personal deletions, oldest first, up to `throughId`.
   * Later messages are never selected; repeating a finished cutoff is a no-op. */
  async clearMessages(userId: string, conversationId: string, input: ClearMessagesInput, validate?: TransactionGuard): Promise<ClearMessagesResult> {
    const { throughId } = clearMessagesInputSchema.parse(input);
    const { result, events } = await this.db.transaction(async () => {
      await validate?.(); await this.requireMember(userId, conversationId);
      const through = await this.db.get<{ rowid: number }>("SELECT rowid FROM messages WHERE id=? AND conversation_id=?", [throughId, conversationId]);
      if (!through) throw new HubError("message_not_found", 404);
      // Tombstone fields and page-local flags only: a page must not decode up
      // to 100 large bodies. `busy` is exact in SQL (running/queued replies,
      // pending inputs, active foreground/background runs and answer
      // follow-ups); `actions` is a superset prefilter for card actions.
      const rows = await this.db.all<Pick<MessageRow, "id" | "author_id" | "author_type" | "version" | "client_msg_id" | "created_at"> & { busy: number; actions: number }>(`SELECT id,author_id,author_type,version,client_msg_id,created_at,
        (status IN ('pending','streaming') OR EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=messages.id AND d.status='pending')
          OR (status='complete' AND author_type='bot' AND (instr(blocks_json,'"nativeRun"')>0 OR instr(blocks_json,'"scopedRun"')>0 OR instr(blocks_json,'"answerFollowup"')>0)
            AND CASE WHEN json_valid(blocks_json) THEN EXISTS(SELECT 1 FROM json_each(blocks_json) b WHERE json_extract(b.value,'$.extra.nativeRun.phase') IN (${activeRunPhaseParams})
              OR json_extract(b.value,'$.extra.scopedRun.phase') IN (${activeRunPhaseParams}) OR json_extract(b.value,'$.extra.answerFollowup.phase') IN ('queued','processing')) ELSE 0 END)) AS busy,
        (author_type='bot' AND status='complete' AND (forwarded_json IS NULL OR forwarded_json='') AND instr(blocks_json,'"actionId"')>0
          AND (instr(blocks_json,'ask_user_question')>0 OR instr(blocks_json,'"approval"')>0 OR instr(blocks_json,'askq_submit')>0)) AS actions
        FROM messages WHERE conversation_id=? AND rowid<=? AND status!='deleted' AND NOT EXISTS(SELECT 1 FROM message_deletions d WHERE d.message_id=messages.id AND d.user_id=?) ORDER BY rowid LIMIT ?`,
        [...activeRunPhases, ...activeRunPhases, conversationId, through.rowid, userId, MAX_CLEAR_MESSAGES]);
      // Refuse the whole page before any write. Earlier committed pages stay;
      // the same cutoff continues after the task, question or approval ends.
      for (const row of rows) {
        if (row.busy) throw new HubError(MESSAGE_CLEAR_ACTIVE, 409);
        if (!row.actions) continue;
        const { blocks_json } = (await this.db.get<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE id=?", [row.id]))!;
        let blocks: unknown; try { blocks = JSON.parse(blocks_json); } catch { continue; }
        if (hasPendingCardAction(blocks)) throw new HubError(MESSAGE_CLEAR_ACTIVE, 409);
      }
      const events: HubEvent[] = [];
      for (const row of rows) events.push(...await this.hideMessageInTransaction(userId, conversationId, row.id, () => deletedMessage({ id: row.id, conversationId, authorId: row.author_id, authorType: row.author_type,
        createdAt: row.created_at, status: "complete", version: row.version, blocks: [], ...(row.client_msg_id ? { clientMsgId: row.client_msg_id } : {}) })));
      const remaining = await this.visibleThrough(userId, conversationId, through.rowid);
      const { seq } = (await this.db.get<{ seq: number }>("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE conversation_id=?", [conversationId]))!;
      return { result: { throughId, clearedIds: rows.map(row => row.id), remaining, seq }, events };
    });
    for (const event of events) this.emit(event);
    return result;
  }
  private async hiddenMessages(userId: string, conversationId: string): Promise<Set<string>> {
    const rows = await this.db.all<{ message_id: string }>("SELECT d.message_id FROM message_deletions d JOIN messages m ON m.id=d.message_id WHERE d.user_id=? AND m.conversation_id=?", [userId, conversationId]);
    return new Set(rows.map(row => row.message_id));
  }
  /** One serialized read per broadcast; the server preserves event order. */
  eventProjections(event: HubEvent, userIds: string[]): Promise<Map<string, HubEvent>> {
    return this.db.serial(async () => {
      const messageId = messageEventId(event);
      const hidden = messageId ? new Set((await this.db.all<{ user_id: string }>("SELECT user_id FROM message_deletions WHERE message_id=?", [messageId])).map(row => row.user_id)) : new Set<string>();
      return new Map(userIds.map(userId => [userId, personalMessageEvent(event, userId, new Set(messageId && hidden.has(userId) ? [messageId] : []))]));
    });
  }
  listMessages(userId: string, conversationId: string, before?: string): Promise<{ messages: Message[]; nextBefore?: string }> {
    return this.db.serial(async () => {
      await this.requireMember(userId, conversationId);
      const cursor = before ? await this.db.get<{ rowid: number }>("SELECT rowid FROM messages WHERE id=? AND conversation_id=?", [before, conversationId]) : undefined;
      if (before && !cursor) throw new HubError("message_cursor_invalid");
      // Select lightweight keys first: a count-only page can otherwise load
      // dozens of logical 32 MiB messages before any byte limit is applied.
      const rows = await this.db.all<{ id: string }>("SELECT id FROM messages WHERE conversation_id=? AND status!='deleted' AND rowid<? AND NOT EXISTS(SELECT 1 FROM message_deletions d WHERE d.message_id=messages.id AND d.user_id=?) ORDER BY rowid DESC LIMIT 51", [conversationId, cursor?.rowid ?? Number.MAX_SAFE_INTEGER, userId]);
      const messages: Message[] = []; let bytes = 1024;
      for (const { id } of rows.slice(0, 50)) {
        const message = this.decodeMessage((await this.db.get<MessageRow>("SELECT * FROM messages WHERE id=?", [id]))!);
        const size = Buffer.byteLength(JSON.stringify(message)) + 1;
        if (messages.length && bytes + size > 6 * 1024 * 1024) break;
        messages.push(message); bytes += size;
      }
      return { messages, ...(rows.length > messages.length ? { nextBefore: messages.at(-1)!.id } : {}) };
    });
  }
  sync(userId: string, conversationId: string, after: number, limit = 1000): Promise<{ events: HubEvent[]; more: boolean }> {
    return this.db.serial(async () => {
      await this.requireMember(userId, conversationId);
      const boundary = (await this.db.get<{ firstSeq: number }>(replayHeadSql, [conversationId]))!;
      if (after + 1 < boundary.firstSeq) throw new HubError("sync_snapshot_required", 409);
      const count = Math.max(1, Math.min(1000, Math.floor(limit)));
      const rows = await this.db.all<{ seq: number }>("SELECT seq FROM events WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?", [conversationId, after, count + 1]);
      // Only inspect IDs encountered in this byte-bounded replay. Repeated
      // versions share one lookup; old hidden history is never scanned.
      const checked = new Set<string>(), hidden = new Set<string>();
      const events: HubEvent[] = []; let bytes = 1024;
      for (const { seq } of rows.slice(0, count)) {
        const r = (await this.db.get<StoredEvent>("SELECT * FROM events WHERE conversation_id=? AND seq=?", [conversationId, seq]))!;
        const original = eventSchema.parse({ v: 1, type: "event", conversationId: r.conversation_id, seq: r.seq, kind: r.kind, payload: JSON.parse(r.payload_json), at: r.at });
        const messageId = messageEventId(original);
        if (messageId && !checked.has(messageId)) {
          checked.add(messageId);
          if (await this.db.get("SELECT 1 FROM message_deletions WHERE user_id=? AND message_id=?", [userId, messageId])) hidden.add(messageId);
        }
        const event = personalMessageEvent(original, userId, hidden);
        const size = Buffer.byteLength(JSON.stringify(event)) + 1;
        if (events.length && bytes + size > 4 * 1024 * 1024) break;
        events.push(event); bytes += size;
      }
      return { events, more: rows.length > events.length };
    });
  }
  snapshot(userId: string, conversationId: string): Promise<{ conversation: Conversation; messages: Message[]; seq: number }> {
    return this.db.serial(async () => {
      await this.requireMember(userId, conversationId);
      const messages = (await this.db.all<MessageRow>("SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at,rowid", [conversationId])).map((r) => this.decodeMessage(r));
      const seq = (await this.db.get<{ seq: number }>("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE conversation_id=?", [conversationId]))!.seq;
      const hidden = await this.hiddenMessages(userId, conversationId);
      return { conversation: await this.conversationRow(conversationId), messages: messages.map(message => hidden.has(message.id) ? deletedMessage(message) : message), seq };
    });
  }
  syncHead(userId: string, conversationId: string): Promise<{ seq: number; firstSeq: number }> {
    return this.db.serial(async () => {
      await this.requireMember(userId, conversationId);
      return (await this.db.get<{ seq: number; firstSeq: number }>(replayHeadSql, [conversationId]))!;
    });
  }
  private messageActivity?: MessageActivityIndex;
  /** Derived per-message activity coverage for this store's own connection. */
  get activityIndex(): MessageActivityIndex { return this.messageActivity ??= new MessageActivityIndex(this.db); }
  /** Authorize first: a public read must not start derived writes for a
   * conversation the caller cannot read (the read transaction rechecks). Then
   * bring durable coverage forward. Exactness never depends on that succeeding:
   * readers fold any uncovered tail, which after a failure may be the whole
   * journal (slow, counted in activityIndex.stats). */
  private async prepareActivity(userId: string, conversationId: string): Promise<void> {
    await this.db.serial(() => this.requireMember(userId, conversationId));
    this.activityIndex.start();
    await this.activityIndex.ensure(conversationId).catch((error: unknown) => this.activityIndex.failed(error));
  }
  private async canMergeSnapshot(db: HubDatabase, conversationId: string, after: number, seq: number, firstSeq: number): Promise<boolean> {
    if (after <= 0 || after > seq) return false;
    if (after + 1 >= firstSeq) return true;
    // A retired replay body is not needed to compute an exact snapshot delta:
    // retained per-message lastSeq and personal hide records cover every change.
    // Only our recorded reclamation floor and complete coverage authorize this;
    // unknown journal gaps still require replacement.
    const floor=(await db.get<{seq:number}>("SELECT seq FROM event_history_floor WHERE conversation_id=?",[conversationId]))?.seq ?? 0;
    const coverage=(await db.get<{through_seq:number}>("SELECT through_seq FROM conversation_activity WHERE conversation_id=?",[conversationId]))?.through_seq;
    return floor>0 && firstSeq===floor+1 && coverage===seq;
  }
  /**
   * Snapshot frames for one conversation. Full snapshots keep their existing
   * shape. With `incremental` and a provably covered cursor, `snapshot.begin`
   * carries `mode: "merge"` and only messages changed after `after` (including
   * messages this user hid after it) are sent. Activity metadata comes from
   * compact coverage; with current coverage no historical event body is parsed.
   */
  async *snapshotFrames(userId: string, conversationId: string, after: number, options: { incremental?: boolean } = {}): AsyncGenerator<SnapshotFrame> {
    await this.prepareActivity(userId, conversationId);
    // A separate WAL read transaction freezes one authoritative revision while
    // live writes continue. Message bodies are read in pages, never all at once.
    const db = await HubDatabase.snapshot(this.db.file), view = new HubStore(db), id = newId("snapshot");
    try {
      await db.exec("BEGIN"); await view.requireMember(userId, conversationId);
      const conversation = await view.conversationRow(conversationId);
      const { seq, firstSeq } = (await db.get<{ seq: number; firstSeq: number }>(replayHeadSql, [conversationId]))!;
      const readSeq = (await db.get<{ seq: number }>("SELECT seq FROM reads WHERE user_id=? AND conversation_id=?", [userId, conversationId]))?.seq ?? 0;
      // Completion transitions match ClientCache.apply; editing an already-complete
      // reply is not unread; user blocks are immutable (see message-activity.ts).
      let activity: Map<string, MessageActivity> | undefined, rowids: number[] = [];
      // Merge inside the journal or across a floor with complete compact coverage.
      let merge = options.incremental === true && await this.canMergeSnapshot(db, conversationId, after, seq, firstSeq);
      if (merge) {
        // Changes come from lastSeq (including user enrichments that keep their
        // contentSeq) and this user's tombstones. Changed IDs first, bodies later.
        const change = this.activityIndex.observe(await readConversationActivity(db, conversationId, seq, { after, userId }));
        rowids = (await db.all<{ rowid: number }>("SELECT rowid FROM messages WHERE conversation_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY rowid", [conversationId, JSON.stringify([...change.changed!])])).map(row => row.rowid);
        // A change without a canonical row (unknown/physical removal) cannot be
        // expressed as a merge; replace the whole conversation instead.
        if (rowids.length === change.changed!.size) activity = change.activity; else merge = false;
      }
      activity ??= this.activityIndex.observe(await readConversationActivity(db, conversationId, seq)).activity;
      yield { v: 1, type: "snapshot.begin", id, conversation, seq, after, readSeq, ...(merge ? { mode: "merge" as const } : {}) };
      let count = 0;
      const frame = (row: MessageHeader, message: Message): SnapshotFrame => {
        const meta = activity!.get(row.id);
        return { v: 1, type: "snapshot.message", id, index: count++, message, contentSeq: meta?.contentSeq ?? 0, contentAt: meta?.contentAt ?? row.created_at, unreadSeq: meta?.unreadSeq ?? 0 };
      };
      // A personal tombstone only needs metadata. Reading the full body before
      // hiding it makes reconnect cost grow with history the user has cleared.
      const page = async (where: string, params: SqlValue[]) => {
        const rows = await db.all<MessageHeader & { rowid: number; hidden: number }>(`SELECT m.rowid,m.id,m.conversation_id,m.author_id,m.author_type,m.created_at,m.version,m.client_msg_id,
          EXISTS(SELECT 1 FROM message_deletions d WHERE d.user_id=? AND d.message_id=m.id) AS hidden FROM messages m ${where}`, [userId, ...params]);
        const visibleIds = rows.filter(row => !row.hidden).map(row => row.id);
        const visible = new Map((visibleIds.length ? await db.all<MessageRow>("SELECT * FROM messages WHERE id IN (SELECT value FROM json_each(?))", [JSON.stringify(visibleIds)]) : []).map(row => [row.id, view.decodeMessage(row)]));
        return rows.map(row => ({ rowid: row.rowid, frame: frame(row, row.hidden ? deletedMessageRow(row) : visible.get(row.id)!) }));
      };
      if (merge) {
        for (let index = 0; index < rowids.length; index += 16) {
          const rows = await page("WHERE m.rowid IN (SELECT value FROM json_each(?)) ORDER BY m.rowid", [JSON.stringify(rowids.slice(index, index + 16))]);
          for (const row of rows) yield row.frame;
        }
      } else {
        let rowid = 0;
        for (;;) {
          const rows = await page("WHERE m.conversation_id=? AND m.rowid>? ORDER BY m.rowid LIMIT 16", [conversationId, rowid]);
          if (!rows.length) break;
          for (const row of rows) { yield row.frame; rowid = row.rowid; }
        }
      }
      yield { v: 1, type: "snapshot.end", id, count };
    } finally { await db.close(); }
  }
  /** Index-only catch-up sizing: how many messages a merge snapshot after
   * `after` would send. `indexed` is false while durable coverage lags;
   * `mergeable` is false when snapshotFrames would fall back to a full one. */
  async catchupPlan(userId: string, conversationId: string, after: number): Promise<{ head: number; firstSeq: number; changedMessages: number; indexed: boolean; mergeable: boolean }> {
    await this.prepareActivity(userId, conversationId);
    const db = await HubDatabase.snapshot(this.db.file), view = new HubStore(db);
    try {
      await db.exec("BEGIN"); await view.requireMember(userId, conversationId);
      const { seq, firstSeq } = (await db.get<{ seq: number; firstSeq: number }>(replayHeadSql, [conversationId]))!;
      if (after >= seq) return { head: seq, firstSeq, changedMessages: 0, indexed: true, mergeable: after === seq && after > 0 };
      const { changed, indexed } = this.activityIndex.observe(await readConversationActivity(db, conversationId, seq, { after: Math.max(0, after), userId }));
      // Same rule as snapshotFrames: every changed ID needs a canonical row.
      const rows = (await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND id IN (SELECT value FROM json_each(?))", [conversationId, JSON.stringify([...changed!])]))!.n;
      return { head: seq, firstSeq, changedMessages: changed!.size, indexed, mergeable: rows === changed!.size && await this.canMergeSnapshot(db, conversationId, after, seq, firstSeq) };
    } finally { await db.close(); }
  }
  private readSearch<T>(read: (db: HubDatabase) => Promise<T>): Promise<T> {
    // Searches use independent WAL readers and never hold the writer/auth queue.
    const task = this.searchTail.then(async () => {
      const db = await HubDatabase.snapshot(this.db.file);
      try { return await read(db); } finally { await db.close(); }
    });
    this.searchTail = task.catch(() => undefined); return task;
  }
  search(userId: string, query: string, filters: SearchFilters = {}): Promise<Message[]> {
    return this.readSearch(async (db) => {
      const { conditions, params } = historySearchWhere(userId, query, filters);
      return (await db.all<MessageRow>(`SELECT m.* FROM messages m WHERE ${conditions.join(" AND ")} ORDER BY m.created_at DESC,m.id DESC LIMIT 100`, params)).map((r) => this.decodeMessage(r));
    });
  }
  searchPage(userId: string, query: string, filters: SearchFilters = {}, cursor?: string): Promise<SearchPage> {
    return this.readSearch(async (db) => {
      // A cursor is a position, never an access grant. Every page runs the same
      // current membership and filter checks; another search cannot reuse it.
      // Preserve existing host-wide cursors while binding scoped pages to one chat.
      const scope = createHash("sha256").update(JSON.stringify([userId, query, filters.botId ?? null, filters.from ?? null, filters.to ?? null, !!filters.hasFile, ...(filters.conversationId ? [filters.conversationId] : [])])).digest("hex");
      let before: { at: number; id: string } | undefined;
      if (cursor !== undefined) {
        const raw = searchCursorSchema.safeParse(cursor);
        let decoded: unknown;
        try { if (raw.success) decoded = JSON.parse(Buffer.from(raw.data, "base64url").toString("utf8")); } catch { /* Invalid cursor below. */ }
        const parsed = historyCursorSchema.safeParse(decoded);
        if (!parsed.success) throw new HubError("search_cursor_invalid");
        if (parsed.data.scope !== scope) throw new HubError("search_cursor_mismatch");
        before = parsed.data;
      }
      const { conditions, params } = historySearchWhere(userId, query, filters, true);
      if (before) { conditions.push("(m.created_at<? OR (m.created_at=? AND m.id<?))"); params.push(before.at, before.at, before.id); }
      // Slice in SQLite before crossing into Node. Returning full message blocks
      // would make even a small page enormous for long answers and tool output.
      const rows = await db.all<{ id: string; conversationId: string; createdAt: number; excerpt: string }>(`
        SELECT id,conversationId,createdAt,
          CASE WHEN start>1 THEN '…' ELSE '' END || substr(body,start,?) || CASE WHEN length(body)>=start+? THEN '…' ELSE '' END AS excerpt
        FROM (
          SELECT m.id,m.conversation_id AS conversationId,m.created_at AS createdAt,f.body,
            max(1,instr(lower(f.body),lower(?))-80) AS start
          FROM messages_fts f JOIN messages m ON m.id=f.message_id
          WHERE ${conditions.join(" AND ")}
          ORDER BY m.created_at DESC,m.id DESC LIMIT ?
        ) ORDER BY createdAt DESC,id DESC`, [SEARCH_EXCERPT_CHARS, SEARCH_EXCERPT_CHARS, query, ...params, SEARCH_PAGE_SIZE + 1]);
      const items = rows.slice(0, SEARCH_PAGE_SIZE), last = items.at(-1);
      const nextCursor = rows.length > SEARCH_PAGE_SIZE && last
        ? Buffer.from(JSON.stringify({ v: 1, scope, at: last.createdAt, id: last.id })).toString("base64url") : null;
      return searchPageSchema.parse({ items, nextCursor });
    });
  }
  async actionExists(userId: string, clientActionId: string, payload: unknown): Promise<boolean> {
    return this.db.serial(async () => {
      const old = await this.db.get<{ payload_json: string }>("SELECT payload_json FROM actions WHERE user_id=? AND client_action_id=?", [userId, clientActionId]);
      if (!old) return false;
      if (old.payload_json !== JSON.stringify(z.json().parse(payload))) throw new HubError("idempotency_conflict", 409);
      return true;
    });
  }
  async enqueueAction(userId: string, clientActionId: string, payload: unknown, botId: string, conversationId: string, params: unknown, validate?: TransactionGuard): Promise<void> {
    const value = JSON.stringify(z.json().parse(payload));
    await this.db.transaction(async () => {
      await validate?.();
      await this.requireMember(userId, conversationId);
      await this.requireBot(botId, conversationId);
      const old = await this.db.get<{ payload_json: string }>("SELECT payload_json FROM actions WHERE user_id=? AND client_action_id=?", [userId, clientActionId]);
      if (old) { if (old.payload_json !== value) throw new HubError("idempotency_conflict", 409); return; }
      await this.db.run("INSERT INTO actions VALUES(?,?,?)", [userId, clientActionId, value]);
      await this.db.run("INSERT INTO action_deliveries(id,user_id,client_action_id,bot_id,conversation_id,params_json,created_at) VALUES(?,?,?,?,?,?,?)", [newId("action"), userId, clientActionId, botId, conversationId, JSON.stringify(z.json().parse(params)), Date.now()]);
    });
  }
  pendingActions(botId: string): Promise<{ id: string; conversation_id: string; params_json: string }[]> {
    return this.db.serial(() => this.db.all("SELECT id,conversation_id,params_json FROM action_deliveries WHERE bot_id=? AND status='pending' ORDER BY created_at,rowid", [botId]));
  }
  async finishAction(id: string, result: Json): Promise<void> {
    await this.db.serial(() => this.db.run("UPDATE action_deliveries SET status='complete',result_json=? WHERE id=? AND status='pending'", [JSON.stringify(result), id]));
  }
}
