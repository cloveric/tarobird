import { useEffect, useState, useSyncExternalStore } from "react";
import { Globe, Smartphone } from "lucide-react";
import { HOST_ROUTES_PATH, hostRoutesViewSchema } from "../../src/client-protocol/host-routes.js";
import { isLoopbackOrUnspecified } from "../../src/client-protocol/loopback-address.js";
import { selectPairingInviteRoutes, type NetworkCandidateMeta, type WindowsFirewallStatus } from "../../src/client-protocol/network-candidates.js";
import { isDirectRoute, isEdgeTlsRoute, isRelayRoute, legacyV1Routes, MAX_VPS_ROUTES } from "../../src/client-protocol/routes.js";
import type { HubConnection } from "./connection.js";
import type { Route } from "./storage.js";
import { anySignal, timeoutSignal } from "./abort-signals.js";
import { DesktopHostInvite } from "./DesktopHostInvite.js";
import { ConnectionInviteCode } from "./ConnectionInviteCode.js";
import { WindowsFirewallNotice } from "./WindowsFirewallNotice.js";
import { describeNetworkCandidate, savePreferredPairingAddress } from "./network-address-label.js";
import { connectionPairingPayload } from "./pairing-link.js";
import { isBrowserTrustedRoute, isWebBrowser } from "./web-browser.js";
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
  const [prepared, setPrepared] = useState<{ key: string; route: Route; allRoutes: Route[]; candidates: NetworkCandidateMeta[]; windowsFirewall?: WindowsFirewallStatus; unavailableRouteCount?: number }>();
  const [retry, setRetry] = useState(0), [configure, setConfigure] = useState(false), [selected, setSelected] = useState("");
  // Apps up to 1.6.0 read only a v1 code (one direct address) and call any
  // other code damaged, so several candidates are the owner's explicit choice.
  const [multiAddress, setMultiAddress] = useState(false);
  const [targetMode, setTargetMode] = useState<"app" | "browser">("app");
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
  const saved = read?.key === key ? [...read.routes, ...connection.identity.routes.filter(route => isRelayRoute(route) && !read.routes.some(other => other.url === route.url))] : available ? [] : connection.identity.routes;
  const preparedRoutes = prepared?.key === key ? prepared.allRoutes : [];
  const source = prepared?.key === key
    ? [prepared.route, ...preparedRoutes.filter(route => route.url !== prepared.route.url), ...saved.filter(route => route.url !== prepared.route.url && !preparedRoutes.some(item => item.url === route.url))]
    : saved;
  const routes = source.filter(route => {
    try { const url = new URL(route.url); return url.protocol === "https:" && !isLoopbackOrUnspecified(url.hostname); }
    catch { return false; }
  });
  const directs = routes.filter(isDirectRoute);
  // Keep QR v1's bounded relay list, preserving the connection in use first.
  // Keep LAN/Tailscale/VPS invites free of Cloudflare routes so v1.6.0 Apps can
  // still decode them: a Cloudflare route gets its own v1 code, never a v2 code
  // or a browser link.
  const allRelays = routes.filter(isRelayRoute).sort((a, b) => Number(b.url === state.route?.url) - Number(a.url === state.route?.url));
  const relays = legacyV1Routes(allRelays).slice(0, MAX_VPS_ROUTES);
  const cfRelays = allRelays.filter(isEdgeTlsRoute).slice(0, MAX_VPS_ROUTES);
  const isLoopbackHost = (url: string) => {
    try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname); }
    catch { return false; }
  };
  const choices = [...directs, ...(relays.length ? [relays[0]!] : []), ...(cfRelays.length ? [cfRelays[0]!] : [])];
  const localLoopback = connection.identity.routes.find(route =>
    isDirectRoute(route)
    && isLoopbackHost(route.url)
    && isBrowserTrustedRoute(route)
    && (localHost || (isWebBrowser() && state.route?.url === route.url)),
  );
  const browserChoices = [...choices.filter(route => !isEdgeTlsRoute(route)), ...(localLoopback && !choices.some(r => r.url === localLoopback.url) ? [localLoopback] : [])];
  const activeChoices = targetMode === "browser" ? browserChoices : choices;
  const candidateByUrl = new Map((prepared?.key === key ? prepared.candidates : []).map(item => [item.url, item]));
  const usable = activeChoices.filter(route =>
    (localLoopback && route.url === localLoopback.url)
    || (prepared?.key === key && (route.url === prepared.route.url || preparedRoutes.some(item => item.url === route.url)))
    || !(read?.key === key && read.unavailableNames?.includes(route.name)),
  );
  const defaults = usable.length ? usable : activeChoices;
  const preferredBrowser = defaults.find(isBrowserTrustedRoute);
  const chosen = activeChoices.find(route => route.url === selected) ?? (targetMode === "browser" ? preferredBrowser : undefined) ?? defaults.find(route => route.url === state.route?.url) ?? (localHost ? defaults.find(route => route.name === "Direct") : undefined) ?? defaults.find(route => route.name === "Tailscale") ?? defaults[0];
  const chosenIsLoopback = !!chosen && !!localLoopback && chosen.url === localLoopback.url;
  const browserTrusted = chosen ? isBrowserTrustedRoute(chosen) : false;
  const trustedRelays = relays.filter(isBrowserTrustedRoute);
  const title = (route: Route) => {
    if (isLoopbackHost(route.url)) return t("本机浏览器");
    return route.name === "Tailscale" ? t("Tailscale") : route.name === "VPS" ? t("VPS 中转") : route.name === "Cloudflare" ? "Cloudflare Tunnel" : t("同一局域网");
  };
  const optionLabel = (route: Route) => {
    if (isRelayRoute(route) || isLoopbackHost(route.url)) return title(route);
    const candidate = candidateByUrl.get(route.url);
    if (candidate) return describeNetworkCandidate(route, candidate);
    if (route.name === "Tailscale") return describeNetworkCandidate(route);
    return activeChoices.filter(other => other.name === route.name && !isLoopbackHost(other.url)).length > 1 ? describeNetworkCandidate(route) : title(route);
  };
  // A browser link names the one address the browser will open, plus relays it
  // can trust. Only an App code can carry several direct candidates.
  const inviteRoutes = chosen
    ? targetMode === "browser"
      ? [chosen, ...trustedRelays.filter(route => route.url !== chosen.url)]
      : isEdgeTlsRoute(chosen)
        ? cfRelays
        : chosen.name === "VPS"
          ? relays
          : selectPairingInviteRoutes(directs, relays, {
              primaryUrl: chosen.url,
              candidates: prepared?.key === key ? prepared.candidates : undefined,
              version: multiAddress ? 2 : 1,
            })
    : [];
  const directInviteCount = inviteRoutes.filter(isDirectRoute).length;
  const canOfferMultiAddress = targetMode === "app" && !!chosen && isDirectRoute(chosen) && selectPairingInviteRoutes(directs, relays, {
    primaryUrl: chosen.url,
    candidates: prepared?.key === key ? prepared.candidates : undefined,
    version: 2,
  }).filter(isDirectRoute).length > 1;
  const handleReady = (route: Route, unavailableRouteCount?: number, allRoutes?: Route[], candidates?: NetworkCandidateMeta[], windowsFirewall?: WindowsFirewallStatus) => {
    setPrepared({ key, route, allRoutes: allRoutes?.length ? allRoutes : [route], candidates: candidates ?? [], windowsFirewall, unavailableRouteCount });
    setSelected(route.url);
    setConfigure(false);
  };
  if (configure) return <div className="device-invite"><button type="button" disabled={preparing} onClick={() => { setConfigure(false); setRetry(value => value + 1); }}>{t("返回连接二维码")}</button><DesktopHostInvite compact connection={connection} hubKey={key} busyChange={setPreparing} onReady={handleReady}/></div>;
  // The host's own report stays visible, next to the network choice it concerns.
  const unavailableWarning = !prepared && read?.key === key && read.unavailable && <p role="alert" className="settings-warning">{t("主机报告本地线路当前不可用。请检查网络后重新生成，或选择其他可用连接方式。")}</p>;
  return <section className="device-invite" aria-label={t("连接二维码")}>
    <div className="device-invite-mode" role="group" aria-label={t("连接方式")}>
      <button type="button" aria-pressed={targetMode === "app"} onClick={() => setTargetMode("app")}><Smartphone size={15} aria-hidden="true"/>{t("配对 App")}</button>
      <button type="button" aria-pressed={targetMode === "browser"} onClick={() => setTargetMode("browser")}><Globe size={15} aria-hidden="true"/>{t("在浏览器中使用")}</button>
    </div>
    {state.status !== "online" && <p role="status" className="settings-warning">{t("当前主机离线。这里显示的是已保存的连接信息；请先恢复连接，再确认新设备。")}</p>}
    {!prepared && read?.key === key && read.selectionRequired && <p role="status" className="settings-note">{t("这台主机有多个局域网地址。请在主机电脑选择新设备所在的网络，再生成连接二维码。")}</p>}
    {loading ? <p role="status">{t("正在读取可用的连接二维码…")}</p> : failed ? <div role="alert"><p>{t("未能读取主机的连接信息，请重试。现有连接不会改变。")}</p><button type="button" onClick={() => setRetry(value => value + 1)}>{t("重试")}</button></div> : chosen ? <>
      <div className="device-invite-route">{activeChoices.length > 1 ? <label>{targetMode === "browser" ? t("浏览器通过哪条线路访问？") : t("新设备通过什么网络连接？")}<select value={chosen.url} onChange={event => { setSelected(event.target.value); if (targetMode === "app" && event.target.value !== relays[0]?.url && event.target.value !== cfRelays[0]?.url) savePreferredPairingAddress(key, event.target.value); }}>{activeChoices.map(route => <option key={route.url} value={route.url}>{optionLabel(route)}</option>)}</select></label> : <strong>{title(chosen)}</strong>}{unavailableWarning}</div>
      {targetMode === "browser" && !browserTrusted ? <div role="status" className="settings-warning device-invite-browser-cert">
        <p>{chosen.name === "Tailscale" ? t("这条 Tailscale 线路使用主机自签名证书（或私有 IP），浏览器不会信任它。请勿绕过浏览器的证书安全警告。") : chosen.name === "VPS" ? t("这条中转线路使用私有证书或非公网受信任地址，浏览器不会信任它。请勿绕过浏览器的证书安全警告。") : t("这条局域网线路使用主机自签名证书，浏览器不会信任它。请勿绕过浏览器的证书安全警告。")}</p>
        <p>{localLoopback ? t("要从其他设备的浏览器打开，请切换到具备受信任 HTTPS 证书的线路（如 VPS 中转、Tailscale HTTPS），或在本机直接选择「本机浏览器」。") : t("要从浏览器打开，请切换到具备受信任 HTTPS 证书的线路（如 VPS 中转或 Tailscale HTTPS 域名），或使用原生 TaroBird App。")}</p>
      </div> : <ConnectionInviteCode connection={connection} browserUrl={targetMode === "browser" ? chosen.url : undefined} hideQr={targetMode === "browser" && chosenIsLoopback} payload={connectionPairingPayload(key, inviteRoutes, connection.identity.deployment, chosen.url, { version: multiAddress && targetMode === "app" ? 2 : 1 })}/>}
      {directInviteCount > 1 && <p className="settings-note pairing-multi-note" role="status">{t("二维码已包含 {0} 个可用候选地址{1}，新设备会同时尝试并选择最快的一条。", directInviteCount, relays.length ? t("和备用中转") : "")}</p>}
      {canOfferMultiAddress && <label className="pairing-qr-compat"><input type="checkbox" checked={multiAddress} onChange={(e) => setMultiAddress(e.target.checked)}/><span>{t("加入多个候选地址（仅适用于高于 1.6.0 的 App）")}</span></label>}
      {prepared?.key === key && <WindowsFirewallNotice status={prepared.windowsFirewall} hasFallback={relays.length > 0 || directs.some(route => route.name === "Tailscale")}/>}
      {!(targetMode === "browser" && !browserTrusted) && <p className="settings-note device-invite-note">{targetMode === "browser" ? chosenIsLoopback ? t("复制上方一次性链接并在这台电脑的浏览器中打开（仅限本机访问，无法用手机扫码），再在已配对设备核对 8 位配对码确认。浏览器会出现在设备列表中，可随时吊销。") : t("用桌面或手机浏览器打开一次性链接（或直接用系统相机扫码），再在已配对设备核对 8 位配对码确认。浏览器会出现在设备列表中，可随时吊销。") : chosen.name === "Tailscale" ? t("新设备和主机都需开启 Tailscale，并允许互相访问。") : chosen.name === "Cloudflare" ? t("新设备联网即可通过你自建的 Cloudflare Tunnel 连接主机。") : chosen.name === "VPS" ? t("新设备联网即可通过已配置的中转连接主机。") : t("新设备与主机需连接同一 Wi-Fi 或局域网。")} {targetMode === "app" && t("扫码后仍需核对 8 位配对码并确认，才会授权新设备。")}</p>}
    </> : <>
      {unavailableWarning}
      <p className="settings-note">{localHost ? t("首次设置：选择连接方式并生成二维码。") : t("此主机尚未提供可分享的连接地址。请在主机电脑打开「添加设备」，生成连接二维码。")}</p>
      {localHost && <DesktopHostInvite compact connection={connection} hubKey={key} busyChange={setPreparing} onReady={handleReady}/>}
    </>}
    {prepared?.key === key && chosen?.url === prepared.route.url && (prepared.unavailableRouteCount ?? 0) > 0 && <p role="status" className="settings-note">{t("{0} 个地址暂未就绪，已显示可用地址。", prepared.unavailableRouteCount)}</p>}
    {localHost && chosen && !loading && !failed && <details className="device-invite-options"><summary>{t("其他连接方式")}</summary><p>{t("已有线路不适用时，可在这里配置局域网或 Tailscale。")}</p><button type="button" onClick={() => setConfigure(true)}>{t("设置其他连接方式")}</button></details>}
  </section>;
}
