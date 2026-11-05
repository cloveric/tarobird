import { useSyncExternalStore } from "react";
import type { HubConnection } from "./connection.js";
import { googleDocsErrorText } from "./google-docs-errors.js";

type ExportState = { busy?: true; url?: string; error?: string };
// Keep a single result across a recycled row, closed sheet, or layout change.
// Host identity is the connection object; identical message IDs never mix hosts.
const exportsByHost = new WeakMap<HubConnection, Map<string, ExportState>>();
const listeners = new Set<() => void>();
const state = (connection: HubConnection, messageId?: string) => messageId ? exportsByHost.get(connection)?.get(messageId) : undefined;
function setState(connection: HubConnection, messageId: string, value: ExportState) {
  let host = exportsByHost.get(connection);
  if (!host) exportsByHost.set(connection, host = new Map());
  host.set(messageId, value); listeners.forEach(notify => notify());
}
const subscribe = (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify); }; };

export function useMessageExport(connection: HubConnection, messageId?: string) {
  const exported = useSyncExternalStore(subscribe, () => state(connection, messageId));
  const send = async () => {
    if (!messageId) return;
    const previous = state(connection, messageId);
    if (previous?.busy) return;
    setState(connection, messageId, { busy: true, url: previous?.url });
    try {
      const result = await connection.http<{ url: string }>("/api/gdocs/export", { method: "POST", body: JSON.stringify({ messageId }) });
      if (!/^https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+\/edit$/.test(result.url)) throw new Error("invalid_document_url");
      setState(connection, messageId, { url: result.url });
    } catch (e) { setState(connection, messageId, { url: previous?.url, error: googleDocsErrorText(e instanceof Error ? e.message : "unknown") }); }
  };
  return { exported, send };
}
