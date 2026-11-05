import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";

const emptyMessages: Message[] = [];
type View = { connection: HubConnection; conversationId: string; messages: Message[]; failed: boolean; readRevision: number };
// Leave decoding room between reads, but a stalled read must not impose an
// equally long second wait after storage has recovered.
export const MIN_HISTORY_READ_GAP_MS = 80;
export const MAX_HISTORY_READ_GAP_MS = 1000;

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
    let disposed = false, running = false, dirty = false, immediate = false, lastEnd = 0, lastCost = 0;
    let wake: (() => void) | undefined;
    let revision = scoped ? connection.conversationRevision(conversationId) : connection.state.cacheRevision;
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
          // The first read is immediate; later ones leave the main thread idle
          // for a bounded duration based on its cost. A user-requested retry
          // skips the gap, including one already being awaited.
          const gap = Math.min(MAX_HISTORY_READ_GAP_MS, Math.max(MIN_HISTORY_READ_GAP_MS, lastCost));
          const wait = lastEnd && !immediate ? lastEnd + gap - performance.now() : 0;
          if (wait > 0) {
            await new Promise<void>(resolve => {
              const timer = setTimeout(resolve, wait);
              wake = () => { clearTimeout(timer); resolve(); };
            });
            wake = undefined;
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
            // Publish each completed read so a continuous stream cannot starve
            // rendering. A revision received during it requests one fresh read.
            const visibleMessages = messages.filter(message => message.status !== "deleted");
            if (!disposed) setView(previous => ({ connection, conversationId, failed: false, readRevision,
              messages: previous?.connection === connection && previous.conversationId === conversationId ? shareMessages(previous.messages, visibleMessages) : visibleMessages,
            }));
          } catch {
            if (!disposed) setView(previous => ({ connection, conversationId,
              messages: previous?.connection === connection && previous.conversationId === conversationId ? previous.messages : emptyMessages,
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
      if (next === revision) return;
      revision = next;
      refresh();
    });
    request.current = () => refresh(true);
    refresh();
    return () => { disposed = true; wake?.(); unsubscribe(); request.current = () => {}; };
  }, [connection, conversationId, visible, scoped]);
  // A hidden host retains its reading position, but another conversation must
  // never render the previous conversation's messages while its read is pending.
  const current = view?.connection === connection && view.conversationId === conversationId ? view : undefined;
  return { readRevision: current?.readRevision ?? -1, messages: current?.messages ?? emptyMessages, failed: current?.failed ?? false, ready: !!current && !current.failed, retry };
}
