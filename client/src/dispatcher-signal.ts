import { useCallback, useRef, useSyncExternalStore } from "react";
import { ticketOverviewListSchema, type TicketOverview } from "../../src/client-protocol/dispatch.js";
import type { HubConnection } from "./connection.js";
import { IDLE_AGENT, type AgentSignal, type AgentState } from "./agent-state.js";
import { queueRequest } from "./prompt-queue-request.js";

const POLL_MS = 8_000, READ_MS = 8_000;
const rank: Record<AgentState, number> = { idle: 0, done: 1, failed: 1, working: 2, ask: 3 };

/** A question outranks running work, which outranks a finished result; the newest wins a tie. */
export function mergeAgentSignals(base: AgentSignal, extra?: AgentSignal): AgentSignal {
  if (!extra || rank[extra.state] < rank[base.state] || rank[extra.state] === rank[base.state] && extra.at <= base.at) return base;
  return extra;
}

/** A dispatcher's open tickets as one list-avatar state: waiting for an answer
 * → ask, running → working, blocked → failed, awaiting review → done.
 * Pass `conversationId` or `conversationIds` to scope the state to specific chats. */
export function ticketSignal(tickets: readonly TicketOverview[], scope?: string | readonly string[]): AgentSignal {
  let signal: AgentSignal = IDLE_AGENT;
  const filter = scope === undefined ? undefined : typeof scope === "string" ? new Set([scope]) : new Set(scope);
  for (const ticket of tickets) {
    if (filter && !filter.has(ticket.conversationId)) continue;
    const attempt = ticket.attempts.at(-1), stopping = !!attempt?.stopRequested && !attempt.endedAt;
    const state: AgentState | undefined = ticket.status === "needs_answer" || ticket.status === "working" && attempt?.waitingFor && !stopping ? "ask" : ticket.status === "working" && (!ticket.paused || stopping) ? "working"
      : ticket.status === "blocked" ? "failed" : ticket.status === "needs_review" ? "done" : undefined;
    if (state) signal = mergeAgentSignals(signal, { state, at: ticket.updatedAt });
  }
  return signal;
}

// One shared poll per Host connection and dispatcher, however many rows show it.
// An open ticket list publishes the same answer and pauses this poll while fresh.
type Entry = {
  signal?: AgentSignal;
  byConversation: Map<string, AgentSignal>;
  listeners: Set<() => void>;
  timer?: ReturnType<typeof setInterval>;
  request?: AbortController;
  reads: number;
  applied: number;
  conversationApplied: Map<string, number>;
  freshUntil: number;
};
const entries = new WeakMap<HubConnection, Map<string, Entry>>();
function entry(connection: HubConnection, botId: string): Entry {
  let byBot = entries.get(connection);
  if (!byBot) entries.set(connection, byBot = new Map());
  let value = byBot.get(botId);
  if (!value) byBot.set(botId, value = { byConversation: new Map(), listeners: new Set(), reads: 0, applied: 0, conversationApplied: new Map(), freshUntil: 0 });
  return value;
}
function sameSignal(a?: AgentSignal, b?: AgentSignal): boolean {
  return a?.state === b?.state && a?.at === b?.at;
}
function notifyListeners(value: Entry): void {
  for (const listener of value.listeners) listener();
}
function recomputeGlobalSignal(value: Entry): AgentSignal {
  let next: AgentSignal = IDLE_AGENT;
  for (const signal of value.byConversation.values()) next = mergeAgentSignals(next, signal);
  return next;
}
/** Numbers a read of this dispatcher's tickets in start order. */
export function beginTicketRead(connection: HubConnection, botId: string): number { return ++entry(connection, botId).reads; }
/** Publishes a read's tickets unless a later-started read already did, so a
 * delayed response never reverts a newer state. `fresh` pauses the shared poll
 * for one interval; a list that stops publishing releases it on its own.
 * Pass `conversationId` when the read only covers one conversation. */
export function publishTicketSignal(connection: HubConnection, botId: string, read: number, tickets: readonly TicketOverview[], fresh = false, conversationId?: string): void {
  const value = entry(connection, botId);
  if (fresh) value.freshUntil = Date.now() + POLL_MS;
  if (conversationId) {
    if (read <= (value.conversationApplied.get(conversationId) ?? value.applied)) return;
    value.conversationApplied.set(conversationId, read);
    const nextChat = ticketSignal(tickets, conversationId);
    const prevChat = value.byConversation.get(conversationId);
    let changed = false;
    if (nextChat.state === "idle") {
      if (prevChat && prevChat.state !== "idle") { value.byConversation.delete(conversationId); changed = true; }
    } else if (!sameSignal(prevChat, nextChat)) {
      value.byConversation.set(conversationId, nextChat);
      changed = true;
    }
    const nextGlobal = recomputeGlobalSignal(value);
    if (!sameSignal(value.signal, nextGlobal)) { value.signal = nextGlobal; changed = true; }
    if (changed) notifyListeners(value);
    return;
  }
  if (read <= value.applied) return;
  value.applied = read;
  const grouped = new Map<string, TicketOverview[]>();
  for (const ticket of tickets) {
    let bucket = grouped.get(ticket.conversationId);
    if (!bucket) grouped.set(ticket.conversationId, bucket = []);
    bucket.push(ticket);
  }
  const nextByConversation = new Map<string, AgentSignal>();
  for (const [id, existing] of value.byConversation) {
    if ((value.conversationApplied.get(id) ?? 0) > read) nextByConversation.set(id, existing);
  }
  for (const [id, list] of grouped) {
    if ((value.conversationApplied.get(id) ?? 0) > read) continue;
    const chatSignal = ticketSignal(list);
    if (chatSignal.state !== "idle") nextByConversation.set(id, chatSignal);
  }
  let changed = nextByConversation.size !== value.byConversation.size;
  if (!changed) {
    for (const [id, signal] of nextByConversation) {
      if (!sameSignal(value.byConversation.get(id), signal)) { changed = true; break; }
    }
  }
  value.byConversation = nextByConversation;
  const nextGlobal = recomputeGlobalSignal(value);
  if (!sameSignal(value.signal, nextGlobal)) { value.signal = nextGlobal; changed = true; }
  if (changed) notifyListeners(value);
}
async function poll(connection: HubConnection, botId: string, value: Entry): Promise<void> {
  if (value.request || Date.now() < value.freshUntil || connection.state?.status !== "online" || !connection.state.dispatchAvailable || connection.state.user?.role !== "owner" || connection.isReadOnly || document.visibilityState === "hidden") return;
  const controller = new AbortController(), read = beginTicketRead(connection, botId), request = queueRequest([controller.signal], READ_MS);
  value.request = controller;
  try {
    const list = ticketOverviewListSchema.parse(await request.wait(connection.http(`/api/bots/${encodeURIComponent(botId)}/tickets?open=1&summary=1`, { signal: request.signal })));
    if (!controller.signal.aborted) publishTicketSignal(connection, botId, read, list.tickets);
  } catch { /* A missed or abandoned poll keeps the last known state; the next one retries. */ }
  finally { request.dispose(); if (value.request === controller) value.request = undefined; }
}

function readEntrySignal(connection: HubConnection | undefined, botIds: readonly string[], conversationIds?: readonly string[]): AgentSignal | undefined {
  if (!connection || !botIds.length) return undefined;
  const byBot = entries.get(connection);
  if (!byBot) return undefined;
  let result: AgentSignal | undefined;
  for (const botId of botIds) {
    const value = byBot.get(botId);
    if (!value) continue;
    if (!conversationIds) {
      if (value.signal) result = result ? mergeAgentSignals(result, value.signal) : value.signal;
    } else if (value.signal !== undefined) {
      let chatSignal: AgentSignal = IDLE_AGENT;
      for (const conversationId of conversationIds) {
        const found = value.byConversation.get(conversationId);
        if (found) chatSignal = mergeAgentSignals(chatSignal, found);
      }
      result = result ? mergeAgentSignals(result, chatSignal) : chatSignal;
    }
  }
  return result;
}

/** Ticket state for one or more dispatchers, optionally scoped to specific conversations. */
export function useTicketSignals(connection: HubConnection | undefined, botIds: readonly string[] | undefined, conversationIds?: readonly string[]): AgentSignal | undefined {
  const botKey = botIds?.length ? botIds.join("\0") : "";
  const convKey = conversationIds ? conversationIds.join("\0") : "";
  const hasConvScope = conversationIds !== undefined;
  const subscribe = useCallback((notify: () => void) => {
    if (!connection || !botKey) return () => undefined;
    const ids = botKey.split("\0");
    const cleanups = ids.map(botId => {
      const value = entry(connection, botId);
      value.listeners.add(notify);
      if (!value.timer) { void poll(connection, botId, value); value.timer = setInterval(() => void poll(connection, botId, value), POLL_MS); }
      return () => {
        value.listeners.delete(notify);
        if (!value.listeners.size && value.timer) { clearInterval(value.timer); value.timer = undefined; value.request?.abort(); value.request = undefined; }
      };
    });
    return () => { for (const cleanup of cleanups) cleanup(); };
  }, [connection, botKey]);
  const cached = useRef<AgentSignal | undefined>(undefined);
  const getSnapshot = useCallback(() => {
    const next = readEntrySignal(connection, botKey ? botKey.split("\0") : [], hasConvScope ? (convKey ? convKey.split("\0") : []) : undefined);
    if (sameSignal(cached.current, next)) return cached.current;
    return (cached.current = next);
  }, [connection, botKey, convKey, hasConvScope]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Ticket state for a dispatcher's list avatar; undefined for other rows. */
export function useTicketSignal(connection: HubConnection | undefined, botId: string | undefined, conversationId?: string): AgentSignal | undefined {
  return useTicketSignals(connection, botId ? [botId] : undefined, conversationId !== undefined ? [conversationId] : undefined);
}
