import { setListOption, expectListOption, openMobileListOptions, closeMobileListOptions, openFolderManager } from './fixtures/mobile.js';
import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { HOST_PROFILE_KEY } from "../../src/hub/host-profile.js";
import { ConversationFolders } from "../../src/hub/conversation-folders.js";
import { HubServer } from "../../src/hub/server.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { openMobileHome, openMobileSearch } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
const workspace = (page: Page) => page.locator('.host-workspace:not([hidden])');
const sidebar = (page: Page) => workspace(page).locator('.sidebar');
const mode = (page: Page, name: string) => sidebar(page).getByRole('button', { name, exact: true });

test('empty conversation lists do not mistake hidden Bots for hidden history or remove creation', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'empty-bot-history-'));
  const a = await HubServer.start({ stateDir: path.join(root, 'a'), clientDir: path.resolve('dist') });
  const b = await HubServer.start({ stateDir: path.join(root, 'b'), origins: [a.url] });
  try {
    await a.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('on','在线助手','fixture',1),('off','离线助手','fixture',0)");
    await b.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('off','离线助手','fixture',0)");
    await pair(page, a, '主机 A');
    await mode(page, '按对话').click();
    await expect(sidebar(page).locator('.empty-sidebar')).toHaveText('选择 Bot 开始新对话，或点击新建群组。');
    await pair(page, b, '主机 B', true);
    await expect(sidebar(page).getByText('未连接的 Bot 已隐藏，勾选「显示未连接 Bot」即可查看。', { exact: true })).toHaveCount(0);
    await setListOption(page, '按主机分组', true);
    await expect(sidebar(page).getByText('未连接的 Bot 已隐藏，勾选「显示未连接 Bot」即可查看。', { exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 }); await openMobileHome(page);
    const home = workspace(page).locator('.mobile-home');
    await expectListOption(page, '显示未连接 Bot', false);
    await expect(home.getByText('还没有会话', { exact: true })).toBeVisible();
    await expect(home.getByRole('button', { name: '新建对话', exact: true })).toBeVisible();
    // If history really is hidden, explain it without blocking a different,
    // connected Bot's creation action.
    await a.store.createConversation('owner', ['off'], '离线历史', 'empty-history');
    await page.reload(); await openMobileHome(page);
    await expect(home).toContainText('未连接的 Bot 已隐藏');
    await home.getByRole('button', { name: '新建对话', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '选择运行主机', exact: true })).toBeVisible();
  } finally { await page.close(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});

test('disconnected Bots default hidden across hosts, layouts and phone; presence and saved choices preserve drafts and pins', async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.clock.install();
  const root = await mkdtemp(path.join(os.tmpdir(), 'disconnected-bots-'));
  const a = await HubServer.start({ stateDir: path.join(root, 'a'), clientDir: path.resolve('dist') });
  const b = await HubServer.start({ stateDir: path.join(root, 'b'), origins: [a.url] });
  let bClosed = false;
  const home = () => workspace(page).locator('.mobile-home');
  const presence = async (online: number) => {
    await a.store.botStatus('same', { online });
    await (a as unknown as { broadcastBotStatus(id: string): Promise<void> }).broadcastBotStatus('same');
  };
  try {
    for (const hub of [a, b]) {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('same','在线助手','fixture',1)");
      await hub.store.createConversation('owner', ['same'], hub === a ? 'Mac 对话' : 'Windows 对话', 'chat');
    }
    await a.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('off','未连接助手','fixture',0)");
    const offline = await a.store.createConversation('owner', ['off'], '离线历史', 'offline');
    const group = await a.store.createConversation('owner', ['off'], '保留群组', 'group', { type: 'group' });
    await new ConversationFolders(a.store.db).change('owner', { type: 'create', id: 'work', name: '工作', conversationId: offline.id, revision: 0 });
    await pair(page, a, 'example-mac'); await pair(page, b, '示例电脑', true);
    await expectListOption(page, '显示未连接 Bot', false);
    await expect(sidebar(page).locator('.bot-tree')).toHaveCount(2);
    await expect(sidebar(page).locator(`[data-conversation-id="${offline.id}"]`)).toHaveCount(0);
    await setListOption(page, '显示未连接 Bot', true);
    const offlineRow = sidebar(page).locator(`[data-conversation-id="${offline.id}"]`);
    await offlineRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '分组置顶', exact: true }).click();
    await page.keyboard.press('Escape');
    await setListOption(page, '显示未连接 Bot', false);
    await expect(offlineRow).toHaveCount(0);
    const mac = (await a.store.conversations('owner')).find(c => c.title === 'Mac 对话')!;
    await sidebar(page).locator(`[data-conversation-id="${mac.id}"]`).click();
    const composer = () => workspace(page).getByRole('textbox', { name: '消息', exact: true });
    await composer().fill('断开时保留的草稿');
    await presence(0);
    await expect(sidebar(page).locator('.bot-tree')).toHaveCount(1);
    await expect(composer()).toHaveValue('断开时保留的草稿');
    await mode(page, '按对话').click();
    await expect(sidebar(page).locator('.conversation-row')).toHaveCount(2); // remote Bot + group
    await setListOption(page, '按主机分组', true);
    await expect(sidebar(page).locator('.conversation-row')).toHaveCount(2);
    await setListOption(page, '按主机分组', false);
    await setListOption(page, '显示未连接 Bot', true);
    await expect.poll(() => page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('tarocub-hosts-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try { return await new Promise<boolean>((resolve, reject) => { const request = db.transaction('meta').objectStore('meta').get('preferences'); request.onsuccess = () => resolve(JSON.parse(request.result).showDisconnectedBots); request.onerror = () => reject(request.error); }); } finally { db.close(); }
    })).toBe(true);
    await page.reload();
    await expectListOption(page, '显示未连接 Bot', true);
    await expect(composer()).toHaveValue('断开时保留的草稿');
    await expect(sidebar(page).locator(`[data-conversation-id="${offline.id}"]`).getByLabel('已分组置顶')).toBeVisible();
    await setListOption(page, '显示未连接 Bot', false);
    await page.setViewportSize({ width: 390, height: 844 }); await openMobileHome(page);
    await expectListOption(page, '显示未连接 Bot', false);
    await expect(home().locator('.mh-row')).toHaveCount(2);
    await setListOption(page, '按主机分组', true);
    await expect(home().locator('.mh-row')).toHaveCount(2);
    await setListOption(page, '按主机分组', false);
    await openMobileSearch(page);
    await home().getByLabel('查找会话或 Bot', { exact: true }).fill('未连接助手');
    await expect(home().locator('.mh-bot-main')).toHaveCount(0);
    await expect(home().locator('.mh-row')).toHaveCount(1); // participating group remains searchable
    await expect(home().locator(`[data-conversation-id="${offline.id}"]`)).toHaveCount(0);
    await setListOption(page, '显示未连接 Bot', true);
    await expect(home().locator('.mh-bot-main')).toHaveCount(1);
    await expect(home().locator('.mh-row')).toHaveCount(2);
    await setListOption(page, '显示未连接 Bot', false);
    await home().getByRole('button', { name: '关闭搜索', exact: true }).click();
    await page.screenshot({ path: info.outputPath('phone-hidden.png') });
    await home().locator('.mh-tabbar').getByRole('button', { name: 'Bot', exact: true }).click();
    await expect(home().locator('.mh-bot-main')).toHaveCount(1);
    await setListOption(page, '显示未连接 Bot', true); await expect(home().locator('.mh-bot-main')).toHaveCount(3);
    await setListOption(page, '显示未连接 Bot', false);
    await b.close(); bClosed = true;
    await expect(home().locator('.mh-bot-main').getByRole('img', { name: '在线', exact: true })).toHaveCount(0);
    await expect(home().locator('.mh-bot-main')).toHaveCount(1); // Short host loss retains the original list.
    await page.setViewportSize({ width: 1360, height: 900 });
    await expect(sidebar(page).locator('.conversation-row').filter({ hasText: 'Windows 对话' })).toBeVisible();
    await expect(sidebar(page).locator('.conversation-row').filter({ hasText: 'Windows 对话' }).locator('.avatar i.online')).toHaveCount(0);
    await page.clock.fastForward(301_000);
    await expect(sidebar(page).locator('.conversation-row').filter({ hasText: 'Windows 对话' })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(home().locator('.mh-bot-main')).toHaveCount(0);
    await expect(home()).toContainText('未连接的 Bot 已隐藏');
    await presence(1);
    await expect(home().locator('.mh-bot-main')).toHaveCount(1);
    await home().locator('.mh-tabbar').getByRole('button', { name: /^消息/ }).click();
    await expect(home().locator('.mh-row')).toHaveCount(2);
    await expect(home().locator(`[data-conversation-id="${group.id}"]`)).toBeVisible();
    await setListOption(page, '显示未连接 Bot', true);
    await page.setViewportSize({ width: 320, height: 740 });
    await expect(home().locator('.mh-row')).toHaveCount(4);
    await expect(home().locator(`[data-conversation-id="${mac.id}"]`)).toContainText('草稿');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const checkbox of await home().getByRole('checkbox').all()) {
      const box = await checkbox.locator('..').boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    }
    await page.screenshot({ path: info.outputPath('phone-show-320.png') });
    await page.setViewportSize({ width: 1360, height: 900 });
    await expectListOption(page, '显示未连接 Bot', true);
    const remoteRow = sidebar(page).locator('.conversation-row').filter({ hasText: 'Windows 对话' });
    await expect(remoteRow.locator('.avatar i.online')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('desktop-show.png') });
    // Upgrade from preferences written before the toggle existed also defaults off.
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('tarocub-hosts-v1'); request.onsuccess = () => resolve(request.result); });
      try { await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('meta', 'readwrite'), store = tx.objectStore('meta'), read = store.get('preferences');
        read.onsuccess = () => { const prefs = JSON.parse(read.result); delete prefs.showDisconnectedBots; store.put(JSON.stringify(prefs), 'preferences'); };
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
      }); } finally { db.close(); }
    });
    await page.reload(); await expectListOption(page, '显示未连接 Bot', false);
    expect((await a.store.conversations('owner')).filter(c => !c.archived)).toHaveLength(3);
    expect((await a.store.bots('owner')).map(bot => bot.id).sort()).toEqual(['off', 'same']);
  } finally { await page.close(); await a.close(); if (!bClosed) await b.close(); await rm(root, { recursive: true, force: true }); }
});
async function pair(page: Page, hub: HubServer, name: string, add = false) {
  await hub.store.db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [HOST_PROFILE_KEY, JSON.stringify({ name, revision: 1 })]);
  if (add) await clickAppAction(page, "连接另一台主机", workspace(page).getByRole("button", { name: "连接另一台主机", exact: true }));
  else await page.goto(hub.url);
  await page.getByLabel("主机名称", { exact: true }).fill(name);
  await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await expect(workspace(page).locator('.connection-pill.online')).toBeVisible();
}

test('phone host grouping defaults off, labels each branch once and retains host-scoped drafts across reload and desktop layout', async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phone-host-grouping-'));
  const a = await HubServer.start({ stateDir: path.join(root, 'a'), clientDir: path.resolve('dist') });
  const b = await HubServer.start({ stateDir: path.join(root, 'b'), origins: [a.url] });
  const home = () => workspace(page).locator('.mobile-home');
  const grouping = () => home().getByRole('checkbox', { name: '按主机分组', exact: true });
  try {
    for (const hub of [a, b]) {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('bot','助手','fixture',1)");
      await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES('same','direct','同名会话','owner',1,'same')");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same','user','owner',0),('same','bot','bot',0)");
      await hub.store.createConversation('owner', ['bot'], '日常', 'other');
      await new ConversationFolders(hub.store.db).change('owner', { type: 'create', id: 'work', name: '工作', conversationId: 'same', revision: 0 });
    }
    await pair(page, a, 'example-mac');
    await page.setViewportSize({ width: 390, height: 844 });
    await openMobileHome(page);
    await expect(home().locator('.mh-row')).toHaveCount(2);
    await expect(home().locator('.host-source-badge')).toHaveCount(0);
    await openMobileListOptions(page);
    await expect(grouping()).toHaveCount(0);
    await closeMobileListOptions(page);
    await page.setViewportSize({ width: 1360, height: 900 });
    await pair(page, b, '笔记本', true);
    await page.setViewportSize({ width: 320, height: 844 });
    await openMobileHome(page);
    const more = home().getByRole('button', { name: '列表选项', exact: true });
    const groups = home().getByRole('button', { name: '群组', exact: true });
    const moreBox = await more.boundingBox(), groupsBox = await groups.boundingBox();
    // WebKit can report a 44px hit target as 43.99998474121094 after layout.
    // Keep the hit-target boundary, allowing only sub-millipixel coordinate noise.
    expect(moreBox!.width + .001).toBeGreaterThanOrEqual(44);
    expect(Math.abs(moreBox!.y - groupsBox!.y)).toBeLessThan(2);
    await expect(home().locator('.mh-body .folder-toolbar')).toHaveCount(0);
    await expect(grouping()).toHaveCount(0);
    await openMobileListOptions(page);
    await expect(grouping()).toBeVisible();
    await expect(home().getByRole('button', { name: '管理 example-mac 的分组', exact: true })).toBeVisible();
    await expect(home().getByRole('button', { name: '管理 笔记本 的分组', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('phone-list-options-320.png'), animations: 'disabled' });
    expect(await page.evaluate(() => !window.dispatchEvent(new Event('tarocub-native-back', { cancelable: true })))).toBe(true);
    await expect(page.getByRole('dialog', { name: '列表选项', exact: true })).toHaveCount(0);
    await expect(more).toBeFocused();
    // Reuse the real manager; a phone menu must not change the active host implicitly.
    await openFolderManager(page, '笔记本');
    await page.getByRole('button', { name: '新建分组', exact: true }).click();
    await page.getByLabel('分组名称', { exact: true }).fill('手机整理');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: '关闭分组', exact: true }).click();
    expect((await new ConversationFolders(a.store.db).read('owner')).folders.some(f => f.name === '手机整理')).toBe(false);
    const created = (await new ConversationFolders(b.store.db).read('owner')).folders.find(f => f.name === '手机整理')!;
    expect(created).toBeTruthy();
    await openFolderManager(page, '笔记本');
    await page.getByRole('button', { name: '分组操作：手机整理', exact: true }).click();
    await page.getByRole('button', { name: '删除分组「手机整理」', exact: true }).click();
    await page.getByRole('button', { name: '删除分组', exact: true }).click();
    await page.getByRole('button', { name: '关闭分组', exact: true }).click();

    await expectListOption(page, '按主机分组', false);
    await expect(home().locator('.mh-folder-host-title')).toHaveCount(0);
    await expect(home().locator('.mh-row')).toHaveCount(4);
    await expect(home().locator('.mh-row .host-source-badge')).toHaveCount(0);
    await expect(home().locator('.folder-heading .host-source-badge')).toHaveCount(4);
    await expect(more).toHaveCount(1);
    const hostB = () => home().locator('.mh-folder-host').filter({ has: page.locator('.folder-heading .host-source-badge', { hasText: '笔记本' }) });
    await hostB().locator('[data-conversation-id="same"]').click();
    await workspace(page).getByRole('textbox', { name: '消息', exact: true }).fill('B 的草稿');
    await workspace(page).getByRole('button', { name: '打开会话列表', exact: true }).click();
    await expect(hostB().locator('[data-conversation-id="same"]')).toContainText('草稿');
    const firstFolder = () => home().locator('.folder-heading').first();
    await firstFolder().click(); await expect(firstFolder()).toHaveAttribute('aria-expanded', 'false');
    await setListOption(page, '按主机分组', true);
    await expect(firstFolder()).toHaveAttribute('aria-expanded', 'false');
    await firstFolder().click();
    await expect(home().locator('.mh-folder-host-title')).toHaveText(['example-mac', '笔记本']);
    await expect(home().locator('.host-source-badge')).toHaveCount(0);
    await expectListOption(page, '按主机分组', true);
    const groupedB = () => home().locator('.mh-folder-host').filter({ has: page.getByRole('heading', { name: '笔记本', exact: true }) });
    await groupedB().locator('[data-conversation-id="same"]').click({ button: 'right' });
    await page.getByRole('dialog', { name: '对话操作', exact: true }).getByRole('button', { name: '重命名', exact: true }).click();
    await page.getByRole('dialog', { name: '重命名对话', exact: true }).getByRole('textbox').fill('仅修改笔记本');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '重命名对话', exact: true })).toHaveCount(0);
    await expect(groupedB().locator('[data-conversation-id="same"]')).toContainText('仅修改笔记本');
    expect((await a.store.conversations('owner')).find(c => c.id === 'same')?.title).toBe('同名会话');
    await page.screenshot({ path: info.outputPath('phone-grouped-hosts.png') });
    await page.reload(); await openMobileHome(page); await expectListOption(page, '按主机分组', true);
    await groupedB().locator('[data-conversation-id="same"]').click();
    await expect(workspace(page).getByRole('textbox', { name: '消息', exact: true })).toHaveValue('B 的草稿');
    await workspace(page).getByRole('button', { name: '打开会话列表', exact: true }).click();
    await setListOption(page, '按主机分组', false);
    await expect(home().locator('.mh-folder-host-title')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('phone-combined-folders.png') });
    expect(await home().evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 1360, height: 900 });
    await expectListOption(page, '按主机分组', false);
    await page.reload();
    await page.setViewportSize({ width: 390, height: 844 });
    await openMobileHome(page);
    await expectListOption(page, '按主机分组', false);
    for (const platform of ['android', 'ios']) for (const theme of ['light', 'dark']) {
      await page.evaluate(({platform, theme}) => { document.documentElement.dataset.platform = platform; document.documentElement.dataset.theme = theme; }, {platform, theme});
      const button = home().getByRole('button', { name: '列表选项', exact: true });
      const rect = await button.boundingBox();
      expect(rect!.width).toBeGreaterThanOrEqual(44);
      expect(rect!.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`phone-list-${platform}-${theme}.png`), animations: 'disabled' });
      await openMobileListOptions(page);
      await expect(grouping()).not.toBeChecked();
      await page.screenshot({ path: info.outputPath(`phone-options-${platform}-${theme}.png`), animations: 'disabled' });
      await closeMobileListOptions(page);
    }
    await openMobileListOptions(page);
    await page.setViewportSize({ width: 1000, height: 844 });
    await expect(page.locator('dialog:modal')).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('dialog:modal')).toHaveCount(0);
  } finally { await page.close(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});

test('phone hosts without custom folders combine by recency and group without duplicate source labels', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phone-hosts-flat-'));
  const a = await HubServer.start({ stateDir: path.join(root, 'a'), clientDir: path.resolve('dist') });
  const b = await HubServer.start({ stateDir: path.join(root, 'b'), origins: [a.url] });
  const home = () => workspace(page).locator('.mobile-home');
  try {
    for (const hub of [a, b]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('bot','助手','fixture',1)");
    const old = await a.store.createConversation('owner', ['bot'], '旧对话', 'old');
    await b.store.createConversation('owner', ['bot'], '新对话', 'new');
    await pair(page, a, 'example-mac'); await pair(page, b, '笔记本', true);
    await page.setViewportSize({ width: 390, height: 844 }); await openMobileHome(page);
    await expect(home().locator('.mh-row-title')).toHaveText(['新对话', '旧对话']);
    await expect(home().locator('.mh-row .host-source-badge')).toHaveCount(2);
    await a.store.publishBotMessage('bot', { conversationId: old.id, blocks: [{ type: 'text', text: '最新进展' }] });
    await expect(home().locator('.mh-row-title')).toHaveText(['旧对话', '新对话']);
    await setListOption(page, '按主机分组', true);
    await expect(home().locator('.mh-folder-host-title')).toHaveText(['example-mac', '笔记本']);
    await expect(home().locator('.mh-row')).toHaveCount(2);
    await expect(home().getByRole('listitem')).toHaveCount(2);
    await expect(home().locator('.host-source-badge')).toHaveCount(0);
    await home().getByRole('button', { name: '未读', exact: true }).click();
    await expect(home().locator('.mh-row')).toHaveCount(1);
    await expect(home().locator('.mh-row')).toContainText('旧对话');
    await expect(home().getByRole('heading', { name: 'example-mac', exact: true })).toBeVisible();
    await expect(home().getByRole('heading', { name: '笔记本', exact: true })).toHaveCount(0);
    await setListOption(page, '按主机分组', false);
    await expect(home().locator('.mh-folder-host-title')).toHaveCount(0);
    await expect(home().locator('.mh-row')).toHaveCount(1);
    await home().getByRole('button', { name: '全部', exact: true }).click();
    await expect(home().locator('.mh-row-title')).toHaveText(['旧对话', '新对话']);
  } finally { await page.close(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});

for (const width of [390, 1360]) test(`mixed folder and folder-free hosts use one source-label hierarchy at ${width}px`, async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mixed-host-folders-'));
  const a = await HubServer.start({ stateDir: path.join(root, 'a'), clientDir: path.resolve('dist') });
  const b = await HubServer.start({ stateDir: path.join(root, 'b'), origins: [a.url] });
  try {
    for (const hub of [a, b]) {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('bot','助手','fixture',1)");
      await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES('same','direct','同名对话','owner',1,'same')");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same','user','owner',0),('same','bot','bot',0)");
    }
    await new ConversationFolders(a.store.db).change('owner', { type: 'create', id: 'work', name: '工作', conversationId: 'same', revision: 0 });
    await pair(page, a, 'example-mac'); await pair(page, b, '示例电脑', true);
    await mode(page, '按对话').click();
    await page.setViewportSize({ width, height: 844 });
    if (width < 761) await openMobileHome(page);
    const list = width < 761 ? workspace(page).locator('.mobile-home') : sidebar(page);
    await expectListOption(page, '按主机分组', false);
    await expect(list.locator('[data-conversation-id="same"]')).toHaveCount(2);
    for (const name of ['example-mac', '示例电脑']) await expect(list.locator('.host-source-badge').filter({ hasText: name }).first()).toBeVisible();
    await page.screenshot({ path: info.outputPath(`mixed-host-folders-${width}.png`) });
    const folderSources = await list.locator('.folder-heading .host-source-badge').count();
    const rowSources = await list.locator(':is(.mh-row,.conversation-row) .host-source-badge').count();
    expect(folderSources > 0 && rowSources > 0, 'one host must not be labeled at folder level while another is labeled at conversation level').toBe(false);
    expect(rowSources).toBe(0);
    const unfiled = list.locator('.conversation-folder').filter({ has: page.locator('.folder-heading .host-source-badge', { hasText: '示例电脑' }) });
    await expect(unfiled.locator('.folder-name')).toHaveText('未分组');
    await expect(unfiled.locator('.folder-count')).toHaveText('1');
    await unfiled.locator('[data-conversation-id="same"]').click();
    expect(await workspace(page).getAttribute('data-active-host')).toBe(`hub_${createHash('sha256').update(Buffer.from(b.auth.publicKey, 'base64')).digest('hex')}`);
    await workspace(page).getByRole('textbox', { name: '消息', exact: true }).fill('示例电脑草稿');
    if (width < 761) await openMobileHome(page);
    await expect(unfiled.locator('[data-conversation-id="same"]')).toContainText('示例电脑草稿');
    await setListOption(page, '按主机分组', true); await expect(list.locator('.host-source-badge')).toHaveCount(0);
    await setListOption(page, '按主机分组', false);
    await expect(unfiled.locator('[data-conversation-id="same"]')).toContainText('示例电脑草稿');
    await expect(list.locator('[data-conversation-id="same"]')).toHaveCount(2);
    expect((await new ConversationFolders(b.store.db).read('owner')).folders).toEqual([]);
    // The desktop splitter intentionally extends 4px outside its sidebar.
    const content = width < 761 ? list : list.locator('.combined-sidebar');
    expect(await content.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  } finally { await page.close(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});

test('recent activity promotes an older Bot reply in combined and host-grouped views, including snapshots', async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sidebar-bot-recency-'));
  const a = await HubServer.start({ stateDir: path.join(root, 'a'), clientDir: path.resolve('dist') });
  const b = await HubServer.start({ stateDir: path.join(root, 'b'), origins: [a.url] });
  try {
    for (const [id, name] of [['aa1', 'AA1'], ['gg1', 'GG1']])
      await a.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES(?,?,'fixture',1)", [id, name]);
    const gg = await a.store.createConversation('owner', ['gg1'], 'TaroBird', 'gg');
    const running = await a.store.publishBotMessage('gg1', { conversationId: gg.id, blocks: [{ type: 'text', text: '正在检查。'.repeat(100) }], status: 'streaming' });
    const aa = await a.store.createConversation('owner', ['aa1'], 'AGY 日常', 'aa');
    await a.store.publishBotMessage('aa1', { conversationId: aa.id, blocks: [{ type: 'text', text: '已完成旧任务' }] });
    await pair(page, a, '主机 A'); await pair(page, b, '主机 B', true);
    const firstBot = () => sidebar(page).locator('.bot-tree').first();
    await expect(firstBot()).toHaveAttribute('data-bot-id', 'aa1');
    await sidebar(page).locator(`[data-conversation-id="${aa.id}"]`).click();
    const composer = () => workspace(page).getByRole('textbox', { name: '消息', exact: true });
    await composer().fill('排序时保留草稿');
    const progress = async (suffix: string) => a.store.publishBotMessage('gg1', { id: running.id, conversationId: gg.id, blocks: [{ type: 'text', text: '正在检查。'.repeat(100) + suffix }], status: 'streaming' });
    await progress('第一轮进展');
    await expect(firstBot()).toHaveAttribute('data-bot-id', 'gg1');
    await expect(sidebar(page).locator(`[data-conversation-id="${aa.id}"]`)).toHaveAttribute('aria-current', 'page');
    await expect(composer()).toHaveValue('排序时保留草稿');
    await setListOption(page, '按主机分组', true);
    await expect(firstBot()).toHaveAttribute('data-bot-id', 'gg1');
    await a.store.publishBotMessage('aa1', { conversationId: aa.id, blocks: [{ type: 'text', text: 'AA1 这次确实有新消息' }] });
    await expect(firstBot()).toHaveAttribute('data-bot-id', 'aa1');
    await progress('第一轮进展，第二轮进展');
    await expect(firstBot()).toHaveAttribute('data-bot-id', 'gg1');
    await setListOption(page, '按主机分组', false);
    await expect(firstBot()).toHaveAttribute('data-bot-id', 'gg1');
    await page.reload();
    await expect(firstBot()).toHaveAttribute('data-bot-id', 'gg1');
    await expect(composer()).toHaveValue('排序时保留草稿');
    await page.goto('about:blank');
    // Force the real offline snapshot path rather than replaying a few events.
    for (let i = 0; i < 1001; i++) await a.store.appendBotEvent('gg1', gg.id, 'turn.state', { phase: 'thinking', i });
    await progress('第一轮进展，第二轮进展，离线期间的新进展');
    const snapshots: unknown[] = [];
    page.on('websocket', socket => socket.on('framereceived', ({ payload }) => { const frame = JSON.parse(String(payload)); if (frame.type === 'snapshot.message') snapshots.push(frame); }));
    await page.goto(a.url);
    await expect.poll(() => snapshots.length).toBeGreaterThan(0);
    await expect(firstBot()).toHaveAttribute('data-bot-id', 'gg1');
    await mode(page, '按对话').click();
    await expect(sidebar(page).locator('.conversation-row').first()).toHaveAttribute('data-conversation-id', gg.id);
    await mode(page, '按 Bot').click();
    await page.screenshot({ path: info.outputPath('bot-recent-activity.png') });
  } finally { await page.close(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});

test('desktop defaults to Bots; flat inbox shares phone ordering and keeps selection, draft and saved layout', async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sidebar-layout-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  try {
    for (const [id, name] of [['alpha', '产品助手'], ['beta', '研究助手']])
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES(?,?,'fixture',1)", [id, name]);
    await hub.store.db.run("UPDATE bots SET engine='claude', model='claude-opus-5-5' WHERE id='beta'");
    const old = await hub.store.createConversation('owner', ['alpha'], '设计讨论', 'old');
    const direct = await hub.store.createConversation('owner', ['beta'], '研究报告', 'direct');
    const group = await hub.store.createConversation('owner', ['alpha', 'beta'], '产品工作群', 'group', { type: 'group' });
    const topic = await hub.store.createConversation('owner', [], '界面体验', 'topic', { parentId: group.id });
    const archived = await hub.store.createConversation('owner', ['alpha'], '归档讨论', 'archived');
    await hub.store.updateConversation('owner', archived.id, { archived: true });
    await pair(page, hub, '主机 A');
    await expect(mode(page, '按 Bot')).toHaveAttribute('aria-pressed', 'true');
    await expect(sidebar(page).locator('.bot-tree')).toHaveCount(2);
    await sidebar(page).locator(`[data-conversation-id="${old.id}"]`).click();
    const composer = workspace(page).getByRole('textbox', { name: '消息', exact: true });
    await composer.fill('切换排列时保留草稿');
    await hub.store.publishBotMessage('beta', { conversationId: direct.id, blocks: [{ type: 'text', text: '研究报告最新进展' }], status: 'complete' });
    await hub.store.publishBotMessage('alpha', { conversationId: topic.id, blocks: [{ type: 'text', text: '群组话题最新消息' }], status: 'complete' });
    await mode(page, '按对话').click();
    const rows = sidebar(page).locator('.conversation-row');
    const groupRow = sidebar(page).locator(`[data-conversation-id="${group.id}"]`);
    await expect(sidebar(page).locator('.bot-tree')).toHaveCount(0);
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toHaveAttribute('data-conversation-id', group.id);
    await expect(rows.nth(1)).toHaveAttribute('data-conversation-id', direct.id);
    await expect(groupRow).toContainText('界面体验：群组话题最新消息');
    await expect(groupRow.locator('.unread-badge')).toHaveText('1');
    await expect(groupRow.locator('.avatar')).toBeVisible();
    await expect(sidebar(page).locator(`[data-conversation-id="${direct.id}"] .inbox-row-bot`)).toHaveText('研究助手');
    await expect(sidebar(page).locator(`[data-conversation-id="${old.id}"]`)).toHaveAttribute('aria-current', 'page');
    await expect(composer).toHaveValue('切换排列时保留草稿');
    // A short title must not leave a growing blank before its Bot identity.
    // Measure actual text, not the flex box, and retain a little breathing room.
    const directRow = sidebar(page).locator(`[data-conversation-id="${direct.id}"]`);
    const resize = workspace(page).getByRole('separator', { name: '调整侧栏宽度' });
    for (const size of ['default', 'wide']) {
      if (size === 'wide') { await resize.focus(); await page.keyboard.press('End'); }
      await expect(directRow.locator('.inbox-row-bot')).toBeVisible();
      const geometry = await directRow.evaluate(row => {
        const title = row.querySelector('strong')!, bot = row.querySelector('.inbox-row-bot')!, icon = row.querySelector('.bot-brand-icon')!;
        const text = document.createRange(); text.selectNodeContents(title);
        const a = text.getBoundingClientRect(), b = bot.getBoundingClientRect(), c = icon.getBoundingClientRect();
        return { gap: b.left - Math.min(a.right, title.getBoundingClientRect().right), sameLine: Math.abs((a.top + a.bottom - b.top - b.bottom) / 2), iconWidth: c.width, contained: c.right <= row.getBoundingClientRect().right };
      });
      expect(geometry.gap).toBeGreaterThanOrEqual(7);
      expect(geometry.gap).toBeLessThanOrEqual(9);
      expect(geometry.sameLine).toBeLessThan(3);
      expect(geometry.iconWidth).toBe(12);
      expect(geometry.contained).toBe(true);
    }
    await resize.dblclick();
    await page.screenshot({ path: info.outputPath('desktop-conversation-layout.png') });

    // Existing context actions operate on the same rows and pin precedes recency.
    await sidebar(page).locator(`[data-conversation-id="${old.id}"]`).click({ button: 'right' });
    await page.getByRole('menu', { name: '对话操作', exact: true }).getByRole('menuitem', { name: '分组置顶', exact: true }).click();
    await expect(rows.first()).toHaveAttribute('data-conversation-id', old.id);
    await expect(rows.first().getByLabel('已分组置顶', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await mode(page, '按 Bot').click();
    await expect(sidebar(page).locator('.bot-tree')).toHaveCount(2);
    await expect(composer).toHaveValue('切换排列时保留草稿');
    await sidebar(page).locator(`[data-conversation-id="${topic.id}"]`).click();
    await mode(page, '按对话').click();
    await expect(groupRow).toHaveAttribute('aria-current', 'page');
    await sidebar(page).locator(`[data-conversation-id="${old.id}"]`).click();
    await page.reload();
    await expect(mode(page, '按对话')).toHaveAttribute('aria-pressed', 'true');
    await expect(composer).toHaveValue('切换排列时保留草稿');
    await expect(rows.first()).toHaveAttribute('data-conversation-id', old.id);

    // The narrowest desktop sidebar remains bounded in every shape-based theme.
    const separator = workspace(page).getByRole('separator', { name: '调整侧栏宽度' });
    await separator.focus(); await page.keyboard.press('Home');
    for (const palette of ['white-teal', 'cli', 'pixel']) {
      await page.evaluate(palette => { document.documentElement.dataset.palette = palette; }, palette);
      expect(await sidebar(page).locator('.conversation-list').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await sidebar(page).locator('.sidebar-layout-switch').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await expect(mode(page, '按对话')).toBeVisible();
      await expect(sidebar(page).locator('.inbox-row-bot').first()).toBeHidden();
      await page.screenshot({ path: info.outputPath(`narrow-${palette}.png`), animations: 'disabled' });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(sidebar(page).locator('.sidebar-layout-switch')).toBeHidden();
    await workspace(page).getByRole('button', { name: '打开会话列表', exact: true }).click();
    await expect(workspace(page).locator('.mobile-home')).toBeVisible();
    await expect(workspace(page).locator('.mh-row')).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('rapid selections survive closing and reopening while IndexedDB writes are pending', async ({ page, context }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'selection-close-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  let reopened: Page | undefined;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('alpha','助手','fixture',1)");
    const chats = [];
    for (const [index, title] of ['原对话', '快速切换中间对话', '关闭前最后对话'].entries()) {
      chats.push(await hub.store.createConversation('owner', ['alpha'], title, `close_${index}`));
    }
    await pair(page, hub, '主机 A');
    await sidebar(page).locator(`[data-conversation-id="${chats[0]!.id}"]`).click();
    await expect(workspace(page).getByRole('heading', { name: chats[0]!.title, exact: true })).toBeVisible();
    // A real queued IDB transaction makes the unload window deterministic.
    // Navigation closes it, just as a busy cache transaction is interrupted.
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('tarocub-v1');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const tx = db.transaction('settings', 'readwrite');
      const keepBusy = () => { tx.objectStore('settings').get('selection-close-fixture').onsuccess = keepBusy; };
      keepBusy();
      window.addEventListener('pagehide', () => { try { tx.abort(); } catch { /* Already closed. */ } db.close(); }, { once: true });
    });
    await sidebar(page).locator(`[data-conversation-id="${chats[1]!.id}"]`).click();
    await sidebar(page).locator(`[data-conversation-id="${chats[2]!.id}"]`).click();
    await expect(workspace(page).getByRole('heading', { name: chats[2]!.title, exact: true })).toBeVisible();
    await page.close();
    reopened = await context.newPage(); await reopened.goto(hub.url);
    await expect(workspace(reopened).getByRole('heading', { name: chats[2]!.title, exact: true })).toBeVisible();
    await expect(sidebar(reopened).locator(`[data-conversation-id="${chats[2]!.id}"]`)).toHaveAttribute('aria-current', 'page');
  } finally { await reopened?.close(); await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('host grouping defaults off, removes redundant badges and preserves same-ID actions, drafts and saved choices', async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sidebar-layout-hosts-'));
  const a = await HubServer.start({ stateDir: path.join(root, 'a'), clientDir: path.resolve('dist') });
  const b = await HubServer.start({ stateDir: path.join(root, 'b'), origins: [a.url] });
  try {
    for (const hub of [a, b]) {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('bot','同名助手','fixture',1)");
      await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES('same','direct','同名对话','owner',1,'same')");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same','user','owner',0)");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same','bot','bot',0)");
    }
    await pair(page, a, '主机 A'); await mode(page, '按对话').click();
    await pair(page, b, '主机 B', true);
    await expect(mode(page, '按对话')).toHaveAttribute('aria-pressed', 'true');
    const id = (hub: HubServer) => `hub_${createHash('sha256').update(Buffer.from(hub.auth.publicKey, 'base64')).digest('hex')}`;
    const hostA = () => sidebar(page).locator(`[data-host-id="${id(a)}"]`);
    const hostB = () => sidebar(page).locator(`[data-host-id="${id(b)}"]`);
    const savedGrouping = () => page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('tarocub-hosts-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try { return await new Promise<boolean>((resolve, reject) => { const request = db.transaction('meta').objectStore('meta').get('preferences'); request.onsuccess = () => resolve(JSON.parse(request.result).sidebarGroupByHost); request.onerror = () => reject(request.error); }); } finally { db.close(); }
    });
    await expectListOption(page, '按主机分组', false);
    await expect(sidebar(page).locator('.host-heading')).toHaveCount(0);
    await expect(sidebar(page).locator('.conversation-row')).toHaveCount(2);
    await expect(hostA().locator('.host-source-badge')).toHaveCount(1);
    await expect(hostB().locator('.host-source-badge')).toHaveCount(1);
    await b.store.publishBotMessage('bot', { conversationId: 'same', blocks: [{ type: 'text', text: 'B 最新消息' }], status: 'complete' });
    await expect(sidebar(page).locator('.conversation-row').first()).toContainText('B 最新消息');
    await a.store.publishBotMessage('bot', { conversationId: 'same', blocks: [{ type: 'text', text: 'A 最新消息' }], status: 'complete' });
    await expect(sidebar(page).locator('.conversation-row').first()).toContainText('A 最新消息');
    await page.screenshot({ path: info.outputPath('combined-conversations.png') });
    await hostA().locator('[data-conversation-id="same"]').click({ button: 'right' });
    await page.getByRole('menu', { name: '对话操作', exact: true }).getByRole('menuitem', { name: '重命名', exact: false }).click();
    const rename = page.getByRole('dialog', { name: '重命名对话', exact: true });
    await rename.getByRole('textbox').fill('A 独有名称');
    await rename.getByRole('button', { name: '保存', exact: true }).click();
    await expect(hostA().locator('.conversation-row')).toContainText('A 独有名称');
    await expect(hostB().locator('.conversation-row')).toContainText('同名对话');
    await hostA().locator('.conversation-row').click();
    await workspace(page).getByRole('textbox', { name: '消息', exact: true }).fill('A 的草稿');
    await expect(mode(page, '按对话')).toHaveAttribute('aria-pressed', 'true');
    await mode(page, '按 Bot').click();
    await expect(sidebar(page).getByRole('region', { name: 'Bot', exact: true })).toHaveCount(1);
    await expect(sidebar(page).locator('.bot-tree-heading .host-source-badge')).toHaveCount(2);
    await expect(sidebar(page).locator('.bot-tree-conversations .host-source-badge')).toHaveCount(0);
    await expect(sidebar(page).locator('.conversation-row').first()).toContainText('A 独有名称');
    await page.screenshot({ path: info.outputPath('combined-bots.png') });
    await hostB().locator('.conversation-row').click();
    await workspace(page).getByRole('textbox', { name: '消息', exact: true }).fill('B 的草稿');
    await hostA().locator('.conversation-row').click();
    await expect(workspace(page).getByRole('textbox', { name: '消息', exact: true })).toHaveValue('A 的草稿');
    await expect(mode(page, '按 Bot')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('tarocub-hosts-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try { return await new Promise<string>((resolve, reject) => { const request = db.transaction('meta').objectStore('meta').get('selectedHost'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); } finally { db.close(); }
    })).toBe(id(a));
    await page.reload(); await expect(mode(page, '按 Bot')).toHaveAttribute('aria-pressed', 'true');
    await expect(workspace(page)).toHaveAttribute('data-active-host', id(a));
    await expectListOption(page, '按主机分组', false);
    await setListOption(page, '按主机分组', true);
    await expect(sidebar(page).locator('.host-heading')).toHaveCount(2);
    await expect(sidebar(page).locator('.host-source-badge')).toHaveCount(0);
    await expect(workspace(page).getByRole('textbox', { name: '消息', exact: true })).toHaveValue('A 的草稿');
    await page.screenshot({ path: info.outputPath('grouped-bots.png') });
    await expect.poll(savedGrouping).toBe(true);
    await page.reload(); await expectListOption(page, '按主机分组', true);
    await mode(page, '按对话').click();
    await expect(sidebar(page).locator('.host-heading')).toHaveCount(2);
    await expect(sidebar(page).locator('.host-source-badge')).toHaveCount(0);
    await sidebar(page).getByRole('combobox', { name: '筛选运行主机' }).selectOption(id(b));
    await expect(sidebar(page).locator('.host-heading')).toHaveCount(0);
    await expect(sidebar(page).locator('.conversation-row')).toHaveCount(1);
    await expect(workspace(page).getByRole('textbox', { name: '消息', exact: true })).toHaveValue('B 的草稿');
    await sidebar(page).getByRole('combobox', { name: '筛选运行主机' }).selectOption('');
    await setListOption(page, '按主机分组', false);
    await expect.poll(savedGrouping).toBe(false);
    await page.reload(); await expectListOption(page, '按主机分组', false);
    await expect(sidebar(page).locator('.host-heading')).toHaveCount(0);
    await expect(sidebar(page).locator('.conversation-row')).toHaveCount(2);
  } finally { await page.close(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});
