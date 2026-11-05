import { describe, expect, it } from 'vitest';
import { IDLE_AGENT, agentSignal, projectReply, type BotReply } from '../client/src/agent-state.js';
import type { Message } from '../src/client-protocol/index.js';

const message = (id: string, status: Message['status'], createdAt: number, extra: Partial<Message> = {}): Message =>
  ({ id, conversationId: 'chat', authorId: 'alpha', authorType: 'bot', blocks: [{ type: 'text', text: id }], status, version: 1, createdAt, ...extra }) as Message;
const reply = (id: string, status: Message['status'], at: number): BotReply => ({ id, status, createdAt: at, at });

describe('projectReply', () => {
  it('keeps work active after a newer question is answered or an attachment arrives', () => {
    const activity = { unread: {}, replies: {} };
    projectReply(activity, message('run', 'streaming', 10), 10);
    projectReply(activity, message('question', 'complete', 20), 20);
    expect(agentSignal([{ ...activity, attention: { question: { kind: 'question', at: 20 } } }])).toEqual({ state: 'ask', at: 20 });
    // Submitting/reading the separate card must not stop the main run.
    projectReply(activity, message('question', 'complete', 20), 30);
    expect(agentSignal([activity])).toEqual({ state: 'working', at: 10 });
    projectReply(activity, message('file', 'complete', 40), 40);
    projectReply(activity, message('run', 'streaming', 10), 50);
    expect(agentSignal([activity])).toEqual({ state: 'working', at: 50 });
    projectReply(activity, message('run', 'complete', 10), 60);
    expect(agentSignal([activity])).toBe(IDLE_AGENT);
  });

  it('settles only the matching running reply, including deletion and error', () => {
    const activity = { unread: {}, replies: {} };
    projectReply(activity, message('first', 'streaming', 10), 10);
    projectReply(activity, message('second', 'streaming', 20), 20);
    projectReply(activity, message('queued', 'pending', 30), 30);
    projectReply(activity, message('second', 'error', 20), 40);
    expect(agentSignal([activity])).toEqual({ state: 'working', at: 10 });
    projectReply(activity, message('first', 'deleted', 10), 50);
    expect(agentSignal([activity])).toBe(IDLE_AGENT);
  });

  it('does not count forwarded or mirrored work as this conversation running', () => {
    const activity = { unread: {}, replies: {} };
    projectReply(activity, message('forward', 'streaming', 10, { forwardedFrom: { conversationId: 'x', messageId: 'y' } } as Partial<Message>), 10);
    projectReply(activity, message('mirror', 'streaming', 20, { blocks: [{ type: 'card', elements: [], extra: { agentBusStage: { runId: 'run', workspaceId: 'ws', stageId: 's1', status: 'running' } } }] }), 20);
    expect(agentSignal([activity])).toBe(IDLE_AGENT);
  });

  it('keeps the newest ordinary reply per Bot and follows its status', () => {
    const activity: { replies?: Record<string, BotReply> } = {};
    projectReply(activity, message('first', 'streaming', 10), 10);
    projectReply(activity, message('first', 'complete', 10), 20);
    expect(activity.replies).toEqual({ alpha: { id: 'first', status: 'complete', createdAt: 10, at: 20 } });
    projectReply(activity, message('second', 'streaming', 30), 30);
    // A late edit to an older reply never replaces the newer turn.
    projectReply(activity, message('first', 'error', 10), 40);
    expect(activity.replies!.alpha).toMatchObject({ id: 'second', status: 'streaming' });
    projectReply(activity, message('other', 'streaming', 31, { authorId: 'beta' }), 31);
    expect(Object.keys(activity.replies!).sort()).toEqual(['alpha', 'beta']);
  });

  it('ignores people, forwarded copies and removes a deleted newest reply', () => {
    const activity: { replies?: Record<string, BotReply> } = {};
    projectReply(activity, message('user', 'complete', 1, { authorType: 'user' }), 1);
    projectReply(activity, message('copy', 'complete', 2, { forwardedFrom: { conversationId: 'x', messageId: 'y' } } as Partial<Message>), 2);
    expect(activity.replies).toBeUndefined();
    projectReply(activity, message('reply', 'complete', 3), 3);
    projectReply(activity, message('reply', 'deleted', 3), 4);
    expect(activity.replies).toEqual({});
  });
});

describe('agentSignal', () => {
  const activity = (replies: BotReply[], unread: string[] = [], attention = false) => ({
    unread: Object.fromEntries(unread.map((id, i) => [id, i + 1])),
    attention: attention ? { ask: { kind: 'question' as const, at: 50 } } : {},
    replies: Object.fromEntries(replies.map((r, i) => [`bot${i}`, r])),
  });

  it('is idle without activity, for read replies and for queued replies', () => {
    expect(agentSignal([])).toBe(IDLE_AGENT);
    expect(agentSignal([undefined, activity([reply('a', 'complete', 5)])])).toBe(IDLE_AGENT);
    expect(agentSignal([activity([reply('a', 'pending', 5)])])).toBe(IDLE_AGENT);
  });

  it('ranks a pending request over work, and work over finished replies', () => {
    expect(agentSignal([activity([reply('a', 'streaming', 5)], [], true)])).toEqual({ state: 'ask', at: 50 });
    expect(agentSignal([activity([reply('a', 'streaming', 5), reply('b', 'complete', 9)], ['b'])])).toEqual({ state: 'working', at: 5 });
    expect(agentSignal([activity([reply('a', 'complete', 9)], ['a'])])).toEqual({ state: 'done', at: 9 });
    expect(agentSignal([activity([reply('a', 'error', 9)], ['a'])])).toEqual({ state: 'failed', at: 9 });
  });

  it('uses the newest unread finished reply across a group and its topics', () => {
    const group = activity([reply('old-failure', 'error', 3)], ['old-failure']);
    const topic = activity([reply('new-success', 'complete', 8)], ['new-success']);
    expect(agentSignal([group, topic])).toEqual({ state: 'done', at: 8 });
    expect(agentSignal([group, activity([reply('newer-failure', 'error', 12)], ['newer-failure']), topic])).toEqual({ state: 'failed', at: 12 });
  });
});
