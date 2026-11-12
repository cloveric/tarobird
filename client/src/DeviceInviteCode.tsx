import { useEffect, useState, useSyncExternalStore } from "react";
import { HOST_ROUTES_PATH, hostRoutesViewSchema } from "../../src/client-protocol/host-routes.js";
import { isLoopbackOrUnspecified } from "../../src/client-protocol/loopback-address.js";
import { MAX_VPS_ROUTES } from "../../src/client-protocol/routes.js";
import type { HubConnection } from "./connection.js";
import type { Route } from "./storage.js";
import { anySignal, timeoutSignal } from "./abort-signals.js";
import { DesktopHostInvite } from "./DesktopHostInvite.js";
import { ConnectionInviteCode } from "./ConnectionInviteCode.js";
import { connectionPairingPayload } from "./pairing-link.js";
import { t, useLocale } from "./i18n.js";
import "./device-invite.css";

/** Displaying an invite only reads existing routes. Opening a listener remains
 * an explicit action in DesktopHostInvite; never restart a host to show a QR. */
export function DeviceInviteCode({ connection, localHost, busyChange }: { connection: HubConnection; localHost: boolean; busyChange?: (busy: boolean) => void }) {
  useLocale();
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const key = connection.identity.hubPublicKey!;
  const available = state.status === "online" && state.user?.role === "owner" && !!state.hostRoutesAvailable;
  const [read, setRead] = useState<{ key: string; routes: Route[]; failed?: boolean; unavailable?: boolean; unavailableNames?: Route["name"][]; selectionRequired?: boolean }>();
  const [preparing, setPreparing] = useState(false);
  useEffect(() => { busyChange?.(preparing); return () => busyChange?.(false); }, [preparing, busyChange]);
  const [prepared, setPrepared] = useState<{ key: string; route: Route; unavailableRouteCount?: number }>();
  const [retry, setRetry] = useState(0), [configure, setConfigure] = useState(false), [selected, setSelected] = useState("");
  useEffect(() => {
    setRead(previous => previous?.key === key && !previous.failed ? previous : undefined);
    setPrepared(previous => previous?.key === key ? previous : undefined);
    if (!available) return;
    const abort = new AbortController();
    void connection.http(HOST_ROUTES_PATH, { signal: anySignal([abort.signal, timeoutSignal(8000)]) }).then(raw => {
      const view = hostRoutesViewSchema.parse(raw);
      if (view.hostPublicKey !== key) throw new Error("invite_host_mismatch");
      const unavailableNames: Route["name"][] = [];
      if (view.notices.includes("lan_not_listening")) unavailableNames.push("Direct");
      if (view.notices.includes("tailscale_not_listening")) unavailableNames.push("Tailscale");
      if (!abort.signal.aborted) setRead({ key, routes: view.routes.map(entry => entry.route), unavailable: unavailableNames.length > 0, unavailableNames, selectionRequired: view.notices.includes("lan_selection_required") });
    }).catch(() => { if (!abort.signal.aborted) setRead({ key, routes: [], failed: true }); });
    return () => abort.abort();
  }, [connection, key, available, retry]);
  const loading = available && read?.key !== key;
  const failed = available && read?.key === key && read.failed;
  const saved = read?.key === key ? [...read.routes, ...connection.identity.routes.filter(route => route.name === "VPS" && !read.routes.some(other => other.url === route.url))] : available ? [] : connection.identity.routes;
  const source = prepared?.key === key ? [prepared.route, ...saved.filter(route => route.url !== prepared.route.url)] : saved;
  const routes = source.filter(route => {
    try { const url = new URL(route.url); return url.protocol === "https:" && !isLoopbackOrUnspecified(url.hostname); }
    catch { return false; }
  });
  const directs = routes.filter(route => route.name !== "VPS");
  // Keep QR v1's bounded relay list, preserving the connection in use first.
  const relays = routes.filter(route => route.name === "VPS").sort((a, b) => Number(b.url === state.route?.url) - Number(a.url === state.route?.url)).slice(0, MAX_VPS_ROUTES);
  const choices = [...directs, ...(relays.length ? [relays[0]!] : [])];
  const usable = choices.filter(route => prepared?.key === key && route.url === prepared.route.url || !(read?.key === key && read.unavailableNames?.includes(route.name)));
  const defaults = usable.length ? usable : choices;
  const chosen = choices.find(route => route.url === selected) ?? defaults.find(route => route.url === state.route?.url) ?? (localHost ? defaults.find(route => route.name === "Direct") : undefined) ?? defaults.find(route => route.name === "Tailscale") ?? defaults[0];
  const title = (route: Route) => route.name === "Tailscale" ? t("Tailscale") : route.name === "VPS" ? t("VPS 中转") : t("同一局域网");
  if (configure) return <div className="device-invite"><button type="button" disabled={preparing} onClick={() => { setConfigure(false); setRetry(value => value + 1); }}>{t("返回连接二维码")}</button><DesktopHostInvite compact connection={connection} hubKey={key} busyChange={setPreparing} onReady={(route, unavailableRouteCount) => { setPrepared({ key, route, unavailableRouteCount }); setSelected(route.url); setConfigure(false); }}/></div>;
  // The host's own report stays visible, next to the network choice it concerns.
  const unavailableWarning = !prepared && read?.key === key && read.unavailable && <p role="alert" className="settings-warning">{t("主机报告本地线路当前不可用。请检查网络后重新生成，或选择其他可用连接方式。")}</p>;
  return <section className="device-invite" aria-label={t("连接二维码")}>
    {state.status !== "online" && <p role="status" className="settings-warning">{t("当前主机离线。这里显示的是已保存的连接信息；请先恢复连接，再确认新设备。")}</p>}
    {!prepared && read?.key === key && read.selectionRequired && <p role="status" className="settings-note">{t("这台主机有多个局域网地址。请在主机电脑选择新设备所在的网络，再生成连接二维码。")}</p>}
    {loading ? <p role="status">{t("正在读取可用的连接二维码…")}</p> : failed ? <div role="alert"><p>{t("未能读取主机的连接信息，请重试。现有连接不会改变。")}</p><button type="button" onClick={() => setRetry(value => value + 1)}>{t("重试")}</button></div> : chosen ? <>
      <div className="device-invite-route">{choices.length > 1 ? <label>{t("新设备通过什么网络连接？")}<select value={chosen.url} onChange={event => setSelected(event.target.value)}>{choices.map(route => <option key={route.url} value={route.url}>{title(route)}{choices.filter(other => other.name === route.name).length > 1 ? ` · ${new URL(route.url).hostname}` : ""}</option>)}</select></label> : <strong>{title(chosen)}</strong>}{unavailableWarning}</div>
      <ConnectionInviteCode connection={connection} payload={connectionPairingPayload(key, chosen.name === "VPS" ? relays : [chosen, ...relays], connection.identity.deployment, chosen.url)}/>
      <p className="settings-note device-invite-note">{chosen.name === "Tailscale" ? t("新设备和主机都需开启 Tailscale，并允许互相访问。") : chosen.name === "VPS" ? t("新设备联网即可通过已配置的中转连接主机。") : t("新设备与主机需连接同一 Wi-Fi 或局域网。")} {t("扫码后仍需核对 8 位配对码并确认，才会授权新设备。")}</p>
    </> : <>
      {unavailableWarning}
      <p className="settings-note">{localHost ? t("首次设置：选择连接方式并生成二维码。") : t("此主机尚未提供可分享的连接地址。请在主机电脑打开「添加设备」，生成连接二维码。")}</p>
      {localHost && <DesktopHostInvite compact connection={connection} hubKey={key} busyChange={setPreparing} onReady={(route, unavailableRouteCount) => { setPrepared({ key, route, unavailableRouteCount }); setSelected(route.url); setConfigure(false); }}/>}
    </>}
    {prepared?.key === key && chosen?.url === prepared.route.url && (prepared.unavailableRouteCount ?? 0) > 0 && <p role="status" className="settings-note">{t("{0} 个地址暂未就绪，已显示可用地址。", prepared.unavailableRouteCount)}</p>}
    {localHost && chosen && !loading && !failed && <details className="device-invite-options"><summary>{t("其他连接方式")}</summary><p>{t("已有线路不适用时，可在这里配置局域网或 Tailscale。")}</p><button type="button" onClick={() => setConfigure(true)}>{t("设置其他连接方式")}</button></details>}
  </section>;
}
