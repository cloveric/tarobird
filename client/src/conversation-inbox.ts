import type { Conversation } from '../../src/client-protocol/index.js';
import type { Bot, HubConnection } from './connection.js';
import type { ConversationActivity } from './storage.js';
import { attentionTargets, type AttentionTarget } from './attention.js';
import { agentSignal, type AgentSignal } from './agent-state.js';
import { conversationPreview } from './conversation-preview.js';
import { t } from './i18n.js';
import { listedConversations } from './dispatcher.js';
type Locale = 'zh' | 'en';

export type InboxHost = {
  id: string;
  name: string;
  connection: HubConnection;
  conversations: Conversation[];
  activity: Record<string, ConversationActivity>;
  pins: string[];
  globalPins?: string[];
  bots: Bot[];
  /** Explicitly opened, read-only history for this suspended host only. */
  viewingHistory?: boolean;
};

export function retainsOfflineNavigation(connection: HubConnection): boolean {
  return connection.state.status !== 'online' && !connection.isClosed && !connection.isReadOnly
    && (connection.state.navigationGraceUntil ?? 0) > Date.now();
}

/** A view-only filter. Brief link loss retains last-known visible Bots, without
 * changing their offline status or treating cached presence as reachability.
 * Keep groups/topics and memberless history; never mutate the canonical cache. */
export function navigationItems(host: Pick<InboxHost, 'connection' | 'bots' | 'conversations' | 'viewingHistory'>, showDisconnectedBots = false, retained?: ReadonlySet<string>) {
  const conversations = listedConversations(host.conversations);
  if (showDisconnectedBots || host.viewingHistory) return { bots: host.bots, conversations };
  const bots = host.connection.state.status === 'online' || retainsOfflineNavigation(host.connection) ? host.bots.filter(bot => !!bot.online) : [];
  const connected = new Set(bots.map(bot => bot.id));
  return {
    bots,
    conversations: conversations.filter(chat => retained?.has(chat.id) || chat.type !== 'direct' || !!chat.parentId || !chat.botIds.length || chat.botIds.some(id => connected.has(id))),
  };
}

/** Once custom folders are visible, every populated host uses folder headings
 * (including its implicit Unfiled section). Mixing headings with standalone
 * host-badged rows would put the same source information at two levels. */
export function folderSectionHosts(hosts: InboxHost[], rows: InboxRow[]): InboxHost[] {
  const hasFolders = (host: InboxHost) => !!host.connection.state.conversationFolders?.folders.length;
  if (!hosts.some(hasFolders)) return [];
  const populated = new Set(rows.map(row => row.hostId));
  return hosts.filter(host => hasFolders(host) || populated.has(host.id));
}

/** Use the same host-scoped Bot order in combined and per-host sidebars.
 * Presence, directory order and explicit conversation pins do not rank Bots. */
export function buildBotRows(hosts: Pick<InboxHost, 'id' | 'bots' | 'conversations' | 'activity'>[]) {
  return hosts.flatMap(host => {
    const archived = new Set(host.conversations.filter(c => c.archived).map(c => c.id));
    const times = new Map<string, number>();
    const names = new Map(host.bots.map(bot => [bot.id, bot.name]));
    for (const chat of listedConversations(host.conversations)) {
      const id = chat.botIds[0];
      if (!id || chat.type !== 'direct' || chat.archived || chat.parentId && archived.has(chat.parentId)) continue;
      times.set(id, Math.max(times.get(id) ?? 0, host.activity[chat.id]?.at ?? 0, chat.createdAt));
    }
    return [...new Set([...names.keys(), ...times.keys()])].map(id => ({
      hostId: host.id, id, key: `${host.id}\0${id}`, name: names.get(id) ?? id, at: times.get(id) ?? 0,
    }));
  }).sort((a, b) => b.at - a.at || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/** A Bot row reflects that Bot's own direct conversations (groups have rows). */
export function botAgentSignal(host: Pick<InboxHost, 'conversations' | 'activity'>, botId: string): AgentSignal {
  return agentSignal(listedConversations(host.conversations).filter(chat => chat.type === 'direct' && !chat.archived && chat.botIds[0] === botId).map(chat => host.activity[chat.id]));
}

export type InboxRow = {
  key: string;
  hostId: string;
  hostName: string;
  conversation: Conversation;
  botNames: string[];
  topicTitles: string[];
  parentTitle?: string;
  /** Markdown-free preview of the newest activity (own or from a live topic). */
  preview: string;
  /** Topic the preview came from, for group rows. */
  previewTopic?: string;
  /** 0 when nothing has been recorded yet; only real activity shows a time. */
  activityAt: number;
  sortAt: number;
  unread: number;
  attention: AttentionTarget[];
  /** Avatar state across the conversation and its folded topics. */
  agent: AgentSignal;
  pinned: boolean;
  globallyPinned?: boolean;
};


/** Activity is already scoped to the signed-in user's cache. Keys are message
 * IDs and values are content sequence numbers, not user IDs or unread counts. */
export function unreadFor(activity: ConversationActivity | undefined): number {
  return Object.keys(activity?.unread ?? {}).length;
}


/**
 * Flat cross-host list: one row per live direct conversation and per live
 * top-level group. Topics fold into their parent (newest preview, summed
 * unread); archived parents hide their topics, orphan topics are skipped.
 */
export function buildConversationRows(hosts: InboxHost[]): InboxRow[] {
  const rows: InboxRow[] = [];
  for (const host of hosts) {
    const conversations = listedConversations(host.conversations);
    const botNames = new Map(host.bots.map((bot) => [bot.id, bot.name] as const));
    const pins = new Set(host.pins);
    const globals = new Set(host.globalPins);
    const liveParents = new Set(conversations.filter(c => !c.archived && !c.parentId).map(c => c.id));
    const topicsByParent = new Map<string, Conversation[]>();
    for (const conversation of conversations) {
      if (!conversation.parentId || conversation.archived) continue;
      const siblings = topicsByParent.get(conversation.parentId);
      if (siblings) siblings.push(conversation);
      else topicsByParent.set(conversation.parentId, [conversation]);
    }
    for (const conversation of conversations) {
      if (conversation.archived || conversation.parentId && (!globals.has(conversation.id) || !liveParents.has(conversation.parentId))) continue;
      const topics = (topicsByParent.get(conversation.id) ?? []).filter(topic => !globals.has(topic.id));
      const own = host.activity[conversation.id];
      let latest = own;
      let latestTopic: Conversation | undefined;
      let unread = unreadFor(own);
      for (const topic of topics) {
        const activity = host.activity[topic.id];
        unread += unreadFor(activity);
        if (activity && (!latest || activity.at > latest.at)) {
          latest = activity;
          latestTopic = topic;
        }
      }
      const activityAt = latest?.at ?? 0;
      rows.push({
        key: `${host.id}\u0000${conversation.id}`,
        hostId: host.id,
        hostName: host.name,
        conversation,
        botNames: conversation.botIds
          .map((id) => botNames.get(id))
          .filter((name): name is string => Boolean(name)),
        topicTitles: topics.map((topic) => topic.title),
        parentTitle: conversation.parentId ? host.conversations.find(parent => parent.id === conversation.parentId)?.title : undefined,
        preview: latest ? conversationPreview(latest.preview) : '',
        previewTopic: latestTopic?.title,
        activityAt,
        sortAt: Math.max(activityAt, conversation.createdAt || 0),
        unread,
        attention: attentionTargets([conversation, ...topics], host.activity),
        agent: agentSignal([own, ...topics.map(topic => host.activity[topic.id])]),
        pinned: pins.has(conversation.id),
        globallyPinned: globals.has(conversation.id),
      });
    }
  }
  return rows.sort(compareRows);
}

function compareRows(a: InboxRow, b: InboxRow): number {
  if (!!a.globallyPinned !== !!b.globallyPinned) return a.globallyPinned ? -1 : 1;
  if (!a.globallyPinned && a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.sortAt !== b.sortAt) return b.sortAt - a.sortAt;
  return a.conversation.title.localeCompare(b.conversation.title) || a.key.localeCompare(b.key);
}


export function formatRowTime(at: number, locale: Locale, now: number = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  const tag = locale === 'zh' ? 'zh-CN' : 'en-US';
  const date = new Date(at);
  const today = new Date(now);
  const startOfDay = (daysAgo: number) =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo).getTime();
  if (at >= startOfDay(0)) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  if (at >= startOfDay(1)) return t('昨天');
  if (at >= startOfDay(6)) return new Intl.DateTimeFormat(tag, { weekday: 'short' }).format(date);
  if (date.getFullYear() === today.getFullYear()) {
    return new Intl.DateTimeFormat(tag, { month: 'numeric', day: 'numeric' }).format(date);
  }
  return new Intl.DateTimeFormat(tag, { year: 'numeric', month: 'numeric', day: 'numeric' }).format(date);
}

