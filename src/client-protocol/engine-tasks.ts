import { z } from "zod";

export const ENGINE_TASKS_CAPABILITY = "conversations.tasks.v1";
/** Display-only metadata on a saved scoped reply; never a control target. */
export const scopedTaskLabelSchema = z.object({ version: z.literal(1), label: z.string().min(1).max(500), kind: z.enum(["subagent", "background"]) }).strict();
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
/** IDs are opaque live-worker handles, never paths or resumable native IDs. */
export const engineTaskSchema = z.object({
  id, label: z.string().min(1).max(500), kind: z.enum(["subagent", "shell", "unknown"]),
  mode: z.enum(["foreground", "background"]), status: z.enum(["running", "done", "error", "stopped", "unknown"]),
  canStop: z.boolean(), startedAt: z.number().nonnegative().optional(), updatedAt: z.number().nonnegative(),
  progress: z.string().max(2000).optional(),
  parentId: id.optional(), owner: z.enum(["bound", "unattributed"]).optional(),
}).strict();
export const engineTaskSnapshotSchema = z.object({ supported: z.boolean(), tasks: z.array(engineTaskSchema).max(128), foregroundStopScope: z.enum(["foreground", "subagents", "all"]).optional(), recovery: z.object({ token: id, reason: z.literal("stop_unconfirmed") }).strict().optional() }).strict();
export const engineTaskControlResultSchema = z.object({ outcome: z.enum(["accepted", "rejected", "unknown"]), reason: z.enum(["unsupported", "stale", "not_ready", "uncertain"]).optional() }).strict();
export const engineTaskStopSchema = z.object({ botId: id, taskId: id, requestId: id }).strict();
export const engineSessionRecoverySchema = z.object({ botId: id, token: id, requestId: id }).strict();
export type EngineTask = z.infer<typeof engineTaskSchema>;
export type EngineTaskSnapshot = z.infer<typeof engineTaskSnapshotSchema>;
export type EngineTaskControlResult = z.infer<typeof engineTaskControlResultSchema>;
