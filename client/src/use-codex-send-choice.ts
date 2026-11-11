import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { HubConnection } from './connection.js';

type Status = { targetId?: string; idle?: boolean };
type Store = { targets: Map<string, string>; listeners: Set<() => void> };
const stores = new WeakMap<HubConnection, Store>();

/** Only a deliberate supplement has state. Every new Codex task defaults to
 * the ordinary queue; unknown/offline status is not proof of a new task. */
export function codexSupplementTarget(target: string | undefined, status: Status): string | undefined {
  return status.idle || status.targetId && status.targetId !== target ? undefined : target;
}

export function useCodexSendChoice(connection: HubConnection, conversationId: string, botId: string | undefined, status: Status) {
  let entry = stores.get(connection);
  if (!entry) { entry = { targets: new Map(), listeners: new Set() }; stores.set(connection, entry); }
  const store = entry, key = `${conversationId}:${botId ?? ''}`;
  const subscribe = useCallback((notify: () => void) => { store.listeners.add(notify); return () => { store.listeners.delete(notify); }; }, [store]);
  const snapshot = useCallback(() => store.targets.get(key), [store, key]);
  const selected = useSyncExternalStore(subscribe, snapshot);
  // Derive before effects: a new target must never render the old selection
  // for a frame or permit a click to supplement the wrong task.
  const targetId = codexSupplementTarget(selected, status);
  const choose = useCallback((next: boolean) => {
    if (!next) {
      // A repeated tap while the status poll is unavailable must not silently
      // change an existing supplement into an ordinary queued message.
      if (!status.targetId || status.idle) return;
      store.targets.set(key, status.targetId);
    } else store.targets.delete(key);
    for (const notify of store.listeners) notify();
  }, [store, key, status.targetId, status.idle]);
  useEffect(() => {
    if (selected && !targetId && store.targets.get(key) === selected) choose(true);
  }, [store, key, selected, targetId, choose]);
  return { targetId, choose };
}
