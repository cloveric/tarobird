import { z } from "zod";

export const ENGINE_TASKS_CAPABILITY = "conversations.tasks.v1";
export const SWARM_TASKS_CAPABILITY = "conversations.tasks.swarm.v1";
/** Display-only metadata on a saved scoped reply; never a control target. */
export const scopedTaskLabelSchema = z.object({ version: z.literal(1), label: z.string().min(1).max(500), kind: z.enum(["subagent", "background"]) }).strict();
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const swarmMemberStateSchema = z.enum(["working", "waiting", "killed", "done", "failed", "paused", "unknown"]);
export const swarmMemberSchema = z.object({
  name: z.string().min(1).max(128),
  role: z.string().min(1).max(64).optional(),
  helper: z.boolean().optional(),
  state: swarmMemberStateSchema,
  model: z.string().min(1).max(160).optional(),
  latestActivity: z.string().max(2000).optional(),
  updatedAt: z.number().nonnegative().optional(),
}).strict();
export const swarmPostSchema = z.object({
  id: z.string().min(1).max(128),
  author: z.string().min(1).max(128),
  mentions: z.array(z.string().min(1).max(128)).max(32).optional(),
  title: z.string().max(300).optional(),
  content: z.string().max(16_000),
  kind: z.string().max(64).optional(),
  createdAt: z.number().nonnegative(),
}).strict();
export const swarmSnapshotSchema = z.object({
  active: z.boolean(),
  title: z.string().max(300).optional(),
  statusText: z.string().max(500).optional(),
  source: z.enum(["acp", "files", "merged"]),
  formatUnknown: z.boolean().optional(),
  members: z.array(swarmMemberSchema).max(64),
  posts: z.array(swarmPostSchema).max(200),
  updatedAt: z.number().nonnegative(),
}).strict();
/** IDs are opaque live-worker handles, never paths or resumable native IDs. */
export const engineTaskSchema = z.object({
  id, label: z.string().min(1).max(500), kind: z.enum(["subagent", "shell", "unknown"]),
  mode: z.enum(["foreground", "background"]), status: z.enum(["running", "done", "error", "stopped", "unknown"]),
  canStop: z.boolean(), startedAt: z.number().nonnegative().optional(), updatedAt: z.number().nonnegative(),
  progress: z.string().max(2000).optional(),
  parentId: id.optional(), owner: z.enum(["bound", "unattributed"]).optional(),
  role: z.string().min(1).max(64).optional(),
  swarmState: swarmMemberStateSchema.optional(),
  model: z.string().min(1).max(160).optional(),
  helper: z.boolean().optional(),
}).strict();
export const engineTaskSnapshotSchema = z.object({
  supported: z.boolean(),
  tasks: z.array(engineTaskSchema).max(128),
  foregroundStopScope: z.enum(["foreground", "subagents", "all"]).optional(),
  recovery: z.object({ token: id, reason: z.literal("stop_unconfirmed") }).strict().optional(),
  swarm: swarmSnapshotSchema.optional(),
}).strict();
export const engineTaskControlResultSchema = z.object({ outcome: z.enum(["accepted", "rejected", "unknown"]), reason: z.enum(["unsupported", "stale", "not_ready", "uncertain"]).optional() }).strict();
export const engineTaskStopSchema = z.object({ botId: id, taskId: id, requestId: id }).strict();
export const engineSessionRecoverySchema = z.object({ botId: id, token: id, requestId: id }).strict();
export type SwarmMemberState = z.infer<typeof swarmMemberStateSchema>;
export type SwarmMember = z.infer<typeof swarmMemberSchema>;
export type SwarmPost = z.infer<typeof swarmPostSchema>;
export type SwarmSnapshot = z.infer<typeof swarmSnapshotSchema>;
export type EngineTask = z.infer<typeof engineTaskSchema>;
export type EngineTaskSnapshot = z.infer<typeof engineTaskSnapshotSchema>;
export type EngineTaskControlResult = z.infer<typeof engineTaskControlResultSchema>;

/** Strip post-1.6.0 Swarm fields so strict 1.6.0 clients and Hubs accept the snapshot. */
export function stripSwarmTaskFields(snapshot: EngineTaskSnapshot): EngineTaskSnapshot {
  const { swarm: _swarm, ...rest } = snapshot;
  return {
    ...rest,
    tasks: snapshot.tasks.map(({ role: _role, swarmState: _swarmState, model: _model, helper: _helper, ...task }) => task),
  };
}
