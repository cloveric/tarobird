import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { HubConnection } from "./connection.js";
import { t } from "./i18n.js";

export function useAttachment(connection: HubConnection, id: string, enabled = true, interactive = false): { url?: string; blob?: Blob; error?: string; retry: () => void } {
  const status = useSyncExternalStore((notify) => connection.subscribe(notify), () => connection.state.status);
  const [state, setState] = useState<{ connection: HubConnection; id: string; blob?: Blob; error?: string }>();
  const [attempt, setAttempt] = useState(0), retryPending = useRef(false);
  useEffect(() => {
    // A route transition invalidates unfinished transfers, not an authenticated
    // original already in memory. Keep it readable even above the cache limit.
    if (!enabled) { setState(undefined); return; }
    if (state?.connection === connection && state.id === id && state.blob) return;
    let disposed = false; retryPending.current = false; setState(undefined);
    const lease = connection.acquireAttachment(id, interactive);
    void lease.promise.then(blob => { if (!disposed) setState({ connection, id, blob }); })
      .catch((e: unknown) => { if (!disposed && !(e instanceof Error && e.name === "AbortError")) setState({ connection, id, error: e instanceof Error ? e.message : t("附件不可用") }); });
    return () => { disposed = true; lease.release(); };
  }, [connection, id, status, enabled, attempt, interactive]);
  const current = enabled && state?.connection === connection && state.id === id ? state : undefined;
  const [resource, setResource] = useState<{ blob: Blob; url: string }>();
  useEffect(() => {
    if (!current?.blob) { setResource(undefined); return; }
    const blob = current.blob, url = URL.createObjectURL(blob);
    setResource({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [current?.blob]);
  const url = current?.blob && resource?.blob === current.blob ? resource.url : undefined;
  return { ...current, url, retry: () => {
    if (!current?.error || retryPending.current) return;
    retryPending.current = true; setState(undefined); setAttempt(value => value + 1);
  } };
}
