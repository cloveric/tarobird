import { test, expect } from '@playwright/test';
import { createServer } from './fixtures/vite.js';
import type { ClientCache } from '../src/storage.js';
import type { HubEvent, Message } from '../../src/client-protocol/index.js';

test('activity uses event time for old streaming replies and ignores reads and user enrichment', async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: '127.0.0.1' } });
  await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'e2e/fixtures/stream.html');
    await page.waitForFunction(() => 'streamCache' in window);
    const result = await page.evaluate(async () => {
      const cache = (window as unknown as { streamCache: ClientCache }).streamCache;
      const message: Message = { id: 'reply', conversationId: 'chat', authorId: 'gg1', authorType: 'bot', blocks: [{ type: 'text', text: 'start' }], status: 'streaming', version: 1, createdAt: 10 };
      let seq = 0;
      const apply = (kind: HubEvent['kind'], payload: HubEvent['payload'], at: number) => cache.apply({ v: 1, type: 'event', conversationId: 'chat', seq: ++seq, kind, payload, at }, 'owner');
      const at = async () => (await cache.activity()).chat!.at;
      await apply('message.created', message, 10);
      await apply('message.created', { ...message, id: 'user', authorId: 'owner', authorType: 'user', status: 'complete', createdAt: 20 }, 20);
      await apply('message.updated', { ...message, version: 2 }, 30);
      const updated = await at();
      await apply('message.stream', { messageId: 'reply', baseVersion: 2, version: 3, ops: [{ op: 'appendText', block: 0, text: ' continued' }] }, 40);
      const streamed = await at();
      await apply('message.updated', { ...message, id: 'user', authorId: 'owner', authorType: 'user', status: 'complete', createdAt: 20, version: 2 }, 50);
      await apply('read', { userId: 'owner', seq }, 60);
      await apply('turn.state', { phase: 'thinking' }, 70);
      await apply('message.updated', { ...message, version: 3 }, 80);
      const unchanged = await at();
      await apply('message.updated', { ...message, version: 4, status: 'complete' }, 90);
      const completed = await at();
      return { updated, streamed, unchanged, completed };
    });
    expect(result).toEqual({ updated: 30, streamed: 40, unchanged: 40, completed: 90 });
  } finally { await server.close(); }
});


test('card summaries stay in sidebar projections through updates, deletions and snapshots', async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: '127.0.0.1' } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'e2e/fixtures/stream.html');
    await page.waitForFunction(() => 'streamCache' in window);
    const result = await page.evaluate(async () => {
      const cache = (window as unknown as { streamCache: ClientCache }).streamCache;
      const conversation = { id: 'cards', type: 'direct' as const, title: 'Cards', ownerId: 'owner', botIds: ['alpha'], archived: false, createdAt: 1 };
      const message: Message = { id: 'card', conversationId: conversation.id, authorId: 'alpha', authorType: 'bot', blocks: [{ type: 'card', title: 'Full title', summary: 'Brief', elements: [{ type: 'markdown', text: 'Full details remain searchable' }] }], status: 'complete', version: 1, createdAt: 1 };
      let seq = 0;
      const apply = (kind: HubEvent['kind'], payload: HubEvent['payload']) => cache.apply({ v: 1, type: 'event', conversationId: conversation.id, seq: ++seq, kind, payload, at: seq }, 'owner');
      const preview = async () => (await cache.activity())[conversation.id]!.preview;
      await apply('message.created', message); const created = await preview();
      const updated: Message = { ...message, version: 2, blocks: [{ type: 'card', title: 'Full title', summary: 'New summary', elements: [{ type: 'markdown', text: 'Full details remain searchable' }] }] };
      await apply('message.updated', updated); const edited = await preview();
      await apply('message.created', { ...message, id: 'newer', createdAt: 3, blocks: [{ type: 'text', text: 'newer' }] });
      await apply('message.updated', { ...message, id: 'newer', createdAt: 3, version: 2, status: 'deleted', blocks: [] }); const deleted = await preview();
      await cache.acceptSnapshot({ v: 1, type: 'snapshot.begin', id: 'cards-snapshot', conversation, seq: 10, after: seq, readSeq: 0 });
      await cache.acceptSnapshot({ v: 1, type: 'snapshot.message', id: 'cards-snapshot', index: 0, message, contentSeq: 10, contentAt: 10, unreadSeq: 10 });
      await cache.acceptSnapshot({ v: 1, type: 'snapshot.end', id: 'cards-snapshot', count: 1 });
      return { created, edited, deleted, snapshot: await preview(), blocks: (await cache.messages(conversation.id))[0]!.blocks };
    });
    expect(result).toEqual({ created: 'Brief', edited: 'New summary', deleted: 'New summary', snapshot: 'Brief', blocks: [{ type: 'card', title: 'Full title', summary: 'Brief', elements: [{ type: 'markdown', text: 'Full details remain searchable' }] }] });
  } finally { await server.close(); }
});

test('editing the latest queued user message refreshes only its own sidebar preview', async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: '127.0.0.1' } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + 'e2e/fixtures/stream.html');
    await page.waitForFunction(() => 'streamCache' in window);
    const result = await page.evaluate(async () => {
      const cache = (window as unknown as { streamCache: ClientCache }).streamCache;
      const message: Message = { id: 'queued', conversationId: 'edited', authorId: 'owner', authorType: 'user', blocks: [{ type: 'text', text: 'old prompt' }], status: 'complete', version: 1, createdAt: 10 };
      let seq = 0;
      const apply = (kind: HubEvent['kind'], payload: HubEvent['payload'], at: number) => cache.apply({ v: 1, type: 'event', conversationId: 'edited', seq: ++seq, kind, payload, at }, 'owner');
      const activity = async () => (await cache.activity()).edited!;
      await apply('message.created', message, 10);
      await apply('message.updated', { ...message, version: 2, blocks: [{ type: 'text', text: 'new prompt' }] }, 20);
      const edited = await activity();
      await apply('message.created', { ...message, id: 'reply', authorId: 'bot', authorType: 'bot', createdAt: 30, blocks: [{ type: 'text', text: 'newer reply' }] }, 30);
      await apply('message.updated', { ...message, version: 3, blocks: [{ type: 'text', text: 'another edit' }] }, 40);
      const olderEdit = await activity();
      return { edited: { preview: edited.preview, at: edited.at, seq: edited.lastContentSeq }, olderEdit: { preview: olderEdit.preview, at: olderEdit.at, seq: olderEdit.lastContentSeq } };
    });
    expect(result).toEqual({ edited: { preview: 'new prompt', at: 10, seq: 1 }, olderEdit: { preview: 'newer reply', at: 30, seq: 3 } });
  } finally { await server.close(); }
});
