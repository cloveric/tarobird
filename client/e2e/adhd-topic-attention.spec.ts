import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import type { Block } from '../../src/client-protocol/index.js';
import { preparePairing } from './fixtures/pairing-invite.js';
import { showDisconnectedBots, waitForClientOnline } from './fixtures/mobile.js';

test.use({ serviceWorkers: 'block' });

test('collapsed ADHD groups surface live topic attention and retire it without opening the group', async ({ page, browserName }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-topic-attention-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const group = await hub.store.createConversation('owner', ['alpha'], '待处理群组', 'group', { type: 'group' });
    const topic = await hub.store.createConversation('owner', ['alpha'], '等待回答的话题', 'topic', { parentId: group.id });
    await hub.store.createConversation('owner', ['alpha'], '普通话题', 'quiet-topic', { parentId: group.id });
    const other = await hub.store.createConversation('owner', ['alpha'], '另一个群组', 'other', { type: 'group' });
    const question: Block[] = [{ type: 'card', title: '需要选择', elements: [{ type: 'button', text: '提交', actionId: 'askq_submit', value: { cctb_lark: 'ask_user_question', action: 'form_submit', requestId: 'question' } }] }];
    const approval: Block[] = [{ type: 'card', title: '需要批准', elements: [{ type: 'button', text: '允许此次', actionId: 'approve', value: { cctb_lark: 'approval', decision: 'allow_once', requestId: 'approval' } }] }];
    const request = await hub.store.publishBotMessage('alpha', { conversationId: topic.id, blocks: question });
    await page.goto(hub.url); await preparePairing(page, hub);
    await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
    await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
    await waitForClientOnline(page); await showDisconnectedBots(page);
    await page.getByRole('button', { name: '打开 ADHD 模式', exact: true }).click();
    const tree = page.locator('.adhd-group-topics').filter({ has: page.locator(`[data-conversation-id="${group.id}"]`) });
    const parent = tree.locator(`[data-conversation-id="${group.id}"]`);
    const child = tree.locator(`[data-conversation-id="${topic.id}"]`);
    const toggle = tree.locator('.adhd-topic-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(parent.locator('.adhd-picker-attention')).toHaveText('待回答');
    await expect(parent).toHaveAttribute('aria-label', /待回答/);
    await expect(child).toBeHidden();
    await expect(page.locator(`.adhd-picker-list [data-conversation-id="${other.id}"] .adhd-picker-attention`)).toHaveCount(0);
    await tree.screenshot({ path: info.outputPath('collapsed-topic-attention.png') });
    const resize = page.locator('.adhd-shell > .sidebar .sidebar-resize-handle');
    await resize.focus(); await page.keyboard.press('Home');
    await expect(page.locator('.adhd-shell > .sidebar')).toHaveCSS('width', '200px');
    for (const mode of ['light', 'dark']) {
      await page.evaluate(mode => { document.documentElement.dataset.theme = mode; }, mode);
      // Pending attention must not consume the title/preview column at minimum width.
      await expect.poll(() => parent.locator('.row-text').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(32);
      await expect(parent).toHaveAttribute('aria-label', /待回答/);
      await expect(parent.locator('.adhd-picker-attention')).toHaveAttribute('title', '待回答');
      await expect(parent.locator('.adhd-picker-attention')).toHaveCSS('font-size', '0px');
      await expect(parent.locator('.adhd-picker-attention')).toHaveCSS('width', '6px');
      await tree.screenshot({ path: info.outputPath(`narrow-topic-attention-${mode}.png`) });
    }
    if (browserName === 'chromium') {
      await page.emulateMedia({ forcedColors: 'active' });
      const marker = parent.locator('.adhd-picker-attention');
      await expect(marker).toHaveCSS('forced-color-adjust', 'none');
      await expect.poll(() => marker.evaluate(el => {
        const probe = document.createElement('span');
        probe.style.color = 'CanvasText'; el.append(probe);
        const canvasText = getComputedStyle(probe).color; probe.remove();
        return getComputedStyle(el).backgroundColor === canvasText;
      })).toBe(true);
      await tree.screenshot({ path: info.outputPath('narrow-topic-attention-forced-colors.png') });
      await page.emulateMedia({ forcedColors: 'none' });
    }
    await resize.focus(); await page.keyboard.press('End');
    await expect(parent.locator('.adhd-picker-attention')).toHaveCSS('font-size', '10px');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

    await toggle.click();
    await expect(parent.locator('.adhd-picker-attention')).toHaveCount(0);
    await expect(child.locator('.adhd-picker-attention')).toHaveText('待回答');
    await toggle.click();
    const search = page.getByRole('textbox', { name: '筛选面板对话', exact: true });
    await search.fill(topic.title);
    await expect(parent.locator('.adhd-picker-attention')).toHaveCount(0);
    await expect(child.locator('.adhd-picker-attention')).toBeVisible();
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    await expect(parent.locator('.adhd-picker-attention')).toHaveText('待回答');
    await hub.store.publishBotMessage('alpha', { id: request.id, conversationId: topic.id, blocks: approval });
    await expect(parent.locator('.adhd-picker-attention')).toHaveText('待批准');
    await expect(parent).toHaveAttribute('aria-label', /待批准/);
    await hub.store.publishBotMessage('alpha', { id: request.id, conversationId: topic.id, blocks: [{ type: 'text', text: '已处理' }] });
    await expect(parent.locator('.adhd-picker-attention')).toHaveCount(0);
    await expect(parent).not.toHaveAttribute('aria-label', /待回答|待批准/);
    // A request in the parent itself remains visible after expanding its topics.
    const ownRequest = await hub.store.publishBotMessage('alpha', { conversationId: group.id, blocks: approval });
    await expect(parent.locator('.adhd-picker-attention')).toHaveText('待批准');
    await toggle.click();
    await expect(parent.locator('.adhd-picker-attention')).toHaveText('待批准');
    await hub.store.publishBotMessage('alpha', { id: ownRequest.id, conversationId: group.id, blocks: [{ type: 'text', text: '已处理' }] });
    await hub.store.publishBotMessage('alpha', { id: request.id, conversationId: topic.id, blocks: question });
    await child.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '分组置顶', exact: true }).click();
    // The inbox does not render a separate pinned-topic section: pinning must
    // not remove the only way to reach this topic or hide its pending request.
    await expect(child).toBeVisible();
    await expect(page.locator(`.adhd-picker-list [data-conversation-id="${topic.id}"]`)).toHaveCount(1);
    await toggle.click();
    await expect(parent.locator('.adhd-picker-attention')).toHaveText('待回答');
    await toggle.click();
    await expect(child.locator('.adhd-picker-attention')).toHaveText('待回答');
    await child.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '取消分组置顶', exact: true }).click();
    await expect(child).toBeVisible();
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
