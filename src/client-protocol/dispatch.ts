import { z } from "zod";
import { botCapabilitiesSchema } from "./capabilities.js";
// Imported by index.ts for its capability list; keep it independent of index.ts
// to avoid an initialization cycle.

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const effort = z.enum(["", "low", "medium", "high", "xhigh", "max", "ultra"]);

/** A dispatcher Bot, hidden ticket conversations and the ticket ledger. */
export const DISPATCH_CAPABILITY = "dispatch.v1";

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
export const dispatcherSettingsSchema = z.object({
  /** Engine CLIs the dispatcher may use. Absent: every installed one. */
  allowedEngines: z.array(dispatchEngineSchema).min(1).max(DISPATCH_ENGINES.length).optional(),
  mode: dispatchModeSchema.default("ask"),
  maxConcurrent: z.number().int().min(1).max(DISPATCH_MAX_CONCURRENT).default(2),
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
  botId: id, engine: dispatchEngineSchema, model: z.string().max(128), effort,
}).strict();
export type TicketTarget = z.infer<typeof ticketTargetSchema>;

export const ticketAttemptSchema = ticketTargetSchema.extend({
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

export const dispatchTicketSchema = z.object({
  id, dispatcherBotId: id, conversationId: id,
  title: z.string().max(200), request: z.string().max(20_000),
  status: ticketStatusSchema, paused: z.boolean(),
  attempts: z.array(ticketAttemptSchema).max(32),
  /** Excerpt of the latest worker reply, for the list and the dispatcher. */
  result: z.string().max(4000).optional(),
  note: z.string().max(2000).optional(),
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
  id, dispatcherBotId: id, model: z.string().max(128).optional(), effort: effort.optional(),
  /** The ticket's own directory, inside the dispatcher's workspace. */
  workspace: z.string().max(4096).optional(),
}).strict();
export type ConversationTicket = z.infer<typeof conversationTicketSchema>;

export const createTicketSchema = z.object({
  requestId: id, title: z.string().trim().min(1).max(200), request: z.string().trim().min(1).max(20_000),
}).strict();
export const dispatchTicketRequestSchema = z.object({
  requestId: id, ticketId: id, engine: dispatchEngineSchema,
  // Becomes a native CLI argument; never an option-like or shell-like value.
  model: z.string().trim().max(128).regex(/^(?!-)[A-Za-z0-9._:/@+[\]-]*$/).optional(), effort: effort.optional(),
  /** Instruction for the worker; defaults to the ticket request. */
  text: z.string().trim().min(1).max(20_000).optional(),
  /** Dispatch even though the engine is cooling down or needs sign-in. */
  force: z.boolean().optional(),
  /** Bounded helper calls for this dispatch chain; auto defaults to one,
   * ask defaults to none. Continuations never replenish this allowance. */
  assist: z.number().int().min(0).max(2).optional(),
}).strict();
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
export const ticketOverviewSchema = dispatchTicketSchema.omit({ request: true, result: true, note: true }).strip();
export type TicketOverview = z.infer<typeof ticketOverviewSchema>;
export const ticketOverviewListSchema = z.object({
  tickets: z.array(ticketOverviewSchema), engines: z.array(engineHealthSchema),
  capabilities: z.object({ remove: z.boolean() }).strict().optional(),
}).strict();
export type TicketOverviewList = z.infer<typeof ticketOverviewListSchema>;
