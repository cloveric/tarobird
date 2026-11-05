import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { showDisconnectedBots, mobileHome, openWorkspacePage, selectConversation, waitForClientOnline } from './fixtures/mobile.js';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });

// Browser/iOS fallback values; Android's native window is tested by instrumentation.
async function insets(page: Page, top: number, right = 0, bottom = 0, left = 0) {
  await page.evaluate(values => {
    for (const [side, value] of Object.entries(values)) document.documentElement.style.setProperty(`--safe-area-inset-${side}`, `${value}px`);
  }, { top, right, bottom, left });
}
async function within(locator: Locator, bounds: { top: number; right: number; bottom: number; left: number }) {
  await expect(locator).toBeVisible();
  await expect.poll(() => locator.evaluate((node, b) => {
    const r = node.getBoundingClientRect();
    return r.top >= b.top - 1 && r.left >= b.left - 1 && r.bottom <= b.bottom + 1 && r.right <= b.right + 1;
  }, bounds)).toBe(true);
}

test('phone operations and capabilities fill the safe viewport with a persistent back bar', async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'settings-fullscreen-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  const portrait = { top: 59, left: 0, right: 390, bottom: 810 };
  const panel = page.locator('.mobile-settings-page');
  const fullPage = async (bounds: typeof portrait) => {
    await expect.poll(() => panel.evaluate(node => {
      const box = node.getBoundingClientRect();
      return { top: Math.round(box.top), left: Math.round(box.left), right: Math.round(box.right), bottom: Math.round(box.bottom) };
    })).toEqual(bounds);
    expect(await panel.evaluate(node => ({ radius: getComputedStyle(node).borderTopLeftRadius, overflow: node.scrollWidth > node.clientWidth }))).toEqual({ radius: '0px', overflow: false });
    await within(panel.locator('.settings-page-back'), bounds);
  };
  try {
    for (let i = 0; i < 9; i++) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,'fixture')", [`bot${i}`, `助手 ${i}`]);
    await page.route('**/api/bots/*/capabilities', route => route.fulfill({ json: {
      generatedAt: new Date().toISOString(), engine: 'claude', workspace: '/fixture', runtime: 'unverified', coverage: 'partial',
      entries: Array.from({ length: 25 }, (_, i) => ({ id: `skill-${i}`, kind: 'skill', name: `资料整理 ${i}`, description: '整理资料与核对来源。', scope: 'workspace', source: `skills/task-${i}/SKILL.md`, status: 'discovered' })),
      sources: [], warnings: ['runtime_unverified', 'partial_catalog'],
    } }));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(hub.url); await insets(page, 59, 0, 34);
    await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
    await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' }); await showDisconnectedBots(page); await waitForClientOnline(page);
    await openWorkspacePage(page, '运行状态');
    await expect(page.locator('.operation-bot')).toHaveCount(9);
    await fullPage(portrait);
    const header = panel.locator('.settings-page-header');
    const headerTop = (await header.boundingBox())!.y;
    await page.screenshot({ path: info.outputPath('phone-operations-fullscreen.png') });
    await page.locator('.operation-bot').last().scrollIntoViewIfNeeded();
    expect((await header.boundingBox())!.y).toBeCloseTo(headerTop, 0);
    await within(page.locator('.operation-bot').last(), portrait);
    await page.getByRole('button', { name: '查看 Hub 审计', exact: true }).click();
    await expect(page.getByRole('button', { name: '刷新状态', exact: true })).toHaveCount(0);
    await panel.locator('.settings-page-back').click();
    await expect(page.getByRole('button', { name: '刷新状态', exact: true })).toBeInViewport();
    await panel.locator('.settings-page-back').click();
    await expect(panel).toHaveCount(0);
    await expect(mobileHome(page).getByRole('button', { name: '运行状态', exact: true })).toBeFocused();
    await openWorkspacePage(page, 'Skills 与 MCP');
    await expect(page.locator('.capability-card')).toHaveCount(25);
    await fullPage(portrait);
    await page.screenshot({ path: info.outputPath('phone-capabilities-fullscreen.png') });
    await page.locator('.capability-summary').last().scrollIntoViewIfNeeded();
    await within(header, portrait);
    // Native-resize keyboard: the app can use the resized viewport without
    // reserving the gesture inset twice or hiding its navigation.
    const search = page.getByLabel('搜索能力', { exact: true });
    await search.scrollIntoViewIfNeeded(); await search.tap();
    await search.fill('资料整理 2');
    await page.setViewportSize({ width: 390, height: 480 }); await insets(page, 59, 0, 0);
    await fullPage({ ...portrait, bottom: 480 });
    await within(page.getByLabel('搜索能力', { exact: true }), { ...portrait, bottom: 480 });
    await expect(page.locator('.capability-card')).toHaveCount(6);
    // The enclosing search field owns focus styling, never a second box
    // around the text after touching it or typing with the keyboard open.
    await expect(search).toBeFocused();
    await expect(search).toHaveCSS('box-shadow', 'none');
    await expect(search).toHaveCSS('outline-style', 'none');
    await expect(search).toHaveCSS('border-width', '0px');
    await page.screenshot({ path: info.outputPath('phone-capabilities-keyboard.png') });
    // Touch landscape crosses the desktop width breakpoint but stays full page.
    await page.setViewportSize({ width: 844, height: 390 }); await insets(page, 32, 44, 21, 44);
    const landscape = { top: 32, left: 44, right: 800, bottom: 369 };
    await fullPage(landscape);
    await page.locator('.capability-summary').last().scrollIntoViewIfNeeded();
    await within(header, landscape);
    await page.screenshot({ path: info.outputPath('landscape-capabilities-fullscreen.png') });
    await page.setViewportSize({ width: 390, height: 844 }); await insets(page, 59, 0, 34);
    // Android's WebView is already inset by NativeInsets, so no second padding.
    await page.evaluate(() => { document.documentElement.dataset.nativeInsets = 'android'; });
    await fullPage({ top: 0, left: 0, right: 390, bottom: 844 });
    await expect(page.getByLabel('搜索能力', { exact: true })).toHaveValue('资料整理 2');
    await panel.locator('.settings-page-back').click();
    await expect(panel).toHaveCount(0);
    await expect(mobileHome(page).getByRole('button', { name: 'Skills 与 MCP', exact: true })).toBeFocused();
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('safe areas protect pairing, inbox, chat, sheets and previews and update after rotation', async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safe-area-'));
  const hub = await HubServer.start({stateDir: root, clientDir: path.resolve('dist')});
  try {
    for (let i = 0; i < 9; i++) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,'fixture')", [`bot${i}`, `助手 ${i}`]);
    const chat = await hub.store.createConversation('owner', ['bot0'], '安全区测试', 'chat');
    const bytes = Buffer.from('# 内置阅读\n不会被系统区域遮住。');
    const attachmentId = await hub.attachments.importForBot('bot0', {conversationId:chat.id, name:'reading.md', mime:'text/markdown', size:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex')}, bytes);
    await hub.store.publishBotMessage('bot0', {conversationId:chat.id, blocks:[{type:'file', attachmentId, name:'reading.md', mime:'text/markdown', size:bytes.length}], status:'complete'});
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.goto(hub.url); await insets(page, 59, 0, 34);
    const portrait = {top:59, left:0, right:390, bottom:810};
    await within(page.locator('.pairing-card h1'), portrait);
    await preparePairing(page, hub); await page.getByRole('button', {name:'配对此设备', exact:true}).click();
    await hub.auth.approve(await page.getByLabel('配对码', {exact:true}).innerText(), 'local-owner');
    await page.getByLabel('配对码', {exact:true}).waitFor({state:'hidden'}); await showDisconnectedBots(page); await waitForClientOnline(page);
    await within(mobileHome(page).locator('.mh-titlebar'), portrait);
    await within(mobileHome(page).getByRole('button', {name:'我的', exact:true}), portrait);
    // A rejected notification must remain readable below the Dynamic Island.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('tarocub-navigate', {
      detail: { conversationId: 'unknown', hostId: 'unknown-host' }, cancelable: true,
    })));
    const hostError = page.locator('.host-error');
    await within(hostError, portrait);
    await hostError.getByRole('button', { name: '关闭', exact: true }).click();
    await selectConversation(page, chat.title);
    await within(page.getByRole('button', {name:'打开会话列表', exact:true}), portrait);
    await within(page.getByRole('heading', {name:chat.title, exact:true}), portrait);
    await within(page.getByRole('button', {name:'更多聊天操作', exact:true}), portrait);
    await within(page.locator('.composer-toolbar'), portrait);
    // The page owns exactly one status-bar inset, including a Pro Max width.
    // Native container behavior is configured separately in capacitor.config.ts.
    for (const width of [390, 430]) {
      await page.setViewportSize({ width, height: 932 });
      await expect.poll(() => page.locator('.conversation-header').evaluate(node => {
        const box = node.getBoundingClientRect();
        return { top: box.top, height: box.height };
      })).toEqual({ top: 0, height: 59 + 56 });
      await page.screenshot({ path: info.outputPath(`single-top-inset-${width}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const paddedHeight = await page.locator('.conversation-header').evaluate(node => node.getBoundingClientRect().height);
    await page.screenshot({path:info.outputPath('portrait-safe-chat.png')});
    await insets(page, 0);
    await expect.poll(() => page.locator('.conversation-header').evaluate(node => node.getBoundingClientRect().height)).toBeCloseTo(paddedHeight - 59, 0);
    // Android's already-inset WebView must never reserve a stale CSS inset again.
    await page.evaluate(() => { document.documentElement.dataset.nativeInsets = 'android'; });
    await insets(page, 59, 0, 34);
    await expect.poll(() => page.locator('.conversation-header').evaluate(node => node.getBoundingClientRect().height)).toBeCloseTo(paddedHeight - 59, 0);
    await page.evaluate(() => { delete document.documentElement.dataset.nativeInsets; });
    await expect(page.getByRole('heading', {name:chat.title, exact:true})).toBeVisible();
    await insets(page, 59, 0, 34);
    await page.getByRole('region', {name:'reading.md', exact:true}).getByRole('button', {name:'预览 reading.md', exact:true}).click();
    const preview = page.getByRole('dialog', {name:'文件预览', exact:true});
    await within(preview.locator('.file-preview'), portrait);
    await preview.getByRole('button', {name:'关闭', exact:true}).click();
    await page.getByRole('button', {name:'更多聊天操作', exact:true}).click();
    await page.getByRole('dialog', {name:'聊天操作', exact:true}).getByRole('button', {name:'打开连接设置', exact:true}).click();
    await within(page.getByRole('button', {name:'关闭连接状态与线路', exact:true}), portrait);
    await page.setViewportSize({width:844, height:390}); await insets(page, 32, 44, 21, 44);
    await within(page.getByRole('button', {name:'关闭连接状态与线路', exact:true}), {top:32, left:44, right:800, bottom:369});
    await page.setViewportSize({width:390, height:844}); await insets(page, 59, 0, 34);
    await page.getByRole('button', {name:'关闭连接状态与线路', exact:true}).click();
    await page.getByRole('button', {name:'打开会话列表', exact:true}).click();
    await mobileHome(page).getByRole('button', {name:'新建', exact:true}).click();
    await mobileHome(page).getByRole('menuitem', {name:'新建群组', exact:true}).click();
    const group = page.getByRole('dialog', {name:'新建群组', exact:true});
    await within(group.locator('header'), portrait);
    const create = group.getByRole('button', {name:'创建群组', exact:true});
    await create.scrollIntoViewIfNeeded(); await within(create, portrait);
    await page.keyboard.press('Escape');
    await selectConversation(page, chat.title);
    await page.setViewportSize({width:740, height:390}); await insets(page, 0, 44, 21, 44);
    const landscape = {top:0, left:44, right:696, bottom:369};
    await within(page.getByRole('button', {name:'打开会话列表', exact:true}), landscape);
    await within(page.getByRole('button', {name:'更多聊天操作', exact:true}), landscape);
    await within(page.locator('.composer-toolbar'), landscape);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath('landscape-safe-chat.png')});
    // Native-resize keyboard: the resized viewport already excludes the IME.
    await page.setViewportSize({width:390, height:480}); await insets(page, 59, 0, 0);
    await page.getByRole('textbox', {name:'消息', exact:true}).fill('保留安全区草稿');
    await within(page.locator('.composer-toolbar'), {top:59, left:0, right:390, bottom:480});
    await within(page.getByRole('button', {name:'更多聊天操作', exact:true}), {top:59, left:0, right:390, bottom:480});
    await page.setViewportSize({width:390, height:844}); await insets(page, 59, 0, 34);
    await expect(page.getByRole('textbox', {name:'消息', exact:true})).toHaveValue('保留安全区草稿');
    await within(page.locator('.composer-toolbar'), portrait);
  } finally { await page.close(); await hub.close(); await rm(root, {recursive:true, force:true}); }
});
