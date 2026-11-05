import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, CheckCircle2, Copy, Globe, LoaderCircle, Wifi } from "lucide-react";
import { HOST_ROUTES_PATH, hostRoutesViewSchema, type HostRoutesView } from "../../src/client-protocol/host-routes.js";
import type { HubConnection } from "./connection.js";
import { useDesktopHostAccess } from "./useDesktopHostAccess.js";
import { t, useLocale } from "./i18n.js";
import "./desktop-host.css";

/** Configure this host's listeners, independently of enrolling a new device. */
export function LocalConnectionSettings({ connection, busyChange }: { connection: HubConnection; busyChange: (busy: boolean) => void }) {
  useLocale();
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const hubKey = connection.identity.hubPublicKey!;
  const allowed = state.status === "online" && state.user?.role === "owner";
  const access = useDesktopHostAccess({ hubKey, connection, purpose: "connection", disabled: !allowed, busyChange });
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; view?: HostRoutesView; failed?: boolean; checkedAt?: number }>();
  const [copy, setCopy] = useState<{ key: string; url: string; failed?: boolean }>();
  const canRead = allowed && state.hostRoutesAvailable;
  useEffect(() => {
    setResult(undefined);
    setCopy(undefined);
    if (!canRead || access.operationBusy) return;
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => { if (active) { active = false; controller.abort(); setResult({ key: hubKey, failed: true }); } }, 8000);
    void connection.http(HOST_ROUTES_PATH, { signal: controller.signal }).then(raw => {
      const view = hostRoutesViewSchema.parse(raw);
      if (view.hostPublicKey !== hubKey) throw new Error("host_identity_mismatch");
      if (active) setResult({ key: hubKey, view, checkedAt: Date.now() });
    }).catch(() => { if (active) setResult({ key: hubKey, failed: true }); })
      .finally(() => { active = false; clearTimeout(timer); });
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [connection, hubKey, canRead, attempt, access.operationBusy, access.publishedRoute]);
  const view = canRead && result?.key === hubKey ? result.view : undefined;
  const failed = canRead && result?.key === hubKey && result.failed;
  const reading = canRead && !result && !access.operationBusy;
  const mode = access.method === "tailscale" ? "tailscale" : "lan";
  const listening = view?.local[mode].listening;
  const addresses = view?.routes.filter(({ route }) => route.name === (mode === "tailscale" ? "Tailscale" : "Direct")) ?? [];
  const copyAddress = async (url: string) => {
    try { await navigator.clipboard.writeText(url); setCopy({ key: hubKey, url }); }
    catch { setCopy({ key: hubKey, url, failed: true }); }
  };
  const status = (value: "lan" | "tailscale") => !allowed ? t("暂时无法读取")
    : access.operationBusy ? t("正在更新…") : failed ? t("状态读取失败")
    : !view ? canRead ? t("正在读取…") : t("状态不可用")
    : !view.local[value].enabled ? t("未开启") : view.local[value].listening ? t("本机已就绪") : t("等待网络连接");
  const refresh = () => setAttempt(value => value + 1);
  return <section className="local-connection-settings">
    <p className="local-access-lede">{t("已配对设备会通过已保存的可用线路自动重连，无需再次配对。")}</p>
    <div className="local-access-choices" role="group" aria-label={t("本机连接方式")}>
      {(["network", "tailscale"] as const).map(method => <button type="button" key={method} aria-pressed={access.method === method} disabled={access.operationBusy || !allowed} onClick={() => access.chooseMethod(method)}>
        {method === "network" ? <Wifi size={20}/> : <Globe size={20}/>}<span><strong>{method === "network" ? t("局域网") : "Tailscale"}</strong><small>{status(method === "network" ? "lan" : "tailscale")}</small></span>
      </button>)}
    </div>
    <div className="local-access-body">
      <p>{access.method === "tailscale" ? t("外出也能连接。各设备需连接同一个 Tailscale 网络，并允许相互访问。") : t("适合同一 Wi-Fi 或有线局域网内的设备。")}</p>
      {listening && <p className="local-access-ready"><CheckCircle2 size={16}/>{t("本机入口已就绪")}</p>}
      {view && <div className="local-access-addresses">
        <strong>{mode === "tailscale" ? t("主机的 Tailscale 连接地址") : t("主机的局域网连接地址")}</strong>
        {!listening && addresses.length > 0 && <p className="muted">{t("入口当前未就绪，以下为已保存的地址。")}</p>}
        {view.notices.includes("replacement_pending") && addresses.length > 0 && <p className="muted">{t("主机地址正在更新，以下地址可能尚未生效。")}</p>}
        {addresses.map(({ route }, index) => <div className="local-access-address" key={route.url}>
          <code aria-label={t("连接地址 {0}", index + 1)}>{route.url}</code>
          <button type="button" aria-label={t("复制主机地址 {0}", index + 1)} onClick={() => void copyAddress(route.url)}>
            {copy?.key === hubKey && copy.url === route.url && !copy.failed ? <Check size={16}/> : <Copy size={16}/>}
            {copy?.key === hubKey && copy.url === route.url && !copy.failed ? t("已复制") : t("复制")}
          </button>
        </div>)}
        {!addresses.length && <p className="muted">{t("当前没有此方式的连接地址。")}</p>}
        {copy?.key === hubKey && copy.failed && addresses.some(({ route }) => route.url === copy.url) && <p role="alert">{t("复制失败，请选择地址手动复制。")}</p>}
      </div>}
      {!allowed ? <p role="status">{state.status !== "online" ? t("请等待主机重新连接后再设置。") : t("仅主机管理者可设置连接方式。")}</p>
        : reading ? <p role="status"><LoaderCircle className="spin" size={16}/>{t("正在读取入口状态…")}</p>
        : failed ? <><p role="alert">{t("未能读取本机入口状态，请重试。")}</p><button type="button" onClick={refresh}>{t("重新读取")}</button></>
        : <>
          {!listening && <p className="muted local-access-restart">{t("首次开启或更新地址可能短暂重启主机，请先完成正在执行的任务。")}</p>}
          {listening && !access.error ? <button type="button" onClick={refresh}>{t("刷新状态")}</button> : <button type="button" className="primary" disabled={access.operationBusy} onClick={() => void access.prepare()}>
            {access.operationBusy && <LoaderCircle className="spin" size={16}/>}{access.operationBusy ? t("正在准备连接…") : access.error || view?.local[mode].enabled ? t("重新准备线路") : access.method === "tailscale" ? t("开启 Tailscale 访问") : t("开启局域网访问")}
          </button>}
          {!listening && view?.local[mode].enabled && !access.operationBusy && <button type="button" onClick={refresh}>{t("刷新状态")}</button>}
        </>}
      {view && result?.checkedAt && <p className="local-access-refreshed" role="status">{t("状态已刷新 · {0}", new Date(result.checkedAt).toLocaleTimeString())}<small>{t("本机入口状态，不代表其他设备已连接。")}</small></p>}
      {access.error && <p className="error-text" role="alert">{access.error}</p>}
      {access.routes.length > 1 && <label>{t("选择连接地址")}<select value={access.selected} disabled={access.operationBusy || !allowed} onChange={event => access.setSelected(Number(event.target.value))}>{access.routes.map((route, index) => <option key={route.url} value={index}>{route.url}</option>)}</select></label>}
    </div>
    <details className="settings-help local-access-help"><summary>{t("连接说明与排查")}</summary>
      <p>{t("开启后，保持在线的已配对管理设备会自动同步新地址。首次加入 TaroBird 的设备仍需在「添加设备」中扫码并确认。")}</p>
      <p>{t("若旧线路已全部失效，或此设备没有管理权限，可在「连接状态与线路」中扫描二维码更新地址，保留原来的配对关系。")}</p>
      <p>{t("「本机已就绪」只表示这台主机的入口正常；其他设备仍需联网，Tailscale 也需保持连接。")}</p>
      <p>{t("首次开启或更新地址可能短暂重启主机，请先完成正在执行的任务。")}</p>
      {allowed && view && !access.operationBusy && <button type="button" onClick={() => void access.prepare()}>{t("重新准备线路")}</button>}
    </details>
  </section>;
}
