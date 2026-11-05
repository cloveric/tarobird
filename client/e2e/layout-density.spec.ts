import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { openSettings, closeSettings } from './fixtures/settings.js';
import { showDisconnectedBots, mobileHome, openMobileHome, selectConversation, waitForClientOnline } from './fixtures/mobile.js';

test.use({ serviceWorkers: 'block' });

for (const platform of ['web', 'android', 'ios']) test(`${platform} keeps its own compact list geometry across density changes and reload`, async ({ page }, info) => {
  // Exercise the packaged web UI with a native platform hint; this is not an
  // Android/iPhone device test or native plugin acceptance.
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-density-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture')");
    const chat = await hub.store.createConversation('owner', ['alpha'], '项目讨论', 'project');
    await hub.store.publishBotMessage('alpha', { conversationId: chat.id, blocks: [{ type: 'text', text: '最近的消息会显示在这里' }], status: 'complete' });
    await page.setViewportSize({ width: 390, height: 844 }); await pair(page, hub);
    // Cache a real conversation before enabling the hint. Native transport and
    // keystore APIs are outside this layout-only browser check.
    await page.addInitScript(platform => {
      (window as any).CapacitorCustomPlatform = { name: platform };
      // Native plugins are unavailable in this browser fixture. Keep their
      // capability checks off while getPlatform exercises the real UI branch.
      const capacitor = (window as any).Capacitor = {};
      Object.defineProperty(capacitor, 'isNativePlatform', { get: () => () => false, set: () => {} });
    }, platform);
    await page.reload(); await expect(mobileHome(page)).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-platform', platform);
    const row = mobileHome(page).locator(`[data-conversation-id="${chat.id}"]`);
    const compact = platform === 'ios' ? { avatar: 44, title: 16, preview: 14, height: 64, gap: 12, padding: 8 } : { avatar: 40, title: 14, preview: 12.5, height: 60, gap: 10, padding: 6 };
    for (const density of ['compact', 'standard', 'comfortable', 'compact'] as const) {
      await openSettings(page);
      await page.getByRole('radio', { name: { compact: '紧凑', standard: '标准', comfortable: '宽松' }[density]!, exact: true }).check();
      const expected = density === 'compact' ? compact : density === 'standard' ? { avatar: 48, title: 16, preview: 14, height: 72, gap: 12, padding: 10 } : { avatar: 56, title: 17, preview: 15, height: 84, gap: 14, padding: 14 };
      await expect(page.locator('.density-preview-avatar').first()).toHaveCSS('width', `${expected.avatar * .75}px`);
      await closeSettings(page); await openMobileHome(page);
      await mobileHome(page).getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^消息/ }).click();
      await expect(row.locator('.profile-avatar').first()).toHaveCSS('width', `${expected.avatar}px`);
      await expect(row.locator('.mh-row-title')).toHaveCSS('font-size', `${expected.title}px`);
      await expect(row.locator('.mh-row-preview')).toHaveCSS('font-size', `${expected.preview}px`);
      await expect(row).toHaveCSS('min-height', `${expected.height}px`);
      await expect(row).toHaveCSS('column-gap', `${expected.gap}px`);
      await expect(row).toHaveCSS('padding-top', `${expected.padding}px`);
    }
    await page.reload(); await expect(mobileHome(page)).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
    await expect(row.locator('.profile-avatar').first()).toHaveCSS('width', `${compact.avatar}px`);
    await expect(row.locator('.mh-row-title')).toHaveCSS('font-size', `${compact.title}px`);
    await page.screenshot({ path: info.outputPath(`${platform}-compact.png`), animations: 'disabled' });
    await mobileHome(page).getByRole('navigation', { name: '主导航' }).getByRole('button', { name: 'Bot', exact: true }).click();
    const bot = mobileHome(page).getByRole('button', { name: '查看 研究助手 的全部对话', exact: true });
    await expect(bot.locator('.profile-avatar').first()).toHaveCSS('width', `${compact.avatar}px`);
    await expect(bot.locator('.mh-row-title')).toHaveCSS('font-size', `${compact.title}px`);
    await page.screenshot({ path: info.outputPath(`${platform}-bots-compact.png`), animations: 'disabled' });
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url);
  await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
  await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
  await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' }); await showDisconnectedBots(page);
  await waitForClientOnline(page);
}

for (const width of [390, 1360]) test(`density changes layout without changing reading size or drafts at ${width}px`, async ({ page, browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'layout-density-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture'),('beta','写作助手','fixture')");
    const chat = await hub.store.createConversation('owner', ['alpha'], '项目讨论', 'project');
    const group = await hub.store.createConversation('owner', ['alpha', 'beta'], '协作小组', 'group', { type: 'group' });
    for (const title of ['旅行计划', '阅读笔记', '设计方案', '每周复盘', '生活记录']) {
      const entry = await hub.store.createConversation('owner', ['alpha'], title, title);
      await hub.store.publishBotMessage('alpha', { conversationId: entry.id, blocks: [{ type: 'text', text: '最近的消息会显示在这里' }], status: 'complete' });
    }
    await hub.store.publishBotMessage('alpha', { conversationId: chat.id, blocks: [{ type: 'text', text: '独立的聊天字号应保持不变。' }], status: 'complete' });
    await page.setViewportSize({ width, height: 844 }); await pair(page, hub);
    await expect(page.locator('html')).toHaveAttribute('data-density', width <= 760 ? 'compact' : 'standard');
    await page.screenshot({ path: info.outputPath('default-density.png'), animations: 'disabled' });
    if (width > 760) await page.getByRole('button', { name: '按对话', exact: true }).click();
    await selectConversation(page, chat.title);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('切换密度也要保留这份草稿');
    const measurements: Record<string, number> = {};
    const treeMeasurements: Record<string, number> = {};
    for (const [density, label] of [['standard', '标准'], ['comfortable', '宽松'], ['compact', '紧凑']]) {
      await openSettings(page);
      const font = page.getByRole('slider', { name: '字号', exact: true });
      await font.focus(); await font.press('Home');
      for (let i = 12; i < 18; i++) await font.press('ArrowRight');
      await page.locator('input[name="color-palette"][value="white-violet"]').check();
      await page.getByLabel('主题', { exact: true }).selectOption(density === 'comfortable' ? 'dark' : 'light');
      await page.getByRole('radio', { name: label, exact: true }).check();
      await expect(page.locator('html')).toHaveAttribute('data-density', density);
      await expect(font).toHaveValue('18');
      if (width > 760 && density === 'compact') await expect(page.locator('.density-preview-avatar').first()).toHaveCSS('width', '30px');
      await page.screenshot({ path: info.outputPath(`density-picker-${density}.png`), animations: 'disabled' });
      await closeSettings(page);
      await selectConversation(page, chat.title);
      await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('切换密度也要保留这份草稿');
      await expect(page.locator('.message.bot .markdown')).toHaveCSS('font-size', '18px');
      await openMobileHome(page);
      const list = width <= 760 ? mobileHome(page) : page.locator('.host-workspace:not([hidden]) .sidebar');
      const row = list.locator(`[data-conversation-id="${chat.id}"]`);
      measurements[density] = (await row.boundingBox())!.height;
      if (width > 760 && density === 'compact') {
        await expect(row.locator('strong').first()).toHaveCSS('font-size', '13px');
        await expect(row.locator('small').first()).toHaveCSS('font-size', '11.5px');
      }
      // The desktop sidebar's resize handle intentionally extends 4px outside
      // its edge. Check the scrollable content rather than that outer handle.
      const content = width <= 760 ? list : list.locator('.conversation-list');
      const bounds = await content.evaluate(node => ({ scroll: node.scrollWidth, client: node.clientWidth }));
      expect(bounds.scroll, `${density}: ${JSON.stringify(bounds)}`).toBeLessThanOrEqual(bounds.client);
      const collage = list.locator(`[data-conversation-id="${group.id}"] .group-avatar-members`);
      expect(await collage.evaluate(node => {
        const box = node.getBoundingClientRect();
        return [...node.querySelectorAll('.profile-avatar')].every(child => { const r = child.getBoundingClientRect(); return r.right <= box.right + 1 && r.bottom <= box.bottom + 1; });
      })).toBe(true);
      await list.screenshot({ path: info.outputPath(`list-${density}.png`), animations: 'disabled' });
      if (width > 760) {
        await list.getByRole('button', { name: '按 Bot', exact: true }).click();
        treeMeasurements[density] = (await row.boundingBox())!.height;
        await expect(row).toBeVisible();
        await list.screenshot({ path: info.outputPath(`bot-tree-${density}.png`), animations: 'disabled' });
        await list.getByRole('button', { name: '按对话', exact: true }).click();
      }
    }
    expect(measurements.compact).toBeLessThan(measurements.standard!);
    expect(measurements.comfortable).toBeGreaterThan(measurements.standard!);
    if (width > 760) {
      expect(treeMeasurements.compact).toBeLessThan(treeMeasurements.standard!);
      expect(treeMeasurements.comfortable).toBeGreaterThan(treeMeasurements.standard!);
    }
    await page.reload(); await waitForClientOnline(page);
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
    await selectConversation(page, chat.title);
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('切换密度也要保留这份草稿');
    if (width > 760) {
      // A desktop window can enter the narrow layout; its saved Compact choice
      // must not pick up native iPhone list sizes at that breakpoint.
      await page.setViewportSize({ width: 600, height: 844 });
      await openMobileHome(page);
      const row = mobileHome(page).locator(`[data-conversation-id="${chat.id}"]`);
      await expect(row.locator('.profile-avatar').first()).toHaveCSS('width', '40px');
      await expect(row.locator('.mh-row-title')).toHaveCSS('font-size', '14px');
      await expect(row.locator('.mh-row-preview')).toHaveCSS('font-size', '12.5px');
      await page.screenshot({ path: info.outputPath('desktop-narrow-compact.png'), animations: 'disabled' });
      await page.setViewportSize({ width, height: 844 });
    }
    if (width <= 760) {
      await page.evaluate(() => {
        document.documentElement.style.setProperty('--safe-area-inset-top', '59px');
        document.documentElement.style.setProperty('--safe-area-inset-bottom', '34px');
      });
      await openMobileHome(page);
      expect((await mobileHome(page).locator('.mh-titlebar').boundingBox())!.y).toBeGreaterThanOrEqual(59);
      const tab = (await mobileHome(page).getByRole('button', { name: '我的', exact: true }).boundingBox())!;
      expect(tab.y + tab.height).toBeLessThanOrEqual(810);
      await selectConversation(page, chat.title); await page.setViewportSize({ width: 390, height: 480 });
      const composer = page.getByRole('textbox', { name: '消息', exact: true });
      await composer.focus(); await composer.fill('键盘打开时也能继续输入');
      const box = (await composer.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(59); expect(box.y + box.height).toBeLessThanOrEqual(446);
      await page.setViewportSize({ width: 320, height: 740 });
    }
    await openSettings(page);
    // An explicit Standard choice survives reload even on a phone whose
    // fresh-install default is now Compact.
    await page.getByRole('radio', { name: '标准', exact: true }).check();
    await closeSettings(page);
    await page.reload(); await waitForClientOnline(page);
    await expect(page.locator('html')).toHaveAttribute('data-density', 'standard');
    await openSettings(page);
    await page.getByLabel('语言', { exact: true }).selectOption('en');
    await expect(page.getByRole('group', { name: 'Layout density', exact: true })).toBeVisible();
    await page.getByRole('radio', { name: 'Standard', exact: true }).check();
    await expect(page.locator('html')).toHaveAttribute('data-density', 'standard');
    await expect(page.getByRole('slider', { name: 'Text size', exact: true })).toHaveValue('18');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // A newly paired device keeps its own layout preference.
    await page.getByRole('radio', { name: 'Compact', exact: true }).check();
    const other = await browser.newContext({ serviceWorkers: 'block' });
    try { const independent = await other.newPage(); await pair(independent, hub); await expect(independent.locator('html')).toHaveAttribute('data-density', 'standard'); }
    finally { await other.close(); }
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const width of [390, 1360]) test(`saved density preserves choices and uses the device default for missing values at ${width}px`, async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'density-migration-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  try {
    await page.setViewportSize({ width, height: 844 });
    await pair(page, hub);
    for (const saved of [null, 'unknown-density', 'standard', 'comfortable', 'compact']) {
      await page.evaluate(value => new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('tarocub-hosts-v1');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction('meta', 'readwrite'), store = tx.objectStore('meta');
          const get = store.get('preferences');
          get.onsuccess = () => { const prefs = JSON.parse(get.result); prefs.fontSize = 18; prefs.palette = 'white-violet'; if (value === null) delete prefs.layoutDensity; else prefs.layoutDensity = value; store.put(JSON.stringify(prefs), 'preferences'); localStorage.setItem('tarocub-appearance', JSON.stringify(prefs)); };
          tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(tx.error); };
        };
      }), saved);
      await page.reload(); await waitForClientOnline(page);
      const expected = saved && ['compact', 'standard', 'comfortable'].includes(saved) ? saved : width <= 760 ? 'compact' : 'standard';
      await expect(page.locator('html')).toHaveAttribute('data-density', expected);
      await expect(page.locator('html')).toHaveAttribute('data-palette', 'white-violet');
      await expect(page.locator('html')).toHaveCSS('font-size', '18px');
    }
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
