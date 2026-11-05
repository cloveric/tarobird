import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from './fixtures/vite.js';
import { HubServer } from '../../src/hub/server.js';
import { messageAction } from './fixtures/message-actions.js';
import { showDisconnectedBots, selectConversation, waitForClientOnline } from './fixtures/mobile.js';

// Deliberate viewport-signal simulation, not a claim of a physical OS keyboard.
async function simulatedViewport(page: Page) {
  await page.addInitScript(() => {
    const visual = Object.assign(new EventTarget(), { height: innerHeight, width: innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: visual });
    (window as any).setAcceptanceViewport = (height: number, top = 0, scale = 1) => {
      Object.assign(visual, { height, offsetTop: top, scale }); visual.dispatchEvent(new Event('resize')); visual.dispatchEvent(new Event('scroll'));
    };
  });
}
const viewport = (page: Page, height: number, top = 0, scale = 1) => page.evaluate(({ height, top, scale }) => (window as any).setAcceptanceViewport(height, top, scale), { height, top, scale });
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
  await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page); await waitForClientOnline(page);
}
const within = async (page: Page, selector: string, top: number, bottom: number) => {
  await expect.poll(async () => page.locator(selector).filter({ visible: true }).evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom }; }))).toEqual(expect.arrayContaining([expect.objectContaining({ top: expect.any(Number), bottom: expect.any(Number) })]));
  await expect.poll(async () => page.locator(selector).filter({ visible: true }).evaluateAll((elements, bounds) => elements.every(element => { const rect = element.getBoundingClientRect(); return rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1; }), { top, bottom })).toBe(true);
};
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('repeated keyboard opening and dismissal preserve the header and restore only one bottom inset', async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keyboard-inset-cycle-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  try {
    await page.setViewportSize({ width: 430, height: 932 });
    await simulatedViewport(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const chat = await hub.store.createConversation('owner', ['alpha'], '键盘切换布局', 'keyboard-insets');
    await pair(page, hub); await selectConversation(page, chat.title);
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--safe-area-inset-top', '59px');
      document.documentElement.style.setProperty('--safe-area-inset-bottom', '34px');
    });
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    const geometry = () => page.evaluate(() => {
      const header = document.querySelector('.conversation-header')!.getBoundingClientRect();
      const composer = document.querySelector('.composer')!.getBoundingClientRect();
      return { headerTop: header.top, headerHeight: header.height, composerBottom: composer.bottom };
    });
    const closed = { headerTop: 0, headerHeight: 115, composerBottom: 932 - 34 };
    await expect.poll(geometry).toEqual(closed);
    await input.focus(); // Focus alone must not move either edge of the page.
    await expect.poll(geometry).toEqual(closed);
    for (let cycle = 0; cycle < 3; cycle++) {
      await viewport(page, 550);
      await expect.poll(geometry).toEqual({ headerTop: 0, headerHeight: 115, composerBottom: 550 - 8 });
      await input.fill('输入时标题保持原位');
      await expect.poll(geometry).toEqual({ headerTop: 0, headerHeight: 115, composerBottom: 550 - 8 });
      if (cycle === 0) await page.screenshot({ path: info.outputPath('keyboard-open.png'), clip: { x: 0, y: 0, width: 430, height: 550 } });
      await viewport(page, 932);
      await input.blur();
      await expect.poll(geometry).toEqual(closed);
      await expect(input).toHaveValue('输入时标题保持原位');
      await input.fill('');
      await expect.poll(geometry).toEqual(closed);
    }
    await page.screenshot({ path: info.outputPath('keyboard-closed-after-three-cycles.png') });
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('visual keyboard keeps quoted attachment composer reachable and preserves the draft across hide and zoom', async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keyboard-chat-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  try {
    await simulatedViewport(page);
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','产品搭档','fixture'),('beta','研究助手','fixture')");
    const group = await hub.store.createConversation('owner', ['alpha', 'beta'], '手机输入体验', 'group', { type: 'group' });
    const original = await hub.store.publishBotMessage('alpha', { conversationId: group.id, blocks: [{ type: 'text', text: '请引用这段建议，和文件说明一起发送。\n' + '消息区仍应可以阅读和滚动。\n'.repeat(20) }] });
    await pair(page, hub); await selectConversation(page, group.title);
    await messageAction(page, page.locator(`[data-message-id="${original.id}"]`), '引用回复');
    const draft = '这是一份键盘展开后仍可编辑的草稿。';
    await page.getByRole('textbox', { name: '消息', exact: true }).fill(draft);
    await page.locator('input[type="file"][multiple]').setInputFiles([{ name: '方案一.txt', mimeType: 'text/plain', buffer: Buffer.from('一') }, { name: '方案二.txt', mimeType: 'text/plain', buffer: Buffer.from('二') }]);
    await viewport(page, 500, 24);
    await expect(page.getByRole('region', { name: '群聊方式与讨论状态' })).toBeHidden();
    await within(page, '.conversation-header', 24, 524);
    await page.screenshot({ path: info.outputPath('keyboard-composer-before-bounds.png') });
    await within(page, '.composer textarea,.composer-toolbar', 24, 524);
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
    await expect(page.getByRole('region', { name: '待发送的附件' }).getByRole('listitem')).toHaveCount(2);
    await expect.poll(() => page.locator('.message-scroll').evaluate(element => element.clientHeight)).toBeGreaterThan(80);
    await page.screenshot({ path: info.outputPath('keyboard-composer.png'), clip: { x: 0, y: 24, width: 390, height: 500 } });
    await viewport(page, 422, 0, 2);
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--app-height'))).toBe('');
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(draft);
    await viewport(page, 844);
    await expect(page.getByRole('region', { name: '群聊方式与讨论状态' })).toBeVisible();
    await within(page, '.composer-toolbar', 0, 844);
    await expect(page.getByRole('region', { name: '待发送的附件' }).getByRole('listitem')).toHaveCount(2);
    await viewport(page, 500);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(async () => (await hub.store.snapshot('owner', group.id)).messages.filter(message => message.authorType === 'user').length).toBe(1);
    const sent = (await hub.store.snapshot('owner', group.id)).messages.find(message => message.authorType === 'user')!;
    expect(sent.replyTo).toBe(original.id); expect(sent.blocks.filter(block => block.type === 'file')).toHaveLength(2);
    expect(sent.blocks).toContainEqual({ type: 'text', text: draft });
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('short visual viewport keeps group creation scrollable and settings navigation inside the visible area', async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keyboard-dialog-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  try {
    await simulatedViewport(page);
    for (let i = 0; i < 8; i++) await hub.store.db.run('INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)', [`bot${i}`, `项目助手 ${i + 1}`, 'fixture']);
    await pair(page, hub);
    const home = page.locator('.mobile-home');
    await home.getByRole('button', { name: '新建', exact: true }).click();
    await home.getByRole('menu').getByRole('menuitem', { name: '新建群组', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建群组', exact: true });
    await dialog.getByLabel('群组名称（可选）', { exact: true }).fill('键盘下创建的群组');
    await viewport(page, 420, 20);
    await within(page, '.creation-dialog[open]', 20, 440);
    await expect.poll(() => dialog.locator('.profile-avatar').evaluateAll(elements => elements.every(element => { const rect = element.getBoundingClientRect(); return Math.abs(rect.width - rect.height) < 1 && rect.width >= 28; }))).toBe(true);
    await dialog.getByRole('checkbox').first().check();
    const create = dialog.getByRole('button', { name: '创建群组', exact: true }); await create.scrollIntoViewIfNeeded();
    await within(page, '.creation-dialog button.primary', 20, 440);
    await page.screenshot({ path: info.outputPath('keyboard-creation.png'), clip: { x: 0, y: 20, width: 390, height: 420 } });
    await create.click(); await expect(dialog).toBeHidden();
    await viewport(page, 844);
    await page.getByRole('button', { name: '更多聊天操作', exact: true }).click();
    await page.getByRole('dialog', { name: '聊天操作', exact: true }).getByRole('button', { name: '打开连接设置', exact: true }).click();
    await viewport(page, 420, 20);
    await within(page, '.preferences-dialog[open]', 20, 440);
    await within(page, '.preferences-header', 20, 440);
    await expect.poll(() => page.locator('.settings-content').evaluate(element => element.clientHeight)).toBeGreaterThan(100);
    await page.screenshot({ path: info.outputPath('keyboard-settings.png'), clip: { x: 0, y: 20, width: 390, height: 420 } });
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const kind of ['对话', '群组'] as const) for (const keyboard of ['visual', 'android'] as const) {
  test(`phone ${kind} ${keyboard} creation keeps its heading and name label clear of the sheet edge after focus scrolling`, async ({ page }, info) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'keyboard-create-heading-'));
    const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
    try {
      await simulatedViewport(page); await page.emulateMedia({ reducedMotion: 'reduce' });
      for (let i = 0; i < 6; i++) await hub.store.db.run('INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)', [`bot${i}`, `助手 ${i + 1}`, 'fixture']);
      await pair(page, hub);
      await page.evaluate(mode => {
        document.documentElement.dataset.density = mode === 'android' ? 'compact' : 'standard';
        if (mode === 'android') document.documentElement.dataset.nativeInsets = 'android';
      }, keyboard);
      const home = page.locator('.mobile-home');
      await home.getByRole('button', { name: '新建', exact: true }).click();
      await home.getByRole('menuitem', { name: `新建${kind}`, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: `新建${kind}`, exact: true });
      const name = dialog.getByLabel(`${kind}名称（可选）`, { exact: true });
      await name.fill(`键盘下的${kind}`);
      const top = keyboard === 'android' ? 0 : 20;
      if (keyboard === 'android') await page.setViewportSize({ width: 390, height: 420 });
      await viewport(page, 420, top);
      // Model the native focus scroll that revealed the field while scrolling
      // the title and close button outside the original sheet's clipping box.
      await name.evaluate(element => element.scrollIntoView({ block: 'start' }));
      // Also exercise a native scroll that brings the label to the very edge
      // of the form, without consulting scroll-padding / scroll-margin.
      await name.evaluate(element => {
        const form = element.closest('form')!;
        const label = element.closest('label')!;
        form.scrollTop += label.getBoundingClientRect().top - form.getBoundingClientRect().top;
      });
      await page.screenshot({ path: info.outputPath(`creation-${kind}-focus.png`), clip: { x: 0, y: top, width: 390, height: 420 } });
      await expect(dialog.getByRole('heading', { name: `新建${kind}`, exact: true })).toBeInViewport();
      await expect(dialog.getByRole('button', { name: '关闭新建对话', exact: true })).toBeInViewport();
      const host = dialog.locator(':scope > .runtime-host-label');
      await expect(host).toBeVisible();
      // Native focus scrolling does not always honour CSS scroll margins.
      // The scrollport itself must never paint over the fixed host caption.
      await expect.poll(async () => {
        const hostBox = (await host.boundingBox())!;
        const form = (await dialog.locator(':scope > form').boundingBox())!;
        return form.y - hostBox.y - hostBox.height;
      }).toBeGreaterThanOrEqual(8);
      await expect.poll(async () => {
        const hostBox = (await host.boundingBox())!;
        const label = (await name.locator('..').boundingBox())!;
        return label.y - hostBox.y - hostBox.height;
      }).toBeGreaterThanOrEqual(8);
      await expect.poll(async () => {
        const header = (await dialog.locator(':scope > header').boundingBox())!;
        const label = (await name.locator('..').boundingBox())!;
        return label.y - header.y - header.height;
      }).toBeGreaterThanOrEqual(8);
      await expect(name).toHaveValue(`键盘下的${kind}`);
      await dialog.getByRole('checkbox').last().check();
      await expect(dialog.getByRole('heading', { name: `新建${kind}`, exact: true })).toBeInViewport();
      await dialog.getByRole('button', { name: `创建${kind}`, exact: true }).click();
      await expect(dialog).toBeHidden();
      expect((await hub.store.conversations('owner')).map(chat => ({ title: chat.title, botIds: chat.botIds }))).toEqual([{ title: `键盘下的${kind}`, botIds: ['bot5'] }]);
    } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test('pairing input and desktop layout survive keyboard-sized viewport signals and rotation', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keyboard-pairing-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  try {
    await simulatedViewport(page); await page.goto(hub.url);
    await page.getByLabel('主机名称', { exact: true }).fill('我的 Mac mini');
    await viewport(page, 420);
    // Viewport events commit in the controller's next animation frame. Wait
    // for that band before asking the browser whether the action needs scroll.
    await expect.poll(() => page.locator('.pairing-page').evaluate(element => element.getBoundingClientRect().height)).toBe(420);
    const connect = page.getByRole('button', { name: '配对此设备', exact: true }); await connect.scrollIntoViewIfNeeded();
    await within(page, '.pairing-card form > button.primary', 0, 420);
    await expect(page.getByLabel('主机名称', { exact: true })).toHaveValue('我的 Mac mini');
    // Import and manual pairing are separate actions in a scrollable form;
    // both remain reachable, but need not fit in the keyboard band together.
    await page.getByRole('button', { name: '粘贴连接信息', exact: true }).scrollIntoViewIfNeeded();
    await within(page, '.pairing-import-actions button.primary', 0, 420);
    await viewport(page, 844);
    await page.setViewportSize({ width: 1360, height: 900 }); await viewport(page, 900);
    await expect.poll(() => page.locator('.pairing-card').evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(500);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('keyboard resize follows the latest message but preserves an explicit history position', async ({ page, browserName }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keyboard-scroll-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  try {
    await simulatedViewport(page); await page.emulateMedia({ reducedMotion: 'reduce' });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const chat = await hub.store.createConversation('owner', ['alpha'], '键盘与阅读位置', 'scroll');
    for (let i = 0; i < 40; i++) await hub.store.publishBotMessage('alpha', { conversationId: chat.id, blocks: [{ type: 'text', text: `阅读记录 ${i}：收起和展开键盘时，保持正在阅读的位置。` }] });
    await pair(page, hub); await selectConversation(page, chat.title);
    const scroll = page.locator('.message-scroll');
    const distance = () => scroll.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);
    await expect.poll(distance).toBeLessThan(3);
    await viewport(page, 500, 24); await expect.poll(distance).toBeLessThan(3);
    // An explicit user intent, unlike resize-generated scroll events, opts out
    // of following the tail before moving to older messages.
    if (browserName === 'webkit') {
      // Playwright does not support wheel input in mobile WebKit.
      await scroll.evaluate(element => { element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1000 })); element.scrollTop = 0; });
    } else {
      // A synthetic wheel + scrollTop assignment does not produce Chromium's
      // native scrolling sequence and can race the virtualizer's end anchor.
      await scroll.hover(); await page.mouse.wheel(0, -1000);
    }
    await expect(page.getByRole('button', { name: '回到最新消息', exact: true })).toBeVisible();
    // The jump mounts previously unmeasured rows. WebKit can publish their
    // ResizeObserver corrections after the button is already visible. Capture
    // a settled reading position, including the virtualizer's 150 ms deferred
    // iOS inertia correction, not its temporary size estimate.
    await scroll.evaluate(async element => {
      let previous = '', stableFrames = 0;
      for (let frame = 0; frame < 120; frame++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const signature = `${element.scrollTop}/${element.scrollHeight}/${[...element.querySelectorAll<HTMLElement>('.message')].map(row => `${row.dataset.index}:${row.style.transform}:${row.getBoundingClientRect().height}`).join(',')}`;
        stableFrames = signature === previous ? stableFrames + 1 : 0;
        if (stableFrames >= 12) return;
        previous = signature;
      }
      throw new Error('History rows did not finish measuring before keyboard resize');
    });
    await expect.poll(distance).toBeGreaterThan(844);
    const position = await scroll.evaluate(element => element.scrollTop);
    await viewport(page, 844);
    await expect.poll(() => scroll.evaluate((element, before) => Math.abs(element.scrollTop - before), position)).toBeLessThan(3);
    await viewport(page, 500);
    await expect.poll(() => scroll.evaluate((element, before) => Math.abs(element.scrollTop - before), position)).toBeLessThan(3);
    await page.getByRole('button', { name: '回到最新消息', exact: true }).click(); await expect.poll(distance).toBeLessThan(3);
    // Also exercise a genuinely resized browser layout, as with native resize.
    await page.setViewportSize({ width: 390, height: 500 }); await viewport(page, 500);
    await within(page, '.composer textarea,.composer-toolbar', 0, 500);
    await expect.poll(distance).toBeLessThan(3);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});


for (const width of [320, 430]) test(`native overlay keeps the new Bot form and close action visible after a window shrink at ${width}px`, async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keyboard-window-shrink-'));
  const vite = await createServer({ plugins: [{ name: 'native-overlay-fixture', enforce: 'pre', transform(code, id) {
    if (id.endsWith('/src/MobileViewport.tsx')) return code.replace("platform === 'ios' || platform === 'android' ? nativeKeyboardMotion[platform] : false", 'nativeKeyboardMotion.android');
  } }], server: { port: 0, host: '127.0.0.1' } });
  await vite.listen(); const url = vite.resolvedUrls!.local[0]!;
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  try {
    await page.setViewportSize({ width, height: 932 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(url); await page.getByLabel('Hub 地址', { exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
    await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' }); await waitForClientOnline(page);
    await page.route('**/api/bots/catalog', route => route.fulfill({ status: 200, json: { engines: [{ id: 'codex', available: true, models: [{ id: 'default', efforts: [] }], defaultModel: 'default', defaultEffort: '' }] } }));
    await page.getByRole('button', { name: '新建', exact: true }).filter({ visible: true }).click();
    await page.getByRole('menuitem', { name: '新建 Bot', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建 Bot', exact: true });
    await dialog.getByText('高级设置', { exact: true }).click();
    const field = dialog.getByLabel('工作区（可选）', { exact: true });
    await field.fill('/tmp/retained-draft');
    const keyboard = (height: number) => page.evaluate(height => window.dispatchEvent(new CustomEvent('tarobot-keyboard', { detail: { height, at: Date.now() - 1000 } })), height);
    await keyboard(400);
    const bounds = () => field.evaluate(node => ({ top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom }));
    await expect.poll(async () => (await bounds()).bottom).toBeLessThanOrEqual(532);
    await page.setViewportSize({ width, height: 750 });
    await expect.poll(() => page.locator('html').evaluate(node => node.style.getPropertyValue('--app-height'))).toBe('350px');
    await page.waitForTimeout(250);
    await page.screenshot({ path: info.outputPath('new-bot-after-window-shrink.png') });
    await info.attach('new-bot-field-after-window-shrink', { body: JSON.stringify(await bounds()), contentType: 'application/json' });
    await expect.poll(async () => (await bounds()).bottom).toBeLessThanOrEqual(350);
    await expect.poll(async () => (await bounds()).top).toBeGreaterThanOrEqual(0);
    await expect(field).toBeFocused(); await expect(field).toHaveValue('/tmp/retained-draft');
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await expect(dialog.getByRole('heading', { name: '新建 Bot', exact: true })).toBeInViewport();
    await expect(dialog.getByRole('button', { name: '关闭新建对话', exact: true })).toBeInViewport();
    // Repeated native/window signals must not pull a form the reader scrolled
    // back to the field; only an actual geometry change needs another reveal.
    const form = dialog.locator(':scope > form');
    const offset = await form.evaluate(node => { node.scrollTop -= 25; return node.scrollTop; });
    await keyboard(400); await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForTimeout(100);
    expect(await form.evaluate(node => node.scrollTop)).toBeCloseTo(offset, 1);
    // A visible upper field must not produce even a redundant scroll write.
    const name = dialog.getByLabel('Bot 名称', { exact: true });
    await name.fill('保留名称');
    await page.setViewportSize({ width, height: 780 });
    await page.waitForTimeout(100);
    await form.evaluate(node => {
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
      (window as any).focusResizeWrites = [];
      Object.defineProperty(node, 'scrollTop', { configurable: true,
        get() { return descriptor.get!.call(this); },
        set(value) { (window as any).focusResizeWrites.push(value); descriptor.set!.call(this, value); },
      });
    });
    await page.setViewportSize({ width, height: 750 });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as any).focusResizeWrites)).toEqual([]);
    await expect(name).toBeFocused();
    // With no native keyboard, a lower focused field is left to normal browser
    // scrolling; the controller must not take ownership of that resize.
    await keyboard(0); await page.waitForTimeout(100);
    await field.fill('/tmp/retained-draft');
    await form.evaluate(node => { node.scrollTop -= 25; (window as any).focusResizeWrites = []; });
    await page.setViewportSize({ width, height: 700 });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as any).focusResizeWrites)).toEqual([]);
    await dialog.getByRole('button', { name: '关闭新建对话', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  } finally { await page.close(); await hub.close(); await vite.close(); await rm(root, { recursive: true, force: true }); }
});
