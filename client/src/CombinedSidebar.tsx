import { GlobalPinSection } from "./GlobalPinSection.js";
import { Fragment, type ReactNode } from "react";
import { SidebarListHeading } from "./SidebarListOptions.js";
import { buildBotRows, buildConversationRows, isTicketConversation, navigationItems, folderSectionHosts, type InboxHost } from "./conversation-inbox.js";
import { filterUnreadHostItems, type InboxFilter, type UnreadHostMatch } from "./conversation-unread.js";
import { resolveCrossHostFolderOrder, visibleCrossHostFolders } from "./cross-host-folder-order.js";
import { buildCrossHostFolderSources, buildHostFolderRowCounts, useCrossHostFolderOrder, useHostFolderUpdates } from "./use-cross-host-folder-order.js";
import type { SidebarSlice } from "./ConversationList.js";
import type { SidebarLayout } from "./storage.js";
import { t } from "./i18n.js";

/** Only presentation is combined. Every rendered item keeps its host's
 * connection, avatars and action handlers, including when IDs coincide. */
export function CombinedSidebar({ hosts, layout, showDisconnectedBots = false, filtered = false, inboxFilter, retainedOpen, leadingSection, retained, render }: {
  hosts: InboxHost[];
  layout: SidebarLayout;
  showDisconnectedBots?: boolean;
  filtered?: boolean;
  inboxFilter?: InboxFilter;
  retainedOpen?: { hostId: string; conversationId: string };
  leadingSection?: ReactNode;
  retained?: (hostId: string) => ReadonlySet<string>;
  render: (hostId: string, slice: SidebarSlice, showHostBadge: boolean) => ReactNode;
}) {
  useHostFolderUpdates(hosts);
  const crossHostOrder = useCrossHostFolderOrder();
  const filterActive = !!inboxFilter;
  const effectiveFiltered = filtered || filterActive;
  const matchByHost = new Map<string, UnreadHostMatch>();
  const listed = hosts.map(host => {
    const match = inboxFilter
      ? filterUnreadHostItems(host.conversations, host.activity, host.globalPins, retainedOpen?.hostId === host.id ? retainedOpen.conversationId : undefined, inboxFilter)
      : undefined;
    if (match) matchByHost.set(host.id, match);
    const hostRetained = retained?.(host.id);
    const retainedIds = match ? (hostRetained ? new Set([...hostRetained, ...match.matchingIds]) : match.matchingIds) : hostRetained;
    return { ...host, ...navigationItems(match ? { ...host, conversations: match.conversations } : host, showDisconnectedBots, retainedIds) };
  });
  const visibleHosts = hosts.map((host, i) => ({ ...host, conversations: listed[i]!.conversations }));
  const hiddenBots = listed.some((host, i) => host.bots.length < hosts[i]!.bots.length);
  const rawRows = buildConversationRows(visibleHosts);
  const allRows = filterActive
    ? rawRows.filter(row => {
      const match = matchByHost.get(row.hostId)!;
      return match.matchingIds.has(row.conversation.id) || match.groupIds.has(row.conversation.id);
    })
    : rawRows;
  const rows = allRows.filter(row => !row.globallyPinned);
  const globals = allRows.filter(row => row.globallyPinned);
  const globalSection = globals.length > 0 && <GlobalPinSection>{globals.map(row => <Fragment key={row.key}>{render(row.hostId, { kind: "conversation", id: row.conversation.id, ...(layout === "conversations" ? { inbox: row } : {}) }, true)}</Fragment>)}</GlobalPinSection>;
  const hiddenItems = layout === "conversations" ? allRows.length < buildConversationRows(hosts).length : hiddenBots;
  const emptyText = inboxFilter === "pending" ? t("没有等你回答的问题") : filterActive ? t("没有未读会话") : hiddenItems ? t("未连接的 Bot 已隐藏，勾选「显示未连接 Bot」即可查看。") : t("选择 Bot 开始新对话，或点击新建群组。");
  if (layout === "conversations") {
    const folderHosts = folderSectionHosts(hosts, rows);
    const folderHostIds = new Set(folderHosts.map(host => host.id));
    const allSources = buildCrossHostFolderSources(hosts);
    const folderSources = buildCrossHostFolderSources(folderHosts);
    const orderedFolders = folderHosts.length ? resolveCrossHostFolderOrder(folderSources, crossHostOrder) : [];
    const visibleFolders = orderedFolders.length
      ? visibleCrossHostFolders(orderedFolders, buildHostFolderRowCounts(folderHosts, rows), effectiveFiltered)
      : [];
    const visibleKeys = visibleFolders.map(item => item.key);
    const hasAnyPinned = visibleFolders.some(item => item.pinned);
    return <nav className="conversation-list conversation-inbox combined-sidebar">
      {globalSection}{leadingSection}
      {/* Custom folders belong to their host. Interleave only their display
          order across hosts; identify each folder once and omit child badges. */}
      {visibleFolders.map(item => <Fragment key={item.key}>{render(item.hostId, { kind: "folder", folderId: item.folderId, crossHost: { sources: allSources, visibleKeys, itemKey: item.key, hasAnyPinned } }, false)}</Fragment>)}
      {rows.filter(row => !folderHostIds.has(row.hostId)).map(row => <Fragment key={row.key}>{render(row.hostId, { kind: "conversation", id: row.conversation.id, inbox: row }, true)}</Fragment>)}
      {!allRows.length && (filterActive || !folderHosts.length || hiddenItems) && <p className="empty-sidebar">{emptyText}</p>}
    </nav>;
  }
  const bots = buildBotRows(listed).filter(bot => !filterActive || matchByHost.get(bot.hostId)!.botIds.has(bot.id));
  const unassigned = rows.filter(row => row.conversation.type === "direct" && (!row.conversation.botIds.length || isTicketConversation(row.conversation)));
  const groups = rows.filter(row => row.conversation.type === "group");
  return <nav className="conversation-list combined-sidebar">
    {globalSection}{leadingSection}

    {!!bots.length && <section aria-label={t("Bot")}><SidebarListHeading>{t("Bot")}</SidebarListHeading>{bots.map(bot => <Fragment key={bot.key}>{render(bot.hostId, { kind: "bot", id: bot.id }, true)}</Fragment>)}</section>}
    {!!unassigned.length && <section><SidebarListHeading>{t("对话")}</SidebarListHeading>{unassigned.map(row => <Fragment key={row.key}>{render(row.hostId, { kind: "conversation", id: row.conversation.id }, true)}</Fragment>)}</section>}
    {!!groups.length && <section><SidebarListHeading>{t("群组")}</SidebarListHeading>{groups.map(row => <Fragment key={row.key}>{render(row.hostId, { kind: "conversation", id: row.conversation.id }, true)}</Fragment>)}</section>}
    {!bots.length && !allRows.length && <p className="empty-sidebar">{emptyText}</p>}
  </nav>;
}
