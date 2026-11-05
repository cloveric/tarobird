import { z } from "zod";
import { blockSchema, idSchema, jsonSchema } from "./index.js";

export const botPublishSchema = z.object({ id: idSchema.optional(), conversationId: idSchema, blocks: z.array(blockSchema), status: z.enum(["pending", "streaming", "complete", "error", "deleted"]).optional(), replyTo: idSchema.optional(), version: z.number().int().positive().optional() });
export const botRuntimeStatusSchema = z.object({ engine: z.string().max(64), model: z.string().max(128), effort: z.string().max(32) });
export const instanceFrameSchema = z.discriminatedUnion("type", [
  z.object({ v: z.literal(1), type: z.literal("instance.hello"), capabilities: z.array(z.string().max(64)).max(64).optional(), botId: idSchema, secret: z.string().min(32).max(256), engine: z.string().max(64), model: z.string().max(128), effort: z.string().max(32) }),
  z.object({ v: z.literal(1), type: z.literal("instance.request"), id: idSchema, method: z.enum(["workbench.command", "workbench.cancel", "workbench.targets", "workbench.context", "workbench.turn.begin", "workbench.turn.end", "publish", "fetch", "conversation", "reaction", "turn.state", "ack", "queue.take", "delivery.fail", "run.write", "run.scope.write", "run.recover", "steer.outcome", "input.progress", "agentBus.event", "groupDiscussion.report"]), params: jsonSchema }),
  z.object({ v: z.literal(1), type: z.literal("instance.result"), id: idSchema, result: jsonSchema.optional(), error: z.string().optional() }),
  // Older Hubs ignore the optional fields and still answer this heartbeat.
  z.object({ v: z.literal(1), type: z.literal("ping"), status: botRuntimeStatusSchema.optional() }),
]);
export type InstanceFrame = z.infer<typeof instanceFrameSchema>;
