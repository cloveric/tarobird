import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { ConversationFolders } from '../../src/hub/conversation-folders.js';
import { showDisconnectedBots, waitForClientOnline, mobileHome, openMobileHome } from './fixtures/mobile.js';
import { clickAppAction } from './fixtures/desktop-actions.js';

test.use({ serviceWorkers: 'block' });
const workspace = (page: Page) => page.locator('.host-workspace:not([hidden])');
const sidebar = (page: Page) => workspace(page).locator('.sidebar');
const row = (page: Page, id: string) => ((page.viewportSize()?.width ?? 1360) <= 760 ? mobileHome(page) : sidebar(page)).locator(`[data-conversation-id="${id}"]`);
const toolbar = (page: Page) => page.locator('.conversation-bulk-toolbar').filter({ visible: true });
const dialog = (page: Page, name: string) => page.getByRole('dialog', { name, exact: true });
async function fixture(name = '整理测试主机', origins: string[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'conversation-bulk-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist'), origins });
  await hub.profile.update({ name, revision: (await hub.profile.read()).revision });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','整理助手','fixture')");
  for (const [id, title] of [['same', '旅行计划'], ['second', '产品讨论'], ['third', '阅读笔记']]) {
    await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES(?,'direct',?,'owner',?,?)", [id!, title!, Date.now(), `create_${id}`]);
    await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'user','owner',0),(?,'bot','bot',0)", [id!, id!]);
    await hub.store.publishBotMessage('bot', { conversationId: id!, blocks: [{ type: 'text', text: '保留的历史记录' }] });
  }
  const group = await hub.store.createConversation('owner', ['bot'], '项目群组', 'group', { type: 'group' });
  const topic = await hub.store.createConversation('owner', ['bot'], '设计话题', 'topic', { type: 'group', parentId: group.id });
  const folders = new ConversationFolders(hub.store.db);
  await folders.change('owner', { type: 'create', id: 'work', name: '工作', revision: 0 });
  await folders.change('owner', { type: 'create', id: 'life', name: '生活', revision: 1 });
  return { hub, root, group, topic, folders, close: async () => { await hub.close(); await rm(root, { recursive: true, force: true }); } };
}
async function pair(page: Page, hub: HubServer, add = false) {
  if (add) await clickAppAction(page, '连接另一台主机', workspace(page).getByRole('button', { name: '连接另一台主机', exact: true }));
  else await page.goto(hub.url);
  await page.getByLabel('主机名称', { exact: true }).fill((await hub.profile.read()).name);
  await page.getByLabel('Hub 地址', { exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
  await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
  await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
  await showDisconnectedBots(page); await waitForClientOnline(page);
}
async function selectMultiple(page: Page, id: string, target: Locator = row(page, id)) {
  if ((page.viewportSize()?.width ?? 1360) <= 760) {
    await target.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 17, isPrimary: true, button: 0, clientX: 140, clientY: 260 });
    const menu = page.getByRole('dialog', { name: /^(对话|群组)操作$/ });
    await expect(menu).toBeVisible();
    await target.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 17, isPrimary: true, button: 0 });
    await menu.getByRole('button', { name: '多选', exact: true }).click();
  } else {
    await target.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '多选', exact: true }).click();
  }
  await expect(toolbar(page)).toContainText('已选 1 项');
  await expect(target).toHaveAttribute('aria-checked', 'true');
}
async function addSecond(page: Page) { await row(page, 'second').click(); await expect(toolbar(page)).toContainText('已选 2 项'); }
async function openMove(page: Page) { await page.getByRole('group', { name: '批量整理对话' }).filter({ visible: true }).getByRole('button', { name: '移至分组', exact: true }).click(); return dialog(page, '移动选中对话'); }

test('desktop multi-select does not navigate, cancel preserves drafts, and moving to a new folder is atomic', async ({ page }, info) => {
  const f = await fixture();
  try {
    await pair(page, f.hub);
    await row(page, 'same').click(); await workspace(page).getByRole('textbox', { name: '消息', exact: true }).fill('保留这一份草稿');
    await selectMultiple(page, 'same'); await addSecond(page);
    await row(page, 'same').click(); await expect(row(page, 'same')).not.toHaveClass(/\bselected\b/);
    await expect(row(page, 'same')).toHaveAttribute('aria-checked', 'false'); await row(page, 'same').click();
    await expect(workspace(page).getByRole('heading', { name: '旅行计划', exact: true })).toBeVisible();
    await row(page, 'second').click({ button: 'right' }); await expect(page.getByRole('menu', { name: '对话操作', exact: true })).toHaveCount(0);
    await toolbar(page).getByRole('button', { name: '取消多选', exact: true }).click();
    await expect(workspace(page).getByRole('textbox', { name: '消息', exact: true })).toHaveValue('保留这一份草稿');
    await selectMultiple(page, 'same'); await addSecond(page);
    await page.screenshot({ path: info.outputPath('desktop-light-selection.png') });
    const move = await openMove(page); await move.getByRole('button', { name: '新建分组', exact: true }).click();
    await move.getByLabel('分组名称', { exact: true }).fill('项目资料');
    await move.getByLabel('分组名称', { exact: true }).dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229 });
    await expect(move).toBeVisible();
    await move.getByLabel('分组名称', { exact: true }).press('Enter'); await expect(move).toHaveCount(0);
    const saved = await f.folders.read('owner');
    const folderId = saved.folders.find(folder => folder.name === '项目资料')!.id;
    expect(saved.revision).toBe(3);
    expect(saved.assignments.filter(item => item.folderId === folderId).map(item => item.conversationId).sort()).toEqual(['same', 'second']);
    expect(await f.hub.store.db.get('SELECT COUNT(*) AS n FROM conversation_batch_requests')).toEqual({ n: 1 });
    await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    await expect(sidebar(page).locator(`[data-folder-id="${folderId}"]`)).toContainText('旅行计划');
    await page.reload(); await waitForClientOnline(page);
    await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    await expect(sidebar(page).locator(`[data-folder-id="${folderId}"]`)).toContainText('产品讨论');
  } finally { await f.close(); }
});

for (const width of [390, 320]) test(`phone hold, selection overlay, native back and batch move (${width}px)`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 }); const f = await fixture();
  try {
    await pair(page, f.hub);
    const before = await row(page, 'same').locator('.mh-row-main').boundingBox();
    await selectMultiple(page, 'same'); await addSecond(page);
    const after = await row(page, 'same').locator('.mh-row-main').boundingBox();
    expect(after!.x).toBe(before!.x); expect(after!.width).toBe(before!.width);
    await expect.poll(async () => (await row(page, 'same').evaluate(node => getComputedStyle(node).backgroundColor)) === (await row(page, 'second').evaluate(node => getComputedStyle(node).backgroundColor))).toBe(true);
    await row(page, 'same').dispatchEvent('contextmenu'); await expect(page.getByRole('dialog', { name: '对话操作', exact: true })).toHaveCount(0);
    expect(await mobileHome(page).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('phone-light-selection.png') });
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await page.screenshot({ path: info.outputPath('phone-dark-selection.png') });
    await page.evaluate(() => window.dispatchEvent(new Event('tarocub-native-back', { cancelable: true })));
    await expect(toolbar(page)).toHaveCount(0); await expect(mobileHome(page)).toBeVisible();
    await selectMultiple(page, 'same'); await addSecond(page);
    const move = await openMove(page); await move.getByRole('radio', { name: '工作', exact: true }).click();
    await page.screenshot({ path: info.outputPath('phone-move-dialog.png') });
    await move.getByRole('button', { name: '移动 2 个对话', exact: true }).click(); await expect(move).toHaveCount(0);
    expect((await f.folders.read('owner')).assignments).toHaveLength(2);
    await expect(mobileHome(page).getByRole('navigation', { name: '主导航' })).toBeVisible();
  } finally { await f.close(); }
});

test('deleting a group and selected topic only archives the group; currently open chat moves once and history survives', async ({ page }, info) => {
  const f = await fixture();
  try {
    await pair(page, f.hub); await row(page, 'same').click();
    await selectMultiple(page, f.topic.id); await row(page, f.group.id).click();
    await expect(toolbar(page)).toContainText('已选 1 项');
    await expect(row(page, f.topic.id)).toBeDisabled();
    await row(page, 'same').click();
    await toolbar(page).getByRole('button', { name: '删除', exact: true }).click();
    const remove = dialog(page, '删除选中对话');
    await expect(remove).toContainText('1 个话题也会隐藏');
    await expect(remove.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await expect(remove.locator('.conversation-bulk-details').first()).not.toHaveAttribute('open', '');
    await remove.getByText('查看已选对话', { exact: true }).click();
    await expect(remove).toContainText('项目群组'); await expect(remove).toContainText('旅行计划');
    await page.screenshot({ path: info.outputPath('desktop-archive-confirm.png') });
    await remove.getByRole('button', { name: '删除 2 个对话', exact: true }).click(); await expect(remove).toHaveCount(0);
    expect((await f.hub.store.conversationInTransaction(f.group.id)).archived).toBe(true);
    expect((await f.hub.store.conversationInTransaction(f.topic.id)).archived).toBe(false);
    await expect(row(page, 'same')).toHaveCount(0);
    await expect(workspace(page).getByRole('heading', { name: '旅行计划', exact: true })).toHaveCount(0);
    expect(await f.hub.store.db.get("SELECT COUNT(*) AS n FROM messages WHERE conversation_id='same'")).toEqual({ n: 1 });
  } finally { await f.close(); }
});

test('mixed ownership and topics give explicit exclusions rather than partial operations', async ({ page }) => {
  const f = await fixture();
  try {
    await f.hub.store.db.run("INSERT INTO users VALUES('other','Other','member')");
    await f.hub.store.db.run("UPDATE conversations SET owner_id='other' WHERE id='second'");
    await pair(page, f.hub); await selectMultiple(page, 'same'); await addSecond(page);
    await expect(toolbar(page).getByRole('button', { name: '删除', exact: true })).toBeDisabled();
    await toolbar(page).getByRole('button', { name: '查看', exact: true }).click();
    await dialog(page, '已选 2 个对话').getByRole('button', { name: '仅保留可删除项', exact: true }).click();
    await dialog(page, '已选 1 个对话').getByRole('button', { name: '取消', exact: true }).click();
    await expect(toolbar(page)).toContainText('已选 1 项');
    await row(page, f.topic.id).click(); await expect(toolbar(page).getByRole('button', { name: '移至分组', exact: true })).toBeDisabled();
    await toolbar(page).getByRole('button', { name: '查看', exact: true }).click();
    await dialog(page, '已选 2 个对话').getByRole('button', { name: '取消选择话题', exact: true }).click();
    await dialog(page, '已选 1 个对话').getByRole('button', { name: '取消', exact: true }).click();
    await expect(toolbar(page).getByRole('button', { name: '移至分组', exact: true })).toBeEnabled();
    expect(await f.hub.store.db.get('SELECT COUNT(*) AS n FROM conversation_batch_requests')).toEqual({ n: 0 });
  } finally { await f.close(); }
});

test('folder revision conflict changes nothing and retains selection for an explicit retry', async ({ page }) => {
  const f = await fixture();
  try {
    await pair(page, f.hub); await selectMultiple(page, 'same'); await addSecond(page);
    const move = await openMove(page); await move.getByRole('radio', { name: '工作', exact: true }).click();
    await f.folders.change('owner', { type: 'rename', id: 'work', name: '新工作', revision: 2 });
    await move.getByRole('button', { name: '移动 2 个对话', exact: true }).click();
    await expect(move.getByRole('alert')).toContainText('分组已变化');
    expect((await f.folders.read('owner')).assignments).toEqual([]);
    await move.getByRole('radio', { name: '新工作', exact: true }).click();
    await move.getByRole('button', { name: '移动 2 个对话', exact: true }).click(); await expect(move).toHaveCount(0);
    expect((await f.folders.read('owner')).assignments).toHaveLength(2);
  } finally { await f.close(); }
});

test('lost archive receipt survives reload and cannot re-archive a conversation restored afterwards', async ({ page }) => {
  const f = await fixture();
  try {
    await pair(page, f.hub); await selectMultiple(page, 'same'); await addSecond(page);
    await page.route('**/api/conversations/batch', async route => { await route.fetch(); await route.abort('failed'); }, { times: 1 });
    await toolbar(page).getByRole('button', { name: '删除', exact: true }).click();
    const remove = dialog(page, '删除选中对话'); await remove.getByRole('button', { name: '删除 2 个对话', exact: true }).click();
    await expect(remove.getByRole('alert')).toContainText('结果待确认');
    await f.hub.store.updateConversation('owner', 'same', { archived: false });
    await page.reload(); await waitForClientOnline(page);
    await expect(toolbar(page)).toContainText('删除结果待确认');
    await toolbar(page).getByRole('button', { name: '核对', exact: true }).click();
    await dialog(page, '删除选中对话').getByRole('button', { name: '重试删除 2 个对话', exact: true }).click();
    await expect(dialog(page, '删除选中对话')).toHaveCount(0);
    expect((await f.hub.store.conversationInTransaction('same')).archived).toBe(false);
    expect((await f.hub.store.conversationInTransaction('second')).archived).toBe(true);
    expect(await f.hub.store.db.get('SELECT COUNT(*) AS n FROM conversation_batch_requests')).toEqual({ n: 1 });
  } finally { await f.close(); }
});

test('combined hosts with identical conversation IDs cannot join the wrong host batch', async ({ page }) => {
  const a = await fixture('主机 A'), b = await fixture('主机 B', [a.hub.url]);
  try {
    await pair(page, a.hub); await pair(page, b.hub, true);
    const rows = sidebar(page).locator('[data-conversation-id="same"]'); await expect(rows).toHaveCount(2);
    await selectMultiple(page, 'same', rows.first());
    await expect(rows.last()).toBeDisabled();
    await expect(rows.last()).toHaveAttribute('title', '请先完成此主机的整理');
    await rows.first().click(); await expect(toolbar(page)).toContainText('已选 0 项');
    await expect(rows.last()).toBeEnabled(); await rows.last().click();
    await expect(toolbar(page)).toContainText('已选 1 项');
    expect(await a.hub.store.db.get('SELECT COUNT(*) AS n FROM conversation_batch_requests')).toEqual({ n: 0 });
    expect(await b.hub.store.db.get('SELECT COUNT(*) AS n FROM conversation_batch_requests')).toEqual({ n: 0 });
  } finally { await a.close(); await b.close(); }
});

test('phone deletion keeps the list visible and replaces its archived current selection without touching drafts', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const f = await fixture();
  try {
    await pair(page, f.hub); await row(page, 'same').click();
    await workspace(page).getByRole('textbox', { name: '消息', exact: true }).fill('保留手机草稿');
    await openMobileHome(page); await selectMultiple(page, 'same'); await addSecond(page);
    await page.getByRole('group', { name: '批量整理对话' }).getByRole('button', { name: '删除', exact: true }).click();
    await dialog(page, '删除选中对话').getByRole('button', { name: '删除 2 个对话', exact: true }).click();
    await expect(dialog(page, '删除选中对话')).toHaveCount(0); await expect(mobileHome(page)).toBeVisible();
    await expect(workspace(page).getByRole('heading', { name: '旅行计划', exact: true, includeHidden: true })).toHaveCount(0);
    await f.hub.store.updateConversation('owner', 'same', { archived: false });
    await page.reload(); await waitForClientOnline(page); await row(page, 'same').click();
    await expect(workspace(page).getByRole('textbox', { name: '消息', exact: true })).toHaveValue('保留手机草稿');
  } finally { await f.close(); }
});

test('ADHD multi-select leaves pane membership and input drafts intact', async ({ page }, info) => {
  const f = await fixture();
  try {
    await pair(page, f.hub); await page.getByRole('button', { name: '打开 ADHD 模式', exact: true }).click();
    const pick = page.getByRole('checkbox', { name: '加入面板：整理测试主机 · 旅行计划', exact: true });
    await pick.check();
    const panes = page.locator('.adhd-pane'); const before = await panes.count();
    const rows = page.locator('.adhd-picker-list [data-conversation-id]');
    await selectMultiple(page, 'same', rows.filter({ hasText: '旅行计划' }));
    await rows.filter({ hasText: '产品讨论' }).click();
    await expect(toolbar(page)).toContainText('已选 2 项'); await expect(panes).toHaveCount(before);
    await expect(page.getByRole('checkbox', { name: /^加入面板：/ })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('desktop-adhd-selection.png') });
    await page.getByRole('textbox', { name: '筛选面板对话', exact: true }).fill('找不到的关键词');
    await expect(toolbar(page)).toContainText('已选 2 项');
    await toolbar(page).getByRole('button', { name: '已选 2 项', exact: true }).click();
    await expect(dialog(page, '已选 2 个对话')).toContainText('旅行计划');
    await expect(dialog(page, '已选 2 个对话')).toContainText('产品讨论');
    await dialog(page, '已选 2 个对话').getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('textbox', { name: '筛选面板对话', exact: true }).fill('');
    await toolbar(page).getByRole('button', { name: '取消多选', exact: true }).click();
    await expect(pick).toBeChecked();
    await expect(page.getByRole('checkbox', { name: '加入面板：整理测试主机 · 产品讨论', exact: true })).not.toBeChecked();
  } finally { await f.close(); }
});

test('older Hosts allow selecting but explain disabled bulk actions without falling back to single writes', async ({ page }) => {
  const f = await fixture(); let writes = 0;
  try {
    await page.routeWebSocket('**/ws', socket => {
      const server = socket.connectToServer(); server.onMessage(data => {
        const frame = JSON.parse(String(data));
        if (frame.type === 'ready') frame.serverCapabilities = frame.serverCapabilities.filter((cap: string) => cap !== 'conversations.batch.v1');
        socket.send(JSON.stringify(frame));
      });
    });
    page.on('request', request => { if (request.method() !== 'GET' && request.url().includes('/api/conversations')) writes++; });
    await pair(page, f.hub); await selectMultiple(page, 'same'); await addSecond(page);
    await expect(toolbar(page)).toContainText('升级此主机');
    await expect(toolbar(page).getByRole('button', { name: '删除', exact: true })).toBeDisabled();
    await expect(toolbar(page).getByRole('button', { name: '移至分组', exact: true })).toBeDisabled();
    expect(writes).toBe(0);
  } finally { await f.close(); }
});

test('a request that never arrived is explicitly retried, while an unknown operation can be discarded without writing', async ({ page }) => {
  const f = await fixture();
  try {
    await pair(page, f.hub); await selectMultiple(page, 'same');
    await page.route('**/api/conversations/batch', route => route.abort('failed'), { times: 1 });
    await toolbar(page).getByRole('button', { name: '删除', exact: true }).click();
    const remove = dialog(page, '删除选中对话'); await remove.getByRole('button', { name: '删除 1 个对话', exact: true }).click();
    await expect(remove.getByRole('alert')).toContainText('结果待确认');
    await expect(remove).toContainText('重试会继续删除这 1 个对话，已完成的不会重复执行');
    expect((await f.hub.store.conversationInTransaction('same')).archived).toBe(false);
    await remove.getByRole('button', { name: '不再重试', exact: true }).click();
    await dialog(page, '放弃本地操作记录').getByRole('button', { name: '放弃记录', exact: true }).click();
    await expect(toolbar(page)).toHaveCount(0);
    expect(await f.hub.store.db.get('SELECT COUNT(*) AS n FROM conversation_batch_requests')).toEqual({ n: 0 });
    await selectMultiple(page, 'same');
    await page.route('**/api/conversations/batch', route => route.abort('failed'), { times: 1 });
    await toolbar(page).getByRole('button', { name: '删除', exact: true }).click();
    await remove.getByRole('button', { name: '删除 1 个对话', exact: true }).click();
    await expect(remove.getByRole('alert')).toContainText('结果待确认');
    await remove.getByRole('button', { name: '重试删除 1 个对话', exact: true }).click();
    await expect(remove).toHaveCount(0);
    expect((await f.hub.store.conversationInTransaction('same')).archived).toBe(true);
    expect(await f.hub.store.db.get('SELECT COUNT(*) AS n FROM conversation_batch_requests')).toEqual({ n: 1 });
  } finally { await f.close(); }
});

test('an unreadable local pending record has a confirmed escape without touching the Host', async ({ page }) => {
  const f = await fixture();
  try {
    await pair(page, f.hub);
    await page.evaluate(async () => {
      const info = (await indexedDB.databases()).find(item => item.name === 'tarocub-v1' || item.name?.startsWith('tarocub-host-'))!;
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open(info.name!); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      try { await new Promise<void>((resolve, reject) => { const tx = db.transaction('settings', 'readwrite'); tx.objectStore('settings').put('{invalid', 'operation:conversation-batch'); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); } finally { db.close(); }
    });
    await page.reload(); await waitForClientOnline(page); await expect(toolbar(page)).toContainText('记录无法读取');
    await toolbar(page).getByRole('button', { name: '处理记录', exact: true }).click();
    await dialog(page, '放弃本地操作记录').getByRole('button', { name: '放弃记录', exact: true }).click();
    await selectMultiple(page, 'same'); await expect(toolbar(page).getByRole('button', { name: '删除', exact: true })).toBeEnabled();
    expect(await f.hub.store.db.get('SELECT COUNT(*) AS n FROM conversation_batch_requests')).toEqual({ n: 0 });
  } finally { await f.close(); }
});

test('an item archived in a second window is marked unavailable and can be removed from the whole selection', async ({ page, context }) => {
  const f = await fixture(); const other = await context.newPage();
  try {
    await pair(page, f.hub); await selectMultiple(page, 'same'); await addSecond(page);
    await other.goto(f.hub.url); await waitForClientOnline(other); await selectMultiple(other, 'second');
    await toolbar(other).getByRole('button', { name: '删除', exact: true }).click();
    await dialog(other, '删除选中对话').getByRole('button', { name: '删除 1 个对话', exact: true }).click();
    await expect(dialog(other, '删除选中对话')).toHaveCount(0);
    await expect(toolbar(page)).toContainText('部分对话已不可用');
    await toolbar(page).getByRole('button', { name: '已选 2 项', exact: true }).click();
    await expect(dialog(page, '已选 2 个对话').locator('li').filter({ hasText: '产品讨论' })).toContainText('已不可用');
    await dialog(page, '已选 2 个对话').getByRole('button', { name: '移除 1 个不可用项', exact: true }).click();
    await dialog(page, '已选 1 个对话').getByRole('button', { name: '取消', exact: true }).click();
    await expect(toolbar(page)).toContainText('已选 1 项'); await expect(toolbar(page).getByRole('button', { name: '删除', exact: true })).toBeEnabled();
    expect((await f.hub.store.conversationInTransaction('same')).archived).toBe(false);
  } finally { await other.close(); await f.close(); }
});

test('a competing pending batch closes the old confirmation instead of swapping its destructive target in place', async ({ page, context }) => {
  const f = await fixture(); const other = await context.newPage();
  try {
    await pair(page, f.hub); await other.goto(f.hub.url); await waitForClientOnline(other);
    await selectMultiple(page, 'same'); await selectMultiple(other, 'second');
    await toolbar(page).getByRole('button', { name: '删除', exact: true }).click();
    await toolbar(other).getByRole('button', { name: '删除', exact: true }).click();
    await page.route('**/api/conversations/batch', route => route.abort('failed'), { times: 1 });
    await dialog(page, '删除选中对话').getByRole('button', { name: '删除 1 个对话', exact: true }).click();
    await expect(dialog(page, '删除选中对话').getByRole('alert')).toContainText('结果待确认');
    await dialog(other, '删除选中对话').getByRole('button', { name: '删除 1 个对话', exact: true }).click();
    await expect(dialog(other, '删除选中对话')).toHaveCount(0);
    await expect(toolbar(other)).toContainText('另一窗口已有批量操作');
    await expect(row(other, 'second')).toHaveAttribute('aria-checked', 'true');
    await expect(row(other, 'same')).toHaveAttribute('aria-checked', 'false');
    await expect(toolbar(other).getByRole('button', { name: '删除', exact: true })).toBeDisabled();
    expect(await f.hub.store.db.get('SELECT COUNT(*) AS n FROM conversation_batch_requests')).toEqual({ n: 0 });
    await toolbar(other).getByRole('button', { name: '核对', exact: true }).click();
    await expect(dialog(other, '删除选中对话')).toContainText('旅行计划');
    await expect(dialog(other, '删除选中对话')).not.toContainText('产品讨论');
    await dialog(other, '删除选中对话').getByRole('button', { name: '不再重试', exact: true }).click();
    await dialog(other, '放弃本地操作记录').getByRole('button', { name: '放弃记录', exact: true }).click();
    // Window A still has the restored request in memory. Its retry must not
    // recreate the record B just explicitly discarded.
    await dialog(page, '删除选中对话').getByRole('button', { name: '重试删除 1 个对话', exact: true }).click();
    await expect(dialog(page, '删除选中对话')).toHaveCount(0);
    await expect(workspace(page)).toContainText('该操作已在其他窗口处理或放弃');
    expect(await f.hub.store.db.get('SELECT COUNT(*) AS n FROM conversation_batch_requests')).toEqual({ n: 0 });
    expect((await f.hub.store.conversationInTransaction('same')).archived).toBe(false);
    expect((await f.hub.store.conversationInTransaction('second')).archived).toBe(false);
  } finally { await other.close(); await f.close(); }
});


test.describe('phone destructive confirmation', () => {
  test.use({ hasTouch: true });
  for (const width of [390, 320]) test(`repeated taps on the delete entry cannot confirm deletion (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 }); const f = await fixture();
    try {
      await pair(page, f.hub); await selectMultiple(page, 'same'); await addSecond(page);
      const entry = mobileHome(page).getByRole('group', { name: '批量整理对话' }).getByRole('button', { name: '删除', exact: true });
      const bounds = (await entry.boundingBox())!;
      const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
      await page.touchscreen.tap(x, y);
      const confirm = dialog(page, '删除选中对话').getByRole('button', { name: '删除 2 个对话', exact: true });
      await expect(confirm).toBeVisible();
      const target = (await confirm.boundingBox())!;
      expect(x < target.x || x > target.x + target.width || y < target.y || y > target.y + target.height).toBe(true);
      await page.waitForTimeout(200); await page.touchscreen.tap(x, y);
      expect((await f.hub.store.conversationInTransaction('same')).archived).toBe(false);
      expect((await f.hub.store.conversationInTransaction('second')).archived).toBe(false);
      expect(await f.hub.store.db.get('SELECT COUNT(*) AS n FROM conversation_batch_requests')).toEqual({ n: 0 });
      if (!await confirm.isVisible()) await entry.click();
      await confirm.click(); await expect(dialog(page, '删除选中对话')).toHaveCount(0);
      expect((await f.hub.store.conversationInTransaction('same')).archived).toBe(true);
    } finally { await f.close(); }
  });
});

for (const width of [1360, 390, 320]) test(`selection guidance never moves rows under repeated clicks (${width}px)`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 }); const f = await fixture();
  try {
    await f.hub.store.db.run("INSERT INTO users VALUES('other','Other','member')");
    await f.hub.store.db.run("UPDATE conversations SET owner_id='other' WHERE id='second'");
    await pair(page, f.hub); await selectMultiple(page, 'same');
    const original = (await row(page, 'same').boundingBox())!;
    const height = (await toolbar(page).boundingBox())!.height;
    const x = original.x + original.width / 2, y = original.y + original.height / 2;
    await page.mouse.click(x, y);
    await expect(toolbar(page)).toContainText('已选 0 项');
    expect((await row(page, 'same').boundingBox())!.y).toBe(original.y);
    expect((await toolbar(page).boundingBox())!.height).toBe(height);
    await page.mouse.click(x, y);
    await expect(row(page, 'same')).toHaveAttribute('aria-checked', 'true');
    await expect(row(page, 'second')).toHaveAttribute('aria-checked', 'false');
    await addSecond(page);
    await expect(page.getByRole('group', { name: '批量整理对话' }).filter({ visible: true }).getByRole('button', { name: '删除', exact: true })).toBeDisabled();
    expect((await row(page, 'same').boundingBox())!.y).toBe(original.y);
    expect((await toolbar(page).boundingBox())!.height).toBe(height);
    await row(page, 'second').click();
    if (width > 760) {
      await row(page, f.topic.id).click();
      await expect(toolbar(page).getByRole('button', { name: '移至分组', exact: true })).toBeDisabled();
      expect((await row(page, 'same').boundingBox())!.y).toBe(original.y);
      expect((await toolbar(page).boundingBox())!.height).toBe(height);
    }
  } finally { await f.close(); }
});

for (const width of [1360, 390, 320]) test(`bulk confirmation keeps accent selection and clear retry actions readable (${width}px)`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  const f = await fixture();
  try {
    const ids = ['same', 'second', 'third', 'extra1', 'extra2', 'extra3'];
    for (const [index, id] of ids.slice(3).entries()) {
      await f.hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES(?,'direct',?,'owner',?,?)", [id, `界面布局联合检查与较长对话名称 ${index + 1}`, Date.now(), `create_${id}`]);
      await f.hub.store.db.run("INSERT INTO conversation_members VALUES(?,'user','owner',0),(?,'bot','bot',0)", [id, id]);
    }
    await pair(page, f.hub); await selectMultiple(page, 'same');
    for (const id of ids.slice(1)) await row(page, id).click();
    await expect(toolbar(page)).toContainText('已选 6 项');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { Object.assign(document.documentElement.dataset, { theme, palette: 'mono', monoAccent: 'sage' }); }, theme);
      const check = row(page, 'same').locator('.conversation-bulk-check');
      await expect(check).toHaveCSS('background-color', 'rgb(220, 228, 214)');
      await expect(check).toHaveCSS('color', 'rgb(67, 81, 61)');
      await expect(check.locator('svg')).toHaveCSS('stroke', 'rgb(67, 81, 61)');
      await page.screenshot({ animations: 'disabled', path: info.outputPath(`selection-${theme}.png`) });
    }
    await page.evaluate(() => document.documentElement.dataset.theme = 'light');
    await page.getByRole('group', { name: '批量整理对话' }).filter({ visible: true }).getByRole('button', { name: '删除', exact: true }).click();
    const remove = dialog(page, '删除选中对话');
    await expect(remove.getByText('从列表移除，保留聊天记录、草稿和 Bot。', { exact: true })).toBeVisible();
    await expect(remove.locator('.conversation-bulk-review')).toBeHidden();
    await page.screenshot({ animations: 'disabled', path: info.outputPath('delete-confirm-collapsed.png') });
    await remove.getByText('查看已选对话', { exact: true }).click();
    await expect(remove.locator('.conversation-bulk-review li')).toHaveCount(6);
    await remove.getByText('删除后如何恢复', { exact: true }).click();
    await expect(remove.getByText(/对话可在「我的/)).toBeVisible();
    if (width <= 760) await page.setViewportSize({ width, height: 568 });
    const requests: string[] = [];
    await page.route('**/api/conversations/batch', route => { requests.push(route.request().postData()!); return route.abort('failed'); }, { times: 1 });
    await remove.getByRole('button', { name: '删除 6 个对话', exact: true }).click();
    const retry = remove.getByRole('button', { name: '重试删除 6 个对话', exact: true });
    await expect(remove.getByRole('alert')).toHaveCount(1);
    await expect(remove.getByRole('alert')).toContainText('删除结果待确认');
    await expect(remove.getByRole('button', { name: '重试原操作', exact: true })).toHaveCount(0);
    await expect(retry).toBeInViewport({ ratio: 1 });
    expect(await remove.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await remove.locator('.conversation-bulk-body').evaluate(node => node.scrollTop = node.scrollHeight);
    await expect(remove.getByRole('button', { name: '不再重试', exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ animations: 'disabled', path: info.outputPath('delete-retry-short-screen.png') });
    await page.setViewportSize({ width, height: 844 });
    for (const summary of await remove.locator('.conversation-bulk-details > summary').all()) await summary.click();
    await remove.locator('.conversation-bulk-body').evaluate(node => node.scrollTop = 0);
    await page.screenshot({ animations: 'disabled', path: info.outputPath('delete-retry.png') });
    await page.route('**/api/conversations/batch', route => { requests.push(route.request().postData()!); return route.continue(); }, { times: 1 });
    await retry.click(); await expect(remove).toHaveCount(0);
    expect(requests).toHaveLength(2); expect(requests[1]).toBe(requests[0]);
    expect(await f.hub.store.db.get('SELECT COUNT(*) AS n FROM conversation_batch_requests')).toEqual({ n: 1 });
    for (const id of ids) expect((await f.hub.store.conversationInTransaction(id)).archived).toBe(true);
  } finally { await f.close(); }
});

test('pending move names the action and keeps its original destination on retry', async ({ page }) => {
  const f = await fixture();
  try {
    await pair(page, f.hub); await selectMultiple(page, 'same');
    const move = await openMove(page);
    await move.getByRole('radio', { name: '工作', exact: true }).click();
    const requests: string[] = [];
    await page.route('**/api/conversations/batch', async route => { requests.push(route.request().postData()!); await route.fetch(); await route.abort('failed'); }, { times: 1 });
    await move.getByRole('button', { name: '移动 1 个对话', exact: true }).click();
    await expect(move.getByRole('alert')).toContainText('移动结果待确认');
    await expect(move.getByRole('alert')).toContainText('原目标分组：工作');
    await page.route('**/api/conversations/batch', route => { requests.push(route.request().postData()!); return route.continue(); }, { times: 1 });
    await move.getByRole('button', { name: '重试移动 1 个对话', exact: true }).click();
    await expect(move).toHaveCount(0);
    expect(requests).toHaveLength(2); expect(requests[1]).toBe(requests[0]);
    expect((await f.folders.read('owner')).assignments).toEqual([{ conversationId: 'same', folderId: 'work' }]);
    expect(await f.hub.store.db.get('SELECT COUNT(*) AS n FROM conversation_batch_requests')).toEqual({ n: 1 });
  } finally { await f.close(); }
});
