import { useCallback, useEffect, useRef, useState } from "react";
import type { HubConnection } from "./connection.js";

type Result<T> = { connection: HubConnection; botId: string; data?: T; pending?: "read" | "save"; error?: unknown; saved?: boolean };
/** Settings reads can be abandoned; saves retain an explicit, bounded receipt.
 * A response belongs to one connection and Bot even if membership changes while
 * its request is in flight. Aborting a save does not imply it was rolled back. */
export function useBotSettingsRequest<T>(connection: HubConnection, botId: string, kind: "permissions" | "effort" | "persona" | "model" | "chrome" | "dispatcher", schema: { parse: (raw: unknown) => T }) {
  const [result, setResult] = useState<Result<T>>({ connection, botId });
  const current = useRef<{ controller: AbortController; timer: ReturnType<typeof setTimeout>; method: "GET" | "PUT" } | undefined>(undefined);
  const cancel = useCallback(() => {
    const previous = current.current; current.current = undefined;
    if (previous) { clearTimeout(previous.timer); previous.controller.abort(); }
  }, []);
  const request = useCallback(async (method: "GET" | "PUT", body?: unknown) => {
    if (!botId || current.current?.method === "PUT") return;
    cancel();
    const controller = new AbortController(), operation = { controller, timer: setTimeout(() => controller.abort(), 20_000), method };
    current.current = operation;
    setResult(previous => ({ connection, botId, ...(method === "PUT" && previous.connection === connection && previous.botId === botId ? { data: previous.data } : {}), pending: method === "GET" ? "read" : "save" }));
    try {
      const raw = await connection.http(`/api/bots/${botId}/${kind}`, { method, signal: controller.signal, ...(method === "PUT" ? { body: JSON.stringify(body) } : {}) });
      if (current.current !== operation) return;
      setResult({ connection, botId, data: schema.parse(raw), saved: method === "PUT" });
    } catch (error) {
      if (current.current === operation) setResult(previous => ({ connection, botId, error, ...(method === "PUT" && previous.connection === connection && previous.botId === botId ? { data: previous.data } : {}) }));
    } finally {
      clearTimeout(operation.timer);
      if (current.current === operation) current.current = undefined;
    }
  }, [connection, botId, kind, schema, cancel]);
  useEffect(() => { void request("GET"); return cancel; }, [request, cancel]);
  const active = result.connection === connection && result.botId === botId ? result : undefined;
  return { data: active?.data, error: active?.error, saved: !!active?.saved, busy: !active || !!active.pending, saving: active?.pending === "save", load: () => request("GET"), save: (body: unknown) => request("PUT", body) };
}
