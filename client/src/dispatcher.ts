import { useSyncExternalStore } from "react";
import type { Conversation, Message } from "../../src/client-protocol/index.js";
import { messageAttention } from "./attention.js";

/** dispatch.v1: chosen only at creation. Other or unknown roles display as ordinary Bots. */
export const isDispatcher = (bot?: { role?: string }) => bot?.role === "dispatcher";

// Device-local preference shared by every host list. Hidden ticket conversations
// stay out of lists until the owner opts in to see and handle them.
let visible = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => visible;
export function setTicketConversationsVisible(value: boolean): void {
  if (visible === value) return;
  visible = value;
  for (const listener of listeners) listener();
}
export const ticketConversationsVisible = snapshot;
export function useTicketConversationsVisible(): boolean { return useSyncExternalStore(subscribe, snapshot, snapshot); }

/** A hidden ticket conversation with an open approval or question for the
 * owner: it is listed, counted and notified like any other while it waits. */
export function waitsForOwner(activity: { attention?: Record<string, unknown> } | undefined): boolean {
  return !!activity?.attention && Object.keys(activity.attention).length > 0;
}

/** Whether `message` may raise a desktop notice even in a hidden ticket
 * conversation: the device lists those, or it is an open approval or question
 * (the same request that keeps the conversation listed while it waits). */
export function notifiesWhileHidden(message: Message): boolean {
  return visible || !!messageAttention(message);
}

/** Lists, counts, pickers and avatar signals skip a dispatcher's hidden worker
 * conversations, unless one waits for the owner (with `activity` given).
 * Opening one by ID (the ticket panel) still uses the full cache. */
export function listedConversations<T extends Pick<Conversation, "hidden" | "id">>(conversations: readonly T[], activity?: Readonly<Record<string, { attention?: Record<string, unknown> } | undefined>>): T[] {
  return visible || !conversations.some(chat => chat.hidden) ? conversations as T[] : conversations.filter(chat => !chat.hidden || waitsForOwner(activity?.[chat.id]));
}

/** A Host notice in a dispatcher's conversation (a ticket settled or resumed).
 * Only Hub-stamped Host notices carry both a `tn_*` clientMsgId and a `tk_*`
 * request ID; Bot-to-Bot messages always receive `bm_*` and never collapse here. */
export const isTicketNotice = (message: Pick<Message, "authorType" | "botSource" | "clientMsgId">, dispatcherChat: boolean) =>
  dispatcherChat && message.authorType === "user" && !!message.botSource && !!message.clientMsgId?.startsWith("tn_") && /^tk_/.test(message.botSource.requestId);
/** The notice's first line without the ticket ID, e.g. 【工单完成】「写周报」由 Codex（…）完成，等待验收。 */
export const ticketNoticeSummary = (text: string) => (text.split("\n", 1)[0] ?? "").replace(/（tk_[A-Za-z0-9_-]+）/u, "").trim();
