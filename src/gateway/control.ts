import { z } from "zod";
import { idSchema } from "../client-protocol/index.js";

// Internal parent/worker IPC. The optional request ID keeps existing local
// supervisors compatible; new callers wait for the matching child receipt.
export const restartRequestSchema = z.object({ type: z.enum(["restart.whenIdle", "drain.whenIdle"]), requestId: idSchema.optional() }).strict();
export const cancelDrainRequestSchema = z.object({ type: z.literal("drain.cancel"), requestId: idSchema.optional() }).strict();
export const drainCancelledSchema = z.object({ type: z.literal("drain.cancelled"), requestId: idSchema, pid: z.number().int().positive().safe(), ok: z.boolean() }).strict();
export const drainStatusRequestSchema = z.object({ type: z.literal("drain.status"), requestId: idSchema, drainId: idSchema }).strict();
export const drainBlockerSchema = z.object({ botId: idSchema, conversationKey: z.string().min(1).max(512).optional(), type: z.enum(["run", "approval", "async_question", "native_choice", "batch", "queue", "cron", "bus", "transport", "worker"]), count: z.number().int().positive().safe() }).strict();
export type DrainBlocker = z.infer<typeof drainBlockerSchema>;
export const drainStatusReceiptSchema = z.object({ type: z.literal("drain.status.result"), requestId: idSchema, drainId: idSchema, pid: z.number().int().positive().safe(), idle: z.boolean(), blockers: z.array(drainBlockerSchema).max(128).optional() }).strict();
export const drainCommitSchema = z.object({ type: z.literal("drain.commit"), drainId: idSchema }).strict();
export const restartQueuedSchema = z.object({ type: z.literal("restart.queued"), requestId: idSchema, pid: z.number().int().positive().safe() }).strict();

export const shutdownRequestSchema = z.object({ type: z.literal("shutdown.now") }).strict();
