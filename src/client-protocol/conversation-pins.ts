import { z } from "zod";

export const CONVERSATION_PINS_CAPABILITY = "conversation-pins.v1";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const revision = z.number().int().nonnegative().safe();

export const pinScopeSchema = z.enum(["group", "global"]);
export type PinScope = z.infer<typeof pinScopeSchema>;

export const conversationPinsSchema = z.object({
  revision,
  pins: z.array(id).max(2048),
  globalPins: z.array(id).max(2048),
});
export type ConversationPinsState = z.infer<typeof conversationPinsSchema>;

export const pinSetSchema = z.object({
  type: z.literal("set"),
  revision,
  scope: pinScopeSchema,
  conversationId: id,
  pinned: z.boolean(),
}).strict();

export const pinMergeSchema = z.object({
  type: z.literal("merge"),
  revision,
  pins: z.array(id).max(2048),
  globalPins: z.array(id).max(2048),
}).strict();

export const pinReconcileItemSchema = z.object({
  scope: pinScopeSchema,
  conversationId: id,
  pinned: z.boolean(),
  at: z.number().int().nonnegative().safe(),
}).strict();
export type PinReconcileItem = z.infer<typeof pinReconcileItemSchema>;

export const pinReconcileSchema = z.object({
  type: z.literal("reconcile"),
  revision,
  changes: z.array(pinReconcileItemSchema).min(1).max(2048),
}).strict();

export const pinChangeSchema = z.discriminatedUnion("type", [
  pinSetSchema,
  pinMergeSchema,
  pinReconcileSchema,
]);
export type PinChange = z.infer<typeof pinChangeSchema>;

export const emptyConversationPins = (): ConversationPinsState => ({
  revision: 0,
  pins: [],
  globalPins: [],
});
