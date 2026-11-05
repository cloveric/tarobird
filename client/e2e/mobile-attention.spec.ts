import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots } from "./fixtures/mobile.js";
import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from './fixtures/vite.js';
import { HubServer } from '../../src/hub/server.js';
import type { Block, Message } from '../../src/client-protocol/index.js';
import type { ClientCache } from '../src/storage.js';

test.use({ serviceWorkers: 'block' });
const home = (page: Page) => page.locator('.host-workspace:not([hidden]) .mobile-home');
const back = (page: Page) => page.evaluate(() => !window.dispatchEvent(new Event('tarocub-native-back', { cancelable: true })));
function question(title: string, disabled = false): Block[] {
  return [{ type: 'card', title, elements: [{ type: 'form', disabled, extra: { tarocub_questions: { version: 1, requestId: title, questions: [{ header: '决定', question: title, multiSelect: false, required: true, allowFreeText: true, options: [{ label: '继续' }] }] } }, children: [{ type: 'button', name: 'askq_submit', actionId: 'askq_submit', text: '提交', extra: { form_action_type: 'submit' }, value: { cctb_lark: 'ask_user_question', action: 'form_submit', requestId: title } }] }] }];
}
function approval(title: string): Block[] {
  return [{ type: 'card', title, elements: [{ type: 'columns', children: [{ type: 'column', children: [{ type: 'button', actionId: 'approve', text: '允许此次', value: { cctb_lark: 'approval', requestId: title, decision: 'allow_once' } }] }] }] }];
}

test('attention projects every live request and retires it with cache updates, snapshots and legacy backfill', async ({ page }) => {
  const vite = await createServer({ server: { port: 0, strictPort: false, host: '127.0.0.1', hmr: false } }); await vite.listen();
  try {
    await page.goto(vite.resolvedUrls!.local[0]!);
    const result = await page.evaluate(async ({ questions, approvals, resolved }) => {
      const storagePath = '/src/storage.ts', attentionPath = '/src/attention.ts';
      const { ClientCache } = await import(storagePath) as { ClientCache: new (name: string) => ClientCache };
      const { messageAttention } = await import(attentionPath) as typeof import('../src/attention.js');
      const cache = new ClientCache(`attention-${crypto.randomUUID()}`);
      const conversation = { id: 'chat', type: 'direct' as const, title: 'Conversation', ownerId: 'owner', botIds: ['alpha'], archived: false, createdAt: 1 };
      const message = (id: string, blocks: Block[], overrides: Partial<Message> = {}): Message => ({ id, conversationId: 'chat', authorId: 'alpha', authorType: 'bot', status: 'complete', version: 1, createdAt: 1, blocks, ...overrides });
      let seq = 0;
      const apply = (m: Message) => cache.apply({ v: 1, type: 'event', conversationId: 'chat', seq: ++seq, kind: 'message.updated', payload: m, at: seq });
      const requests = async () => (await cache.activity()).chat!.attention;
      try {
        await cache.saveConversations([conversation]);
        const q = message('question', questions), a = message('approval', approvals, { createdAt: 2 });
        await apply(q); await apply(a);
        await apply(message('ordinary_pending', [{ type: 'run', phase: 'working', elapsedMs: 0, tools: [], todos: [] }], { status: 'pending' }));
        await apply(message('later_reply', [{ type: 'text', text: 'Later ordinary message' }], { createdAt: 9 }));
        const afterLater = await requests();
        await cache.enqueue({ v: 1, type: 'interaction.submit', conversationId: 'chat', messageId: q.id, actionId: 'askq_submit', values: { q0: '继续' }, clientActionId: 'queued_answer' });
        const afterQueued = await requests();
        // An older full update cannot resurrect or remove current requests.
        await apply({ ...q, blocks: resolved, version: 2 });
        await apply(q);
        const afterResolved = await requests();
        await apply({ ...a, status: 'deleted', version: 2 });
        const afterDeleted = await requests();
        const streaming = message('streaming_question', questions, { status: 'streaming' });
        await apply(streaming);
        await cache.apply({ v: 1, type: 'event', conversationId: 'chat', seq: ++seq, kind: 'message.stream', at: seq, payload: { messageId: streaming.id, baseVersion: 1, version: 2, ops: [{ op: 'replaceBlock', block: 0, value: resolved[0]! }] } });
        const afterStream = await requests();
        await apply(message('before_snapshot', questions));
        await cache.acceptSnapshot({ v: 1, type: 'snapshot.begin', id: 'snapshot', conversation, seq: seq + 10, after: seq, readSeq: 0 });
        await cache.acceptSnapshot({ v: 1, type: 'snapshot.message', id: 'snapshot', index: 0, message: message('snapshot_question', questions), contentSeq: seq + 1, unreadSeq: 0 });
        const duringSnapshot = await requests();
        await cache.acceptSnapshot({ v: 1, type: 'snapshot.end', id: 'snapshot', count: 1 });
        const afterSnapshot = await requests();
        // Simulate the old activity schema without changing cached messages.
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(cache.databaseName); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        await new Promise<void>((resolve, reject) => { const tx = db.transaction('activity', 'readwrite'); tx.objectStore('activity').put({ preview: 'old summary', at: 1, unread: {}, lastContentSeq: 1 }, 'chat'); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
        db.close();
        const backfilled = await requests();
        // Once projected, even opening an index cursor would expose a rescan.
        const cursor = IDBIndex.prototype.openCursor;
        IDBIndex.prototype.openCursor = function () { throw new Error('unexpected_history_scan'); };
        let reread;
        try { reread = await requests(); } finally { IDBIndex.prototype.openCursor = cursor; }
        const excluded = [
          message('answered', resolved), message('deleted', questions, { status: 'deleted' }), message('error', questions, { status: 'error' }),
          message('forwarded', questions, { forwardedFrom: { messageId: 'original', conversationId: 'original', conversationTitle: 'Original', authorName: 'Bot', createdAt: 1 } }),
          message('user', questions, { authorType: 'user' }),
          message('config', [{ type: 'card', elements: [{ type: 'button', actionId: 'save', value: { cctb_lark: 'config', requestId: 'config' } }] }]),
          message('disabled_parent', [{ type: 'card', elements: [{ type: 'column', disabled: true, children: approvals[0]!.type === 'card' ? approvals[0]!.elements : [] }] }]),
        ].map(m => messageAttention(m) ?? null);
        return { afterLater, afterQueued, afterResolved, afterDeleted, afterStream, duringSnapshot, afterSnapshot, backfilled, reread, excluded };
      } finally { cache.close(); }
    }, { questions: question('live question'), approvals: approval('live approval'), resolved: question('live question', true) });
    expect(Object.keys(result.afterLater!)).toEqual(['question', 'approval']);
    expect(result.afterQueued).toEqual(result.afterLater);
    expect(Object.keys(result.afterResolved!)).toEqual(['approval']);
    for (const value of [result.afterDeleted, result.afterStream]) expect(value).toEqual({});
    expect(Object.keys(result.duringSnapshot!)).toEqual(['before_snapshot']);
    expect(Object.keys(result.afterSnapshot!)).toEqual(['snapshot_question']);
    expect(result.backfilled).toEqual(result.afterSnapshot); expect(result.reread).toEqual(result.afterSnapshot);
    expect(result.excluded).toEqual(Array(7).fill(null));
  } finally { await page.close(); await vite.close(); }
});

test('phone attention keeps hosts separate, includes live topics and opens the exact older request', async ({ page }, info) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'mobile-attention-'));
  const vite = await createServer({ server: { port: 0, strictPort: false, host: '127.0.0.1', hmr: false } }); await vite.listen();
  const origin = vite.resolvedUrls!.local[0]!;
  const a = await HubServer.start({ stateDir: path.join(root, 'a'), origins: [new URL(origin).origin] });
  const b = await HubServer.start({ stateDir: path.join(root, 'b'), origins: [new URL(origin).origin] });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  async function pair(hub: HubServer, name: string) {
    await hub.profile.update({ name, revision: (await hub.profile.read()).revision });
    await page.getByLabel('主机名称', { exact: true }).fill(name); await page.getByLabel('Hub 地址', { exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page); await expect(home(page)).toBeVisible();
  }
  try {
    for (const hub of [a, b]) {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
      await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES('same','direct','同名对话','owner',1,'same')");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same','user','owner',0)");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same','bot','alpha',0)");
      await hub.store.publishBotMessage('alpha', { id: 'same_question', conversationId: 'same', blocks: question(hub === a ? 'A 的旧问题' : 'B 的旧问题'), status: 'complete' });
    }
    for (let i = 0; i < 25; i++) await a.store.publishBotMessage('alpha', { conversationId: 'same', blocks: [{ type: 'text', text: `较新的普通回复 ${i}，用于确认入口可以定位到更早的原生提问。` }], status: 'complete' });
    const group = await a.store.createConversation('owner', ['alpha'], '项目群', 'group', { type: 'group' });
    const topic = await a.store.createConversation('owner', [], '审批话题', 'topic', { parentId: group.id });
    const next = await a.store.createConversation('owner', [], '回答话题', 'next', { parentId: group.id });
    const approvalMessage = await a.store.publishBotMessage('alpha', { conversationId: topic.id, blocks: approval('话题中的审批'), status: 'complete' });
    const nextQuestion = await a.store.publishBotMessage('alpha', { conversationId: next.id, blocks: question('话题中的提问'), status: 'complete' });
    const archived = await a.store.createConversation('owner', ['alpha'], '归档群', 'archive', { type: 'group' });
    const archivedTopic = await a.store.createConversation('owner', [], '归档群里的提问', 'archived-topic', { parentId: archived.id });
    await a.store.publishBotMessage('alpha', { conversationId: archivedTopic.id, blocks: question('不能显示的提问'), status: 'complete' });
    await a.store.updateConversation('owner', archived.id, { archived: true });
    const working = await a.store.createConversation('owner', ['alpha'], '只是工作中', 'working');
    await a.store.publishBotMessage('alpha', { conversationId: working.id, blocks: [{ type: 'run', phase: 'working', elapsedMs: 0, tools: [], todos: [] }], status: 'pending' });
    await page.setViewportSize({ width: 320, height: 740 }); await page.goto(origin); await pair(a, '主机 A');
    await home(page).getByRole('button', { name: '待处理', exact: true }).click();
    await expect(home(page).locator('.mh-row')).toHaveCount(2);
    const groupRow = home(page).locator(`[data-conversation-id="${group.id}"]`);
    await expect(groupRow).toHaveAttribute('data-attention', '2'); await expect(groupRow).toContainText('审批话题：审批请求');
    await groupRow.click(); await expect(page.getByRole('heading', { name: topic.title, exact: true })).toBeVisible();
    await expect(page.locator(`[data-message-id="${approvalMessage.id}"].focused-message`)).toBeInViewport();
    expect(await back(page)).toBe(true); await expect(home(page).getByRole('button', { name: '待处理', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await a.store.publishBotMessage('alpha', { id: approvalMessage.id, conversationId: topic.id, blocks: [{ type: 'text', text: '已允许此次调用' }], status: 'complete' });
    await expect(groupRow).toHaveAttribute('data-attention', '1'); await expect(groupRow).toContainText('回答话题：回答请求');
    // Direct fixture metadata writes do not broadcast; reconnect reads the
    // actual ready directory, just as another device's next sync would.
    await a.store.updateConversation('owner', next.id, { archived: true }); await page.reload();
    await home(page).getByRole('button', { name: '待处理', exact: true }).click(); await expect(groupRow).toHaveCount(0);
    await a.store.updateConversation('owner', next.id, { archived: false }); await page.reload();
    await home(page).getByRole('button', { name: '待处理', exact: true }).click(); await expect(groupRow).toHaveAttribute('data-attention', '1');
    await a.store.publishBotMessage('alpha', { id: nextQuestion.id, conversationId: next.id, blocks: question('话题中的提问', true), status: 'complete' }); await expect(groupRow).toHaveCount(0);
    await home(page).getByRole('button', { name: '我的', exact: true }).click(); await home(page).getByRole('button', { name: '设备与网络', exact: true }).click();
    await page.getByRole('dialog', { name: '设备与网络', exact: true }).getByRole('button', { name: /^此设备连接另一台主机/ }).click(); await pair(b, '主机 B');
    await home(page).getByRole('button', { name: '待处理', exact: true }).click(); await expect(home(page).locator('.mh-row')).toHaveCount(2);
    await page.screenshot({ path: info.outputPath('attention-two-hosts-phone.png') });
    await page.evaluate(async () => { const source = '/src/i18n.ts'; const i18n = await import(source); i18n.setLocale('en'); });
    await expect(home(page).locator('.mh-attention-help')).not.toContainText('待回答');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const filterBounds = await home(page).locator('.mh-chip').evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return { right: rect.right, left: rect.left, width: rect.width, height: rect.height }; }));
    expect(filterBounds.every(rect => rect.left >= 0 && rect.right <= 320 && rect.width >= 44 && rect.height >= 44)).toBe(true);
    await page.screenshot({ path: info.outputPath('attention-two-hosts-phone-en.png') });
    await page.evaluate(async () => { const source = '/src/i18n.ts'; const i18n = await import(source); i18n.setLocale('zh'); });
    const rowA = home(page).locator('.mh-row').filter({ hasText: '主机 A' }), rowB = home(page).locator('.mh-row').filter({ hasText: '主机 B' });
    await rowA.click(); await expect(page.locator('.host-workspace:not([hidden]) [data-message-id="same_question"].focused-message')).toBeInViewport();
    await expect(page.locator('.host-workspace:not([hidden])').getByRole('radio', { name: '继续', exact: true })).toBeVisible();
    await expect(page.locator('.host-workspace:not([hidden]) .rich-card').getByText('A 的旧问题', { exact: true }).first()).toBeVisible();
    expect(await back(page)).toBe(true);
    await a.store.publishBotMessage('alpha', { id: 'same_question', conversationId: 'same', blocks: question('A 的旧问题', true), status: 'complete' });
    await expect(rowA).toHaveCount(0); await expect(rowB).toHaveCount(1);
    await rowB.click(); await expect(page.locator('.host-workspace:not([hidden]) [data-message-id="same_question"].focused-message')).toBeInViewport();
    await expect(page.locator('.host-workspace:not([hidden]) .rich-card').getByText('B 的旧问题', { exact: true }).first()).toBeVisible();
    expect(await back(page)).toBe(true);
    await b.store.publishBotMessage('alpha', { id: 'same_question', conversationId: 'same', blocks: question('B 的旧问题', true), status: 'complete' });
    await expect(home(page).getByText('暂无待处理请求', { exact: true })).toBeVisible();
    await home(page).getByRole('button', { name: '未读', exact: true }).click(); await expect(home(page).locator('.mh-row').first()).toBeVisible();
    await home(page).getByRole('button', { name: '待处理', exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('attention-cleared-phone.png') });
    expect(errors).toEqual([]);
  } finally { await page.close(); await a.close(); await b.close(); await vite.close(); await rm(root, { recursive: true, force: true }); }
});
