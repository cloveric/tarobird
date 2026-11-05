import { createHash } from "node:crypto";
import { z } from "zod";
import { type Block, type HubEvent, type Message } from "../client-protocol/index.js";
import {
  GROUP_DISCUSSION_MAX_MEMBERS, GROUP_DISCUSSION_MAX_STEPS, GROUP_DISCUSSION_MIN_MEMBERS, GROUP_DISCUSSION_PROPOSAL_LIMIT, GROUP_DISCUSSION_SUMMARY_LIMIT, GROUP_DISCUSSION_TEXT_LIMIT, GROUP_DISCUSSION_UNSEEN_NOTE_IDS,
  groupDiscussionControlSchema, groupDiscussionDispatchSchema, groupDiscussionReportSchema, groupDiscussionStartSchema, groupDiscussionNoteSchema, groupStanceSchema, hasVisibleGroupText,
  type GroupDiscussionAction, type GroupDiscussionDispatch, type GroupDiscussionRun, type GroupDiscussionStep, type GroupDiscussionStepResult, type GroupDiscussionView, type GroupStance,
} from "../client-protocol/group-discussion.js";
import { anyRun, isRunActive, nativeRun } from "../client-protocol/run.js";
import { activeAnswerFollowup, answerFollowup } from "../client-protocol/answer-followup.js";
import { queueNotice } from "../client-protocol/queue-notice.js";
import { HubError, type HubStore, type TransactionGuard } from "./store.js";

const ACTIVE_SQL = "('running','pausing','paused','ending')";
const TERMINAL = new Set(["completed", "ended", "failed"]);
const SUCCESS = new Set<GroupDiscussionStepResult>(["answered", "partial"]);
const REFERENCE_CHARS = 8000;
const REFERENCE_TOTAL_CHARS = 40_000;
const NOTE_CHARS = 2000;
/** Entries per turn (the dispatch contract's bound), including an overflow line. */
const NOTE_ENTRIES = 10;
const NOTE_PREVIEW_CHARS = 500;
const MIN_REFERENCE_CHARS = 400;
const BRIEF_STEP_CHARS = 600;
const REQUEST_RETENTION_MS = 30 * 24 * 60 * 60_000;

type RunStatus = "running" | "pausing" | "paused" | "ending" | "completed" | "ended" | "failed";
type Participant = { botId: string; name: string };
type Proposal = { id: string; botId: string; text: string; turnId: string };
type RunRow = {
  id: string; group_id: string; conversation_id: string; topic_message_id: string; created_by: string; settings_revision: string;
  mode: "sequential" | "independent"; participants_json: string; left_json: string; max_rounds: number; stage: "blind" | "discussion"; round: number;
  status: RunStatus; pause_reason: string | null; pause_turn_id: string | null; outcome: GroupDiscussionRun["outcome"] | null; conclusion: string | null;
  proposal_json: string | null; proposal_seq: number; revision: number; created_at: number; updated_at: number; finished_at: number | null;
};
type TurnRow = {
  id: string; discussion_id: string; seq: number; round: number; position: number; attempt: number; bot_id: string; blind: number; input_message_id: string;
  context_json: string; state: "active" | "settled"; result: GroupDiscussionStepResult | null; acknowledged: number; report_text: string | null; report_truncated: number;
  stance_json: string | null; stop_requested: number; stop_sent: number; attention: string | null; started: number; created_at: number; settled_at: number | null;
};
/** `noteIds`: every user note this Bot has been given through this turn
 * (absent in contexts frozen before note tracking). Neither field is dispatched. */
type StoredContext = GroupDiscussionDispatch & { seen: string[]; noteIds?: string[] };
type NoteRow = { id: string; created_at: number; blocks_json: string; quoted_blocks_json: string | null; quoted_author_type: string | null };
type Live = { live: true; attention?: "approval" | "answer"; running: boolean };
type Classified = Live | { live: false; result: GroupDiscussionStepResult };
type Stop = { botId: string; conversationId: string; messageId: string; turnId: string };
type Work = { events: HubEvent[]; stops: Stop[] };

export interface GroupDiscussionHooks {
  /** `undefined` while the Bot has no attached worker. */
  workerCapable(botId: string): boolean | undefined;
  /** Stops the engine run executing exactly this input, if it is live. */
  stop(botId: string, conversationId: string, messageId: string): Promise<unknown>;
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const participantsSchema = z.array(z.object({ botId: z.string(), name: z.string() }).strict());
const proposalSchema = z.object({ id: z.string(), botId: z.string(), text: z.string(), turnId: z.string() }).strict();
const contextSchema = groupDiscussionDispatchSchema.extend({ seen: z.array(z.string()), noteIds: z.array(z.string()).optional() });
const clip = (text: string, limit: number) => text.length > limit ? { text: `${text.slice(0, limit - 1)}…`, truncated: true } : { text, truncated: false };
const stanceOf = (turn: TurnRow): GroupStance | undefined => {
  if (!turn.stance_json) return undefined;
  const parsed = groupStanceSchema.safeParse(JSON.parse(turn.stance_json));
  return parsed.success ? parsed.data : undefined;
};
const failure = (result: GroupDiscussionStepResult | null) => !!result && !SUCCESS.has(result);
const seenProposal = (turn: TurnRow): string | undefined => {
  const context = contextSchema.safeParse(JSON.parse(turn.context_json));
  return context.success && !turn.blind ? context.data.proposal?.id : undefined;
};
const MODE_LABEL = { sequential: "轮流讨论", independent: "独立评议" } as const;
const STANCE_LABEL: Record<GroupStance["stance"] | "none", string> = { propose: "提出提案", agree: "同意", disagree: "不同意", abstain: "弃权", none: "未表态" };

/** Hub-owned discussion scheduler. Each speaking turn is one ordinary queued
 * input addressed to one Bot in the original group/topic; there is no hidden
 * session or Agent Bus involvement. A turn advances only once, from durable
 * settled state: delivery terminal, the Bot's replies terminal and, for a
 * successful turn, the worker's own report of the completed engine output. */
export class HubGroupDiscussions {
  constructor(private readonly store: HubStore, private readonly hooks: GroupDiscussionHooks) {}
  private get db() { return this.store.db; }

  /** Read-only: never settles or advances anything. `known` is the reader's
   * opaque `viewRevision` (legacy run/settings token when nothing is hidden);
   * an unchanged view answers `{unchanged:true}`. `brief` shortens step texts. */
  view(userId: string, conversationId: string, validate?: TransactionGuard, options: { brief?: boolean } = {}): Promise<GroupDiscussionView> {
    return this.read(userId, conversationId, validate, options) as Promise<GroupDiscussionView>;
  }
  read(userId: string, conversationId: string, validate?: TransactionGuard, options: { brief?: boolean; known?: string } = {}): Promise<GroupDiscussionView | { unchanged: true }> {
    return this.db.serial(async () => {
      await validate?.(); await this.store.requireMember(userId, conversationId);
      const conversation = await this.store.conversationInTransaction(conversationId);
      if (conversation.type !== "group") throw new HubError("group_required");
      const groupId = conversation.parentId ?? conversation.id;
      const settings = await this.store.groupSettingsInTransaction(groupId);
      let row = await this.db.get<RunRow>(`SELECT * FROM group_discussions WHERE group_id=? AND status IN ${ACTIVE_SQL}`, [groupId]);
      if (row && !await this.db.get("SELECT 1 FROM conversation_members WHERE conversation_id=? AND member_type='user' AND member_id=?", [row.conversation_id, userId])) row = undefined;
      row ??= await this.db.get<RunRow>("SELECT * FROM group_discussions WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 1", [conversationId]);
      // Personal history deletion changes this reader's notes without changing
      // the shared run revision (which is also the scheduler's control CAS).
      // Count within the indexed conversation/time range, not the whole history.
      const hidden = row ? (await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages m
        JOIN message_deletions d ON d.message_id=m.id AND d.user_id=?
        WHERE m.conversation_id=? AND m.created_at>=? AND m.created_at<=?`,
      [userId, row.conversation_id, row.created_at, row.finished_at ?? Number.MAX_SAFE_INTEGER]))!.n : 0;
      const viewRevision = `${row ? `${row.id}.r${row.revision}` : "none"}.${settings.revision}${hidden ? `.d${hidden}` : ""}`;
      if (options.known !== undefined && options.known === viewRevision) return { unchanged: true as const };
      return { settings, run: row ? await this.runView(row, userId, options.brief) : null, viewRevision };
    });
  }
  /** One step with its complete text, for a reader of the run's conversation. */
  step(userId: string, conversationId: string, runId: string, stepId: string, validate?: TransactionGuard): Promise<GroupDiscussionStep> {
    return this.db.serial(async () => {
      await validate?.(); await this.store.requireMember(userId, conversationId);
      const run = await this.db.get<RunRow>("SELECT * FROM group_discussions WHERE id=? AND (conversation_id=? OR group_id=?)", [runId, conversationId, conversationId]);
      if (!run) throw new HubError("group_discussion_not_found", 404);
      await this.store.requireMember(userId, run.conversation_id);
      const step = (await this.runView(run, userId)).steps.find(item => item.id === stepId);
      if (!step) throw new HubError("group_discussion_step_not_found", 404);
      return step;
    });
  }

  async start(userId: string, conversationId: string, raw: unknown, validate?: TransactionGuard): Promise<GroupDiscussionView> {
    const input = groupDiscussionStartSchema.parse(raw);
    const runId = `gd_${digest([userId, input.requestId]).slice(0, 32)}`;
    // Older receipts hash without the recovery fields, so their replays still match.
    const payload = digest(["start", conversationId, input.revision, input.text, input.attachments ?? [], ...(input.replyTo ? [input.replyTo] : []),
      ...(input.participants || input.supersedes ? [input.participants ?? null, input.supersedes?.runId ?? null] : [])]);
    const result = await this.db.transaction(async (): Promise<Work & { value: GroupDiscussionView }> => {
      await validate?.(); await this.store.requireMember(userId, conversationId);
      if (await this.replayed(userId, input.requestId, "start", payload)) return { value: await this.viewInTransaction(userId, conversationId, runId), events: [], stops: [] };
      // Keep exact old receipts replayable; only new requests need visible text.
      if (!hasVisibleGroupText(input.text)) throw new HubError("group_discussion_empty_topic");
      const conversation = await this.store.conversationInTransaction(conversationId);
      if (conversation.type !== "group") throw new HubError("group_required");
      if (conversation.archived || conversation.parentId && (await this.store.conversationInTransaction(conversation.parentId)).archived) throw new HubError("conversation_archived", 409);
      const groupId = conversation.parentId ?? conversation.id;
      const settings = await this.store.groupSettingsInTransaction(groupId);
      // The start names the exact settings the user saw. A mode, order, round or
      // membership change on another device rejects the whole start atomically.
      if (settings.revision !== input.revision) throw new HubError("group_settings_conflict", 409);
      const { policy } = settings;
      if (policy.mode === "mentions" || policy.mode === "parallel") throw new HubError("group_discussion_mode_required", 409);
      // An explicit speaker selection narrows this run only; the saved order
      // still decides who speaks when. Omitted means every member.
      if (input.participants?.some(botId => !policy.botOrder.includes(botId))) throw new HubError("group_discussion_participants_invalid", 409);
      const speakers = input.participants ? policy.botOrder.filter(botId => input.participants!.includes(botId)) : policy.botOrder;
      if (speakers.length < GROUP_DISCUSSION_MIN_MEMBERS || speakers.length > GROUP_DISCUSSION_MAX_MEMBERS) throw new HubError("group_discussion_member_count", 409);
      const owner = (await this.db.get<{ role: string }>("SELECT role FROM users WHERE id=?", [userId]))?.role === "owner";
      const participants: Participant[] = [];
      for (const botId of speakers) {
        const bot = await this.db.get<{ name: string }>("SELECT name FROM bots WHERE id=? AND deleted_at IS NULL", [botId]);
        if (!bot || !conversation.botIds.includes(botId)) throw new HubError("bot_not_found", 404);
        // Same rule as creating a group: starting runs every participant for this user.
        if (!owner && !await this.db.get("SELECT 1 FROM bot_grants WHERE user_id=? AND bot_id=?", [userId, botId])) throw new HubError("bot_forbidden", 403);
        if (this.hooks.workerCapable(botId) === false) throw new HubError("group_discussion_worker_update_required", 409);
        participants.push({ botId, name: bot.name.slice(0, 256) });
      }
      const work: Work = { events: [], stops: [] };
      if (input.supersedes) await this.supersede(userId, conversationId, input.supersedes.runId, work);
      if (await this.db.get(`SELECT 1 FROM group_discussions WHERE group_id=? AND status IN ${ACTIVE_SQL}`, [groupId])) throw new HubError("group_discussion_active", 409);
      const topic = await this.store.sendMessageInTransaction(userId, { conversationId, clientMsgId: `gdtopic_${runId.slice(3)}`, text: input.text, attachments: input.attachments ?? [], previewUrl: null,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}), groupDiscussion: { runId, role: "topic", mode: policy.mode } });
      if (topic.duplicate) throw new HubError("idempotency_conflict", 409);
      const now = Date.now(), stage = policy.mode === "independent" ? "blind" : "discussion";
      await this.db.run(`INSERT INTO group_discussions(id,group_id,conversation_id,topic_message_id,created_by,settings_revision,mode,participants_json,max_rounds,stage,round,status,revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,1,'running',1,?,?)`, [runId, groupId, conversationId, topic.message.id, userId, settings.revision, policy.mode, JSON.stringify(participants), policy.maxRounds, stage, now, now]);
      const run = (await this.db.get<RunRow>("SELECT * FROM group_discussions WHERE id=?", [runId]))!;
      const events = work.events;
      if (topic.event) events.push(topic.event);
      // Independent first round: every participant receives only the topic, at once.
      const positions = stage === "blind" ? participants.map((_, index) => index) : [0];
      for (const position of positions) events.push(await this.createTurn(run, 1, position, 1, stage === "blind"));
      await this.remember(userId, input.requestId, "start", payload, runId);
      await this.db.run("DELETE FROM group_discussion_requests WHERE created_at<?", [now - REQUEST_RETENTION_MS]);
      await this.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [now, userId, "group.discussion_started", JSON.stringify({ runId, groupId, conversationId, mode: policy.mode, participants: participants.length, maxRounds: policy.maxRounds,
        ...(input.participants ? { selected: true } : {}), ...(input.supersedes ? { supersedes: input.supersedes.runId } : {}) })]);
      events.push(await this.store.discussionEventInTransaction(conversationId, { runId, revision: "r1" }));
      return { value: await this.viewInTransaction(userId, conversationId, runId), ...work };
    });
    this.after(result);
    return result.value;
  }
  /** A new topic replaces a paused run in the same transaction. Only a paused
   * run with nothing handed to a worker ends at once; a live speaker first needs
   * End and its terminal evidence, so it is rejected here, never left running.
   * A run that already ended (e.g. on another device) is no longer the run the
   * user chose to replace: refuse, so the draft is reconsidered rather than
   * silently becoming a plain new start. Replays were answered before this. */
  private async supersede(userId: string, conversationId: string, runId: string, work: Work): Promise<void> {
    const run = await this.db.get<RunRow>("SELECT * FROM group_discussions WHERE id=? AND conversation_id=?", [runId, conversationId]);
    if (!run) throw new HubError("group_discussion_not_found", 404);
    if (!await this.canControl(run, userId)) throw new HubError("group_discussion_control_forbidden", 403);
    if (TERMINAL.has(run.status)) throw new HubError("group_discussion_not_active", 409);
    if (run.status !== "paused" || (await this.speaking(await this.turns(run.id))).length) throw new HubError("group_discussion_active", 409);
    await this.apply(run, userId, "end", work);
    if (!TERMINAL.has((await this.db.get<{ status: RunStatus }>("SELECT status FROM group_discussions WHERE id=?", [run.id]))!.status)) throw new HubError("group_discussion_active", 409);
  }

  /** A supplemental composer message is bound to an exact live discussion.
   * It cannot become a broadcast after a delayed send or a settings change. */
  async note(userId: string, conversationId: string, runId: string, raw: unknown, validate?: TransactionGuard): Promise<GroupDiscussionView> {
    const input = groupDiscussionNoteSchema.parse(raw);
    const payload = digest(["note", conversationId, runId, input.text, input.attachments, input.replyTo ?? null,
      ...(input.then || input.ifRunning ? [input.then ?? null, input.revision ?? null, !!input.ifRunning] : [])]);
    const result = await this.db.transaction(async (): Promise<Work & { value: GroupDiscussionView }> => {
      await validate?.(); await this.store.requireMember(userId, conversationId);
      if (await this.replayed(userId, input.requestId, "note", payload)) return { value: await this.viewInTransaction(userId, conversationId, runId), events: [], stops: [] };
      if (!hasVisibleGroupText(input.text) && !input.attachments.length) throw new HubError("empty_message");
      const run = await this.db.get<RunRow>("SELECT * FROM group_discussions WHERE id=? AND conversation_id=?", [runId, conversationId]);
      if (!run || !["running", "pausing", "paused"].includes(run.status)) throw new HubError("group_discussion_not_active", 409);
      // A note written against a running view must not silently wait in a run
      // another device has paused meanwhile.
      if (input.ifRunning && run.status !== "running") throw new HubError("group_discussion_paused", 409);
      // "Add and continue" is one decision: the note and the control commit
      // together or not at all, under the control API's own CAS and permission.
      if (input.then) {
        if (!await this.canControl(run, userId)) throw new HubError("group_discussion_control_forbidden", 403);
        if (`r${run.revision}` !== input.revision) throw new HubError("group_discussion_conflict", 409);
      }
      const note = await this.store.sendMessageInTransaction(userId, { conversationId, clientMsgId: `gdnote_${digest([userId, input.requestId]).slice(0, 32)}`, text: input.text, attachments: input.attachments,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}), parallelCapable: false });
      const work: Work = { events: note.event ? [note.event] : [], stops: [] };
      await this.remember(userId, input.requestId, "note", payload, runId);
      if (input.then) await this.apply(run, userId, input.then, work);
      // Readers' note counts change with the run view.
      else await this.bump(run, work);
      return { value: await this.viewInTransaction(userId, conversationId, runId), ...work };
    });
    this.after(result);
    return result.value;
  }

  async control(userId: string, conversationId: string, runId: string, raw: unknown, validate?: TransactionGuard): Promise<GroupDiscussionView> {
    const input = groupDiscussionControlSchema.parse(raw);
    const payload = digest(["control", runId, input.action, input.revision]);
    const result = await this.db.transaction(async (): Promise<Work & { value: GroupDiscussionView }> => {
      await validate?.(); await this.store.requireMember(userId, conversationId);
      // A topic's run may also be addressed through its root group, which is
      // where the group-level status is read; membership of the run's own
      // conversation is still required.
      const run = await this.db.get<RunRow>("SELECT * FROM group_discussions WHERE id=? AND (conversation_id=? OR group_id=?)", [runId, conversationId, conversationId]);
      if (!run) throw new HubError("group_discussion_not_found", 404);
      await this.store.requireMember(userId, run.conversation_id);
      if (!await this.canControl(run, userId)) throw new HubError("group_discussion_control_forbidden", 403);
      const view = async () => this.viewInTransaction(userId, run.conversation_id, runId);
      if (await this.replayed(userId, input.requestId, "control", payload)) return { value: await view(), events: [], stops: [] };
      const done = await this.alreadyDone(run, input.action);
      // A stale view may still ask for a state that already holds. End and
      // pause never create work, so the exact run identity suffices for them:
      // dispatch/attention updates cannot make Stop fail. Pause still applies
      // only to a running run. Resume and retry create turns and keep the CAS.
      if (`r${run.revision}` !== input.revision && !done && !(input.action === "end" || input.action === "pause" && run.status === "running")) throw new HubError("group_discussion_conflict", 409);
      const work: Work = { events: [], stops: [] };
      if (!done) await this.apply(run, userId, input.action, work);
      await this.remember(userId, input.requestId, "control", payload, runId);
      return { value: await view(), ...work };
    });
    this.after(result);
    return result.value;
  }

  /** Metadata for one dispatched input; undefined for any other message. */
  dispatch(botId: string, messageId: string): Promise<GroupDiscussionDispatch | undefined> {
    return this.db.serial(async () => {
      const turn = await this.db.get<TurnRow>("SELECT * FROM group_discussion_turns WHERE input_message_id=? AND bot_id=?", [messageId, botId]);
      if (!turn) return undefined;
      const { seen: _seen, noteIds: _noteIds, ...context } = contextSchema.parse(JSON.parse(turn.context_json));
      return groupDiscussionDispatchSchema.parse(context);
    });
  }
  /** The reporting worker's own completed output for its dispatched turn. */
  async report(botId: string, raw: unknown): Promise<void> {
    const input = groupDiscussionReportSchema.parse(raw);
    await this.db.transaction(async () => {
      const turn = await this.db.get<TurnRow>("SELECT * FROM group_discussion_turns WHERE id=? AND input_message_id=? AND bot_id=?", [input.turnId, input.messageId, botId]);
      if (!turn) throw new HubError("group_discussion_turn_forbidden", 403);
      if (turn.state !== "active") return;
      const delivery = await this.db.get<{ status: string; dispatched: number }>("SELECT status,dispatched FROM deliveries WHERE message_id=? AND bot_id=?", [turn.input_message_id, botId]);
      if (!delivery?.dispatched || !["pending", "accepted"].includes(delivery.status)) return;
      // One report per turn: the speaker's primary answer and position. A later
      // repair call inside the same turn (e.g. artifact delivery) never replaces it.
      await this.db.run("UPDATE group_discussion_turns SET report_text=?,report_truncated=?,stance_json=? WHERE id=? AND state='active' AND report_text IS NULL",
        [input.text, Number(!!input.truncated), input.stance ? JSON.stringify(input.stance) : null, turn.id]);
    });
  }
  /** After an acknowledgement, failure receipt or reply publication for an input. */
  async settleInput(botId: string, messageId: string, failure?: "interrupted" | "failed"): Promise<void> {
    const result = await this.db.transaction(async () => {
      const turn = await this.db.get<{ discussion_id: string }>("SELECT discussion_id FROM group_discussion_turns WHERE input_message_id=? AND bot_id=? AND state='active'", [messageId, botId]);
      const work: Work = { events: [], stops: [] };
      if (turn) await this.progress(turn.discussion_id, work, failure ? new Map([[messageId, failure]]) : undefined);
      return work;
    });
    this.after(result);
  }
  /** Cheap filter for every Bot publication; only replies that can change a
   * live turn's outcome or deliver a pending Stop do any work. */
  async published(botId: string, message: Message): Promise<void> {
    if (!message.replyTo) return;
    const turn = await this.db.serial(() => this.db.get<{ stop_requested: number; stop_sent: number; attention: string | null; started: number }>("SELECT stop_requested,stop_sent,attention,started FROM group_discussion_turns WHERE input_message_id=? AND bot_id=? AND state='active'", [message.replyTo!, botId]));
    if (!turn) return;
    // Waiting for an approval/answer (or no longer waiting) is shown to users.
    const phases = message.blocks.flatMap(block => block.type === "card" ? anyRun(block)?.phase ?? [] : []);
    const attention = phases.includes("waiting_approval") ? "approval" : phases.includes("waiting_answer") ? "answer" : null;
    if (["complete", "error", "deleted"].includes(message.status) || turn.stop_requested && !turn.stop_sent || (phases.length && attention !== turn.attention) || !turn.started && phases.some(isRunActive)) await this.settleInput(botId, message.replyTo);
  }
  /** An input reached its worker, where it may still wait in the Core queue. */
  async markDispatched(botId: string, messageId: string): Promise<void> {
    const result = await this.db.transaction(async () => {
      const turn = await this.db.get<{ discussion_id: string }>("SELECT discussion_id FROM group_discussion_turns WHERE input_message_id=? AND bot_id=? AND state='active'", [messageId, botId]);
      const work: Work = { events: [], stops: [] };
      if (turn) await this.progress(turn.discussion_id, work, undefined, true);
      return work;
    });
    this.after(result);
  }
  /** Deletion, membership loss or a recovered worker can settle many inputs.
   * On worker attachment, a Stop requested for an ending run is re-sent if the
   * turn's own run card is still live (the earlier call may have been lost). */
  async settleBot(botId: string, attached = false): Promise<void> {
    const result = await this.db.transaction(async () => {
      const work: Work = { events: [], stops: [] };
      if (attached) await this.db.run("UPDATE group_discussion_turns SET stop_sent=0 WHERE bot_id=? AND state='active' AND stop_requested=1", [botId]);
      // Also every active run that merely lists this Bot: a deleted or removed
      // future speaker must be retired before it is scheduled.
      const runs = await this.db.all<{ id: string }>(`SELECT DISTINCT id FROM (SELECT discussion_id AS id FROM group_discussion_turns WHERE bot_id=? AND state='active'
        UNION SELECT d.id FROM group_discussions d, json_each(d.participants_json) p WHERE d.status IN ${ACTIVE_SQL} AND json_extract(p.value,'$.botId')=?)`, [botId, botId]);
      for (const { id } of runs) await this.progress(id, work);
      return work;
    });
    this.after(result);
  }
  /** Startup reconciliation: settled deliveries whose result was not yet
   * applied advance exactly once; nothing uncertain is replayed. */
  async reconcile(): Promise<void> {
    const result = await this.db.transaction(async () => {
      const work: Work = { events: [], stops: [] };
      for (const { id } of await this.db.all<{ id: string }>(`SELECT id FROM group_discussions WHERE status IN ${ACTIVE_SQL}`)) await this.progress(id, work);
      return work;
    });
    this.after(result);
  }
  /** Caller holds the claim transaction. A worker without the discussion
   * capability would answer the bare input as chat; withhold it instead. */
  async rejectForWorkerInTransaction(botId: string, messageIds: string[]): Promise<HubEvent[]> {
    const work: Work = { events: [], stops: [] }, runs = new Set<string>();
    for (const messageId of messageIds) {
      const turn = await this.db.get<TurnRow>("SELECT * FROM group_discussion_turns WHERE input_message_id=? AND bot_id=? AND state='active'", [messageId, botId]);
      const delivery = await this.db.get<{ status: string; dispatched: number }>("SELECT status,dispatched FROM deliveries WHERE message_id=? AND bot_id=?", [messageId, botId]);
      if (!turn || delivery?.status !== "pending") continue;
      // A dispatched input may already have partly run on a newer worker.
      await this.db.run("UPDATE deliveries SET status=? WHERE message_id=? AND bot_id=? AND status='pending'", [delivery.dispatched ? "failed" : "cancelled", messageId, botId]);
      await this.db.run("UPDATE group_discussion_turns SET state='settled',result='worker_update_required',settled_at=? WHERE id=? AND state='active'", [Date.now(), turn.id]);
      runs.add(turn.discussion_id);
    }
    for (const id of runs) await this.progress(id, work);
    return work.events;
  }
  async inputIdsForBotInTransaction(botId: string): Promise<string[]> {
    return (await this.db.all<{ message_id: string }>(`SELECT d.message_id FROM deliveries d JOIN group_discussion_turns t ON t.input_message_id=d.message_id AND t.bot_id=d.bot_id
      WHERE d.bot_id=? AND d.status='pending'`, [botId])).map(row => row.message_id);
  }

  private after(work: Work): void {
    this.store.emitCommitted(work.events);
    // The durable stop_requested intent survives; a failed or unconfirmed Stop
    // is re-armed so the next publication, reattachment or restart retries it.
    for (const stop of work.stops) void this.hooks.stop(stop.botId, stop.conversationId, stop.messageId)
      .then(result => { if (z.object({ stopped: z.literal(true) }).safeParse(result).success) return; throw new Error("stop_unconfirmed"); })
      .catch(() => this.db.serial(() => this.db.run("UPDATE group_discussion_turns SET stop_sent=0 WHERE id=? AND state='active'", [stop.turnId])).catch(() => undefined));
  }
  private async replayed(userId: string, requestId: string, kind: string, payload: string): Promise<boolean> {
    const prior = await this.db.get<{ kind: string; payload_hash: string }>("SELECT kind,payload_hash FROM group_discussion_requests WHERE user_id=? AND request_id=?", [userId, requestId]);
    if (prior && (prior.kind !== kind || prior.payload_hash !== payload)) throw new HubError("idempotency_conflict", 409);
    return !!prior;
  }
  private async remember(userId: string, requestId: string, kind: string, payload: string, resultId: string): Promise<void> {
    await this.db.run("INSERT INTO group_discussion_requests VALUES(?,?,?,?,?,?)", [userId, requestId, kind, payload, resultId, Date.now()]);
  }
  private async canControl(run: RunRow, userId: string): Promise<boolean> {
    if (run.created_by === userId) return true;
    return (await this.db.get<{ owner_id: string }>("SELECT owner_id FROM conversations WHERE id=?", [run.group_id]))?.owner_id === userId;
  }
  private async alreadyDone(run: RunRow, action: GroupDiscussionAction): Promise<boolean> {
    if (action === "pause") return run.status === "paused" || run.status === "pausing" && run.pause_reason === "user";
    if (action === "end") return run.status === "ending" || TERMINAL.has(run.status);
    if (action === "resume") return run.status === "running";
    return false;
  }
  private async turns(runId: string): Promise<TurnRow[]> {
    return this.db.all<TurnRow>("SELECT * FROM group_discussion_turns WHERE discussion_id=? ORDER BY seq", [runId]);
  }
  /** Active turns already handed to a worker. Undispatched inputs of a paused
   * run are held by the queue claim and are not "speaking". */
  private async speaking(turns: TurnRow[]): Promise<TurnRow[]> {
    const result: TurnRow[] = [];
    for (const turn of turns) if (turn.state === "active" && (await this.db.get<{ dispatched: number }>("SELECT dispatched FROM deliveries WHERE message_id=? AND bot_id=?", [turn.input_message_id, turn.bot_id]))?.dispatched) result.push(turn);
    return result;
  }
  private async apply(run: RunRow, userId: string, action: GroupDiscussionAction, work: Work): Promise<void> {
    const turns = await this.turns(run.id), active = turns.filter(turn => turn.state === "active");
    if (TERMINAL.has(run.status)) throw new HubError("group_discussion_not_active", 409);
    if (action === "pause") {
      if (run.status !== "running") throw new HubError("group_discussion_not_running", 409);
      // Pausing never interrupts the Bot that is speaking now; an input not yet
      // handed to its worker is held until resume.
      await this.update(run, { status: (await this.speaking(turns)).length ? "pausing" : "paused", pause_reason: "user", pause_turn_id: null });
    } else if (action === "resume") {
      if (run.status === "pausing" && run.pause_reason === "user") await this.update(run, { status: "running", pause_reason: null });
      else if (run.status !== "paused") throw new HubError("group_discussion_not_paused", 409);
      // Skipping every first-round answer would reveal nothing and start the
      // discussion without any position: only Retry or End remain.
      else if (this.blindUnanswered(run, turns)) throw new HubError("group_discussion_resume_unavailable", 409);
      else if (await this.archived(run)) throw new HubError("conversation_archived", 409);
      else {
        // Continue after a failed/stopped/uncertain turn without rerunning it.
        await this.acknowledgeFailures(run, turns);
        await this.retireUnavailable(run);
        await this.update(run, { status: "running", pause_reason: null, pause_turn_id: null });
      }
    } else if (action === "retry") {
      const { retry, drop, failed } = await this.retryPlan(run, turns);
      if (!failed) throw new HubError("group_discussion_retry_unavailable", 409);
      if (turns.length + Math.max(1, retry.length) > GROUP_DISCUSSION_MAX_STEPS) throw new HubError("group_discussion_turn_limit", 409);
      if (!retry.length) throw new HubError("group_discussion_participant_unavailable", 409);
      for (const turn of retry) if (this.hooks.workerCapable(turn.bot_id) === false) throw new HubError("group_discussion_worker_update_required", 409);
      if (await this.archived(run)) throw new HubError("conversation_archived", 409);
      // A first-round failure is retried together with every other unfinished
      // first-round answer; completed answers are never rerun. Members that can
      // no longer answer are acknowledged as retired.
      for (const turn of [...retry, ...drop]) await this.db.run("UPDATE group_discussion_turns SET acknowledged=1 WHERE id=?", [turn.id]);
      for (const turn of retry) {
        const attempt = Math.max(...turns.filter(other => other.round === turn.round && other.position === turn.position).map(other => other.attempt)) + 1;
        work.events.push(await this.createTurn(run, turn.round, turn.position, attempt, !!turn.blind));
      }
      if (drop.length) await this.retireUnavailable(run);
      await this.update(run, { status: "running", pause_reason: null, pause_turn_id: null });
    } else {
      // End = request Stop for live turns and wait for their terminal state.
      // Never-dispatched inputs are withdrawn in this transaction.
      for (const turn of active) {
        const withdrawn = await this.db.run("UPDATE deliveries SET status='cancelled' WHERE message_id=? AND bot_id=? AND status='pending' AND dispatched=0", [turn.input_message_id, turn.bot_id]);
        if (withdrawn.changes) {
          await this.db.run("UPDATE group_discussion_turns SET state='settled',result='cancelled',acknowledged=1,settled_at=? WHERE id=? AND state='active'", [Date.now(), turn.id]);
          work.events.push(await this.store.queueEventInTransaction(run.conversation_id, turn.bot_id));
        } else await this.db.run("UPDATE group_discussion_turns SET stop_requested=1 WHERE id=?", [turn.id]);
      }
      await this.update(run, { status: "ending", pause_reason: "user", pause_turn_id: null });
      await this.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), userId, "group.discussion_end_requested", JSON.stringify({ runId: run.id, live: active.length })]);
    }
    if (action === "resume" || action === "retry") await this.refreshHeldTurns(run, active, work);
    await this.progress(run.id, work, undefined, true);
  }
  private async update(run: RunRow, fields: Partial<Pick<RunRow, "status" | "pause_reason" | "pause_turn_id" | "stage" | "round" | "outcome" | "conclusion" | "proposal_json" | "proposal_seq" | "finished_at" | "left_json">>): Promise<void> {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    await this.db.run(`UPDATE group_discussions SET ${keys.map(key => `${key}=?`).join(",")} WHERE id=?`, [...keys.map(key => fields[key] ?? null), run.id]);
    Object.assign(run, fields);
  }
  private async participantAvailable(run: RunRow, botId: string): Promise<boolean> {
    return !!await this.db.get("SELECT 1 FROM bots b JOIN conversation_members m ON m.member_id=b.id AND m.member_type='bot' AND m.conversation_id=? WHERE b.id=? AND b.deleted_at IS NULL", [run.conversation_id, botId]);
  }
  private async archived(run: RunRow): Promise<boolean> {
    return !!await this.db.get("SELECT 1 FROM conversations WHERE id IN (?,?) AND archived=1", [run.conversation_id, run.group_id]);
  }
  private async retireUnavailable(run: RunRow): Promise<void> {
    const left = new Set(z.array(z.string()).parse(JSON.parse(run.left_json)));
    for (const participant of participantsSchema.parse(JSON.parse(run.participants_json))) if (!left.has(participant.botId) && !await this.participantAvailable(run, participant.botId)) left.add(participant.botId);
    await this.update(run, { left_json: JSON.stringify([...left]) });
  }
  /** Every first-round answer is terminal and none succeeded. */
  private blindUnanswered(run: RunRow, turns: TurnRow[]): boolean {
    const blind = turns.filter(turn => turn.blind);
    return run.stage === "blind" && !blind.some(turn => turn.state === "active") && !blind.some(turn => turn.state === "settled" && SUCCESS.has(turn.result!));
  }
  /** What Retry would rerun: the paused-on turn or, in the independent first
   * round, every unacknowledged first-round failure. `drop` cannot answer again. */
  private async retryPlan(run: RunRow, turns: TurnRow[]): Promise<{ failed?: TurnRow; retry: TurnRow[]; drop: TurnRow[] }> {
    const failed = run.status === "paused" && run.pause_turn_id ? turns.find(turn => turn.id === run.pause_turn_id) : undefined;
    if (!failed || failed.acknowledged || !failure(failed.result)) return { retry: [], drop: [] };
    const candidates = failed.blind ? turns.filter(turn => turn.blind && turn.state === "settled" && failure(turn.result) && !turn.acknowledged) : [failed];
    const retry: TurnRow[] = [], drop: TurnRow[] = [];
    for (const turn of candidates) (await this.participantAvailable(run, turn.bot_id) ? retry : drop).push(turn);
    return { failed, retry, drop };
  }
  /** A run view change without a scheduling change (e.g. a new note). */
  private async bump(run: RunRow, work: Work): Promise<void> {
    const revision = run.revision + 1;
    await this.db.run("UPDATE group_discussions SET revision=?,updated_at=? WHERE id=?", [revision, Date.now(), run.id]);
    run.revision = revision;
    work.events.push(await this.store.discussionEventInTransaction(run.conversation_id, { runId: run.id, revision: `r${revision}` }));
  }
  private async acknowledgeFailures(run: RunRow, turns: TurnRow[]): Promise<void> {
    for (const turn of turns) if (turn.state === "settled" && failure(turn.result) && !turn.acknowledged) await this.db.run("UPDATE group_discussion_turns SET acknowledged=1 WHERE id=?", [turn.id]);
    void run;
  }

  /** Caller holds the transaction. Re-evaluates every live turn of one run,
   * applies settled results once, then advances at most one step. */
  private async progress(runId: string, work: Work, failures?: Map<string, "interrupted" | "failed">, force = false): Promise<void> {
    const run = await this.db.get<RunRow>("SELECT * FROM group_discussions WHERE id=?", [runId]);
    if (!run || TERMINAL.has(run.status)) return;
    let changed = force;
    for (const turn of await this.turns(run.id)) {
      if (turn.state !== "active") continue;
      const outcome = await this.classify(run, turn, failures?.get(turn.input_message_id));
      if (outcome.live) {
        if (outcome.running && !turn.started) {
          await this.db.run("UPDATE group_discussion_turns SET started=1 WHERE id=?", [turn.id]);
          changed = true;
        }
        // A dispatched input can still be waiting inside Core's own queue or
        // preparing its run card. Exact-input Stop must reach that queue too.
        if (turn.stop_requested && !turn.stop_sent) {
          await this.db.run("UPDATE group_discussion_turns SET stop_sent=1 WHERE id=?", [turn.id]);
          work.stops.push({ botId: turn.bot_id, conversationId: run.conversation_id, messageId: turn.input_message_id, turnId: turn.id });
        }
        if ((outcome.attention ?? null) !== turn.attention) {
          await this.db.run("UPDATE group_discussion_turns SET attention=? WHERE id=?", [outcome.attention ?? null, turn.id]);
          changed = true;
        }
        continue;
      }
      const settled = await this.db.run("UPDATE group_discussion_turns SET state='settled',result=?,attention=NULL,settled_at=? WHERE id=? AND state='active'", [outcome.result, Date.now(), turn.id]);
      if (!settled.changes) continue;
      changed = true;
      if (outcome.result === "unavailable") await this.retireUnavailable(run);
      // Positions from the independent round are applied together at reveal.
      if (!turn.blind && SUCCESS.has(outcome.result)) await this.applyStance(run, { ...turn, state: "settled", result: outcome.result });
    }
    changed = await this.advance(run, work) || changed;
    if (changed) {
      const revision = run.revision + 1;
      await this.db.run("UPDATE group_discussions SET revision=?,updated_at=? WHERE id=?", [revision, Date.now(), run.id]);
      run.revision = revision;
      work.events.push(await this.store.discussionEventInTransaction(run.conversation_id, { runId: run.id, revision: `r${revision}` }));
    }
  }

  /** The Bot's replies to this input: whether any is still live, and the
   * terminal phases of its foreground run cards. */
  private async replies(turn: TurnRow): Promise<{ live: boolean; running: boolean; attention?: Live["attention"]; phases: string[]; error: boolean }> {
    const rows = await this.db.all<{ blocks_json: string; status: Message["status"]; reply_to: string; created_at: number; conversation_id: string }>(
      "SELECT blocks_json,status,reply_to,created_at,conversation_id FROM messages WHERE reply_to=? AND author_id=? AND author_type='bot' AND status!='deleted'", [turn.input_message_id, turn.bot_id]);
    let attention: Live["attention"], live = false, running = false, error = false;
    const phases: string[] = [];
    for (const row of rows) {
      const meta = { authorType: "bot" as const, conversationId: row.conversation_id, replyTo: row.reply_to, createdAt: row.created_at };
      if (["pending", "streaming"].includes(row.status)) live = true;
      if (row.status === "error") error = true;
      for (const block of JSON.parse(row.blocks_json) as Block[]) {
        if (block.type !== "card") continue;
        const summary = anyRun(block);
        if (summary && isRunActive(summary.phase)) {
          live = true; running = true;
          if (summary.phase === "waiting_approval") attention = "approval";
          if (summary.phase === "waiting_answer") attention ??= "answer";
        }
        if (activeAnswerFollowup(answerFollowup(block))) live = true;
        if (["queued", "started"].includes(queueNotice(block, meta)?.state ?? "")) live = true;
        const foreground = nativeRun(block);
        if (foreground) phases.push(foreground.phase);
      }
    }
    return { live, running, ...(attention ? { attention } : {}), phases, error };
  }
  private async classify(run: RunRow, turn: TurnRow, failed?: "interrupted" | "failed"): Promise<Classified> {
    const available = await this.participantAvailable(run, turn.bot_id);
    const delivery = await this.db.get<{ status: string; dispatched: number }>("SELECT status,dispatched FROM deliveries WHERE message_id=? AND bot_id=?", [turn.input_message_id, turn.bot_id]);
    if (!delivery) return { live: false, result: "unavailable" };
    if (delivery.status === "pending") {
      if (available) {
        const replies = await this.replies(turn);
        return { live: true, running: replies.running, ...(replies.attention ? { attention: replies.attention } : {}) };
      }
      // A removed/deleted participant can never acknowledge its input.
      await this.db.run("UPDATE deliveries SET status=? WHERE message_id=? AND bot_id=? AND status='pending'", [delivery.dispatched ? "failed" : "cancelled", turn.input_message_id, turn.bot_id]);
      return { live: false, result: "unavailable" };
    }
    if (delivery.status === "cancelled") return { live: false, result: available ? "cancelled" : "unavailable" };
    if (delivery.status === "failed") return { live: false, result: !available ? "unavailable" : failed ?? (turn.stop_requested ? "stopped" : "interrupted") };
    // A receipt can precede the final run-card publication: wait for it.
    const replies = await this.replies(turn);
    if (replies.live) return { live: true, running: replies.running, ...(replies.attention ? { attention: replies.attention } : {}) };
    if (replies.phases.includes("stopped")) return { live: false, result: "stopped" };
    if (replies.phases.includes("interrupted")) return { live: false, result: "interrupted" };
    if (replies.phases.includes("error")) return { live: false, result: "failed" };
    // Success needs the worker's report of the completed engine output; an
    // acknowledged turn that never produced one (dropped, budget, prepare
    // error) is not an answer.
    if (!turn.report_text?.trim()) return { live: false, result: turn.stop_requested ? "stopped" : replies.error ? "failed" : "no_reply" };
    return { live: false, result: replies.phases.includes("partial") || replies.error ? "partial" : "answered" };
  }

  private async applyStance(run: RunRow, turn: TurnRow): Promise<void> {
    const stance = stanceOf(turn);
    if (stance?.stance !== "propose" || !stance.proposal) return;
    const seq = run.proposal_seq + 1;
    // A new proposal revision implicitly clears every earlier agreement.
    const proposal: Proposal = { id: `P${seq}`, botId: turn.bot_id, text: stance.proposal.slice(0, GROUP_DISCUSSION_PROPOSAL_LIMIT), turnId: turn.id };
    await this.update(run, { proposal_seq: seq, proposal_json: JSON.stringify(proposal) });
  }
  private proposal(run: RunRow): Proposal | undefined {
    return run.proposal_json ? proposalSchema.parse(JSON.parse(run.proposal_json)) : undefined;
  }
  /** Latest successful position of each participant; never inferred from prose. */
  private positions(run: RunRow, turns: TurnRow[]): Map<string, { stance?: GroupStance; turn: TurnRow }> {
    const latest = new Map<string, { stance?: GroupStance; turn: TurnRow }>();
    for (const turn of turns) if (turn.state === "settled" && SUCCESS.has(turn.result!) && (!turn.blind || run.stage === "discussion")) latest.set(turn.bot_id, { stance: stanceOf(turn), turn });
    return latest;
  }
  /** Agreement counts only for the exact proposal frozen into that Bot's own
   * turn context: a guessed, future or (blind-round) unseen ID is no agreement. */
  private agrees(position: { stance?: GroupStance; turn: TurnRow } | undefined, proposal: Proposal): boolean {
    const stance = position?.stance;
    if (stance?.stance === "propose") return position!.turn.id === proposal.turnId;
    return stance?.stance === "agree" && stance.proposalId === proposal.id && seenProposal(position!.turn) === proposal.id;
  }
  private activeParticipants(run: RunRow): Participant[] {
    const left = new Set(z.array(z.string()).parse(JSON.parse(run.left_json)));
    return participantsSchema.parse(JSON.parse(run.participants_json)).filter(participant => !left.has(participant.botId));
  }

  /** Returns whether run state changed. */
  private async advance(run: RunRow, work: Work): Promise<boolean> {
    if (TERMINAL.has(run.status)) return false;
    const turns = await this.turns(run.id);
    const unacknowledged = turns.find(turn => turn.state === "settled" && failure(turn.result) && !turn.acknowledged);
    // Once a failure starts a pause, undispatched inputs are held immediately.
    // Do not await another event from those held inputs to finish pausing: the
    // queue will no longer dispatch them and may produce no further receipt.
    const holding = run.status === "pausing" || run.status === "paused" || run.status === "running" && !!unacknowledged;
    const active = holding ? await this.speaking(turns) : turns.filter(turn => turn.state === "active");
    if (active.length) {
      // Other independent answers keep running; the run stops after them.
      if (unacknowledged && run.status === "running") { await this.update(run, { status: "pausing", pause_reason: `turn_${unacknowledged.result}`, pause_turn_id: unacknowledged.id }); return true; }
      return false;
    }
    if (run.status === "ending") { await this.finish(run, turns, "ended", "stopped"); return true; }
    if (unacknowledged) {
      if (run.status === "paused" && run.pause_turn_id === unacknowledged.id) return false;
      await this.update(run, { status: "paused", pause_reason: `turn_${unacknowledged.result}`, pause_turn_id: unacknowledged.id });
      return true;
    }
    if (run.status === "pausing") { await this.update(run, { status: "paused" }); return true; }
    if (run.status === "paused") return false;
    // A held input resumes as it is; never schedule a duplicate speaker.
    if (turns.some(turn => turn.state === "active")) return false;
    // Deleted or removed members never receive another turn.
    await this.retireUnavailable(run);
    const participants = this.activeParticipants(run);
    if (participants.length < GROUP_DISCUSSION_MIN_MEMBERS) { await this.finish(run, turns, "completed", "different_views", "participants_insufficient"); return true; }
    let changed = false;
    if (run.stage === "blind") {
      // Reveal only after every first-round answer is terminal; apply their
      // proposals in the configured order so the result is deterministic.
      await this.update(run, { stage: "discussion" });
      const blind = turns.filter(turn => turn.blind && turn.state === "settled" && SUCCESS.has(turn.result!)).sort((a, b) => a.position - b.position || a.attempt - b.attempt);
      for (const turn of blind) await this.applyStance(run, turn);
      changed = true;
    }
    const proposal = this.proposal(run);
    if (proposal) {
      const positions = this.positions(run, turns);
      if (participants.every(participant => this.agrees(positions.get(participant.botId), proposal))) { await this.finish(run, turns, "completed", "consensus"); return true; }
    }
    const next = this.slotAfter(run, turns, new Set(participants.map(participant => participant.botId)));
    if (!next) { await this.finish(run, turns, "completed", "different_views"); return true; }
    if (turns.length >= GROUP_DISCUSSION_MAX_STEPS) { await this.finish(run, turns, "completed", "different_views", "group_discussion_turn_limit"); return true; }
    if (await this.archived(run)) {
      if (run.pause_reason === "conversation_archived" && !changed) return false;
      await this.update(run, { status: "paused", pause_reason: "conversation_archived", pause_turn_id: null }); return true;
    }
    work.events.push(await this.createTurn(run, next.round, next.position, 1, false));
    await this.update(run, { round: next.round });
    return true;
  }
  /** The next speaking slot after the latest sequential turn (a retry repeats
   * its slot); the independent round is round 1, so discussion begins at round 2.
   * Shared by scheduling and the read-only `next` hint. */
  private slotAfter(run: RunRow, turns: TurnRow[], activeIds: Set<string>): { round: number; position: number } | undefined {
    const all = participantsSchema.parse(JSON.parse(run.participants_json));
    const last = [...turns].reverse().find(turn => !turn.blind);
    let round = last?.round ?? (run.mode === "independent" ? 2 : 1), position = last ? last.position + 1 : 0;
    for (;;) {
      if (position >= all.length) { round++; position = 0; }
      if (round > run.max_rounds) return undefined;
      if (activeIds.has(all[position]!.botId)) return { round, position };
      position++;
    }
  }

  private async finish(run: RunRow, turns: TurnRow[], status: "completed" | "ended" | "failed", outcome: NonNullable<GroupDiscussionRun["outcome"]>, error?: string): Promise<void> {
    const proposal = this.proposal(run), participants = participantsSchema.parse(JSON.parse(run.participants_json));
    const names = new Map(participants.map(participant => [participant.botId, participant.name]));
    // A blind run ended early still has terminal answers to list.
    const positions = this.positions({ ...run, stage: "discussion" }, turns);
    let conclusion: string;
    if (outcome === "consensus" && proposal) conclusion = `全员同意提案 ${proposal.id}（${names.get(proposal.botId) ?? proposal.botId} 提出）：\n${proposal.text}`;
    else {
      const lines = participants.map(participant => {
        const position = positions.get(participant.botId), stance = position?.stance;
        const label = stance ? `${STANCE_LABEL[stance.stance]}${stance.proposalId ? ` ${stance.proposalId}` : ""}` : position ? STANCE_LABEL.none : "未发言";
        const summary = stance?.summary || (stance?.stance === "propose" ? stance.proposal?.slice(0, GROUP_DISCUSSION_SUMMARY_LIMIT) : undefined);
        return `- ${participant.name}：${label}${summary ? ` — ${summary}` : ""}`;
      });
      conclusion = [outcome === "stopped" ? "讨论已结束，以下为各成员最后的立场：" : "未达成全员一致，保留各成员最后的立场：", ...lines,
        ...(proposal ? [`当前提案 ${proposal.id}（${names.get(proposal.botId) ?? proposal.botId}）：${proposal.text}`] : [])].join("\n");
    }
    await this.update(run, { status, outcome, conclusion: clip(conclusion, GROUP_DISCUSSION_TEXT_LIMIT).text, finished_at: Date.now(), pause_reason: error ?? null, pause_turn_id: null });
    await this.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), "hub", "group.discussion_finished", JSON.stringify({ runId: run.id, status, outcome, turns: turns.length })]);
  }

  /** Freeze context only before the input is claimed by a worker. */
  private async turnContext(run: RunRow, round: number, position: number, attempt: number, blind: boolean, turnId: string, turns: TurnRow[]): Promise<{ context: StoredContext; resources: Block[] }> {
    const participants = participantsSchema.parse(JSON.parse(run.participants_json)), self = participants[position]!;
    const topic = await this.store.queuedMessageInTransaction(run.topic_message_id);
    const topicText = topic.blocks.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
    const topicAttachments = topic.blocks.flatMap(block => block.type === "file" ? [block.name] : block.type === "image" ? [block.title ?? "image"] : block.type === "audio" ? [block.name ?? "audio"] : []).slice(0, 16);
    const base = { v: 1 as const, runId: run.id, turnId, conversationId: run.conversation_id, mode: run.mode, stage: blind ? "blind" as const : "discussion" as const,
      round, maxRounds: run.max_rounds, position, attempt, self, participants, topic: clip(topicText, GROUP_DISCUSSION_TEXT_LIMIT).text, topicAttachments, remainingRounds: Math.max(0, run.max_rounds - round) };
    // A failed attempt may never have reached the engine's session: count
    // material as seen only through this Bot's last successful turn.
    const previous = [...turns].reverse().find(turn => turn.bot_id === self.botId && turn.state === "settled" && SUCCESS.has(turn.result!));
    // The user's own notes reach every new turn. The independent first round
    // withholds other members' answers only, so a first-round retry still gets
    // the correction it was retried for (without quotes of members' replies).
    const notes = await this.notesFor(run, previous, blind);
    let context: StoredContext;
    if (blind) context = { ...base, references: [], positions: [], notes: notes.texts, seen: [], noteIds: notes.ids };
    else {
      // Only material revealed after this Bot's previous turn is resent in
      // full; the positions summary covers everything earlier, bounded.
      const seen = new Set(previous ? contextSchema.parse(JSON.parse(previous.context_json)).seen : []);
      const names = new Map(participants.map(participant => [participant.botId, participant.name]));
      const fresh = turns.filter(turn => turn.bot_id !== self.botId && turn.state === "settled" && SUCCESS.has(turn.result!) && turn.report_text && !seen.has(turn.id));
      // Newest first within a hard total; anything older that no longer fits is
      // summarized only by the positions below (and counted as omitted).
      const references: GroupDiscussionDispatch["references"] = [];
      let budget = REFERENCE_TOTAL_CHARS, omitted = 0;
      for (const turn of [...fresh].reverse()) {
        if (budget < MIN_REFERENCE_CHARS) { omitted++; continue; }
        const value = clip(turn.report_text!, Math.min(REFERENCE_CHARS, budget));
        budget -= value.text.length;
        references.unshift({ botId: turn.bot_id, name: names.get(turn.bot_id) ?? turn.bot_id, round: turn.round, text: value.text, ...(value.truncated || turn.report_truncated ? { truncated: true } : {}) });
      }
      for (const turn of fresh) seen.add(turn.id);
      const latest = this.positions({ ...run, stage: "discussion" }, turns);
      const positions = participants.map(participant => {
        const stance = latest.get(participant.botId)?.stance;
        return { botId: participant.botId, name: participant.name, stance: stance?.stance ?? "none" as const, ...(stance?.proposalId ? { proposalId: stance.proposalId } : {}), ...(stance?.summary ? { summary: stance.summary.slice(0, GROUP_DISCUSSION_SUMMARY_LIMIT) } : {}) };
      });
      const proposal = this.proposal(run);
      context = { ...base, references, ...(omitted ? { omittedReferences: omitted } : {}), positions, notes: notes.texts, seen: [...seen], noteIds: notes.ids,
        ...(proposal ? { proposal: { id: proposal.id, botId: proposal.botId, name: names.get(proposal.botId) ?? proposal.botId, text: proposal.text } } : {}) };
    }
    return { context: contextSchema.parse(context), resources: notes.resources };
  }

  /** Creates and freezes one turn: its bounded context and its single input. */
  private async createTurn(run: RunRow, round: number, position: number, attempt: number, blind: boolean): Promise<HubEvent> {
    const turns = await this.turns(run.id), seq = (turns.at(-1)?.seq ?? 0) + 1;
    const turnId = `gdt_${digest([run.id, round, position, attempt]).slice(0, 32)}`;
    const { context, resources } = await this.turnContext(run, round, position, attempt, blind, turnId, turns);
    const { self, participants } = context;
    const label = `【${MODE_LABEL[run.mode]} · ${blind ? "独立作答" : `第 ${round}/${run.max_rounds} 轮`} · ${position + 1}/${participants.length}】`;
    const input = await this.store.insertDiscussionInputInTransaction({ userId: run.created_by, conversationId: run.conversation_id, clientMsgId: `gdin_${turnId.slice(4)}`,
      botId: self.botId, text: `${label}请 ${self.name} ${attempt > 1 ? "重新" : ""}发言。`, replyTo: run.topic_message_id, resources,
      // Clients render and gate this input from the marker, never from its text.
      marker: { runId: run.id, role: "input", mode: run.mode, turnId, botId: self.botId, round, maxRounds: run.max_rounds, position, participants: participants.length, attempt, blind } });
    await this.db.run(`INSERT INTO group_discussion_turns(id,discussion_id,seq,round,position,attempt,bot_id,blind,input_message_id,context_json,state,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'active',?)`, [turnId, run.id, seq, round, position, attempt, self.botId, Number(blind), input.message.id, JSON.stringify(contextSchema.parse(context)), Date.now()]);
    return input.event;
  }
  /** Caller owns the resume/retry transaction, serialized with queue claims.
   * Refresh a held input in place: no duplicate delivery, changed attempt, or
   * half-updated context/resources can reach a worker already holding it. */
  private async refreshHeldTurns(run: RunRow, held: TurnRow[], work: Work): Promise<void> {
    if (!held.length) return;
    const turns = await this.turns(run.id);
    for (const turn of held) {
      if (turn.state !== "active" || !await this.db.get("SELECT 1 FROM deliveries WHERE message_id=? AND bot_id=? AND status='pending' AND dispatched=0", [turn.input_message_id, turn.bot_id])) continue;
      const { context, resources } = await this.turnContext(run, turn.round, turn.position, turn.attempt, !!turn.blind, turn.id, turns);
      const message = await this.store.queuedMessageInTransaction(turn.input_message_id);
      const blocks = [...message.blocks.filter(block => block.type === "text"), ...resources];
      if (JSON.stringify(blocks) !== JSON.stringify(message.blocks)) work.events.push(await this.store.updateQueuedMessageInTransaction({ ...message, blocks, version: message.version + 1 }));
      await this.db.run("UPDATE group_discussion_turns SET context_json=? WHERE id=?", [JSON.stringify(context), turn.id]);
    }
  }
  /** Unmentioned user messages written in the run's own conversation during
   * the run are its notes, oldest first. They are never delivered as ordinary
   * input; they reach the turns created after them (first-round answers that
   * have already started cannot change). Topics are separate conversations;
   * deleted messages and any run's topic are excluded. */
  private async noteRows(run: RunRow): Promise<NoteRow[]> {
    const rows = await this.db.all<NoteRow>(`SELECT m.id,m.created_at,m.blocks_json,q.blocks_json AS quoted_blocks_json,q.author_type AS quoted_author_type FROM messages m LEFT JOIN messages q ON q.id=m.reply_to AND q.conversation_id=m.conversation_id AND q.status!='deleted'
      WHERE m.conversation_id=? AND m.author_type='user' AND m.created_at>=? AND m.created_at<=? AND m.status!='deleted' AND m.mentions_json='[]'
      AND NOT EXISTS(SELECT 1 FROM group_discussions g WHERE g.topic_message_id=m.id) AND NOT EXISTS(SELECT 1 FROM group_discussion_turns t WHERE t.input_message_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=m.id) ORDER BY m.created_at,m.rowid`, [run.conversation_id, run.created_at, run.finished_at ?? Number.MAX_SAFE_INTEGER]);
    return rows.filter(row => !!this.noteText(row).text);
  }
  /** `sealed`: an independent first-round turn, which never receives a quoted
   * Bot message (it may be a member's withheld answer) or that message's files. */
  private noteText(row: NoteRow, sealed = false): { text: string; resources: Block[] } {
    const blocks = JSON.parse(row.blocks_json) as Block[];
    const withheld = sealed && !!row.quoted_blocks_json && row.quoted_author_type !== "user";
    const quote = row.quoted_blocks_json && !withheld ? JSON.parse(row.quoted_blocks_json) as Block[] : [];
    const resources = [...blocks, ...quote].filter(block => ["file", "image", "audio"].includes(block.type) && "attachmentId" in block);
    const text = blocks.map(block => block.type === "text" ? block.text : block.type === "file" ? `[${block.name}]` : block.type === "image" ? `[${block.title ?? "image"}]` : block.type === "audio" ? `[${block.name ?? "audio"}]` : "").filter(Boolean).join("\n");
    const quoted = quote.filter(block => block.type === "text").map(block => block.text).join("\n");
    return { text: text + (quoted ? `\n[Quoted reference]\n${quoted}` : withheld ? "\n[Quoted member reply withheld in the independent first round]" : ""), resources };
  }
  /** Notes a turn has given its Bot, cumulatively. Contexts frozen before note
   * tracking gave every turn the notes written before it. */
  private noteIdsOf(turn: TurnRow, rows: NoteRow[]): Set<string> {
    const context = contextSchema.safeParse(JSON.parse(turn.context_json));
    if (context.success && context.data.noteIds) return new Set(context.data.noteIds);
    // The earlier scheduler never gave first-round turns any note.
    return new Set(turn.blind ? [] : rows.filter(row => row.created_at < turn.created_at).map(row => row.id));
  }
  /** The notes this Bot has not received through its last successful turn,
   * oldest first. What does not fit is carried to its next turn, announced by
   * the last entry, rather than dropped. */
  private async notesFor(run: RunRow, previous: TurnRow | undefined, sealed: boolean): Promise<{ texts: string[]; resources: Block[]; ids: string[] }> {
    const rows = await this.noteRows(run);
    const given = previous ? this.noteIdsOf(previous, rows) : new Set<string>();
    const unseen = rows.filter(row => !given.has(row.id));
    const taken = unseen.length > NOTE_ENTRIES ? unseen.slice(0, NOTE_ENTRIES - 1) : unseen;
    const resources = new Map<string, Block>();
    const texts = taken.map(row => {
      const note = this.noteText(row, sealed);
      for (const block of note.resources) if ("attachmentId" in block) resources.set(block.attachmentId, block);
      return clip(note.text, NOTE_CHARS).text;
    });
    if (unseen.length > taken.length) texts.push(`[${unseen.length - taken.length} more user note(s) will be provided in a later turn.]`);
    return { texts, resources: [...resources.values()].slice(-16), ids: [...given, ...taken.map(row => row.id)] };
  }

  private async viewInTransaction(userId: string, conversationId: string, runId: string): Promise<GroupDiscussionView> {
    const conversation = await this.store.conversationInTransaction(conversationId);
    const settings = await this.store.groupSettingsInTransaction(conversation.parentId ?? conversation.id);
    const row = await this.db.get<RunRow>("SELECT * FROM group_discussions WHERE id=?", [runId]);
    if (!row) throw new HubError("group_discussion_not_found", 404);
    return { settings, run: await this.runView(row, userId) };
  }
  private async runView(run: RunRow, userId: string, brief = false): Promise<GroupDiscussionRun> {
    const participants = participantsSchema.parse(JSON.parse(run.participants_json)), left = new Set(z.array(z.string()).parse(JSON.parse(run.left_json)));
    const turns = await this.turns(run.id);
    const topic = await this.store.queuedMessageInTransaction(run.topic_message_id);
    const steps: GroupDiscussionStep[] = [];
    for (const turn of turns) {
      const stance = stanceOf(turn);
      let attention: GroupDiscussionStep["attention"];
      let dispatched: boolean | undefined;
      if (turn.state === "active") {
        attention = await this.classifyRead(turn);
        dispatched = !!(await this.db.get<{ dispatched: number }>("SELECT dispatched FROM deliveries WHERE message_id=? AND bot_id=?", [turn.input_message_id, turn.bot_id]))?.dispatched;
      }
      const result = turn.state === "settled" ? turn.result ?? undefined : undefined;
      const status: GroupDiscussionStep["status"] = turn.state === "active" ? turn.started ? "running" : "queued"
        : SUCCESS.has(result!) ? "completed" : result === "interrupted" ? "interrupted" : result === "stopped" || result === "cancelled" ? "cancelled" : "failed";
      const shown = turn.state === "settled" && SUCCESS.has(result!) && turn.report_text ? clip(turn.report_text, brief ? BRIEF_STEP_CHARS : GROUP_DISCUSSION_TEXT_LIMIT) : undefined;
      steps.push({ id: turn.id, botId: turn.bot_id, round: turn.round, phase: "opinion", status,
        ...(shown !== undefined ? { text: shown.text, ...(brief && shown.truncated ? { textTruncated: true } : {}) } : {}),
        ...(turn.state === "settled" && SUCCESS.has(result!) ? { vote: stance?.stance === "agree" && stance.proposalId === seenProposal(turn) ? "agree" as const : stance?.stance === "disagree" ? "disagree" as const : "unconfirmed" as const } : {}),
        ...(result && !SUCCESS.has(result) ? { error: result } : {}),
        inputMessageId: turn.input_message_id, position: turn.position, attempt: turn.attempt, blind: !!turn.blind,
        ...(dispatched !== undefined ? { dispatched } : {}),
        ...(result ? { result } : {}),
        ...(stance && turn.state === "settled" && SUCCESS.has(result!) ? { stance: { kind: stance.stance, ...(stance.proposalId ? { proposalId: stance.proposalId } : {}), ...(stance.summary ? { summary: stance.summary } : {}) } } : {}),
        ...(attention ? { attention } : {}), startedAt: turn.created_at, ...(turn.settled_at ? { finishedAt: turn.settled_at } : {}) });
    }
    const active = turns.filter(turn => turn.state === "active").map(turn => turn.bot_id);
    const proposal = this.proposal(run);
    const actions: GroupDiscussionAction[] = [];
    const plan = await this.retryPlan(run, turns);
    const retryable = !!plan.failed && plan.failed.result !== "unavailable" && plan.retry.length > 0 && turns.length + plan.retry.length <= GROUP_DISCUSSION_MAX_STEPS;
    if (await this.canControl(run, userId) && !TERMINAL.has(run.status)) {
      if (run.status === "running") actions.push("pause");
      if (run.status === "pausing" && run.pause_reason === "user" || run.status === "paused" && !this.blindUnanswered(run, turns)) actions.push("resume");
      if (retryable) actions.push("retry");
      if (run.status !== "ending") actions.push("end");
    }
    const notes = await this.noteView(run, turns, userId);
    let next: GroupDiscussionRun["next"];
    const held = ["paused", "pausing"].includes(run.status)
      ? steps.find(step => (step.status === "queued" || step.status === "running") && step.dispatched === false && !left.has(step.botId)) : undefined;
    if (held && await this.participantAvailable(run, held.botId)) next = { botId: held.botId, round: held.round, position: held.position! };
    else if (!TERMINAL.has(run.status) && turns.length < GROUP_DISCUSSION_MAX_STEPS) {
      const available = new Set<string>();
      for (const participant of participants) if (!left.has(participant.botId) && await this.participantAvailable(run, participant.botId)) available.add(participant.botId);
      const slot = available.size >= GROUP_DISCUSSION_MIN_MEMBERS ? this.slotAfter(run, turns, available) : undefined;
      if (slot) next = { botId: participants[slot.position]!.botId, ...slot };
    }
    const topicText = topic.blocks.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
    return {
      id: run.id, conversationId: run.conversation_id, revision: `r${run.revision}`, mode: run.mode, topic: clip(topicText, GROUP_DISCUSSION_TEXT_LIMIT).text,
      status: run.status, phase: TERMINAL.has(run.status) ? "finished" : "opinion", round: Math.max(1, run.round), maxRounds: run.max_rounds,
      participants: participants.map(participant => ({ ...participant, ...(left.has(participant.botId) ? { active: false } : {}) })),
      ...(active.length ? { currentBotId: active[0], currentBotIds: active } : {}), steps: steps.slice(-GROUP_DISCUSSION_MAX_STEPS),
      ...(run.outcome ? { outcome: run.outcome } : {}), ...(run.conclusion ? { conclusion: run.conclusion } : {}),
      ...(run.pause_reason && run.pause_reason !== "user" ? { error: run.pause_reason } : {}),
      createdAt: run.created_at, ...(run.finished_at ? { finishedAt: run.finished_at } : {}),
      groupId: run.group_id, topicMessageId: run.topic_message_id, createdBy: run.created_by, stage: run.stage,
      ...(run.pause_reason ? { pauseReason: run.pause_reason } : {}),
      ...(proposal ? { proposal: { id: proposal.id, botId: proposal.botId, text: proposal.text } } : {}), actions,
      // Structured evidence for consensus/different views, rendered by clients.
      positions: await this.positionView(run, turns, participants, proposal),
      ...(brief ? { brief: true } : {}),
      ...notes, ...(next ? { next } : {}),
      ...(retryable ? { retryTargets: plan.retry.map(turn => ({ stepId: turn.id, botId: turn.bot_id, round: turn.round, position: turn.position })) } : {}),
    };
  }
  /** The reader's view of this run's notes: their own history deletions are
   * honoured. Unseen = not frozen into any live or successful turn (at a
   * terminal run: never received by any Bot). */
  private async noteView(run: RunRow, turns: TurnRow[], userId: string): Promise<Pick<GroupDiscussionRun, "noteCount" | "latestNote" | "unseenNoteCount" | "unseenNotes">> {
    const all = await this.noteRows(run);
    const hidden = new Set((await this.db.all<{ message_id: string }>("SELECT message_id FROM message_deletions WHERE user_id=? AND message_id IN (SELECT value FROM json_each(?))", [userId, JSON.stringify(all.map(row => row.id))])).map(row => row.message_id));
    const rows = all.filter(row => !hidden.has(row.id)), covered = new Set<string>();
    for (const turn of turns) if (turn.state === "active" || SUCCESS.has(turn.result!)) for (const id of this.noteIdsOf(turn, all)) covered.add(id);
    const unseen = rows.filter(row => !covered.has(row.id)), latest = rows.at(-1);
    return { noteCount: rows.length, ...(latest ? { latestNote: { messageId: latest.id, text: clip(this.noteText(latest).text, NOTE_PREVIEW_CHARS).text } } : {}),
      unseenNoteCount: unseen.length, unseenNotes: unseen.slice(0, GROUP_DISCUSSION_UNSEEN_NOTE_IDS).map(row => row.id) };
  }
  private async positionView(run: RunRow, turns: TurnRow[], participants: Participant[], proposal: Proposal | undefined): Promise<NonNullable<GroupDiscussionRun["positions"]>> {
    const latest = this.positions({ ...run, stage: TERMINAL.has(run.status) ? "discussion" : run.stage }, turns);
    return participants.map(participant => {
      const position = latest.get(participant.botId), stance = position?.stance;
      return { botId: participant.botId, stance: stance?.stance ?? "none" as const, ...(stance?.proposalId ? { proposalId: stance.proposalId } : {}),
        ...(stance?.summary ? { summary: stance.summary } : {}), ...(position ? { turnId: position.turn.id } : {}),
        agreesWithProposal: !!proposal && this.agrees(position, proposal) };
    });
  }
  /** Read-only attention hint for a live turn (approval/question waiting). */
  private async classifyRead(turn: TurnRow): Promise<GroupDiscussionStep["attention"]> {
    return (await this.replies(turn)).attention;
  }
}
