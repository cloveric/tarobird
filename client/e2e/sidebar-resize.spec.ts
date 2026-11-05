import { setListOption } from "./fixtures/mobile.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots } from "./fixtures/mobile.js";
import { HOST_PROFILE_KEY } from "../../src/hub/host-profile.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";

test.use({ serviceWorkers: "block" });
const workspace = (page: Page) => page.locator('.host-workspace:not([hidden])');
const sidebar = (page: Page) => workspace(page).locator('.sidebar');
const separator = (page: Page) => workspace(page).getByRole('separator', { name: '调整侧栏宽度' });
async function pair(page: Page, hub: HubServer, name: string, add = false) {
  await hub.store.db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [HOST_PROFILE_KEY, JSON.stringify({ name, revision: 1 })]);
  if (add) await clickAppAction(page, "连接另一台主机", workspace(page).getByRole("button", { name: "连接另一台主机", exact: true }));
  else await page.goto(hub.url);
  await page.getByRole("textbox", { name: "主机名称", exact: true }).fill(name);
  await page.getByRole("textbox", { name: "Hub 地址", exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
  await expect(workspace(page).locator(".connection-pill.online")).toBeVisible();
}
async function drag(page: Page, delta: number, release = true) {
  const rect = (await separator(page).boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + 260);
  await page.mouse.down(); await page.mouse.move(rect.x + rect.width / 2 + delta, rect.y + 260, { steps: 8 });
  if (release) await page.mouse.up();
}
async function seed(hub: HubServer, title: string) {
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','侧栏助手','fixture')");
  const chat = await hub.store.createConversation('owner', ['bot'], title, title);
  await hub.store.publishBotMessage('bot', { conversationId: chat.id, blocks: [{ type: 'text', text: '调整侧栏时，聊天内容与草稿保持不变。' }] });
  return chat;
}

test('Bot and topic previews fill resized rows while unread badges stay at the trailing edge', async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sidebar-preview-width-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  try {
    const read = await seed(hub, '侧栏内容宽度');
    const title = '项目资料整理与第四页修正版字体检查的完整讨论';
    const preview = '已完成：整理了项目资料、核对最新文档的字体和排版，并保留上一轮修改，下一步检查导出结果。';
    const unread = await hub.store.createConversation('owner', ['bot'], title, 'unread');
    const group = await hub.store.createConversation('owner', ['bot'], '项目工作群', 'group', { type: 'group' });
    const topic = await hub.store.createConversation('owner', [], title, 'topic', { parentId: group.id });
    await hub.store.publishBotMessage('bot', { conversationId: read.id, blocks: [{ type: 'text', text: preview }] });
    await pair(page, hub, '主机 A');
    const selected = sidebar(page).locator(`[data-conversation-id="${read.id}"]`);
    await selected.click();
    await expect(selected.locator('.unread-badge')).toHaveCount(0);
    for (const chat of [unread, topic]) await hub.store.publishBotMessage('bot', { conversationId: chat.id, blocks: [{ type: 'text', text: preview }] });
    const rows = sidebar(page).locator('.bot-tree-conversations .conversation-row, .group-tree-topics .conversation-row');
    await expect(rows).toHaveCount(3);
    await expect(sidebar(page).locator(`[data-conversation-id="${unread.id}"] .unread-badge`)).toHaveText('1');
    await expect(sidebar(page).locator(`[data-conversation-id="${topic.id}"] .unread-badge`)).toHaveText('1');
    await expect(selected.locator('small')).toHaveText(preview);
    await drag(page, 180); await expect(sidebar(page)).toHaveCSS('width', '452px');
    await sidebar(page).screenshot({ path: info.outputPath('bot-preview-wide.png') });
    const checkRows = async () => {
      const geometry = await rows.evaluateAll(nodes => nodes.map(node => {
        const row = node.getBoundingClientRect(), style = getComputedStyle(node);
        const text = node.querySelector('.row-text')!.getBoundingClientRect();
        const badge = node.querySelector('.unread-badge')?.getBoundingClientRect();
        const right = row.right - parseFloat(style.paddingRight);
        return { id: node.getAttribute('data-conversation-id'), textRight: text.right, expectedRight: badge ? badge.left - parseFloat(style.columnGap) : right,
          badgeRight: badge?.right, right, overflow: node.scrollWidth - node.clientWidth,
          spans: [...node.children].map(child => ({class: child.className, width:child.getBoundingClientRect().width, flex:getComputedStyle(child).flex, display:getComputedStyle(child).display})) };
      }));
      for (const row of geometry) {
        expect(Math.abs(row.textRight - row.expectedRight), `${row.id}: text must use available row width ${JSON.stringify(row)}`).toBeLessThan(2);
        if (row.badgeRight !== undefined) expect(Math.abs(row.badgeRight - row.right), `${row.id}: unread badge stays at the edge`).toBeLessThan(2);
        expect(row.overflow, `${row.id}: row must not overflow`).toBeLessThanOrEqual(1);
      }
      return selected.locator('small').evaluate(node => node.clientWidth);
    };
    const wide = await checkRows();
    await separator(page).focus(); await page.keyboard.press('Home');
    await expect(sidebar(page)).toHaveCSS('width', '200px');
    const narrow = await checkRows();
    expect(wide - narrow).toBeCloseTo(252, 0);
    await separator(page).focus(); await page.keyboard.press('End');
    await expect(sidebar(page)).toHaveCSS('width', '480px');
    await checkRows();
    for (const palette of ['cli', 'pixel']) {
      await page.evaluate(palette => { document.documentElement.dataset.palette = palette; }, palette);
      await checkRows();
    }
    await sidebar(page).getByRole('button', { name: '按对话', exact: true }).click();
    await expect(sidebar(page).locator('.conversation-inbox')).toBeVisible();
    expect(await sidebar(page).locator('.conversation-list').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await sidebar(page).getByRole('button', { name: '按 Bot', exact: true }).click();
    await checkRows();
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('desktop split drags both panes, bounds narrow windows, and resets on a fresh document', async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sidebar-resize-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  try {
    await seed(hub, '侧栏验收'); await pair(page, hub, '主机 A');
    await expect(sidebar(page)).toHaveCSS('width', '272px');
    const composer = workspace(page).getByRole('textbox', { name: '消息', exact: true });
    await composer.fill('保留这份草稿');
    const before = (await workspace(page).locator('.conversation-main').boundingBox())!;
    await drag(page, 110);
    await expect(sidebar(page)).toHaveCSS('width', '382px');
    await expect(separator(page)).toHaveAttribute('aria-valuenow', '382');
    const after = (await workspace(page).locator('.conversation-main').boundingBox())!;
    expect(after.width).toBeCloseTo(before.width - 110, 0); expect(after.x).toBeCloseTo(before.x + 110, 0);
    await expect(composer).toHaveValue('保留这份草稿');
    expect(await page.evaluate(() => !!document.documentElement.dataset.sidebarResizing)).toBe(false);
    await page.screenshot({ path: info.outputPath('desktop-resized.png') });
    for (const palette of ['cli', 'pixel']) {
      await page.evaluate(palette => { document.documentElement.dataset.palette = palette; }, palette);
      await drag(page, 24); await expect(sidebar(page)).toHaveCSS('width', palette === 'cli' ? '406px' : '430px');
    }
    await drag(page, 400); await expect(sidebar(page)).toHaveCSS('width', '480px');
    await page.setViewportSize({ width: 800, height: 900 });
    await expect(sidebar(page)).toHaveCSS('width', '440px');
    expect((await workspace(page).locator('.conversation-main').boundingBox())!.width).toBeGreaterThanOrEqual(360);
    await drag(page, -600); await expect(sidebar(page)).toHaveCSS('width', '200px');
    await separator(page).dblclick(); await expect(sidebar(page)).toHaveCSS('width', '272px');
    await page.setViewportSize({ width: 1600, height: 900 }); await expect(sidebar(page)).toHaveCSS('width', '288px');
    await drag(page, 80); await expect(sidebar(page)).toHaveCSS('width', '368px');
    await page.reload(); await expect(sidebar(page)).toHaveCSS('width', '288px');
    await expect(composer).toHaveValue('保留这份草稿');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('keyboard resizing, interrupted drags and mobile transitions keep the splitter usable', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sidebar-keyboard-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  try {
    await seed(hub, '键盘验收'); await pair(page, hub, '主机 A');
    await separator(page).focus(); await page.keyboard.press('ArrowRight'); await expect(sidebar(page)).toHaveCSS('width', '280px');
    await page.keyboard.press('Shift+ArrowLeft'); await expect(sidebar(page)).toHaveCSS('width', '248px');
    await page.keyboard.press('Home'); await expect(sidebar(page)).toHaveCSS('width', '200px');
    await page.keyboard.press('End'); await expect(sidebar(page)).toHaveCSS('width', '480px');
    await page.keyboard.press('Enter'); await expect(sidebar(page)).toHaveCSS('width', '272px');
    await drag(page, 80, false); await page.keyboard.press('Escape'); await page.mouse.up();
    await expect(sidebar(page)).toHaveCSS('width', '272px');
    await drag(page, 80, false); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.mouse.up();
    expect(await page.evaluate(() => !!document.documentElement.dataset.sidebarResizing)).toBe(false);
    await drag(page, 20); await expect(sidebar(page)).toHaveCSS('width', '372px');
    await drag(page, 20, false); await page.setViewportSize({ width: 390, height: 844 }); await page.mouse.up();
    await expect(workspace(page).locator('.sidebar-resize-handle')).toBeHidden();
    expect(await page.evaluate(() => !!document.documentElement.dataset.sidebarResizing)).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1360, height: 900 });
    await expect(separator(page)).toBeVisible(); await separator(page).dblclick(); await expect(sidebar(page)).toHaveCSS('width', '272px');
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('sidebar width follows this window across host and conversation switches', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sidebar-hosts-'));
  const a = await HubServer.start({ stateDir: path.join(root, 'a'), clientDir: path.resolve('dist') });
  const b = await HubServer.start({ stateDir: path.join(root, 'b'), origins: [a.url] });
  try {
    await seed(a, 'A 对话'); await seed(b, 'B 对话'); await pair(page, a, '主机 A');
    await drag(page, 100); await expect(sidebar(page)).toHaveCSS('width', '372px');
    await pair(page, b, '主机 B', true); await expect(sidebar(page)).toHaveCSS('width', '372px');
    await setListOption(page, '按主机分组', true);
    await workspace(page).getByRole('region', { name: '主机：主机 A', exact: true }).getByRole('button', { name: /^A 对话/ }).click();
    await expect(sidebar(page)).toHaveCSS('width', '372px');
    await separator(page).dblclick(); await expect(sidebar(page)).toHaveCSS('width', '272px');
    await workspace(page).getByRole('region', { name: '主机：主机 B', exact: true }).getByRole('button', { name: /^B 对话/ }).click();
    await expect(sidebar(page)).toHaveCSS('width', '272px');
  } finally { await page.close(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});
