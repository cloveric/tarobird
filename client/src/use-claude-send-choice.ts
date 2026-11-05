import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { HubConnection } from './connection.js';

type Choice = { targetId?: string };
type Store = { choices: Map<string, Choice>; listeners: Set<() => void> };
const stores = new WeakMap<HubConnection, Store>();
function storeFor(connection: HubConnection) {
  let store = stores.get(connection);
  if (!store) { store = { choices: new Map(), listeners: new Set() }; stores.set(connection, store); }
  return store;
}

/** An explicit next-turn choice belongs to this conversation and live task.
 * Never persisted as a preference; an unfinished draft retains its intent when
 * a task ends. Unknown/offline status is not evidence that the task ended. */
export function useClaudeSendChoice(connection: HubConnection, conversationId: string, botId: string | undefined, status: { targetId?: string; idle?: boolean }, hasDraft: boolean) {
  const store = storeFor(connection), key = `${conversationId}:${botId ?? ''}`;
  const subscribe = useCallback((notify: () => void) => { store.listeners.add(notify); return () => { store.listeners.delete(notify); }; }, [store]);
  const snapshot = useCallback(() => store.choices.get(key), [store, key]);
  const choice = useSyncExternalStore(subscribe, snapshot);
  const update = useCallback((next?: Choice) => {
    if (next) store.choices.set(key, next); else store.choices.delete(key);
    for (const notify of store.listeners) notify();
  }, [store, key]);
  useEffect(() => {
    if (!choice || (!status.targetId && !status.idle) || choice.targetId === status.targetId) return;
    // A newer choice made before this effect must never be erased by it.
    if (store.choices.get(key) !== choice) return;
    update(hasDraft ? { targetId: status.targetId } : undefined);
  }, [store, key, choice, status.targetId, status.idle, hasDraft, update]);
  useEffect(() => {
    if (choice && status.idle && !hasDraft && store.choices.get(key) === choice) update();
  }, [store, key, choice, status.idle, hasDraft, update]);
  return { next: !!choice, choose: (next: boolean) => update(next ? { targetId: status.targetId } : undefined) };
}
