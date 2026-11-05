import { useSyncExternalStore } from "react";
import type { Conversation, Message } from "../../src/client-protocol/index.js";

/** dispatch.v1: chosen only at creation. Other or unknown roles display as ordinary Bots. */
export const isDispatcher = (bot?: { role?: string }) => bot?.role === "dispatcher";

// Device-local debug preference shared by every host list, like the avatar
// motion switch. Off by default: worker conversations stay out of lists.
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

/** Lists, counts, pickers and avatar signals skip a dispatcher's hidden worker
 * conversations. Opening one by ID (the ticket panel) still uses the full cache. */
export function listedConversations<T extends Pick<Conversation, "hidden">>(conversations: readonly T[]): T[] {
  return visible || !conversations.some(chat => chat.hidden) ? conversations as T[] : conversations.filter(chat => !chat.hidden);
}

/** A Host notice in a dispatcher's conversation (a ticket settled or resumed).
 * Only these carry a ticket ID as their Bot-message request ID there. */
export const isTicketNotice = (message: Pick<Message, "authorType" | "botSource">, dispatcherChat: boolean) =>
  dispatcherChat && message.authorType === "user" && !!message.botSource && /^tk_/.test(message.botSource.requestId);
/** The notice's first line without the ticket ID, e.g. 【工单完成】「写周报」由 Codex（…）完成，等待验收。 */
export const ticketNoticeSummary = (text: string) => (text.split("\n", 1)[0] ?? "").replace(/（tk_[A-Za-z0-9_-]+）/u, "").trim();
