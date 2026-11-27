import { useState } from "react";
import { LoaderCircle, Smartphone } from "lucide-react";
import { selectPairingInviteRoutes } from "../../src/client-protocol/network-candidates.js";
import type { HubConnection } from "./connection.js";
import type { Route } from "./storage.js";
import { ConnectionInviteCode } from "./ConnectionInviteCode.js";
import { WindowsFirewallNotice } from "./WindowsFirewallNotice.js";
import { describeNetworkCandidate } from "./network-address-label.js";
import { connectionPairingPayload } from "./pairing-link.js";
import { useDesktopHostAccess, type DesktopHostAccessReady } from "./useDesktopHostAccess.js";
import { t, useLocale } from "./i18n.js";
import "./desktop-host.css";

export function DesktopHostInvite({
  hubKey,
  connection,
  purpose = "pairing",
  disabled = false,
  busyChange,
  compact = false,
  onReady,
}: {
  compact?: boolean;
  onReady?: DesktopHostAccessReady;
  disabled?: boolean;
  busyChange?: (busy: boolean) => void;
  hubKey: string;
  connection?: HubConnection;
  purpose?: "pairing" | "network";
}) {
  useLocale();
  // Apps up to 1.6.0 read only a v1 code (one direct address) and call any
  // other code damaged, so several candidates are the owner's explicit choice.
  const [multiAddress, setMultiAddress] = useState(false);
  const {
    method,
    chooseMethod,
    routes,
    candidates,
    windowsFirewall,
    selected,
    setSelected,
    publishedRoute,
    publicationFailed,
    busy,
    publishingRoute,
    unavailableRouteCount,
    error,
    prepare,
  } = useDesktopHostAccess({ hubKey, connection, purpose, disabled, busyChange, onReady });
  const selectedRoute = routes[selected];
  const candidateByUrl = new Map(candidates.map(item => [item.url, item]));
  const recommendedUrl = candidates.find(item => !item.demoted && !item.virtualBridge)?.url;
  const relays = (connection?.state.network?.host.routes ?? connection?.identity.routes ?? [])
    .filter(route => route.name === "VPS");
  const inviteRoutes = selectedRoute
    ? selectPairingInviteRoutes(routes, relays, {
        primaryUrl: selectedRoute.url,
        candidates,
        version: multiAddress ? 2 : 1,
      })
    : [];
  const directInviteCount = inviteRoutes.filter(route => route.name !== "VPS").length;
  const canOfferMultiAddress = selectedRoute
    ? selectPairingInviteRoutes(routes, relays, { primaryUrl: selectedRoute.url, candidates, version: 2 })
        .filter(route => route.name !== "VPS").length > 1
    : false;
  // The parent replaces this preparation view after publication. Minting a
  // code here would revoke it on that automatic handoff, even after a scan.
  const handsOffInvitation = purpose === "pairing" && !!onReady;
  // A rejected publication never reaches the parent. Its code is then stable
  // here until the owner prepares, switches method or picks another address.
  const showInvitation = purpose === "pairing" && (!handsOffInvitation || publicationFailed);
  return <section className="desktop-host-invite">
    {(!compact || !routes.length) && <><fieldset className="pairing-network-choice" disabled={busy || publishingRoute || disabled}><legend>{t("选择连接方式")}</legend>
      <div>{(["network", "tailscale"] as const).map(value => <button key={value} type="button" aria-pressed={method === value} onClick={() => chooseMethod(value)}>{value === "network" ? t("同一 Wi-Fi") : t("Tailscale 异地连接")}</button>)}</div>
    </fieldset>
    {method === "network" ? <p className="desktop-host-lead">{purpose === "network" ? t("适用于电脑和手机在同一 Wi-Fi 或局域网。人在外面时，请选「Tailscale 异地连接」或配置 VPS 中转。") : t("让新手机、平板或电脑连接同一 Wi-Fi 或局域网，点击下方按钮生成二维码。")}</p> : <>
      <ol className="tailscale-instructions"><li>{t("各设备安装并连接 Tailscale，加入同一个 Tailscale 网络。")}</li><li>{purpose === "pairing" ? t("点击下方按钮，自动检测这台电脑的 Tailscale 地址并生成连接码。") : t("点击下方按钮，检测并共享这台电脑的 Tailscale 地址。")}</li>{purpose === "pairing" && <li>{t("手机打开 TaroBird 扫码，再回到电脑确认手机显示的配对码。")}</li>}</ol>
      <p className="muted">{t("无需另租 VPS。电脑需保持开机联网，两端 Tailscale 需保持连接；网络访问规则须允许手机访问主机。")}</p>
    </>}
    </>}
    {/* One list of what the button does, most disruptive first, instead of
       three loose paragraphs in three text styles. */}
    {(() => {
      const notes = [
        ...(!compact || !routes.length ? [t("TaroBird 主机服务会短暂重启（不是重启电脑），正在运行的 Bot 任务会被中断，请先等它们结束。只在首次开启或网络变化时发生。")] : []),
        ...(purpose === "network" ? [t("本机开启加密连接，把地址共享给网络成员；不改防火墙，仍只有授权设备能访问。")] : []),
        ...(!compact ? [t("已配对的管理设备在线时会自动收到新线路；旧地址都连不上时，再扫码更新。")] : []),
      ];
      const action = routes.length ? purpose === "network" ? t("重新准备线路") : t("网络变了？重新准备线路")
        : purpose === "network" ? method === "tailscale" ? t("准备 Tailscale 线路") : t("准备局域网线路") : method === "tailscale" ? t("生成 Tailscale 二维码") : t("生成局域网二维码");
      return notes.length ? <div className="desktop-host-notes"><p>{t("点「{0}」后：", action)}</p><ul>{notes.map(note => <li key={note}>{note}</li>)}</ul></div> : null;
    })()}
    {!routes.length ? <button type="button" className="primary" disabled={busy || publishingRoute || disabled} onClick={() => void prepare()}>{busy ? <LoaderCircle className="spin" size={16}/> : <Smartphone size={16}/>}{busy ? t("正在准备连接…") : purpose === "network" ? method === "tailscale" ? t("准备 Tailscale 线路") : t("准备局域网线路") : method === "tailscale" ? t("生成 Tailscale 二维码") : t("生成局域网二维码")}</button> : <>
      {(routes.length > 1 || !selectedRoute) && <label className="pairing-adapter-select">{method === "tailscale" ? t("选择 Tailscale 地址") : t("选择电脑所在网络")}<select disabled={busy || publishingRoute || disabled} value={selected} onChange={(e) => setSelected(Number(e.target.value))}>{selected < 0 && <option value={-1} disabled>{t("请选择连接地址")}</option>}{routes.map((route, i) => <option key={route.url} value={i}>{describeNetworkCandidate(route, candidateByUrl.get(route.url), { recommended: routes.length > 1 && route.url === recommendedUrl })}</option>)}</select></label>}
      {!selectedRoute && <p className="settings-note" role="status">{candidates.length > 0 ? t("仅检测到虚拟网桥或代理地址，请手动选择与另一台设备在同一网络的地址。") : t("检测到多个地址，请选择与另一台设备在同一网络的地址。")}</p>}
      {selectedRoute && <>
      {showInvitation && <>
        <ConnectionInviteCode
          connection={connection}
          payload={connectionPairingPayload(hubKey, inviteRoutes, "computer", selectedRoute.url, { version: multiAddress ? 2 : 1 })}
        />
        {directInviteCount > 1 && <p className="settings-note pairing-multi-note" role="status">{t("二维码已包含 {0} 个可用候选地址{1}，新设备会同时尝试并选择最快的一条。", directInviteCount, relays.length ? t("和备用中转") : "")}</p>}
        {canOfferMultiAddress && <label className="pairing-qr-compat"><input type="checkbox" checked={multiAddress} onChange={(e) => setMultiAddress(e.target.checked)}/><span>{t("加入多个候选地址（仅适用于高于 1.6.0 的 App）")}</span></label>}
      </>}
      {compact ? <details><summary>{t("连接地址")}</summary><input aria-label={t("连接地址")} readOnly value={selectedRoute.url}/></details> : <label>{t("连接地址")}<input readOnly value={selectedRoute.url} onFocus={event => event.currentTarget.select()}/></label>}
      {showInvitation ? <p>{t("在新设备打开 TaroBird，扫描此二维码。再回到这里，输入新设备上的 8 位配对码确认。")}</p> : !error && <p role="status">{!handsOffInvitation && publishedRoute === selectedRoute.url ? t("本机线路已共享，可以继续确认加入。") : t("正在等待本机重新连接并共享线路…")}</p>}
      </>}
      {method === "network" && <WindowsFirewallNotice status={windowsFirewall} hasFallback={relays.length > 0}/>}
      <button type="button" disabled={busy || publishingRoute || disabled} onClick={() => void prepare()}>{purpose === "network" ? t("重新准备线路") : t("网络变了？重新准备线路")}</button>
    </>}
    {!compact && purpose === "pairing" && (method === "tailscale" ? <p className="settings-note">{t("手机已经配对过？在手机「连接状态与线路」中点击「扫描二维码更新连接」，若尚未自动同步地址，可扫描这里的码添加线路，无需重新配对。")}</p> : <p className="muted">{t("局域网二维码不支持手机流量直连。外出使用请选择「Tailscale 异地连接」，或在「连接状态与线路」中配置 VPS 中转。")}</p>)}
    {unavailableRouteCount > 0 && <p className="settings-note" role="status">{t("{0} 个地址暂未就绪，已显示可用地址。", unavailableRouteCount)}</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </section>;
}
