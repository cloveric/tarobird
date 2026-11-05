import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { MAX_TEXT_BYTES } from '../../src/client-protocol/index.js';
import { showDisconnectedBots, waitForClientOnline, selectConversation } from './fixtures/mobile.js';
import { messageAction, holdMessage } from './fixtures/message-actions.js';

test.use({ serviceWorkers: 'block' });
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url);
  await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
  await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
  await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
  await waitForClientOnline(page);
}

for (const phone of [false, true]) {
  test(`retrying one failed group Bot does not repeat another Bot's work (${phone ? 'phone' : 'desktop'})`, async ({ page }) => {
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    const root = await mkdtemp(path.join(os.tmpdir(), 'group-retry-audit-'));
    const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
    try {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手甲','fixture'),('beta','助手乙','fixture'),('gamma','助手丙','fixture')");
      const group = await hub.store.createConversation('owner', ['alpha', 'beta', 'gamma'], '重试审计', 'group', { type: 'group' });
      const { message: source } = await hub.store.sendMessage('owner', { conversationId: group.id, clientMsgId: 'initial', text: '各自处理自己的任务', attachments: [], mentions: ['alpha', 'beta'] });
      await hub.store.publishBotMessage('beta', { conversationId: group.id, replyTo: source.id, blocks: [{ type: 'text', text: '乙已完成，不应重复执行' }] });
      await hub.store.acknowledgeDelivery('beta', source.id);
      await hub.store.failDelivery('alpha', source.id, 'failed');
      const failed = (await hub.store.snapshot('owner', group.id)).messages.find(m => m.authorId === 'alpha' && m.status === 'error')!;
      const users = async () => (await hub.store.snapshot('owner', group.id)).messages.filter(m => m.authorType === 'user');
      await pair(page, hub); await selectConversation(page, group.title);
      await messageAction(page, page.locator(`[data-message-id="${failed.id}"]`), '重新发送消息');
      await expect.poll(async () => (await users()).length).toBe(2);
      expect((await users()).at(-1)?.mentions).toEqual(['alpha']);
      expect(await hub.store.pendingForBot('beta')).toHaveLength(0);
      expect((await hub.store.pendingForBot('alpha')).map(m => m.id)).toEqual([(await users()).at(-1)!.id]);

      // Retrying one's own message remains an explicit resend to its recipients.
      await messageAction(page, page.locator(`[data-message-id="${source.id}"]`), '重新发送消息');
      await expect.poll(async () => (await users()).length).toBe(3);
      expect((await users()).at(-1)?.mentions).toEqual(['alpha', 'beta']);

      for (const message of await hub.store.pendingForBot('beta')) await hub.store.acknowledgeDelivery('beta', message.id);
      await hub.store.updateGroup('owner', group.id, { title: group.title, expectedTitle: group.title, botIds: ['alpha', 'gamma'], expectedBotIds: ['alpha', 'beta', 'gamma'] });
      await page.reload(); await waitForClientOnline(page); await selectConversation(page, group.title);
      await messageAction(page, page.locator(`[data-message-id="${failed.id}"]`), '重新发送消息');
      await expect.poll(async () => (await users()).length).toBe(4);
      expect((await users()).at(-1)?.mentions).toEqual(['alpha']);

      for (const message of await hub.store.pendingForBot('alpha')) await hub.store.acknowledgeDelivery('alpha', message.id);
      await hub.store.updateGroup('owner', group.id, { title: group.title, expectedTitle: group.title, botIds: ['gamma'], expectedBotIds: ['alpha', 'gamma'] });
      await page.reload(); await waitForClientOnline(page); await selectConversation(page, group.title);
      const row = page.locator(`[data-message-id="${failed.id}"]`);
      if (phone) await holdMessage(page, row);
      await expect((phone ? page.getByRole('dialog', { name: '消息操作', exact: true }) : row).getByRole('button', { name: '重新发送消息', exact: true })).toHaveCount(0);
    } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
  });

  test(`retrying a forwarded group message preserves forwarding and narrows recipients (${phone ? 'phone' : 'desktop'})`, async ({ page }) => {
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    const root = await mkdtemp(path.join(os.tmpdir(), 'forward-retry-audit-'));
    const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
    try {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手甲','fixture'),('beta','助手乙','fixture')");
      const group = await hub.store.createConversation('owner', ['alpha', 'beta'], '转发重试审计', 'group', { type: 'group' });
      const original = await hub.store.publishBotMessage('beta', { conversationId: group.id, blocks: [{ type: 'text', text: '待处理的转发内容' }] });
      const { message: source } = await hub.store.forwardMessage('owner', { v: 1, type: 'message.forward', conversationId: group.id, clientMsgId: 'forward_initial', sourceMessageId: original.id, mentions: ['alpha', 'beta'] }, async () => {});
      await hub.store.acknowledgeDelivery('beta', source.id);
      await hub.store.failDelivery('alpha', source.id, 'failed');
      const failed = (await hub.store.snapshot('owner', group.id)).messages.find(m => m.authorId === 'alpha' && m.status === 'error')!;
      await pair(page, hub); await selectConversation(page, group.title);
      await messageAction(page, page.locator(`[data-message-id="${failed.id}"]`), '重新发送消息');
      await expect.poll(async () => (await hub.store.snapshot('owner', group.id)).messages.filter(m => m.authorType === 'user').length).toBe(2);
      const retried = (await hub.store.snapshot('owner', group.id)).messages.filter(m => m.authorType === 'user').at(-1)!;
      expect(retried.mentions).toEqual(['alpha']);
      expect(retried.forwardedFrom?.messageId).toBe(source.id);
      expect(retried.blocks).toEqual(source.blocks);
      expect(await hub.store.pendingForBot('beta')).toHaveLength(0);
      await expect(page.getByRole('dialog', { name: '转发消息', exact: true })).toHaveCount(0);
    } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
  });

  test(`oversized UTF-8 text keeps the draft and does not upload attachments (${phone ? 'phone' : 'desktop'})`, async ({ page }) => {
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    const root = await mkdtemp(path.join(os.tmpdir(), 'message-size-audit-'));
    const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
    try {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
      const conversation = await hub.store.createConversation('owner', ['alpha'], '大消息审计', 'chat');
      await pair(page, hub); await showDisconnectedBots(page); await selectConversation(page, conversation.title);
      let uploads = 0;
      page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/uploads') uploads++; });
      const draft = '界'.repeat(Math.floor(MAX_TEXT_BYTES / 3) + 1);
      const composer = page.getByRole('textbox', { name: '消息', exact: true });
      await composer.fill(draft);
      await page.locator('input.attachment-picker-input').setInputFiles({ name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('keep this draft') });
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect(page.getByText('消息过大，请作为文件发送', { exact: true })).toBeVisible();
      expect(uploads).toBe(0);
      await expect(composer).toHaveValue(draft);
      await expect(page.locator('.attachment-draft')).toContainText('keep.txt');
      expect((await hub.store.snapshot('owner', conversation.id)).messages).toHaveLength(0);
    } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
  });
}
