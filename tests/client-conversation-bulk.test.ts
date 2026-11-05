import { expect, it } from 'vitest';
import { selectionAfterArchive, toggleConversationSelection } from '../client/src/conversation-bulk.js';
import type { Conversation } from '../src/client-protocol/index.js';
const chat = (id: string, parentId?: string) => ({ id, parentId, archived: false } as Conversation);
it('selecting a group coalesces topics, then deselecting it does not leave hidden destructive targets', () => {
  const group = chat('g'), topic = chat('t', 'g'), other = chat('other');
  const chats = [group, topic, other];
  expect(toggleConversationSelection(['t', 'other'], group, chats)).toEqual(['other', 'g']);
  expect(toggleConversationSelection(['g'], topic, chats)).toEqual(['g']);
  expect(toggleConversationSelection(['g'], group, chats)).toEqual([]);
});
it('never selects archived chats or a topic in an archived group and bounds selection', () => {
  const group = { ...chat('g'), archived: true }, topic = chat('t', 'g');
  expect(toggleConversationSelection([], group, [group, topic])).toEqual([]);
  expect(toggleConversationSelection([], topic, [group, topic])).toEqual([]);
  const full = Array.from({ length: 100 }, (_, i) => `c${i}`);
  expect(toggleConversationSelection(full, chat('next'), [])).toEqual(full);
});
it('moves a deleted current selection to its surviving group or most recent visible root, preserving unrelated selections', () => {
  const a = chat('a'), b = chat('b'), g = chat('g'), topic = chat('topic', 'g'); const all = [a, b, g, topic];
  expect(selectionAfterArchive('topic', ['topic'], all)).toBe('g');
  expect(selectionAfterArchive('a', ['a'], all, [a, b, g], { b: { at: 10 }, topic: { at: 20 } })).toBe('g');
  expect(selectionAfterArchive('a', ['a'], all, [a, b], { g: { at: 100 } })).toBe('b');
  expect(selectionAfterArchive('b', ['a'], all)).toBeUndefined();
  expect(selectionAfterArchive('a', ['a', 'b', 'g'], all)).toBe('');
});
