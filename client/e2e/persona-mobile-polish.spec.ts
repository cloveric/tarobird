import { readBotPersona, replaceBotPersona } from "../../src/runtime/bot-instructions.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { hashSecret } from '../../src/hub/auth.js';
import { attachGateway } from '../../src/gateway/service.js';
import { createCoreServiceRuntime } from '../../src/core/runtime.js';
import { showDisconnectedBots, mobileHome, waitForClientOnline } from './fixtures/mobile.js';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await page.getByLabel('Hub 地址', { exact: true }).fill(hub.url); await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
  await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
  await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' }); await waitForClientOnline(page);
}
test('phone persona writes Bot instructions, preserves conflicting drafts and enforces owner access', async ({ page, browser, browserName }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'persona-ui-')), stateDir = path.join(root, 'alpha'); await mkdir(stateDir);
  const secret = randomBytes(32).toString('base64url');
  await writeFile(path.join(stateDir, 'config.json'), JSON.stringify({ engine: 'antigravity', locale: 'zh' }));
  await mkdir(path.join(stateDir, 'workspace'));
  const instructionsFile = path.join(stateDir, 'workspace', 'AGENTS.md');
  await writeFile(instructionsFile, '# Existing rules\nKeep these rules.\n');
  await writeFile(path.join(stateDir, 'agent.md'), '原有角色'); await writeFile(path.join(stateDir, 'session.json'), '{"chats":[]}');
  const hub = await HubServer.start({ stateDir: path.join(root, 'hub'), clientDir: path.resolve('dist') });
  await hub.store.db.run('INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)', ['alpha', '研究助手', hashSecret(secret)]);
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace('http', 'ws') + '/instance', secret, botId: 'alpha', engine: 'antigravity', runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: 'unused' }) } });
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 }, hasTouch: false, isMobile: false }); let authorization = '';
  page.on('request', request => { if (request.url().endsWith('/persona')) authorization = request.headers().authorization ?? authorization; });
  try {
    await hub.store.createConversation('owner', ['alpha'], '旅行计划', 'one'); await pair(page, hub);
    await mobileHome(page).getByRole('navigation').getByRole('button', { name: 'Bot', exact: true }).tap();
    await mobileHome(page).getByRole('button', { name: '研究助手 的 Bot 设置' }).tap();
    await page.getByRole('button', { name: /^人设/ }).tap();
    const editor = page.getByRole('dialog', { name: '编辑人设', exact: true }), input = editor.getByLabel('人设内容', { exact: true });
    await expect(editor.getByRole('heading', { name: '编辑人设', exact: true })).toBeFocused();
    await expect(editor.getByRole('button', { name: '关闭人设编辑' })).not.toBeFocused();
    await expect(input).toHaveAttribute('maxlength', '16000'); await expect(input).toHaveValue('原有角色'); await input.fill('你是研究助手。先说结论，再列依据。');
    await editor.getByRole('button', { name: '保存人设', exact: true }).tap(); await expect(editor.getByRole('status')).toContainText('人设已保存');
    expect(readBotPersona(await readFile(instructionsFile, 'utf8'))).toBe('你是研究助手。先说结论，再列依据。');
    expect(await readFile(instructionsFile, 'utf8')).toContain('# Existing rules\nKeep these rules.\n');
    expect(await readFile(path.join(stateDir, 'agent.md.migrated'), 'utf8')).toBe('原有角色');
    await expect(editor.getByText('保存只更新文件。需要在当前对话使用新版时，请让 Bot 重新读取人设文件。')).toBeVisible();
    await page.screenshot({ path: info.outputPath('persona.png') });
    await input.fill('保留我的草稿'); await editor.getByRole('button', { name: '关闭人设编辑' }).tap();
    await expect(editor.getByText('尚有未保存的人设修改，要放弃这些修改吗？')).toBeVisible();
    await editor.getByRole('button', { name: '继续编辑', exact: true }).tap(); await expect(input).toHaveValue('保留我的草稿');
    await writeFile(instructionsFile, replaceBotPersona(await readFile(instructionsFile, 'utf8'), '主机上的新角色'));
    await editor.getByRole('button', { name: '保存人设', exact: true }).tap();
    await expect(editor.getByRole('alert')).toContainText('人设已被其他设备修改'); await expect(input).toHaveValue('保留我的草稿');
    await editor.getByRole('button', { name: '刷新编辑内容', exact: true }).tap(); await editor.getByRole('button', { name: '放弃修改', exact: true }).tap();
    await expect(input).toHaveValue('主机上的新角色');
    await input.fill(''); await editor.getByRole('button', { name: '保存人设', exact: true }).tap();
    await expect(editor.getByRole('status')).toContainText('人设已保存');
    expect(readBotPersona(await readFile(instructionsFile, 'utf8'))).toBe('');
    expect(await readFile(instructionsFile, 'utf8')).toContain('Keep these rules.');
    await pair(desktop, hub);
    await desktop.getByRole('button', { name: '查看对话详情', exact: true }).click(); await desktop.getByRole('button', { name: 'Bot 设置', exact: true }).click(); await desktop.getByRole('button', { name: /^人设/ }).click();
    await expect(desktop.getByLabel('人设内容', { exact: true })).toHaveValue('');
    const desktopEditor = desktop.getByRole('dialog', { name: '编辑人设', exact: true });
    const closePersona = desktopEditor.getByRole('button', { name: '关闭人设编辑' });
    await expect(desktopEditor.getByRole('heading', { name: '编辑人设', exact: true })).toBeFocused();
    expect(await closePersona.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('none');
    await desktop.screenshot({ path: info.outputPath('persona-pointer-open.png'), animations: 'disabled' });
    // macOS WebKit's default Tab cycle skips buttons; Option+Tab includes them.
    const nextControl = browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
    await desktop.keyboard.press(nextControl);
    await expect(closePersona).toBeFocused();
    expect(await closePersona.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
    expect(await closePersona.evaluate(el => getComputedStyle(el).outlineWidth)).toBe('2px');
    await desktop.keyboard.press('Escape');
    await expect(desktopEditor).toHaveCount(0);
    await expect(desktop.getByRole('button', { name: /^人设/ })).toBeFocused();
    await desktop.keyboard.press('Enter');
    await expect(desktopEditor.getByRole('heading', { name: '编辑人设', exact: true })).toBeFocused();
    await desktop.keyboard.press(nextControl);
    await expect(closePersona).toBeFocused();
    await desktop.keyboard.press('Enter');
    await expect(desktopEditor).toHaveCount(0);
    expect((await fetch(`${hub.url}/api/bots/alpha/persona`)).status).toBe(401);
    expect((await fetch(`${hub.url}/api/bots/missing/persona`, { headers: { authorization } })).status).toBe(403);
    await hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
    expect((await fetch(`${hub.url}/api/bots/alpha/persona`, { headers: { authorization } })).status).toBe(403);
    await expect(page.getByRole('dialog', { name: 'Bot 设置', exact: true }).locator('.avatar-setting')).toHaveCount(1);
    expect(await readFile(path.join(stateDir, 'session.json'), 'utf8')).toBe('{"chats":[]}');
  } finally { await desktop.close(); await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
test('Me profile stays below header and search has one focus surface', async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phone-layout-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture')");
    for (let i = 0; i < 18; i++) await hub.store.createConversation('owner', ['alpha'], `测试对话 ${i}`, `c${i}`);
    await pair(page, hub); await showDisconnectedBots(page);
    const home = mobileHome(page), nav = home.getByRole('navigation'), header = home.locator('.mh-header');
    const openMe = () => nav.getByRole('button', { name: '我的', exact: true }).tap();
    await home.locator('.mh-body').evaluate(el => { el.scrollTop = 110; }); await openMe();
    const card = home.getByRole('button', { name: '个人头像', exact: true });
    const check = async () => {
      const h = (await header.boundingBox())!, c = (await card.boundingBox())!;
      expect(c.y).toBeGreaterThanOrEqual(h.y + h.height + 8);
      expect(await home.locator('.mh-body').evaluate(el => el.scrollTop)).toBe(0);
    };
    await check(); await card.tap(); await page.getByRole('button', { name: '关闭设置', exact: true }).tap(); await check();
    await page.screenshot({ path: info.outputPath('me.png') });
    // The Me title scrolls with the profile, so it never paints over the avatar.
    await page.setViewportSize({ width: 390, height: 690 });
    await home.locator('.mh-body').evaluate(el => { el.scrollTop = 35; });
    const h = (await header.boundingBox())!, c = (await card.boundingBox())!;
    expect(c.y).toBeGreaterThanOrEqual(h.y + h.height + 8);
    await home.locator('.mh-body').evaluate(el => { el.scrollTop = 0; });
    await page.setViewportSize({ width: 390, height: 844 });
    await nav.getByRole('button', { name: /^消息/ }).tap(); await home.getByRole('button', { name: '搜索会话或 Bot', exact: true }).tap();
    const input = home.getByRole('searchbox'); await expect(input).toBeFocused();
    expect(await input.evaluate(el => getComputedStyle(el).boxShadow)).toBe('none');
    await page.screenshot({ path: info.outputPath('search.png') });
    await input.fill('测试对话 2'); await expect(home.locator('.mh-row')).toHaveCount(1);
    await home.getByRole('button', { name: '关闭搜索', exact: true }).tap(); await openMe(); await check();
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
