import { AgentAvatar } from "./AgentAvatar.js";
import { isDispatcher, useTicketConversationsVisible } from "./dispatcher.js";
import { restorePinFocus } from "./conversation-pin-focus.js";
import { GlobalPinSection } from "./GlobalPinSection.js";
import { ConversationBulkProvider, ConversationBulkToolbar, ConversationBulkActions, ConversationBulkCheck, useConversationBulk } from './ConversationBulkSelection.js';
import { useSceneMotion } from "./use-scene-motion.js";
import { DraftPreviewText, useDraftPreviewText } from "./DraftPreview.js";
import { FolderSections } from "./ConversationFolders.js";
import { DisconnectedBotsSwitch } from "./SidebarLayoutSwitch.js";
import { botAgentSignal, buildConversationRows as buildMobileRows, folderSectionHosts, navigationItems, retainsOfflineNavigation, unreadFor, formatRowTime, type InboxHost as MobileHost, type InboxRow as MobileConversationRow } from './conversation-inbox.js';
export { buildConversationRows as buildMobileRows, unreadFor, formatRowTime, type InboxHost as MobileHost, type InboxRow as MobileConversationRow } from './conversation-inbox.js';
import { MobileListOptions } from "./MobileListOptions.js";
import { HostSourceBadge } from "./HostSourceBadge.js";
import { BotName } from "./BotName.js";
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { CalendarClock, Archive as ArchiveIcon, ArrowLeft, Settings, Bell, ShieldCheck, Wifi, WifiOff, RefreshCw } from 'lucide-react';
import type { Conversation } from '../../src/client-protocol/index.js';
import { Avatar, AvatarProvider, ConversationAvatar } from './Avatar.js';
import { BotReferences, ReferencePreview } from './BotReferences.js';
import type { Bot, HubConnection } from './connection.js';
import { t, useLocale } from './i18n.js';
import { useBackAction } from './back-navigation.js';
import { useConversationHold } from './useConversationHold.js';
import { MobileConversationActions } from './MobileConversationActions.js';
import { mobileListAvatarSizes, type LayoutDensity } from './layout-density.js';

const ListAvatarSize = createContext(48);

// Phone-only IM home (messages / bots / me). Pure view: every action is a
// callback; the scoped action sheet owns explicit conversation writes.
// Hidden on desktop by mobile-im.css; the desktop sidebar is untouched.

export type MobileTab = 'messages' | 'bots' | 'me';
export type MobileFilter = 'all' | 'unread' | 'attention' | 'groups';
type BotScope = { hostId: string; botId: string };
export type MobileInboxState = { query: string; filter: MobileFilter; botScope?: BotScope; botQuery?: string };
export type MobileScrollPositions = Record<MobileTab, number>;
export type MobileCreateKind = 'bot' | 'group' | 'direct' | 'schedule';
export type MobileOpenTarget = 'settings' | 'connection' | 'devices' | 'notifications' | 'files' | 'capabilities' | 'operations' | 'schedules' | 'hosts' | 'archives';
type Locale = ReturnType<typeof useLocale>;

export type MobileHomeProps = {
  density?: LayoutDensity;
  groupByHost?: boolean;
  showDisconnectedBots?: boolean;
  changeShowDisconnectedBots?: (value: boolean) => void;
  changeGroupByHost?: (value: boolean) => void;
  notice?: ReactNode;
  hosts: MobileHost[];
  activeHostId: string;
  tab: MobileTab;
  setTab: (value: MobileTab) => void;
  archived?: (hostId: string, ids: string[]) => void;
  select: (hostId: string, conversationId: string, messageId?: string) => void;
  newChat: (hostId: string, botId: string) => void;
  settingsBot: (hostId: string, botId: string) => void;
  create: (kind: MobileCreateKind) => void;
  selectHost: (hostId: string) => void;
  open: (kind: MobileOpenTarget) => void;
  searchHistory: (query: string) => void;
  inbox?: MobileInboxState;
  updateInbox?: (value: MobileInboxState) => void;
  scrollPositions?: RefObject<MobileScrollPositions>;
  visible?: boolean;
};

export type HostTone = 'ok' | 'pending' | 'bad' | 'unknown';

export function isHostConnected(status: string): boolean {
  return status === 'online';
}

export function hostStatus(status: string): { label: string; tone: HostTone } {
  switch (status) {
    case 'online':
      return { label: t('已连接'), tone: 'ok' };
    case 'connecting':
    case 'reconnecting':
      return { label: t('连接中'), tone: 'pending' };
    case 'offline':
    case 'revoked':
    case 'disconnected':
    case 'closed':
      return { label: t('未连接'), tone: 'bad' };
    case 'error':
    case 'failed':
      return { label: t('连接异常'), tone: 'bad' };
    default:
      return { label: status, tone: 'unknown' };
  }
}

export function matchesRow(row: MobileConversationRow, needle: string): boolean {
  if (!needle) return true;
  return [row.conversation.title, row.parentTitle ?? "", ...row.botNames, ...row.topicTitles]
    .some((value) => value.toLocaleLowerCase().includes(needle));
}

function passesFilter(row: MobileConversationRow, filter: MobileFilter): boolean {
  if (filter === 'unread') return row.unread > 0;
  if (filter === 'attention') return row.attention.length > 0;
  if (filter === 'groups') return row.conversation.type === 'group';
  return true;
}

function matchingBots(hosts: MobileHost[], needle: string, showDisconnectedBots: boolean): Array<{ host: MobileHost; bot: Bot }> {
  return hosts.flatMap((host) => navigationItems(host, showDisconnectedBots).bots
    .filter((bot) => bot.name.toLocaleLowerCase().includes(needle))
    .map((bot) => ({ host, bot })));
}

// Both identifiers are required: different hosts can use the same Bot ID.
function botScopeKey(hostId: string, botId: string): string {
  return JSON.stringify([hostId, botId]);
}

function badgeText(count: number): string {
  return count > 99 ? '99+' : String(count);
}

function titleOf(conversation: Conversation): string {
  return conversation.title.trim() || t('未命名会话');
}

// Keep local search/menu state while the chat covers the inbox, but do not
// reconcile every conversation for each composer keystroke or stream update.
// The visible transition always renders with the latest host data and callbacks.
export const MobileHome = memo(function MobileHome(props: MobileHomeProps) {
  return <ConversationBulkProvider hosts={props.hosts} visible={props.visible !== false && props.tab === 'messages'} scopeKey={props.tab} archived={(host, ids) => props.archived?.(host.id, ids)}><MobileHomeContent {...props}/></ConversationBulkProvider>;
}, (previous, next) => previous.visible === false && next.visible === false);

const MobileHomeContent = memo(function MobileHome(props: MobileHomeProps) {
  const { hosts, activeHostId, tab, setTab, create } = props;
  const locale = useLocale();
  const [localInbox, setLocalInbox] = useState<MobileInboxState>({ query: '', filter: 'all' });
  // The inbox lists every host, so its filters belong to the device shell,
  // not the currently visible host's cached Workspace.
  const inbox = props.inbox ?? localInbox;
  const { filter, botScope } = inbox;
  const query = tab === 'bots' ? inbox.botQuery ?? '' : inbox.query;
  const updateInbox = props.updateInbox ?? setLocalInbox;
  const localScroll = useRef<MobileScrollPositions>({ messages: 0, bots: 0, me: 0 });
  const positions = props.scrollPositions ?? localScroll;
  const body = useRef<HTMLDivElement>(null);
  const visible = props.visible ?? true;
  useSceneMotion(body, tab, visible, 0);
  const bulk = useConversationBulk();
  const actionTrigger = useRef<HTMLElement | null>(null);
  const [actionTarget, setActionTarget] = useState<{ hostId: string; conversationId: string }>();
  const actionHost = hosts.find(host => host.id === actionTarget?.hostId);
  useLayoutEffect(() => {
    if (actionTarget || !visible || tab !== "messages") return;
    for (const host of hosts) {
      const owner = host.connection.identity.hubPublicKey ? JSON.stringify([host.connection.identity.hubPublicKey, host.connection.identity.publicKey]) : undefined;
      restorePinFocus(owner, host.pins, host.globalPins ?? [], (id, scopes) => {
        const chat = host.conversations.find(chat => chat.id === id);
        const folder = host.connection.state.conversationFolders?.assignments.find(item => item.conversationId === (chat?.parentId ?? id))?.folderId ?? "";
        return scopes.flatMap(node => [...node.querySelectorAll<HTMLElement>(".folder-heading")])
          .find(node => node.dataset.renameFolderId === folder && node.getClientRects().length);
      });
    }
  }, [hosts, actionTarget, visible, tab]);

  const openActions = (row: HTMLElement) => {
    if (bulk?.active) return;
    const hostId = row.dataset.hostId, conversationId = row.dataset.conversationId;
    if (!hostId || !conversationId) return;
    actionTrigger.current = row;
    setActionTarget({ hostId, conversationId });
  };
  useConversationHold(body, `${tab}\0${query}\0${filter}\0${botScope?.hostId}\0${botScope?.botId}\0${props.groupByHost}\0${props.showDisconnectedBots}`, visible && tab === 'messages' && !bulk?.active, openActions);
  useEffect(() => { setActionTarget(undefined); }, [visible, tab, query, filter, botScope?.hostId, botScope?.botId, props.groupByHost, props.showDisconnectedBots]);
  useEffect(() => { if (actionTarget && !actionHost) setActionTarget(undefined); }, [actionTarget, actionHost]);
  const [searchTab, setSearchTab] = useState<MobileTab>();
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searching = tab !== 'me' && (searchTab === tab || !!query);
  const focusSearch = useRef(false);
  useLayoutEffect(() => { setSearchTab(undefined); }, [tab]);
  const setQuery = (query: string) => {
    setSearchTab(tab);
    positions.current[tab] = 0;
    updateInbox(tab === 'bots' ? { ...inbox, botQuery: query } : { ...inbox, query });
  };
  const setFilter = (filter: MobileFilter) => { positions.current.messages = 0; updateInbox({ ...inbox, filter }); };
  const closeSearch = () => {
    setQuery(''); setSearchTab(undefined);
    searchTrigger.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    if (searching && focusSearch.current) { focusSearch.current = false; searchInput.current?.focus(); }
  }, [searching]);
  const setScope = (botScope?: BotScope) => { positions.current.messages = 0; updateInbox({ ...inbox, botScope }); };
  const browseBot = (hostId: string, botId: string) => {
    setSearchTab(undefined);
    positions.current.messages = 0;
    updateInbox({ ...inbox, query: '', filter: 'all', botScope: { hostId, botId } });
    setTab('messages');
  };
  useBackAction(body, () => {
    if (visible && bulk?.active) { bulk.cancel(); return; }
    if (visible && searching) { closeSearch(); return; }
    if (!visible || tab !== 'messages' || !botScope) return false;
    setScope(undefined);
  });
  useLayoutEffect(() => {
    if (visible && body.current) body.current.scrollTop = positions.current[tab];
  }, [visible, tab, query, filter, botScope?.hostId, botScope?.botId, positions]);
  const showTickets = useTicketConversationsVisible();
  const rows = useMemo(() => buildMobileRows(hosts), [hosts, showTickets]);
  const botCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) for (const id of row.conversation.botIds) {
      const key = botScopeKey(row.hostId, id);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [rows]);
  const scopeHost = hosts.find(host => host.id === botScope?.hostId);
  const scopeBot = scopeHost?.bots.find(bot => bot.id === botScope?.botId);
  const visibleKeys = new Set(hosts.flatMap(host => navigationItems(host, props.showDisconnectedBots).conversations.map(chat => botScopeKey(host.id, chat.id))));
  const scopedAllRows = botScope ? rows.filter(row => row.hostId === botScope.hostId && row.conversation.botIds.includes(botScope.botId)) : rows;
  const scopedRows = scopedAllRows.filter(row => visibleKeys.has(botScopeKey(row.hostId, row.conversation.id)));
  const activeHost = hosts.find((host) => host.id === activeHostId);
  const needle = query.trim().toLocaleLowerCase();
  const totalUnread = rows.reduce((sum, row) => sum + row.unread, 0);
  const scoped = tab === 'messages' && !!botScope;
  const title = scoped ? scopeBot ? t('{0} 的对话', scopeBot.name) : t('Bot 已不可用')
    : tab === 'messages' ? t('消息') : tab === 'bots' ? t('Bot') : t('我的');
  const pane: PaneProps = { ...props, rows: scopedRows, hiddenConversations: scopedRows.length < scopedAllRows.length, activeHost, needle, query, filter, locale, botScope, browseBot, botCounts, openActions };

  const header = (<>
      <header className="mh-header">
        <ConversationBulkToolbar mobile/>
        <div className="mh-titlebar" data-scoped={scoped || undefined}>
          {scoped && <button type="button" className="mh-icon-button" aria-label={t('显示全部 Bot 的对话')} onClick={() => setScope(undefined)}><ArrowLeft size={22}/></button>}
          <div className="mh-heading">
            <h1 className="mh-title" title={title}>{title}</h1>
            {scoped && hosts.length > 1 && scopeHost && <span className="mh-scope-host">{scopeHost.name}</span>}
          </div>
          {tab !== 'me' && <button ref={searchTrigger} type="button" className="mh-icon-button" aria-label={searching ? t('关闭搜索') : t('搜索会话或 Bot')} aria-expanded={searching} onClick={() => {
            if (searching) closeSearch();
            else { focusSearch.current = true; setSearchTab(tab); }
          }}>{searching ? <CloseIcon size={22}/> : <SearchIcon size={22}/>}</button>}
          {tab === 'messages' && scopeHost && scopeBot ? !isDispatcher(scopeBot) && (
            <button type="button" className="mh-icon-button" aria-label={t('与 {0} 新建对话', scopeBot.name)} onClick={() => props.newChat(scopeHost.id, scopeBot.id)}><PlusIcon size={22}/></button>
          ) : tab !== 'me' && (
            <CreateMenu hostName={hosts.length === 1 ? activeHost?.name : undefined} disabled={hosts.length === 0} onCreate={create} />
          )}
        </div>
        {searching && <SearchField key={tab} inputRef={searchInput} value={query} onChange={setQuery} close={closeSearch} scoped={tab === 'messages' && !!botScope} />}
        {tab === 'messages' && <div className="mh-filter-toolbar"><FilterBar value={filter} onChange={setFilter}/><MobileListOptions
          hosts={hosts} scopedHostId={botScope?.hostId} visible={visible} disabled={!!bulk?.active}
          groupByHost={props.groupByHost ?? false} changeGroupByHost={props.changeGroupByHost}
          showDisconnectedBots={props.showDisconnectedBots ?? false} changeShowDisconnectedBots={props.changeShowDisconnectedBots}
        /></div>}
      </header>
      {props.notice}
      {tab !== 'me' && <HomeConnectionNotice host={scopeHost ?? activeHost} manage={() => props.open('hosts')}/>}
  </>);
  return (
    <ListAvatarSize.Provider value={mobileListAvatarSizes[props.density ?? 'standard']}><div className="mobile-home" data-tab={tab} data-bulk={bulk?.active || undefined}>
      {tab !== 'me' && header}
      <div className="mh-body" key={tab} ref={body} onScroll={(event) => { if (visible) positions.current[tab] = event.currentTarget.scrollTop; }}>
        {tab === 'messages' && <MessagesPane {...pane} />}
        {tab === 'bots' && <BotsPane {...pane} />}
        {tab === 'me' && <>{header}<MePane {...pane} /></>}
      </div>
      {bulk?.active ? <ConversationBulkActions/> : <TabBar tab={tab} setTab={setTab} unread={totalUnread} />}
      {visible && actionTarget && actionHost && <MobileConversationActions key={`${actionTarget.hostId}\0${actionTarget.conversationId}`} host={actionHost} conversationId={actionTarget.conversationId} returnFocus={actionTrigger} close={() => setActionTarget(undefined)}/>}
    </div></ListAvatarSize.Provider>
  );
}, (previous, next) => previous.visible === false && next.visible === false);

/** The desktop connection pill is hidden on phones. Keep recovery visible even
 * when filtering disconnected Bots leaves a nonempty list of groups. */
function HomeConnectionNotice({ host, manage }: { host?: MobileHost; manage: () => void }) {
  if (!host || host.viewingHistory || host.connection.state.status === 'online') return null;
  const connection = host.connection, blocked = connection.isReadOnly || connection.isClosed;
  return <section className="mh-connection-notice" role="status" aria-label={t('主机连接状态')}>
    <WifiOff size={17} aria-hidden="true"/>
    <div><strong>{blocked ? t('未连接到「{0}」', host.name) : t('正在连接「{0}」', host.name)}</strong><p>{blocked ? t('连接暂不可用，已缓存的记录仍保留。') : retainsOfflineNavigation(connection) ? t('正在自动重连，断线 5 分钟内保留对话列表。') : t('正在自动重连，对话记录仍保留。')}</p></div>
    {blocked ? <button type="button" onClick={manage}>{t('主机管理')}</button> : <button type="button" aria-label={t('重试连接')} disabled={connection.state.status === 'connecting'} onClick={() => connection.resume(true)}><RefreshCw size={15} aria-hidden="true"/>{t('重试')}</button>}
  </section>;
}

type PaneProps = MobileHomeProps & {
  rows: MobileConversationRow[];
  hiddenConversations: boolean;
  activeHost: MobileHost | undefined;
  needle: string;
  query: string;
  filter: MobileFilter;
  locale: Locale;
  botScope?: BotScope;
  botCounts: Map<string, number>;
  browseBot: (hostId: string, botId: string) => void;
  openActions: (row: HTMLElement) => void;
};

function MessagesPane({
  hosts, rows, hiddenConversations, activeHost, needle, query, filter, locale, select, newChat, settingsBot, create, open, searchHistory, botScope, botCounts, browseBot, openActions, groupByHost = false, showDisconnectedBots = false, visible: paneVisible = true,
}: PaneProps) {
  if (hosts.length === 0) {
    return <EmptyState text={t('还没有可用的主机')} action={{ label: t('主机管理'), onClick: () => open('hosts') }} />;
  }
  const multiHost = hosts.length > 1;
  const grouped = multiHost && groupByHost && !botScope;
  const connectedBotAvailable = hosts.some(host => (!botScope || host.id === botScope.hostId)
    && host.connection.state.status === 'online' && host.bots.some(bot => bot.online && (!botScope || bot.id === botScope.botId)));
  const hostById = new Map(hosts.map((host) => [host.id, host] as const));
  const visible = rows.filter((row) => matchesRow(row, needle) && passesFilter(row, filter));
  const globalRows = visible.filter(row => row.globallyPinned);
  const ordinary = visible.filter(row => !row.globallyPinned);
  const bots = !botScope && needle && filter === 'all' ? matchingBots(hosts, needle, showDisconnectedBots) : [];
  const scopeAvailable = !botScope || hosts.some(host => host.id === botScope.hostId && host.bots.some(bot => bot.id === botScope.botId));
  const scopedHosts = hosts.filter(host => !botScope || host.id === botScope.hostId);
  const folderHosts = folderSectionHosts(scopedHosts, rows);
  const folderHostIds = new Set(folderHosts.map(host => host.id));
  const sectionHosts = grouped ? scopedHosts : folderHosts;
  const filtered = !!needle || filter !== 'all' || !!botScope;
  const hasVisibleRows = (host: MobileHost) => ordinary.some(row => row.hostId === host.id) || !filtered && !!host.connection.state.conversationFolders?.folders.length;
  const renderRow = (row: MobileConversationRow, showHost: boolean) => {
    const host = hostById.get(row.hostId); if (!host) return null;
    return <AvatarProvider connection={host.connection} conversations={host.conversations} directory={host.bots}><BotReferences bots={host.bots}><ConversationRow row={row} connection={host.connection} conversations={host.conversations} dispatcher={row.conversation.type === 'direct' && !row.conversation.parentId && isDispatcher(host.bots.find(bot => bot.id === row.conversation.botIds[0]))} multiHost={showHost} locale={locale} attentionOnly={filter === 'attention'} onSelect={select} onActions={openActions}/></BotReferences></AvatarProvider>;
  };
  const renderFolders = (host: MobileHost, showHostBadge: boolean) => <FolderSections connection={host.connection} hostName={host.name} showHostBadge={showHostBadge} visible={paneVisible} holdActions rows={ordinary.filter(row => row.hostId === host.id)} filtered={!!needle || filter !== 'all' || !!botScope} renderRow={row => renderRow(row, false)}/>;
  const renderList = (items: MobileConversationRow[], showHost: boolean) => <ul className="mh-list">{items.map(row => <li key={row.key}>{renderRow(row, showHost)}</li>)}</ul>;
  const emptyText = rows.length === 0
    ? hiddenConversations ? t('未连接的 Bot 已隐藏，勾选「显示未连接 Bot」即可查看。') : !scopeAvailable ? t('此 Bot 已不可用，请选择其他 Bot') : botScope ? t('还没有与此 Bot 的会话') : t('还没有会话')
    : needle
      ? t('没有匹配的会话')
      : filter === 'unread'
        ? t('没有未读会话')
        : filter === 'attention'
          ? t('暂无待处理请求')
          : t('没有群组');

  return (
    <>
      {botScope && <p className="mh-scope-help">{t('含参与的群组 · 不含已归档对话')}</p>}
      {filter === 'attention' && <p className="mh-attention-help">{t('待回答、待审批或待主机确认的请求；仅显示已同步到本机的消息。')}</p>}
      {needle && !botScope && (
        <button
          type="button"
          className="mh-history"
          aria-label={t('搜索历史消息')}
          disabled={!activeHost}
          onClick={() => searchHistory(query.trim())}
        >
          <span className="mh-history-icon" aria-hidden="true"><SearchIcon size={18} /></span>
          <span className="mh-history-text">
            <span className="mh-history-label">{t('搜索历史消息')}</span>
            <span className="mh-history-scope">
              {activeHost ? t('仅当前主机：{0}', activeHost.name) : t('未选择主机')}
            </span>
          </span>
          <span className="mh-cell-chevron" aria-hidden="true"><ChevronIcon size={18} /></span>
        </button>
      )}
      {bots.length > 0 && (
        <section>
          <SectionHead title={t('Bot')} />
          <ul className="mh-list">
            {bots.map(({ host, bot }) => (
              <li key={`${host.id}\u0000${bot.id}`}>
                <AvatarProvider connection={host.connection} conversations={host.conversations} directory={host.bots}>
                  <BotRow host={host} bot={bot} count={botCounts.get(botScopeKey(host.id, bot.id)) ?? 0} showHost={multiHost} onBrowse={browseBot} onNew={newChat} onSettings={settingsBot} />
                </AvatarProvider>
              </li>
            ))}
          </ul>
        </section>
      )}
      {bots.length > 0 && visible.length > 0 && <SectionHead title={t('会话')}/>}
      {globalRows.length > 0 && <GlobalPinSection>{renderList(globalRows, multiHost && !botScope)}</GlobalPinSection>}
      {/* Folders keep their owning host, just like the desktop combined list.
          Keep their keyed owners mounted across grouping/filter changes so
          collapsed folders retain their state; label each branch only once. */}
      {sectionHosts.map(host => <section key={host.id} className="mh-folder-host" data-folder-host={host.id} data-pin-scope={host.connection.identity.hubPublicKey ? JSON.stringify([host.connection.identity.hubPublicKey, host.connection.identity.publicKey]) : undefined} hidden={!hasVisibleRows(host)}>
        {grouped && <h3 className="mh-folder-host-title">{host.name}</h3>}
        {folderHostIds.has(host.id) ? renderFolders(host, multiHost && !grouped && !botScope) : renderList(ordinary.filter(row => row.hostId === host.id), false)}
      </section>)}
      {!grouped && ordinary.some(row => !folderHostIds.has(row.hostId)) && <section>
        {renderList(ordinary.filter(row => !folderHostIds.has(row.hostId)), multiHost && !botScope)}
      </section>}
      {visible.length === 0 && bots.length === 0 && (
        <EmptyState
          text={emptyText}
          action={rows.length === 0 && scopeAvailable && (!hiddenConversations || connectedBotAvailable) ? { label: t('新建对话'), onClick: () => botScope ? newChat(botScope.hostId, botScope.botId) : create('direct') } : undefined}
        />
      )}
    </>
  );
}

function ConversationRow({ row, connection, conversations, dispatcher, multiHost, locale, attentionOnly, onSelect, onActions }: {
  row: MobileConversationRow;
  connection: HubConnection;
  conversations: Conversation[];
  dispatcher: boolean;
  multiHost: boolean;
  locale: Locale;
  attentionOnly: boolean;
  onActions: (row: HTMLElement) => void;
  onSelect: (hostId: string, conversationId: string, messageId?: string) => void;
}) {
  const avatarSize = useContext(ListAvatarSize);
  const bulk = useConversationBulk();
  const { conversation } = row;
  const draftPreview = useDraftPreviewText(connection.cache, conversation, conversations, true);
  const isGroup = conversation.type === 'group' && !conversation.parentId;
  const title = titleOf(conversation);
  const botId = conversation.botIds[0];
  const tag = conversation.parentId ? conversations.find(parent => parent.id === conversation.parentId)?.title ?? t('独立话题') : isGroup ? t('群组') : row.botNames.join(locale === 'zh' ? '、' : ', ');
  const target = attentionOnly ? row.attention[0] : undefined;
  const attentionLabel = target?.kind === 'approval' ? t('审批请求') : t('回答请求');
  const preview = target
    ? target.topicTitle ? t('{0}：{1}', target.topicTitle, attentionLabel) : attentionLabel
    : !row.preview
    ? t('暂无消息')
    : row.previewTopic
      ? t('{0}：{1}', row.previewTopic, row.preview)
      : row.preview;

  return (
    <button
      type="button"
      className={`mh-row ${bulk?.active ? 'conversation-bulk-row' : ''}`}
      role={bulk?.active ? 'checkbox' : undefined}
      aria-checked={bulk?.active ? bulk.checked(connection, conversation) : undefined}
      aria-label={bulk?.active ? t('选择对话：{0}', title) : undefined}
      disabled={bulk?.active && !!bulk.reason(connection, conversation)}
      title={bulk?.active ? bulk.reason(connection, conversation) : undefined}
      data-host-id={row.hostId}
      data-pin-scope={connection.identity.hubPublicKey ? JSON.stringify([connection.identity.hubPublicKey, connection.identity.publicKey]) : undefined}
      data-conversation-id={conversation.id}
      data-unread={row.unread > 0 || undefined}
      data-attention={row.attention.length || undefined}
      aria-haspopup={bulk?.active ? undefined : "dialog"}
      onContextMenu={event => { event.preventDefault(); onActions(event.currentTarget); }}
      onKeyDown={event => { if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) { event.preventDefault(); onActions(event.currentTarget); } }}
      onClick={() => bulk?.active ? bulk.toggle(connection, conversation) : onSelect(row.hostId, target?.conversationId ?? conversation.id, target?.messageId)}
    >
      <AgentAvatar signal={row.agent} size={avatarSize} className="mh-avatar" dispatcher={dispatcher} tickets={dispatcher ? { connection, botId: conversation.botIds[0]! } : undefined}>
        <ConversationAvatar conversation={conversation} size={avatarSize}/>
        {row.unread > 0 && <span className="mh-badge"><span aria-hidden="true">{badgeText(row.unread)}</span></span>}
        {bulk?.active && <ConversationBulkCheck checked={bulk.checked(connection, conversation)}/>}
      </AgentAvatar>
      <span className="mh-row-main">
        <span className="mh-row-top">
          <span className="mh-row-title">{title}</span>
          {tag && <span className="mh-row-tag">{isGroup || conversation.parentId ? tag : <BotName id={botId ?? ""} name={tag} compact/>}</span>}
          {(row.pinned || row.globallyPinned) && (
            <span className="mh-pin" role="img" aria-label={row.globallyPinned ? t('已全局置顶') : t('已分组置顶')}><PinIcon size={13} /></span>
          )}
          <span className="mh-row-time">{formatRowTime(target?.at ?? row.activityAt, locale)}</span>
        </span>
        <span className="mh-row-bottom">
          <span className="mh-row-preview">{!target && draftPreview ? <DraftPreviewText text={draftPreview}/> : <ReferencePreview text={preview}/>}</span>
          {multiHost && <HostSourceBadge name={row.hostName}/>}
          {row.attention.length > 0 && <span className="mh-attention-badge">{t('{0} 条待处理', String(row.attention.length))}</span>}
          {row.unread > 0 && <span className="mh-sr-only">{t('{0} 条未读', String(row.unread))}</span>}
        </span>
      </span>
    </button>
  );
}

function BotRow({ host, bot, count, showHost, onBrowse, onNew, onSettings }: {
  host: MobileHost;
  bot: Bot;
  count: number;
  showHost: boolean;
  onBrowse: (hostId: string, botId: string) => void;
  onNew: (hostId: string, botId: string) => void;
  onSettings: (hostId: string, botId: string) => void;
}) {
  const avatarSize = useContext(ListAvatarSize);
  const online = isHostConnected(host.connection.state.status) && bot.online > 0;
  const meta = bot.engine;
  const body = (
    <>
      <AgentAvatar signal={botAgentSignal(host, bot.id)} size={avatarSize} className="mh-avatar" dispatcher={isDispatcher(bot)} tickets={isDispatcher(bot) ? { connection: host.connection, botId: bot.id } : undefined}>
        <Avatar kind="bot" id={bot.id} name={bot.name} size={avatarSize} />
        {online && <span className="mh-presence" role="img" aria-label={t('在线')} />}
      </AgentAvatar>
      <span className="mh-row-main">
        <span className="mh-row-top">
          <span className="mh-row-title"><BotName id={bot.id} name={bot.name} bot={bot}/></span>
          {meta && <span className="mh-row-tag">{meta}</span>}
        </span>
        <span className="mh-row-bottom">
          <span className="mh-row-preview">
            {t('{0} 个会话 · 查看全部', String(count))}
          </span>
          {showHost && <HostSourceBadge name={host.name}/>}
        </span>
      </span>
    </>
  );

  return (
    <div className="mh-bot-row">
      <button type="button" className="mh-bot-main" aria-label={t('查看 {0} 的全部对话', bot.name)} onClick={() => onBrowse(host.id, bot.id)}>{body}</button>
      {/* A dispatcher Bot keeps exactly one conversation. */}
      {!isDispatcher(bot) && <button
        type="button"
        className="mh-new-chat"
        aria-label={t('与 {0} 新建对话', bot.name)}
        onClick={() => onNew(host.id, bot.id)}
      >
        <PlusIcon size={16} />
        <span>{t('新对话')}</span>
      </button>}
      <button type="button" className="mh-bot-settings" data-bot-settings={bot.id} data-settings-host={host.id} aria-label={t('{0} 的 Bot 设置', bot.name)} title={t('Bot 设置')} onClick={event => { event.currentTarget.focus(); onSettings(host.id, bot.id); }}><Settings size={20} /></button>
    </div>
  );
}

function BotsPane({ hosts, activeHostId, needle, browseBot, botCounts, newChat, settingsBot, open, showDisconnectedBots = false, changeShowDisconnectedBots }: PaneProps) {
  if (hosts.length === 0) {
    return <EmptyState text={t('还没有可用的主机')} action={{ label: t('主机管理'), onClick: () => open('hosts') }} />;
  }
  const sections = hosts
    .map((host) => ({
      host,
      bots: navigationItems(host, showDisconnectedBots).bots.filter((bot) => !needle || bot.name.toLocaleLowerCase().includes(needle)),
    }))
    .filter(({ host, bots }) => bots.length > 0 || !needle && !host.bots.length);
  const hiddenBots = hosts.some(host => navigationItems(host, showDisconnectedBots).bots.length < host.bots.length);

  return (
    <>
      {changeShowDisconnectedBots && <div className="mh-list-options"><DisconnectedBotsSwitch checked={showDisconnectedBots} change={changeShowDisconnectedBots}/></div>}
      {sections.length === 0 && <EmptyState text={hiddenBots && !needle ? t("未连接的 Bot 已隐藏，勾选「显示未连接 Bot」即可查看。") : t("没有匹配的 Bot")}/>}
      {sections.map(({ host, bots }) => {
        const status = hostStatus(host.connection.state.status);
        return (
          <section key={host.id}>
            <SectionHead title={host.name}>
              {host.id === activeHostId && <span className="mh-current">{t('当前主机')}</span>}
              <span className="mh-status" data-tone={status.tone}>{status.label}</span>
            </SectionHead>
            {bots.length > 0 ? (
              <ul className="mh-list">
                {bots.map((bot) => (
                  <li key={bot.id}>
                    <AvatarProvider connection={host.connection} conversations={host.conversations} directory={host.bots}>
                      <BotRow host={host} bot={bot} count={botCounts.get(botScopeKey(host.id, bot.id)) ?? 0} showHost={hosts.length > 1} onBrowse={browseBot} onNew={newChat} onSettings={settingsBot} />
                    </AvatarProvider>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mh-section-empty">{t('此主机暂无 Bot')}</p>
            )}
          </section>
        );
      })}
    </>
  );
}

function notificationSummary(host: MobileHost | undefined): string {
  const state = host?.connection.state;
  if (!state || state.status !== 'online') return t('连接主机后可设置');
  if (!state.notifications) return t('查看通知权限与接收状态');
  if (!Object.values(state.notifications.providers).some(Boolean)) return t('后台推送尚未配置');
  return state.notifications.preferences.enabled ? t('已请求提醒 · 点此检查接收状态') : t('未开启 · 点此设置');
}

function MePane({ hosts, activeHost, selectHost, open }: PaneProps) {
  const userId = activeHost?.connection.state.user?.id;
  const computerNames = hosts.map((host) => {
    const state = host.connection.state;
    // Shared names identify the computer; older pairings may only have the
    // generic local alias. The shell already resolves the newest acknowledged
    // name; strip only the registry's own disambiguation suffix.
    const suffix = ` · ${host.id.slice(4, 12)}`;
    const savedName = host.name.endsWith(suffix) ? host.name.slice(0, -suffix.length) : host.name;
    return ['我的主机', 'My host'].includes(savedName)
      ? state.hostProfile?.name ?? state.network?.host.name ?? t('已配对电脑') : savedName;
  });
  const nameCounts = new Map<string, number>();
  for (const name of computerNames) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  const computerLabels = computerNames.map((name, index) => nameCounts.get(name)! > 1 ? `${name} · ${hosts[index]!.id.slice(4, 12)}` : name);
  return (
    <div className="mh-me">
      <button type="button" className="mh-me-card" data-settings-entry="profile" aria-label={t("个人头像")} onClick={(event) => { event.currentTarget.focus(); open("settings"); }}>
        <span className="mh-avatar">
          {activeHost && userId ? (
            <AvatarProvider connection={activeHost.connection} conversations={activeHost.conversations} directory={activeHost.bots}>
              <Avatar kind="user" id={userId} name={t('我')} size={56} />
            </AvatarProvider>
          ) : (
            <span className="mh-avatar-fallback" aria-hidden="true"><UserIcon size={26} /></span>
          )}
        </span>
        <span className="mh-me-text">
          <span className="mh-me-name">{t('我')}</span>
          <span className="mh-me-sub">
            {t('语言、外观与个人头像')}
          </span>
        </span>
        <span className="mh-cell-chevron" aria-hidden="true"><ChevronIcon size={18} /></span>
      </button>

      {hosts.length > 0 && (
        <section>
          <h2 className="mh-group-title">{t('运行 Bot 的电脑')}</h2>
          <p className="mh-group-description">{t('选择一台电脑，查看它的文件、能力与运行状态。')}</p>
          <ul className="mh-group">
            {hosts.map((host, index) => {
              const current = host.id === activeHost?.id;
              const status = hostStatus(host.connection.state.status);
              const label = computerLabels[index]!;
              return (
                <li key={host.id}>
                  <button
                    type="button"
                    className="mh-cell"
                    aria-pressed={current}
                    onClick={() => selectHost(host.id)}
                  >
                    <span className="mh-cell-icon" aria-hidden="true"><MonitorIcon /></span>
                    <span className="mh-cell-label">{label}</span>
                    <span className="mh-status" data-tone={status.tone}>{status.label}</span>
                    <span className="mh-cell-check" aria-hidden="true">{current && <CheckIcon size={18} />}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section><ul className="mh-group">
          <Cell icon={<MonitorIcon />} labelOnly label={t('设备与网络')} description={t('添加手机或电脑 · 显示二维码')} onClick={() => open('hosts')} />
          <Cell settingsEntry="connection" icon={<Wifi size={20}/>} label={t('连接状态与线路')} description={computerLabels[hosts.findIndex(host => host.id === activeHost?.id)]} disabled={!activeHost} onClick={() => open('connection')} />
      </ul></section>

      <section>
        <h2 className="mh-group-title">
          {t('所选电脑的工具')}
        </h2>
        <ul className="mh-group">
          <Cell icon={<FolderIcon />} label={t('文件中心')} disabled={!activeHost} onClick={() => open('files')} />
          <Cell settingsEntry="capabilities" icon={<PlugIcon />} label={t('Skills 与 MCP')} disabled={!activeHost} onClick={() => open('capabilities')} />
          <Cell icon={<CalendarClock />} label={t('定时任务')} disabled={!activeHost} onClick={() => open('schedules')} />
          <Cell settingsEntry="operations" icon={<ActivityIcon />} label={t('运行状态')} disabled={!activeHost} onClick={() => open('operations')} />
          <Cell icon={<ShieldCheck size={20}/>} label={t('设备与安全')} description={t('设备名称与访问授权')} disabled={!activeHost} onClick={() => open('devices')} />
          <Cell icon={<ArchiveIcon />} label={t('已归档对话')} disabled={!activeHost} onClick={() => open('archives')} />
        </ul>
      </section>

      <section>
        <ul className="mh-group">
          <Cell icon={<Bell size={20}/>} label={t('消息通知')} description={notificationSummary(activeHost)} disabled={!activeHost} onClick={() => open('notifications')} />
          <Cell settingsEntry="settings" icon={<SlidersIcon />} label={t('设置')} onClick={() => open('settings')} />
        </ul>
      </section>
    </div>
  );
}

function Cell({ icon, label, description, disabled, onClick, settingsEntry, labelOnly }: {
  description?: string;
  labelOnly?: boolean;
  settingsEntry?: "settings" | "connection" | "capabilities" | "operations";
  icon: ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button type="button" className="mh-cell" aria-label={settingsEntry === "connection" || labelOnly ? label : undefined} data-settings-entry={settingsEntry} disabled={disabled} onClick={(event) => { event.currentTarget.focus(); onClick(); }}>
        <span className="mh-cell-icon" aria-hidden="true">{icon}</span>
        <span className="mh-cell-label">{label}{description && <small className="mh-cell-description">{description}</small>}</span>
        <span className="mh-cell-chevron" aria-hidden="true"><ChevronIcon size={18} /></span>
      </button>
    </li>
  );
}

function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mh-section-head">
      <h2 className="mh-section-title">{title}</h2>
      {children}
    </div>
  );
}

function EmptyState({ text, action }: { text: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="mh-empty">
      <p>{text}</p>
      {action && (
        <button type="button" className="mh-empty-action" onClick={action.onClick}>{action.label}</button>
      )}
    </div>
  );
}

function SearchField({ value, onChange, scoped, close, inputRef }: { value: string; onChange: (value: string) => void; scoped?: boolean; close: () => void; inputRef: RefObject<HTMLInputElement | null> }) {
  const label = scoped ? t('查找此 Bot 的会话') : t('查找会话或 Bot');
  const [text, setText] = useState(value), composing = useRef(false);
  useEffect(() => { if (!composing.current) setText(value); }, [value]);
  return (
    <div className="mh-search">
      <span className="mh-search-icon" aria-hidden="true"><SearchIcon size={18} /></span>
      <input
        ref={inputRef}
        type="search"
        value={text}
        aria-label={label}
        placeholder={label}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={(event) => { composing.current = false; setText(event.currentTarget.value); onChange(event.currentTarget.value); }}
        onChange={(event) => { setText(event.target.value); if (!composing.current) onChange(event.target.value); }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing) return;
          // Enter only dismisses the keyboard; history search stays an explicit button.
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
        }}
      />
      {text && (
        <button
          type="button"
          className="mh-search-clear"
          aria-label={t('清除搜索')}
          onClick={() => {
            composing.current = false; setText(''); onChange('');
            inputRef.current?.focus();
          }}
        >
          <CloseIcon size={16} />
        </button>
      )}
    </div>
  );
}

function FilterBar({ value, onChange }: { value: MobileFilter; onChange: (value: MobileFilter) => void }) {
  const items: Array<[MobileFilter, string]> = [
    ['all', t('全部')],
    ['unread', t('未读')],
    ['attention', t('待处理')],
    ['groups', t('群组')],
  ];
  return (
    <div className="mh-filters" data-tauri-drag-region="false" role="group" aria-label={t('筛选会话')}>
      {items.map(([id, label]) => (
        <button key={id} type="button" className="mh-chip" aria-pressed={value === id} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

const CREATE_MENU_ID = 'mh-create-menu';

function CreateMenu({ hostName, disabled, onCreate }: {
  hostName?: string;
  disabled: boolean;
  onCreate: (kind: MobileCreateKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useBackAction(menuRef, () => { setOpen(false); triggerRef.current?.focus(); });

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const last = items.length - 1;
    let next: number;
    if (event.key === 'ArrowDown') next = current < 0 || current === last ? 0 : current + 1;
    else if (event.key === 'ArrowUp') next = current <= 0 ? last : current - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else return;
    event.preventDefault();
    items[next]?.focus();
  };

  const choose = (kind: MobileCreateKind) => {
    setOpen(false);
    onCreate(kind);
  };

  const items: Array<{ kind: MobileCreateKind; label: string; icon: ReactNode }> = [
    { kind: 'direct', label: t('新建对话'), icon: <MessageIcon size={18} /> },
    { kind: 'group', label: t('新建群组'), icon: <UsersIcon size={18} /> },
    { kind: 'bot', label: t('新建 Bot'), icon: <BotIcon size={18} /> },
    { kind: 'schedule', label: t('新建定时任务'), icon: <CalendarClock size={18} /> },
  ];
  const scope = hostName ? t('在 {0} 上新建', hostName) : '';

  return (
    <div className="mh-create">
      <button
        ref={triggerRef}
        type="button"
        className="mh-icon-button"
        aria-label={t('新建')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? CREATE_MENU_ID : undefined}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <PlusIcon size={22} />
      </button>
      {open && (
        <>
          <div className="mh-create-scrim" aria-hidden="true" onClick={() => setOpen(false)} />
          <div
            ref={menuRef}
            id={CREATE_MENU_ID}
            className="mh-create-menu"
            role="menu"
            aria-label={scope || t('新建')}
            onKeyDown={onMenuKeyDown}
          >
            {scope && <div className="mh-create-scope" aria-hidden="true">{scope}</div>}
            {items.map((item) => (
              <button
                key={item.kind}
                type="button"
                role="menuitem"
                className="mh-menu-item"
                onClick={() => choose(item.kind)}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TabBar({ tab, setTab, unread }: { tab: MobileTab; setTab: (value: MobileTab) => void; unread: number }) {
  const items: Array<{ id: MobileTab; label: string; icon: ReactNode }> = [
    { id: 'messages', label: t('消息'), icon: <MessageTabIcon size={22} /> },
    { id: 'bots', label: t('Bot'), icon: <BotIcon size={22} /> },
    { id: 'me', label: t('我的'), icon: <UserIcon size={22} /> },
  ];
  return (
    <nav className="mh-tabbar" aria-label={t('主导航')}>
      {items.map((item) => {
        const badge = item.id === 'messages' && unread > 0;
        return (
          <button
            key={item.id}
            type="button"
            className="mh-tab"
            aria-current={tab === item.id ? 'page' : undefined}
            onClick={() => setTab(item.id)}
          >
            <span className="mh-tab-icon" aria-hidden="true">
              {item.icon}
              {badge && <span className="mh-tab-badge">{badgeText(unread)}</span>}
            </span>
            <span className="mh-tab-label">{item.label}</span>
            {badge && <span className="mh-sr-only">{t('{0} 条未读', String(unread))}</span>}
          </button>
        );
      })}
    </nav>
  );
}

type IconProps = { size?: number };

// `name` lets an opt-in skin (Pixel) redraw the glyph; other styles ignore it.
function Icon({ size = 20, name, children }: IconProps & { name?: string; children: ReactNode }) {
  return (
    <svg
      data-icon={name}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

function SearchIcon(props: IconProps) {
  return <Icon {...props} name="search"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>;
}

function PlusIcon(props: IconProps) {
  return <Icon {...props} name="plus"><path d="M12 5v14M5 12h14" /></Icon>;
}

function CloseIcon(props: IconProps) {
  return <Icon {...props} name="close"><path d="M18 6 6 18M6 6l12 12" /></Icon>;
}

function ChevronIcon(props: IconProps) {
  return <Icon {...props} name="chevron"><path d="m9 6 6 6-6 6" /></Icon>;
}

function CheckIcon(props: IconProps) {
  return <Icon {...props} name="check"><path d="M5 12.5 10 17 19 7" /></Icon>;
}

function MessageIcon(props: IconProps) {
  return <Icon {...props} name="message"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" /></Icon>;
}

function MessageTabIcon(props: IconProps) {
  return <Icon {...props} name="message"><path d="M7.7 18.95A9.5 8.3 0 1 0 3.55 15.38L2 21.4Z" /></Icon>;
}

function BotIcon(props: IconProps) {
  return (
    <Icon {...props} name="bot">
      <path d="M12 8V4H8" />
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
    </Icon>
  );
}

function UserIcon(props: IconProps) {
  return <Icon {...props} name="user"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Icon>;
}

function UsersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8" />
    </Icon>
  );
}

function PinIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 17v5" />
      <path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V17h14v-1.8a2 2 0 0 0-1.1-1.8l-1.8-.9a2 2 0 0 1-1.1-1.8V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
    </Icon>
  );
}

function FolderIcon(props: IconProps) {
  return <Icon {...props}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Icon>;
}

function PlugIcon(props: IconProps) {
  return <Icon {...props}><path d="M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z" /></Icon>;
}

function ActivityIcon(props: IconProps) {
  return <Icon {...props}><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></Icon>;
}

function SlidersIcon(props: IconProps) {
  return <Icon {...props}><path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4" /></Icon>;
}

function MonitorIcon(props: IconProps) {
  return <Icon {...props}><rect x="2" y="4" width="20" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></Icon>;
}
