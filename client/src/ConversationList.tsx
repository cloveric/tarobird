import { beginPinFocus, cancelPinFocus, restorePinFocus } from "./conversation-pin-focus.js";
import { SidebarListHeading, SidebarListSettings } from "./SidebarListOptions.js";
import { GlobalPinSection } from "./GlobalPinSection.js";
import { ConversationBulkCheck, useConversationBulk } from './ConversationBulkSelection.js';
import { useBotConversationFolds, useGroupTopicFolds } from "./bot-conversation-folds.js";
import "./bot-conversation-folds.css";
import { DraftPreviewText, listDraftPreview, useDraftPreviews } from "./DraftPreview.js";
import { FolderSections, MoveToFolder } from "./ConversationFolders.js";
import { botAgentSignal, buildBotRows, buildConversationRows, navigationItems, formatRowTime, type InboxRow } from "./conversation-inbox.js";
import { agentSignal } from "./agent-state.js";
import { AgentAvatar } from "./AgentAvatar.js";
import { isDispatcher, listedConversations } from "./dispatcher.js";
import { HostSourceBadge } from "./HostSourceBadge.js";
import { BotName } from "./BotName.js";
import { ConversationAvatarDialog } from "./ConversationAvatarDialog.js";
import { Avatar, ConversationAvatar, canEditConversationAvatar } from "./Avatar.js";
import { useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode } from "react";
import { useConnectionSelection } from "./connection-selection.js";
import { createPortal } from "react-dom";
import { t, useLocale } from "./i18n.js";
import { ReferencePreview, useBotLabels } from "./BotReferences.js";
import { conversationPreview } from "./conversation-preview.js";
import { Camera, ListChecks, Check, ChevronDown, ChevronRight, FolderInput, Hash, Plus, Pencil, Settings, MessageSquare, MessageSquarePlus, Plug, Activity, Pin, PinOff, Trash2, UsersRound } from "lucide-react";
import type { Conversation } from "../../src/client-protocol/index.js";
import type { Bot, HubConnection } from "./connection.js";
import type { ConversationActivity, SidebarLayout } from "./storage.js";
import { DesktopMenu } from "./DesktopMenu.js";
import { RenameConversation } from "./RenameConversation.js";
import { RemoveConversation } from "./RemoveConversation.js";
import { GroupSettings } from "./GroupSettings.js";
import { BotSettings } from "./BotSettings.js";
import { RuntimeHostContext } from "./RuntimeHost.js";
export type SidebarSlice = { kind: "bot"; id: string } | { kind: "conversation"; id: string; inbox?: InboxRow } | { kind: "folders" };

export type ConversationSelection = {
  selected: ReadonlySet<string>; ready: boolean; key: (id: string) => string;
  topics: { expanded: (id: string) => boolean; setExpanded: (id: string, expanded: boolean) => void };
  disabled: (id: string) => boolean; reason?: (id: string) => string | undefined; toggle: (id: string) => void;
};

export function ConversationList({ connection, hostName, slice, showHostBadge = false, showDisconnectedBots = false, visible = true, layout = "bots", selection, filtered = false, conversations, bots, selected, pins, globalPins = [], showGlobalPins = true, activity, select, newChat, openBot }: { connection: HubConnection; hostName?: string; slice?: SidebarSlice; showHostBadge?: boolean; showDisconnectedBots?: boolean; visible?: boolean; layout?: SidebarLayout; selection?: ConversationSelection; filtered?: boolean; conversations: Conversation[]; bots: Bot[]; selected: string; pins: string[]; globalPins?: string[]; showGlobalPins?: boolean; activity: Record<string, ConversationActivity>; select: (id: string) => void; newChat: (botId: string) => void; openBot: (botId: string, destination: "capabilities" | "operations") => void }) {
  const drafts = useDraftPreviews(connection.cache);
  const sourceHost = showHostBadge && hostName ? <HostSourceBadge name={hostName}/> : null;
  const bulk = useConversationBulk();
  const locale = useLocale(); const labels = useBotLabels(); const prefix = useId();
  const state = useConnectionSelection(connection, current => ({ status: current.state.status, user: current.state.user,
    foldersAvailable: current.state.foldersAvailable, conversationAvatarsAvailable: current.state.conversationAvatarsAvailable }));
  const foldScope = connection.identity.hubPublicKey ? JSON.stringify([connection.identity.hubPublicKey, connection.identity.publicKey]) : undefined;
  const botFolds = useBotConversationFolds(foldScope);
  const topicFolds = useGroupTopicFolds(foldScope);
  const [editingAvatar, setEditingAvatar] = useState<string>();
  const [moving, setMoving] = useState<string>();
  const [removing, setRemoving] = useState<Conversation>();
  const [actionError, setActionError] = useState(""), [pinBusy, setPinBusy] = useState(false);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const [menu, setMenu] = useState<{ conversation: Conversation; point: { x: number; y: number } }>();
  const [botMenu, setBotMenu] = useState<{ id: string; point: { x: number; y: number } }>();
  const [editingGroup, setEditingGroup] = useState<{ id: string; members: boolean }>();
  const [settingsBot, setSettingsBot] = useState<string>();
  const botTrigger = useRef<HTMLElement | null>(null);
  const [renaming, setRenaming] = useState<Conversation>();
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => { setEditingAvatar(undefined); setMoving(undefined); setMenu(undefined); setBotMenu(undefined); setSettingsBot(undefined); setEditingGroup(undefined); setRenaming(undefined); setRemoving(undefined); setActionError(""); }, [selected, visible, connection, layout]);
  useEffect(() => {
    if (menu && !conversations.some(c => c.id === menu.conversation.id && !c.archived)) setMenu(undefined);
    if (editingAvatar && !conversations.some(c => c.id === editingAvatar && !c.archived)) setEditingAvatar(undefined);
    if (editingGroup && !conversations.some(c => c.id === editingGroup.id && !c.archived)) setEditingGroup(undefined);
    if (renaming && !conversations.some(c => c.id === renaming.id && !c.archived)) setRenaming(undefined);
  }, [conversations, menu, renaming, editingGroup, editingAvatar]);
  useEffect(() => {
    if (botMenu && !bots.some(bot => bot.id === botMenu.id)) setBotMenu(undefined);
    if (settingsBot && !bots.some(bot => bot.id === settingsBot)) setSettingsBot(undefined);
  }, [bots, botMenu, settingsBot]);
  const openBotMenu = (id: string, row: HTMLButtonElement, point?: { x: number; y: number }) => {
    if (bulk?.active) return;
    const rect = row.getBoundingClientRect(); botTrigger.current = row; setMenu(undefined);
    setBotMenu({ id, point: point ?? { x: rect.left + 20, y: rect.bottom } });
  };
  const settingsTarget = bots.find(bot => bot.id === settingsBot);
  const avatarTarget = conversations.find(c => c.id === editingAvatar && !c.archived);
  const groupTarget = conversations.find(c => c.id === editingGroup?.id);
  const isGroup = (c: Conversation) => c.type === "group" && !c.parentId;
  const openConversationMenu = (conversation: Conversation, node: HTMLElement, point?: { x: number; y: number }) => {
    if (bulk?.active) return;
    setBotMenu(undefined); setActionError(""); trigger.current = node;
    const rect = node.getBoundingClientRect();
    setMenu({ conversation, point: point ?? { x: rect.left + 20, y: rect.bottom } });
  };
  const menuTarget = conversations.find(c => c.id === menu?.conversation.id);
  const canEdit = (conversation: Conversation) => state.status === "online" && state.user?.id === conversation.ownerId;
  const pin = async (id: string, value: boolean, scope: "group" | "global" = "group") => {
    if (pinBusy) return;
    const intent = beginPinFocus(foldScope, id, value, scope, trigger.current);
    setPinBusy(true); setActionError(""); setMenu(undefined);
    try { await connection.pinConversation(id, value, scope); }
    catch (e) { cancelPinFocus(intent); setActionError(e instanceof Error ? e.message : t("操作失败")); }
    finally { setPinBusy(false); }
  };
  useLayoutEffect(() => {
    restorePinFocus(foldScope, pins, globalPins, (id, scopes) => {
      const chat = conversations.find(chat => chat.id === id);
      if (!chat) return;
      const find = (selector: string, matches: (node: HTMLElement) => boolean) => scopes
        .flatMap(node => [...node.querySelectorAll<HTMLElement>(selector)])
        .find(node => matches(node) && node.getClientRects().length);
      if (layout === "bots" && !chat.parentId && chat.botIds[0]) {
        const tree = find(".bot-tree", node => node.dataset.botId === chat.botIds[0]);
        return tree?.querySelector<HTMLElement>(".bot-tree-toggle, .bot-identity") ?? undefined;
      }
      if (chat.parentId) {
        const parent = find("[data-conversation-id]", node => node.dataset.conversationId === chat.parentId);
        const tree = parent?.closest(".group-tree, .adhd-group-topics");
        const disclosure = tree?.querySelector<HTMLElement>(".group-toggle, .adhd-topic-toggle");
        if (disclosure?.getClientRects().length) return disclosure;
        if (parent) return parent;
      }
      const folder = connection.state.conversationFolders?.assignments.find(item => item.conversationId === (chat.parentId ?? id))?.folderId ?? "";
      return find(".folder-heading", node => node.dataset.renameFolderId === folder);
    });
  }, [foldScope, pins, globalPins, menu, layout, conversations, connection]);
  const parent = conversations.find((c) => c.id === selected)?.parentId;
  // A selected topic may remain in a manually folded group. Mode changes and
  // mounted hidden sidebars must not overwrite the owner's disclosure choice.
  const listed = navigationItems({ connection, bots, conversations }, showDisconnectedBots, selection?.selected);
  const hiddenBots = listed.bots.length < bots.length;
  const listedIds = new Set(listed.conversations.map(chat => chat.id));
  const hiddenConversations = listedConversations(conversations).some(chat => !chat.archived && !chat.parentId && !listedIds.has(chat.id));
  const available = listed.conversations.filter((c) => !c.archived && (!c.parentId || !conversations.find((p) => p.id === c.parentId)?.archived));
  const updated = new Map(available.map((c) => [c.id, activity[c.id]?.at ?? c.createdAt]));
  for (const c of available) if (c.parentId) updated.set(c.parentId, Math.max(updated.get(c.parentId) ?? 0, updated.get(c.id) ?? 0));
  const active = available.sort((a, b) => (updated.get(b.id) ?? 0) - (updated.get(a.id) ?? 0));
  const ordinary = active.filter(c => !globalPins.includes(c.id)).sort((a, b) => Number(pins.includes(b.id)) - Number(pins.includes(a.id)));
  // Nested rows sit on their parent's guide line: the Bot or group avatar above
  // already identifies them, so chats show text only and topics a "#".
  const row = (c: Conversation, nested = false, inbox?: InboxRow) => {
    const current = selected === c.id || c.id === parent && !globalPins.includes(selected) && (!!inbox || topicFolds.collapsed.has(c.id));
    const bot = bots.find((b) => b.id === c.botIds[0]);
    const online = state.status === "online" && bots.some((b) => c.botIds.includes(b.id) && b.online);
    const children = ordinary.filter((child) => child.parentId === c.id);
    const unread = inbox?.unread ?? (Object.keys(activity[c.id]?.unread ?? {}).length + (topicFolds.collapsed.has(c.id) ? children.reduce((sum, child) => sum + Object.keys(activity[child.id]?.unread ?? {}).length, 0) : 0));
    const parentName = c.parentId && (pins.includes(c.id) || globalPins.includes(c.id)) ? conversations.find((p) => p.id === c.parentId)?.title : undefined;
    // Nested rows show a preview only when there is one: the parent row already
    // carries the Bot's model/engine, so children do not repeat it (or "独立话题").
    const draftPreview = listDraftPreview(c, conversations, drafts, !!inbox || !!topicFolds.collapsed.has(c.id));
    const detail = draftPreview ? <DraftPreviewText text={draftPreview}/> : inbox ? (inbox.preview ? <ReferencePreview text={inbox.previewTopic ? t("{0}：{1}", inbox.previewTopic, inbox.preview) : inbox.preview}/> : t("暂无消息")) : activity[c.id]?.preview ? <ReferencePreview text={conversationPreview(activity[c.id]!.preview)}/> : nested ? undefined : c.parentId ? t("独立话题") : c.type === "group" ? t("{0} 个话题 · {1} 个 Bot", children.length, c.botIds.length) : bot?.model || bot?.engine || "TaroBird";
    // A folded ADHD group must still expose requests in its hidden topics.
    // Expanded/search results show each topic marker on its own row.
    const foldedTopics = selection && inbox && isGroup(c) && !filtered && !selection.topics.expanded(c.id);
    const attention = foldedTopics
      ? inbox.attention[0]
      : Object.values(activity[c.id]?.attention ?? {}).sort((a, b) => a.at - b.at)[0];
    const content = <button role={bulk?.active ? "checkbox" : undefined} aria-checked={bulk?.active ? bulk.checked(connection, c) : undefined} title={bulk?.active ? bulk.reason(connection, c) : undefined} disabled={bulk?.active ? !!bulk.reason(connection, c) : selection && !selection.ready} aria-label={bulk?.active ? t("选择对话：{0}", c.title) : selection ? [t("在面板中查看 {0}", c.title), attention ? attention.kind === "question" ? t("待回答") : t("待批准") : "", unread ? t("{0} 条新消息", unread) : ""].filter(Boolean).join(" · ") : undefined} ref={node => { if (node) rows.current.set(c.id, node); else rows.current.delete(c.id); }} data-conversation-id={c.id} className={`conversation-row ${bulk?.active ? "conversation-bulk-row" : ""} ${selection && !bulk?.active ? "adhd-picker-target" : ""} ${c.parentId ? "topic-row" : ""} ${!bulk?.active && current ? "selected" : ""}`} key={c.id} aria-current={!bulk?.active && current ? "page" : undefined} aria-haspopup={bulk?.active ? undefined : "menu"} aria-expanded={bulk?.active ? undefined : menu?.conversation.id === c.id} aria-controls={menu?.conversation.id === c.id ? `${prefix}_actions` : undefined} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); openConversationMenu(c, event.currentTarget, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined); }} onKeyDown={event => { if (!bulk?.active && event.key === "F2" && canEdit(c)) { event.preventDefault(); setBotMenu(undefined); setActionError(""); trigger.current = event.currentTarget; setRenaming(c); } else if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) { event.preventDefault(); openConversationMenu(c, event.currentTarget); } }} onClick={() => { setMenu(undefined); setBotMenu(undefined); if (bulk?.active) bulk.toggle(connection, c); else select(c.id); }}>{bulk?.active && <ConversationBulkCheck checked={bulk.checked(connection, c)}/>} {nested ? c.parentId && <span className="row-glyph" aria-hidden="true"><Hash size={14}/></span> : <AgentAvatar signal={inbox?.agent ?? agentSignal([activity[c.id], ...children.map(child => activity[child.id])])} size={inbox ? 36 : 40} className={`avatar ${c.parentId ? "topic" : c.type}`} dispatcher={!c.parentId && c.type === "direct" && isDispatcher(bot)} tickets={!c.parentId && c.type === "direct" && bot && isDispatcher(bot) ? { connection, botId: bot.id } : undefined}>{layout === "conversations" ? <ConversationAvatar conversation={c} size={inbox ? 36 : 40}/> : <Avatar kind={c.type === "group" ? "group" : "bot"} id={c.parentId ?? (c.type === "group" ? c.id : c.botIds[0] ?? c.id)} name={c.type === "group" ? conversations.find((p) => p.id === c.parentId)?.title ?? c.title : labels.get(c.botIds[0]!) ?? c.title} size={inbox ? 36 : 40} fallback={c.parentId ? <Hash size={15}/> : c.type === "direct" && !c.botIds.length ? <MessageSquare size={15}/> : undefined}/>}<i className={online ? "online" : ""}/></AgentAvatar>}<span className="row-text">{inbox ? <span className="inbox-row-title"><strong title={c.title}>{c.title}</strong>{c.type === "direct" && bot && <span className="inbox-row-bot" title={selection ? labels.get(bot.id) ?? bot.name : undefined}><BotName id={bot.id} name={labels.get(bot.id) ?? bot.name} bot={bot} compact/></span>}{(inbox.pinned || inbox.globallyPinned) && <Pin size={11} aria-label={inbox.globallyPinned ? t("已全局置顶") : t("已分组置顶")}/>}</span> : <strong>{c.title}{(globalPins.includes(c.id) || pins.includes(c.id)) && <Pin className="conversation-pin-mark" size={11} aria-label={globalPins.includes(c.id) ? t("已全局置顶") : t("已分组置顶")}/>}</strong>}{(parentName || detail) && <small>{parentName && `${parentName} · `}{detail}</small>}</span>{selection && attention && <span className="adhd-picker-attention" title={attention.kind === "question" ? t("待回答") : t("待批准")}>{attention.kind === "question" ? t("待回答") : t("待批准")}</span>}{inbox ? <span className="inbox-row-meta"><time dateTime={inbox.activityAt ? new Date(inbox.activityAt).toISOString() : undefined}>{formatRowTime(inbox.activityAt, locale)}</time>{sourceHost}{unread > 0 && <b className={`unread-badge ${selection ? "adhd-picker-unread" : ""}`} role="img" aria-label={t("{0} 条新消息", unread)} title={t("{0} 条新消息", unread)}>{unread}</b>}</span> : <span className="row-source-meta">{!nested && sourceHost}{unread > 0 && <b className={`unread-badge ${selection ? "adhd-picker-unread" : ""}`} role="img" aria-label={t("{0} 条新消息", unread)} title={t("{0} 条新消息", unread)}>{unread}</b>}</span>}</button>;
    if (!selection || bulk?.active) return content;
    const checked = selection.selected.has(c.id);
    return <div key={c.id} className={`adhd-picker-row ${checked ? "is-added" : ""} ${selected === c.id ? "is-focused" : ""}`}>
      {content}<label className="adhd-picker-check" title={selection.reason?.(c.id) ?? (checked ? t("从面板移除，对话保留") : t("加入面板"))}><input type="checkbox" data-pane-toggle={selection.key(c.id)} aria-label={t("加入面板：{0} · {1}", hostName ?? "", c.title)} checked={checked} disabled={!selection.ready || selection.disabled(c.id)} onChange={() => selection.toggle(c.id)}/><span aria-hidden="true">{checked && <Check size={12}/>}</span></label>
    </div>;
  };
  const groupRow = (c: Conversation) => <div className="group-tree" key={c.id}><div className="group-tree-heading" onContextMenu={event => { event.preventDefault(); event.stopPropagation(); openConversationMenu(c, rows.current.get(c.id) ?? event.currentTarget, { x: event.clientX, y: event.clientY }); }}>{row(c)}<button className="group-toggle" onKeyDown={event => { if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) { event.preventDefault(); event.stopPropagation(); openConversationMenu(c, event.currentTarget); } }} aria-expanded={!topicFolds.collapsed.has(c.id)} aria-controls={`${prefix}_topics_${c.id}`} aria-label={topicFolds.collapsed.has(c.id) ? t("展开「{0}」的话题", c.title) : t("收起「{0}」的话题", c.title)} onClick={() => topicFolds.set(c.id, !topicFolds.collapsed.has(c.id))}>{topicFolds.collapsed.has(c.id) ? <ChevronRight size={16}/> : <ChevronDown size={16}/>}</button></div><div id={`${prefix}_topics_${c.id}`} className="group-tree-topics">{!topicFolds.collapsed.has(c.id) && ordinary.filter((topic) => topic.parentId === c.id).map((topic) => row(topic, true))}</div></div>;
  const inboxRow = (item: InboxRow) => {
    const c = item.conversation;
    // The ADHD inbox has no separate pinned-topic section. Keep every topic
    // reachable here, including topics pinned in the ordinary Bot tree.
    const children = selection && isGroup(c) ? ordinary.filter(child => child.parentId === c.id) : [];
    if (!children.length) return row(c, false, item);
    const expanded = filtered || !!selection?.topics.expanded(c.id);
    return <div className="adhd-group-topics" key={c.id}>{row(c, false, item)}<button className="adhd-topic-toggle" disabled={filtered} aria-expanded={expanded} aria-controls={`${prefix}_topics_${c.id}`} onClick={() => selection?.topics.setExpanded(c.id, !expanded)}>{expanded ? <ChevronDown size={12} aria-hidden="true"/> : <ChevronRight size={12} aria-hidden="true"/>}<span>{t("{0} 个话题", children.length)}</span></button><div id={`${prefix}_topics_${c.id}`} hidden={!expanded}>{children.map(child => row(child, true))}</div></div>;
  };
  const botIds = buildBotRows([{ id: "local", ...listed, activity }]).map(bot => bot.id);
  // Cached or historical conversations may have no remaining Bot member. Keep
  // them readable without inventing an undefined Bot or enabling its actions.
  const unassigned = ordinary.filter((c) => c.type === "direct" && !c.botIds.length);
  const groups = ordinary.filter((c) => c.type === "group" && !c.parentId);
  const inbox = layout === "conversations" && (!slice || slice.kind === "folders") ? buildConversationRows([{ id: "local", name: hostName ?? "", connection, conversations: listed.conversations, bots, pins, globalPins, activity }]) : undefined;
  const botRow = (id: string) => {
      const bot = bots.find((b) => b.id === id), name = labels.get(id) ?? bot?.name ?? id;
      const chats = ordinary.filter((c) => c.type === "direct" && c.botIds[0] === id);
      const current = chats.find((c) => c.id === selected) ?? chats[0];
      const children = chats;
      const folded = !filtered && children.length > 0 && botFolds.collapsed.has(id);
      const unread = children.reduce((sum, chat) => sum + Object.keys(activity[chat.id]?.unread ?? {}).length, 0);
      const attention = children.reduce((sum, chat) => sum + Object.keys(activity[chat.id]?.attention ?? {}).length, 0);
      const currentHidden = folded && children.some(chat => chat.id === selected);
      const foldLabel = folded ? t("展开「{0}」的对话", name) : t("收起「{0}」的对话", name);
      const summary = [t("{0} 个对话", children.length), unread ? t("{0} 条新消息", unread) : "", attention ? t("{0} 项待处理", attention) : "", currentHidden ? t("含当前对话") : ""].filter(Boolean).join(" · ");
      const openChat = () => { if (bulk?.active) { botFolds.set(id, false); return; } botFolds.set(id, false); setBotMenu(undefined); if (current) select(current.id); else newChat(id); };
      const createChat = () => { if (bulk?.active) return; botFolds.set(id, false); newChat(id); };
      // One line per Bot: the engine/model is a hover detail here and lives in the
      // conversation's details menu, so the list reads as names and chats.
      return <div className="bot-tree" key={id} data-bot-id={id} data-bot-fold-scope={foldScope} data-collapsed={folded || undefined}>
        <div className="bot-tree-heading">
          {children.length ? <button type="button" className="bot-tree-toggle" disabled={!botFolds.ready || filtered} aria-label={foldLabel} title={foldLabel} aria-expanded={!folded} aria-controls={`${prefix}_bot_chats_${id}`} aria-describedby={folded ? `${prefix}_bot_summary_${id}` : undefined} onClick={event => { event.currentTarget.focus({ preventScroll: true }); setMenu(undefined); botFolds.set(id, !folded); }} onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); setMenu(undefined); botFolds.set(id, event.key === "ArrowLeft"); } }}><ChevronRight size={14} aria-hidden="true"/></button> : <span className="bot-tree-disclosure-space" aria-hidden="true"/>}
          <button className={`bot-identity${currentHidden ? " is-collapsed-current" : ""}`} aria-current={currentHidden ? "page" : undefined} aria-describedby={folded ? `${prefix}_bot_summary_${id}` : undefined} aria-haspopup="menu" aria-expanded={botMenu?.id === id} aria-controls={botMenu?.id === id ? `${prefix}_bot_actions` : undefined} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); openBotMenu(id, event.currentTarget, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined); }} onKeyDown={event => { if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) { event.preventDefault(); event.stopPropagation(); openBotMenu(id, event.currentTarget); } }} aria-label={t("打开 {0}", name)} title={[bot?.engine, bot?.model].filter(Boolean).join(" · ") || undefined} onClick={openChat}><AgentAvatar signal={botAgentSignal({ conversations: chats, activity }, id)} size={40} className="avatar" dispatcher={isDispatcher(bot)} tickets={isDispatcher(bot) ? { connection, botId: id } : undefined}><Avatar kind="bot" id={id} name={name} size={40}/><i className={state.status === "online" && bot?.online ? "online" : ""}/></AgentAvatar><span><strong><BotName id={id} name={name} bot={bot}/></strong></span></button>
          {sourceHost}
          {folded && <><span className="bot-fold-signals" aria-hidden="true" title={summary}>{attention > 0 && <span className="folder-attention"/>}{unread > 0 ? <b className="unread-badge">{unread > 99 ? "99+" : unread}</b> : <span className="bot-fold-count">{children.length}</span>}</span><span id={`${prefix}_bot_summary_${id}`} hidden>{summary}</span></>}
          {!isDispatcher(bot) ? <button className="icon-button" aria-label={t("为 {0} 新建对话", name)} title={t("为 {0} 新建对话", name)} disabled={bulk?.active} onClick={createChat}><Plus size={16}/></button> : <span className="bot-tree-action-space" aria-hidden="true"/>}
        </div>
        <div className="bot-tree-conversations" id={`${prefix}_bot_chats_${id}`} hidden={folded}>{!folded && children.map(c => row(c, true))}</div>
      </div>;
  };
  const slicedConversation = slice?.kind === "conversation" ? active.find(c => c.id === slice.id) : undefined;
  const globalRows = showGlobalPins ? buildConversationRows([{ id: "local", name: hostName ?? "", connection, conversations: listed.conversations, bots, pins, globalPins, activity }]).filter(item => item.globallyPinned) : [];
  const globalSection = globalRows.length > 0 && <GlobalPinSection>{globalRows.map(item => layout === "conversations" ? inboxRow(item) : isGroup(item.conversation) ? groupRow(item.conversation) : row(item.conversation))}</GlobalPinSection>;
  const Container = slice ? "div" : "nav";
  return <Container data-pin-scope={foldScope} className={slice ? "conversation-list-slice" : `conversation-list${inbox ? " conversation-inbox" : ""}`}>
    {slice ? slice.kind === "bot" ? botIds.includes(slice.id) ? botRow(slice.id) : null : slice.kind === "folders" ? <FolderSections connection={connection} rows={(inbox ?? []).filter(item => !item.globallyPinned)} visible={visible} hostName={hostName} showHostBadge filtered={filtered} renderRow={inboxRow}/> : slicedConversation ? slice.inbox ? inboxRow(slice.inbox) : isGroup(slicedConversation) ? groupRow(slicedConversation) : row(slicedConversation) : null : <>
    {inbox ? <>{globalSection}<FolderSections connection={connection} rows={inbox.filter(item => !item.globallyPinned)} visible={visible} hostName={hostName} filtered={filtered} renderRow={inboxRow}/></> : <>
    {globalSection}

    {!!botIds.length && <section aria-label={t("Bot")}><SidebarListHeading>{t("Bot")}</SidebarListHeading>{botIds.map(botRow)}</section>}
    {!!unassigned.length && <section><SidebarListHeading>{t("对话")}</SidebarListHeading>{unassigned.map((c) => row(c))}</section>}
    {!!groups.length && <section><SidebarListHeading>{t("群组")}</SidebarListHeading>{groups.map((c) => groupRow(c))}</section>}
    </>}
    {!(inbox ? inbox.length : active.length || botIds.length) && <p className="empty-sidebar">{(inbox ? hiddenConversations : hiddenBots) ? t("未连接的 Bot 已隐藏，勾选「显示未连接 Bot」即可查看。") : t("选择 Bot 开始新对话，或点击新建群组。")}</p>}
    </>}
    {actionError && <p className="error-text" role="alert">{actionError}</p>}
    {visible && menu && menuTarget && <DesktopMenu id={`${prefix}_actions`} label={isGroup(menuTarget) ? t("群组操作") : t("对话操作")} open point={menu.point} placement="down-start" trigger={trigger} close={() => setMenu(undefined)}>
      {isGroup(menuTarget) && <><button type="button" role="menuitem" onClick={() => setEditingGroup({ id: menuTarget.id, members: false })}><Settings size={16}/>{t("群组设置")}</button><button type="button" role="menuitem" disabled={!canEdit(menuTarget)} onClick={() => setEditingGroup({ id: menuTarget.id, members: true })}><UsersRound size={16}/>{t("添加 / 移除 Bot")}</button><hr/></>}
      {bulk && <button type="button" role="menuitem" onClick={() => { bulk.begin(connection, menuTarget, trigger.current); setMenu(undefined); }}><ListChecks size={16}/>{t("多选")}</button>}
      <button type="button" role="menuitem" disabled={pinBusy} onClick={() => { void pin(menuTarget.id, !globalPins.includes(menuTarget.id), "global"); }}>{globalPins.includes(menuTarget.id) ? <PinOff size={16}/> : <Pin size={16}/>}<span>{globalPins.includes(menuTarget.id) ? t("取消全局置顶") : t("全局置顶")}</span></button>
      <button type="button" role="menuitem" disabled={pinBusy} onClick={() => { void pin(menuTarget.id, !pins.includes(menuTarget.id)); }}>{pins.includes(menuTarget.id) ? <PinOff size={16}/> : <Pin size={16}/>}<span>{pins.includes(menuTarget.id) ? t("取消分组置顶") : t("分组置顶")}</span></button>
      {!menuTarget.parentId && <button type="button" role="menuitem" disabled={state.status !== "online" || !state.foldersAvailable} onClick={() => setMoving(menuTarget.id)}><FolderInput size={16}/>{t("移至分组")}</button>}
      {layout === "conversations" && !menuTarget.parentId && <button type="button" role="menuitem" disabled={!canEditConversationAvatar(state, menuTarget)} title={menuTarget.type === "direct" && !state.conversationAvatarsAvailable ? t("升级此主机后即可设置对话头像") : undefined} onClick={() => setEditingAvatar(menuTarget.id)}><Camera size={16}/>{t("设置{0}", menuTarget.type === "group" ? t("群头像") : t("对话头像"))}</button>}
      <button type="button" role="menuitem" disabled={!canEdit(menuTarget)} onClick={() => setRenaming(menuTarget)}><Pencil size={16} aria-hidden="true"/>{isGroup(menuTarget) ? t("重命名群组") : t("重命名")}<kbd>F2</kbd></button>
      <hr/>
      <button type="button" role="menuitem" className="text-danger" disabled={!canEdit(menuTarget)} onClick={() => setRemoving(menuTarget)}><Trash2 size={16}/>{menuTarget.parentId ? t("删除话题") : isGroup(menuTarget) ? t("删除群组") : t("删除对话")}</button>
      {!canEdit(menuTarget) && <p className="desktop-menu-note">{state.status !== "online" ? t("连接恢复后即可操作") : t("仅对话创建者可修改或删除此对话。")}</p>}
    </DesktopMenu>}
    {visible && botMenu && <DesktopMenu id={`${prefix}_bot_actions`} label={t("Bot 操作")} className="sidebar-list-menu" open point={botMenu.point} placement="down-start" trigger={botTrigger} close={() => setBotMenu(undefined)}>
      <button type="button" role="menuitem" onClick={() => setSettingsBot(botMenu.id)}><Settings size={16}/>{t("Bot 设置")}</button>
      {!isDispatcher(bots.find(bot => bot.id === botMenu.id)) && <button type="button" role="menuitem" onClick={() => { botFolds.set(botMenu.id, false); newChat(botMenu.id); }}><MessageSquarePlus size={16}/>{t("新建对话")}</button>}
      <hr/>
      <button type="button" role="menuitem" onClick={() => openBot(botMenu.id, "capabilities")}><Plug size={16}/>Skills &amp; MCP</button>
      <button type="button" role="menuitem" onClick={() => openBot(botMenu.id, "operations")}><Activity size={16}/>{t("运行状态")}</button>
      <SidebarListSettings trigger={botTrigger} connection={connection}/>
    </DesktopMenu>}
    {/* Combined rows move when another conversation receives activity. Keep native
        dialogs out of those DOM moves, which remove them from the top layer.
        Portal the whole stack together so nested Back/Escape and focus still work. */}
    {createPortal(<>
    {visible && avatarTarget && <RuntimeHostContext.Provider value={hostName}><ConversationAvatarDialog key={avatarTarget.id} conversation={avatarTarget} returnFocus={trigger} close={() => setEditingAvatar(undefined)}/></RuntimeHostContext.Provider>}
    {visible && moving && conversations.some(c => c.id === moving && !c.archived) && <RuntimeHostContext.Provider value={hostName}><MoveToFolder key={moving} connection={connection} conversationId={moving} showLayoutHint={layout === "bots"} returnFocus={trigger} close={() => setMoving(undefined)}/></RuntimeHostContext.Provider>}
    {visible && groupTarget && <RuntimeHostContext.Provider value={hostName}><GroupSettings key={groupTarget.id} connection={connection} group={groupTarget} bots={bots} membersFirst={editingGroup?.members} close={() => setEditingGroup(undefined)} returnFocus={trigger}/></RuntimeHostContext.Provider>}
    {visible && removing && <RuntimeHostContext.Provider value={hostName}><RemoveConversation key={removing.id} connection={connection} conversation={removing} returnFocus={trigger} close={() => setRemoving(undefined)} removed={() => {
      setRemoving(undefined);
      if (!selection && (selected === removing.id || conversations.find(c => c.id === selected)?.parentId === removing.id)) {
        const next = active.find(c => c.id !== removing.id && c.parentId !== removing.id);
        select(next?.id ?? "");
      }
    }}/></RuntimeHostContext.Provider>}
    {visible && settingsTarget && <RuntimeHostContext.Provider value={hostName}><BotSettings key={settingsTarget.id} connection={connection} bot={settingsTarget} name={labels.get(settingsTarget.id) ?? settingsTarget.name} close={() => setSettingsBot(undefined)} returnFocus={botTrigger}/></RuntimeHostContext.Provider>}
    {visible && renaming && <RuntimeHostContext.Provider value={hostName}><RenameConversation key={renaming.id} connection={connection} conversation={renaming} returnFocus={trigger} close={() => setRenaming(undefined)}/></RuntimeHostContext.Provider>}
    </>, document.body)}
  </Container>;
}
