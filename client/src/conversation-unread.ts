import type { Conversation } from '../../src/client-protocol/index.js';
import type { ConversationActivity } from './storage.js';
import { listedConversations } from './dispatcher.js';

/** Count the canonical inbox, independently of search, folding and Bot presence.
 * Archived history retains its unread state for restoration but has no badge.
 * A topic is visible only with its live root; stale activity has no target.
 * Hidden ticket conversations count only while the device lists them. */
export function conversationUnreadTotal(all: readonly Conversation[], activity: Readonly<Record<string, ConversationActivity>>): number {
  const conversations = listedConversations(all);
  const roots = new Set(conversations.filter(chat => !chat.archived && !chat.parentId).map(chat => chat.id));
  let count = 0;
  for (const chat of conversations) {
    if (chat.archived || chat.parentId && !roots.has(chat.parentId)) continue;
    count += Object.keys(activity[chat.id]?.unread ?? {}).length;
  }
  return count;
}
