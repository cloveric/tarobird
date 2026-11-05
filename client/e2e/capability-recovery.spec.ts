import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from './fixtures/vite.js';
import { HubServer } from '../../src/hub/server.js';
import { openWorkspacePage, waitForClientOnline } from './fixtures/mobile.js';

test.use({ serviceWorkers: 'block' });
for (const phone of [false, true]) test(`capability dialog retains edits, retry identity and selected inventory through temporary Bot loss (${phone ? 'phone' : 'desktop'})`, async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'capability-recovery-'));
  const vite = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false } }); await vite.listen();
  const origin = vite.resolvedUrls!.local[0]!;
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(origin).origin] });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    for (const [id, name] of [['alpha', '当前助手'], ['beta', '配置助手']]) await hub.store.db.run('INSERT INTO bots(id,name,engine,secret_hash) VALUES(?,?,?,?)', [id!, name!, 'claude', 'fixture']);
    const original = await hub.store.createConversation('owner', ['alpha'], '原有对话', 'original');
    await page.setViewportSize({ width: phone ? 390 : 1360, height: phone ? 844 : 900 });
    await page.goto(origin);
    // Capture the actual Workspace connection before pairing creates it.
    // Fault injection is source-only; no diagnostic handle ships in production.
    await page.evaluate(async () => {
      const source = '/src/connection.ts'; const { HubConnection } = await import(source);
      const original = HubConnection.prototype.subscribe;
      HubConnection.prototype.subscribe = function(callback: () => void) { (window as any).recoveryConnection = this; return original.call(this, callback); };
      (window as any).restoreSubscribe = () => { HubConnection.prototype.subscribe = original; };
    });
    await page.getByLabel('Hub 地址', { exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
    await page.setViewportSize({ width: phone ? 391 : 1361, height: phone ? 844 : 900 });
    await openWorkspacePage(page, 'Skills 与 MCP');
    await expect.poll(() => page.evaluate(() => !!(window as any).recoveryConnection)).toBe(true);
    await page.evaluate(() => (window as any).restoreSubscribe());
    await page.route('**/api/bots/beta/capabilities', route => route.fulfill({ json: {
      generatedAt: new Date().toISOString(), engine: 'claude', workspace: '/fixture', runtime: 'unverified', coverage: 'partial', sources: [], warnings: ['runtime_unverified', 'partial_catalog'],
      entries: [{ id: 'knowledge', name: '目标知识库', description: '核对研究资料', kind: 'mcp', source: 'workspace/.mcp.json', scope: 'workspace', status: 'configured', transport: 'stdio' }],
    } }));
    await page.getByLabel('选择 Bot', { exact: true }).selectOption('beta');
    await page.getByRole('button', { name: /^MCP/ }).click();
    await page.getByLabel('搜索能力', { exact: true }).fill('目标');
    await page.getByLabel('能力来源', { exact: true }).selectOption('workspace');
    const card = page.locator('.capability-card').filter({ hasText: '目标知识库' });
    await card.locator('.capability-summary').click(); await card.getByRole('button', { name: '让 Bot 检查', exact: true }).click();
    await page.getByRole('button', { name: '关闭配置消息', exact: true }).click();
    await expect(page.getByLabel('选择 Bot', { exact: true })).toHaveValue('beta');
    await expect(page.getByLabel('搜索能力', { exact: true })).toHaveValue('目标');
    await expect(page.getByLabel('能力来源', { exact: true })).toHaveValue('workspace');
    await expect(card.locator('.capability-summary')).toHaveAttribute('aria-expanded', 'true');
    await card.getByRole('button', { name: '让 Bot 检查', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '准备配置消息', exact: true });
    const text = page.getByRole('textbox', { name: '配置消息', exact: true });
    await text.fill('为配置助手检查知识库，保留这条编辑。');
    const ids: string[] = [];
    await page.route('**/api/conversations', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      ids.push(route.request().postDataJSON().clientActionId);
      const response = await route.fetch(); await route.fulfill(ids.length === 1 ? { status: 503, json: { error: 'lost_receipt' } } : { response });
    });
    await dialog.getByRole('button', { name: '打开配置对话', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('重试会查询同一次创建');
    await page.evaluate(() => { const c = (window as any).recoveryConnection; (window as any).savedBots = c.state.bots; c.update({ bots: c.state.bots.filter((bot: any) => bot.id !== 'beta') }); });
    await expect(dialog).toBeVisible(); await expect(text).toHaveValue('为配置助手检查知识库，保留这条编辑。');
    await expect(dialog.getByRole('button', { name: '打开配置对话', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('status')).toContainText('Bot 可访问');
    await page.evaluate(() => (window as any).recoveryConnection.update({ bots: (window as any).savedBots }));
    await dialog.getByRole('button', { name: '打开配置对话', exact: true }).click();
    await expect(dialog).toHaveCount(0); expect(ids).toHaveLength(2); expect(new Set(ids).size).toBe(1);
    const all = await hub.store.db.all<{ id: string }>('SELECT id FROM conversations'); expect(all).toHaveLength(2);
    const created = all.find(row => row.id !== original.id)!;
    expect((await hub.store.snapshot('owner', created.id)).conversation.botIds).toEqual(['beta']);
    expect((await hub.store.snapshot('owner', created.id)).messages).toHaveLength(0);
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('为配置助手检查知识库，保留这条编辑。');
    expect(errors).toEqual([]);
  } finally { await page.close(); await hub.close(); await vite.close(); await rm(root, { recursive: true, force: true }); }
});
