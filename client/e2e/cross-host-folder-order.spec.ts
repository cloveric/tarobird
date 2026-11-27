import { test, expect, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HOST_PROFILE_KEY } from '../../src/hub/host-profile.js';
import { HubServer } from '../../src/hub/server.js';
import { ConversationFolders } from '../../src/hub/conversation-folders.js';
import { clickAppAction } from './fixtures/desktop-actions.js';
import {
  mobileHome,
  openFolderManager,
  openMobileHome,
  openMobileSearch,
  setListOption,
  showDisconnectedBots,
  waitForClientOnline,
} from './fixtures/mobile.js';
import { preparePairing } from './fixtures/pairing-invite.js';

test.use({ serviceWorkers: 'block' });

const workspace = (page: Page) => page.locator('.host-workspace:not([hidden])');
const sidebar = (page: Page) => workspace(page).locator('.sidebar');
const dialog = (page: Page, name: string) => page.getByRole('dialog', { name, exact: true });
const hostId = (hub: HubServer) => `hub_${createHash('sha256').update(Buffer.from(hub.auth.publicKey, 'base64')).digest('hex')}`;
const shotsDir = process.env.CROSS_HOST_FOLDER_SHOTS_DIR;

async function saveShot(target: Page | Locator, outputPath: string, name: string, options: { clip?: { x: number; y: number; width: number; height: number } } = {}) {
  await target.screenshot({ path: outputPath, animations: 'disabled', ...options });
  if (shotsDir) {
    await mkdir(shotsDir, { recursive: true });
    await target.screenshot({ path: path.join(shotsDir, name), animations: 'disabled', ...options });
  }
}

async function pair(page: Page, hub: HubServer, name: string, add = false) {
  await hub.store.db.run(
    'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [HOST_PROFILE_KEY, JSON.stringify({ name, revision: 1 })],
  );
  if (add) await clickAppAction(page, '连接另一台主机', workspace(page).getByRole('button', { name: '连接另一台主机', exact: true }));
  else await page.goto(hub.url);
  await page.getByLabel('主机名称', { exact: true }).fill(name);
  await page.getByLabel('Hub 地址', { exact: true }).fill(hub.url);
  await preparePairing(page, hub);
  await page.getByRole('button', { name: '配对此设备', exact: true }).click();
  await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
  await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
  await waitForClientOnline(page);
}

async function folderSequence(root: Locator): Promise<string[]> {
  return root.locator('.folder-heading').evaluateAll(nodes => nodes.map(node => {
    const name = node.querySelector('.folder-name')?.textContent?.trim() ?? '';
    const host = node.querySelector('.host-source-badge')?.textContent?.trim() ?? '';
    return host ? `${host}/${name}` : name;
  }));
}

async function managerSequence(manager: Locator): Promise<string[]> {
  return manager.locator('.folder-order-list > li').evaluateAll(nodes => nodes.map(node => {
    const name = node.querySelector('.folder-order-name')?.textContent?.trim() ?? '';
    const host = node.querySelector('.host-source-badge')?.textContent?.trim() ?? '';
    return host ? `${host}/${name}` : name;
  }));
}

async function dragCrossHostRow(page: Page, sourceLabel: string, destLabel: string, touch: boolean, cancel = false) {
  const manager = dialog(page, '管理分组');
  const list = manager.locator('.folder-order-list');
  const handle = manager.getByRole('button', { name: `拖动排序：${sourceLabel}`, exact: true });
  const dest = manager.getByRole('button', { name: `拖动排序：${destLabel}`, exact: true });
  await handle.click({ trial: true });
  const a = (await handle.boundingBox())!;
  const b = (await dest.boundingBox())!;
  const x = a.x + a.width / 2;
  const startY = a.y + a.height / 2;
  const endY = b.y + b.height / 2;
  if (touch && page.context().browser()!.browserType().name() === 'chromium') {
    const session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] });
    await expect(list).toHaveAttribute('data-dragging', 'true');
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: endY }] });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await session.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
    await session.detach();
  } else {
    await page.mouse.move(x, startY);
    await page.mouse.down();
    await page.mouse.move(x, endY, { steps: 10 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
  }
  await expect(list).not.toHaveAttribute('data-dragging', 'true');
}

test('combined sidebar and manager share local order when only one registered host is ready', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cross-host-folder-one-ready-'));
  const a = await HubServer.start({ stateDir: path.join(root, 'a'), clientDir: path.resolve('dist') });
  const b = await HubServer.start({ stateDir: path.join(root, 'b'), origins: [a.url] });
  try {
    await a.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('bot','助手','fixture',1)");
    const chat = await a.store.createConversation('owner', ['bot'], '分组对话', 'chat');
    const folders = new ConversationFolders(a.store.db);
    await folders.change('owner', { type: 'create', id: 'f1', name: '分组 1', conversationId: chat.id, revision: 0 });
    await folders.change('owner', { type: 'create', id: 'f2', name: '分组 2', revision: 1 });
    const original = await folders.read('owner');
    await pair(page, a, '主机 A');
    await pair(page, b, '主机 B', true);
    await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    await sidebar(page).locator(`[data-host-id="${hostId(a)}"] [data-conversation-id="${chat.id}"]`).click();

    // An interrupted removal is registered but has no connection/directory.
    // Ordinary offline hosts retain their directory and do not exercise this case.
    await page.evaluate(async id => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('tarocub-hosts-v1');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('hosts', 'readwrite'), store = tx.objectStore('hosts'), request = store.get(id);
          request.onsuccess = () => store.put({ ...request.result, state: 'removing' });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } finally { db.close(); }
    }, hostId(b));
    await page.reload();
    await waitForClientOnline(page);
    await expect(sidebar(page).getByRole('button', { name: '主机 B · 等待完成移除', exact: true })).toBeVisible();

    await sidebar(page).locator('[data-folder-id="f2"] .folder-heading').click({ button: 'right' });
    await page.getByRole('menu', { name: '分组操作', exact: true }).getByRole('button', { name: '移到最上面', exact: true }).click();
    await expect.poll(() => folderSequence(sidebar(page))).toEqual(['主机 A/分组 2', '主机 A/分组 1', '主机 A/未分组']);
    await openFolderManager(page);
    const manager = dialog(page, '管理分组');
    await expect.poll(() => managerSequence(manager)).toEqual(['主机 A/分组 2', '主机 A/分组 1', '主机 A/未分组']);
    await manager.getByRole('button', { name: '拖动排序：分组 1（主机 A）', exact: true }).press('Home');
    await manager.getByRole('button', { name: '保存', exact: true }).click();
    await expect(manager).toHaveCount(0);
    await expect.poll(() => folderSequence(sidebar(page))).toEqual(['主机 A/分组 1', '主机 A/分组 2', '主机 A/未分组']);
    expect(await folders.read('owner')).toEqual(original);

    // An explicit single-host filter still edits that host's canonical order.
    await sidebar(page).getByRole('combobox', { name: '筛选运行主机' }).selectOption(hostId(a));
    await openFolderManager(page);
    await manager.getByRole('button', { name: '拖动排序：分组 2', exact: true }).press('Home');
    await manager.getByRole('button', { name: '保存', exact: true }).click();
    await expect(manager).toHaveCount(0);
    await expect.poll(async () => (await folders.read('owner')).revision).toBe(original.revision + 1);
    await expect.poll(() => folderSequence(sidebar(page))).toEqual(['分组 2', '分组 1', '未分组']);
  } finally {
    await page.close();
    await a.close();
    await b.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop and phone interleave cross-host folders via actions and manager, persist across reload, and keep host ownership intact', async ({ page, browser }, info) => {
  test.setTimeout(150_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'cross-host-folder-order-'));
  const a = await HubServer.start({ stateDir: path.join(root, 'a'), clientDir: path.resolve('dist') });
  const b = await HubServer.start({ stateDir: path.join(root, 'b'), origins: [a.url] });
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  const phone = await phoneCtx.newPage();
  try {
    await a.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('bot_a','规划助手','fixture',1)");
    await b.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('bot_b','运维助手','fixture',1)");
    const a1 = await a.store.createConversation('owner', ['bot_a'], '需求评审', 'a1');
    const a2 = await a.store.createConversation('owner', ['bot_a'], '日常记录', 'a2');
    await a.store.createConversation('owner', ['bot_a'], '待整理草稿', 'a3');
    const b1 = await b.store.createConversation('owner', ['bot_b'], '发布清单', 'b1');
    await b.store.createConversation('owner', ['bot_b'], '远程备忘', 'b2');

    const foldersA = new ConversationFolders(a.store.db);
    const foldersB = new ConversationFolders(b.store.db);
    await foldersA.change('owner', { type: 'create', id: 'f1', name: '分组 1', conversationId: a1.id, revision: 0 });
    await foldersA.change('owner', { type: 'create', id: 'f2', name: '分组 2', conversationId: a2.id, revision: 1 });
    await foldersB.change('owner', { type: 'create', id: 'f3', name: '分组 3', conversationId: b1.id, revision: 0 });

    await pair(page, a, '主机 A');
    await pair(page, b, '主机 B', true);
    await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();

    await expect.poll(() => folderSequence(sidebar(page))).toEqual([
      '主机 A/分组 1',
      '主机 A/分组 2',
      '主机 A/未分组',
      '主机 B/分组 3',
      '主机 B/未分组',
    ]);

    // Select a Host A chat, type a draft, create unread on Host B, and collapse Host A's 分组 2.
    await sidebar(page).locator(`[data-host-id="${hostId(a)}"] [data-conversation-id="${a1.id}"]`).click();
    const composer = workspace(page).getByRole('textbox', { name: '消息', exact: true });
    await composer.fill('跨主机排序保留草稿');
    await b.store.publishBotMessage('bot_b', { conversationId: b1.id, blocks: [{ type: 'text', text: '远端检查已完成' }], status: 'complete' });
    const folderA2 = sidebar(page).locator(`[data-host-id="${hostId(a)}"] [data-folder-id="f2"] .folder-heading`);
    await folderA2.click();
    await expect(folderA2).toHaveAttribute('aria-expanded', 'false');

    // Desktop heading menu: move 主机 B / 分组 3 to top, then down one step to interleave.
    const folderB3 = () => sidebar(page).locator(`[data-host-id="${hostId(b)}"] [data-folder-id="f3"] .folder-heading`);
    const menu = page.getByRole('menu', { name: '分组操作', exact: true });
    await folderB3().click({ button: 'right' });
    await expect(menu.getByLabel('运行于 主机 B', { exact: true })).toBeVisible();
    await menu.getByRole('button', { name: '移到最上面', exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expect.poll(() => folderSequence(sidebar(page))).toEqual([
      '主机 B/分组 3',
      '主机 A/分组 1',
      '主机 A/分组 2',
      '主机 A/未分组',
      '主机 B/未分组',
    ]);

    await folderB3().focus();
    await page.keyboard.press('Shift+F10');
    await menu.getByRole('button', { name: '下移一位', exact: true }).click();
    await expect.poll(() => folderSequence(sidebar(page))).toEqual([
      '主机 A/分组 1',
      '主机 B/分组 3',
      '主机 A/分组 2',
      '主机 A/未分组',
      '主机 B/未分组',
    ]);

    // Selection, draft, collapse state, and unread badge stay intact.
    await expect(sidebar(page).locator(`[data-host-id="${hostId(a)}"] [data-conversation-id="${a1.id}"]`)).toHaveAttribute('aria-current', 'page');
    await expect(composer).toHaveValue('跨主机排序保留草稿');
    await expect(folderA2).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebar(page).locator(`[data-host-id="${hostId(b)}"] [data-conversation-id="${b1.id}"] .unread-badge`)).toHaveText('1');

    // Capture synthetic desktop interleaved sidebar screenshot.
    await saveShot(page, info.outputPath('desktop-combined-interleaved.png'), 'desktop-combined-interleaved.png', {
      clip: { x: 0, y: 0, width: 320, height: 780 },
    });

    // Desktop Manage folders: drag Host B / 分组 3 to the top, save, and verify reload persistence.
    await openFolderManager(page);
    const manager = dialog(page, '管理分组');
    await expect.poll(() => managerSequence(manager)).toEqual([
      '主机 A/分组 1',
      '主机 B/分组 3',
      '主机 A/分组 2',
      '主机 A/未分组',
      '主机 B/未分组',
    ]);
    await dragCrossHostRow(page, '分组 3（主机 B）', '分组 1（主机 A）', false);
    await expect.poll(() => managerSequence(manager)).toEqual([
      '主机 B/分组 3',
      '主机 A/分组 1',
      '主机 A/分组 2',
      '主机 A/未分组',
      '主机 B/未分组',
    ]);
    await saveShot(manager, info.outputPath('desktop-folder-manager.png'), 'desktop-folder-manager.png');
    await manager.getByRole('button', { name: '保存', exact: true }).click();
    await expect(manager).toHaveCount(0);
    await expect.poll(() => folderSequence(sidebar(page))).toEqual([
      '主机 B/分组 3',
      '主机 A/分组 1',
      '主机 A/分组 2',
      '主机 A/未分组',
      '主机 B/未分组',
    ]);

    // Keyboard reorder + cancel must leave saved order untouched.
    await openFolderManager(page);
    await manager.getByRole('button', { name: '拖动排序：分组 1（主机 A）', exact: true }).press('Home');
    await expect.poll(() => managerSequence(manager)).toEqual([
      '主机 A/分组 1',
      '主机 B/分组 3',
      '主机 A/分组 2',
      '主机 A/未分组',
      '主机 B/未分组',
    ]);
    await manager.getByRole('button', { name: '取消', exact: true }).click();
    await expect.poll(() => folderSequence(sidebar(page))).toEqual([
      '主机 B/分组 3',
      '主机 A/分组 1',
      '主机 A/分组 2',
      '主机 A/未分组',
      '主机 B/未分组',
    ]);

    // Reload desktop: cross-host order, draft, and collapse survive.
    await page.reload();
    await waitForClientOnline(page);
    await expect.poll(() => folderSequence(sidebar(page))).toEqual([
      '主机 B/分组 3',
      '主机 A/分组 1',
      '主机 A/分组 2',
      '主机 A/未分组',
      '主机 B/未分组',
    ]);
    await expect(composer).toHaveValue('跨主机排序保留草稿');
    await expect(folderA2).toHaveAttribute('aria-expanded', 'false');

    // Clicking and sending in Host B's reordered folder routes strictly to Host B (zero migration).
    await sidebar(page).locator(`[data-host-id="${hostId(b)}"] [data-conversation-id="${b1.id}"]`).click();
    await expect(workspace(page)).toHaveAttribute('data-active-host', hostId(b));
    await workspace(page).getByRole('textbox', { name: '消息', exact: true }).fill('仅发往主机 B');
    await workspace(page).getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(async () => (await b.store.snapshot('owner', b1.id)).messages.some(m => m.blocks.some(block => block.type === 'text' && block.text === '仅发往主机 B'))).toBe(true);
    expect((await a.store.conversations('owner')).map(c => c.id).sort()).toEqual([a1.id, a2.id, (await a.store.conversations('owner')).find(c => c.title === '待整理草稿')!.id].sort());
    expect((await foldersA.read('owner')).folders.map(f => f.id)).toEqual(['f1', 'f2']);
    expect((await foldersB.read('owner')).folders.map(f => f.id)).toEqual(['f3']);

    // Independent phone device receives Desktop's synced cross-host order and syncs changes back.
    await phone.setViewportSize({ width: 1360, height: 900 });
    await pair(phone, a, '主机 A');
    await pair(phone, b, '主机 B', true);
    await phone.setViewportSize({ width: 390, height: 844 });
    await openMobileHome(phone);
    const home = mobileHome(phone);
    await expect.poll(() => folderSequence(home)).toEqual([
      '主机 B/分组 3',
      '主机 A/分组 1',
      '主机 A/分组 2',
      '主机 A/未分组',
      '主机 B/未分组',
    ]);

    // Phone long-press on 主机 A / 分组 2 -> 移到最上面 (syncs live to desktop).
    const phoneA2 = home.locator(`[data-folder-host="${hostId(a)}"] [data-folder-id="f2"] .folder-heading`);
    const actions = dialog(phone, '分组操作');
    await phoneA2.dispatchEvent('pointerdown', { pointerId: 9, pointerType: 'touch', isPrimary: true, button: 0, clientX: 120, clientY: 320 });
    await expect(actions).toBeVisible();
    await phoneA2.dispatchEvent('pointerup', { pointerId: 9, pointerType: 'touch', isPrimary: true, button: 0 });
    await actions.getByRole('button', { name: '移到最上面', exact: true }).tap();
    await expect(actions).toHaveCount(0);
    await expect.poll(() => folderSequence(home)).toEqual([
      '主机 A/分组 2',
      '主机 B/分组 3',
      '主机 A/分组 1',
      '主机 A/未分组',
      '主机 B/未分组',
    ]);
    await expect.poll(() => folderSequence(sidebar(page))).toEqual([
      '主机 A/分组 2',
      '主机 B/分组 3',
      '主机 A/分组 1',
      '主机 A/未分组',
      '主机 B/未分组',
    ]);

    // Phone Manage folders: touch-drag to interleave, verify Back protects unsaved changes, then save.
    await openFolderManager(phone);
    const phoneManager = dialog(phone, '管理分组');
    await dragCrossHostRow(phone, '分组 1（主机 A）', '分组 2（主机 A）', true);
    await expect.poll(() => managerSequence(phoneManager)).toEqual([
      '主机 A/分组 1',
      '主机 A/分组 2',
      '主机 B/分组 3',
      '主机 A/未分组',
      '主机 B/未分组',
    ]);
    await phoneManager.getByRole('button', { name: '关闭分组', exact: true }).tap();
    const confirmDiscard = dialog(phone, '放弃未保存的修改？');
    await expect(confirmDiscard).toBeVisible();
    await confirmDiscard.getByRole('button', { name: '继续编辑', exact: true }).tap();
    await expect(confirmDiscard).toHaveCount(0);
    await expect.poll(() => managerSequence(phoneManager)).toEqual([
      '主机 A/分组 1',
      '主机 A/分组 2',
      '主机 B/分组 3',
      '主机 A/未分组',
      '主机 B/未分组',
    ]);
    await saveShot(phone, info.outputPath('phone-folder-manager.png'), 'phone-folder-manager.png');
    await phoneManager.getByRole('button', { name: '保存', exact: true }).tap();
    await expect(phoneManager).toHaveCount(0);
    await expect.poll(() => folderSequence(home)).toEqual([
      '主机 A/分组 1',
      '主机 A/分组 2',
      '主机 B/分组 3',
      '主机 A/未分组',
      '主机 B/未分组',
    ]);
    await expect.poll(() => folderSequence(sidebar(page))).toEqual([
      '主机 A/分组 1',
      '主机 A/分组 2',
      '主机 B/分组 3',
      '主机 A/未分组',
      '主机 B/未分组',
    ]);
    await saveShot(phone, info.outputPath('phone-combined-interleaved.png'), 'phone-combined-interleaved.png');

    await phone.reload();
    await waitForClientOnline(phone);
    await openMobileHome(phone);
    await expect.poll(() => folderSequence(home)).toEqual([
      '主机 A/分组 1',
      '主机 A/分组 2',
      '主机 B/分组 3',
      '主机 A/未分组',
      '主机 B/未分组',
    ]);
  } finally {
    await phoneCtx.close();
    await page.close();
    await a.close();
    await b.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('same folder ID/name across hosts, host/folder renames, folder pins, global pins, grouping, filters and search stay compatible', async ({ page }) => {
  test.setTimeout(150_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'cross-host-folder-compat-'));
  const a = await HubServer.start({ stateDir: path.join(root, 'a'), clientDir: path.resolve('dist') });
  const b = await HubServer.start({ stateDir: path.join(root, 'b'), origins: [a.url] });
  try {
    for (const [hub, noteTitle] of [[a, '甲备忘'], [b, '乙备忘']] as const) {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('bot','助手','fixture',1)");
      await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES('same','direct','同名对话','owner',20,'same')");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same','user','owner',0),('same','bot','bot',0)");
      await hub.store.createConversation('owner', ['bot'], noteTitle, 'note');
      await new ConversationFolders(hub.store.db).change('owner', { type: 'create', id: 'work', name: '工作', conversationId: 'same', revision: 0 });
    }
    await pair(page, a, '主机甲');
    await pair(page, b, '主机乙', true);
    await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();

    // Move 主机乙/工作 above 主机甲/工作 (both have bare id "work" and name "工作").
    const menu = page.getByRole('menu', { name: '分组操作', exact: true });
    await sidebar(page).locator(`[data-host-id="${hostId(b)}"] [data-folder-id="work"] .folder-heading`).click({ button: 'right' });
    await menu.getByRole('button', { name: '移到最上面', exact: true }).click();
    await expect.poll(() => folderSequence(sidebar(page))).toEqual([
      '主机乙/工作',
      '主机甲/工作',
      '主机甲/未分组',
      '主机乙/未分组',
    ]);

    // Rename Host B (profile) AND Host B's "work" folder -> order stays keyed by [hubPublicKey, folderId]!
    await b.profile.update({ name: '新主机乙', revision: (await b.profile.read()).revision });
    await sidebar(page).locator(`[data-host-id="${hostId(b)}"] [data-folder-id="work"] .folder-heading`).click({ button: 'right' });
    await menu.getByRole('button', { name: '重命名分组', exact: true }).click();
    const rename = dialog(page, '重命名分组');
    await rename.getByLabel('分组名称').fill('核心工作');
    await rename.getByRole('button', { name: '保存', exact: true }).click();
    await expect(rename).toHaveCount(0);
    await page.reload();
    await waitForClientOnline(page);
    await expect.poll(() => folderSequence(sidebar(page))).toEqual([
      '新主机乙/核心工作',
      '主机甲/工作',
      '主机甲/未分组',
      '新主机乙/未分组',
    ]);
    expect((await new ConversationFolders(a.store.db).read('owner')).folders[0]?.name).toBe('工作');

    // Pin Host A's 工作 -> jumps above 新主机乙/核心工作; pin 新主机乙/核心工作 -> prepends in pinned tier.
    await sidebar(page).locator(`[data-host-id="${hostId(a)}"] [data-folder-id="work"] .folder-heading`).click({ button: 'right' });
    await menu.getByRole('button', { name: '置顶分组', exact: true }).click();
    await expect.poll(() => folderSequence(sidebar(page))).toEqual([
      '主机甲/工作',
      '新主机乙/核心工作',
      '主机甲/未分组',
      '新主机乙/未分组',
    ]);
    await sidebar(page).locator(`[data-host-id="${hostId(b)}"] [data-folder-id="work"] .folder-heading`).click({ button: 'right' });
    await menu.getByRole('button', { name: '置顶分组', exact: true }).click();
    await expect.poll(() => folderSequence(sidebar(page))).toEqual([
      '新主机乙/核心工作',
      '主机甲/工作',
      '主机甲/未分组',
      '新主机乙/未分组',
    ]);

    // Ordinary folder cannot cross above pinned tier.
    await sidebar(page).locator(`[data-host-id="${hostId(b)}"] [data-folder-id=""] .folder-heading`).click({ button: 'right' });
    await menu.getByRole('button', { name: '移到同类分组最上面', exact: true }).click();
    await expect.poll(() => folderSequence(sidebar(page))).toEqual([
      '新主机乙/核心工作',
      '主机甲/工作',
      '新主机乙/未分组',
      '主机甲/未分组',
    ]);

    // Unpin 新主机乙/核心工作 -> returns to its saved ordinary top slot!
    await sidebar(page).locator(`[data-host-id="${hostId(b)}"] [data-folder-id="work"] .folder-heading`).click({ button: 'right' });
    await menu.getByRole('button', { name: '取消置顶', exact: true }).click();
    await expect.poll(() => folderSequence(sidebar(page))).toEqual([
      '主机甲/工作',
      '新主机乙/核心工作',
      '新主机乙/未分组',
      '主机甲/未分组',
    ]);

    // Global conversation pin sits ABOVE every folder section.
    await sidebar(page).locator(`[data-host-id="${hostId(b)}"] [data-conversation-id="same"]`).click({ button: 'right' });
    await page.getByRole('menu', { name: '对话操作', exact: true }).getByRole('menuitem', { name: '全局置顶', exact: true }).click();
    const globalSection = sidebar(page).getByRole('region', { name: '已全局置顶', exact: true });
    await expect(globalSection.locator(`[data-host-id="${hostId(b)}"] [data-conversation-id="same"]`)).toBeVisible();
    await expect.poll(() => sidebar(page).evaluate(root => {
      const global = root.querySelector('.global-pin-section');
      const firstFolder = root.querySelector('.conversation-folder');
      return !!global && !!firstFolder && !!(global.compareDocumentPosition(firstFolder) & Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBe(true);

    // Group-by-host uses per-host blocks; toggling back off restores the cross-host order.
    await setListOption(page, '按主机分组', true);
    await expect(sidebar(page).locator('.host-heading')).toHaveCount(2);
    await setListOption(page, '按主机分组', false);
    await expect.poll(() => folderSequence(sidebar(page))).toEqual([
      '主机甲/工作',
      '新主机乙/核心工作',
      '新主机乙/未分组',
      '主机甲/未分组',
    ]);

    // Desktop host filter temporarily hides Host B without deleting its saved order.
    const hostFilter = sidebar(page).getByRole('combobox', { name: '筛选运行主机' });
    await hostFilter.selectOption(hostId(a));
    await expect.poll(() => folderSequence(sidebar(page))).toEqual(['工作', '未分组']);
    await hostFilter.selectOption('');
    await expect.poll(() => folderSequence(sidebar(page))).toEqual([
      '主机甲/工作',
      '新主机乙/核心工作',
      '新主机乙/未分组',
      '主机甲/未分组',
    ]);

    // Mobile search filters folders in cross-host order without losing hidden folders.
    await page.setViewportSize({ width: 390, height: 844 });
    await openMobileHome(page);
    await openMobileSearch(page);
    await mobileHome(page).getByRole('searchbox', { name: '查找会话或 Bot', exact: true }).fill('乙备忘');
    await expect.poll(() => folderSequence(mobileHome(page))).toEqual(['新主机乙/未分组']);
    await mobileHome(page).getByRole('button', { name: '关闭搜索', exact: true }).click();
    await expect.poll(() => folderSequence(mobileHome(page))).toEqual([
      '主机甲/工作',
      '新主机乙/核心工作',
      '新主机乙/未分组',
      '主机甲/未分组',
    ]);
  } finally {
    await page.close();
    await a.close();
    await b.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('offline/reconnect, folder creation/deletion, and host removal merge stably without losing or resetting cross-host order', async ({ page }) => {
  test.setTimeout(150_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'cross-host-folder-lifecycle-'));
  const dirB = path.join(root, 'b');
  const a = await HubServer.start({ stateDir: path.join(root, 'a'), clientDir: path.resolve('dist') });
  let b = await HubServer.start({ stateDir: dirB, origins: [a.url] });
  const c = await HubServer.start({ stateDir: path.join(root, 'c'), origins: [a.url] });
  const portB = new URL(b.url).port;
  try {
    for (const [hub, id, fname] of [[a, 'fa', '甲分组'], [b, 'fb', '乙分组'], [c, 'fc', '丙分组']] as const) {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('bot','助手','fixture',1)");
      const chat = await hub.store.createConversation('owner', ['bot'], `${fname}对话`, 'chat');
      await new ConversationFolders(hub.store.db).change('owner', { type: 'create', id, name: fname, conversationId: chat.id, revision: 0 });
    }
    await pair(page, a, '主机 A');
    await pair(page, b, '主机 B', true);
    await pair(page, c, '主机 C', true);
    await showDisconnectedBots(page);
    await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();

    // Put 乙分组 at top, then 丙分组 below it.
    const menu = page.getByRole('menu', { name: '分组操作', exact: true });
    await sidebar(page).locator(`[data-host-id="${hostId(b)}"] [data-folder-id="fb"] .folder-heading`).click({ button: 'right' });
    await menu.getByRole('button', { name: '移到最上面', exact: true }).click();
    await sidebar(page).locator(`[data-host-id="${hostId(c)}"] [data-folder-id="fc"] .folder-heading`).click({ button: 'right' });
    await menu.getByRole('button', { name: '移到最上面', exact: true }).click();
    await expect.poll(() => folderSequence(sidebar(page))).toEqual([
      '主机 C/丙分组',
      '主机 B/乙分组',
      '主机 A/甲分组',
      '主机 A/未分组',
      '主机 B/未分组',
      '主机 C/未分组',
    ]);

    // Disconnect Host B -> its folders remain in saved order, NOT deleted!
    await b.close();
    await expect.poll(() => folderSequence(sidebar(page))).toEqual([
      '主机 C/丙分组',
      '主机 B/乙分组',
      '主机 A/甲分组',
      '主机 A/未分组',
      '主机 B/未分组',
      '主机 C/未分组',
    ]);

    // Reconnect Host B on the same stateDir/port -> order still intact!
    b = await HubServer.start({ stateDir: dirB, port: Number(portB), origins: [a.url] });
    await expect.poll(() => folderSequence(sidebar(page))).toEqual([
      '主机 C/丙分组',
      '主机 B/乙分组',
      '主机 A/甲分组',
      '主机 A/未分组',
      '主机 B/未分组',
      '主机 C/未分组',
    ]);

    // Create a new folder on Host A remotely (merged beside Host A without resetting C/B order).
    const foldersA = new ConversationFolders(a.store.db);
    await foldersA.change('owner', { type: 'create', id: 'fa2', name: '甲新增', revision: 1 });
    await page.reload();
    await waitForClientOnline(page);
    await expect.poll(() => folderSequence(sidebar(page))).toEqual([
      '主机 C/丙分组',
      '主机 B/乙分组',
      '主机 A/甲分组',
      '主机 A/甲新增',
      '主机 A/未分组',
      '主机 B/未分组',
      '主机 C/未分组',
    ]);

    // Delete 甲分组 on Host A -> cleanly removed without duplicates or resetting C/B order.
    await openFolderManager(page);
    const manager = dialog(page, '管理分组');
    await manager.getByRole('button', { name: '分组操作：甲分组（主机 A）', exact: true }).click();
    await manager.getByRole('button', { name: '删除分组「甲分组（主机 A）」', exact: true }).click();
    await dialog(page, '删除分组').getByRole('button', { name: '删除分组', exact: true }).click();
    await manager.getByRole('button', { name: '关闭分组', exact: true }).click();
    await expect.poll(() => folderSequence(sidebar(page))).toEqual([
      '主机 C/丙分组',
      '主机 B/乙分组',
      '主机 A/甲新增',
      '主机 A/未分组',
      '主机 B/未分组',
      '主机 C/未分组',
    ]);

    // Permanently remove Host C -> Host C entries are pruned while Host B stays above Host A!
    await clickAppAction(page, '设备与网络');
    const network = page.getByRole('dialog', { name: '设备与网络', exact: true });
    await network.getByRole('button', { name: '此设备的连接', exact: true }).click();
    const connMgr = page.getByRole('dialog', { name: '此设备的连接', exact: true });
    const rowC = connMgr.getByRole('region', { name: '主机 C', exact: true });
    await rowC.getByRole('button', { name: '从此设备移除', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: '从此设备移除「主机 C」？', exact: true });
    await confirm.getByRole('button', { name: '确认移除', exact: true }).click();
    await expect(connMgr.getByRole('region', { name: '主机 C', exact: true })).toHaveCount(0);
    await connMgr.getByRole('button', { name: '关闭连接管理', exact: true }).click();

    await expect.poll(() => folderSequence(sidebar(page))).toEqual([
      '主机 B/乙分组',
      '主机 A/甲新增',
      '主机 A/未分组',
      '主机 B/未分组',
    ]);
    const storedRaw = await page.evaluate(() => localStorage.getItem('tarobird-cross-host-folder-order-v1') ?? '');
    expect(storedRaw).not.toContain(c.auth.publicKey);
  } finally {
    await page.close();
    await a.close();
    await b.close();
    await c.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const locale of ['zh', 'en'] as const) test(`narrow desktop and mobile layouts prioritize folder names over host badges while staying single-line and contained (${locale})`, async ({ page }, info) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), `cross-host-folder-narrow-${locale}-`));
  const a = await HubServer.start({ stateDir: path.join(root, 'a'), clientDir: path.resolve('dist') });
  const b = await HubServer.start({ stateDir: path.join(root, 'b'), origins: [a.url] });
  const names = locale === 'en'
    ? { hostA: 'Studio Alpha', hostB: 'Studio Beta', folderA: 'Product Roadmap', folderB: 'Release Ops', chats: 'Chats', manager: 'Manage folders', close: 'Close folders' }
    : { hostA: '工作室甲', hostB: '工作室乙', folderA: '季度产品规划与评审', folderB: '发布运维', chats: '按对话', manager: '管理分组', close: '关闭分组' };
  try {
    await a.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('bot','Assistant','fixture',1)");
    await b.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('bot','Assistant','fixture',1)");
    const ca = await a.store.createConversation('owner', ['bot'], 'Chat A', 'ca');
    const cb = await b.store.createConversation('owner', ['bot'], 'Chat B', 'cb');
    await new ConversationFolders(a.store.db).change('owner', { type: 'create', id: 'fa', name: names.folderA, conversationId: ca.id, revision: 0 });
    await new ConversationFolders(b.store.db).change('owner', { type: 'create', id: 'fb', name: names.folderB, conversationId: cb.id, revision: 0 });

    await pair(page, a, names.hostA);
    await pair(page, b, names.hostB, true);
    await page.evaluate(async loc => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('tarocub-hosts-v1'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('meta', 'readwrite'), store = tx.objectStore('meta'), read = store.get('preferences');
        read.onsuccess = () => store.put(JSON.stringify({ ...JSON.parse(read.result ?? '{}'), locale: loc, sidebarLayout: 'conversations', sidebarGroupByHost: false }), 'preferences');
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, locale);
    await page.reload();
    await waitForClientOnline(page);

    const checkHeadingPriority = async (container: Locator, requireFolderUntruncated: readonly string[]) => {
      const metrics = await container.evaluate(rootNode => {
        const rootRect = rootNode.getBoundingClientRect();
        const headings = [...rootNode.querySelectorAll<HTMLElement>('.folder-heading')].filter(el => el.getClientRects().length > 0);
        return {
          overflow: rootNode.scrollWidth > rootNode.clientWidth + 1,
          rows: headings.map(heading => {
            const nameEl = heading.querySelector<HTMLElement>('.folder-name')!;
            const badge = heading.querySelector<HTMLElement>('.host-source-badge')!;
            const badgeSpan = badge.querySelector<HTMLElement>('span')!;
            const nameRect = nameEl.getBoundingClientRect();
            const badgeRect = badge.getBoundingClientRect();
            return {
              folder: nameEl.textContent?.trim() ?? '',
              host: badge.textContent?.trim() ?? '',
              nameWidth: nameRect.width,
              nameTruncated: nameEl.scrollWidth > nameEl.clientWidth + 1,
              badgeWidth: badgeRect.width,
              badgeHeight: badgeRect.height,
              badgeContained: badgeRect.left >= rootRect.left - 1 && badgeRect.right <= rootRect.right + 1,
              badgeTruncated: badgeSpan.scrollWidth > badgeSpan.clientWidth + 1,
            };
          }),
        };
      });
      expect(metrics.overflow, 'container must not overflow horizontally').toBe(false);
      expect(metrics.rows.length).toBeGreaterThanOrEqual(4);
      for (const row of metrics.rows) {
        expect(row.badgeHeight, `badge "${row.host}" must stay single-line`).toBeLessThanOrEqual(24);
        expect(row.badgeContained, `badge "${row.host}" must stay within bounds`).toBe(true);
        expect(row.badgeWidth, `badge "${row.host}" must retain readable minimum width`).toBeGreaterThanOrEqual(36);
        if (row.nameTruncated) {
          expect(row.nameWidth, `folder "${row.folder}" must have >= visible width of host badge "${row.host}"`).toBeGreaterThanOrEqual(row.badgeWidth);
          expect(row.badgeTruncated, `host badge "${row.host}" must shrink before truncating folder "${row.folder}"`).toBe(true);
        }
        if (requireFolderUntruncated.includes(row.folder)) {
          expect(row.nameTruncated, `folder "${row.folder}" must not be truncated`).toBe(false);
        }
      }
    };

    const checkManagerBadges = async (container: Locator) => {
      const metrics = await container.evaluate(rootNode => {
        const badges = [...rootNode.querySelectorAll<HTMLElement>('.host-source-badge')].filter(el => el.getClientRects().length > 0);
        const rootRect = rootNode.getBoundingClientRect();
        return {
          overflow: rootNode.scrollWidth > rootNode.clientWidth + 1,
          count: badges.length,
          badges: badges.map(badge => {
            const rect = badge.getBoundingClientRect();
            const span = badge.querySelector<HTMLElement>('span')!;
            return {
              text: badge.textContent?.trim() ?? '',
              height: rect.height,
              contained: rect.left >= rootRect.left - 1 && rect.right <= rootRect.right + 1,
              truncated: span.scrollWidth > span.clientWidth + 1,
            };
          }),
        };
      });
      expect(metrics.overflow, 'manager must not overflow horizontally').toBe(false);
      expect(metrics.count).toBeGreaterThanOrEqual(4);
      for (const badge of metrics.badges) {
        expect(badge.height, `manager badge "${badge.text}" must stay single-line`).toBeLessThanOrEqual(24);
        expect(badge.contained, `manager badge "${badge.text}" must stay within bounds`).toBe(true);
        expect(badge.truncated, `manager badge "${badge.text}" must not be truncated`).toBe(false);
      }
    };

    // Narrowest desktop sidebar (200px via resize separator Home key).
    const sep = workspace(page).getByRole('separator').first();
    await sep.focus();
    await page.keyboard.press('Home');
    const desktopUntruncated = locale === 'en' ? ['Release Ops', 'Ungrouped'] : ['发布运维', '未分组'];
    await checkHeadingPriority(sidebar(page).locator('.combined-sidebar'), desktopUntruncated);
    await saveShot(page, info.outputPath(`desktop-narrow-${locale}.png`), `desktop-narrow-${locale}.png`, {
      clip: { x: 0, y: 0, width: 220, height: 680 },
    });

    // Narrowest phone (320px) list + unified Manage folders dialog.
    await page.setViewportSize({ width: 320, height: 740 });
    const backBtn = page.getByRole('button', { name: locale === 'en' ? 'Open conversation list' : '打开会话列表', exact: true });
    if (await backBtn.isVisible()) await backBtn.click();
    await expect(mobileHome(page)).toBeVisible();
    await expect(mobileHome(page)).toHaveAttribute('data-tab', 'messages');
    const phoneUntruncated = locale === 'en' ? ['Product Roadmap', 'Release Ops', 'Ungrouped'] : ['季度产品规划与评审', '发布运维', '未分组'];
    await checkHeadingPriority(mobileHome(page), phoneUntruncated);
    await saveShot(page, info.outputPath(`phone-narrow-list-${locale}.png`), `phone-narrow-list-${locale}.png`);

    const more = mobileHome(page).getByRole('button', { name: locale === 'en' ? 'List options' : '列表选项', exact: true });
    await more.click();
    await dialog(page, locale === 'en' ? 'List options' : '列表选项').getByRole('button', { name: names.manager, exact: true }).click();
    const mgr = dialog(page, names.manager);
    await expect(mgr).toBeVisible();
    await checkManagerBadges(mgr);
    await saveShot(page, info.outputPath(`phone-narrow-manager-${locale}.png`), `phone-narrow-manager-${locale}.png`);
    await mgr.getByRole('button', { name: names.close, exact: true }).click();
  } finally {
    await page.close();
    await a.close();
    await b.close();
    await rm(root, { recursive: true, force: true });
  }
});
