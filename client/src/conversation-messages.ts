import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";
import { markSendTimingHistoryRead } from "./send-timing.js";

const emptyMessages: Message[] = [];
const emptyDeletedClientMsgIds: ReadonlySet<string> = new Set();
type FilteredHistory = { visible: Message[]; deletedClientMsgIds: ReadonlySet<string> };
type View = { connection: HubConnection; conversationId: string; messages: Message[]; deletedClientMsgIds: ReadonlySet<string>; failed: boolean; readRevision: number };
// Leave decoding room between reads, but a stalled read must not impose an
// equally long second wait after storage has recovered.
export const MIN_HISTORY_READ_GAP_MS = 80;
export const MAX_HISTORY_READ_GAP_MS = 1000;

const filteredHistoryCache = new WeakMap<readonly Message[], FilteredHistory>();
const lastReadRevisions = new WeakMap<HubConnection, Map<string, number>>();
const MAX_REVISION_TRACKED = 32;

function filterRawHistory(raw: readonly Message[]): FilteredHistory {
  let filtered = filteredHistoryCache.get(raw);
  if (!filtered) {
    const visible: Message[] = [];
    let deletedClientMsgIds: Set<string> | undefined;
    for (const message of raw) {
      if (message.status === "deleted") {
        if (message.clientMsgId) (deletedClientMsgIds ??= new Set()).add(message.clientMsgId);
      } else {
        visible.push(message);
      }
    }
    filtered = { visible, deletedClientMsgIds: deletedClientMsgIds ?? emptyDeletedClientMsgIds };
    filteredHistoryCache.set(raw, filtered);
  }
  return filtered;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function peekCachedMessages(connection: HubConnection, conversationId: string): readonly Message[] | undefined {
  return (connection.cache as { peekMessages?: (id: string) => readonly Message[] | undefined }).peekMessages?.(conversationId);
}

function immediateRevision(connection: HubConnection, conversationId: string): number {
  return (connection as { conversationImmediateRevision?: (id: string) => number }).conversationImmediateRevision?.(conversationId) ?? 0;
}

function rememberReadRevision(connection: HubConnection, conversationId: string, revision: number): void {
  let map = lastReadRevisions.get(connection);
  if (!map) {
    map = new Map();
    lastReadRevisions.set(connection, map);
  }
  map.delete(conversationId);
  map.set(conversationId, revision);
  while (map.size > MAX_REVISION_TRACKED) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** Every IDB read returns fresh objects. Keep the previous object for a message
 * whose version and status are unchanged (versions advance on every content
 * change), so memoised rows only re-render for messages that actually changed.
 * Returns `previous` itself when nothing changed. */
export function shareMessages(previous: readonly Message[], next: Message[]): Message[] {
  if (!previous.length || !next.length) return next;
  const known = new Map(previous.map(message => [message.id, message]));
  let unchanged = previous.length === next.length;
  const shared = next.map((message, index) => {
    const prior = known.get(message.id);
    const kept = prior && prior.version === message.version && prior.status === message.status
      && prior.createdAt === message.createdAt && prior.blocks.length === message.blocks.length ? prior : message;
    if (kept !== previous[index]) unchanged = false;
    return kept;
  });
  return unchanged ? previous as Message[] : shared;
}

/** Coalesce updates and reuse the read slot when returning to a conversation. */
export function useConversationMessages(connection: HubConnection, conversationId: string, visible: boolean, scoped = false) {
  const [view, setView] = useState<View>();
  const pending = useRef(new WeakMap<HubConnection, Map<string, Promise<Message[]>>>());
  const request = useRef<() => void>(() => {});
  const retry = useCallback(() => request.current(), []);
  useEffect(() => {
    if (!visible || !conversationId) return;
    let reads = pending.current.get(connection);
    if (!reads) { reads = new Map(); pending.current.set(connection, reads); }
    const inFlight = reads;
    let disposed = false, running = false, dirty = false, immediate = false, lastCost = 0;
    let lastEnd: number | undefined;
    let wake: (() => void) | undefined;
    let revision = scoped ? connection.conversationRevision(conversationId) : connection.state.cacheRevision;
    let urgentRevision = immediateRevision(connection, conversationId);
    const refresh = (explicit = false) => {
      if (disposed) return;
      dirty = true;
      if (explicit) { immediate = true; wake?.(); }
      if (running) return;
      running = true;
      void (async () => {
        do {
          // Leaving a view fences its result, but does not cancel the IDB read.
          // On return, wait for that slot and then read current data. Reusing the
          // old result could briefly roll back a previously rendered message.
          const previous = inFlight.get(conversationId);
          if (previous) await previous.catch(() => undefined);
          if (disposed) break;
          // The first read is immediate; later IDB reads leave the main thread
          // idle for a bounded duration based on cost. Authoritative in-memory
          // cache hits (zero IDB read) and urgent user-send arrivals skip the gap.
          const cachedInMemory = !immediate && Boolean(peekCachedMessages(connection, conversationId));
          const gap = Math.min(MAX_HISTORY_READ_GAP_MS, Math.max(MIN_HISTORY_READ_GAP_MS, lastCost));
          const wait = lastEnd !== undefined && !immediate && !cachedInMemory ? lastEnd + gap - performance.now() : 0;
          // The send timing probe reports the time spent in this wait, not the
          // planned one: an urgent revision or an explicit retry ends it early,
          // and a skipped wait counts as zero.
          let gapWaitedMs = 0;
          if (wait > 0) {
            const waitStarted = performance.now();
            await new Promise<void>(resolve => {
              const timer = setTimeout(resolve, wait);
              wake = () => { clearTimeout(timer); resolve(); };
            });
            wake = undefined;
            gapWaitedMs = performance.now() - waitStarted;
            if (disposed) break;
          }
          immediate = false;
          dirty = false;
          let reading: Promise<Message[]> | undefined;
          const started = performance.now();
          try {
            const readRevision = connection.state.cacheRevision;
            reading = connection.cache.messages(conversationId);
            inFlight.set(conversationId, reading);
            const messages = await reading;
            rememberReadRevision(connection, conversationId, readRevision);
            // Publish each completed read so a continuous stream cannot starve
            // rendering. A revision received during it requests one fresh read.
            const { visible: visibleMessages, deletedClientMsgIds } = filterRawHistory(messages);
            if (!disposed) {
              const readEndAt = performance.now();
              markSendTimingHistoryRead(conversationId, visibleMessages, readEndAt, gapWaitedMs, readEndAt - started);
              setView(previous => {
                const sameScope = previous?.connection === connection && previous.conversationId === conversationId;
                const shared = sameScope ? shareMessages(previous.messages, visibleMessages) : visibleMessages;
                const sameDeleted = sameScope && sameSet(previous.deletedClientMsgIds, deletedClientMsgIds);
                const sharedDeleted = sameDeleted ? previous.deletedClientMsgIds : deletedClientMsgIds;
                if (sameScope && !previous.failed && previous.readRevision === readRevision && shared === previous.messages && sameDeleted) {
                  return previous;
                }
                return { connection, conversationId, failed: false, readRevision, messages: shared, deletedClientMsgIds: sharedDeleted };
              });
            }
          } catch {
            if (!disposed) setView(previous => ({ connection, conversationId,
              messages: previous?.connection === connection && previous.conversationId === conversationId ? previous.messages : emptyMessages,
              deletedClientMsgIds: previous?.connection === connection && previous.conversationId === conversationId ? previous.deletedClientMsgIds : emptyDeletedClientMsgIds,
              readRevision: previous?.connection === connection && previous.conversationId === conversationId ? previous.readRevision : -1,
              failed: true,
            }));
          } finally {
            if (reading && inFlight.get(conversationId) === reading) inFlight.delete(conversationId);
            lastEnd = performance.now(); lastCost = lastEnd - started;
          }
        } while (dirty && !disposed);
        running = false;
      })();
    };
    const unsubscribe = connection.subscribe(() => {
      const next = scoped ? connection.conversationRevision(conversationId) : connection.state.cacheRevision;
      const nextUrgent = immediateRevision(connection, conversationId);
      if (next === revision && nextUrgent === urgentRevision) return;
      const urgent = nextUrgent !== urgentRevision;
      revision = next;
      urgentRevision = nextUrgent;
      refresh(urgent);
    });
    request.current = () => refresh(true);
    refresh();
    return () => { disposed = true; wake?.(); unsubscribe(); request.current = () => {}; };
  }, [connection, conversationId, visible, scoped]);
  // A hidden host retains its reading position, but another conversation must
  // never render the previous conversation's messages while its read is pending.
  let current = view?.connection === connection && view.conversationId === conversationId ? view : undefined;
  if (!current && visible && conversationId) {
    const peeked = peekCachedMessages(connection, conversationId);
    if (peeked) {
      const readRevision = lastReadRevisions.get(connection)?.get(conversationId) ?? connection.state.cacheRevision;
      const { visible: visibleMessages, deletedClientMsgIds } = filterRawHistory(peeked);
      current = { connection, conversationId, messages: visibleMessages, deletedClientMsgIds, failed: false, readRevision };
    }
  }
  return { readRevision: current?.readRevision ?? -1, messages: current?.messages ?? emptyMessages, deletedClientMsgIds: current?.deletedClientMsgIds ?? emptyDeletedClientMsgIds, failed: current?.failed ?? false, ready: !!current && !current.failed, retry };
}
