import { setListOption } from "./fixtures/mobile.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";

test.use({ serviceWorkers: "block" });
const workspace = (page: Page) => page.locator('.host-workspace:not([hidden])');
const sidebar = (page: Page) => workspace(page).locator('.sidebar');
const bot = (page: Page, id = "alpha") => sidebar(page).locator(`.bot-tree[data-bot-id="${id}"]`);
const toggle = (page: Page, id = "alpha") => bot(page, id).locator('.bot-tree-toggle');
const foldKey = 'tarobot-collapsed-bots-v1';
async function pair(page: Page, hub: HubServer, name = '本机验收', add = false) {
  await hub.profile.update({ name, revision: (await hub.profile.read()).revision });
  if (add) await clickAppAction(page, '连接另一台主机', workspace(page).getByRole('button', { name: '连接另一台主机', exact: true }));
  else await page.goto(hub.url);
  await page.getByLabel('主机名称', { exact: true }).fill(name);
  await page.getByLabel('Hub 地址', { exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
  await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
  await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
  await expect(workspace(page).locator('.connection-pill.online')).toBeVisible();
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bot-fold-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('alpha','研究助手','fixture',1),('beta','写作助手','fixture',1),('empty','空白助手','fixture',1)");
  const chats = [];
  for (let i = 0; i < 3; i++) chats.push(await hub.store.createConversation('owner', ['alpha'], `研究对话 ${i + 1}`, `chat-${i}`));
  const other = await hub.store.createConversation('owner', ['beta'], '保留的对话', 'other');
  return { root, hub, chats, other, close: async () => { await hub.close(); await rm(root, { recursive: true, force: true }); } };
}

test('folds preserve the current chat and draft, survive remount/reload and expand on both create entries', async ({ page }) => {
  const f = await fixture();
  try {
    await pair(page, f.hub);
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(bot(page).locator('.conversation-row')).toHaveCount(3);
    await bot(page).locator(`[data-conversation-id="${f.chats[0]!.id}"]`).click();
    const composer = workspace(page).getByRole('textbox', { name: '消息', exact: true });
    await composer.fill('折叠不能影响这份草稿');
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle(page)).toBeFocused();
    await expect(bot(page).locator('.conversation-row')).toHaveCount(0);
    await expect(bot(page).locator('.bot-fold-count')).toHaveText('3');
    await expect(bot(page).locator('.bot-identity')).toHaveAttribute('aria-current', 'page');
    const selectedColor = await bot(page).locator('.bot-identity').evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => undefined))); return getComputedStyle(node).backgroundColor; });
    await bot(page).locator('.bot-identity').hover();
    await expect(bot(page).locator('.bot-identity')).toHaveCSS('background-color', selectedColor);
    await expect(bot(page).locator('.avatar i')).toHaveCSS('border-top-color', selectedColor);
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await expect.poll(() => bot(page).locator('.bot-identity').evaluate(node => getComputedStyle(node).backgroundColor === getComputedStyle(node.querySelector('.avatar i')!).borderTopColor)).toBe(true);
    await page.evaluate(() => document.documentElement.dataset.theme = 'light');
    await expect(toggle(page)).toHaveAccessibleDescription('3 个对话 · 含当前对话');
    await expect(workspace(page).getByRole('heading', { name: f.chats[0]!.title, exact: true })).toBeVisible();
    await expect(composer).toHaveValue('折叠不能影响这份草稿');
    await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    await sidebar(page).getByRole('button', { name: '按 Bot', exact: true }).click();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    // Layout preferences are stored asynchronously in IndexedDB; wait for the
    // explicit save boundary before simulating an App restart.
    await expect.poll(() => page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('tarocub-hosts-v1'); request.onsuccess = () => resolve(request.result); });
      try { return await new Promise<string>(resolve => { const request = db.transaction('meta').objectStore('meta').get('preferences'); request.onsuccess = () => resolve(JSON.parse(request.result).sidebarLayout); }); } finally { db.close(); }
    })).toBe('bots');
    await page.reload();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(composer).toHaveValue('折叠不能影响这份草稿');
    await toggle(page).press('ArrowRight'); await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    await toggle(page).press('ArrowLeft'); await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await toggle(page).press('Space'); await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    await toggle(page).press('Enter'); await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await bot(page).getByRole('button', { name: '打开 研究助手', exact: true }).click();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    for (const viaMenu of [false, true]) {
      await toggle(page).click();
      if (viaMenu) {
        await bot(page).getByRole('button', { name: '打开 研究助手', exact: true }).press('Shift+F10');
        await page.getByRole('menuitem', { name: '新建对话', exact: true }).click();
      } else await bot(page).getByRole('button', { name: '为 研究助手 新建对话', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '新建对话', exact: true });
      await expect(dialog.getByRole('checkbox', { name: /研究助手/ })).toBeChecked();
      await dialog.getByPlaceholder('为这段对话起个名字').fill(`折叠后新建 ${viaMenu}`);
      await dialog.getByRole('button', { name: '创建对话', exact: true }).click();
      await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
      await expect(bot(page).getByText(`折叠后新建 ${viaMenu}`, { exact: true })).toBeVisible();
    }
  } finally { await page.close(); await f.close(); }
});

test('folds aggregate hidden unread and attention while updates, pins and offline visibility keep the choice', async ({ page }) => {
  const f = await fixture();
  try {
    const group = await f.hub.store.createConversation('owner', ['alpha'], '保留群组', 'group', { type: 'group' });
    await pair(page, f.hub);
    const pinRow = bot(page).locator(`[data-conversation-id="${f.chats[0]!.id}"]`);
    await pinRow.click({ button: 'right' }); await page.getByRole('menuitem', { name: '全局置顶', exact: true }).click(); await page.keyboard.press('Escape');
    await bot(page, 'beta').locator('.conversation-row').click();
    await toggle(page).click();
    await expect(bot(page).locator('.bot-fold-count')).toHaveText('2');
    await expect(sidebar(page).locator(`[data-conversation-id="${f.chats[0]!.id}"]`)).toBeVisible();
    await f.hub.store.publishBotMessage('alpha', { conversationId: f.chats[1]!.id, blocks: [{ type: 'text', text: '收起时到达的新消息' }], status: 'complete' });
    const request = await f.hub.store.publishBotMessage('alpha', { conversationId: f.chats[2]!.id, blocks: [{ type: 'card', title: '请求确认', elements: [{ type: 'button', actionId: 'approve', text: '允许此次', value: { cctb_lark: 'approval', requestId: 'approval', decision: 'allow_once' } }] }], status: 'complete' });
    await expect(bot(page).locator('.bot-fold-signals .unread-badge')).toHaveText('2');
    await expect(bot(page).locator('.folder-attention')).toBeVisible();
    await expect(toggle(page)).toHaveAccessibleDescription('2 个对话 · 2 条新消息 · 1 项待处理');
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(workspace(page).getByRole('heading', { name: f.other.title, exact: true })).toBeVisible();
    await f.hub.store.publishBotMessage('alpha', { id: request.id, conversationId: f.chats[2]!.id, blocks: [{ type: 'text', text: '已处理' }], status: 'complete' });
    await expect(bot(page).locator('.folder-attention')).toHaveCount(0);
    // A pinned chat remains reachable; unpin returns it to the folded tree.
    await sidebar(page).locator(`[data-conversation-id="${f.chats[0]!.id}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '取消全局置顶', exact: true }).click();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebar(page).locator(`[data-conversation-id="${f.chats[0]!.id}"]`)).toHaveCount(0);
    await expect(toggle(page)).toBeFocused();
    // Group pinning must keep its own focus even when a member Bot is folded.
    const groupRow = sidebar(page).locator(`[data-conversation-id="${group.id}"]`);
    await groupRow.click({ button: 'right' }); await page.getByRole('menuitem', { name: '全局置顶', exact: true }).click(); await page.keyboard.press('Escape');
    await groupRow.click({ button: 'right' }); await page.getByRole('menuitem', { name: '取消全局置顶', exact: true }).click(); await page.keyboard.press('Escape');
    await expect(groupRow).toBeFocused();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await f.hub.store.botStatus('alpha', { online: 0 });
    await (f.hub as unknown as { broadcastBotStatus(id: string): Promise<void> }).broadcastBotStatus('alpha');
    await expect(bot(page)).toHaveCount(0);
    await setListOption(page, '显示未连接 Bot', true);
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  } finally { await page.close(); await f.close(); }
});

test('host grouping, same Bot IDs and a different paired identity do not leak folds', async ({ page, browser }) => {
  const f = await fixture();
  const b = await HubServer.start({ stateDir: path.join(f.root, 'second'), origins: [f.hub.url] });
  try {
    await b.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('alpha','远端助手','fixture',1)");
    await b.store.createConversation('owner', ['alpha'], '另一主机的对话', 'remote');
    await pair(page, f.hub, '主机甲'); await pair(page, b, '主机乙', true);
    const aTree = () => sidebar(page).locator('.bot-tree').filter({ has: page.getByRole('button', { name: '打开 研究助手', exact: true }) });
    const bTree = () => sidebar(page).locator('.bot-tree').filter({ has: page.getByRole('button', { name: '打开 远端助手', exact: true }) });
    // Pin before folding so unpinning later removes a separate CombinedSidebar
    // slice; the target disclosure must keep focus after that slice unmounts.
    await aTree().locator(`[data-conversation-id="${f.chats[0]!.id}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '全局置顶', exact: true }).click(); await page.keyboard.press('Escape');
    await aTree().locator('.bot-tree-toggle').click();
    await sidebar(page).locator(`[data-conversation-id="${f.chats[0]!.id}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '取消全局置顶', exact: true }).click();
    await expect(sidebar(page).locator(`[data-conversation-id="${f.chats[0]!.id}"]`)).toHaveCount(0);
    await expect(aTree().locator('.bot-tree-toggle')).toBeFocused();
    await expect(bTree().locator('.bot-tree-toggle')).toHaveAttribute('aria-expanded', 'true');
    await setListOption(page, '按主机分组', true);
    await expect(aTree().locator('.bot-tree-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(bTree().locator('.conversation-row')).toBeVisible();
    await setListOption(page, '按主机分组', false);
    await page.reload();
    await expect(aTree().locator('.bot-tree-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(bTree().locator('.bot-tree-toggle')).toHaveAttribute('aria-expanded', 'true');
    const saved = await page.evaluate(key => localStorage.getItem(key)!, foldKey);
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      await context.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: foldKey, value: saved });
      const second = await context.newPage(); await pair(second, f.hub);
      await expect(toggle(second)).toHaveAttribute('aria-expanded', 'true');
      expect(await bot(second).getAttribute('data-bot-fold-scope')).not.toBe(await aTree().getAttribute('data-bot-fold-scope'));
    } finally { await context.close(); }
  } finally { await page.close(); await b.close(); await f.close(); }
});

test('empty and fully globally pinned Bots reserve alignment without a useless disclosure', async ({ page }) => {
  const f = await fixture();
  try {
    await pair(page, f.hub);
    await expect(toggle(page, 'empty')).toHaveCount(0);
    await expect(bot(page, 'empty').locator('.bot-tree-disclosure-space')).toHaveCount(1);
    const only = bot(page, 'beta').locator('.conversation-row');
    await only.click({ button: 'right' }); await page.getByRole('menuitem', { name: '全局置顶', exact: true }).click(); await page.keyboard.press('Escape');
    await expect(toggle(page, 'beta')).toHaveCount(0);
    await expect(sidebar(page).locator(`[data-conversation-id="${f.other.id}"]`)).toBeVisible();
    const positions = await sidebar(page).locator('.bot-identity .avatar').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().x));
    expect(new Set(positions).size).toBe(1);
  } finally { await page.close(); await f.close(); }
});

for (const denied of [false, true]) test(`folds work with ${denied ? 'unavailable' : 'invalid'} local storage`, async ({ page }) => {
  const f = await fixture();
  try {
    const group = await f.hub.store.createConversation('owner', ['alpha'], '折叠测试群', 'fold-group', { type: 'group' });
    await f.hub.store.createConversation('owner', ['alpha'], '保留话题', 'fold-topic', { parentId: group.id });
    await page.addInitScript(({ keys, denied }) => {
      if (!denied) { for (const key of keys) localStorage.setItem(key, '{broken'); }
      else {
        const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
        Storage.prototype.getItem = function (name) { if (keys.includes(name)) throw new DOMException('Denied', 'SecurityError'); return get.call(this, name); };
        Storage.prototype.setItem = function (name, value) { if (keys.includes(name)) throw new DOMException('Denied', 'QuotaExceededError'); return set.call(this, name, value); };
      }
    }, { keys: [foldKey, 'tarobot-collapsed-group-topics-v1'], denied });
    await pair(page, f.hub); await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    await toggle(page).click();
    await sidebar(page).getByRole('button', { name: '收起「折叠测试群」的话题', exact: true }).click();
    await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    await sidebar(page).getByRole('button', { name: '按 Bot', exact: true }).click();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebar(page).getByRole('button', { name: '展开「折叠测试群」的话题', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await toggle(page).click(); await expect(bot(page).locator('.conversation-row')).toHaveCount(3);
    await sidebar(page).getByRole('button', { name: '展开「折叠测试群」的话题', exact: true }).click();
    await expect(sidebar(page).getByText('保留话题', { exact: true })).toBeVisible();
  } finally { await page.close(); await f.close(); }
});

test('disclosures fit compact sidebars and themes, retain existing typography and keep motion enabled', async ({ page }, info) => {
  const f = await fixture();
  const remote = await HubServer.start({ stateDir: path.join(f.root, 'remote'), origins: [f.hub.url] });
  try {
    await remote.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('remote','远端助手','fixture',1)");
    await remote.store.createConversation('owner', ['remote'], '远端对话', 'remote');
    await f.hub.store.db.run("UPDATE bots SET name='用于验证长名字仍能清楚显示的研究助手',engine='claude',model='claude-opus-5-5[1m]' WHERE id='alpha'");
    await pair(page, f.hub, '一台名字较长的运行主机');
    await pair(page, remote, '另一台主机', true);
    await bot(page, 'beta').locator('.conversation-row').click();
    await f.hub.store.publishBotMessage('alpha', { conversationId: f.chats[0]!.id, blocks: [{ type: 'text', text: '收起时到达的新消息' }], status: 'complete' });
    await f.hub.store.publishBotMessage('alpha', { conversationId: f.chats[1]!.id, blocks: [{ type: 'card', elements: [{ type: 'button', actionId: 'approve', text: '允许此次', value: { cctb_lark: 'approval', requestId: 'visual', decision: 'allow_once' } }] }], status: 'complete' });
    await page.setViewportSize({ width: 1000, height: 800 });
    await bot(page).locator(`[data-conversation-id="${f.chats[2]!.id}"]`).click();
    const typography = () => bot(page).locator('.bot-identity').evaluate(node => ({ avatar: node.querySelector('.avatar')!.getBoundingClientRect().width, font: getComputedStyle(node.querySelector('strong')!).fontSize, height: node.getBoundingClientRect().height }));
    const before = await typography();
    // Short, expanded Bot identities retain enough of the host label to identify
    // the source, instead of globally squeezing every badge to one character.
    expect(await bot(page, 'beta').locator('.host-source-badge').evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThanOrEqual(70);
    for (const palette of ['white-violet', 'sage', 'tty', 'cli', 'pixel']) {
      await page.evaluate(palette => document.documentElement.dataset.palette = palette, palette);
      for (const dark of [false, true]) {
        await page.evaluate(dark => document.documentElement.dataset.theme = dark ? 'dark' : 'light', dark);
        await toggle(page).click();
        await expect(toggle(page)).toHaveCSS('opacity', '1');
        await expect(toggle(page)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        const geometry = await bot(page).evaluate(node => {
          const head = node.querySelector('.bot-tree-heading')!, avatar = head.querySelector('.avatar')!, button = head.querySelector('.bot-tree-toggle')!, identity = head.querySelector('.bot-identity')!, plus = head.querySelector('.icon-button')!;
          return { overflow: head.scrollWidth > head.clientWidth, width: button.getBoundingClientRect().width, touching: button.getBoundingClientRect().right <= identity.getBoundingClientRect().left, plus: plus.getBoundingClientRect().right <= head.getBoundingClientRect().right + 1, avatar: avatar.getBoundingClientRect().width, labelWidth: identity.querySelector('.bot-name-label')!.getBoundingClientRect().width, font: getComputedStyle(identity.querySelector('strong')!).fontSize, height: identity.getBoundingClientRect().height };
        });
        expect(geometry).toMatchObject({ overflow: false, touching: true, plus: true });
        expect(geometry.width).toBeGreaterThanOrEqual(24);
        expect(geometry.labelWidth).toBeGreaterThanOrEqual(48);
        if (palette === 'white-violet') {
          expect({ avatar: geometry.avatar, font: geometry.font, height: geometry.height }).toEqual(before);
          if (!dark) await sidebar(page).screenshot({ path: info.outputPath('fold-light.png') });
        }
      }
      if (await toggle(page).getAttribute('aria-expanded') === 'true') await toggle(page).click();
      await sidebar(page).screenshot({ path: info.outputPath(`fold-${palette}.png`) });
    }
    // The real resize handle permits a 200px sidebar; check that lower bound too.
    await sidebar(page).getByRole('separator', { name: '调整侧栏宽度' }).press('Home');
    expect(await bot(page).locator('.bot-tree-heading').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.evaluate(() => document.documentElement.dataset.motion = 'reduced');
    await expect(toggle(page).locator('svg')).not.toHaveCSS('transition-duration', '0s');
    await page.evaluate(() => document.documentElement.dataset.motion = 'full');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(toggle(page).locator('svg')).not.toHaveCSS('transition-duration', '0s');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(toggle(page).locator('svg')).toHaveCSS('transition-duration', '0.14s');
    await expect(bot(page).locator('.bot-tree-conversations')).toHaveCSS('transition-duration', '0s');
  } finally { await page.close(); await remote.close(); await f.close(); }
});


test('group pins stay inside the Bot and survive a global pin round trip', async ({ page }) => {
  const f = await fixture();
  try {
    await pair(page, f.hub);
    const id = f.chats[0]!.id;
    const target = () => sidebar(page).locator(`[data-conversation-id="${id}"]`);
    await target().click({ button: 'right' });
    await page.getByRole('menuitem', { name: '分组置顶', exact: true }).click();
    await expect(bot(page).locator('.conversation-row')).toHaveCount(3);
    await expect(bot(page).locator('.conversation-row').first()).toHaveAttribute('data-conversation-id', id);
    await expect(sidebar(page).locator('.global-pin-section')).toHaveCount(0);
    await target().click({ button: 'right' });
    await page.getByRole('menuitem', { name: '全局置顶', exact: true }).click();
    await expect(sidebar(page).locator('.global-pin-section .conversation-row')).toHaveAttribute('data-conversation-id', id);
    await expect(bot(page).locator('.conversation-row')).toHaveCount(2);
    await target().click({ button: 'right' });
    await page.getByRole('menuitem', { name: '取消全局置顶', exact: true }).click();
    await expect(bot(page).locator('.conversation-row').first()).toHaveAttribute('data-conversation-id', id);
    await expect(target().getByLabel('已分组置顶', { exact: true })).toBeVisible();
    await expect(target()).toBeFocused();
    await page.reload();
    await expect(bot(page).locator('.conversation-row').first()).toHaveAttribute('data-conversation-id', id);
  } finally { await page.close(); await f.close(); }
});
