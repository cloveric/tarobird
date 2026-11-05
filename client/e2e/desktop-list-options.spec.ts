import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationFolders } from '../../src/hub/conversation-folders.js';
import { HubServer } from '../../src/hub/server.js';
import { preparePairing } from './fixtures/pairing-invite.js';
import { clickAppAction } from './fixtures/desktop-actions.js';

test.use({ serviceWorkers: 'block' });
for (const locale of ['zh', 'en']) test(`folder context menus own the correct host, save list settings and restore keyboard focus (${locale})`, async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'list-options-'));
  const a = await HubServer.start({ stateDir: path.join(root, 'a'), clientDir: path.resolve('dist') });
  const b = await HubServer.start({ stateDir: path.join(root, 'b'), origins: [a.url] });
  const w = locale === 'en'
    ? { options: 'List options', group: 'Group by host', offline: 'Show disconnected Bots', chats: 'Chats', folders: 'Manage folders', close: 'Close folders', adhd: 'Open ADHD mode' }
    : { options: '列表选项', group: '按主机分组', offline: '显示未连接 Bot', chats: '按对话', folders: '管理分组', close: '关闭分组', adhd: '打开 ADHD 模式' };
  try {
    for (const [i, hub] of [a, b].entries()) {
      await hub.profile.update({ name: `Studio ${i + 1}`, revision: (await hub.profile.read()).revision });
      await new ConversationFolders(hub.store.db).change('owner', { type: 'create', id: 'folder', name: `Folder ${i + 1}`, revision: 0 });
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('bot','Assistant','fixture',1)");
      await hub.store.createConversation('owner', ['bot'], `Workspace ${i + 1}`, 'chat');
      if (i) await clickAppAction(page, '连接另一台主机'); else await page.goto(hub.url);
      await page.getByLabel('主机名称', { exact: true }).fill(`Studio ${i + 1}`);
      await page.getByLabel('Hub 地址', { exact: true }).fill(hub.url);
      await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
      await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
      await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
      await expect(page.locator('.host-workspace:not([hidden]) .connection-pill.online')).toBeVisible();
    }
    await page.evaluate(async locale => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('tarocub-hosts-v1'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      await new Promise<void>((resolve, reject) => { const tx = db.transaction('meta', 'readwrite'), store = tx.objectStore('meta'), r = store.get('preferences'); r.onsuccess = () => store.put(JSON.stringify({ ...JSON.parse(r.result ?? '{}'), locale, palette: 'mono', monoAccent: 'warm-gray', sidebarGroupByHost: false, showDisconnectedBots: false }), 'preferences'); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
    }, locale);
    await page.reload();
    const sidebar = () => page.locator('.sidebar').filter({ visible: true });
    const folder = (i: number) => sidebar().locator('.folder-heading').filter({ has: page.getByText(`Folder ${i}`, { exact: true }) });
    const menu = () => page.getByRole('menu', { name: locale === 'en' ? 'Folder actions' : '分组操作', exact: true });
    const manager = () => page.getByRole('dialog', { name: w.folders, exact: true });
    await expect(sidebar().getByRole('button', { name: w.options, exact: true })).toHaveCount(0);
    // Bot section labels also retain keyboard access before entering Chats.
    const botHeading = sidebar().locator('.sidebar-label[role=button]').first();
    await botHeading.focus(); await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menu', { name: w.options, exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(botHeading).toBeFocused();
    await page.getByRole('button', { name: w.chats, exact: true }).filter({ visible: true }).click();
    await folder(1).click({ button: 'right' });
    await expect(menu()).toBeVisible();
    await expect(menu().getByRole('checkbox', { name: w.group, exact: true })).not.toBeChecked();
    await expect(menu().getByRole('button', { name: locale === 'en' ? 'Rename folder' : '重命名分组', exact: true })).toBeVisible();
    await menu().getByRole('button', { name: w.folders, exact: true }).click();
    await expect(manager().locator('.folder-order-name')).toContainText(['Folder 1']);
    await expect(manager()).not.toContainText('Folder 2');
    await manager().getByRole('button', { name: w.close, exact: true }).click();
    await expect(folder(1)).toBeFocused();
    await folder(2).focus(); await page.keyboard.press('Shift+F10');
    await menu().getByRole('checkbox', { name: w.offline, exact: true }).focus();
    await page.keyboard.press('Space');
    await expect(menu().getByRole('checkbox', { name: w.offline, exact: true })).toBeChecked();
    // Save a mixed-host preview, then regroup: no persistent extra toolbar row.
    await page.screenshot({ path: info.outputPath(`folder-context-${locale}.png`), clip: { x: 0, y: 0, width: 294, height: 820 }, animations: 'disabled' });
    await menu().getByRole('checkbox', { name: w.group, exact: true }).click();
    await expect(sidebar().locator('.host-heading')).toHaveCount(2);
    await expect(page.locator('.desktop-menu')).toHaveCount(0);
    // Right-clicking a secondary Host heading must manage that Host, not active Studio 2.
    const host1 = sidebar().locator('.host-heading').filter({ hasText: 'Studio 1' });
    await host1.click({ button: 'right' });
    await page.getByRole('menu', { name: w.options, exact: true }).getByRole('button', { name: w.folders, exact: true }).click();
    await expect(manager()).toContainText('Folder 1'); await expect(manager()).not.toContainText('Folder 2');
    await manager().getByRole('button', { name: w.close, exact: true }).click();
    await expect(host1).toBeFocused();
    await page.getByRole('separator').filter({ visible: true }).first().focus(); await page.keyboard.press('Home');
    await folder(2).click({ button: 'right' });
    expect(await menu().evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    const bounds = await menu().boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0);
    await menu().getByRole('button', { name: w.folders, exact: true }).click();
    await expect(manager()).toContainText('Folder 2'); await expect(manager()).not.toContainText('Folder 1');
    await manager().getByRole('button', { name: w.close, exact: true }).click();
    await expect(folder(2)).toBeFocused();
    await page.reload(); await folder(2).click({ button: 'right' });
    await expect(menu().getByRole('checkbox', { name: w.group, exact: true })).toBeChecked();
    await expect(menu().getByRole('checkbox', { name: w.offline, exact: true })).toBeChecked();
    await page.keyboard.press('Escape'); await page.getByRole('button', { name: w.adhd, exact: true }).filter({ visible: true }).click();
    await folder(1).click({ button: 'right' });
    await expect(menu().getByRole('checkbox', { name: w.group, exact: true })).toBeChecked();
    await menu().getByRole('button', { name: w.folders, exact: true }).click();
    await expect(manager()).toContainText('Folder 1'); await expect(manager()).not.toContainText('Folder 2');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(manager()).toHaveCount(0); await expect(page.locator('.desktop-menu')).toHaveCount(0);
  } finally { await page.close(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});

test('empty desktop lists retain context and keyboard access to create the first folder', async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'empty-list-options-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  try {
    await page.goto(hub.url);
    await page.getByLabel('主机名称', { exact: true }).fill('Empty Studio');
    await page.getByLabel('Hub 地址', { exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
    await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
    const directory = page.locator('.sidebar-list-context').filter({ visible: true });
    const menu = page.getByRole('menu', { name: '列表选项', exact: true });
    await directory.click({ button: 'right', position: { x: 10, y: 100 } });
    await expect(menu).toBeVisible(); await page.keyboard.press('Escape');
    await expect(directory).toBeFocused(); await page.keyboard.press('Shift+F10');
    await menu.getByRole('button', { name: '管理分组', exact: true }).click();
    const manager = page.getByRole('dialog', { name: '管理分组', exact: true });
    await manager.getByRole('button', { name: '新建分组', exact: true }).click();
    const create = page.getByRole('dialog', { name: '新建分组', exact: true });
    await create.getByLabel('分组名称').fill('First folder'); await create.getByRole('button', { name: '保存', exact: true }).click();
    await manager.getByRole('button', { name: '关闭分组', exact: true }).click();
    await page.getByRole('button', { name: '按对话', exact: true }).filter({ visible: true }).click();
    await expect(page.locator('.folder-heading').filter({ visible: true, hasText: 'First folder' })).toBeVisible();
    await page.screenshot({ path: info.outputPath('empty-folder-created.png'), animations: 'disabled' });
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
