import { z } from "zod";
import { idSchema } from "./index.js";

export const AGENT_BUS_CAPABILITY = "agent-bus.workspaces.v1";
export const agentBusModeSchema = z.enum(["ask", "fan", "chain", "verify", "crew"]);
export type AgentBusMode = z.infer<typeof agentBusModeSchema>;
export const AGENT_BUS_INSTRUCTION_CHARS = 8_000;
export const agentBusInstructionSchema = z.string().trim().max(AGENT_BUS_INSTRUCTION_CHARS);
export const agentBusMemberSchema = z.object({ botId: idSchema, conversationId: idSchema.optional(),
  instruction: agentBusInstructionSchema.transform(value => value || undefined).optional(),
}).strict();
export const agentBusConfigSchema = z.object({
  name: z.string().trim().min(1).max(80), mode: agentBusModeSchema,
  coordinator: agentBusMemberSchema, members: z.array(agentBusMemberSchema).min(1).max(11),
  maxResearchQuestions: z.number().int().min(1).max(10).default(5),
  maxRevisionRounds: z.number().int().min(0).max(3).default(1),
}).strict().superRefine((config, ctx) => {
  if ((config.mode === "ask" || config.mode === "chain") && config.coordinator.instruction)
    ctx.addIssue({ code: "custom", message: "agent_bus_coordinator_not_a_step", path: ["coordinator", "instruction"] });
  // A Bot can fill several roles; a conversation belongs to just one slot.
  const ids = [config.coordinator, ...config.members].flatMap(member => member.conversationId ? [member.conversationId] : []);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "agent_bus_duplicate_member", path: ["members"] });
  if ((config.mode === "ask" || config.mode === "verify") && config.members.length !== 1 || config.mode === "crew" && config.members.length !== 4)
    ctx.addIssue({ code: "custom", message: "agent_bus_member_count", path: ["members"] });
});
export type AgentBusConfig = z.infer<typeof agentBusConfigSchema>;
/** Admission only: ignore invisible formatting when testing for empty input,
 * but preserve it in meaningful Unicode text (emoji joins, Persian ZWNJ, etc.).
 * Keep the historical config reader permissive so old records remain repairable. */
export const hasVisibleAgentBusText = (text: string): boolean => /[^\s\p{Default_Ignorable_Code_Point}]/u.test(text);
export const agentBusWritableConfigSchema = agentBusConfigSchema.refine(config => hasVisibleAgentBusText(config.name), { path: ["name"], message: "agent_bus_empty_name" }).transform(config => {
  const optionalTask = ({ instruction, ...member }: AgentBusConfig["coordinator"]) => ({ ...member, ...(instruction && hasVisibleAgentBusText(instruction) ? { instruction } : {}) });
  return { ...config, coordinator: optionalTask(config.coordinator), members: config.members.map(optionalTask) };
});
export type AgentBusMember = { botId: string; conversationId: string; instruction?: string };
export type AgentBusRunStatus = "queued" | "running" | "stopping" | "completed" | "failed" | "cancelled" | "interrupted";
export type AgentBusStageStatus = "running" | "completed" | "failed" | "cancelled";
export type AgentBusStage = {
  id: string; botId: string; conversationId: string; status: AgentBusStageStatus;
  messageId?: string; startedAt: number; finishedAt?: number; error?: string;
};
export type AgentBusRunSummary = {
  id: string; workspaceId: string; messageId: string; status: AgentBusRunStatus;
  createdAt: number; startedAt?: number; finishedAt?: number; error?: string; canAbandon?: boolean;
};
/** The resolved configuration a run executes with; later edits never change it. */
export type AgentBusSnapshot = Omit<AgentBusConfig, "coordinator" | "members"> & { coordinator: AgentBusMember; members: AgentBusMember[] };
export type AgentBusRun = AgentBusRunSummary & { text: string; snapshot: AgentBusSnapshot; stages: AgentBusStage[] };
export type AgentBusWorkspace = Omit<AgentBusConfig, "coordinator" | "members"> & {
  id: string; revision: string; coordinator: AgentBusMember; members: AgentBusMember[];
  createdAt: number; updatedAt: number; latestRun?: AgentBusRunSummary;
};
export type AgentBusDetail = { workspace: AgentBusWorkspace; runs: AgentBusRun[] };
export const agentBusCreateSchema = z.object({ requestId: idSchema, config: agentBusWritableConfigSchema }).strict();
export const agentBusUpdateSchema = z.object({ revision: idSchema, config: agentBusWritableConfigSchema }).strict();
export const agentBusStartSchema = z.object({ requestId: idSchema, revision: idSchema, text: z.string().trim().min(1).max(48_000).refine(hasVisibleAgentBusText, "agent_bus_empty_goal") }).strict();
export const agentBusDeleteSchema = z.object({ revision: idSchema }).strict();
export const agentBusStopSchema = z.object({ requestId: idSchema, abandon: z.boolean().optional() }).strict();
export const agentBusIsActive = (status?: AgentBusRunStatus) => status === "queued" || status === "running" || status === "stopping";

// Hub <-> worker contract. A worker without this capability never receives a
// run input: older workers would strip the unknown frame field and execute the
// prompt as an ordinary chat turn.
export const AGENT_BUS_WORKER_CAPABILITY = "agent-bus.runs.v3";
// New workers also understand v2 Hubs. New Hubs require v3 before dispatching
// any run, so an older strict parser never receives per-slot instruction fields.
export const AGENT_BUS_LEGACY_WORKER_CAPABILITY = "agent-bus.runs.v2";
/** Card extra key on Hub-published stage records in member conversations. */
export const AGENT_BUS_STAGE_EXTRA = "agentBusStage";
const stageIdSchema = z.string().regex(/^s[0-9]{1,4}$/);
/** Validated metadata shared by record presentation and completion notifications. */
export const agentBusStageRecordSchema = z.object({
  runId: idSchema, workspaceId: idSchema, stageId: stageIdSchema,
  status: z.enum(["running", "completed", "failed", "cancelled"]),
}).strict();
export const AGENT_BUS_STAGE_LIMIT = 200;
export const AGENT_BUS_RECORD_TEXT_BYTES = 120 * 1024;
export const AGENT_BUS_RECORD_PROMPT_CHARS = 16_000;
/** Crew members are always [researcher, analyst, writer, reviewer]. */
export const agentBusDispatchSchema = z.object({
  runId: idSchema, workspaceId: idSchema, mode: agentBusModeSchema,
  members: z.array(idSchema).min(1).max(11),
  // Optional only for replaying pre-v2 inputs. New Hubs always send bindings.
  coordinatorConversationId: idSchema.optional(),
  conversations: z.array(idSchema).min(1).max(11).optional(),
  instructions: z.array(agentBusInstructionSchema).min(1).max(11).optional(),
  coordinatorInstruction: agentBusInstructionSchema.optional(),
  maxResearchQuestions: z.number().int().min(1).max(10), maxRevisionRounds: z.number().int().min(0).max(3),
  stopRequested: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.instructions && (!value.conversations || value.instructions.length !== value.members.length)
    || value.coordinatorInstruction && (!value.coordinatorConversationId || value.mode === "ask" || value.mode === "chain"))
    ctx.addIssue({ code: "custom", message: "agent_bus_invalid_instructions" });
  if (value.conversations || value.coordinatorConversationId) {
    const ids = [value.coordinatorConversationId, ...(value.conversations ?? [])];
    if (!value.coordinatorConversationId || value.conversations?.length !== value.members.length || new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", message: "agent_bus_invalid_bindings" });
  } else if (new Set(value.members).size !== value.members.length) ctx.addIssue({ code: "custom", message: "agent_bus_invalid_bindings" });
});
export type AgentBusDispatch = z.infer<typeof agentBusDispatchSchema>;
const eventBase = { runId: idSchema, messageId: idSchema };
export const agentBusEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run.started"), ...eventBase }).strict(),
  z.object({ type: z.literal("stage.started"), ...eventBase, stageId: stageIdSchema, botId: idSchema, conversationId: idSchema.optional(), prompt: z.string().max(AGENT_BUS_RECORD_PROMPT_CHARS + 64) }).strict(),
  z.object({ type: z.literal("stage.finished"), ...eventBase, stageId: stageIdSchema, botId: idSchema, conversationId: idSchema.optional(), status: z.enum(["completed", "failed", "cancelled"]),
    text: z.string().refine(text => new TextEncoder().encode(text).length <= AGENT_BUS_RECORD_TEXT_BYTES + 1024, "agent_bus_record_too_large").optional(), error: z.string().max(500).optional() }).strict(),
  z.object({ type: z.literal("run.finished"), ...eventBase, status: z.enum(["completed", "failed", "cancelled"]), error: z.string().max(500).optional() }).strict(),
]);
export type AgentBusEvent = z.infer<typeof agentBusEventSchema>;
