import { z } from "zod";
import { idSchema, messageSchema, eventSchema, type HubEvent, type Message } from "./index.js";

export const MESSAGE_DELETE_CAPABILITY = "messages.delete.v1";
export const MAX_DELETE_MESSAGES = 100;
export const deleteMessagesSchema = z.object({ messageIds: z.array(idSchema).min(1).max(MAX_DELETE_MESSAGES) }).strict();
export const deleteMessagesResultSchema = z.object({ deletedIds: z.array(idSchema).max(MAX_DELETE_MESSAGES) }).strict();
export const messagePageSchema = z.object({ messages: z.array(messageSchema), nextBefore: idSchema.optional() }).strict();
export const personalDeletionEventSchema = z.object({ userId: idSchema, message: messageSchema }).strict();

/** A personal projection only. Never persist this over the shared message. */
export function deletedMessage(message: Message): Message {
  return { id: message.id, conversationId: message.conversationId, authorId: message.authorId,
    authorType: message.authorType, createdAt: message.createdAt, status: "deleted",
    version: message.version + 1, blocks: [], ...(message.clientMsgId ? { clientMsgId: message.clientMsgId } : {}) };
}

export function messageEventId(event: HubEvent): string | undefined {
  const payload = event.payload;
  return (event.kind === "message.created" || event.kind === "message.updated") && payload && typeof payload === "object" && !Array.isArray(payload) && typeof payload.id === "string" ? payload.id : undefined;
}

export function personalMessageEvent(event: HubEvent, userId: string, hidden: ReadonlySet<string>): HubEvent {
  if (event.kind === "message.deleted") {
    const parsed = personalDeletionEventSchema.safeParse(event.payload);
    // Other members advance the shared cursor without learning whose history changed.
    return parsed.success && parsed.data.userId === userId
      ? eventSchema.parse({ ...event, kind: "message.updated", payload: parsed.data.message })
      : { ...event, payload: {} };
  }
  const id = messageEventId(event);
  if (id && hidden.has(id)) {
    const message = messageSchema.safeParse(event.payload);
    return message.success ? eventSchema.parse({ ...event, payload: deletedMessage(message.data) }) : { ...event, kind: "message.deleted", payload: {} };
  }
  return event;
}
