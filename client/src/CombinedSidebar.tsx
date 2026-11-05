import { GlobalPinSection } from "./GlobalPinSection.js";
import { Fragment, type ReactNode } from "react";
import { SidebarListHeading } from "./SidebarListOptions.js";
import { buildBotRows, buildConversationRows, navigationItems, folderSectionHosts, type InboxHost } from "./conversation-inbox.js";
import type { SidebarSlice } from "./ConversationList.js";
import type { SidebarLayout } from "./storage.js";
import { t } from "./i18n.js";

/** Only presentation is combined. Every rendered item keeps its host's
 * connection, avatars and action handlers, including when IDs coincide. */
export function CombinedSidebar({ hosts, layout, showDisconnectedBots = false, leadingSection, retained, render }: {
  hosts: InboxHost[];
  layout: SidebarLayout;
  showDisconnectedBots?: boolean;
  leadingSection?: ReactNode;
  retained?: (hostId: string) => ReadonlySet<string>;
  render: (hostId: string, slice: SidebarSlice, showHostBadge: boolean) => ReactNode;
}) {
  const listed = hosts.map(host => ({ ...host, ...navigationItems(host, showDisconnectedBots, retained?.(host.id)) }));
  const visibleHosts = hosts.map((host, i) => ({ ...host, conversations: listed[i]!.conversations }));
  const hiddenBots = listed.some((host, i) => host.bots.length < hosts[i]!.bots.length);
  const allRows = buildConversationRows(visibleHosts);
  const rows = allRows.filter(row => !row.globallyPinned);
  const globals = allRows.filter(row => row.globallyPinned);
  const globalSection = globals.length > 0 && <GlobalPinSection>{globals.map(row => <Fragment key={row.key}>{render(row.hostId, { kind: "conversation", id: row.conversation.id, ...(layout === "conversations" ? { inbox: row } : {}) }, true)}</Fragment>)}</GlobalPinSection>;
  const hiddenItems = layout === "conversations" ? allRows.length < buildConversationRows(hosts).length : hiddenBots;
  const emptyText = hiddenItems ? t("未连接的 Bot 已隐藏，勾选「显示未连接 Bot」即可查看。") : t("选择 Bot 开始新对话，或点击新建群组。");
  if (layout === "conversations") {
    const folderHosts = folderSectionHosts(hosts, rows);
    const folderHostIds = new Set(folderHosts.map(host => host.id));
    return <nav className="conversation-list conversation-inbox combined-sidebar">
      {globalSection}{leadingSection}
      {/* Custom folders belong to their host. Keep their saved order (including
          Unfiled), identify the folder once, and omit badges on its children. */}
      {folderHosts.map(host => <Fragment key={host.id}>{render(host.id, { kind: "folders" }, false)}</Fragment>)}
      {rows.filter(row => !folderHostIds.has(row.hostId)).map(row => <Fragment key={row.key}>{render(row.hostId, { kind: "conversation", id: row.conversation.id, inbox: row }, true)}</Fragment>)}
      {!allRows.length && (!folderHosts.length || hiddenItems) && <p className="empty-sidebar">{emptyText}</p>}
    </nav>;
  }
  const bots = buildBotRows(listed);
  const unassigned = rows.filter(row => row.conversation.type === "direct" && !row.conversation.botIds.length);
  const groups = rows.filter(row => row.conversation.type === "group");
  return <nav className="conversation-list combined-sidebar">
    {globalSection}{leadingSection}

    {!!bots.length && <section aria-label={t("Bot")}><SidebarListHeading>{t("Bot")}</SidebarListHeading>{bots.map(bot => <Fragment key={bot.key}>{render(bot.hostId, { kind: "bot", id: bot.id }, true)}</Fragment>)}</section>}
    {!!unassigned.length && <section><SidebarListHeading>{t("对话")}</SidebarListHeading>{unassigned.map(row => <Fragment key={row.key}>{render(row.hostId, { kind: "conversation", id: row.conversation.id }, true)}</Fragment>)}</section>}
    {!!groups.length && <section><SidebarListHeading>{t("群组")}</SidebarListHeading>{groups.map(row => <Fragment key={row.key}>{render(row.hostId, { kind: "conversation", id: row.conversation.id }, true)}</Fragment>)}</section>}
    {!bots.length && !allRows.length && <p className="empty-sidebar">{emptyText}</p>}
  </nav>;
}
