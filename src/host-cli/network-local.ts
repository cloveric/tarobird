import type { HostRouteNotice, HostRoutesView } from "../client-protocol/host-routes.js";
import type { TailscaleDiagnostic } from "./tailscale-status.js";

const NOTICES: Record<HostRouteNotice, string> = {
  lan_selection_required: "无法确认局域网地址来源，未自动替换；请用 tarobot pair --lan --address IP 指定手机可达的地址。",
  lan_not_listening: "局域网入口未监听：未检测到可用地址（可能断开 Wi-Fi、休眠或端口被占用）。",
  tailscale_not_listening: "Tailscale 入口未监听：未检测到 Tailscale 地址，请确认本机 Tailscale 已连接。",
  replacement_pending: "检测到地址变化；连续两次检查稳定且距上次更新满 5 分钟后才会自动更新。",
};
const FAILURES: Record<Extract<TailscaleDiagnostic, { available: false }>["reason"], string> = {
  missing: "未找到 tailscale 命令，无法读取本机 Tailscale 状态。",
  timeout: "tailscale status 超时（3 秒），已停止等待。",
  failed: "tailscale status 执行失败。",
  invalid: "tailscale status 输出无法识别。",
};
function mode(name: string, value: HostRoutesView["local"]["lan"]): string {
  return `${name}：${!value.enabled ? "未开启" : value.listening ? "已开启，正在监听" : "已开启，当前未监听"}`;
}

/** Plain-language summary of the read-only `network local` result. */
export function formatLocalRoutes(view: HostRoutesView, tailscale?: TailscaleDiagnostic): string {
  const lines = ["主机线路（只读）。“共享”进入签名网络目录和二维码；“本机”只同步给此主机的拥有者设备。"];
  if (!view.routes.length) lines.push("  尚无线路。局域网用 tarobot pair --lan；Tailscale 用 tarobot pair --tailscale。");
  for (const { source, route } of view.routes) lines.push(`  ${source === "shared" ? "共享" : "本机"}  ${route.name.padEnd(9)} ${route.url}${route.label ? `  ${route.label}` : ""}`);
  lines.push(mode("局域网", view.local.lan), mode("Tailscale", view.local.tailscale));
  for (const notice of view.notices) lines.push(`提示：${NOTICES[notice]}`);
  if (tailscale && !tailscale.available) lines.push(`Tailscale 状态：${FAILURES[tailscale.reason]}`);
  else if (tailscale) {
    lines.push(`Tailscale 状态（本机视角）：${tailscale.backendState}${tailscale.online === undefined ? "" : tailscale.online ? "，在线" : "，离线"}`);
    for (const item of tailscale.addresses) lines.push(`  ${item.address} ${item.held ? "属于本机" : "不属于本机当前 Tailscale 地址"}`);
    lines.push("  仅反映本机状态，不代表手机已连接、ACL 允许访问或当前走直连。");
  }
  return lines.join("\n");
}
