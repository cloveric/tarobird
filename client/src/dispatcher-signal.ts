import { useCallback, useSyncExternalStore } from "react";
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
 * → ask, running → working, blocked → failed, awaiting review → done. */
export function ticketSignal(tickets: readonly TicketOverview[]): AgentSignal {
  let signal: AgentSignal = IDLE_AGENT;
  for (const ticket of tickets) {
    const attempt = ticket.attempts.at(-1), stopping = !!attempt?.stopRequested && !attempt.endedAt;
    const state: AgentState | undefined = ticket.status === "needs_answer" || ticket.status === "working" && attempt?.waitingFor && !stopping ? "ask" : ticket.status === "working" && (!ticket.paused || stopping) ? "working"
      : ticket.status === "blocked" ? "failed" : ticket.status === "needs_review" ? "done" : undefined;
    if (state) signal = mergeAgentSignals(signal, { state, at: ticket.updatedAt });
  }
  return signal;
}

// One shared poll per Host connection and dispatcher, however many rows show it.
// An open ticket list publishes the same answer and pauses this poll while fresh.
type Entry = { signal?: AgentSignal; listeners: Set<() => void>; timer?: ReturnType<typeof setInterval>; request?: AbortController; reads: number; applied: number; freshUntil: number };
const entries = new WeakMap<HubConnection, Map<string, Entry>>();
function entry(connection: HubConnection, botId: string): Entry {
  let byBot = entries.get(connection);
  if (!byBot) entries.set(connection, byBot = new Map());
  let value = byBot.get(botId);
  if (!value) byBot.set(botId, value = { listeners: new Set(), reads: 0, applied: 0, freshUntil: 0 });
  return value;
}
/** Numbers a read of this dispatcher's tickets in start order. */
export function beginTicketRead(connection: HubConnection, botId: string): number { return ++entry(connection, botId).reads; }
/** Publishes a read's tickets unless a later-started read already did, so a
 * delayed response never reverts a newer state. `fresh` pauses the shared poll
 * for one interval; a list that stops publishing releases it on its own. */
export function publishTicketSignal(connection: HubConnection, botId: string, read: number, tickets: readonly TicketOverview[], fresh = false): void {
  const value = entry(connection, botId);
  if (fresh) value.freshUntil = Date.now() + POLL_MS;
  if (read <= value.applied) return;
  value.applied = read;
  const next = ticketSignal(tickets);
  if (next.state !== value.signal?.state || next.at !== value.signal.at) { value.signal = next; for (const listener of value.listeners) listener(); }
}
async function poll(connection: HubConnection, botId: string, value: Entry): Promise<void> {
  if (value.request || Date.now() < value.freshUntil || connection.state.status !== "online" || !connection.state.dispatchAvailable || connection.isReadOnly || document.visibilityState === "hidden") return;
  const controller = new AbortController(), read = beginTicketRead(connection, botId), request = queueRequest([controller.signal], READ_MS);
  value.request = controller;
  try {
    const list = ticketOverviewListSchema.parse(await request.wait(connection.http(`/api/bots/${encodeURIComponent(botId)}/tickets?open=1&summary=1`, { signal: request.signal })));
    if (!controller.signal.aborted) publishTicketSignal(connection, botId, read, list.tickets);
  } catch { /* A missed or abandoned poll keeps the last known state; the next one retries. */ }
  finally { request.dispose(); if (value.request === controller) value.request = undefined; }
}

/** Ticket state for a dispatcher's list avatar; undefined for other rows. */
export function useTicketSignal(connection: HubConnection | undefined, botId: string | undefined): AgentSignal | undefined {
  const subscribe = useCallback((notify: () => void) => {
    if (!connection || !botId) return () => undefined;
    const value = entry(connection, botId);
    value.listeners.add(notify);
    if (!value.timer) { void poll(connection, botId, value); value.timer = setInterval(() => void poll(connection, botId, value), POLL_MS); }
    return () => {
      value.listeners.delete(notify);
      if (!value.listeners.size && value.timer) { clearInterval(value.timer); value.timer = undefined; value.request?.abort(); value.request = undefined; }
    };
  }, [connection, botId]);
  return useSyncExternalStore(subscribe, () => connection && botId ? entries.get(connection)?.get(botId)?.signal : undefined);
}
