import { expect, it } from 'vitest';
import { conversationPendingQuestionTotal, conversationUnreadTotal, filterUnreadHostItems, isUnreadSelectionTarget, pendingQuestionsFor } from '../client/src/conversation-unread.js';
import { setTicketConversationsVisible } from '../client/src/dispatcher.js';
import type { Conversation } from '../src/client-protocol/index.js';
import type { ConversationActivity } from '../client/src/storage.js';
const chat = (id: string, archived = false, parentId?: string, type: Conversation['type'] = 'direct', botIds: string[] = []) =>
  ({ id, archived, parentId, type, botIds } as Conversation);
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

it('counts a hidden ticket conversation in the badge only while it waits for the owner', () => {
  const chats = [chat('home'), { ...chat('worker'), hidden: true } as Conversation];
  const waiting = { home: activity(1), worker: { ...activity(2), attention: { m0: { kind: 'approval' as const, at: 100 } } } };
  expect(conversationUnreadTotal(chats, waiting)).toBe(3);
  expect(filterUnreadHostItems(chats, waiting).matchingIds.has('worker')).toBe(true);
  const answered = { home: activity(1), worker: { ...activity(2), attention: {} } };
  expect(conversationUnreadTotal(chats, answered)).toBe(1);
  expect(filterUnreadHostItems(chats, answered).matchingIds.has('worker')).toBe(false);
});

it('filters unread conversations, bots, groups and retained open chats without including archived or read items', () => {
  const chats = [
    chat('d1', false, undefined, 'direct', ['botA']),
    chat('d2', false, undefined, 'direct', ['botA']),
    chat('d3', false, undefined, 'direct', ['botB']),
    chat('dPinned', false, undefined, 'direct', ['botPinnedOnly']),
    chat('dArchived', true, undefined, 'direct', ['botArchived']),
    chat('g1', false, undefined, 'group', ['botA']),
    chat('t1', false, 'g1', 'group'),
    chat('t2', false, 'g1', 'group'),
    chat('gPinnedParent', false, undefined, 'group', ['botA']),
    chat('tPinned', false, 'gPinnedParent', 'group'),
    chat('gArchived', true, undefined, 'group', ['botA']),
    chat('tUnderArchived', false, 'gArchived', 'group'),
  ];
  const state: Record<string, ConversationActivity> = {
    d1: activity(2),
    d2: activity(0),
    d3: activity(0),
    dPinned: activity(3),
    dArchived: activity(10),
    g1: activity(0),
    t1: activity(4),
    t2: activity(0),
    gPinnedParent: activity(0),
    tPinned: activity(1),
    gArchived: activity(0),
    tUnderArchived: activity(5),
  };

  const match = filterUnreadHostItems(chats, state, ['dPinned', 'tPinned']);
  expect([...match.matchingIds].sort()).toEqual(['d1', 'dPinned', 't1', 'tPinned']);
  // Globally pinned direct chat stays in GlobalPinSection, not as an empty Bot row.
  expect([...match.botIds].sort()).toEqual(['botA']);
  // g1 is included because t1 is a non-globally-pinned unread topic; gPinnedParent stays out of groups.
  expect([...match.groupIds]).toEqual(['g1']);
  // gPinnedParent remains in conversations so tPinned can still resolve its parent title.
  expect(match.conversations.map(c => c.id).sort()).toEqual(['d1', 'dPinned', 'g1', 'gPinnedParent', 't1', 'tPinned']);

  // Retained open conversation stays visible after its unread drops to 0, until navigating away.
  const retained = filterUnreadHostItems(chats, { ...state, d1: activity(0) }, ['dPinned', 'tPinned'], 'd1');
  expect(retained.matchingIds.has('d1')).toBe(true);
  expect(retained.botIds.has('botA')).toBe(true);

  // Archived conversations are never retained even if passed as retainedId.
  const archivedRetained = filterUnreadHostItems(chats, state, [], 'dArchived');
  expect(archivedRetained.matchingIds.has('dArchived')).toBe(false);
});

it('detects unread selection targets accurately for bots and conversations layouts', () => {
  const chats = [
    chat('d1', false, undefined, 'direct', ['botA']),
    chat('d2', false, undefined, 'direct', ['botA']),
    chat('g1', false, undefined, 'group', ['botA']),
    chat('t1', false, 'g1', 'group'),
    chat('gArchived', true, undefined, 'group', ['botA']),
    chat('tArchivedParent', false, 'gArchived', 'group'),
  ];
  const state = {
    d1: activity(1),
    d2: activity(0),
    g1: activity(0),
    t1: activity(2),
    gArchived: activity(3),
    tArchivedParent: activity(4),
  };
  expect(isUnreadSelectionTarget(chats, state, [], 'd1', 'bots')).toBe(true);
  expect(isUnreadSelectionTarget(chats, state, [], 'd2', 'bots')).toBe(false);
  expect(isUnreadSelectionTarget(chats, state, [], 'g1', 'conversations')).toBe(true);
  expect(isUnreadSelectionTarget(chats, state, [], 'g1', 'bots')).toBe(false);
  expect(isUnreadSelectionTarget(chats, state, [], 't1', 'bots')).toBe(true);
  expect(isUnreadSelectionTarget(chats, state, [], 'gArchived', 'conversations')).toBe(false);
  expect(isUnreadSelectionTarget(chats, state, [], 'tArchivedParent', 'bots')).toBe(false);
});

it('the 待处理 filter lists conversations with a question waiting for the owner, never command approvals', () => {
  const chats = [
    chat('asks', false, undefined, 'direct', ['botA']),
    chat('approves', false, undefined, 'direct', ['botB']),
    chat('unreadOnly', false, undefined, 'direct', ['botC']),
    chat('archivedAsk', true, undefined, 'direct', ['botD']),
    chat('g1', false, undefined, 'group', ['botA']),
    chat('topicAsk', false, 'g1', 'group'),
  ];
  const question = (id: string) => ({ [id]: { kind: 'question' as const, at: 100 } });
  const state: Record<string, ConversationActivity> = {
    asks: { ...activity(0), attention: { ...question('q1'), ...question('q2') } },
    approves: { ...activity(0), attention: { a1: { kind: 'approval' as const, at: 100 } } },
    unreadOnly: activity(4),
    archivedAsk: { ...activity(0), attention: question('q3') },
    g1: activity(0),
    topicAsk: { ...activity(0), attention: question('q4') },
  };
  expect(pendingQuestionsFor(state.asks)).toBe(2);
  expect(pendingQuestionsFor(state.approves)).toBe(0);
  expect(conversationPendingQuestionTotal(chats, state)).toBe(3);

  const pending = filterUnreadHostItems(chats, state, [], undefined, 'pending');
  expect([...pending.matchingIds].sort()).toEqual(['asks', 'topicAsk']);
  expect([...pending.botIds]).toEqual(['botA']);
  expect([...pending.groupIds]).toEqual(['g1']);
  // The Unread filter is unchanged: approvals and questions alone do not make a chat unread.
  expect([...filterUnreadHostItems(chats, state).matchingIds]).toEqual(['unreadOnly']);

  // An answered question leaves the list, except for the open conversation while it is being read.
  const answered = { ...state, asks: { ...activity(0), attention: {} } };
  expect(filterUnreadHostItems(chats, answered, [], undefined, 'pending').matchingIds.has('asks')).toBe(false);
  expect(filterUnreadHostItems(chats, answered, [], 'asks', 'pending').matchingIds.has('asks')).toBe(true);
  expect(isUnreadSelectionTarget(chats, state, [], 'asks', 'bots', 'pending')).toBe(true);
  expect(isUnreadSelectionTarget(chats, state, [], 'approves', 'bots', 'pending')).toBe(false);
});
