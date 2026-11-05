import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { selectConversation, waitForClientOnline } from './fixtures/mobile.js';
import { messageAction } from './fixtures/message-actions.js';
import { hashSecret } from '../../src/hub/auth.js';
import { attachGateway } from '../../src/gateway/service.js';
import { createCoreServiceRuntime } from '../../src/core/runtime.js';
import { gatewayCommands } from '../../src/gateway/commands.js';

// Simulated keyboard/IME candidate-bar signals, not a physical-device keyboard.
async function setupViewport(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const visual = Object.assign(new EventTarget(), { height: innerHeight, width: innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: visual });
    (window as any).setSuggestionViewport = (height: number, top: number) => {
      Object.assign(visual, { height, offsetTop: top });
      visual.dispatchEvent(new Event('resize')); visual.dispatchEvent(new Event('scroll'));
    };
  });
}
async function viewport(page: Page, height: number, top = 0) {
  await page.evaluate(({ height, top }) => (window as any).setSuggestionViewport(height, top), { height, top });
}
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url);
  await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
  await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
  await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
  await waitForClientOnline(page);
  await page.evaluate(() => document.documentElement.style.setProperty('--safe-area-inset-top', '48px'));
}
async function bounded(page: Page) {
  await expect(page.locator('.command-menu')).toBeVisible();
  await expect.poll(() => page.locator('.command-menu').evaluate(menu => {
    const column = menu.closest('.conversation-main')!;
    const header = column.querySelector('.conversation-header')!.getBoundingClientRect();
    const messages = column.querySelector('.message-scroll')!.getBoundingClientRect();
    const anchor = menu.parentElement!.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    return box.top >= Math.max(header.bottom, messages.top) + 7 && box.bottom <= anchor.top - 7 && box.height > 30 && box.left >= 0 && box.right <= innerWidth;
  })).toBe(true);
}

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('all slash suggestions remain scrollable through keyboard and candidate-bar resizes', async ({ page, browserName }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-keyboard-'));
  const hub = await HubServer.start({ stateDir: path.join(root, 'hub'), clientDir: path.resolve('dist') });
  let gateway: Awaited<ReturnType<typeof attachGateway>> | undefined;
  try {
    await setupViewport(page);
    const stateDir = path.join(root, 'bot'), secret = randomBytes(32).toString('base64url');
    await mkdir(stateDir); await writeFile(path.join(stateDir, 'config.json'), JSON.stringify({ engine: 'codex', locale: 'zh' }));
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','命令助手',?)", [hashSecret(secret)]);
    gateway = await attachGateway({ stateDir, url: hub.url.replace('http', 'ws') + '/instance', botId: 'alpha', secret, runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: 'fixture' }) } });
    const chat = await hub.store.createConversation('owner', ['alpha'], '拼音输入', 'commands');
    for (let i = 0; i < 12; i++) await hub.store.publishBotMessage('alpha', { conversationId: chat.id, blocks: [{ type: 'text', text: `历史消息 ${i}：滑动命令菜单时保留聊天阅读位置。` }] });
    await pair(page, hub); await selectConversation(page, chat.title);
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    await input.fill('/'); await input.focus();
    for (const [height, top] of [[500, 24], [380, 0], [280, 0], [500, 24]]) {
      await viewport(page, height!, top!); await bounded(page);
    }
    const menu = page.locator('.command-menu');
    // This Host advertises the App-owned task browser in addition to Gateway
    // slash commands. Keep checking the complete catalog and its ordering.
    const allCommands = ['/tasks', ...gatewayCommands('codex').filter(({ command }) => command !== 'tasks').map(({ command }) => `/${command}`)];
    expect(allCommands.length).toBeGreaterThan(9);
    await expect(menu.locator('strong')).toHaveText(allCommands);
    await expect.poll(() => menu.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await expect.poll(() => menu.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(240);
    await page.screenshot({ path: info.outputPath('slash-keyboard.png') });
    // A Pinyin confirmation must not select a command or send the slash draft.
    await input.dispatchEvent('compositionstart', { data: '' });
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
    await input.dispatchEvent('compositionend', { data: '' });
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: false });
    await expect(input).toHaveValue('/');
    await menu.getByRole('button').last().scrollIntoViewIfNeeded();
    const command = await menu.getByRole('button').last().locator('strong').innerText();
    await menu.getByRole('button').last().tap();
    await expect(input).toHaveValue(`${command} `); await expect(input).toBeFocused();
    await expect(menu).toBeHidden();
    expect((await hub.store.snapshot('owner', chat.id)).messages.filter(message => message.authorType === 'user')).toHaveLength(0);
    // Closing the keyboard must retain the full catalog, not just nine rows.
    await input.fill('/'); await viewport(page, 844); await bounded(page);
    await expect(menu.locator('strong')).toHaveText(allCommands);
    const readingPosition = await page.locator('.message-scroll').evaluate(element => element.scrollTop);
    if (browserName === 'chromium') {
      // Trusted browser touch, rather than setting scrollTop: the menu must
      // consume vertical swipes without dragging the chat or selecting a row.
      const touch = await page.context().newCDPSession(page);
      const box = (await menu.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height - 24;
      try {
        await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let i = 1; i <= 8; i++) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - i * 20 }] });
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await expect.poll(() => menu.evaluate(element => element.scrollTop)).toBeGreaterThan(40);
      } finally { await touch.detach(); }
      await expect(input).toHaveValue('/');
      await expect.poll(() => page.locator('.message-scroll').evaluate(element => element.scrollTop)).toBe(readingPosition);
    }
    await menu.getByRole('button').last().scrollIntoViewIfNeeded();
    await bounded(page);
    await expect(menu.getByRole('button').last()).toBeInViewport();
    await page.screenshot({ path: info.outputPath('all-commands-keyboard-closed.png') });
    await menu.getByRole('button').last().tap();
    await expect(input).toHaveValue(`${allCommands.at(-1)} `); await expect(input).toBeFocused();
    // A prefix still filters the complete catalog, including formerly hidden rows.
    await input.fill('/cr');
    await expect(menu.locator('strong')).toHaveText(['/cron']);
    await menu.getByRole('button').tap(); await expect(input).toHaveValue('/cron ');
    await input.fill('/');
    // Native layout resize and rotation continue to recompute the available area.
    await page.setViewportSize({ width: 390, height: 400 }); await viewport(page, 400); await bounded(page);
    await page.setViewportSize({ width: 844, height: 300 }); await viewport(page, 300); await bounded(page);
  } finally { await page.close(); await gateway?.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('group Bot suggestions scroll within the space left above a quoted attachment draft', async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mention-keyboard-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  try {
    await setupViewport(page);
    const bots = Array.from({ length: 14 }, (_, i) => `bot${i}`);
    for (const [i, id] of bots.entries()) await hub.store.db.run('INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)', [id, `助手 ${i + 1}`, 'fixture']);
    const chat = await hub.store.createConversation('owner', bots, '多人讨论', 'mentions', { type: 'group' });
    const original = await hub.store.publishBotMessage(bots[0]!, { conversationId: chat.id, blocks: [{ type: 'text', text: '请大家检查这个文件。' }] });
    await pair(page, hub); await selectConversation(page, chat.title);
    await messageAction(page, page.locator(`[data-message-id="${original.id}"]`), '引用回复');
    await page.locator('input[type="file"][multiple]').setInputFiles({ name: 'review.txt', mimeType: 'text/plain', buffer: Buffer.from('review') });
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    await input.fill('请检查 @'); await input.focus();
    await viewport(page, 520, 20); await bounded(page);
    const menu = page.locator('.command-menu');
    // If not even one touch row fits, never cover the title/composer with a
    // clipped sliver. Candidate-bar dismissal must restore the same draft/menu.
    await viewport(page, 380); await expect(menu).toBeHidden();
    await viewport(page, 560); await bounded(page);
    await expect.poll(() => menu.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await menu.getByRole('button').last().scrollIntoViewIfNeeded();
    await bounded(page);
    await page.screenshot({ path: info.outputPath('mention-keyboard.png') });
    await menu.getByRole('button').last().tap();
    await expect(input).toHaveValue('请检查 '); await expect(input).toBeFocused();
    await expect(menu).toBeHidden();
    await expect(page.locator('.reply-preview')).toBeVisible();
    await expect(page.getByRole('region', { name: '待发送的附件' }).getByRole('listitem')).toHaveCount(1);
    expect((await hub.store.snapshot('owner', chat.id)).messages.filter(message => message.authorType === 'user')).toHaveLength(0);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
