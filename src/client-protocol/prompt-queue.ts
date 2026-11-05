import { z } from "zod";
import { idSchema, messageSchema, textSchema } from "./index.js";

/** Host-owned, not the CLI's native experimental queue. */
export const PROMPT_QUEUE_CAPABILITY = "prompt-queue.v1";
/** Workers claim ordinary direct-chat input only while holding its execution slot. */
export const PROMPT_QUEUE_PULL_CAPABILITY = "prompt-queue.pull.v1";
export const PROMPT_QUEUE_ENGINES = ["codex", "claude", "antigravity", "kimi", "deepseek"] as const;
export const promptQueueActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("move"), messageId: idSchema, beforeId: idSchema.nullable() }).strict(),
  z.object({ type: z.literal("edit"), messageId: idSchema, text: textSchema }).strict(),
  z.object({ type: z.literal("cancel"), messageId: idSchema }).strict(),
  z.object({ type: z.literal("pause"), messageId: idSchema }).strict(),
  z.object({ type: z.literal("resume"), messageId: idSchema }).strict(),
]);
export const promptQueueMutationSchema = z.object({ botId: idSchema, requestId: idSchema, revision: z.string().min(1).max(128), action: promptQueueActionSchema }).strict();
export const promptQueueSnapshotSchema = z.object({
  supported: z.boolean(), reason: z.string().optional(), revision: z.string(), botId: idSchema, conversationId: idSchema,
  items: z.array(z.object({ message: messageSchema, state: z.enum(["queued", "dispatched"]), canEdit: z.boolean(), canCancel: z.boolean(), canMove: z.boolean(), reorderBarrier: z.boolean().optional(), paused: z.boolean().optional(), canPause: z.boolean().optional(), canResume: z.boolean().optional() })),
  capabilities: z.object({ reorder: z.boolean(), edit: z.boolean(), cancel: z.boolean(), pause: z.boolean().optional() }),
});
export type PromptQueueSnapshot = z.infer<typeof promptQueueSnapshotSchema>;
export type PromptQueueMutation = z.infer<typeof promptQueueMutationSchema>;
export type PromptQueueAction = z.infer<typeof promptQueueActionSchema>;
