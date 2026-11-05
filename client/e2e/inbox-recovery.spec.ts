import { setListOption, expectListOption } from './fixtures/mobile.js';
import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { ConversationFolders } from '../../src/hub/conversation-folders.js';
import { mobileHome, openMobileHome, selectConversation, waitForClientOnline } from './fixtures/mobile.js';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
async function fixture(page: Page) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inbox-recovery-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('bot','工作助手','fixture',1)");
  await hub.profile.update({name:'example-mac',revision:(await hub.profile.read()).revision});
  const direct = await hub.store.createConversation('owner', ['bot'], '工作对话', 'direct');
  const group = await hub.store.createConversation('owner', ['bot'], '测试群组', 'group', {type:'group'});
  await new ConversationFolders(hub.store.db).change('owner', {type:'create',id:'work',name:'工作',conversationId:direct.id,revision:0});
  return { hub, direct, group, close: async () => { await hub.close(); await rm(root, {recursive:true,force:true}); } };
}
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await page.getByLabel('主机名称', {exact:true}).fill('example-mac');
  await preparePairing(page, hub); await page.getByRole('button', {name:'配对此设备',exact:true}).click();
  await hub.auth.approve(await page.getByLabel('配对码', {exact:true}).innerText(), 'local-owner');
  await page.getByLabel('配对码', {exact:true}).waitFor({state:'hidden'}); await waitForClientOnline(page);
}

test('phone inbox keeps connection recovery without a persistent hidden-history banner', async ({ page }, info) => {
  await page.clock.install();
  const env = await fixture(page); let offline = false; const sockets: WebSocketRoute[] = [];
  await page.route('**/health', async route => offline ? route.abort('internetdisconnected') : route.continue());
  await page.routeWebSocket('**/ws', socket => { sockets.push(socket); if (!offline) socket.connectToServer(); });
  try {
    await pair(page, env.hub); await selectConversation(page, env.direct.title);
    await page.getByRole('textbox', {name:'消息',exact:true}).fill('保留未发送草稿');
    await expect(page.getByLabel('草稿状态', {exact:true})).toHaveText('草稿已保存'); await openMobileHome(page);
    const home = mobileHome(page), row = home.locator(`[data-conversation-id="${env.direct.id}"]`);
    await expect(row).toBeVisible();
    offline = true; await sockets.at(-1)!.close({code:1012,reason:'fixture interrupted link'});
    await expect(home.getByRole('status', {name:'主机连接状态',exact:true})).toContainText('断线 5 分钟');
    await expect(row).toContainText('保留未发送草稿');
    await expect(home).not.toContainText('未连接的 Bot 已隐藏');
    await page.clock.fastForward(299_000);
    await expect(row).toBeVisible();
    await page.clock.fastForward(2_000);
    await expect(row).toHaveCount(0); // Hide only after one continuous five-minute outage.
    await expect(home.locator(`[data-conversation-id="${env.group.id}"]`)).toBeVisible();
    await page.screenshot({path:info.outputPath('inbox-interrupted.png')});
    await expect(home.getByRole('status', {name:'主机连接状态',exact:true})).toContainText('example-mac');
    await expect(home).not.toContainText('未连接的 Bot 已隐藏');
    await setListOption(page, '显示未连接 Bot', true);
    await expect(row).toContainText('保留未发送草稿');
    await setListOption(page, '显示未连接 Bot', false);
    await page.setViewportSize({width:320,height:740});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath('inbox-recovery-320.png')});
    offline = false; await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitForClientOnline(page); await expect(row).toBeVisible();
    await expect(home.getByRole('status', {name:'主机连接状态',exact:true})).toHaveCount(0);
    await expectListOption(page, '显示未连接 Bot', false);
    await selectConversation(page, env.direct.title);
    await expect(page.getByRole('textbox', {name:'消息',exact:true})).toHaveValue('保留未发送草稿');
    expect((await env.hub.store.conversations('owner')).filter(chat => !chat.archived)).toHaveLength(2);
    expect((await env.hub.store.snapshot('owner',env.direct.id)).messages).toHaveLength(0);
  } finally { await page.close(); await env.close(); }
});

for (const challengeDelay of [0, 350]) test(`repeated foreground signals cannot keep a silent socket alive indefinitely (${challengeDelay}ms challenge)`, async ({ page }) => {
  const env = await fixture(page), sockets: {drop:boolean}[] = [];
  await page.routeWebSocket('**/ws', socket => {
    const state = {drop:false}; sockets.push(state); const server = socket.connectToServer();
    let delayed: ReturnType<typeof setTimeout> | undefined;
    server.onMessage(message => {
      if (state.drop) return;
      if (challengeDelay && JSON.parse(String(message)).type === 'challenge') delayed = setTimeout(() => socket.send(message), challengeDelay);
      else socket.send(message);
    });
    socket.onClose(() => { clearTimeout(delayed); server.close(); });
  });
  try {
    await pair(page,env.hub); const before = sockets.length;
    // Healthy foreground signals preserve the socket and any in-flight work.
    await page.evaluate(() => { (window as any).__foregroundPulse = setInterval(() => window.dispatchEvent(new Event('online')), 100); });
    await page.waitForTimeout(1400); expect(sockets).toHaveLength(before);
    sockets.at(-1)!.drop = true;
    await expect.poll(() => sockets.length, {timeout:5000}).toBeGreaterThan(before);
    await waitForClientOnline(page);
    await expect(mobileHome(page).locator(`[data-conversation-id="${env.direct.id}"]`)).toBeVisible();
    expect(sockets).toHaveLength(before + 1);
  } finally { await page.evaluate(() => clearInterval((window as any).__foregroundPulse)).catch(() => {}); await page.close(); await env.close(); }
});
