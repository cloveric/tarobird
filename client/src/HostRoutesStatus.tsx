import { useEffect, useState, useSyncExternalStore } from "react";
import { HOST_ROUTES_PATH, hostRoutesViewSchema, type HostRoutesView } from "../../src/client-protocol/host-routes.js";
import type { Route } from "../../src/client-protocol/routes.js";
import type { HubConnection } from "./connection.js";
import { t } from "./i18n.js";

/** Owner-only read of the host's own LAN/Tailscale listener view. */
export function useHostRoutesView(connection: HubConnection): HostRoutesView | undefined {
  const [view, setView] = useState<HostRoutesView>();
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state), key = connection.identity.hubPublicKey;
  const available = state.hostRoutesAvailable && state.user?.role === "owner" && state.status === "online";
  useEffect(() => {
    setView(undefined);
    if (!available) return;
    const controller = new AbortController();
    void connection.http(HOST_ROUTES_PATH, { signal: controller.signal }).then(raw => {
      const result = hostRoutesViewSchema.parse(raw);
      if (!controller.signal.aborted && result.hostPublicKey === key) setView(result);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [connection, available, key]);
  return available ? view : undefined;
}

/** The host's entry addresses for other devices, one row per enabled mode.
 * Loopback is never published, so these never duplicate 主机直连. */
export function hostEntries(view: HostRoutesView): { mode: "lan" | "tailscale"; route: Route; listening: boolean; confirmationRequired: boolean }[] {
  const seen = new Set<string>(), entries: { mode: "lan" | "tailscale"; route: Route; listening: boolean; confirmationRequired: boolean }[] = [];
  for (const [mode, name] of [["lan", "Direct"], ["tailscale", "Tailscale"]] as const) {
    if (!view.local[mode].enabled) continue;
    // A listening mode may still retain an old address while the host waits
    // for replacement/selection. The replacement notice has no mode field;
    // until it clears, neither address has individual readiness evidence.
    const listening = view.local[mode].listening;
    const confirmationRequired = listening && (view.notices.includes("replacement_pending") || (mode === "lan"
      ? view.notices.includes("lan_selection_required") || view.notices.includes("lan_not_listening")
      : view.notices.includes("tailscale_not_listening")));
    for (const { route } of view.routes) if (route.name === name && !seen.has(route.url)) { seen.add(route.url); entries.push({ mode, route, listening, confirmationRequired }); }
  }
  return entries;
}

/** Read-only host-side listener status. This is not a claim that the phone's
 * VPN, tailnet policy, or the end-to-end path is working. */
export function HostRoutesStatus({ connection, view }: { connection: HubConnection; view?: HostRoutesView }) {
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  if (!view) return null;
  const status = (mode: HostRoutesView["local"]["lan"]) => !mode.enabled ? t("未开启") : mode.listening ? t("已开启，正在监听") : t("已开启，当前未监听");
  // Only the synchronizer knows the saved base and manual route provenance.
  // Keep this explicitly historical; listener reads do not run a fresh merge.
  const limited = Object.values(state.routeSync ?? {}).some(result => result.limited);
  return <>{limited && <p className="settings-note" role="status">{t("上次同步时线路数量已达上限，部分主机线路未添加。请在编辑线路中腾出空间，随后会自动重试。")}</p>}<details className="settings-help host-route-status"><summary>{t("主机入口状态")}</summary>
    <dl><div><dt>{t("局域网入口")}</dt><dd>{status(view.local.lan)}</dd></div><div><dt>{t("Tailscale 入口")}</dt><dd>{status(view.local.tailscale)}</dd></div></dl>
    {view.notices.includes("lan_selection_required") && <p>{t("无法确认新的局域网地址是否来自原网卡，未自动替换。请在主机准备连接时选择正确网络，再扫码添加。")}</p>}
    {view.notices.includes("tailscale_not_listening") && <p>{t("Tailscale 入口当前未监听。请确认主机上的 Tailscale 已连接，主机仍在运行。")}</p>}
    {view.notices.includes("replacement_pending") && <p>{t("主机地址发生变化，正在等待稳定后同步。现有线路会保留。")}</p>}
    <p className="muted">{t("这是主机端的入口状态；手机仍需开启 Tailscale，并且网络访问规则允许连接。")}</p>
  </details></>;
}
