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

/** `hub_` + SHA-256 of the raw host public key bytes (hub/bot-messages.ts::messageHostId). */
export const messageHostIdSchema = z.string().regex(/^hub_[a-f0-9]{64}$/);
/** The receiving Host approves one direction: a source Host/Bot to its own Bot.
 * The source Bot is an explicit ID; this Host never exposes a peer Bot directory. */
export const crossHostMessageGrantsCommandSchema = z.object({
  operation: z.literal("cross-host-message-grants"),
  sourceHost: messageHostIdSchema,
  sourceBot: idSchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  changes: z.array(z.object({ targetBot: idSchema, allowed: z.boolean() }).strict()).min(1).max(256),
}).strict().refine(value => new Set(value.changes.map(change => change.targetBot)).size === value.changes.length,
  { message: "invalid_message_grant_targets" });
export type CrossHostMessageGrantsCommand = z.infer<typeof crossHostMessageGrantsCommandSchema>;
export const crossHostMessageGrantsSnapshotSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  host: z.object({ id: messageHostIdSchema, name: z.string() }),
  // `available` is current signed membership eligibility, not reachability.
  // Unavailable entries are sources with remaining edges: revoke only.
  hosts: z.array(z.object({ id: messageHostIdSchema, name: z.string(), available: z.boolean() })),
  // A deleted target appears only while it still has a visible edge: revoke only.
  bots: z.array(z.object({ id: idSchema, name: z.string(), online: z.boolean(), deleted: z.literal(true).optional() })),
  grants: z.array(z.object({ sourceHost: messageHostIdSchema, sourceBot: idSchema, targetBot: idSchema })),
});
export type CrossHostMessageGrantsSnapshot = z.infer<typeof crossHostMessageGrantsSnapshotSchema>;
