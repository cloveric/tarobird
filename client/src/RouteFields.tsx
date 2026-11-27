import { ArrowDown, ArrowUp, Cloud, Plus, Trash2 } from "lucide-react";
import { isRelayRoute, MAX_DIRECT_ROUTES, MAX_VPS_ROUTES, type Route, type RouteHealth, type Deployment } from "../../src/client-protocol/routes.js";
import { t } from "./i18n.js";
import { routeHealthStatusLabel } from "./route-diagnostics.js";

export function routeTitle(route: Route, routes: readonly Route[], deployment?: Deployment): string {
  if (route.label) return route.label;
  if (route.name === "Direct") return t("主机直连");
  if (route.name === "Tailscale") return "Tailscale";
  if (route.name === "Cloudflare") {
    const cfRoutes = routes.filter((r) => r.name === "Cloudflare");
    const index = cfRoutes.findIndex((r) => r.url === route.url);
    return cfRoutes.length > 1 ? t("Cloudflare 隧道 {0}", index + 1) : "Cloudflare Tunnel";
  }
  const index = routes.filter((r) => r.name === "VPS").findIndex((r) => r.url === route.url);
  return t("中转 {0}", index + 1);
}
export function RelaySetupNote() {
  return <aside className="relay-setup-note">
    <strong>{t("多台主机共用云服务器")}</strong>
    <p>{t("可以共用一台云服务器和同一个隧道端口，但每台主机仍需自己的中转入口（各用一个端口）。")}</p>
    <p>{t("请先完成部署，再填写当前主机的入口地址。这里只保存线路，不会自动部署中转。")}</p>
  </aside>;
}
export function DirectRouteFields({ routes, change, disabled = false }: { routes: Route[]; change: (routes: Route[]) => void; disabled?: boolean }) {
  const count = routes.filter(route => route.url.trim()).length;
  return <div className="direct-route-groups">{(["Direct", "Tailscale"] as const).map(name => {
    const entries = routes.map((route, index) => ({ route, index })).filter(value => value.route.name === name);
    const shown = entries.length ? entries : [{ route: { name, url: "" } as Route, index: -1 }];
    const update = (index: number, url: string) => change(index < 0 ? [...routes, { name, url }] : routes.map((route, i) => i === index ? { ...route, url } : route));
    return <fieldset className="vps-routes direct-route-group" disabled={disabled} key={name}><legend>{name === "Direct" ? t("局域网 / 主机直连") : "Tailscale"}</legend>
      <p className="route-entry-help">{name === "Direct" ? t("填写这台主机的局域网连接地址，可与 Tailscale 和中转同时保留。") : t("各设备需连接同一 Tailscale 网络。首次连接此主机需配对；已通过其他方式配对的设备无需重复配对。")}</p>
      {name === "Tailscale" && <p className="route-entry-help">{t("在运行 TaroBird 主机的电脑上，打开「局域网与 Tailscale」复制完整地址（含端口），不要填写手机自身的地址。")}</p>}
      {shown.map(({ route, index }, position) => <div className="direct-route-entry" key={position}>
        <label>{name === "Direct" ? (position ? t("主机的其他直连地址 {0}", position + 1) : t("主机的直连地址（可选）")) : (position ? t("主机的其他 Tailscale 连接地址 {0}", position + 1) : t("主机的 Tailscale 连接地址（可选）"))}
          <input type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={2048} value={route.url}
            placeholder={name === "Direct" ? "https://192.168.1.100:8788" : "https://100.64.0.1:8788"} onChange={event => update(index, event.target.value)}/>
        </label>{entries.length > 1 && <button type="button" className="icon-button" aria-label={t("移除地址 {0}", position + 1)} onClick={() => change(routes.filter((_, i) => i !== index))}><Trash2 size={16}/></button>}
      </div>)}
      {entries.length > 0 && entries.every(value => value.route.url.trim()) && <button type="button" className="secondary" disabled={count >= MAX_DIRECT_ROUTES} onClick={() => change([...routes, { name, url: "" }])}><Plus size={16}/>{t("添加此主机的其他地址")}</button>}
    </fieldset>;
  })}</div>;
}
export function VpsRouteFields({ routes, change, current, health = [], disabled = false, allowCloudflare = true }: { routes: Route[]; change: (routes: Route[]) => void; current?: string; health?: RouteHealth[]; disabled?: boolean; allowCloudflare?: boolean }) {
  const update = (index: number, patch: Partial<Route>) => change(routes.map((r, i) => i === index ? { ...r, ...patch } : r));
  const move = (index: number, offset: number) => { const next = [...routes]; [next[index], next[index + offset]] = [next[index + offset]!, next[index]!]; change(next); };
  const hasCloudflare = routes.some((r) => r.name === "Cloudflare");
  const cfTotal = routes.filter((r) => r.name === "Cloudflare").length;
  let vpsSeen = 0, cfSeen = 0;
  return <fieldset className="vps-routes" disabled={disabled}><legend>{allowCloudflare ? t("中转与 Cloudflare 隧道（可选）") : t("中转线路（可选）")}</legend><RelaySetupNote/>{routes.length > 0 && <p className="muted">{t("顺序仅用于整理列表；实际连接会优先局域网与 Tailscale，并比较线路的稳定性与响应速度。")}</p>}
    {routes.map((route, index) => {
      const status = health.find((h) => h.url === route.url), isCf = route.name === "Cloudflare";
      const kindIndex = isCf ? cfSeen++ : vpsSeen++;
      const title = isCf ? (cfTotal > 1 ? t("Cloudflare 隧道 {0}", kindIndex + 1) : t("Cloudflare 隧道")) : t("中转 {0}", kindIndex + 1);
      return <div className="vps-route" key={index} data-route-kind={route.name}>
      <header><strong>{isCf && <Cloud size={14} aria-hidden="true"/>} {title}</strong>{current === route.url ? <small className="online-label">{t("当前使用")}</small> : status && <small>{routeHealthStatusLabel(status).label}</small>}
      <div><button type="button" className="icon-button" disabled={index === 0} aria-label={isCf ? t("上移 Cloudflare 隧道 {0}", kindIndex + 1) : t("上移中转 {0}", kindIndex + 1)} onClick={() => move(index, -1)}><ArrowUp size={16}/></button><button type="button" className="icon-button" disabled={index === routes.length - 1} aria-label={isCf ? t("下移 Cloudflare 隧道 {0}", kindIndex + 1) : t("下移中转 {0}", kindIndex + 1)} onClick={() => move(index, 1)}><ArrowDown size={16}/></button><button type="button" className="icon-button" aria-label={isCf ? t("移除 Cloudflare 隧道 {0}", kindIndex + 1) : t("移除中转 {0}", kindIndex + 1)} onClick={() => change(routes.filter((_, i) => i !== index))}><Trash2 size={16}/></button></div></header>
      <label>{t("名称（可选）")}<input aria-label={isCf ? t("Cloudflare 隧道 {0} 名称", kindIndex + 1) : t("中转线路 {0} 名称", kindIndex + 1)} value={route.label ?? ""} maxLength={40} placeholder={title} onChange={(e) => update(index, { label: e.target.value || undefined })}/></label>
      <label>{isCf ? t("Cloudflare Tunnel 地址") : kindIndex === 0 ? t("中转地址") : t("备用中转 {0} 地址", kindIndex)}<input type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={route.url} maxLength={2048} placeholder={isCf ? "https://hub.example.com" : kindIndex === 0 ? "https://primary.example.com" : "https://backup.example.com"} onChange={(e) => update(index, { url: e.target.value })}/></label>
    </div>; })}
    {hasCloudflare && <p className="route-entry-help">{t("Cloudflare 免费隧道经过境外 Anycast 节点（中国大陆通常增加约 150–350 ms 延迟），且需先在主机启用并授权该域名；国内网络建议在主机启动 cloudflared 时加上 --protocol http2。远程高帧率屏幕控制建议优先使用局域网、Tailscale 或就近自建 VPS。")}</p>}
    <div className="route-add-actions">
      <button type="button" className="secondary" disabled={routes.length >= MAX_VPS_ROUTES} onClick={() => change([...routes, { name: "VPS", url: "" }])}><Plus size={16}/>{routes.some(r => r.name === "VPS") ? t("添加备用 VPS 地址") : t("添加 VPS 中转地址")}</button>
      {allowCloudflare && <button type="button" className="secondary" disabled={routes.length >= MAX_VPS_ROUTES} onClick={() => change([...routes, { name: "Cloudflare", url: "" }])}><Cloud size={16}/>{t("添加 Cloudflare Tunnel 地址")}</button>}
    </div>
  </fieldset>;
}
