import { useCallback, useRef, useSyncExternalStore } from "react";
import type { HubConnection } from "./connection.js";

/** Subscribe to the fields a view actually uses. Cache revisions for unrelated
 * conversations must not invalidate every mounted run/question card. */
export function useConnectionSelection<T extends object>(connection: HubConnection, select: (connection: HubConnection) => T): T {
  const previous = useRef<{ connection: HubConnection; value: T } | undefined>(undefined);
  const subscribe = useCallback((notify: () => void) => connection.subscribe(notify), [connection]);
  const snapshot = () => {
    const next = select(connection), old = previous.current;
    const keys = Object.keys(next) as (keyof T)[];
    if (!old || old.connection !== connection || keys.length !== Object.keys(old.value).length || keys.some(key => !Object.is(next[key], old.value[key]))) previous.current = { connection, value: next };
    return previous.current!.value;
  };
  return useSyncExternalStore(subscribe, snapshot);
}
