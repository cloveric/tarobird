import { createHash } from "node:crypto";
import { blocksText, type Block, type HubEvent, type Message } from "../client-protocol/index.js";
import { PROMPT_QUEUE_ENGINES, promptQueueMutationSchema, type PromptQueueMutation, type PromptQueueSnapshot } from "../client-protocol/prompt-queue.js";
import { deletedMessage } from "../client-protocol/message-deletion.js";
import { HubError, type HubStore, type TransactionGuard } from "./store.js";

type Delivery = { message_id: string; bot_id: string; conversation_id: string; queue_position: number; dispatched: number; queue_paused: number; targets: number };
// Match the worker's slash-token grammar, not Unix paths such as /tmp/log.
// Unknown slash tokens stay barriers too: an engine may add its own commands.
const commandText = (text: string) => /^\/[a-z][\w.-]*(?:@[a-z0-9_][\w.-]*)?(?=\s|$)/i.test(text.trim());
const command = (message: Message) => !message.botSource && !message.forwardedFrom && commandText(blocksText(message.blocks));
export const supportsPromptQueueEngine = (engine: string): boolean => (PROMPT_QUEUE_ENGINES as readonly string[]).includes(engine);

/** Owns only inputs not yet handed to a Gateway. Claim and edits share the same
 * write transaction, so a started/uncertain delivery can never become editable. */
export class HubPromptQueue {
  constructor(private readonly store: HubStore) {}
  async registerWorker(botId: string, supported: boolean, active: () => boolean = () => true, status?: { engine: string; model: string; effort: string }): Promise<boolean> {
    return this.store.db.transaction(async () => {
      if (!active()) return false;
      if (status) {
        const update = await this.store.db.run("UPDATE bots SET engine=?,model=?,effort=?,online=1 WHERE id=? AND deleted_at IS NULL", [status.engine, status.model, status.effort, botId]);
        if (!update.changes) throw new HubError("bot_deleted", 410);
      }
      await this.store.db.run("INSERT INTO prompt_queue_workers VALUES(?,?) ON CONFLICT(bot_id) DO UPDATE SET supported=excluded.supported", [botId, Number(supported)]);
      return true;
    });
  }
  private rows(botId: string, conversationId?: string): Promise<Delivery[]> {
    return this.store.db.all<Delivery>(`SELECT d.*,m.conversation_id,(SELECT COUNT(*) FROM deliveries x WHERE x.message_id=d.message_id) AS targets
      FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.bot_id=? AND d.status='pending' AND m.status!='deleted'
      ${conversationId ? "AND m.conversation_id=?" : ""} ORDER BY d.queue_position,m.created_at,m.rowid`, conversationId ? [botId, conversationId] : [botId]);
  }
  private async scope(userId: string, botId: string, conversationId: string): Promise<string | undefined> {
    await this.store.requireMember(userId, conversationId); await this.store.requireBot(botId, conversationId);
    const conversation = await this.store.db.get<{ type: string; archived: number; parent_id: string | null }>("SELECT type,archived,parent_id FROM conversations WHERE id=?", [conversationId]);
    const members = await this.store.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM conversation_members WHERE conversation_id=? AND member_type='bot'", [conversationId]);
    if (conversation?.type !== "direct" || members?.count !== 1 || conversation.parent_id) return "group_unsupported";
    if (conversation.archived) return "conversation_archived";
    const bot = await this.store.db.get<{ engine: string }>("SELECT engine FROM bots WHERE id=?", [botId]);
    if (!bot || !supportsPromptQueueEngine(bot.engine)) return "unsupported_engine";
    const worker = await this.store.db.get<{ supported: number }>("SELECT supported FROM prompt_queue_workers WHERE bot_id=?", [botId]);
    if (!worker?.supported) return "worker_update_required";
  }
  private async snapshotInTransaction(userId: string, botId: string, conversationId: string): Promise<PromptQueueSnapshot> {
    const reason = await this.scope(userId, botId, conversationId), supported = !reason;
    const rows = await this.rows(botId, conversationId);
    const items: PromptQueueSnapshot["items"] = [];
    for (const row of rows) {
      const message = await this.store.queuedMessageInTransaction(row.message_id);
      const hidden = !!await this.store.db.get("SELECT 1 FROM message_deletions WHERE user_id=? AND message_id=?", [userId, message.id]);
      // An Agent Bus input is stopped through its run, which owns its status.
      const control = command(message);
      const candidate = supported && !row.dispatched && row.targets === 1 && message.authorType === "user" && message.authorId === userId;
      const bus = (control || candidate) && await this.agentBusInput(message.id);
      const editable = candidate && !control && !bus;
      // Bot-origin inputs have an owning ticket/task lifecycle. Holding only
      // its delivery leaves that owner working forever. Keep recovery controls
      // for inputs an older Host already paused, but never create a new hold.
      items.push({ message: hidden ? deletedMessage(message) : message, state: row.dispatched ? "dispatched" : "queued", paused: !!row.queue_paused, canPause: editable && !message.botSource && !row.queue_paused, canResume: editable && !!row.queue_paused, canCancel: editable, canMove: editable, reorderBarrier: control && !bus,
        canEdit: !hidden && editable && !message.botSource && !message.forwardedFrom && message.blocks.every(block => ["text", "file", "image", "audio"].includes(block.type)) });
    }
    const revision = createHash("sha256").update(JSON.stringify({ reason, items: items.map(item => [item.message.id, item.message.version, item.message.status, item.state, item.paused]), positions: rows.map(row => row.queue_position) })).digest("hex");
    return { supported, ...(reason ? { reason } : {}), revision, botId, conversationId, items, capabilities: { reorder: supported, edit: supported, cancel: supported, pause: supported } };
  }
  read(userId: string, botId: string, conversationId: string, validate?: TransactionGuard): Promise<PromptQueueSnapshot> {
    return this.store.db.serial(async () => { await validate?.(); return this.snapshotInTransaction(userId, botId, conversationId); });
  }
  async mutate(userId: string, conversationId: string, raw: PromptQueueMutation, validate?: TransactionGuard): Promise<PromptQueueSnapshot> {
    const input = promptQueueMutationSchema.parse(raw), { botId, action } = input;
    const payload = createHash("sha256").update(JSON.stringify({ conversationId, ...input })).digest("hex");
    const result = await this.store.db.transaction(async () => {
      await validate?.();
      const snapshot = await this.snapshotInTransaction(userId, botId, conversationId);
      const prior = await this.store.db.get<{ payload_hash: string }>("SELECT payload_hash FROM prompt_queue_mutations WHERE user_id=? AND request_id=?", [userId, input.requestId]);
      if (prior) {
        const rejected = /^rejected:([a-f0-9]{64}):(4\d\d):([a-z0-9_]+)$/.exec(prior.payload_hash);
        if (rejected?.[1] === payload) throw new HubError(rejected[3]!, Number(rejected[2]));
        if (prior.payload_hash !== payload) throw new HubError("idempotency_conflict", 409);
        return { snapshot, events: [] };
      }
      // A definitive refusal must also fence a delayed copy of this request.
      // Otherwise restoring the old order restores its content-hash revision,
      // allowing an operation already reported as rejected to execute later.
      // Keep the existing receipt table; old hosts reject this tagged value as
      // an idempotency conflict instead of accidentally applying the request.
      const reject = async (code: string, status = 409) => {
        await this.store.db.run("INSERT INTO prompt_queue_mutations VALUES(?,?,?)", [userId, input.requestId, `rejected:${payload}:${status}:${code}`]);
        return { snapshot, events: [] as HubEvent[], error: new HubError(code, status) };
      };
      if (!snapshot.supported) return reject(snapshot.reason ?? "queue_unsupported");
      const item = snapshot.items.find(item => item.message.id === action.messageId);
      if (!item) return reject("queue_changed");
      if (item.message.authorId !== userId) return reject("message_forbidden", 403);
      if (item.state === "dispatched") return reject("queue_already_dispatched");
      if (input.revision !== snapshot.revision) return reject("queue_changed");
      const allowed = action.type === "move" ? item.canMove : action.type === "edit" ? item.canEdit : action.type === "pause" ? item.canPause : action.type === "resume" ? item.canResume : item.canCancel;
      if (!allowed) return reject("queue_item_unsupported");
      const events: HubEvent[] = [];
      if (action.type === "move") {
        const queued = snapshot.items.filter(item => item.state === "queued");
        const currentIndex = queued.findIndex(item => item.message.id === action.messageId);
        const beforeIndex = action.beforeId === null ? queued.length : queued.findIndex(item => item.message.id === action.beforeId);
        if (beforeIndex < 0) return reject("queue_changed");
        // A /stop, /new or engine command keeps its exact ordering barrier.
        for (const entry of queued.slice(Math.min(currentIndex, beforeIndex), Math.max(currentIndex, beforeIndex))) {
          if (command(entry.message) && !await this.agentBusInput(entry.message.id)) return reject("queue_control_barrier");
        }
        if (action.beforeId !== action.messageId) {
          const ordered = queued.filter(item => item.message.id !== action.messageId);
          ordered.splice(action.beforeId === null ? ordered.length : ordered.findIndex(item => item.message.id === action.beforeId), 0, item);
          const positions = (await this.rows(botId, conversationId)).filter(row => !row.dispatched).map(row => row.queue_position).sort((a, b) => a - b);
          for (let i = 0; i < ordered.length; i++) await this.store.db.run("UPDATE deliveries SET queue_position=? WHERE message_id=? AND bot_id=? AND dispatched=0 AND status='pending'", [positions[i]!, ordered[i]!.message.id, botId]);
        }
      } else if (action.type === "edit") {
        if (commandText(action.text)) return reject("queue_command_edit_forbidden");
        const blocks: Block[] = item.message.blocks.filter(block => block.type !== "text");
        if (!action.text.trim() && !blocks.length) return reject("empty_message", 400);
        if (action.text.trim()) blocks.unshift({ type: "text", text: action.text });
        const { linkPreview: _preview, previewUrl: _url, previewStyle: _style, ...old } = item.message;
        const message: Message = { ...old, blocks, version: old.version + 1 };
        events.push(await this.store.updateQueuedMessageInTransaction(message));
        await this.store.db.run("UPDATE messages SET preview_url=NULL,link_preview_json=NULL,preview_style=NULL WHERE id=?", [message.id]);
      } else if (action.type === "pause" || action.type === "resume") {
        // Shares the claim transaction: a prompt already handed to a worker
        // cannot be paused, and resume never moves it or interrupts a run.
        await this.store.db.run("UPDATE deliveries SET queue_paused=? WHERE message_id=? AND bot_id=? AND dispatched=0 AND status='pending'", [Number(action.type === "pause"), item.message.id, botId]);
      } else {
        await this.store.db.run("UPDATE deliveries SET status='cancelled' WHERE message_id=? AND bot_id=? AND dispatched=0 AND status='pending'", [item.message.id, botId]);
        // A personal projection is never a replacement for shared history.
        const message = await this.store.queuedMessageInTransaction(item.message.id);
        events.push(await this.store.updateQueuedMessageInTransaction({ ...message, version: message.version + 1, blocks: [...message.blocks,
          { type: "card", elements: [{ type: "markdown", text: "已取消排队，未发送给 Bot。" }], extra: { promptQueue: { state: "cancelled", botId } } }] }));
      }
      await this.store.db.run("INSERT INTO prompt_queue_mutations VALUES(?,?,?)", [userId, input.requestId, payload]);
      await this.store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), userId, "prompt_queue.changed", JSON.stringify({ botId, conversationId, messageId: action.messageId, action: action.type })]);
      events.push(await this.store.queueEventInTransaction(conversationId, botId));
      return { snapshot: await this.snapshotInTransaction(userId, botId, conversationId), events };
    });
    if ("error" in result) throw result.error;
    this.store.emitQueueEvents(result.events); return result.snapshot;
  }
  private async settleInaccessibleInTransaction(botId: string, messageId?: string): Promise<number> {
    // Normal membership changes reject busy Bots. Defensive cleanup also handles
    // old/imported inconsistent state without asking a removed Bot to authorize
    // its own failure receipt, which would itself fail requireBot().
    const result = await this.store.db.run(`UPDATE deliveries SET status=CASE WHEN dispatched=1 THEN 'failed' ELSE 'cancelled' END
      WHERE bot_id=? AND status='pending' ${messageId ? "AND message_id=?" : ""}
      AND NOT EXISTS(SELECT 1 FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id
        AND cm.member_type='bot' AND cm.member_id=deliveries.bot_id
        JOIN bots b ON b.id=cm.member_id AND b.deleted_at IS NULL WHERE m.id=deliveries.message_id)`, messageId ? [botId, messageId] : [botId]);
    if (result.changes) await this.store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), "hub", "prompt_queue.membership_unavailable", JSON.stringify({ botId, count: result.changes })]);
    return result.changes;
  }
  /** A member can disappear after claim only through deletion or inconsistent
   * external state. Skip such an input, without disconnecting unrelated chats. */
  settleInaccessible(botId: string, messageId: string): Promise<boolean> {
    return this.store.db.transaction(async () => {
      await this.settleInaccessibleInTransaction(botId, messageId);
      return !await this.store.db.get("SELECT 1 FROM deliveries WHERE bot_id=? AND message_id=? AND status='pending'", [botId, messageId]);
    });
  }
  /** Called from the Hub's serialized dispatch loop. On reconnect only, replay
   * fenced inputs to GatewayReceipts; never revert them to the waiting state. */
  private async agentBusInput(messageId: string): Promise<boolean> {
    return !!await this.store.db.get("SELECT 1 FROM agent_bus_runs WHERE message_id=?", [messageId]);
  }
  /** `agentBus` is true for a worker that executes run inputs. Otherwise the
   * caller's function settles those inputs in this transaction; without one
   * they are only withheld. Either way they are never dispatched as chat. */
  async claim(botId: string, queueCapable: boolean, replay: boolean, active: () => boolean = () => true, botMessages = true, agentBus: boolean | ((messageIds: string[]) => Promise<HubEvent[]>) = true,
    groupDiscussion: boolean | ((messageIds: string[]) => Promise<HubEvent[]>) = true, pull?: { ready: Set<string> }): Promise<Message[]> {
    const result = await this.store.db.transaction(async () => {
      if (!active()) return { messages: [], events: [] };
      await this.settleInaccessibleInTransaction(botId);
      const busEvents: HubEvent[] = [];
      const busInputs = agentBus === true ? new Set<string>() : new Set((await this.store.db.all<{ message_id: string }>(`SELECT d.message_id FROM deliveries d
        JOIN agent_bus_runs r ON r.message_id=d.message_id AND r.coordinator_id=d.bot_id WHERE d.bot_id=? AND d.status='pending'`, [botId])).map(row => row.message_id));
      if (busInputs.size && typeof agentBus === "function") busEvents.push(...await agentBus([...busInputs]));
      // A worker without the discussion capability would answer a bare turn
      // input as chat. Such inputs are settled by the caller, never dispatched.
      if (groupDiscussion !== true) {
        const discussionInputs = (await this.store.db.all<{ message_id: string }>(`SELECT d.message_id FROM deliveries d
          JOIN group_discussion_turns t ON t.input_message_id=d.message_id AND t.bot_id=d.bot_id WHERE d.bot_id=? AND d.status='pending'`, [botId])).map(row => row.message_id);
        if (discussionInputs.length && typeof groupDiscussion === "function") busEvents.push(...await groupDiscussion(discussionInputs));
        for (const id of discussionInputs) busInputs.add(id);
      }
      // A paused discussion holds its next speaker's input until resume; the
      // decision shares this claim transaction with the pause itself.
      for (const { message_id } of await this.store.db.all<{ message_id: string }>(`SELECT d.message_id FROM deliveries d
        JOIN group_discussion_turns t ON t.input_message_id=d.message_id AND t.bot_id=d.bot_id JOIN group_discussions r ON r.id=t.discussion_id
        WHERE d.bot_id=? AND d.status='pending' AND d.dispatched=0 AND r.status IN ('pausing','paused')`, [botId])) busInputs.add(message_id);
      // Tombstones from a previous writer must never become new engine input.
      // Probe each pending delivery by message PK: materializing all historical
      // tombstones here holds the shared database queue on every dispatch.
      await this.store.db.run("UPDATE deliveries SET status='cancelled' WHERE bot_id=? AND status='pending' AND dispatched=0 AND EXISTS(SELECT 1 FROM messages m WHERE m.id=deliveries.message_id AND m.status='deleted')", [botId]);
      const rows = await this.rows(botId), byConversation = new Map<string, Delivery[]>();
      for (const row of rows) {
        // Hold before decoding/command flushing, including legacy workers.
        // Already dispatched deliveries retain their recovery semantics.
        if (row.queue_paused && !row.dispatched) continue;
        // A reconnect must not replay a ticket the owner already stopped.
        // Resolve the one ticket through this conversation's indexed ID; never
        // scan all ticket history on the shared dispatch queue.
        const stoppedTicket = replay && row.dispatched && await this.store.db.get(`SELECT 1 FROM conversations c JOIN dispatch_tickets t ON t.id=json_extract(c.ticket_json,'$.id')
          WHERE c.id=? AND json_extract(t.attempts_json,'$[#-1].inputMessageId')=? AND json_extract(t.attempts_json,'$[#-1].botId')=?
          AND json_extract(t.attempts_json,'$[#-1].stopRequested') IN ('pause','cancel')`, [row.conversation_id, row.message_id, botId]);
        if (stoppedTicket) {
          // Withhold replay, but do not manufacture a terminal receipt: the
          // same process may merely have reconnected while its old turn lives.
          // The exact-input stop retries until execution evidence settles it.
          continue;
        }
        const message = !botMessages ? await this.store.queuedMessageInTransaction(row.message_id) : undefined;
        if (message?.botSource) {
          await this.store.db.run("UPDATE deliveries SET status='failed' WHERE message_id=? AND bot_id=? AND status='pending'", [row.message_id, botId]);
          busEvents.push(await this.store.updateQueuedMessageInTransaction({ ...message, version: message.version + 1, blocks: [...message.blocks,
            { type: "card", elements: [{ type: "markdown", text: "目标 Bot 的运行环境尚不支持 Bot 间消息，此消息未作为普通输入派发。请更新目标 Bot 后再发送。" }], extra: { botMessageError: "bot_message_worker_update_required" } }] }));
          busEvents.push(await this.store.queueEventInTransaction(row.conversation_id, botId));
          await this.store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), botId, "bot-message.worker-unsupported", JSON.stringify({ messageId: message.id, conversationId: row.conversation_id, dispatched: !!row.dispatched })]);
          continue;
        }
        const entries = byConversation.get(row.conversation_id) ?? []; entries.push(row); byConversation.set(row.conversation_id, entries);
      }
      const messages: Message[] = [], events: HubEvent[] = busEvents;
      for (const [conversationId, all] of byConversation) {
        const entries = all.filter(row => !busInputs.has(row.message_id));
        if (!entries.length) continue;
        const conversation = await this.store.db.get<{ type: string; parent_id: string | null }>("SELECT type,parent_id FROM conversations WHERE id=?", [conversationId]);
        const members = await this.store.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM conversation_members WHERE conversation_id=? AND member_type='bot'", [conversationId]);
        const managed = queueCapable && conversation?.type === "direct" && !conversation.parent_id && members?.count === 1 && entries.every(row => row.targets === 1);
        const pending: { row: Delivery; message: Message }[] = [];
        for (const row of entries) pending.push({ row, message: await this.store.queuedMessageInTransaction(row.message_id) });
        const queued = pending.filter(entry => !entry.row.dispatched);
        const pullHere = pull && (!queued[0] || !await this.agentBusInput(queued[0].message.id));
        // Bus goals never execute as slash commands. Only slash-shaped
        // candidates need an indexed run lookup; normal prompts stay unchanged.
        let lastCommand = -1; for (let i = 0; i < queued.length; i++) if (command(queued[i]!.message) && !await this.agentBusInput(queued[i]!.message.id)) lastCommand = i;
        const claimed = !managed ? queued : lastCommand >= 0 ? queued.slice(0, lastCommand + 1) : pending.some(entry => entry.row.dispatched) ? [] : pullHere ? [] : queued.slice(0, 1);
        if (managed && pull && pullHere && lastCommand < 0 && queued.length && !pending.some(entry => entry.row.dispatched)) pull.ready.add(conversationId);
        if (replay) messages.push(...pending.filter(entry => entry.row.dispatched).map(entry => entry.message));
        for (const entry of claimed) {
          await this.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id=? AND status='pending' AND dispatched=0", [entry.row.message_id, botId]);
          messages.push(entry.message);
        }
        if (managed && claimed.length) events.push(await this.store.queueEventInTransaction(conversationId, botId));
      }
      return { messages, events };
    });
    this.store.emitQueueEvents(result.events); return result.messages;
  }
  /** Called only from a live worker holding the shared conversation execution
   * slot. Choosing the head and fencing it share the edit/reorder transaction.
   * A lost response stays fenced and is recovered by ordinary delivery replay. */
  async take(botId: string, conversationId: string, active: () => boolean, botMessages = true): Promise<Message | undefined> {
    const result = await this.store.db.transaction(async () => {
      if (!active()) return;
      await this.store.requireBot(botId, conversationId);
      const conversation = await this.store.db.get<{ type: string; parent_id: string | null }>("SELECT type,parent_id FROM conversations WHERE id=?", [conversationId]);
      const members = await this.store.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM conversation_members WHERE conversation_id=? AND member_type='bot'", [conversationId]);
      if (conversation?.type !== "direct" || conversation.parent_id || members?.count !== 1) return;
      const rows = await this.rows(botId, conversationId);
      if (rows.some(row => row.dispatched || row.targets !== 1)) return;
      const row = rows.find(row => !row.queue_paused); if (!row) return;
      const message = await this.store.queuedMessageInTransaction(row.message_id);
      // Controls and Bus inputs keep their existing dedicated dispatch path.
      if (command(message) || message.botSource && !botMessages || await this.agentBusInput(message.id)) return;
      await this.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id=? AND status='pending' AND dispatched=0", [message.id, botId]);
      return { message, event: await this.store.queueEventInTransaction(conversationId, botId) };
    });
    if (result) this.store.emitQueueEvents([result.event]);
    return result?.message;
  }
  async settled(botId: string, messageId: string): Promise<void> {
    const event = await this.store.db.transaction(async () => {
      const row = await this.store.db.get<{ conversation_id: string }>(`SELECT m.conversation_id FROM messages m JOIN deliveries d ON d.message_id=m.id
        JOIN conversations c ON c.id=m.conversation_id JOIN prompt_queue_workers w ON w.bot_id=d.bot_id
        WHERE m.id=? AND d.bot_id=? AND w.supported=1 AND c.type='direct' AND c.parent_id IS NULL
        AND (SELECT COUNT(*) FROM conversation_members WHERE conversation_id=c.id AND member_type='bot')=1`, [messageId, botId]);
      return row ? this.store.queueEventInTransaction(row.conversation_id, botId) : undefined;
    });
    if (event) this.store.emitQueueEvents([event]);
  }
}
