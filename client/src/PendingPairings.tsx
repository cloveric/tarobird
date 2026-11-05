import { anySignal, timeoutSignal } from "./abort-signals.js";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { HubConnection } from "./connection.js";
import { HubHttpError } from "./http-error.js";
import { platformName } from "./SettingsParts.js";
import { t } from "./i18n.js";

type Request = { deviceId: string; name: string; platform: string; expiresAt: number };
/** Read-only hints. A name or a pending request can never authorize a device:
 * approval still requires its eight-digit code and the existing signed action. */
export function PendingPairings({ connection, confirm }: { connection: HubConnection; confirm?: () => void }) {
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const owner = state.user?.role === "owner";
  const [requests, setRequests] = useState<Request[]>([]), [failed, setFailed] = useState(false);
  useEffect(() => {
    setRequests([]); setFailed(false);
    if (!owner) return;
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    const load = async () => {
      if (!active) return;
      if (document.visibilityState !== "hidden" && connection.state.status === "online") {
        try {
          const next = await connection.http<Request[]>("/api/devices/pending", { signal: anySignal([abort.signal, timeoutSignal(6000)]) });
          if (!active) return;
          setRequests(next); setFailed(false);
        } catch (error) {
          if (!active) return;
          // Older hosts can still approve by code, even without this read-only list.
          if (error instanceof HubHttpError && error.status === 404) return;
          setRequests([]); setFailed(true);
        }
      }
      if (active) timer = setTimeout(() => void load(), 5000);
    };
    void load();
    return () => { active = false; abort.abort(); clearTimeout(timer); };
  }, [connection, owner]);
  if (!owner) return null;
  if (failed) return <p className="settings-note muted">{t("暂时无法读取待确认设备，仍可输入新设备上的配对码确认。")}</p>;
  const live = requests.filter(request => request.expiresAt > Date.now() + (state.serverTimeOffset ?? 0));
  if (!live.length || connection.state.status !== "online") return null;
  return <section className="pairing-pending" aria-label={t("等待确认的设备")}>
    <strong>{t("等待确认的设备")}</strong>
    <ul>{live.map(request => <li key={request.deviceId}><span>{request.name}</span><small>{platformName(request.platform)} · ID …{request.deviceId.slice(-6)}</small></li>)}</ul>
    <p className="muted">{t("核对新设备上的 8 位配对码后再授权，设备名称不能代替配对码。")}</p>
    {confirm && <button type="button" className="primary" onClick={confirm}>{t("输入配对码确认")}</button>}
  </section>;
}
