import type { Conversation } from '../../src/client-protocol/index.js';
import { CONVERSATION_BATCH_LIMIT } from '../../src/client-protocol/conversation-batch.js';

export const CONVERSATION_BATCH_RECORD = 'conversation-batch';
export function toggleConversationSelection(ids: readonly string[], chat: Conversation, chats: readonly Conversation[]): string[] {
  if (ids.includes(chat.id)) return ids.filter(id => id !== chat.id);
  if (chat.archived || chat.parentId && (ids.includes(chat.parentId) || chats.some(parent => parent.id === chat.parentId && parent.archived))) return [...ids];
  const next = ids.filter(id => !chats.some(child => child.id === id && child.parentId === chat.id));
  return next.length >= CONVERSATION_BATCH_LIMIT ? [...ids] : [...next, chat.id];
}
export function availableConversation(chat: Conversation, chats: readonly Conversation[]): boolean {
  return !chat.archived && (!chat.parentId || !chats.some(parent => parent.id === chat.parentId && parent.archived));
}

/** Undefined means retain the current selection; an empty string clears it. */
export function selectionAfterArchive(selected: string, ids: readonly string[], chats: readonly Conversation[], candidates = chats, activity: Record<string, { at?: number }> = {}): string | undefined {
  const current = chats.find(chat => chat.id === selected);
  if (!ids.includes(selected) && !(current?.parentId && ids.includes(current.parentId))) return undefined;
  const available = candidates.filter(chat => !chat.parentId && availableConversation(chat, chats) && !ids.includes(chat.id));
  if (current?.parentId && available.some(chat => chat.id === current.parentId)) return current.parentId;
  const updated = new Map(chats.map(chat => [chat.id, activity[chat.id]?.at ?? chat.createdAt ?? 0]));
  for (const chat of chats) if (chat.parentId && !chat.archived) updated.set(chat.parentId, Math.max(updated.get(chat.parentId) ?? 0, updated.get(chat.id) ?? 0));
  return [...available].sort((a, b) => (updated.get(b.id) ?? 0) - (updated.get(a.id) ?? 0))[0]?.id ?? '';
}
