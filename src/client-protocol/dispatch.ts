import { z } from "zod";
import { botCapabilitiesSchema } from "./capabilities.js";
// Imported by index.ts for its capability list; keep it independent of index.ts
// to avoid an initialization cycle.

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const effort = z.enum(["", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
// Becomes a native CLI argument; never an option-like or shell-like value.
const modelValue = z.string().trim().max(512).regex(/^(?!-)[A-Za-z0-9.%_:/@+~!'()*[\]-]*$/);
export const dispatchEngineSelectionValid = (value: { engine: string; model?: string; effort?: string }) => value.engine === "deepseek"
  || ((!value.model || value.model.length <= 128 && /^(?!-)[A-Za-z0-9._:/@+[\]-]*$/.test(value.model)) && value.effort !== "off" && value.effort !== "minimal");

/** A dispatcher Bot, hidden ticket conversations and the ticket ledger. */
export const DISPATCH_CAPABILITY = "dispatch.v1";
/** Cross-host Superagent dispatch, node load reporting, split planning & batch summary. */
export const DISPATCH_CROSS_HOST_CAPABILITY = "dispatch.cross-host.v1";
export function dispatchWireRoute(route: string, crossHostSupported?: boolean): string {
  if (!crossHostSupported || !/^\/api\/(?:bots\/[^/]+\/(?:dispatcher|tickets)(?:[/?]|$)|tickets\/)/.test(route)) return route;
  return `${route}${route.includes("?") ? "&" : "?"}crossHostDispatch=1`;
}
export const REMOTE_DISPATCH_TARGET_BOT = "__dispatch__" as const;

/** `dispatcher` is chosen only when the Bot is created; an ordinary Bot has no
 * role. `worker` Bots are created by the Host as a dispatcher's hidden channel
 * to one installed engine CLI; clients never create or list them. */
export const botRoleSchema = z.enum(["dispatcher", "worker"]);
export type BotRole = z.infer<typeof botRoleSchema>;

export const DISPATCH_ENGINES = ["codex", "claude", "kimi", "deepseek", "antigravity"] as const;
export const dispatchEngineSchema = z.enum(DISPATCH_ENGINES);
export type DispatchEngine = z.infer<typeof dispatchEngineSchema>;

/** `ask`: confirm with the owner before dispatching; `auto`: dispatch, then report. */
export const dispatchModeSchema = z.enum(["ask", "auto"]);
export const DISPATCH_MAX_CONCURRENT = 8;
/** Host scheduling preference aligned with #88. */
export const hostDispatchPreferenceSchema = z.enum(["normal", "prefer", "less_often", "manual_only"]);
export type HostDispatchPreference = z.infer<typeof hostDispatchPreferenceSchema>;
export const dispatcherNodeSettingsSchema = z.object({
  hostId: id,
  enabled: z.boolean().default(true),
  allowedEngines: z.array(dispatchEngineSchema).min(1).max(DISPATCH_ENGINES.length).optional(),
  maxConcurrent: z.number().int().min(1).max(DISPATCH_MAX_CONCURRENT).default(2),
  preference: hostDispatchPreferenceSchema.default("normal"),
}).strict();
export type DispatcherNodeSettings = z.infer<typeof dispatcherNodeSettingsSchema>;
export const dispatcherSettingsSchema = z.object({
  /** Engine CLIs the dispatcher may use. Absent: every installed one. */
  allowedEngines: z.array(dispatchEngineSchema).min(1).max(DISPATCH_ENGINES.length).optional(),
  mode: dispatchModeSchema.default("ask"),
  maxConcurrent: z.number().int().min(1).max(DISPATCH_MAX_CONCURRENT).default(2),
  /** Optional per-Host node configuration for cross-host dispatch. */
  nodes: z.array(dispatcherNodeSettingsSchema).max(32).optional(),
}).strict();
export type DispatcherSettings = z.infer<typeof dispatcherSettingsSchema>;
export const defaultDispatcherSettings = (): DispatcherSettings => dispatcherSettingsSchema.parse({});
export const dispatcherSettingsUpdateSchema = z.object({ settings: dispatcherSettingsSchema, expectedRevision: z.string().max(128) }).strict();

export const TICKET_STATUSES = ["queued", "working", "needs_answer", "needs_review", "blocked", "done", "cancelled"] as const;
export const ticketStatusSchema = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof ticketStatusSchema>;
export const OPEN_TICKET_STATUSES: readonly TicketStatus[] = ["queued", "working", "needs_answer", "needs_review", "blocked"];

/** Engine failures that mean "use another tool", not "the task failed". */
export const ticketFailureSchema = z.object({
  category: z.string().max(64),
  /** Free text from the engine, e.g. "resets at 5pm". */
  resetHint: z.string().max(256).optional(),
  message: z.string().max(1000).optional(),
}).strict();
export type TicketFailure = z.infer<typeof ticketFailureSchema>;

export const ticketTargetSchema = z.object({
  botId: id, engine: dispatchEngineSchema, model: z.string().max(512), effort,
  hostId: id.optional(),
  hostName: z.string().max(128).optional(),
  remoteTicketId: id.optional(),
  remoteConversationId: id.optional(),
  remoteMessageId: id.optional(),
  remoteBotName: z.string().max(128).optional(),
}).strict().refine(dispatchEngineSelectionValid, { message: "engine_selection_invalid" });
export type TicketTarget = z.infer<typeof ticketTargetSchema>;

export const ticketAttemptSchema = ticketTargetSchema.safeExtend({
  id, conversationId: id, inputMessageId: id, startedAt: z.number().int(),
  endedAt: z.number().int().optional(),
  /** Durable intent; an RPC acknowledgment alone never proves the turn ended. */
  stopRequested: z.enum(["pause", "cancel"]).optional(),
  /** A live worker question/approval; the attempt still owns its run slot. */
  waitingFor: z.object({ kind: z.enum(["answer", "approval"]), messageId: id }).strict().optional(),
  outcome: z.enum(["completed", "failed", "cancelled"]).optional(),
  failure: ticketFailureSchema.optional(),
}).strict();
export type TicketAttempt = z.infer<typeof ticketAttemptSchema>;

export const ticketArtifactSchema = z.object({
  id,
  name: z.string().max(255),
  size: z.number().nonnegative(),
  mime: z.string().max(128),
  sha256: z.string().max(128).optional(),
  localAttachmentId: id.optional(),
}).strict();
export type TicketArtifact = z.infer<typeof ticketArtifactSchema>;

export const dispatchTicketSchema = z.object({
  id, dispatcherBotId: id, conversationId: id,
  title: z.string().max(200), request: z.string().max(20_000),
  status: ticketStatusSchema, paused: z.boolean(),
  attempts: z.array(ticketAttemptSchema).max(32),
  /** Excerpt of the latest worker reply, for the list and the dispatcher. */
  result: z.string().max(4000).optional(),
  note: z.string().max(2000).optional(),
  /** Optional batch & assigned-node metadata for split cross-host execution. */
  batchId: id.optional(),
  batchIndex: z.number().int().nonnegative().optional(),
  batchTotal: z.number().int().positive().optional(),
  hostId: id.optional(),
  hostName: z.string().max(128).optional(),
  artifacts: z.array(ticketArtifactSchema).max(64).optional(),
  createdAt: z.number().int(), updatedAt: z.number().int(),
}).strict();
export type DispatchTicket = z.infer<typeof dispatchTicketSchema>;

export const ENGINE_HEALTH_STATES = ["ok", "cooldown", "login_required"] as const;
export const engineHealthSchema = z.object({
  engine: dispatchEngineSchema, state: z.enum(ENGINE_HEALTH_STATES),
  /** Cooldown end; absent when the reset time is unknown or not applicable. */
  until: z.number().int().optional(),
  reason: z.string().max(256).optional(),
  updatedAt: z.number().int(),
}).strict();
export type EngineHealth = z.infer<typeof engineHealthSchema>;

/** Conversation marker for a hidden worker conversation (dispatch.v1 clients only). */
export const conversationTicketSchema = z.object({
  id, dispatcherBotId: id, model: z.string().max(512).optional(), effort: effort.optional(),
  /** The ticket's own directory, inside the dispatcher's workspace. */
  workspace: z.string().max(4096).optional(),
}).strict();
export type ConversationTicket = z.infer<typeof conversationTicketSchema>;

export const createTicketSchema = z.object({
  requestId: id, title: z.string().trim().min(1).max(200), request: z.string().trim().min(1).max(20_000),
  conversationId: id.optional(),
}).strict();
export const dispatchTicketRequestBaseSchema = z.object({
  requestId: id, ticketId: id, engine: dispatchEngineSchema,
  /** Target Host ID (`hub_...`) or `"auto"` for load-based selection; omitted uses local Host. */
  hostId: id.optional(),
  model: modelValue.optional(), effort: effort.optional(),
  /** Instruction for the worker; defaults to the ticket request. */
  text: z.string().trim().min(1).max(20_000).optional(),
  /** Dispatch even though the engine is cooling down or needs sign-in. */
  force: z.boolean().optional(),
  /** Bounded helper calls for this dispatch chain; auto defaults to one,
   * ask defaults to none. Continuations never replenish this allowance. */
  assist: z.number().int().min(0).max(2).optional(),
}).strict();
export const dispatchTicketRequestSchema = dispatchTicketRequestBaseSchema.refine(dispatchEngineSelectionValid, { message: "engine_selection_invalid" });
export const updateTicketSchema = z.object({
  ticketId: id,
  status: z.enum(["queued", "needs_answer", "needs_review", "blocked", "done", "cancelled"]).optional(),
  note: z.string().trim().max(2000).optional(),
}).strict();
export const TICKET_ACTIONS = ["pause", "resume", "cancel", "accept", "remove"] as const;
export const ticketActionSchema = z.object({ requestId: id, action: z.enum(TICKET_ACTIONS) }).strict();
export type TicketAction = z.infer<typeof ticketActionSchema>["action"];

/** An engine CLI as a dispatch target, from the Host's engine catalog. */
export const dispatchTargetSchema = z.object({
  engine: dispatchEngineSchema, installed: z.boolean(), allowed: z.boolean(),
  models: z.array(z.object({ id: z.string(), label: z.string().optional(), efforts: z.array(z.string()) })),
  defaultModel: z.string(), defaultEffort: z.string(), health: engineHealthSchema.optional(),
}).strict();
export type DispatchTarget = z.infer<typeof dispatchTargetSchema>;

/** On-demand user-scope metadata, never a live tool or quality guarantee. */
export const dispatchCapabilitiesRequestSchema = z.object({
  engine: dispatchEngineSchema,
  match: z.string().trim().max(100).optional(),
  offset: z.number().int().min(0).max(1000).default(0),
}).strict();
export const dispatchCapabilitiesSchema = botCapabilitiesSchema.extend({
  scope: z.literal("user"),
  note: z.string().max(500),
  entries: botCapabilitiesSchema.shape.entries.max(40),
  total: z.number().int().min(0).max(1000),
  offset: z.number().int().min(0).max(1000),
  hasMore: z.boolean(),
});
export type DispatchCapabilities = z.infer<typeof dispatchCapabilitiesSchema>;

export const ticketListSchema = z.object({
  tickets: z.array(dispatchTicketSchema), engines: z.array(engineHealthSchema),
}).strict();
export type TicketList = z.infer<typeof ticketListSchema>;

/** App polling needs status and the latest attempt, not task/result bodies.
 * Strip extra fields so an older Host's full response remains readable. Older
 * Hosts may also return all attempts; new Hosts project only the latest one. */
export const ticketOverviewSchema = dispatchTicketSchema.omit({ request: true, result: true, note: true }).extend({
  resultExcerpt: z.string().max(240).optional(),
}).strip();
export type TicketOverview = z.infer<typeof ticketOverviewSchema>;
export const ticketOverviewListSchema = z.object({
  tickets: z.array(ticketOverviewSchema), engines: z.array(engineHealthSchema),
  capabilities: z.object({ remove: z.boolean(), crossHost: z.boolean().optional(), bulkActions: z.boolean().optional() }).strict().optional(),
  otherCount: z.number().int().nonnegative().optional(),
}).strict();
export type TicketOverviewList = z.infer<typeof ticketOverviewListSchema>;

/** Ticket wire projections for 1.6.0's strict full and nested validators. */
export function legacyDispatchTicket(ticket: (DispatchTicket | TicketOverview) & { resultExcerpt?: string }) {
  const { batchId, batchIndex, batchTotal, hostId, hostName, artifacts, resultExcerpt, ...base } = ticket;
  return { ...base, attempts: ticket.attempts.map(attempt => {
    const { hostId, hostName, remoteTicketId, remoteConversationId, remoteMessageId, remoteBotName, ...legacy } = attempt;
    return legacy;
  }) };
}

export function legacyDispatcherSettings({ settings: { nodes, ...settings }, revision }: { settings: DispatcherSettings; revision: string }) {
  return { settings, revision };
}

/** Read-only Host load, capacity, and cached engine quota report (aligned with #88). */
export const hostEngineCapacitySchema = z.object({
  engine: dispatchEngineSchema,
  installed: z.boolean(),
  available: z.boolean(),
  health: engineHealthSchema.optional(),
  quotaState: z.enum(["ok", "warning", "blocked", "unknown"]).optional(),
  quotaSummary: z.string().max(160).optional(),
  models: z.array(z.object({ id: z.string(), label: z.string().optional(), efforts: z.array(z.string()) })),
  defaultModel: z.string(),
  defaultEffort: z.string(),
}).strict();
export type HostEngineCapacity = z.infer<typeof hostEngineCapacitySchema>;

export const hostLoadReportSchema = z.object({
  hostId: id,
  hostName: z.string().max(128),
  online: z.boolean(),
  authorized: z.boolean().optional(),
  cpuCount: z.number().int().positive().optional(),
  cpuLoadRatio: z.number().min(0).max(100).optional(),
  freeMemoryRatio: z.number().min(0).max(1).optional(),
  activeTurns: z.number().int().nonnegative(),
  activeTickets: z.number().int().nonnegative(),
  engines: z.array(hostEngineCapacitySchema),
  observedAt: z.number().int(),
  error: z.string().max(128).optional(),
}).strict();
export type HostLoadReport = z.infer<typeof hostLoadReportSchema>;

export const dispatchNodeTargetSchema = z.object({
  hostId: id,
  hostName: z.string().max(128),
  local: z.boolean(),
  enabled: z.boolean(),
  online: z.boolean(),
  authorized: z.boolean(),
  preference: hostDispatchPreferenceSchema,
  maxConcurrent: z.number().int().min(1).max(DISPATCH_MAX_CONCURRENT),
  allowedEngines: z.array(dispatchEngineSchema).optional(),
  activeOnNode: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative().optional(),
  load: hostLoadReportSchema,
  eligible: z.boolean(),
  ineligibleReason: z.string().max(128).optional(),
  score: z.number().optional(),
  selectionReason: z.string().max(128).optional(),
}).strict();
export type DispatchNodeTarget = z.infer<typeof dispatchNodeTargetSchema>;

export const dispatchNodesResponseSchema = z.object({
  ownHostId: id,
  settings: dispatcherSettingsSchema,
  nodes: z.array(dispatchNodeTargetSchema),
}).strict();
export type DispatchNodesResponse = z.infer<typeof dispatchNodesResponseSchema>;

export const dispatchSplitPlanRequestSchema = z.object({
  conversationId: id.optional(),
  requestId: id,
  title: z.string().trim().min(1).max(200).optional(),
  request: z.string().trim().min(1).max(20_000),
  engine: dispatchEngineSchema.optional(),
  model: modelValue.optional(),
  effort: effort.optional(),
  totalItems: z.number().int().positive().max(10_000).optional(),
  perNode: z.number().int().positive().max(10_000).optional(),
  items: z.array(z.string().trim().min(1).max(2000)).min(1).max(500).optional(),
  hostIds: z.array(id).min(1).max(32).optional(),
  create: z.boolean().default(false),
  dispatch: z.boolean().default(false),
  force: z.boolean().default(false),
}).strict().refine(value => !value.engine || dispatchEngineSelectionValid({ engine: value.engine, model: value.model, effort: value.effort }), { message: "engine_selection_invalid" });
export type DispatchSplitPlanRequest = z.infer<typeof dispatchSplitPlanRequestSchema>;
export type DispatchSplitPlanInput = z.input<typeof dispatchSplitPlanRequestSchema>;

export const dispatchSplitBatchSchema = z.object({
  batchIndex: z.number().int().nonnegative(),
  batchTotal: z.number().int().positive(),
  title: z.string().max(200),
  request: z.string().max(20_000),
  hostId: id,
  hostName: z.string().max(128),
  engine: dispatchEngineSchema,
  model: z.string().max(512),
  effort,
  itemStart: z.number().int().positive().optional(),
  itemEnd: z.number().int().positive().optional(),
  itemCount: z.number().int().positive().optional(),
  reason: z.string().max(128),
}).strict();
export type DispatchSplitBatch = z.infer<typeof dispatchSplitBatchSchema>;

export const dispatchSplitPlanResponseSchema = z.object({
  batchId: id,
  totalItems: z.number().int().positive().optional(),
  perNode: z.number().int().positive().optional(),
  mode: dispatchModeSchema,
  requiresConfirmation: z.boolean(),
  batches: z.array(dispatchSplitBatchSchema),
  skippedNodes: z.array(z.object({ hostId: id, hostName: z.string().max(128), reason: z.string().max(128) }).strict()),
  tickets: z.array(dispatchTicketSchema).optional(),
}).strict();
export type DispatchSplitPlanResponse = z.infer<typeof dispatchSplitPlanResponseSchema>;

export const ticketBulkActionSchema = z.object({
  requestId: id,
  action: z.enum(["pause", "resume", "cancel"]),
  conversationId: id.optional(),
  hostId: id.optional(),
  batchId: id.optional(),
}).strict();
export type TicketBulkAction = z.infer<typeof ticketBulkActionSchema>;

export const crossHostDispatchGrantCommandSchema = z.object({
  operation: z.literal("cross-host-dispatch-grant"),
  sourceHost: z.string().regex(/^hub_[a-f0-9]{64}$/),
  sourceBot: id,
  allowed: z.boolean(),
}).strict();
export type CrossHostDispatchGrantCommand = z.infer<typeof crossHostDispatchGrantCommandSchema>;

export const crossHostDispatchGrantsSnapshotSchema = z.object({
  host: z.object({ id: z.string().regex(/^hub_[a-f0-9]{64}$/), name: z.string() }).strict(),
  hosts: z.array(z.object({ id: z.string().regex(/^hub_[a-f0-9]{64}$/), name: z.string(), available: z.boolean() }).strict()),
  grants: z.array(z.object({ sourceHost: z.string().regex(/^hub_[a-f0-9]{64}$/), sourceBot: id }).strict()),
}).strict();
export type CrossHostDispatchGrantsSnapshot = z.infer<typeof crossHostDispatchGrantsSnapshotSchema>;

export const remoteDispatchRunRequestSchema = z.object({
  remoteRequestId: id,
  title: z.string().trim().min(1).max(200),
  request: z.string().trim().min(1).max(20_000),
  engine: dispatchEngineSchema,
  model: modelValue.default(""),
  effort: effort.default(""),
  force: z.boolean().optional(),
}).strict().refine(dispatchEngineSelectionValid, { message: "engine_selection_invalid" });
export type RemoteDispatchRunRequest = z.infer<typeof remoteDispatchRunRequestSchema>;

export const remoteDispatchRunResponseSchema = z.object({
  remoteTicketId: id,
  conversationId: id,
  messageId: id,
  botId: id,
  botName: z.string().max(128),
  engine: dispatchEngineSchema,
  model: z.string().max(512),
  effort,
  status: z.enum(["queued", "working"]),
}).strict();
export type RemoteDispatchRunResponse = z.infer<typeof remoteDispatchRunResponseSchema>;

export const remoteDispatchStatusResponseSchema = z.object({
  remoteTicketId: id,
  status: z.enum(["queued", "working", "needs_answer", "completed", "failed", "cancelled"]),
  waitingFor: z.object({ kind: z.enum(["answer", "approval"]), messageId: id }).strict().optional(),
  result: z.string().max(4000).optional(),
  resultTruncated: z.boolean().optional(),
  failure: ticketFailureSchema.optional(),
  artifacts: z.array(ticketArtifactSchema).max(64),
  updatedAt: z.number().int(),
}).strict();
export type RemoteDispatchStatusResponse = z.infer<typeof remoteDispatchStatusResponseSchema>;

export const remoteDispatchStopRequestSchema = z.object({
  remoteTicketId: id,
  action: z.enum(["pause", "cancel"]),
}).strict();

export const remoteDispatchStopResponseSchema = z.object({
  remoteTicketId: id,
  status: z.enum(["queued", "working", "needs_answer", "completed", "failed", "cancelled"]),
  stopped: z.boolean(),
}).strict();
export type RemoteDispatchStopResponse = z.infer<typeof remoteDispatchStopResponseSchema>;
