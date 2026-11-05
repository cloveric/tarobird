import { openFolderManager } from './fixtures/mobile.js';
import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Locator, type Page, type WebSocketRoute } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HOST_PROFILE_KEY } from "../../src/hub/host-profile.js";
import { HubServer } from '../../src/hub/server.js';
import { ConversationFolders } from '../../src/hub/conversation-folders.js';
import { showDisconnectedBots, mobileHome, openMobileHome, waitForClientOnline } from './fixtures/mobile.js';
import { clickAppAction } from './fixtures/desktop-actions.js';
import { colorPalettes } from '../src/palettes.js';

test.use({ serviceWorkers: 'block' });
const workspace = (page: Page) => page.locator('.host-workspace:not([hidden])');
const sidebar = (page: Page) => workspace(page).locator('.sidebar');
const dialog = (page: Page, name: string) => page.getByRole('dialog', { name, exact: true });
const hostId = (hub: HubServer) => `hub_${createHash('sha256').update(Buffer.from(hub.auth.publicKey, 'base64')).digest('hex')}`;
async function navigate(page: Page, hub: HubServer) {
  await page.evaluate(detail => window.dispatchEvent(new CustomEvent('tarocub-navigate', { detail })), { hostId: hostId(hub), conversationId: 'same' });
  await expect(workspace(page)).toHaveAttribute('data-active-host', hostId(hub));
}
async function pair(page: Page, hub: HubServer, name = '测试主机', add = false) {
  await hub.store.db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [HOST_PROFILE_KEY, JSON.stringify({ name, revision: 1 })]);
  if (add) await clickAppAction(page, '连接另一台主机', workspace(page).getByRole('button', { name: '连接另一台主机', exact: true }));
  else await page.goto(hub.url);
  await page.getByLabel('主机名称', { exact: true }).fill(name);
  await page.getByLabel('Hub 地址', { exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
  await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
  await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' }); await showDisconnectedBots(page);
  await waitForClientOnline(page);
}
async function createFolder(page: Page, name: string) {
  await openFolderManager(page);
  await page.getByRole('button', { name: '新建分组', exact: true }).filter({ visible: true }).click();
  await dialog(page, '新建分组').getByLabel('分组名称').fill(name);
  await dialog(page, '新建分组').getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog(page, '新建分组')).toHaveCount(0);
  await dialog(page, '管理分组').getByRole('button', { name: '关闭分组', exact: true }).click();
}
async function desktopMove(page: Page, id: string, name: string) {
  await sidebar(page).locator(`[data-conversation-id="${id}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移至分组', exact: true }).click();
  await dialog(page, '移至分组').getByRole('button', { name, exact: true }).click();
  await expect(dialog(page, '移至分组')).toHaveCount(0);
}

async function folderOptions(page: Page, name: string) {
  const entry = dialog(page, '管理分组').getByRole('button', { name: `分组操作：${name}`, exact: true });
  if (await entry.getAttribute('aria-expanded') !== 'true') await entry.click();
}

for (const width of [390, 1360]) test(`new folder stays before trailing Unfiled while a pin holds the last ordinary slot (${width}px)`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const root = await mkdtemp(path.join(os.tmpdir(), 'folder-create-pinned-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  const folders = new ConversationFolders(hub.store.db);
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','助手','fixture')");
    await hub.store.createConversation('owner', ['bot'], '分组验收', 'chat');
    await folders.change('owner', { type: 'create', id: 'work', name: '工作', revision: 0 });
    await folders.change('owner', { type: 'create', id: 'life', name: '生活', revision: 1 });
    await folders.change('owner', { type: 'reorder', folderIds: ['work', null, 'life'], revision: 2 });
    await folders.change('owner', { type: 'pin', id: 'life', pinned: true, revision: 3 });
    await pair(page, hub);
    if (width > 600) await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    await createFolder(page, '新分组');
    const headings = (width > 600 ? sidebar(page) : mobileHome(page)).locator('.folder-heading .folder-name');
    await expect(headings).toHaveText(['生活', '工作', '新分组', '未分组']);
    await openFolderManager(page);
    await expect(dialog(page, '管理分组').locator('.folder-order-name')).toHaveText(['生活', '工作', '新分组', '未分组']);
    await page.screenshot({ path: info.outputPath('new-folder-pinned-order.png') });
    await dialog(page, '管理分组').getByRole('button', { name: '关闭分组', exact: true }).click();
    await page.reload(); await waitForClientOnline(page);
    await expect(headings).toHaveText(['生活', '工作', '新分组', '未分组']);
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('pinned folders sync desktop and phone, survive reload and stay above ordinary sorting', async ({ page, browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'folder-pin-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  const phone = await context.newPage(), folders = new ConversationFolders(hub.store.db);
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','助手','fixture')");
    const chat = await hub.store.createConversation('owner', ['bot'], '项目设计', 'chat');
    await folders.change('owner', { type: 'create', id: 'work', name: '工作', conversationId: chat.id, revision: 0 });
    await folders.change('owner', { type: 'create', id: 'life', name: '生活', revision: 1 });
    await folders.change('owner', { type: 'create', id: 'learn', name: '学习', revision: 2 });
    await pair(page, hub); await pair(phone, hub);
    await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    await sidebar(page).locator(`[data-conversation-id="${chat.id}"]`).click();
    const composer = workspace(page).getByRole('textbox', { name: '消息', exact: true });
    await composer.fill('置顶时保留草稿');
    const desktopNames = sidebar(page).locator('.folder-heading .folder-name'), phoneNames = mobileHome(phone).locator('.folder-heading .folder-name');
    const heading = (id: string) => sidebar(page).locator(`[data-folder-id="${id}"] .folder-heading`);
    const menu = page.getByRole('menu', { name: '分组操作', exact: true });
    await heading('life').click({ button: 'right' });
    await menu.getByRole('button', { name: '置顶分组', exact: true }).click();
    await expect(desktopNames).toHaveText(['生活', '工作', '学习', '未分组']);
    await expect(phoneNames).toHaveText(['生活', '工作', '学习', '未分组']);
    await expect(heading('life').getByRole('img', { name: '已置顶', exact: true })).toBeVisible();
    await heading('work').focus(); await heading('work').press('Shift+F10');
    await expect(menu.getByRole('button', { name: '上移一位', exact: true })).toBeDisabled();
    await expect(menu.getByRole('button', { name: '移到同类分组最上面', exact: true })).toBeDisabled();
    await menu.getByRole('button', { name: '置顶分组', exact: true }).click();
    await expect(desktopNames).toHaveText(['工作', '生活', '学习', '未分组']);
    await page.reload(); await phone.reload();
    await expect(phoneNames).toHaveText(['工作', '生活', '学习', '未分组']);
    await expect(sidebar(page).locator('.conversation-folder[data-pinned=true]')).toHaveCount(2);
    await expect(composer).toHaveValue('置顶时保留草稿');
    await heading('work').click({ button: 'right' });
    await expect(menu.getByRole('button', { name: '取消置顶', exact: true })).toBeEnabled();
    await page.screenshot({ path: info.outputPath('desktop-pinned-folder.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    const phoneHeading = mobileHome(phone).locator('[data-folder-id="work"] .folder-heading'), actions = dialog(phone, '分组操作');
    await phoneHeading.dispatchEvent('pointerdown', { pointerId: 5, pointerType: 'touch', isPrimary: true, button: 0, clientX: 100, clientY: 200 });
    await expect(actions).toBeVisible();
    await phoneHeading.dispatchEvent('pointerup', { pointerId: 5, pointerType: 'touch', isPrimary: true, button: 0 });
    await phone.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await phone.screenshot({ path: info.outputPath('phone-pinned-folder.png'), animations: 'disabled' });
    await actions.getByRole('button', { name: '取消置顶', exact: true }).tap();
    await expect(actions).toHaveCount(0);
    await expect(desktopNames).toHaveText(['生活', '工作', '学习', '未分组']);
    await expect(heading('work').getByRole('img', { name: '已置顶', exact: true })).toHaveCount(0);
    await openFolderManager(page);
    const manager = dialog(page, '管理分组');
    await manager.getByRole('button', { name: '拖动排序：未分组', exact: true }).press('Home');
    await expect(manager.locator('.folder-order-name')).toHaveText(['生活', '未分组', '工作', '学习']);
    const handle = await manager.getByRole('button', { name: '拖动排序：未分组', exact: true }).boundingBox();
    const target = await manager.getByRole('button', { name: '拖动排序：生活', exact: true }).boundingBox();
    await page.mouse.move(handle!.x + 10, handle!.y + 10); await page.mouse.down();
    await page.mouse.move(target!.x + 10, target!.y + 10, { steps: 8 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.mouse.up();
    await expect(manager.locator('.folder-order-name')).toHaveText(['生活', '未分组', '工作', '学习']);
    await folderOptions(page, '学习');
    await manager.getByRole('button', { name: '置顶分组「学习」', exact: true }).click();
    // The local unsaved ordinary order survives this immediate pin edit.
    await expect(manager.locator('.folder-order-name')).toHaveText(['生活', '学习', '未分组', '工作']);
    await manager.getByRole('button', { name: '拖动排序：学习', exact: true }).press('Home');
    await expect(manager.locator('.folder-order-name')).toHaveText(['学习', '生活', '未分组', '工作']);
    await manager.getByRole('button', { name: '保存', exact: true }).click();
    await expect(manager).toHaveCount(0);
    await expect(phoneNames).toHaveText(['学习', '生活', '未分组', '工作']);
    expect((await folders.read('owner')).assignments).toEqual([{ conversationId: chat.id, folderId: 'work' }]);
    await hub.close(); await expect(workspace(page).locator('.connection-pill.online')).toHaveCount(0);
    await heading('life').click({ button: 'right' });
    await expect(menu.getByRole('button', { name: '取消置顶', exact: true })).toBeDisabled();
  } finally { await context.close(); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const width of [390, 1360]) test(`unpin restores the ordinary position and preserves pending peer moves at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  const root = await mkdtemp(path.join(os.tmpdir(), 'folder-unpin-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  const folders = new ConversationFolders(hub.store.db);
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','助手','fixture')");
    const chat = await hub.store.createConversation('owner', ['bot'], '项目设计', 'chat');
    await folders.change('owner', { type: 'create', id: 'work', name: '工作', conversationId: chat.id, revision: 0 });
    await folders.change('owner', { type: 'create', id: 'life', name: '生活', revision: 1 });
    await folders.change('owner', { type: 'create', id: 'learn', name: '学习', revision: 2 });
    await pair(page, hub);
    if (width > 760) await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    const list = width > 760 ? sidebar(page) : mobileHome(page);
    const names = list.locator('.folder-heading .folder-name');
    const manager = dialog(page, '管理分组');
    await openFolderManager(page);
    await folderOptions(page, '学习');
    await manager.getByRole('button', { name: '置顶分组「学习」', exact: true }).click();
    await expect(manager.locator('.folder-order-name')).toHaveText(['学习', '工作', '生活', '未分组']);
    await manager.getByRole('button', { name: '关闭分组', exact: true }).click();
    await page.reload(); await expect(names).toHaveText(['学习', '工作', '生活', '未分组']);
    const heading = list.locator('[data-folder-id="learn"] .folder-heading');
    if (width > 760) await heading.click({ button: 'right' });
    else {
      await heading.dispatchEvent('pointerdown', { pointerId: 5, pointerType: 'touch', isPrimary: true, button: 0, clientX: 100, clientY: 200 });
      await expect(dialog(page, '分组操作')).toBeVisible();
      await heading.dispatchEvent('pointerup', { pointerId: 5, pointerType: 'touch', isPrimary: true, button: 0 });
    }
    const actions = width > 760 ? page.getByRole('menu', { name: '分组操作', exact: true }) : dialog(page, '分组操作');
    await actions.getByRole('button', { name: '取消置顶', exact: true }).click();
    await expect(actions).toHaveCount(0);
    await expect(names).toHaveText(['工作', '生活', '学习', '未分组']);
    await expect(list.locator('.conversation-folder[data-pinned=true]')).toHaveCount(0);
    await page.reload(); await expect(names).toHaveText(['工作', '生活', '学习', '未分组']);
    await page.screenshot({ path: info.outputPath(`unpin-restored-${width}.png`), animations: 'disabled' });
    await openFolderManager(page);
    await folderOptions(page, '生活');
    await manager.getByRole('button', { name: '置顶分组「生活」', exact: true }).click();
    await expect(manager.locator('.folder-order-name')).toHaveText(['生活', '工作', '学习', '未分组']);
    await manager.getByRole('button', { name: '拖动排序：学习', exact: true }).press('Home');
    await expect(manager.locator('.folder-order-name')).toHaveText(['生活', '学习', '工作', '未分组']);
    await manager.getByRole('button', { name: '取消置顶分组「生活」', exact: true }).click();
    // Restore Life's ordinary rank while retaining the unsaved Learning/Work swap.
    await expect(manager.locator('.folder-order-name')).toHaveText(['学习', '生活', '工作', '未分组']);
    await expect(manager.getByRole('img', { name: '已置顶', exact: true })).toHaveCount(0);
    await manager.getByRole('button', { name: '保存', exact: true }).click();
    await expect(manager).toHaveCount(0);
    await expect(names).toHaveText(['学习', '生活', '工作', '未分组']);
    await page.reload(); await expect(names).toHaveText(['学习', '生活', '工作', '未分组']);
    expect((await folders.read('owner')).assignments).toEqual([{ conversationId: chat.id, folderId: 'work' }]);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('folder pin gates older hosts and refreshes lost receipts without replaying changes', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'folder-pin-receipt-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  let legacy = true, patches = 0;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','助手','fixture')");
    await hub.store.createConversation('owner', ['bot'], '对话', 'chat');
    const folders = new ConversationFolders(hub.store.db);
    await folders.change('owner', { type: 'create', id: 'work', name: '工作', revision: 0 });
    await page.routeWebSocket('**/ws', socket => {
      const server = socket.connectToServer(); server.onMessage(message => {
        const frame = JSON.parse(String(message));
        if (legacy && frame.type === 'ready') frame.serverCapabilities = frame.serverCapabilities.filter((cap: string) => cap !== 'conversation-folders.pin.v1');
        socket.send(JSON.stringify(frame));
      });
    });
    await pair(page, hub); await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    const heading = sidebar(page).locator('[data-folder-id="work"] .folder-heading'), menu = page.getByRole('menu', { name: '分组操作', exact: true });
    await heading.click({ button: 'right' });
    await expect(menu.getByRole('button', { name: '置顶分组', exact: true })).toBeDisabled();
    await expect(menu).toContainText('此主机尚未支持置顶分组');
    legacy = false; await page.reload(); await waitForClientOnline(page);
    await page.route('**/api/conversation-folders', async route => {
      if (route.request().method() !== 'PATCH') { await route.continue(); return; }
      patches++; await route.fetch(); await route.abort('failed');
    });
    await heading.click({ button: 'right' });
    await menu.getByRole('button', { name: '置顶分组', exact: true }).click();
    await expect(menu.getByRole('alert')).toContainText('未能确认操作结果');
    await expect(menu.getByRole('button', { name: '取消置顶', exact: true })).toBeEnabled();
    expect(patches).toBe(1); expect((await folders.read('owner')).pinnedFolderIds).toEqual(['work']);
    await page.keyboard.press('Escape'); await page.reload();
    await expect(heading.getByRole('img', { name: '已置顶', exact: true })).toBeVisible();
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const width of [320, 390, 1360]) test(`one folder manager combines creation, editing, deletion and pending order at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  const root = await mkdtemp(path.join(os.tmpdir(), 'folder-manager-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  const folders = new ConversationFolders(hub.store.db);
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','助手','fixture')");
    const chat = await hub.store.createConversation('owner', ['bot'], '项目设计', 'chat');
    await folders.change('owner', { type: 'create', id: 'work', name: '工作', conversationId: chat.id, revision: 0 });
    await folders.change('owner', { type: 'create', id: 'life', name: '生活', revision: 1 });
    await pair(page, hub);
    if (width > 760) await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    if (width > 760) await expect(sidebar(page).getByRole('button', { name: '列表选项', exact: true })).toHaveCount(0);
    else await expect(mobileHome(page).getByRole('button', { name: '列表选项', exact: true })).toHaveCount(1);
    await openFolderManager(page);
    const manager = dialog(page, '管理分组');
    await expect(manager.getByRole('button', { name: '新建分组', exact: true })).toBeVisible();
    await folderOptions(page, '工作');
    await manager.getByRole('button', { name: '下移 工作', exact: true }).click();
    await expect(manager.locator('.folder-order-name')).toHaveText(['生活', '工作', '未分组']);
    expect((await folders.read('owner')).revision).toBe(2);
    await folderOptions(page, '工作');
    await manager.getByRole('button', { name: '重命名分组「工作」', exact: true }).click();
    await dialog(page, '重命名分组').getByLabel('分组名称').fill('项目');
    await dialog(page, '重命名分组').getByRole('button', { name: '保存', exact: true }).click();
    await expect(manager.locator('.folder-order-name')).toHaveText(['生活', '项目', '未分组']);
    await manager.getByRole('button', { name: '新建分组', exact: true }).click();
    await dialog(page, '新建分组').getByLabel('分组名称').fill('临时分组');
    await dialog(page, '新建分组').getByRole('button', { name: '保存', exact: true }).click();
    await expect(manager.locator('.folder-order-name')).toHaveText(['生活', '项目', '临时分组', '未分组']);
    await folderOptions(page, '临时分组');
    await manager.getByRole('button', { name: '删除分组「临时分组」', exact: true }).click();
    await dialog(page, '删除分组').getByRole('button', { name: '删除分组', exact: true }).click();
    await expect(manager.locator('.folder-order-name')).toHaveText(['生活', '项目', '未分组']);
    await expect(manager.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    await folderOptions(page, '未分组');
    await expect(manager.getByRole('button', { name: /(?:重命名|删除)分组「未分组」/ })).toHaveCount(0);
    await manager.getByRole('button', { name: '分组操作：未分组', exact: true }).click();
    await page.evaluate(async () => { await document.fonts.load('12px "Sarasa Term SC"'); await document.fonts.load('600 12px "Sarasa Term SC"'); });
    await page.mouse.move(2, 2);
    for (const palette of ['white-teal', 'cli']) for (const theme of ['light', 'dark']) {
      await page.evaluate(({ palette, theme }) => { document.documentElement.dataset.palette = palette; document.documentElement.dataset.theme = theme; }, { palette, theme });
      expect(await manager.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await manager.screenshot({ path: info.outputPath(`manager-${width}-${palette}-${theme}.png`), animations: 'disabled' });
    }
    await manager.getByRole('button', { name: '保存', exact: true }).click();
    await expect(manager).toHaveCount(0);
    expect((await folders.read('owner')).folders.map(folder => folder.name)).toEqual(['生活', '项目']);
    expect((await folders.read('owner')).assignments).toEqual([{ conversationId: chat.id, folderId: 'work' }]);
    await page.reload();
    await expect((width > 760 ? sidebar(page) : mobileHome(page)).locator('.folder-heading .folder-name')).toHaveText(['生活', '项目', '未分组']);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('a retried rename cannot rebase pending order over another device update', async ({ page, browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'folder-manager-conflict-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const phone = await context.newPage(), folders = new ConversationFolders(hub.store.db);
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','助手','fixture')");
    await hub.store.createConversation('owner', ['bot'], '对话', 'chat');
    await folders.change('owner', { type: 'create', id: 'work', name: '工作', revision: 0 });
    await pair(page, hub); await pair(phone, hub);
    await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    await openFolderManager(phone);
    const manager = dialog(phone, '管理分组');
    await manager.getByRole('button', { name: '拖动排序：未分组', exact: true }).press('Home');
    await folderOptions(phone, '工作');
    await manager.getByRole('button', { name: '重命名分组「工作」', exact: true }).click();
    const form = dialog(phone, '重命名分组');
    await form.getByLabel('分组名称').fill('项目');
    await createFolder(page, '其他设备创建');
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('分组已在其他设备更新');
    await form.getByRole('button', { name: '保存', exact: true }).click();
    await expect(manager.getByRole('status')).toContainText('分组已在其他设备更新');
    await expect(manager.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await manager.getByRole('button', { name: '载入最新顺序', exact: true }).click();
    await expect(manager.locator('.folder-order-name')).toHaveText(['项目', '其他设备创建', '未分组']);
    await expect(manager.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    expect((await folders.read('owner')).revision).toBe(3);
  } finally { await context.close(); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

async function dragFolder(page: Page, name: string, destination: string, touch: boolean, cancel = false) {
  const order = dialog(page, '管理分组'), list = order.locator('.folder-order-list');
  const handle = order.getByRole('button', { name: `拖动排序：${name}`, exact: true });
  await handle.click({ trial: true });
  const targetIndex = (await order.locator('.folder-order-name').allTextContents()).indexOf(destination);
  const a = (await handle.boundingBox())!, b = (await order.getByRole('button', { name: `拖动排序：${destination}`, exact: true }).boundingBox())!;
  const x = a.x + a.width / 2, y = a.y + a.height / 2, end = b.y + b.height / 2;
  if (touch && page.context().browser()!.browserType().name() === 'chromium') {
    const session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await expect(list).toHaveAttribute('data-dragging', 'true');
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: end }] });
    await expect(order.locator('.folder-order-name').nth(targetIndex)).toHaveText(name);
    await session.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
    await session.detach();
  } else {
    // Mouse input is trusted in both engines. WebKit has no touch-move driver.
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x, end, { steps: 8 });
    await expect(order.locator('.folder-order-name').nth(targetIndex)).toHaveText(name);
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
  }
  await expect(list).not.toHaveAttribute('data-dragging', 'true');
}

test('folder order supports phone touch, desktop mouse and keyboard, Unfiled, sync and reload', async ({ page, browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'folder-order-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  const phone = await context.newPage(), folders = new ConversationFolders(hub.store.db);
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','助手','fixture')");
    const chat = await hub.store.createConversation('owner', ['bot'], '项目设计', 'chat');
    await folders.change('owner', { type: 'create', id: 'work', name: '工作', conversationId: chat.id, revision: 0 });
    await folders.change('owner', { type: 'create', id: 'life', name: '生活', revision: 1 });
    await pair(page, hub); await pair(phone, hub);
    await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    await sidebar(page).locator(`[data-conversation-id="${chat.id}"]`).click();
    const composer = workspace(page).getByRole('textbox', { name: '消息', exact: true });
    await composer.fill('排序保留草稿');
    const desktopNames = sidebar(page).locator('.folder-heading .folder-name'), phoneNames = mobileHome(phone).locator('.folder-heading .folder-name');
    const phoneWork = mobileHome(phone).locator('[data-folder-id="work"] .folder-heading');
    await phoneWork.tap(); await expect(phoneWork).toHaveAttribute('aria-expanded', 'false');
    await openFolderManager(phone);
    const phoneOrder = dialog(phone, '管理分组');
    await expect(phoneOrder.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await dragFolder(phone, '未分组', '工作', true);
    await expect(phoneOrder.locator('.folder-order-name')).toHaveText(['未分组', '工作', '生活']);
    await expect(desktopNames).toHaveText(['工作', '生活', '未分组']);
    await phone.screenshot({ path: info.outputPath('phone-folder-order.png') });
    await phoneOrder.getByRole('button', { name: '保存', exact: true }).tap();
    await expect(phoneOrder).toHaveCount(0);
    await expect(desktopNames).toHaveText(['未分组', '工作', '生活']);
    await expect(phoneNames).toHaveText(['未分组', '工作', '生活']);
    await expect(phoneWork).toHaveAttribute('aria-expanded', 'false');
    await expect(composer).toHaveValue('排序保留草稿');
    await openFolderManager(page);
    const desktopOrder = dialog(page, '管理分组');
    await dragFolder(page, '生活', '未分组', false);
    await expect(desktopOrder.locator('.folder-order-name')).toHaveText(['生活', '未分组', '工作']);
    await page.screenshot({ path: info.outputPath('desktop-folder-order.png') });
    await desktopOrder.getByRole('button', { name: '保存', exact: true }).click();
    await expect(desktopOrder).toHaveCount(0);
    await expect(phoneNames).toHaveText(['生活', '未分组', '工作']);
    await openFolderManager(page);
    await desktopOrder.getByRole('button', { name: '拖动排序：工作', exact: true }).press('Home');
    await expect(desktopOrder.locator('.folder-order-name')).toHaveText(['工作', '生活', '未分组']);
    await desktopOrder.getByRole('button', { name: '保存', exact: true }).click();
    await expect(desktopOrder).toHaveCount(0);
    await phone.reload(); await page.reload();
    await expect(phoneNames).toHaveText(['工作', '生活', '未分组']);
    await expect(desktopNames).toHaveText(['工作', '生活', '未分组']);
    await expect(composer).toHaveValue('排序保留草稿');
    expect((await folders.read('owner')).assignments).toEqual([{ conversationId: chat.id, folderId: 'work' }]);
    // A cancelled gesture rolls back its draft; Cancel never writes to the Hub.
    await openFolderManager(phone);
    await dragFolder(phone, '未分组', '工作', true, true);
    await expect(phoneOrder.locator('.folder-order-name')).toHaveText(['工作', '生活', '未分组']);
    await expect(phoneOrder.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await folderOptions(phoneOrder.page(), '工作');
    await phoneOrder.getByRole('button', { name: '下移 工作', exact: true }).tap();
    await expect(phoneOrder.locator('.folder-order-name')).toHaveText(['生活', '工作', '未分组']);
    await phoneOrder.getByRole('button', { name: '取消', exact: true }).tap();
    await expect(phoneNames).toHaveText(['工作', '生活', '未分组']);
    expect((await folders.read('owner')).revision).toBe(5);
  } finally { await context.close(); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('move the whole 禅修 folder above 项目 from its phone and desktop heading', async ({ page, browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'folder-heading-order-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  const phone = await context.newPage(), folders = new ConversationFolders(hub.store.db);
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','助手','fixture')");
    const project = await hub.store.createConversation('owner', ['bot'], '项目内容', 'project');
    const zen = await hub.store.createConversation('owner', ['bot'], '禅修内容', 'zen');
    await folders.change('owner', { type: 'create', id: 'project', name: '项目', conversationId: project.id, revision: 0 });
    await folders.change('owner', { type: 'create', id: 'zen', name: '禅修', conversationId: zen.id, revision: 1 });
    const assignments = (await folders.read('owner')).assignments;
    await pair(page, hub); await pair(phone, hub);
    await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    await sidebar(page).locator(`[data-conversation-id="${project.id}"]`).click();
    const composer = workspace(page).getByRole('textbox', { name: '消息', exact: true });
    await composer.fill('项目草稿保留');
    const phoneNames = mobileHome(phone).locator('.folder-name'), desktopNames = sidebar(page).locator('.folder-name');
    await expect(phoneNames).toHaveText(['项目', '禅修', '未分组']);
    const heading = mobileHome(phone).locator('[data-folder-id="zen"] .folder-heading');
    const actions = dialog(phone, '分组操作');
    await heading.dispatchEvent('pointerdown', { pointerId: 5, pointerType: 'touch', isPrimary: true, button: 0, clientX: 100, clientY: 300 });
    await expect(actions).toBeVisible();
    await heading.dispatchEvent('pointerup', { pointerId: 5, pointerType: 'touch', isPrimary: true, button: 0 });
    await actions.screenshot({ path: info.outputPath('phone-folder-actions.png'), animations: 'disabled' });
    await actions.getByRole('button', { name: '上移一位', exact: true }).tap();
    await expect(actions).toHaveCount(0);
    await expect(phoneNames).toHaveText(['禅修', '项目', '未分组']);
    await expect(desktopNames).toHaveText(['禅修', '项目', '未分组']);
    await expect(heading).toHaveAttribute('aria-expanded', 'true');
    await expect(mobileHome(phone).locator('[data-folder-id="zen"] .mh-row')).toContainText('禅修内容');
    await phone.screenshot({ path: info.outputPath('phone-zen-above-project.png'), animations: 'disabled' });
    const desktopHeading = sidebar(page).locator('[data-folder-id="zen"] .folder-heading');
    const menu = page.getByRole('menu', { name: '分组操作', exact: true });
    await desktopHeading.click({ button: 'right' });
    await expect(menu.getByRole('button', { name: '上移一位', exact: true })).toBeDisabled();
    await menu.getByRole('button', { name: '下移一位', exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expect(phoneNames).toHaveText(['项目', '禅修', '未分组']);
    await desktopHeading.focus(); await desktopHeading.press('Shift+F10');
    await menu.getByRole('button', { name: '移到最上面', exact: true }).click();
    await expect(menu).toHaveCount(0); await expect(desktopHeading).toBeFocused();
    await expect(phoneNames).toHaveText(['禅修', '项目', '未分组']);
    await expect(composer).toHaveValue('项目草稿保留');
    expect((await folders.read('owner')).assignments).toEqual(assignments);
    await page.reload(); await phone.reload();
    await expect(phoneNames).toHaveText(['禅修', '项目', '未分组']);
    await expect(desktopNames).toHaveText(['禅修', '项目', '未分组']);
    await hub.close();
    await expect(workspace(page).locator('.connection-pill.online')).toHaveCount(0);
    await desktopHeading.click({ button: 'right' });
    await expect(menu.getByRole('button', { name: '下移一位', exact: true })).toBeDisabled();
    await expect(menu).toContainText('连接恢复后可调整分组顺序');
  } finally { await context.close(); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('folder ordering refuses stale edits, disables offline and gates older hosts', async ({ page, browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'folder-order-conflict-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const phone = await context.newPage();
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','助手','fixture')");
    await hub.store.createConversation('owner', ['bot'], '对话', 'chat');
    await new ConversationFolders(hub.store.db).change('owner', { type: 'create', id: 'work', name: '工作', revision: 0 });
    await pair(page, hub); await pair(phone, hub); await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    await openFolderManager(phone);
    const order = dialog(phone, '管理分组');
    await folderOptions(order.page(), '未分组');
    await order.getByRole('button', { name: '上移 未分组', exact: true }).click();
    await createFolder(page, '新分组');
    await expect(order.getByRole('status')).toContainText('分组已在其他设备更新');
    await expect(order.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await order.getByRole('button', { name: '载入最新顺序', exact: true }).click();
    await expect(order.locator('.folder-order-name')).toHaveText(['工作', '新分组', '未分组']);
    await folderOptions(order.page(), '未分组');
    await order.getByRole('button', { name: '上移 未分组', exact: true }).click();
    await order.getByRole('button', { name: '保存', exact: true }).click();
    await expect(order).toHaveCount(0);
    await expect(sidebar(page).locator('.folder-name')).toHaveText(['工作', '未分组', '新分组']);
    await page.routeWebSocket('**/ws', socket => {
      const server = socket.connectToServer();
      server.onMessage(message => {
        const frame = JSON.parse(String(message));
        if (frame.type === 'ready') frame.serverCapabilities = frame.serverCapabilities.filter((cap: string) => cap !== 'conversation-folders.reorder.v1');
        socket.send(JSON.stringify(frame));
      });
    });
    await page.reload(); await waitForClientOnline(page);
    await openFolderManager(page);
    await expect(dialog(page, '管理分组').getByRole('status')).toContainText('请更新运行 Bot 的电脑上的 TaroBird');
    await expect(dialog(page, '管理分组').getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await expect(dialog(page, '管理分组').getByRole('button', { name: '新建分组', exact: true })).toBeEnabled();
    await dialog(page, '管理分组').getByRole('button', { name: '取消', exact: true }).click();
    await openFolderManager(phone);
    await folderOptions(order.page(), '工作');
    await order.getByRole('button', { name: '下移 工作', exact: true }).click();
    await hub.close();
    await expect(order.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await expect(order.getByRole('button', { name: '拖动排序：工作', exact: true })).toBeDisabled();
    await order.getByRole('button', { name: '取消', exact: true }).click();
    await expect(mobileHome(phone).locator('.folder-name')).toHaveText(['工作', '未分组', '新分组']);
  } finally { await context.close(); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('long folder lists scroll while dragging and discard unsaved order on layout changes', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'folder-order-scroll-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  const folders = new ConversationFolders(hub.store.db);
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','助手','fixture')");
    await hub.store.createConversation('owner', ['bot'], '对话', 'chat');
    for (let i = 0; i < 18; i++) await folders.change('owner', { type: 'create', id: `folder_${i}`, name: `项目 ${i}`, revision: i });
    await pair(page, hub); await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    await openFolderManager(page);
    const order = dialog(page, '管理分组'), list = order.locator('.folder-order-list');
    const handle = order.getByRole('button', { name: '拖动排序：项目 0', exact: true });
    await handle.click({ trial: true });
    const a = (await handle.boundingBox())!, b = (await list.boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2, b.y + b.height - 8, { steps: 6 });
    await expect(order.locator('.folder-order-name').last()).toHaveText('项目 0');
    await page.mouse.up();
    await order.getByRole('button', { name: '保存', exact: true }).click();
    await expect(order).toHaveCount(0);
    expect((await folders.read('owner')).folders.at(-1)?.id).toBe('folder_0');
    expect((await folders.read('owner')).unfiledIndex).toBe(17);
    await openFolderManager(page);
    await folderOptions(order.page(), '项目 1');
    await order.getByRole('button', { name: '下移 项目 1', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(order).toHaveCount(0); await expect(page.locator('dialog:modal')).toHaveCount(0);
    await openMobileHome(page);
    await openFolderManager(page);
    await expect(order.locator('.folder-order-name').first()).toHaveText('项目 1');
    await expect(order.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    expect((await folders.read('owner')).revision).toBe(19);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('desktop moves chats from the visible header menu and the default Bot layout', async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'folder-desktop-entry-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','计划助手','fixture')");
    const chat = await hub.store.createConversation('owner', ['bot'], '项目设计', 'chat');
    const other = await hub.store.createConversation('owner', ['bot'], '周末计划', 'other');
    const group = await hub.store.createConversation('owner', ['bot'], '项目群聊', 'group', { type: 'group' });
    const topic = await hub.store.createConversation('owner', [], '设计评审', 'topic', { parentId: group.id });
    await pair(page, hub);
    await sidebar(page).locator(`[data-conversation-id="${chat.id}"]`).click();
    const composer = workspace(page).getByRole('textbox', { name: '消息', exact: true });
    await composer.fill('移动时保留这份草稿');
    const more = workspace(page).getByRole('button', { name: '更多聊天操作', exact: true });
    const headerMenu = page.getByRole('group', { name: '聊天操作', exact: true });
    // Ordinary click must expose the action, without knowing a right-click shortcut.
    await more.click();
    await expect(headerMenu.getByRole('button', { name: '移至分组', exact: true })).toBeVisible();
    await headerMenu.getByRole('button', { name: '移至分组', exact: true }).click();
    const move = dialog(page, '移至分组');
    await move.getByRole('button', { name: '新建分组', exact: true }).click();
    await move.getByLabel('分组名称').fill('工作');
    await move.getByRole('button', { name: '创建并移入', exact: true }).click();
    await expect(move).toHaveCount(0); await expect(more).toBeFocused();
    await expect(composer).toHaveValue('移动时保留这份草稿');
    const folders = new ConversationFolders(hub.store.db);
    const first = (await folders.read('owner')).folders[0]!;
    expect((await folders.read('owner')).assignments).toContainEqual({ conversationId: chat.id, folderId: first.id });
    // The default Bot tree can organize an unselected chat without navigating.
    await desktopMove(page, other.id, '工作');
    await expect(composer).toHaveValue('移动时保留这份草稿');
    await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    const filed = sidebar(page).locator(`[data-folder-id="${first.id}"]`);
    await expect(filed.locator('[data-conversation-id]')).toHaveCount(2);
    await createFolder(page, '新项目');
    await more.click();
    await headerMenu.getByRole('button', { name: '移至分组', exact: true }).click();
    await move.getByRole('button', { name: '新项目', exact: true }).click();
    await expect(move).toHaveCount(0);
    const second = (await folders.read('owner')).folders.find(f => f.name === '新项目')!;
    await expect(sidebar(page).locator(`[data-folder-id="${second.id}"] [data-conversation-id="${chat.id}"]`)).toBeVisible();
    await page.reload();
    await expect(sidebar(page).locator(`[data-folder-id="${second.id}"] [data-conversation-id="${chat.id}"]`)).toBeVisible();
    await expect(composer).toHaveValue('移动时保留这份草稿');
    await more.click(); await expect(headerMenu).toBeVisible();
    await page.screenshot({ path: info.outputPath('desktop-move-menu.png') });
    await headerMenu.getByRole('button', { name: '移至分组', exact: true }).click();
    await expect(move.getByRole('button', { name: '新项目', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await move.getByRole('button', { name: '关闭分组', exact: true }).click();
    await more.click(); await headerMenu.getByRole('button', { name: '移至分组', exact: true }).click();
    await expect(move).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(move).toHaveCount(0);
    await page.setViewportSize({ width: 1360, height: 900 });
    await expect(move).toHaveCount(0);
    // A topic follows its group; it must not gain a separate folder assignment.
    await sidebar(page).getByRole('button', { name: '按 Bot', exact: true }).click();
    await sidebar(page).locator(`[data-conversation-id="${topic.id}"]`).click();
    await more.click(); await expect(headerMenu.getByRole('button', { name: '移至分组', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await sidebar(page).locator(`[data-conversation-id="${group.id}"]`).click();
    await more.click(); await expect(headerMenu.getByRole('button', { name: '移至分组', exact: true })).toBeEnabled();
    await headerMenu.getByRole('button', { name: '移至分组', exact: true }).click();
    await move.getByRole('button', { name: '工作', exact: true }).click();
    await expect(move).toHaveCount(0);
    expect((await folders.read('owner')).assignments).toContainEqual({ conversationId: group.id, folderId: first.id });
    await hub.close(); await expect(workspace(page).locator('.connection-pill.online')).toHaveCount(0);
    await more.click(); await expect(headerMenu.getByRole('button', { name: '移至分组', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await sidebar(page).locator(`[data-conversation-id="${chat.id}"]`).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: '移至分组', exact: true })).toBeDisabled();
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('phone folder actions rename, synchronizes and preserves tap and scroll behavior', async ({ page, browser }, info) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'folder-hold-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  const phone = await context.newPage();
  const down = (target: Locator) => target.dispatchEvent('pointerdown', { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, clientX: 130, clientY: 270 });
  const up = (target: Locator) => target.dispatchEvent('pointerup', { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0 });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','计划助手','fixture')");
    for (let i = 0; i < 18; i++) await hub.store.createConversation('owner', ['bot'], `项目 ${i}`, `chat_${i}`);
    await pair(page, hub); await pair(phone, hub);
    await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    await createFolder(page, '工作');
    const header = mobileHome(phone).locator('.folder-heading').filter({ hasText: '工作' });
    const form = dialog(phone, '重命名分组'), actions = dialog(phone, '分组操作');
    await expect(header).toBeVisible();
    await header.tap(); await expect(header).toHaveAttribute('aria-expanded', 'false');
    await header.tap(); await expect(header).toHaveAttribute('aria-expanded', 'true');
    // Holding the name exposes moves and rename without navigating via Manage.
    if (browser.browserType().name() === 'chromium') {
      const cdp = await context.newCDPSession(phone), bounds = (await header.locator('.folder-name').boundingBox())!;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds.x + 20, y: bounds.y + bounds.height / 2 }] });
      await expect(actions).toBeVisible();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    } else {
      await down(header.locator('.folder-name')); await expect(actions).toBeVisible(); await up(header);
    }
    expect(await header.evaluate(el => getComputedStyle(el).userSelect)).toBe('none');
    // The editor intentionally selects its input; the held heading stays unselected.
    expect(await header.evaluate(el => el.contains(getSelection()?.anchorNode ?? null))).toBe(false);
    // Chromium delivers the real release click above; synthesize it only for
    // the WebKit PointerEvent path, which does not create compatibility clicks.
    if (browser.browserType().name() !== 'chromium') await header.dispatchEvent('click', { detail: 1 });
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await actions.getByRole('button', { name: '重命名分组', exact: true }).tap();
    await expect(form.getByLabel('分组名称')).toHaveValue('工作');
    await expect(form).toContainText('测试主机');
    await form.getByLabel('分组名称').fill('项目');
    await form.getByRole('button', { name: '保存', exact: true }).tap();
    await expect(form).toHaveCount(0);
    const renamed = mobileHome(phone).locator('.folder-heading').filter({ hasText: '项目' });
    await expect(renamed).toBeFocused();
    await expect(sidebar(page).locator('.folder-heading').filter({ hasText: '项目' })).toBeVisible();
    expect((await new ConversationFolders(hub.store.db).read('owner')).folders[0]?.name).toBe('项目');
    await phone.reload(); await expect(renamed).toBeVisible();
    for (const reason of ['move', 'release', 'cancel', 'scroll']) {
      await renamed.scrollIntoViewIfNeeded(); await down(renamed);
      if (reason === 'move') await renamed.dispatchEvent('pointermove', { pointerId: 7, pointerType: 'touch', clientX: 130, clientY: 320 });
      if (reason === 'release') await up(renamed);
      if (reason === 'cancel') await renamed.dispatchEvent('pointercancel', { pointerId: 7 });
      if (reason === 'scroll') await mobileHome(phone).locator('.mh-body').evaluate(el => { el.scrollTop += 60; el.dispatchEvent(new Event('scroll')); });
      await renamed.dispatchEvent('contextmenu', { button: 0 });
      await phone.waitForTimeout(620); await expect(actions, reason).toHaveCount(0); await up(renamed);
    }
    const unfiled = mobileHome(phone).locator('.folder-heading').filter({ hasText: '未分组' });
    await unfiled.scrollIntoViewIfNeeded(); await down(unfiled);
    await expect(actions).toBeVisible(); await up(unfiled);
    await expect(actions.getByRole('button', { name: '重命名分组', exact: true })).toHaveCount(0);
    await actions.getByRole('button', { name: '关闭分组', exact: true }).tap();
    await renamed.scrollIntoViewIfNeeded(); await down(renamed); await expect(actions).toBeVisible(); await up(renamed);
    await actions.getByRole('button', { name: '重命名分组', exact: true }).tap();
    await phone.screenshot({ path: info.outputPath('phone-folder-rename.png') });
    await form.getByRole('button', { name: '取消', exact: true }).tap();
    await expect(form).toHaveCount(0); await expect(dialog(phone, '管理分组')).toHaveCount(0);
    // The kept-alive inbox must not leave an inert modal or delayed timer behind.
    await down(renamed);
    await mobileHome(phone).getByRole('button', { name: '我的', exact: true }).tap();
    await phone.waitForTimeout(620); await expect(actions).toHaveCount(0);
    await mobileHome(phone).getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^消息/ }).tap();
    await down(renamed); await expect(actions).toBeVisible(); await up(renamed);
    await phone.setViewportSize({ width: 1360, height: 900 });
    await expect(actions).toHaveCount(0);
    await phone.setViewportSize({ width: 390, height: 844 });
    await expect(form).toHaveCount(0);
  } finally { await page.close(); await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

async function expectReadableFolderAction(button: Locator) {
  await expect(button).toBeVisible();
  // Theme and enabled-state changes animate both foreground and background.
  // A passing intermediate colour is not proof that the settled label is legible.
  await button.evaluate(async el => {
    await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => undefined)));
  });
  const contrast = () => button.evaluate(el => {
    const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
    const luminance = (color: number[]) => color.slice(0, 3).reduce((sum, value, i) => {
      const n = value / 255;
      return sum + (n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i]!;
    }, 0);
    const style = getComputedStyle(el), fg = luminance(rgb(style.color)), bg = luminance(rgb(style.backgroundColor));
    return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
  });
  // Disabled controls may fade as a whole, but their glyphs must still have
  // an inverse foreground rather than the same colour as the button fill.
  await expect.poll(contrast).toBeGreaterThanOrEqual(4.5);
}

for (const width of [390, 1360]) test(`folder save labels remain readable before and after typing in every palette (${width}px)`, async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width, height: 844 });
  const root = await mkdtemp(path.join(os.tmpdir(), 'folder-button-colors-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','计划助手','fixture')");
    await hub.store.createConversation('owner', ['bot'], '项目设计', 'chat');
    await pair(page, hub);
    if (width > 760) await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    await openFolderManager(page);
    await dialog(page, '管理分组').getByRole('button', { name: '新建分组', exact: true }).click();
    const form = dialog(page, '新建分组'), input = form.getByLabel('分组名称');
    const save = form.getByRole('button', { name: '保存', exact: true });
    await page.mouse.move(2, 2);
    const palettes = [...colorPalettes].sort((a, b) => Number(b.id === 'mono') - Number(a.id === 'mono'));
    for (const palette of palettes) for (const theme of ['light', 'dark']) {
      await page.evaluate(({ palette, theme }) => {
        document.documentElement.dataset.palette = palette;
        document.documentElement.dataset.theme = theme;
      }, { palette: palette.id, theme });
      await input.fill('');
      await expect(save).toBeDisabled();
      if (palette.id === 'mono') await form.screenshot({ path: info.outputPath(`${width}-${theme}-empty.png`) });
      await expectReadableFolderAction(save);
      await input.fill('工作');
      await expect(save).toBeEnabled();
      await expectReadableFolderAction(save);
      if (palette.id === 'mono') await form.screenshot({ path: info.outputPath(`${width}-${theme}-ready.png`) });
    }
    await save.click();
    await expect(form).toHaveCount(0);
    expect((await new ConversationFolders(hub.store.db).read('owner')).folders.map(f => f.name)).toEqual(['工作']);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('desktop and phone share folders, moves, rename and deletion without losing drafts or history', async ({ page, browser }, info) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'folder-devices-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  const phone = await context.newPage();
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','计划助手','fixture')");
    const chat = await hub.store.createConversation('owner', ['bot'], '项目设计', 'chat');
    const other = await hub.store.createConversation('owner', ['bot'], '周末计划', 'other');
    const group = await hub.store.createConversation('owner', ['bot'], '项目群聊', 'group', { type: 'group' });
    const topic = await hub.store.createConversation('owner', [], '设计评审', 'topic', { parentId: group.id });
    await pair(page, hub); await pair(phone, hub);
    await expect(sidebar(page).getByRole('button', { name: '新建分组', exact: true })).toHaveCount(0);
    await sidebar(page).locator(`[data-conversation-id="${chat.id}"]`).click();
    const composer = workspace(page).getByRole('textbox', { name: '消息', exact: true });
    await composer.fill('草稿要保留');
    await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    await createFolder(page, '工作');
    await expect(mobileHome(phone).getByRole('button', { name: /^工作/ })).toBeVisible();
    await desktopMove(page, chat.id, '工作');
    await desktopMove(page, group.id, '工作');
    const state = await new ConversationFolders(hub.store.db).read('owner');
    const folderId = state.folders[0]!.id;
    const desktopFolder = sidebar(page).locator(`[data-folder-id="${folderId}"]`);
    const phoneFolder = mobileHome(phone).locator(`[data-folder-id="${folderId}"]`);
    await expect(desktopFolder.locator('.conversation-row')).toHaveCount(2);
    await expect(phoneFolder.locator('.mh-row')).toHaveCount(2);
    await expect(composer).toHaveValue('草稿要保留');
    await expect(sidebar(page).locator(`[data-conversation-id="${chat.id}"]`)).toHaveAttribute('aria-current', 'page');
    // Group topics stay with their group; new activity and unread count survive folding.
    await hub.store.publishBotMessage('bot', { conversationId: topic.id, blocks: [{ type: 'text', text: '评审最新进度' }], status: 'complete' });
    await expect(phoneFolder).toContainText('评审最新进度');
    await phoneFolder.locator('.folder-heading').tap();
    await expect(phoneFolder.locator('.mh-row').first()).toBeHidden();
    await expect(phoneFolder.locator('.folder-heading .unread-badge')).toHaveText('1');
    // Filtering reveals matching rows even if their folder was folded.
    await mobileHome(phone).getByRole('button', { name: '搜索会话或 Bot', exact: true }).tap();
    await mobileHome(phone).getByRole('searchbox').fill('项目设计');
    await expect(phoneFolder.locator('.mh-row')).toBeVisible();
    await mobileHome(phone).getByRole('searchbox').fill('');
    await mobileHome(phone).getByRole('button', { name: '关闭搜索', exact: true }).first().tap();
    await phoneFolder.locator('.folder-heading').tap();
    // Phone long-press move updates the desktop immediately.
    const phoneRow = phoneFolder.locator(`[data-conversation-id="${chat.id}"]`);
    await phoneRow.dispatchEvent('pointerdown', { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, clientX: 130, clientY: 270 });
    await expect(dialog(phone, '对话操作')).toBeVisible();
    await phoneRow.dispatchEvent('pointerup', { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0 });
    await dialog(phone, '对话操作').getByRole('button', { name: '移至分组', exact: true }).tap();
    await dialog(phone, '移至分组').getByRole('button', { name: '未分组', exact: true }).tap();
    await expect(dialog(phone, '移至分组')).toHaveCount(0);
    await expect(desktopFolder.locator('.conversation-row')).toHaveCount(1);
    await expect(composer).toHaveValue('草稿要保留');
    // Rename from phone; duplicate names are rejected without losing the editor.
    await createFolder(phone, '生活');
    await openFolderManager(phone);
    await folderOptions(phone, '工作');
    await dialog(phone, '管理分组').getByRole('button', { name: '重命名分组「工作」', exact: true }).tap();
    await dialog(phone, '重命名分组').getByLabel('分组名称').fill('生活');
    await dialog(phone, '重命名分组').getByRole('button', { name: '保存', exact: true }).tap();
    await expect(dialog(phone, '重命名分组').getByRole('alert')).toContainText('已有同名分组');
    await dialog(phone, '重命名分组').getByLabel('分组名称').fill('项目');
    await dialog(phone, '重命名分组').getByRole('button', { name: '保存', exact: true }).tap();
    await expect(desktopFolder.locator('.folder-heading')).toContainText('项目');
    await dialog(phone, '管理分组').getByRole('button', { name: '关闭分组', exact: true }).tap();
    await page.screenshot({ path: info.outputPath('desktop-folders.png') });
    await phone.screenshot({ path: info.outputPath('phone-folders.png') });
    for (const palette of ['cli', 'pixel', 'white-teal']) {
      await phone.evaluate(p => { document.documentElement.dataset.palette = p; }, palette);
      await expect(phoneFolder).toBeVisible();
      expect(await mobileHome(phone).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await page.reload(); await expect(desktopFolder.locator('.folder-heading')).toContainText('项目');
    await expect(composer).toHaveValue('草稿要保留');
    await openFolderManager(page);
    await folderOptions(page, '项目');
    await dialog(page, '管理分组').getByRole('button', { name: '删除分组「项目」', exact: true }).click();
    await expect(dialog(page, '删除分组')).toContainText('聊天记录保留');
    await dialog(page, '删除分组').getByRole('button', { name: '删除分组', exact: true }).click();
    await dialog(page, '管理分组').getByRole('button', { name: '关闭分组', exact: true }).click();
    await expect(phoneFolder).toHaveCount(0);
    await expect(mobileHome(phone).locator('[data-folder-id=""] .mh-row')).toHaveCount(3);
    expect((await hub.store.conversations('owner')).filter(c => !c.archived)).toHaveLength(4);
    expect((await hub.store.snapshot('owner', topic.id)).messages).toHaveLength(1);
    await phone.reload(); await expect(mobileHome(phone).locator('.mh-row')).toHaveCount(3);
    await hub.close();
    await expect(workspace(phone).locator(".connection-pill.online")).toHaveCount(0);
    await openFolderManager(phone);
    await expect(dialog(phone, '管理分组').getByRole('button', { name: '新建分组', exact: true })).toBeDisabled();
    await dialog(phone, '管理分组').getByRole('button', { name: '关闭分组', exact: true }).tap();
    await expect(mobileHome(phone).locator('.folder-heading').filter({ hasText: '生活' })).toBeVisible();
    await expect(sidebar(page).locator(`[data-conversation-id="${other.id}"]`)).toBeVisible();
  } finally { await context.close(); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('restored Hub folder revisions replace stale cache and conflict refreshes recover editing', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'folder-restore-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','助手','fixture')");
    const chat = await hub.store.createConversation('owner', ['bot'], '恢复后继续对话', 'chat');
    const restored = { revision: 2, folders: [{ id: 'restored', name: '恢复的分组' }], assignments: [] };
    const replaceHub = (value: unknown) => hub.store.db.run("INSERT INTO meta(key,value) VALUES('conversation-folders:owner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(value)]);
    await replaceHub(restored);
    await pair(page, hub); await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    // Cache revision 5 belongs to the same trusted Hub before its backup restore.
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('tarocub-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try { await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('settings', 'readwrite');
        tx.objectStore('settings').put(JSON.stringify({ revision: 5, folders: [{ id: 'stale', name: '备份后才创建的旧缓存分组' }], assignments: [] }), 'conversationFolders');
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
      }); } finally { db.close(); }
    });
    await page.reload(); await waitForClientOnline(page);
    await expect(sidebar(page).locator('[data-folder-id="restored"]')).toBeVisible();
    await expect(sidebar(page).locator('[data-folder-id="stale"]')).toHaveCount(0);
    await desktopMove(page, chat.id, '恢复的分组');
    expect(await new ConversationFolders(hub.store.db).read('owner')).toMatchObject({ revision: 3, assignments: [{ conversationId: chat.id, folderId: 'restored' }] });
    // A fresh conflict GET can also establish a lower authoritative revision.
    await replaceHub(restored);
    await sidebar(page).locator(`[data-conversation-id="${chat.id}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '移至分组', exact: true }).click();
    await dialog(page, '移至分组').getByRole('button', { name: '未分组', exact: true }).click();
    await expect(dialog(page, '移至分组').getByRole('alert')).toContainText('分组已在其他设备更新');
    await expect(dialog(page, '移至分组').getByRole('button', { name: '未分组', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await dialog(page, '移至分组').getByRole('button', { name: '恢复的分组', exact: true }).click();
    await expect(dialog(page, '移至分组')).toHaveCount(0);
    expect((await new ConversationFolders(hub.store.db).read('owner')).revision).toBe(3);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('a late folder conflict refresh cannot roll back a newer socket update', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'folder-refresh-order-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  let socket: WebSocketRoute | undefined, release: (() => void) | undefined, captured = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.routeWebSocket('**/ws', ws => { socket = ws; ws.connectToServer(); });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','助手','fixture')");
    const chat = await hub.store.createConversation('owner', ['bot'], '并发更新对话', 'chat');
    const folders = (revision: number, name: string) => ({ revision, folders: [{ id: 'folder', name }], assignments: [] });
    const replaceHub = (value: unknown) => hub.store.db.run("INSERT INTO meta(key,value) VALUES('conversation-folders:owner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(value)]);
    await replaceHub(folders(1, '初始分组'));
    await pair(page, hub); await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    await replaceHub(folders(2, '请求开始时的分组'));
    await page.route('**/api/conversation-folders', async route => {
      if (route.request().method() !== 'GET') { await route.continue(); return; }
      const response = await route.fetch(); captured = true; await held; await route.fulfill({ response });
    });
    await sidebar(page).locator(`[data-conversation-id="${chat.id}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '移至分组', exact: true }).click();
    await dialog(page, '移至分组').getByRole('button', { name: '初始分组', exact: true }).click();
    await expect.poll(() => captured).toBe(true);
    await replaceHub(folders(3, '较新的分组'));
    socket!.send(JSON.stringify({ v: 1, type: 'conversation-folders.updated', folders: folders(3, '较新的分组') }));
    await expect(dialog(page, '移至分组').getByRole('button', { name: '较新的分组', exact: true })).toBeVisible();
    // Keep rejecting late snapshots within the same authenticated connection.
    socket!.send(JSON.stringify({ v: 1, type: 'conversation-folders.updated', folders: folders(2, '请求开始时的分组') }));
    release!();
    await expect(dialog(page, '移至分组').getByRole('alert')).toContainText('分组已在其他设备更新');
    await expect(dialog(page, '移至分组').getByRole('button', { name: '较新的分组', exact: true })).toBeVisible();
    await dialog(page, '移至分组').getByRole('button', { name: '较新的分组', exact: true }).click();
    await expect(dialog(page, '移至分组')).toHaveCount(0);
    expect(await new ConversationFolders(hub.store.db).read('owner')).toMatchObject({ revision: 4, folders: [{ id: 'folder', name: '较新的分组' }], assignments: [{ conversationId: chat.id, folderId: 'folder' }] });
  } finally { release?.(); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('folder moves with identical conversation IDs stay on their originating host', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'folder-hosts-'));
  const a = await HubServer.start({ stateDir: path.join(root, 'a'), clientDir: path.resolve('dist') });
  const b = await HubServer.start({ stateDir: path.join(root, 'b'), origins: [a.url] });
  try {
    for (const hub of [a, b]) {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','助手','fixture')");
      await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES('same','direct','同名对话','owner',1,'same')");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same','user','owner',0),('same','bot','bot',0)");
    }
    await pair(page, a, '主机 A'); await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    await createFolder(page, 'A 分组'); await desktopMove(page, 'same', 'A 分组');
    await pair(page, b, '主机 B', true);
    const hostB = sidebar(page).locator(`[data-host-id="${hostId(b)}"]`);
    await hostB.locator('[data-conversation-id="same"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '移至分组', exact: true }).click();
    await expect(dialog(page, '移至分组').getByRole('button', { name: 'A 分组', exact: true })).toHaveCount(0);
    await dialog(page, '移至分组').getByRole('button', { name: '新建分组', exact: true }).click();
    await dialog(page, '移至分组').getByLabel('分组名称').fill('B 分组');
    await dialog(page, '移至分组').getByRole('button', { name: '创建并移入', exact: true }).click();
    await expect(dialog(page, '移至分组')).toHaveCount(0);
    expect((await new ConversationFolders(a.store.db).read('owner')).folders[0]?.name).toBe('A 分组');
    expect((await new ConversationFolders(b.store.db).read('owner')).folders[0]?.name).toBe('B 分组');
    await expect(sidebar(page).locator('.host-heading')).toHaveCount(0);
    await expect(sidebar(page).locator('.conversation-row')).toHaveCount(2);
    await expect(sidebar(page).locator('.conversation-row .host-source-badge')).toHaveCount(0);
    await expect(sidebar(page).locator('.folder-heading').filter({ hasText: 'A 分组' }).getByLabel('运行于 主机 A', { exact: true })).toBeVisible();
    await expect(sidebar(page).locator('.folder-heading').filter({ hasText: 'B 分组' }).getByLabel('运行于 主机 B', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(mobileHome(page).locator('.mh-folder-host')).toHaveCount(2);
    await expect(mobileHome(page).locator('.mh-row')).toHaveCount(2);
  } finally { await page.close(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});

for (const width of [1360, 390]) test(`folder dialogs release modal state when notifications leave their host (${width}px)`, async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'folder-dialog-hosts-'));
  const a = await HubServer.start({ stateDir: path.join(root, 'a'), clientDir: path.resolve('dist') });
  const b = await HubServer.start({ stateDir: path.join(root, 'b'), origins: [a.url] });
  try {
    for (const hub of [a, b]) {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','助手','fixture')");
      await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES('same','direct','同名对话','owner',1,'same')");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same','user','owner',0),('same','bot','bot',0)");
    }
    await pair(page, a, '主机 A');
    await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    await createFolder(page, '已保存分组');
    await pair(page, b, '主机 B', true);
    await page.setViewportSize({ width, height: 844 });
    for (const entry of ['新建分组', '管理分组']) {
      await navigate(page, a); await openMobileHome(page);
      await openFolderManager(page, '主机 A');
      if (entry === '新建分组') await dialog(page, '管理分组').getByRole('button', { name: '新建分组', exact: true }).click();
      await expect(dialog(page, entry)).toBeVisible();
      if (entry === '新建分组') await dialog(page, entry).getByLabel('分组名称').fill('尚未保存');
      await navigate(page, b);
      await expect(page.locator('dialog:modal')).toHaveCount(0);
      // A hidden but still-open native dialog makes this visible composer inert.
      await workspace(page).getByRole('textbox', { name: '消息', exact: true }).fill('主机 B 仍可输入');
      await navigate(page, a);
      await expect(page.locator('dialog:modal')).toHaveCount(0);
    }
    if (width > 760) {
      await openFolderManager(page, '主机 A');
      await dialog(page, '管理分组').getByRole('button', { name: '新建分组', exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator('dialog:modal')).toHaveCount(0);
    } else {
      // A same-host notification also leaves the mounted phone inbox hidden.
      await openMobileHome(page);
      await openFolderManager(page, '主机 A');
      await dialog(page, '管理分组').getByRole('button', { name: '新建分组', exact: true }).click();
      await navigate(page, a);
      await expect(page.locator('dialog:modal')).toHaveCount(0);
      await workspace(page).getByRole('textbox', { name: '消息', exact: true }).fill('主机 A 仍可输入');
    }
    expect((await new ConversationFolders(a.store.db).read('owner')).folders.map(folder => folder.name)).toEqual(['已保存分组']);
    expect((await new ConversationFolders(b.store.db).read('owner')).folders).toEqual([]);
  } finally { await page.close(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});
