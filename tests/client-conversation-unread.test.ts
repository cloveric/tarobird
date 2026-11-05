import { expect, it } from 'vitest';
import { conversationUnreadTotal } from '../client/src/conversation-unread.js';
import { setTicketConversationsVisible } from '../client/src/dispatcher.js';
import type { Conversation } from '../src/client-protocol/index.js';
import type { ConversationActivity } from '../client/src/storage.js';
const chat = (id: string, archived = false, parentId?: string) => ({ id, archived, parentId } as Conversation);
const activity = (count: number): ConversationActivity => ({ preview: '', at: 1, lastContentSeq: 1, unread: Object.fromEntries(Array.from({ length: count }, (_, i) => [`m${i}`, 100 + i])) });

it('excludes 53 archived unread messages without erasing their state, and restores them with the conversation', () => {
  const chats = [chat('live'), chat('archived', true)];
  const state = { live: activity(0), archived: activity(53) };
  const before = JSON.stringify(state);
  expect(conversationUnreadTotal(chats, state)).toBe(0);
  expect(JSON.stringify(state)).toBe(before);
  expect(conversationUnreadTotal([chats[0]!, chat('archived')], state)).toBe(53);
});

it('counts live roots and topics once, excluding archived parents, archived topics and orphaned activity', () => {
  const chats = [chat('group'), chat('topic', false, 'group'), chat('archived-topic', true, 'group'), chat('archived-group', true), chat('hidden-topic', false, 'archived-group'), chat('orphan', false, 'missing'), chat('no-activity')];
  const state = Object.fromEntries(chats.map(c => [c.id, activity(c.id==='group' ? 2 : 3)]));
  delete state['no-activity']; state.stale = activity(100);
  expect(conversationUnreadTotal(chats, state)).toBe(5);
  expect(conversationUnreadTotal([], state)).toBe(0);
});

it('counts message IDs rather than sequence values and has no presence, filter or cross-host state', () => {
  const chats = [chat('same')];
  expect(conversationUnreadTotal(chats, { same: activity(2) })).toBe(2);
  expect(conversationUnreadTotal(chats, { same: activity(3) })).toBe(3);
  expect(conversationUnreadTotal(chats, { same: activity(0) })).toBe(0);
});

it('leaves hidden dispatcher worker conversations out of the badge unless the device lists them', () => {
  const chats = [chat('home'), { ...chat('worker'), hidden: true } as Conversation];
  const state = { home: activity(1), worker: activity(4) };
  expect(conversationUnreadTotal(chats, state)).toBe(1);
  setTicketConversationsVisible(true);
  try { expect(conversationUnreadTotal(chats, state)).toBe(5); } finally { setTicketConversationsVisible(false); }
});
