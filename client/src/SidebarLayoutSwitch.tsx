import { Bot, Check, MessagesSquare, PanelsTopLeft } from "lucide-react";
import { t } from "./i18n.js";
import type { SidebarLayout } from "./storage.js";
import type { InboxFilter } from "./conversation-unread.js";
import "./sidebar-layout.css";

export function SidebarLayoutSwitch({ value, change, adhd }: { value: SidebarLayout; change: (value: SidebarLayout) => void; adhd?: { active?: boolean; disabled?: boolean; reason?: string; open: () => void } }) {
  return <div className="sidebar-layout-switch" role="group" aria-label={t("列表排列方式")}>
    <button type="button" disabled={!!adhd?.active && adhd.disabled} title={adhd?.active ? adhd.reason : undefined} aria-pressed={!adhd?.active && value !== "conversations"} onClick={() => change("bots")}><Bot size={14} aria-hidden="true"/>{t("按 Bot")}</button>
    <button type="button" disabled={!!adhd?.active && adhd.disabled} title={adhd?.active ? adhd.reason : undefined} aria-pressed={!adhd?.active && value === "conversations"} onClick={() => change("conversations")}><MessagesSquare size={14} aria-hidden="true"/>{t("按对话")}</button>
    {adhd && <button type="button" aria-label={t("打开 ADHD 模式")} aria-pressed={!!adhd.active} disabled={!adhd.active && adhd.disabled} title={adhd.reason} onClick={adhd.open}><PanelsTopLeft size={14} aria-hidden="true"/>ADHD</button>}
  </div>;
}

/** 全部 / 未读 / 待处理. 待处理 lists conversations where a Bot waits for the owner to answer a question. */
export function SidebarUnreadFilter({ filter, unreadCount, pendingCount, change }: { filter?: InboxFilter; unreadCount: number; pendingCount: number; change: (filter: InboxFilter | undefined) => void }) {
  return <div className="sidebar-unread-filter" role="group" aria-label={t("筛选会话")}>
    <button type="button" className="sidebar-filter-chip" aria-pressed={!filter} onClick={() => change(undefined)}>{t("全部")}</button>
    <button type="button" className="sidebar-filter-chip" aria-pressed={filter === "unread"} onClick={() => change("unread")}>
      <span>{t("未读")}</span>
      {unreadCount > 0 && <>
        <span className="sidebar-unread-total" aria-hidden="true">{unreadCount}</span>
        <span className="screen-reader-only">{t("{0} 条未读", unreadCount)}</span>
      </>}
    </button>
    <button type="button" className="sidebar-filter-chip" aria-pressed={filter === "pending"} title={t("等你回答问题的对话")} onClick={() => change("pending")}>
      <span>{t("待处理")}</span>
      {pendingCount > 0 && <>
        <span className="sidebar-pending-total" aria-hidden="true">{pendingCount}</span>
        <span className="screen-reader-only">{t("{0} 个问题等你回答", pendingCount)}</span>
      </>}
    </button>
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
