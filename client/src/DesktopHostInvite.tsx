import { LoaderCircle, Smartphone } from "lucide-react";
import type { HubConnection } from "./connection.js";
import type { Route } from "./storage.js";
import { ConnectionInviteCode } from "./ConnectionInviteCode.js";
import { useDesktopHostAccess } from "./useDesktopHostAccess.js";
import { t, useLocale } from "./i18n.js";
import "./desktop-host.css";

export function DesktopHostInvite({ hubKey, connection, purpose = "pairing", disabled = false, busyChange, compact = false, onReady }: { compact?: boolean; onReady?: (route: Route) => void; disabled?: boolean; busyChange?: (busy: boolean) => void; hubKey: string; connection?: HubConnection; purpose?: "pairing" | "network" }) {
  useLocale();
  const { method, chooseMethod, routes, selected, setSelected, publishedRoute, busy, publishingRoute, error, prepare } = useDesktopHostAccess({ hubKey, connection, purpose, disabled, busyChange, onReady });
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
      {routes.length > 1 && <label>{method === "tailscale" ? t("选择 Tailscale 地址") : t("选择电脑所在网络")}<select disabled={busy || publishingRoute || disabled} value={selected} onChange={(e) => setSelected(Number(e.target.value))}>{routes.map((route, i) => <option key={route.url} value={i}>{new URL(route.url).hostname}</option>)}</select></label>}
      {purpose === "pairing" && <ConnectionInviteCode connection={connection} payload={{ v: 1, kind: "connect", hubPublicKey: hubKey, routes: [routes[selected]!], deployment: "computer" }}/>}
      {compact ? <details><summary>{t("连接地址")}</summary><input aria-label={t("连接地址")} readOnly value={routes[selected]!.url}/></details> : <label>{t("连接地址")}<input readOnly value={routes[selected]!.url} onFocus={event => event.currentTarget.select()}/></label>}
      {purpose === "pairing" ? <p>{t("在新设备打开 TaroBird，扫描此二维码。再回到这里，输入新设备上的 8 位配对码确认。")}</p> : !error && <p role="status">{publishedRoute === routes[selected]!.url ? t("本机线路已共享，可以继续确认加入。") : t("正在等待本机重新连接并共享线路…")}</p>}
      <button type="button" disabled={busy || publishingRoute || disabled} onClick={() => void prepare()}>{purpose === "network" ? t("重新准备线路") : t("网络变了？重新准备线路")}</button>
    </>}
    {!compact && purpose === "pairing" && (method === "tailscale" ? <p className="settings-note">{t("手机已经配对过？在手机「连接状态与线路」中点击「扫描二维码更新连接」，若尚未自动同步地址，可扫描这里的码添加线路，无需重新配对。")}</p> : <p className="muted">{t("局域网二维码不支持手机流量直连。外出使用请选择「Tailscale 异地连接」，或在「连接状态与线路」中配置 VPS 中转。")}</p>)}
    {error && <p className="error-text" role="alert">{error}</p>}
  </section>;
}
