import { expectSettingsPage } from "./fixtures/settings-page.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots, openMobileSearch } from "./fixtures/mobile.js";
import { test, expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { hashSecret } from '../../src/hub/auth.js';
import { attachGateway } from '../../src/gateway/service.js';
import { createCoreServiceRuntime } from '../../src/core/runtime.js';
import { mobileHome, selectConversation, waitForClientOnline } from './fixtures/mobile.js';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const workspace = (page: Page) => page.locator('.host-workspace:not([hidden])');
const settings = (page: Page) => page.getByRole('dialog', { name: 'Bot 设置', exact: true });
const effort = (page: Page) => page.getByRole('dialog', { name: '思考强度', exact: true });
const back = (page: Page) => page.evaluate(() => !window.dispatchEvent(new Event('tarocub-native-back', { cancelable: true })));
async function pair(page: Page, hub: HubServer, name: string) {
  await hub.profile.update({ name, revision: (await hub.profile.read()).revision });
  await page.getByLabel('主机名称', { exact: true }).fill(name);
  await page.getByLabel('Hub 地址', { exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
  await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
  await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
  await waitForClientOnline(page);
}
async function seed(hub: HubServer, root: string, id: string, name: string, engine: 'codex' | 'kimi' = 'codex') {
  const stateDir = path.join(root, id), secret = randomBytes(32).toString('base64url');
  const model = engine === 'codex' ? 'gpt-5.5' : 'kimi-code/k3';
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, 'config.json'), JSON.stringify({ engine, model, effort: 'high', locale: 'zh', workspacePath: '/preserved/workspace' }));
  await writeFile(path.join(stateDir, 'session.json'), JSON.stringify({ chats: [] }));
  await hub.store.db.run('INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)', [id, name, hashSecret(secret)]);
  return attachGateway({ stateDir, botId: id, secret, url: hub.instanceUrl.replace('http', 'ws') + '/instance', engine, model, effort: 'high', runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => { throw new Error('settings_must_not_invoke_engine'); } } });
}
async function openSettingsFromChat(page: Page) {
  await page.getByRole('button', { name: '更多聊天操作', exact: true }).click();
  await page.getByRole('dialog', { name: '聊天操作', exact: true }).getByRole('button', { name: 'Bot 设置', exact: true }).click();
  await expect(settings(page)).toBeVisible();
  await expectSettingsPage(settings(page), 390, 844);
}
async function saveEffort(page: Page, value: string) {
  await settings(page).getByRole('button', { name: '调整 Bot 思考强度', exact: true }).click();
  await expectSettingsPage(effort(page), page.viewportSize()!.width, page.viewportSize()!.height);
  await effort(page).getByLabel('Effort 档位', { exact: true }).selectOption(value);
  await effort(page).getByRole('button', { name: '保存到此 Bot', exact: true }).click();
  await expect(effort(page).getByRole('status')).toContainText(`已保存为 ${value}`);
}

test('phone chat menu renames durably, keeps drafts and selects engine-specific Bot settings in groups', async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phone-settings-'));
  const hub = await HubServer.start({ stateDir: path.join(root, 'hub'), clientDir: path.resolve('dist') });
  const a = await seed(hub, root, 'alpha', '研究助手'), b = await seed(hub, root, 'beta', '写作助手', 'kimi');
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  try {
    const direct = await hub.store.createConversation('owner', ['alpha'], '研究计划', 'direct');
    await hub.store.db.run('UPDATE conversations SET session_id=?,binding_id=? WHERE id=?', ['preserved_session', 'preserved_binding', direct.id]);
    const group = await hub.store.createConversation('owner', ['alpha', 'beta'], '产品群', 'group', { type: 'group' });
    await page.goto(hub.url); await pair(page, hub, '测试主机');
    await selectConversation(page, '研究计划');
    await workspace(page).getByLabel('消息', { exact: true }).fill('请保留这份草稿');
    const more = page.getByRole('button', { name: '更多聊天操作', exact: true });
    await more.click();
    await expect(page.getByRole("dialog", { name: "聊天操作", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('phone-chat-settings-menu.png'), animations: 'disabled' });
    await page.getByRole('button', { name: '重命名对话', exact: true }).click();
    const input = page.getByLabel('对话名称', { exact: true });
    await expect(input).toBeFocused();
    await input.fill('  新研究计划  ');
    expect(await input.evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', keyCode: 229, isComposing: true })))).toBe(false);
    await expect(page.getByRole('dialog', { name: '重命名对话', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '重命名对话', exact: true })).toHaveCount(0);
    await expect(more).toBeFocused();
    await expect(page.getByRole('heading', { name: '新研究计划', exact: true, level: 1 })).toBeVisible();
    await expect(workspace(page).getByLabel('消息', { exact: true })).toHaveValue('请保留这份草稿');
    expect((await hub.store.conversations('owner')).find(c => c.id === direct.id)).toMatchObject({ title: '新研究计划', sessionId: 'preserved_session', bindingId: 'preserved_binding' });
    await selectConversation(page, '产品群');
    await openSettingsFromChat(page);
    const select = settings(page).getByLabel('选择要调整的 Bot', { exact: true });
    await select.selectOption('beta');
    await settings(page).getByRole('button', { name: '调整 Bot 思考强度', exact: true }).click();
    await expect(effort(page).getByLabel('Effort 档位', { exact: true }).locator('option')).toHaveText(['跟随默认（不强制指定）', 'low', 'high', 'max']);
    await effort(page).getByLabel('Effort 档位', { exact: true }).selectOption('max');
    await effort(page).getByRole('button', { name: '保存到此 Bot', exact: true }).click();
    await expect(effort(page).getByRole('status')).toContainText('已保存为 max');
    expect(await back(page)).toBe(true);
    await expect(effort(page)).toHaveCount(0);
    await expect(settings(page).getByRole('button', { name: '调整 Bot 思考强度', exact: true })).toContainText('max');
    await page.screenshot({ path: info.outputPath('phone-group-bot-settings.png'), animations: 'disabled' });
    await select.selectOption('alpha');
    await settings(page).getByRole('button', { name: '调整 Bot 思考强度', exact: true }).click();
    await expect(effort(page).getByLabel('Effort 档位', { exact: true }).locator('option')).toHaveText(['跟随默认（不强制指定）', 'low', 'medium', 'high', 'xhigh']);
    expect(await back(page)).toBe(true);
    expect(await back(page)).toBe(true);
    await expect(settings(page)).toHaveCount(0);
    await expect(more).toBeFocused();
    await page.reload(); await waitForClientOnline(page);
    await selectConversation(page, '新研究计划');
    await expect(workspace(page).getByLabel('消息', { exact: true })).toHaveValue('请保留这份草稿');
    expect(JSON.parse(await readFile(path.join(root, 'alpha/config.json'), 'utf8')).effort).toBe('high');
    expect(JSON.parse(await readFile(path.join(root, 'beta/config.json'), 'utf8')).effort).toBe('max');
    for (const id of ['alpha', 'beta']) expect(await readFile(path.join(root, id, 'session.json'), 'utf8')).toBe(JSON.stringify({ chats: [] }));
    expect((await hub.store.conversations('owner')).find(c => c.id === group.id)?.botIds).toEqual(['alpha', 'beta']);
    expect(await hub.store.db.get('SELECT COUNT(*) AS count FROM messages')).toEqual({ count: 0 });
    expect(errors).toEqual([]);
  } finally { await page.close(); await a.disconnect(); await b.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test('phone Bot list settings work before any chat, isolate matching IDs across hosts and stay usable at 320px', async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phone-bot-host-settings-'));
  const a = await HubServer.start({ stateDir: path.join(root, 'a/hub'), clientDir: path.resolve('dist') });
  const b = await HubServer.start({ stateDir: path.join(root, 'b/hub'), origins: [a.url] });
  const ga = await seed(a, path.join(root, 'a'), 'alpha', '甲助手');
  const gb = await seed(b, path.join(root, 'b'), 'alpha', '乙助手');
  try {
    await page.goto(a.url); await pair(page, a, '主机甲');
    await mobileHome(page).getByRole('button', { name: '我的', exact: true }).click();
    await mobileHome(page).getByRole('button', { name: '设备与网络', exact: true }).click();
    await page.getByRole('dialog', { name: '设备与网络', exact: true }).getByRole('button', { name: /^此设备连接另一台主机/ }).click();
    await pair(page, b, '主机乙');
    await mobileHome(page).getByRole('navigation', { name: '主导航' }).getByRole('button', { name: 'Bot', exact: true }).click();
    await page.setViewportSize({ width: 320, height: 568 });
    const trigger = mobileHome(page).getByRole('button', { name: '甲助手 的 Bot 设置', exact: true });
    const box = (await trigger.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('phone-bot-settings-entry-320.png'), animations: 'disabled' });
    await trigger.click();
    await expect(settings(page)).toContainText('运行于 主机甲');
    await expect(settings(page)).toContainText('甲助手');
    await page.getByRole('button', { name: '调整 Bot 模型', exact: true }).click();
    await page.getByLabel('选择模型', { exact: true }).selectOption('gpt-6-astra');
    await page.getByRole('button', { name: '保存到此 Bot', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('已保存为 gpt-6-astra');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('phone-model-settings-320.png'), animations: 'disabled' });
    await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
    await saveEffort(page, 'low');
    expect(await back(page)).toBe(true); expect(await back(page)).toBe(true);
    await expect(trigger).toBeFocused();
    expect(JSON.parse(await readFile(path.join(root, 'a/alpha/config.json'), 'utf8')).effort).toBe('low');
    expect(JSON.parse(await readFile(path.join(root, 'b/alpha/config.json'), 'utf8')).effort).toBe('high');
    expect(JSON.parse(await readFile(path.join(root, 'a/alpha/config.json'), 'utf8')).model).toBe('gpt-6-astra');
    expect(JSON.parse(await readFile(path.join(root, 'b/alpha/config.json'), 'utf8')).model).not.toBe('gpt-6-astra');
    // The search results use the same Bot row and settings action.
    await mobileHome(page).getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^消息/ }).click();
    await openMobileSearch(page); await mobileHome(page).getByLabel('查找会话或 Bot', { exact: true }).fill('乙助手');
    await mobileHome(page).getByRole('button', { name: '乙助手 的 Bot 设置', exact: true }).click();
    await expect(settings(page)).toContainText('运行于 主机乙');
    await expect(settings(page)).toContainText('乙助手');
    expect(await back(page)).toBe(true);
    await expect(mobileHome(page).getByRole('button', { name: '乙助手 的 Bot 设置', exact: true })).toBeFocused();
    expect(await a.store.conversations('owner')).toEqual([]); expect(await b.store.conversations('owner')).toEqual([]);
    expect(await a.store.db.get('SELECT COUNT(*) AS count FROM messages')).toEqual({ count: 0 });
    expect(await b.store.db.get('SELECT COUNT(*) AS count FROM messages')).toEqual({ count: 0 });
  } finally { await page.close(); await ga.disconnect(); await gb.disconnect(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});

test('phone settings make offline and non-owner restrictions explicit', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phone-settings-guards-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','离线助手','fixture')");
    await hub.store.createConversation('owner', ['alpha'], '离线讨论', 'direct');
    await page.goto(hub.url); await pair(page, hub, '测试主机');
    await showDisconnectedBots(page); await selectConversation(page, '离线讨论');
    await openSettingsFromChat(page);
    await expect(settings(page).getByRole('status')).toContainText('Bot 当前离线');
    await settings(page).getByRole('button', { name: '调整 Bot 思考强度', exact: true }).click();
    await expect(effort(page).getByRole('button', { name: '重新读取', exact: true })).toBeDisabled();
    expect(await back(page)).toBe(true); expect(await back(page)).toBe(true);
    await hub.store.db.run("INSERT INTO bot_grants(user_id,bot_id) VALUES('owner','alpha')");
    await hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, '离线讨论');
    await openSettingsFromChat(page);
    await expect(settings(page)).toContainText('仅拥有者可修改 Bot 设置');
    await expect(settings(page).getByRole('button', { name: '调整 Bot 思考强度', exact: true })).toBeDisabled();
    expect(await back(page)).toBe(true);
    // Browser offline emulation does not consistently close existing WebSockets
    // in WebKit. Stop the isolated Hub to exercise a real disconnection.
    await hub.close();
    await expect(workspace(page).locator('.connection-pill.online')).toHaveCount(0);
    await page.getByRole('button', { name: '更多聊天操作', exact: true }).click();
    await expect(page.getByRole('button', { name: '重命名对话', exact: true })).toBeDisabled();
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
