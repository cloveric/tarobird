import { z } from "zod";
import { idSchema } from "./index.js";

/** UI for existing local, directed message grants. Agent Bus is independent. */
export const botMessageGrantsCommandSchema = z.object({
  operation: z.literal("local-message-grants"),
  sourceBot: idSchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  changes: z.array(z.object({ targetBot: idSchema, allowed: z.boolean() }).strict()).min(1).max(256),
}).strict().refine(value => new Set(value.changes.map(change => change.targetBot)).size === value.changes.length,
  { message: "invalid_message_grant_targets" });
export type BotMessageGrantsCommand = z.infer<typeof botMessageGrantsCommandSchema>;
export const botMessageGrantsSnapshotSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  // Older hosts omit self grants from snapshots and reject UI self writes.
  selfTargetSupported: z.boolean().optional(),
  bots: z.array(z.object({ id: idSchema, name: z.string(), online: z.boolean() })),
  grants: z.array(z.object({ sourceBot: idSchema, targetBot: idSchema })),
});
export type BotMessageGrantsSnapshot = z.infer<typeof botMessageGrantsSnapshotSchema>;
