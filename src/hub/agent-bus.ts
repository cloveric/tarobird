import { createHash } from "node:crypto";
import { z } from "zod";
import type { Block, CardElement, Conversation, HubEvent } from "../client-protocol/index.js";
import {
  AGENT_BUS_STAGE_EXTRA, AGENT_BUS_STAGE_LIMIT, agentBusConfigSchema, agentBusCreateSchema, agentBusDeleteSchema,
  agentBusEventSchema, agentBusModeSchema, agentBusMemberSchema, agentBusStageRecordSchema, agentBusStartSchema, agentBusStopSchema, agentBusUpdateSchema,
  type AgentBusConfig, type AgentBusDetail, type AgentBusDispatch, type AgentBusMember, type AgentBusRun,
  type AgentBusRunStatus, type AgentBusRunSummary, type AgentBusStage, type AgentBusStageStatus, type AgentBusWorkspace,
} from "../client-protocol/agent-bus.js";
import { nativeRun } from "../client-protocol/run.js";
import { describeBusFailure } from "../bus/error-presentation.js";
import { HubError, newId, type HubStore, type TransactionGuard } from "./store.js";

const WORKSPACE_LIMIT = 64;
const RUN_RETENTION = 50;
const DETAIL_RUNS = 20;
const ACTIVE = ["queued", "running", "stopping"] as const;
const ACTIVE_SQL = "('queued','running','stopping')";

// Persisted and returned shapes are both strict: a workspace never stores an
// unresolved member, and a run snapshot is exactly what its stages may use.
const memberSchema = agentBusMemberSchema.extend({ conversationId: z.string() });
const storedSchema = z.object({
  name: z.string(), mode: agentBusModeSchema, coordinator: memberSchema, members: z.array(memberSchema),
  maxResearchQuestions: z.number().int(), maxRevisionRounds: z.number().int(),
}).strict();
type Stored = z.infer<typeof storedSchema>;
type WorkspaceRow = { id: string; owner_id: string; revision: string; config_json: string; created_at: number; updated_at: number };
type RunRow = { id: string; workspace_id: string; owner_id: string; coordinator_id: string; conversation_id: string; message_id: string; snapshot_json: string; text: string; status: AgentBusRunStatus; error: string | null; stop_requested: number; created_at: number; started_at: number | null; finished_at: number | null };
type StageRow = { run_id: string; id: string; bot_id: string; conversation_id: string; status: AgentBusStageStatus; message_id: string | null; started_at: number; finished_at: number | null; error: string | null; seq: number };

export interface AgentBusHooks {
  /** `undefined` while the Bot has no attached worker. */
  workerCapable(botId: string): boolean | undefined;
  stop(botId: string, params: { runId: string; messageId: string }): Promise<unknown>;
  /** New or automatically renamed records; called only after commit. */
  conversationsCreated(userId: string, conversations: Conversation[]): void;
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const dedicatedAction = (identity: unknown[]) => `agentbus_${digest(identity).slice(0, 40)}`;
const dedicatedTitle = (config: Pick<Stored, "name" | "mode">, slot: number, botName: string) => {
  const role = slot < 0 ? "发起者" : config.mode === "crew" ? ["研究员", "分析员", "撰写者", "审阅者"][slot]
    : config.mode === "chain" ? `步骤 ${slot + 1}` : config.mode === "verify" ? "复核者" : `成员 ${slot + 1}`;
  return `${config.name} · ${role} · ${botName}`.slice(0, 256);
};
const terminal = (status: string) => !(ACTIVE as readonly string[]).includes(status);
const MODE_LABEL: Record<Stored["mode"], string> = { ask: "单人委托", fan: "并行询问", chain: "串联步骤", verify: "回答后复核", crew: "研究团队" };

/** Owner-defined, same-host Bus workspaces. Execution stays in the existing
 * delegation/crew commands and Bus transport; the Hub only queues the input,
 * accepts stage observations from that run's own coordinator delivery and
 * publishes them to the conversations fixed by the run snapshot. */
export class HubAgentBuses {
  constructor(private readonly store: HubStore, private readonly hooks: AgentBusHooks) {}
  private get db() { return this.store.db; }

  list(userId: string, validate?: TransactionGuard): Promise<AgentBusWorkspace[]> {
    return this.transaction(validate, async () => {
      await this.store.requireOwner(userId);
      const events = await this.settleInTransaction("r.owner_id=?", [userId]);
      const rows = await this.db.all<WorkspaceRow>("SELECT * FROM agent_buses WHERE owner_id=? ORDER BY created_at,id", [userId]);
      return { value: await Promise.all(rows.map(row => this.workspace(row))), events };
    });
  }
  detail(userId: string, id: string, validate?: TransactionGuard): Promise<AgentBusDetail> {
    return this.transaction(validate, async () => {
      await this.store.requireOwner(userId);
      const events = await this.settleInTransaction("r.workspace_id=?", [id]);
      const row = await this.row(userId, id);
      const runs = await this.db.all<RunRow>("SELECT * FROM agent_bus_runs WHERE workspace_id=? ORDER BY created_at DESC,id DESC LIMIT ?", [id, DETAIL_RUNS]);
      return { value: { workspace: await this.workspace(row), runs: await Promise.all(runs.map(run => this.run(run))) }, events };
    });
  }
  async create(userId: string, raw: unknown, validate?: TransactionGuard): Promise<AgentBusWorkspace> {
    const input = agentBusCreateSchema.parse(raw);
    const id = `ab_${digest([userId, input.requestId]).slice(0, 32)}`, payload = digest(["create", input.config]);
    let created: Conversation[] = [];
    const result = await this.transaction(validate, async () => {
      await this.store.requireOwner(userId);
      if (await this.replayed(userId, input.requestId, "create", payload)) return { value: await this.workspace(await this.row(userId, id, "agent_bus_deleted")), events: [] };
      const count = await this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_buses WHERE owner_id=?", [userId]);
      if ((count?.count ?? 0) >= WORKSPACE_LIMIT) throw new HubError("agent_bus_limit", 409);
      const resolved = await this.resolve(userId, id, input.config);
      created = resolved.created;
      const now = Date.now(), row: WorkspaceRow = { id, owner_id: userId, revision: newId("rev"), config_json: JSON.stringify(resolved.stored), created_at: now, updated_at: now };
      await this.db.run("INSERT INTO agent_buses VALUES(?,?,?,?,?,?)", [row.id, row.owner_id, row.revision, row.config_json, row.created_at, row.updated_at]);
      await this.remember(userId, input.requestId, "create", payload, id);
      return { value: await this.workspace(row), events: [] };
    });
    if (created.length) this.hooks.conversationsCreated(userId, created);
    return result;
  }
  async update(userId: string, id: string, raw: unknown, validate?: TransactionGuard): Promise<AgentBusWorkspace> {
    const input = agentBusUpdateSchema.parse(raw);
    let created: Conversation[] = [];
    const result = await this.transaction(validate, async () => {
      await this.store.requireOwner(userId);
      const events = await this.settleInTransaction("r.workspace_id=?", [id]);
      const row = await this.row(userId, id);
      if (row.revision !== input.revision) throw new HubError("agent_bus_conflict", 409);
      // The definition shown beside a live run is the one it executes.
      if (await this.db.get(`SELECT 1 FROM agent_bus_runs WHERE workspace_id=? AND status IN ${ACTIVE_SQL}`, [id])) throw new HubError("agent_bus_busy", 409);
      const resolved = await this.resolve(userId, id, input.config, storedSchema.parse(JSON.parse(row.config_json)));
      created = resolved.created;
      const next = { ...row, revision: newId("rev"), config_json: JSON.stringify(resolved.stored), updated_at: Date.now() };
      await this.db.run("UPDATE agent_buses SET revision=?,config_json=?,updated_at=? WHERE id=?", [next.revision, next.config_json, next.updated_at, id]);
      return { value: await this.workspace(next), events };
    });
    if (created.length) this.hooks.conversationsCreated(userId, created);
    return result;
  }
  /** Deletes only the definition and its run records. Conversations and their
   * messages remain ordinary history. */
  remove(userId: string, id: string, raw: unknown, validate?: TransactionGuard): Promise<{ ok: true }> {
    const input = agentBusDeleteSchema.parse(raw);
    return this.transaction(validate, async () => {
      await this.store.requireOwner(userId);
      const events = await this.settleInTransaction("r.workspace_id=?", [id]);
      const row = await this.row(userId, id);
      if (row.revision !== input.revision) throw new HubError("agent_bus_conflict", 409);
      if (await this.db.get(`SELECT 1 FROM agent_bus_runs WHERE workspace_id=? AND status IN ${ACTIVE_SQL}`, [id])) throw new HubError("agent_bus_busy", 409);
      await this.db.run("DELETE FROM agent_bus_stages WHERE run_id IN (SELECT id FROM agent_bus_runs WHERE workspace_id=?)", [id]);
      await this.db.run("DELETE FROM agent_bus_runs WHERE workspace_id=?", [id]);
      await this.db.run("DELETE FROM agent_buses WHERE id=?", [id]);
      return { value: { ok: true as const }, events };
    });
  }
  /** Enqueues one owner message in the coordinator conversation through the
   * ordinary durable queue. The run record commits in the same transaction. */
  async start(userId: string, id: string, raw: unknown, validate?: TransactionGuard): Promise<AgentBusRun> {
    const input = agentBusStartSchema.parse(raw);
    const runId = `abr_${digest([userId, input.requestId]).slice(0, 32)}`, payload = digest(["run", id, input.revision, input.text]);
    return this.transaction(validate, async () => {
      await this.store.requireOwner(userId);
      if (await this.replayed(userId, input.requestId, "run", payload)) return { value: await this.run(await this.runRow(userId, id, runId)), events: [] };
      const events = await this.settleInTransaction("r.workspace_id=?", [id]);
      const row = await this.row(userId, id);
      if (row.revision !== input.revision) throw new HubError("agent_bus_conflict", 409);
      if (await this.db.get(`SELECT 1 FROM agent_bus_runs WHERE workspace_id=? AND status IN ${ACTIVE_SQL}`, [id])) throw new HubError("agent_bus_busy", 409);
      const snapshot = storedSchema.parse(JSON.parse(row.config_json));
      for (const member of [snapshot.coordinator, ...snapshot.members]) await this.checkParticipant(userId, member);
      // An older worker would strip the run marker and answer the prompt as chat.
      if (this.hooks.workerCapable(snapshot.coordinator.botId) === false) throw new HubError("agent_bus_worker_update_required", 409);
      const sent = await this.store.sendMessageInTransaction(userId, { conversationId: snapshot.coordinator.conversationId, clientMsgId: `agentbus_${runId}`,
        text: input.text, attachments: [], mentions: [snapshot.coordinator.botId], previewUrl: null });
      if (sent.duplicate) throw new HubError("idempotency_conflict", 409);
      const now = Date.now();
      await this.db.run("INSERT INTO agent_bus_runs(id,workspace_id,owner_id,coordinator_id,conversation_id,message_id,snapshot_json,text,status,created_at) VALUES(?,?,?,?,?,?,?,?,'queued',?)",
        [runId, id, userId, snapshot.coordinator.botId, snapshot.coordinator.conversationId, sent.message.id, JSON.stringify(snapshot), input.text, now]);
      await this.remember(userId, input.requestId, "run", payload, runId);
      await this.prune(id);
      return { value: await this.run(await this.runRow(userId, id, runId)), events: [...events, ...(sent.event ? [sent.event] : [])] };
    });
  }
  async stop(userId: string, id: string, runId: string, raw: unknown, validate?: TransactionGuard): Promise<AgentBusRun> {
    const input = agentBusStopSchema.parse(raw), payload = digest(input.abandon ? ["stop", id, runId, "abandon"] : ["stop", id, runId]);
    let notify: { botId: string; runId: string; messageId: string } | undefined;
    const result = await this.transaction(validate, async () => {
      await this.store.requireOwner(userId);
      const replay = await this.replayed(userId, input.requestId, "stop", payload);
      const events = await this.settleInTransaction("r.id=?", [runId]);
      const run = await this.runRow(userId, id, runId);
      if (replay || terminal(run.status)) {
        if (!replay) await this.remember(userId, input.requestId, "stop", payload, runId);
        return { value: await this.run(run), events };
      }
      const delivery = await this.db.get<{ status: string; dispatched: number }>("SELECT status,dispatched FROM deliveries WHERE message_id=? AND bot_id=?", [run.message_id, run.coordinator_id]);
      if (input.abandon) {
        // Losing the connection cannot prove execution stopped. Only a new,
        // explicit owner operation may release this wait after a stop request;
        // retain the stop fence and label the result unconfirmed/interrupted.
        if (run.status !== "stopping" || !run.stop_requested || this.hooks.workerCapable(run.coordinator_id) !== undefined)
          throw new HubError("agent_bus_abandon_unavailable", 409);
        await this.db.run("UPDATE deliveries SET status='failed' WHERE message_id=? AND bot_id=? AND status='pending'", [run.message_id, run.coordinator_id]);
        events.push(...await this.finish(run, "interrupted", "agent_bus_wait_abandoned", "agent_bus_wait_abandoned"));
        events.push(await this.store.queueEventInTransaction(run.conversation_id, run.coordinator_id));
        await this.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), userId, "agent_bus.wait_abandoned", JSON.stringify({ runId, workspaceId: id, coordinatorId: run.coordinator_id })]);
      } else if (delivery?.status === "pending" && !delivery.dispatched) {
        // Not yet handed to a worker: the same transaction claim uses decides it.
        await this.db.run("UPDATE deliveries SET status='cancelled' WHERE message_id=? AND bot_id=? AND status='pending' AND dispatched=0", [run.message_id, run.coordinator_id]);
        const message = await this.store.queuedMessageInTransaction(run.message_id);
        events.push(await this.store.updateQueuedMessageInTransaction({ ...message, version: message.version + 1, blocks: [...message.blocks,
          { type: "card", elements: [{ type: "markdown", text: "Agent Bus 任务已在开始前取消，未发送给 Bot。" }], extra: { promptQueue: { state: "cancelled", botId: run.coordinator_id } } }] }));
        events.push(await this.store.queueEventInTransaction(run.conversation_id, run.coordinator_id));
        events.push(...await this.finish(run, "cancelled", null));
      } else {
        await this.db.run("UPDATE agent_bus_runs SET stop_requested=1,status='stopping' WHERE id=?", [run.id]);
        notify = { botId: run.coordinator_id, runId: run.id, messageId: run.message_id };
      }
      await this.remember(userId, input.requestId, "stop", payload, runId);
      return { value: await this.run(await this.runRow(userId, id, runId)), events };
    });
    // The durable stop flag also reaches a worker that is offline or has not
    // received the input yet; this call only shortens a live run.
    if (notify) void this.hooks.stop(notify.botId, { runId: notify.runId, messageId: notify.messageId }).catch(() => undefined);
    return result;
  }
  /** A deliberately abandoned delivery is no longer replayed. On worker
   * reattachment, retry only its stop fence, never the original input. */
  abandonedStops(botId: string, now = Date.now()): Promise<{ runId: string; messageId: string }[]> {
    return this.db.serial(() => this.db.all<{ runId: string; messageId: string }>(
      "SELECT id AS runId,message_id AS messageId FROM agent_bus_runs WHERE coordinator_id=? AND status='interrupted' AND error='agent_bus_wait_abandoned' AND stop_requested=1 AND finished_at>=? ORDER BY finished_at DESC,id DESC LIMIT 256",
      [botId, now - 24 * 60 * 60_000]));
  }
  /** Run marker for one dispatched input, read by the Hub dispatcher. */
  dispatch(botId: string, messageId: string): Promise<AgentBusDispatch | undefined> {
    return this.db.serial(async () => {
      const run = await this.db.get<RunRow>("SELECT * FROM agent_bus_runs WHERE message_id=? AND coordinator_id=?", [messageId, botId]);
      if (!run) return undefined;
      const snapshot = storedSchema.parse(JSON.parse(run.snapshot_json));
      return { runId: run.id, workspaceId: run.workspace_id, mode: snapshot.mode, members: snapshot.members.map(member => member.botId),
        coordinatorConversationId: snapshot.coordinator.conversationId, conversations: snapshot.members.map(member => member.conversationId),
        ...(snapshot.members.some(member => member.instruction) ? { instructions: snapshot.members.map(member => member.instruction ?? "") } : {}),
        ...(snapshot.coordinator.instruction ? { coordinatorInstruction: snapshot.coordinator.instruction } : {}),
        maxResearchQuestions: snapshot.maxResearchQuestions, maxRevisionRounds: snapshot.maxRevisionRounds, ...(run.stop_requested ? { stopRequested: true } : {}) };
    });
  }
  /** Observation from the coordinator worker executing this run's own input.
   * Replays after settlement are ignored; nothing here selects a destination. */
  async event(botId: string, raw: unknown): Promise<void> {
    const event = agentBusEventSchema.parse(raw);
    const events = await this.db.transaction(async () => {
      const run = await this.db.get<RunRow>("SELECT * FROM agent_bus_runs WHERE id=? AND message_id=? AND coordinator_id=?", [event.runId, event.messageId, botId]);
      if (!run) throw new HubError("agent_bus_run_forbidden", 403);
      if (terminal(run.status)) return [];
      const delivery = await this.db.get<{ status: string; dispatched: number }>("SELECT status,dispatched FROM deliveries WHERE message_id=? AND bot_id=?", [run.message_id, botId]);
      if (delivery?.status !== "pending" || !delivery.dispatched) return [];
      const snapshot = storedSchema.parse(JSON.parse(run.snapshot_json));
      const events: HubEvent[] = [];
      const now = Date.now();
      if (run.status === "queued") await this.db.run("UPDATE agent_bus_runs SET status='running',started_at=? WHERE id=?", [now, run.id]);
      if (event.type === "run.started") return events;
      if (event.type === "run.finished") {
        const status = run.stop_requested && event.status !== "completed" ? "cancelled" : event.status;
        return this.finish(run, status, status === "failed" ? event.error ?? "agent_bus_failed" : null, "agent_bus_stage_unfinished");
      }
      const matches = [snapshot.coordinator, ...snapshot.members].filter(member => member.botId === event.botId && (!event.conversationId || member.conversationId === event.conversationId));
      const participant = matches.length === 1 ? matches[0] : undefined;
      if (!participant) throw new HubError("agent_bus_stage_forbidden", 403);
      let stage = await this.db.get<StageRow>("SELECT * FROM agent_bus_stages WHERE run_id=? AND id=?", [run.id, event.stageId]);
      if (stage && (stage.bot_id !== event.botId || stage.conversation_id !== participant.conversationId)) throw new HubError("agent_bus_stage_forbidden", 403);
      if (!stage) {
        const count = await this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_bus_stages WHERE run_id=?", [run.id]);
        if ((count?.count ?? 0) >= AGENT_BUS_STAGE_LIMIT) throw new HubError("agent_bus_stage_limit", 409);
        const seq = (count?.count ?? 0) + 1;
        // Coordinator work already appears in the run's own conversation.
        const record = participant === snapshot.coordinator ? undefined
          : await this.publishRecord(run, snapshot, participant, event.stageId, seq, "running", event.type === "stage.started" ? event.prompt : "");
        if (record?.event) events.push(record.event);
        stage = { run_id: run.id, id: event.stageId, bot_id: event.botId, conversation_id: participant.conversationId, status: "running", message_id: record?.message.id ?? null, started_at: now, finished_at: null, error: null, seq };
        await this.db.run("INSERT INTO agent_bus_stages VALUES(?,?,?,?,?,?,?,?,?,?)", [stage.run_id, stage.id, stage.bot_id, stage.conversation_id, stage.status, stage.message_id, stage.started_at, null, null, stage.seq]);
      }
      if (event.type === "stage.finished" && stage.status === "running") events.push(...await this.closeStage(run, snapshot, stage, event.status, event.error ?? null, event.text));
      return events;
    });
    this.store.emitCommitted(events);
  }
  /** Caller holds the queue claim transaction. A worker without the run
   * capability never receives a run input: it would drop the marker and answer
   * the prompt as chat. Such inputs fail here, once; other messages continue. */
  async rejectForWorkerInTransaction(botId: string, messageIds: string[]): Promise<HubEvent[]> {
    const events: HubEvent[] = [];
    for (const messageId of messageIds) {
      const run = await this.db.get<RunRow>("SELECT * FROM agent_bus_runs WHERE message_id=? AND coordinator_id=?", [messageId, botId]);
      const delivery = await this.db.get<{ status: string; dispatched: number }>("SELECT status,dispatched FROM deliveries WHERE message_id=? AND bot_id=?", [messageId, botId]);
      if (!run || delivery?.status !== "pending") continue;
      // A dispatched input may already have partly run on a newer worker.
      await this.db.run("UPDATE deliveries SET status=? WHERE message_id=? AND bot_id=? AND status='pending'", [delivery.dispatched ? "failed" : "cancelled", messageId, botId]);
      const message = await this.store.queuedMessageInTransaction(messageId);
      events.push(await this.store.updateQueuedMessageInTransaction({ ...message, version: message.version + 1, blocks: [...message.blocks, { type: "card",
        elements: [{ type: "markdown", text: "发起 Bot 的运行环境尚不支持 Agent Bus，这项任务没有作为普通消息执行。请更新该 Bot 后重新启动。" }],
        ...(delivery.dispatched ? {} : { extra: { promptQueue: { state: "cancelled", botId } } }) }] }));
      events.push(await this.store.queueEventInTransaction(run.conversation_id, botId));
      if (!terminal(run.status)) events.push(...await this.finish(run, delivery.dispatched ? "interrupted" : "failed", "agent_bus_worker_update_required"));
    }
    return events;
  }
  /** After a coordinator delivery is acknowledged, failed or cancelled. A run
   * without its own terminal report is interrupted, never assumed complete. */
  async settleDelivery(botId: string, messageId: string): Promise<void> {
    const events = await this.db.transaction(() => this.settleInTransaction("r.message_id=? AND r.coordinator_id=?", [messageId, botId]));
    this.store.emitCommitted(events);
  }
  async reconcile(): Promise<void> {
    const events = await this.db.transaction(() => this.settleInTransaction("1", []));
    this.store.emitCommitted(events);
  }
  /** A deleted coordinator can neither report nor finish its runs. Settle them
   * now, with the same outcome a later Bus read would record, and notify. */
  async settleCoordinator(botId: string): Promise<void> {
    const events = await this.db.transaction(() => this.settleInTransaction("r.coordinator_id=?", [botId]));
    this.store.emitCommitted(events);
  }

  private async transaction<T>(validate: TransactionGuard | undefined, operation: () => Promise<{ value: T; events: HubEvent[] }>): Promise<T> {
    const result = await this.db.transaction(async () => { await validate?.(); return operation(); });
    this.store.emitCommitted(result.events);
    return result.value;
  }
  private async row(userId: string, id: string, missing = "agent_bus_not_found"): Promise<WorkspaceRow> {
    const row = await this.db.get<WorkspaceRow>("SELECT * FROM agent_buses WHERE id=? AND owner_id=?", [id, userId]);
    if (!row) throw new HubError(missing, missing === "agent_bus_deleted" ? 410 : 404);
    return row;
  }
  private async runRow(userId: string, workspaceId: string, runId: string): Promise<RunRow> {
    const run = await this.db.get<RunRow>("SELECT * FROM agent_bus_runs WHERE id=? AND workspace_id=? AND owner_id=?", [runId, workspaceId, userId]);
    if (!run) throw new HubError("agent_bus_run_not_found", 404);
    return run;
  }
  private async replayed(userId: string, requestId: string, kind: string, payload: string): Promise<boolean> {
    const prior = await this.db.get<{ kind: string; payload_hash: string }>("SELECT kind,payload_hash FROM agent_bus_requests WHERE owner_id=? AND request_id=?", [userId, requestId]);
    if (prior && (prior.kind !== kind || prior.payload_hash !== payload)) throw new HubError("idempotency_conflict", 409);
    return !!prior;
  }
  private async remember(userId: string, requestId: string, kind: string, payload: string, resultId: string): Promise<void> {
    await this.db.run("INSERT INTO agent_bus_requests VALUES(?,?,?,?,?,?)", [userId, requestId, kind, payload, resultId, Date.now()]);
  }
  private async prune(workspaceId: string): Promise<void> {
    const stale = await this.db.all<{ id: string }>(`SELECT id FROM agent_bus_runs WHERE workspace_id=? AND status NOT IN ${ACTIVE_SQL} ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET ?`, [workspaceId, RUN_RETENTION]);
    for (const { id } of stale) {
      await this.db.run("DELETE FROM agent_bus_stages WHERE run_id=?", [id]);
      await this.db.run("DELETE FROM agent_bus_runs WHERE id=?", [id]);
    }
  }
  private async workspace(row: WorkspaceRow): Promise<AgentBusWorkspace> {
    const stored = storedSchema.parse(JSON.parse(row.config_json));
    const latest = await this.db.get<RunRow>("SELECT * FROM agent_bus_runs WHERE workspace_id=? ORDER BY created_at DESC,id DESC LIMIT 1", [row.id]);
    return { id: row.id, revision: row.revision, ...stored, createdAt: row.created_at, updatedAt: row.updated_at, ...(latest ? { latestRun: this.summary(latest) } : {}) };
  }
  private summary(row: RunRow): AgentBusRunSummary {
    return { ...summary(row), ...(row.status === "stopping" && row.stop_requested && this.hooks.workerCapable(row.coordinator_id) === undefined ? { canAbandon: true } : {}) };
  }
  private async run(row: RunRow): Promise<AgentBusRun> {
    const stages = await this.db.all<StageRow>("SELECT * FROM agent_bus_stages WHERE run_id=? ORDER BY seq", [row.id]);
    return { ...this.summary(row), text: row.text, snapshot: storedSchema.parse(JSON.parse(row.snapshot_json)), stages: stages.map((stage): AgentBusStage => ({ id: stage.id, botId: stage.bot_id, conversationId: stage.conversation_id, status: stage.status,
      ...(stage.message_id ? { messageId: stage.message_id } : {}), startedAt: stage.started_at, ...(stage.finished_at !== null ? { finishedAt: stage.finished_at } : {}), ...(stage.error ? { error: stage.error } : {}) })) };
  }
  /** Validates owner-managed same-host Bots and explicit conversations, and
   * idempotently creates one dedicated direct conversation per omitted binding. */
  private async resolve(userId: string, workspaceId: string, raw: AgentBusConfig, previous?: Stored): Promise<{ stored: Stored; created: Conversation[] }> {
    const config = agentBusConfigSchema.parse(raw), created: Conversation[] = [];
    const used = new Set<string>();
    const reserved = new Set([config.coordinator, ...config.members].flatMap(member => member.conversationId ? [member.conversationId] : []));
    const bind = async (member: AgentBusConfig["coordinator"], slot: number): Promise<AgentBusMember> => {
      const bot = await this.managedBot(userId, member.botId);
      const instruction = member.instruction ? { instruction: member.instruction } : {};
      if (member.conversationId) { await this.checkParticipant(userId, { botId: member.botId, conversationId: member.conversationId }); return { botId: member.botId, conversationId: member.conversationId, ...instruction }; }
      // Keep pre-v2 default chats reusable. After a reorder a slot's former
      // default may be explicitly bound elsewhere; allocate/reuse the first
      // unreserved candidate instead of merging slots or rejecting the save.
      let action = "", existed: { id: string } | undefined;
      // Retired defaults are historical records, not reusable destinations.
      // There can be more retired chats than live slots. Each occupied key is
      // distinct, so this reaches an unused key after finitely many rows.
      for (let attempt = -1; ; attempt++) {
        const identity = attempt < 0 ? [workspaceId, member.botId] : attempt === 0 ? [workspaceId, member.botId, slot] : [workspaceId, member.botId, slot, attempt];
        const candidate = dedicatedAction(identity);
        const row = await this.db.get<{ id: string }>("SELECT id FROM conversations WHERE owner_id=? AND client_action_id=?", [userId, candidate]);
        if (attempt < 0 && !row || row && (used.has(row.id) || reserved.has(row.id))) continue;
        if (row) {
          try { await this.checkParticipant(userId, { botId: member.botId, conversationId: row.id }); }
          catch (error) {
            if (error instanceof HubError && ["agent_bus_conversation_forbidden", "agent_bus_conversation_unsupported", "agent_bus_conversation_archived", "agent_bus_conversation_bot_mismatch"].includes(error.code)) continue;
            throw error;
          }
        }
        action = candidate; existed = row; break;
      }
      if (!action) throw new HubError("agent_bus_duplicate_member", 400);
      const conversation = await this.store.createConversationInTransaction(userId, [member.botId], dedicatedTitle(config, slot, bot.name), action, { type: "direct" });
      if (!existed) created.push(conversation);
      await this.checkParticipant(userId, { botId: member.botId, conversationId: conversation.id });
      return { botId: member.botId, conversationId: conversation.id, ...instruction };
    };
    const unique = (member: AgentBusMember) => {
      if (used.has(member.conversationId)) throw new HubError("agent_bus_duplicate_member", 400);
      used.add(member.conversationId); return member;
    };
    const coordinator = unique(await bind(config.coordinator, -1)), members: AgentBusMember[] = [];
    for (const [index, member] of config.members.entries()) members.push(unique(await bind(member, index)));
    if (previous) created.push(...await this.maintainTitles(userId, workspaceId, previous, config, [coordinator, ...members]));
    return { stored: { name: config.name, mode: config.mode, coordinator, members, maxResearchQuestions: config.maxResearchQuestions, maxRevisionRounds: config.maxRevisionRounds }, created };
  }
  /** A binding alone is not title ownership: it may be ordinary history or a
   * different Bus's record. Verify the creation key and the exact old title. */
  private async maintainTitles(userId: string, workspaceId: string, previous: Stored, config: AgentBusConfig, members: AgentBusMember[]): Promise<Conversation[]> {
    const oldMembers = [previous.coordinator, ...previous.members], changed: Conversation[] = [];
    const actions = new Set((await this.db.all<{ client_action_id: string }>("SELECT client_action_id FROM conversations WHERE owner_id=? AND client_action_id GLOB 'agentbus_*'", [userId])).map(row => row.client_action_id));
    const owns = (botId: string, action: string) => {
      if (action === dedicatedAction([workspaceId, botId])) return true;
      // Include original slots after reorders and replacements after retirement.
      // A missing historical key ends the proof: preserve uncertain titles.
      for (let slot = -1; slot < 11; slot++) for (let attempt = 0; ; attempt++) {
        const key = dedicatedAction(attempt ? [workspaceId, botId, slot, attempt] : [workspaceId, botId, slot]);
        if (!actions.has(key)) break;
        if (key === action) return true;
      }
      return false;
    };
    for (const [index, member] of members.entries()) {
      const oldIndex = oldMembers.findIndex(old => old.botId === member.botId && old.conversationId === member.conversationId);
      if (oldIndex < 0) continue;
      const row = await this.db.get<{ title: string; client_action_id: string | null }>("SELECT title,client_action_id FROM conversations WHERE id=?", [member.conversationId]);
      if (!row?.client_action_id || !owns(member.botId, row.client_action_id)) continue;
      const { name } = await this.managedBot(userId, member.botId);
      if (row.title !== dedicatedTitle(previous, oldIndex - 1, name) && row.title !== dedicatedTitle({ ...previous, mode: "chain" }, oldIndex - 1, name)) continue;
      const title = dedicatedTitle(config, index - 1, name);
      if (title === row.title) continue;
      await this.db.run("UPDATE conversations SET title=? WHERE id=?", [title, member.conversationId]);
      // Existing-key read preserves all fields and uses the ordinary update
      // notification hook, after the surrounding workspace transaction commits.
      changed.push(await this.store.createConversationInTransaction(userId, [member.botId], title, row.client_action_id, { type: "direct" }));
    }
    return changed;
  }
  private async managedBot(userId: string, botId: string): Promise<{ name: string }> {
    // Bus listeners exist only for Hub-managed workers of this host.
    const bot = await this.db.get<{ name: string }>("SELECT b.name FROM bots b JOIN managed_bots m ON m.bot_id=b.id WHERE b.id=? AND b.deleted_at IS NULL AND m.owner_id=?", [botId, userId]);
    if (!bot) throw new HubError("agent_bus_bot_unavailable", 409);
    return bot;
  }
  /** Each participant's record chat is a direct chat whose only Bot is that
   * participant: a member's private task must never land in a shared chat. */
  private async checkParticipant(userId: string, member: AgentBusMember): Promise<void> {
    await this.managedBot(userId, member.botId);
    const conversation = await this.db.get<{ owner_id: string; type: string; archived: number; parent_id: string | null }>("SELECT owner_id,type,archived,parent_id FROM conversations WHERE id=?", [member.conversationId]);
    if (!conversation || conversation.owner_id !== userId || !await this.db.get("SELECT 1 FROM conversation_members WHERE conversation_id=? AND member_type='user' AND member_id=?", [member.conversationId, userId]))
      throw new HubError("agent_bus_conversation_forbidden", 403);
    if (conversation.type !== "direct" || conversation.parent_id) throw new HubError("agent_bus_conversation_unsupported", 409);
    if (conversation.archived) throw new HubError("agent_bus_conversation_archived", 409);
    const bots = await this.db.all<{ member_id: string }>("SELECT member_id FROM conversation_members WHERE conversation_id=? AND member_type='bot'", [member.conversationId]);
    if (bots.length !== 1 || bots[0]!.member_id !== member.botId) throw new HubError("agent_bus_conversation_bot_mismatch", 409);
  }
  /** Rechecked at every record write: membership may change during a run. */
  private async recordWritable(member: AgentBusMember): Promise<boolean> {
    const conversation = await this.db.get<{ type: string; archived: number; parent_id: string | null }>("SELECT type,archived,parent_id FROM conversations WHERE id=?", [member.conversationId]);
    if (conversation?.type !== "direct" || conversation.archived || conversation.parent_id) return false;
    const bots = await this.db.all<{ member_id: string }>(`SELECT m.member_id FROM conversation_members m JOIN bots b ON b.id=m.member_id AND b.deleted_at IS NULL
      WHERE m.conversation_id=? AND m.member_type='bot'`, [member.conversationId]);
    const all = await this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM conversation_members WHERE conversation_id=? AND member_type='bot'", [member.conversationId]);
    return bots.length === 1 && all?.count === 1 && bots[0]!.member_id === member.botId;
  }
  private async publishRecord(run: RunRow, snapshot: Stored, member: AgentBusMember, stageId: string, seq: number, status: AgentBusStageStatus, prompt: string) {
    // An archived or no longer private conversation receives no new record;
    // the stage still reports the real execution status.
    if (!await this.recordWritable(member)) return undefined;
    const card: Block = { type: "card", title: `Agent Bus · ${snapshot.name}`, ...template(status), elements: [
      { type: "markdown", text: statusLine(snapshot, seq, status) },
      ...(member.instruction ? [{ type: "collapsible" as const, text: "本环节任务", open: member.instruction.length <= 400,
        children: [{ type: "markdown" as const, text: member.instruction }] }] : []),
      ...(prompt ? [{ type: "collapsible" as const, text: "发给此成员的任务", open: false, children: [{ type: "markdown" as const, text: prompt }] }] : []),
      { type: "collapsible", text: "关于此记录", open: false, children: [{ type: "markdown", text: RECORD_NOTE }] },
    ], extra: { [AGENT_BUS_STAGE_EXTRA]: { runId: run.id, workspaceId: run.workspace_id, stageId, status } } };
    // The streaming -> complete/error envelope drives completion notifications
    // and unread counts. Clients recognize the agentBusStage extra and keep it
    // out of the chat's own replying, queue and stop state.
    return this.store.publishBotMessageInTransaction(member.botId, { conversationId: member.conversationId, blocks: [card], status: "streaming" });
  }
  private async closeStage(run: RunRow, snapshot: Stored, stage: StageRow, status: AgentBusStageStatus, error: string | null, text?: string): Promise<HubEvent[]> {
    const now = Date.now(), events: HubEvent[] = [];
    await this.db.run("UPDATE agent_bus_stages SET status=?,finished_at=?,error=? WHERE run_id=? AND id=?", [status, now, error, stage.run_id, stage.id]);
    if (!stage.message_id) return events;
    const member = { botId: stage.bot_id, conversationId: stage.conversation_id };
    if (!await this.db.get("SELECT 1 FROM messages WHERE id=?", [stage.message_id])) return events;
    const old = await this.store.queuedMessageInTransaction(stage.message_id);
    // Never resurrect a record the owner deleted or overwrite foreign content.
    // A live mirror is one stage card; edited/native replies are not ours.
    if (old.status !== "streaming" || old.authorType !== "bot" || old.authorId !== stage.bot_id || old.conversationId !== stage.conversation_id || old.blocks.length !== 1) return events;
    const card = old.blocks[0];
    if (card?.type !== "card" || nativeRun(card)) return events;
    const marker = agentBusStageRecordSchema.safeParse(card.extra?.[AGENT_BUS_STAGE_EXTRA]);
    if (!marker.success || marker.data.runId !== run.id || marker.data.workspaceId !== run.workspace_id || marker.data.stageId !== stage.id || marker.data.status !== "running") return events;
    if (!await this.recordWritable(member)) {
      // Admission can change after this record was published. Close only the
      // existing lifecycle, with no new result/error or completion push. The
      // transaction holds the record identity check and this update together;
      // no publish/admission path can create a message or enqueue Bot work.
      const { template: _runningTemplate, ...closedCard } = card;
      events.push(await this.store.updateQueuedMessageInTransaction({ ...old, version: old.version + 1,
        status: status === "failed" ? "error" : "complete", blocks: [{ ...closedCard, ...template(status),
          elements: [{ type: "markdown", text: statusLine(snapshot, stage.seq, status) }, ...card.elements.slice(1)],
          extra: { ...card.extra, [AGENT_BUS_STAGE_EXTRA]: { ...marker.data, status } } }] }));
      return events;
    }
    const elements: CardElement[] = [{ type: "markdown", text: statusLine(snapshot, stage.seq, status, error) }, ...(card?.elements.filter(element => element.type === "collapsible") ?? [])];
    const blocks: Block[] = [{ type: "card", title: card?.title ?? `Agent Bus · ${snapshot.name}`, ...template(status), elements,
      extra: { [AGENT_BUS_STAGE_EXTRA]: { runId: run.id, workspaceId: run.workspace_id, stageId: stage.id, status } } }, ...(text?.trim() ? [{ type: "text" as const, text }] : [])];
    const published = await this.store.publishBotMessageInTransaction(stage.bot_id, { id: stage.message_id, conversationId: stage.conversation_id, blocks, status: status === "failed" ? "error" : "complete" });
    if (published.event) events.push(published.event);
    return events;
  }
  private async finish(run: RunRow, status: AgentBusRunStatus, error: string | null, unfinished = "agent_bus_interrupted"): Promise<HubEvent[]> {
    const events: HubEvent[] = [], snapshot = storedSchema.parse(JSON.parse(run.snapshot_json));
    for (const stage of await this.db.all<StageRow>("SELECT * FROM agent_bus_stages WHERE run_id=? AND status='running' ORDER BY seq", [run.id]))
      events.push(...await this.closeStage(run, snapshot, stage, status === "cancelled" ? "cancelled" : "failed", status === "cancelled" ? null : unfinished));
    await this.db.run("UPDATE agent_bus_runs SET status=?,error=?,finished_at=? WHERE id=?", [status, error, Date.now(), run.id]);
    return events;
  }
  /** Caller holds the transaction. Active runs whose coordinator input is no
   * longer pending (acknowledged, failed, cancelled, removed) become terminal. */
  private async settleInTransaction(where: string, params: (string | number)[]): Promise<HubEvent[]> {
    const rows = await this.db.all<RunRow & { delivery_status: string | null }>(`SELECT r.*,d.status AS delivery_status FROM agent_bus_runs r
      LEFT JOIN deliveries d ON d.message_id=r.message_id AND d.bot_id=r.coordinator_id
      WHERE r.status IN ${ACTIVE_SQL} AND (d.status IS NULL OR d.status!='pending') AND ${where}`, params);
    const events: HubEvent[] = [];
    for (const { delivery_status: delivery, ...run } of rows) {
      const status: AgentBusRunStatus = delivery === "cancelled" || run.stop_requested ? "cancelled" : "interrupted";
      events.push(...await this.finish(run, status, status === "cancelled" ? null : delivery === "accepted" ? "agent_bus_result_unconfirmed" : "agent_bus_delivery_failed"));
    }
    return events;
  }
}

function summary(row: RunRow): AgentBusRunSummary {
  return { id: row.id, workspaceId: row.workspace_id, messageId: row.message_id, status: row.status, createdAt: row.created_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}), ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}), ...(row.error ? { error: row.error } : {}) };
}
// A completed record stays neutral; only live, stopped and failed steps are tinted.
function template(status: AgentBusStageStatus): { template?: string } { return status === "running" ? { template: "blue" } : status === "cancelled" ? { template: "grey" } : status === "failed" ? { template: "red" } : {}; }
function statusLine(snapshot: Stored, seq: number, status: AgentBusStageStatus, error?: string | null): string {
  const state = status === "running" ? "执行中" : status === "completed" ? "已完成" : status === "cancelled" ? "已停止"
    : error === "agent_bus_wait_abandoned" ? "已结束等待，实际执行结果未确认" : `未完成${error ? `：${describeBusFailure(error, "zh")}` : ""}`;
  return `**${MODE_LABEL[snapshot.mode]} · 第 ${seq} 步** · ${state} · 独立执行记录`;
}
// Bus member turns use an independent temporary session; this chat is the record.
const RECORD_NOTE = "这一步在独立的临时会话中执行，不读取本对话的历史。本对话只保存发给成员的任务和它的结果；在这里继续聊天，成员看不到这次任务的上下文。";
