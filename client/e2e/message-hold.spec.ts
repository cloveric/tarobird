import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { showDisconnectedBots, selectConversation, waitForClientOnline } from './fixtures/mobile.js';
import { holdMessage } from './fixtures/message-actions.js';

const down = (target: Locator, extra = {}) => target.dispatchEvent('pointerdown', { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, clientX: 90, clientY: 220, ...extra });
const up = (target: Locator) => target.dispatchEvent('pointerup', { pointerId: 7, pointerType: 'touch', isPrimary: true });
test('phone hold quotes exact files; tap previews; movement, controls and leaving cancel', async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'message-hold-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','阅读助手','fixture')");
    const chat = await hub.store.createConversation('owner', ['alpha'], '移动交互验收', 'hold');
    const other = await hub.store.createConversation('owner', ['alpha'], '其他对话', 'other');
    const bytes = Buffer.from('阅读编号：HOLD-FILE-318。此内容必须来自文件。');
    const name = '阅读材料与下周计划.txt';
    const attachmentId = await hub.attachments.importForBot('alpha', { conversationId: chat.id, name, size: bytes.length, mime: 'text/plain', sha256: createHash('sha256').update(bytes).digest('hex') }, bytes);
    const msg = await hub.store.publishBotMessage('alpha', { conversationId: chat.id, blocks: [{ type: 'text', text: '请查看下周的阅读安排。\n\n[示例链接](https://example.com)\n\n```text\n可选中的代码\n```' }, { type: 'file', name, attachmentId, mime: 'text/plain', size: bytes.length }] });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page); await waitForClientOnline(page);
    await selectConversation(page, chat.title);
    const row = page.locator(`[data-message-id="${msg.id}"]`), bubble = row.locator('.message-blocks');
    const file = row.getByRole('button', { name: `预览 ${name}`, exact: true });
    const sheet = page.getByRole('dialog', { name: '消息操作', exact: true });
    const preview = page.getByRole('dialog', { name: '文件预览', exact: true });
    const composer = page.getByRole('textbox', { name: '消息', exact: true });
    await composer.fill('保留草稿');
    await expect(row.getByRole('button', { name: '消息操作', exact: true })).toHaveCount(0);
    await expect(file).toHaveText(new RegExp(name.replace('.', '\\.')));
    await expect(file).not.toContainText('预览');
    await expect(row.getByRole('button', { name: '预览', exact: true })).toHaveCount(0);
    // Short tap the filename itself, not a separate label/button.
    await file.locator('strong').tap(); await expect(preview).toContainText('HOLD-FILE-318');
    await preview.getByRole('button', { name: '关闭', exact: true }).click(); await expect(file).toBeFocused();
    // Native Chromium touch input additionally covers the trusted release/click path.
    if (browser.browserType().name() === 'chromium') {
      const cdp = await context.newCDPSession(page), bounds = (await file.boundingBox())!;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds.x + 30, y: bounds.y + 20 }] });
      await expect(sheet).toBeVisible();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(preview).toHaveCount(0); await cdp.detach();
    } else await holdMessage(page, row, file);
    await expect(sheet.locator('.message-sheet-preview')).toContainText(name);
    await page.screenshot({ path: info.outputPath('phone-hold-actions.png') });
    await sheet.getByRole('button', { name: '引用回复', exact: true }).click();
    await expect(composer).toBeFocused(); await expect(composer).toHaveValue('保留草稿');
    await expect(page.locator('.reply-preview')).toContainText(name);
    await page.screenshot({ path: info.outputPath('phone-quoted-file.png') });
    await page.getByRole('button', { name: '取消引用', exact: true }).click();
    // Each cancellation must remain closed after the full hold threshold.
    for (const reason of ['move', 'cancel', 'multi', 'release', 'blur']) {
      await down(bubble);
      if (reason === 'move') await bubble.dispatchEvent('pointermove', { pointerId: 7, pointerType: 'touch', clientX: 90, clientY: 250 });
      if (reason === 'cancel') await bubble.dispatchEvent('pointercancel', { pointerId: 7 });
      if (reason === 'multi') await down(bubble, { pointerId: 8, isPrimary: false });
      if (reason === 'release') await up(bubble);
      if (reason === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await page.waitForTimeout(650); await expect(sheet).toBeHidden(); await up(bubble);
    }
    for (const target of [row.getByRole('link', { name: '示例链接' }), row.locator('pre'), row.getByRole('button', { name: `另存为 ${name}`, exact: true })]) {
      await down(target); await page.waitForTimeout(650); await expect(sheet).toBeHidden(); await up(target);
    }
    await down(bubble);
    await page.evaluate(id => window.dispatchEvent(new CustomEvent('tarocub-navigate', { detail: { conversationId: id } })), other.id);
    await expect(page.getByRole('heading', { name: other.title, exact: true })).toBeVisible();
    await selectConversation(page, chat.title); await page.waitForTimeout(650); await expect(sheet).toBeHidden();
    // A stationary row survives virtualizer/programmatic scroll notifications.
    await down(bubble); await page.locator('.message-scroll').dispatchEvent('scroll');
    await expect(sheet).toBeVisible(); await up(bubble);
    await sheet.getByRole('button', { name: '选择文本', exact: true }).click();
    const selection = sheet.getByRole('textbox', { name: '可选择的消息文本', exact: true });
    await expect(selection).toHaveValue(/请查看下周的阅读安排/);
    await expect(selection).toBeFocused();
    expect(await selection.evaluate((el: HTMLTextAreaElement) => el.selectionEnd > el.selectionStart)).toBe(true);
    await sheet.getByRole('button', { name: '返回消息操作', exact: true }).click();
    await expect(sheet.getByRole('button', { name: '选择文本', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(row).toBeFocused();
    await page.keyboard.press('Shift+F10'); await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape'); await expect(row).toBeFocused();
    await row.dispatchEvent('click', { detail: 0 }); await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    // Ongoing streaming must not let tail-following steal a stationary hold.
    await down(bubble);
    for (let index = 0; index < 4; index++) {
      await hub.store.publishBotMessage('alpha', { id: msg.id, conversationId: chat.id, status: 'streaming', blocks: [...msg.blocks, { type: 'text', text: `继续整理 ${index}` }] });
      await page.waitForTimeout(60);
    }
    await expect(sheet).toBeVisible(); await up(bubble); await page.keyboard.press('Escape');
    await hub.store.publishBotMessage('alpha', { id: msg.id, conversationId: chat.id, status: 'complete', blocks: msg.blocks });
    // New pointer starts clear the release guard; deliberate subsequent taps work.
    await holdMessage(page, row, file); await page.keyboard.press('Escape');
    await file.tap(); await expect(preview).toBeVisible(); await page.keyboard.press('Escape');
    await holdMessage(page, row); await sheet.getByRole('button', { name: '引用回复', exact: true }).click();
    await composer.fill('请读取引用附件'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(async () => (await hub.store.pendingForBot('alpha')).some(input => input.replyTo === msg.id)).toBe(true);
    await page.setViewportSize({ width: 320, height: 844 });
    await expect(file).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const bounds = (await file.boundingBox())!; expect(bounds.width).toBeGreaterThan(130); expect(bounds.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath('phone-file-320.png') });
    await page.setViewportSize({ width: 1360, height: 900 });
    await expect(row.getByRole('button', { name: '预览', exact: true })).toBeVisible();
    await down(bubble); await page.waitForTimeout(650); await expect(sheet).toBeHidden(); await up(bubble);
    expect(errors).toEqual([]);
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const platform of ['android', 'ios', 'web']) test(`phone hold has one feedback owner on ${platform}`, async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hold-feedback-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const chat = await hub.store.createConversation('owner', ['alpha'], '单次长按', 'hold');
    const message = await hub.store.publishBotMessage('alpha', { conversationId: chat.id, blocks: [{ type: 'text', text: '按住这条消息' }] });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
    await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' }); await showDisconnectedBots(page); await waitForClientOnline(page);
    await selectConversation(page, chat.title);
    // Substitute just the Haptics native bridge after pairing. This counts actual
    // App calls; it does not simulate or claim Android's physical system pulse.
    await page.evaluate(platform => {
      const win = window as any, cap = win.Capacitor;
      win.hapticCalls = [];
      cap.getPlatform = () => platform; cap.isNativePlatform = () => platform !== 'web';
      cap.PluginHeaders = [{ name: 'Haptics', methods: [{ name: 'impact', rtype: 'promise' }] }];
      cap.nativePromise = async (plugin: string, method: string, args: unknown) => { win.hapticCalls.push({ plugin, method, args }); };
    }, platform);
    const row = page.locator(`[data-message-id="${message.id}"]`), bubble = row.locator('.message-blocks');
    const sheet = page.getByRole('dialog', { name: '消息操作', exact: true });
    await down(bubble); await expect(sheet).toBeVisible();
    // WebView contextmenu and the finger's release must not reopen or vibrate again.
    await bubble.dispatchEvent('contextmenu', { pointerType: 'touch' });
    await page.waitForTimeout(650); await up(bubble);
    await bubble.dispatchEvent('click', { detail: 1 });
    await expect(sheet).toBeVisible();
    expect(await page.evaluate(() => (window as any).hapticCalls)).toEqual(platform === 'ios'
      ? [{ plugin: 'Haptics', method: 'impact', args: { style: 'LIGHT' } }] : []);
    await page.keyboard.press('Escape'); await expect(row).toBeFocused();
    await down(bubble); await up(bubble); await page.waitForTimeout(650);
    await expect(sheet).toBeHidden();
    expect(await page.evaluate(() => (window as any).hapticCalls.length)).toBe(platform === 'ios' ? 1 : 0);
    // A later intentional hold is still a new gesture, never permanently debounced.
    await holdMessage(page, row);
    await expect.poll(() => page.evaluate(() => (window as any).hapticCalls.length)).toBe(platform === 'ios' ? 2 : 0);
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
