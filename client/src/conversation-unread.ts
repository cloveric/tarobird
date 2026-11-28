import type { Conversation } from '../../src/client-protocol/index.js';
import type { ConversationActivity, SidebarLayout } from './storage.js';
import { listedConversations } from './dispatcher.js';

export type UnreadHostMatch = {
  /** Live conversation IDs with unread > 0 or matching retainedId. */
  matchingIds: Set<string>;
  /** Live conversations needed to render matching items and resolve parent titles. */
  conversations: Conversation[];
  /** Bot IDs with at least one non-globally-pinned matching direct conversation. */
  botIds: Set<string>;
  /** Top-level group IDs that should render (own match or non-globally-pinned matching topic). */
  groupIds: Set<string>;
};

/** The desktop sidebar's filters beside 全部: unread messages, or questions a Bot is waiting on the owner to answer. */
export type InboxFilter = 'unread' | 'pending';

/** Questions (AskUserQuestion forms) waiting for the owner's answer in one conversation. Command approvals are not counted. */
export function pendingQuestionsFor(activity: ConversationActivity | undefined): number {
  return Object.values(activity?.attention ?? {}).filter(item => item.kind === 'question').length;
}

function filterCount(filter: InboxFilter, activity: ConversationActivity | undefined): number {
  return filter === 'pending' ? pendingQuestionsFor(activity) : Object.keys(activity?.unread ?? {}).length;
}

function liveUnreadConversations(all: readonly Conversation[], activity: Readonly<Record<string, ConversationActivity>>): Conversation[] {
  const conversations = listedConversations(all, activity);
  const roots = new Set(conversations.filter(chat => !chat.archived && !chat.parentId).map(chat => chat.id));
  return conversations.filter(chat => !chat.archived && (!chat.parentId || roots.has(chat.parentId)));
}

/** Count the canonical inbox, independently of search, folding and Bot presence.
 * Archived history retains its unread state for restoration but has no badge.
 * A topic is visible only with its live root; stale activity has no target.
 * Hidden ticket conversations count only while the device lists them or while
 * they wait for the owner. */
export function conversationUnreadTotal(all: readonly Conversation[], activity: Readonly<Record<string, ConversationActivity>>): number {
  let count = 0;
  for (const chat of liveUnreadConversations(all, activity)) {
    count += Object.keys(activity[chat.id]?.unread ?? {}).length;
  }
  return count;
}

/** The 待处理 badge: questions waiting for the owner across live conversations,
 * with the same live/archived and topic rules as `conversationUnreadTotal`. */
export function conversationPendingQuestionTotal(all: readonly Conversation[], activity: Readonly<Record<string, ConversationActivity>>): number {
  let count = 0;
  for (const chat of liveUnreadConversations(all, activity)) count += pendingQuestionsFor(activity[chat.id]);
  return count;
}

/** Determine which conversations, Bots, and groups remain visible under the
 * desktop Unread (or Pending) filter, using the exact same live/archived rules as
 * `conversationUnreadTotal`. Keeps `retainedId` visible while it is being read
 * so the row does not vanish mid-read until the user navigates away. */
export function filterUnreadHostItems(
  all: readonly Conversation[],
  activity: Readonly<Record<string, ConversationActivity>>,
  globalPins: readonly string[] = [],
  retainedId?: string,
  filter: InboxFilter = 'unread',
): UnreadHostMatch {
  const live = liveUnreadConversations(all, activity);
  const globals = new Set(globalPins);
  const matchingIds = new Set<string>();
  for (const chat of live) {
    if (filterCount(filter, activity[chat.id]) > 0 || retainedId !== undefined && chat.id === retainedId) {
      matchingIds.add(chat.id);
    }
  }
  const botIds = new Set<string>();
  const groupIds = new Set<string>();
  const neededParentIds = new Set<string>();
  for (const chat of live) {
    if (!matchingIds.has(chat.id)) continue;
    if (chat.type === 'direct' && !chat.parentId && chat.botIds[0] && !globals.has(chat.id)) {
      botIds.add(chat.botIds[0]);
    }
    if (chat.type === 'group' && !chat.parentId) {
      groupIds.add(chat.id);
    }
    if (chat.parentId) {
      neededParentIds.add(chat.parentId);
      if (!globals.has(chat.id)) {
        groupIds.add(chat.parentId);
      }
    }
  }
  const conversations = live.filter(chat => matchingIds.has(chat.id) || neededParentIds.has(chat.id));
  return { matchingIds, conversations, botIds, groupIds };
}

/** Whether opening `conversationId` targets an unread (or pending) item in the current layout
 * (so it should stay retained in the filtered list while being read). */
export function isUnreadSelectionTarget(
  all: readonly Conversation[],
  activity: Readonly<Record<string, ConversationActivity>>,
  globalPins: readonly string[] = [],
  conversationId: string,
  layout: SidebarLayout,
  filter: InboxFilter = 'unread',
): boolean {
  if (!conversationId) return false;
  const match = filterUnreadHostItems(all, activity, globalPins, undefined, filter);
  if (match.matchingIds.has(conversationId)) return true;
  return layout === 'conversations' && match.groupIds.has(conversationId);
}
