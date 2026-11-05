import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { createServer } from './fixtures/vite.js';
import { mobileHome, showDisconnectedBots, selectConversation, openMobileHome } from './fixtures/mobile.js';

test.use({ trace: 'off', viewport: { width: 390, height: 844 }, hasTouch: true });

test('hidden phone inbox does no list-render work while typing and refreshes when reopened', async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phone-inbox-work-'));
  const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, plugins: [{
    name: 'count-inbox-renders', enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/src/MobileHome.tsx')) return;
      return code.replace('function MobileHome(props: MobileHomeProps) {',
        'function MobileHome(props: MobileHomeProps) { window.__inboxRenders = (window.__inboxRenders ?? 0) + 1;');
    },
  }] });
  await server.listen();
  const url = server.resolvedUrls!.local[0]!;
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','产品助手','fixture')");
    const chat = await hub.store.createConversation('owner', ['bot'], '正在编辑', 'active');
    const other = await hub.store.createConversation('owner', ['bot'], '后台更新', 'other');
    for (let i = 0; i < 200; i++) await hub.store.createConversation('owner', ['bot'], `历史项目 ${i}`, `old-${i}`);
    await page.goto(url);
    await page.getByRole('textbox', { name: 'Hub 地址', exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
    await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
    await showDisconnectedBots(page); await selectConversation(page, chat.title);
    await expect(mobileHome(page)).toBeHidden();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const initial = await page.evaluate(() => (window as any).__inboxRenders);
    const field = page.getByRole('textbox', { name: '消息', exact: true });
    const started = Date.now();
    await field.pressSequentially('Draft stays responsive with 202 conversations', { delay: 15 });
    const inputMs = Date.now() - started;
    await expect(field).toHaveValue('Draft stays responsive with 202 conversations');
    const typingRenders = await page.evaluate(() => (window as any).__inboxRenders) - initial;
    await hub.store.publishBotMessage('bot', { conversationId: other.id, blocks: [{ type: 'text', text: '后台会话新内容' }], status: 'complete' });
    await openMobileHome(page);
    await expect(mobileHome(page).getByText('后台会话新内容', { exact: true })).toBeVisible();
    await selectConversation(page, chat.title);
    await expect(field).toHaveValue('Draft stays responsive with 202 conversations');
    await info.attach('inbox-typing-work', { body: JSON.stringify({ conversations: 202, typingRenders, inputMs, scope: 'WebKit/Chromium desktop engine at phone width; synthetic Hub data; not physical iPhone latency' }, null, 2), contentType: 'application/json' });
    console.log('Inbox typing work', JSON.stringify({ typingRenders, inputMs }));
    expect(typingRenders).toBe(0);
  } finally { await page.close(); await server.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
