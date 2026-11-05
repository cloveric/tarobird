import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import type { BoardDocument } from '../src/workbench-model.js';
import { preparePairing } from './fixtures/pairing-invite.js';
import { selectConversation, waitForClientOnline } from './fixtures/mobile.js';
import { closeSettings, openSettings } from './fixtures/settings.js';

test.use({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
test.skip(({ browserName }) => browserName === 'firefox', 'Playwright Firefox has no mobile viewport emulation; iOS uses WebKit.');

async function nativeInsets(page: Page, top: number, right: number, bottom: number, left: number) {
  await page.evaluate(insets => {
    for (const [edge, value] of Object.entries(insets)) {
      document.documentElement.style.setProperty(`--fixture-safe-${edge}`, `${value}px`);
      document.documentElement.style.setProperty(`--safe-area-inset-${edge}`, `${value}px`);
    }
  }, { top, right, bottom, left });
}

async function fixture(page: Page, english = false, font = 18) {
  // Browser engines expose zero env() insets. Substitute only that native input,
  // keeping the App and editor's actual CSS/layout rules unchanged. This is
  // WebKit/browser evidence, not an installed iOS App or physical-device test.
  await page.route('**/*.css', async route => {
    const response = await route.fetch();
    const css = (await response.text()).replace(/env\(safe-area-inset-(top|right|bottom|left)(?:,[^)]*)?\)/g, 'var(--fixture-safe-$1, 0px)');
    await route.fulfill({ response, body: css });
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ios-workbench-'));
  const hub = await HubServer.start({ stateDir: directory, clientDir: path.resolve('dist') });
  await hub.profile.update({ name: 'Demo Studio', revision: (await hub.profile.read()).revision });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('drawing','画图助手','fixture',1)");
  const conversation = await hub.store.createConversation('owner', ['drawing'], '移动白板', 'whiteboard');
  const close = async () => { await page.close(); await hub.close(); await rm(directory, { recursive: true, force: true }); };
  try {
    await page.goto(hub.url); await preparePairing(page, hub);
    await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
    await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
    await waitForClientOnline(page);
    await selectConversation(page, conversation.title);
    if (english) {
      await openSettings(page, 'general'); await page.locator('#language').selectOption('en'); await closeSettings(page, true);
      await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'Message', exact: true }).click();
      await page.locator('.mh-row').filter({ has: page.getByText(conversation.title, { exact: true }) }).click();
    }
    await page.evaluate(font => {
      document.documentElement.dataset.platform = 'ios';
      document.documentElement.style.setProperty('--font-size', `${font}px`);
    }, font);
    await nativeInsets(page, 59, 0, 34, 0);
    await page.getByRole('button', { name: english ? 'Workbench' : '工作台', exact: true }).click();
    const panel = page.getByRole('complementary', { name: english ? 'Workbench' : '工作台', exact: true });
    await panel.getByRole('button', { name: english ? 'Whiteboard' : '白板', exact: true }).click();
    await expect(panel.locator('.workbench-canvas')).toHaveAttribute('data-board-saved', 'true');
    await expect(panel.getByTestId('toolbar-rectangle')).toBeAttached();
    return { panel, close };
  } catch (error) { await close(); throw error; }
}

async function geometry(panel: Locator) {
  return panel.locator('.excalidraw').evaluate(node => {
    const rect = (element: Element) => { const r = element.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom }; };
    const toolbar = node.querySelector('.App-toolbar-container')!;
    const controls = [...toolbar.querySelectorAll<HTMLElement>('.ToolIcon, .default-sidebar-trigger')].filter(element => element.offsetWidth > 0).map(element => {
      const r = rect(element), top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { ...r, label: element.getAttribute('aria-label') || element.getAttribute('title') || element.className, reachable: !!top && element.contains(top) };
    });
    return { root:rect(node), toolbar:rect(toolbar), controls, header:rect(document.querySelector('.conversation-header')!), composer:rect(document.querySelector('.composer-wrap')!) };
  });
}

async function assertTools(panel: Locator, safeLeft = 0, safeRight = 0) {
  await expect.poll(async () => (await geometry(panel)).controls.length).toBeGreaterThanOrEqual(13);
  const layout = await geometry(panel), viewport = panel.page().viewportSize()!;
  expect(layout.toolbar.y - layout.root.y, 'Embedded controls must not repeat the native top inset').toBeLessThanOrEqual(24);
  expect(layout.header.y, 'Workbench mode must not pad the entire chat shell').toBe(0);
  expect(layout.composer.bottom).toBeLessThanOrEqual(viewport.height + 1);
  expect(layout.root.bottom, 'The canvas must not extend behind the composer').toBeLessThanOrEqual(layout.composer.y + 1);
  for (const control of layout.controls) {
    expect(control.x, control.label).toBeGreaterThanOrEqual(Math.max(layout.root.x, safeLeft));
    expect(control.right, control.label).toBeLessThanOrEqual(Math.min(layout.root.right, viewport.width - safeRight) + 1);
    expect(control.bottom, control.label).toBeLessThanOrEqual(layout.root.bottom + 1);
    expect(control.width, control.label).toBeGreaterThanOrEqual(44);
    expect(control.height, control.label).toBeGreaterThanOrEqual(44);
    expect(control.reachable, `${control.label} must not be covered by another control`).toBe(true);
  }
  // Check the full hit rectangles, not just their visible centres.
  const collisions = layout.controls.flatMap((a, i) => layout.controls.slice(i + 1).filter(b => Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1).map(b => [a.label, b.label]));
  expect(collisions).toEqual([]);
  return layout;
}

async function savedBoard(page: Page, id: string) {
  return page.evaluate(async id => {
    for (const { name } of await indexedDB.databases()) {
      if (!name) continue;
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        if (!db.objectStoreNames.contains('workbenchBoards')) continue;
        const boards = await new Promise<BoardDocument[]>((resolve, reject) => { const request = db.transaction('workbenchBoards').objectStore('workbenchBoards').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        const board = boards.find(board => board.id === id);
        if (board) return board;
      } finally { db.close(); }
    }
  }, id);
}

for (const scenario of [{ width:430, height:932, font:18, english:false }, { width:375, height:812, font:20, english:true }, { width:320, height:740, font:20, english:false }]) {
  test(`iPhone whiteboard controls fit at ${scenario.width}px, ${scenario.font}px reading size, ${scenario.english ? 'English' : 'Chinese'}`, async ({ page }, info) => {
    await page.setViewportSize(scenario);
    const f = await fixture(page, scenario.english, scenario.font);
    try {
      await assertTools(f.panel);
      await page.screenshot({ path: info.outputPath('ios-whiteboard.png') });
      // Tap the actual label; the radio remains an upstream hidden input.
      await f.panel.getByTestId('toolbar-rectangle').locator('..').tap();
      await expect(f.panel.getByTestId('toolbar-rectangle')).toBeChecked();
      await f.panel.getByTestId('toolbar-selection').locator('..').tap();
      await expect(f.panel.getByTestId('toolbar-selection')).toBeChecked();
    } finally { await f.close(); }
  });
}

test('iPhone drawing persists through asymmetric landscape insets, undo and reopening', async ({ page }, info) => {
  const f = await fixture(page);
  try {
    const canvas = f.panel.locator('.workbench-canvas'), id = (await canvas.getAttribute('data-board-id'))!;
    await f.panel.getByTestId('toolbar-rectangle').locator('..').tap();
    const area = (await canvas.locator('canvas.interactive').boundingBox())!;
    await page.mouse.move(area.x + 50, area.y + area.height * .5);
    await page.mouse.down(); await page.mouse.move(area.x + 180, area.y + area.height * .7, { steps: 4 }); await page.mouse.up();
    await expect.poll(async () => (await savedBoard(page, id))?.scene.elements.filter(e => !e.isDeleted).length).toBe(1);
    const original = (await savedBoard(page, id))!.scene.elements;
    await f.panel.getByTestId('toolbar-selection').locator('..').tap();
    await nativeInsets(page, 0, 59, 21, 0);
    await page.setViewportSize({ width:932, height:430 });
    await expect(f.panel).not.toHaveClass(/workbench-phone/);
    const expand = f.panel.getByRole('button', { name:'展开到主区', exact:true });
    if (await expand.isVisible()) await expand.tap();
    await expect(f.panel).toHaveClass(/workbench-wide/);
    const toolbar = f.panel.locator('.App-toolbar-container');
    await expect(toolbar).toHaveCSS('overflow-x', 'auto');
    await expect.poll(async () => { const layout = await geometry(f.panel); return layout.root.bottom - layout.composer.y; }).toBeLessThanOrEqual(1);
    const landscape = await geometry(f.panel);
    expect(landscape.root.bottom).toBeLessThanOrEqual(landscape.composer.y + 1);
    expect(landscape.toolbar.right).toBeLessThanOrEqual(932 - 59);
    const bottomActions = (await f.panel.locator('.App-bottom-bar > .Island').boundingBox())!;
    expect(landscape.toolbar.bottom, 'Selection actions must not cover the drawing toolbar').toBeLessThanOrEqual(bottomActions.y + 1);
    // Every control stays available by swiping the short editor's one-row bar.
    const tools = toolbar.locator('.ToolIcon, .default-sidebar-trigger');
    for (let index = 0; index < await tools.count(); index++) {
      const tool = tools.nth(index);
      if (!await tool.isVisible()) continue;
      await tool.scrollIntoViewIfNeeded();
      expect(await tool.evaluate(element => {
        const r = element.getBoundingClientRect(), target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return !!target && element.contains(target);
      })).toBe(true);
    }
    await toolbar.evaluate(element => { element.scrollLeft = 0; });
    expect((await savedBoard(page, id))!.scene.elements).toEqual(original);
    await page.screenshot({ path:info.outputPath('ios-landscape.png') });
    await nativeInsets(page, 59, 0, 34, 0); await page.setViewportSize({ width:430, height:932 });
    await expect(f.panel).toHaveClass(/workbench-phone/);
    await assertTools(f.panel);
    await f.panel.locator('.workbench-canvas-tools').getByRole('button', { name:'撤销', exact:true }).tap();
    await expect.poll(async () => (await savedBoard(page, id))?.scene.elements.filter(e => !e.isDeleted).length).toBe(0);
    await f.panel.locator('.workbench-canvas-tools').getByRole('button', { name:'重做', exact:true }).tap();
    await expect.poll(async () => (await savedBoard(page, id))?.scene.elements.filter(e => !e.isDeleted).length).toBe(1);
    await f.panel.getByRole('button', { name:'返回聊天', exact:true }).tap();
    await page.getByRole('button', { name:'工作台', exact:true }).tap();
    await expect(canvas).toHaveAttribute('data-board-saved', 'true');
    // Excalidraw restores an unbound shape's null bindings as an empty list.
    const normalized = (elements: BoardDocument['scene']['elements']) => elements.map(element => ({ ...element, boundElements:element.boundElements ?? [] }));
    expect(normalized((await savedBoard(page, id))!.scene.elements)).toEqual(normalized(original));
  } finally { await f.close(); }
});
