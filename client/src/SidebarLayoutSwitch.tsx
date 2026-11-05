import { Bot, Check, MessagesSquare, PanelsTopLeft } from "lucide-react";
import { t } from "./i18n.js";
import type { SidebarLayout } from "./storage.js";
import "./sidebar-layout.css";

export function SidebarLayoutSwitch({ value, change, adhd }: { value: SidebarLayout; change: (value: SidebarLayout) => void; adhd?: { active?: boolean; disabled?: boolean; reason?: string; open: () => void } }) {
  return <div className="sidebar-layout-switch" role="group" aria-label={t("列表排列方式")}>
    <button type="button" disabled={!!adhd?.active && adhd.disabled} title={adhd?.active ? adhd.reason : undefined} aria-pressed={!adhd?.active && value !== "conversations"} onClick={() => change("bots")}><Bot size={14} aria-hidden="true"/>{t("按 Bot")}</button>
    <button type="button" disabled={!!adhd?.active && adhd.disabled} title={adhd?.active ? adhd.reason : undefined} aria-pressed={!adhd?.active && value === "conversations"} onClick={() => change("conversations")}><MessagesSquare size={14} aria-hidden="true"/>{t("按对话")}</button>
    {adhd && <button type="button" aria-label={t("打开 ADHD 模式")} aria-pressed={!!adhd.active} disabled={!adhd.active && adhd.disabled} title={adhd.reason} onClick={adhd.open}><PanelsTopLeft size={14} aria-hidden="true"/>ADHD</button>}
  </div>;
}

export function HostGroupingSwitch({ checked, change, menu = false }: { checked: boolean; change: (checked: boolean) => void; menu?: boolean }) {
  if (menu) return <button type="button" role="checkbox" aria-checked={checked} data-menu-keep onClick={() => change(!checked)}><span className="sidebar-list-toggle-mark" aria-hidden="true">{checked && <Check size={12}/>}</span><span>{t("按主机分组")}</span></button>;
  return <label className="sidebar-host-grouping"><input type="checkbox" checked={checked} onChange={event => change(event.target.checked)}/><span>{t("按主机分组")}</span></label>;
}

export function DisconnectedBotsSwitch({ checked, change, menu = false }: { checked: boolean; change: (checked: boolean) => void; menu?: boolean }) {
  if (menu) return <button type="button" role="checkbox" aria-checked={checked} data-menu-keep title={t("主机短暂断线时保留原列表，连续断线 5 分钟后才隐藏。勾选可一直显示未连接的 Bot。")} onClick={() => change(!checked)}><span className="sidebar-list-toggle-mark" aria-hidden="true">{checked && <Check size={12}/>}</span><span>{t("显示未连接 Bot")}</span></button>;
  return <label className="sidebar-host-grouping" title={t("主机短暂断线时保留原列表，连续断线 5 分钟后才隐藏。勾选可一直显示未连接的 Bot。")}><input type="checkbox" checked={checked} onChange={event => change(event.target.checked)}/><span>{t("显示未连接 Bot")}</span></label>;
}
