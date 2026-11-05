import { setListOption } from './fixtures/mobile.js';
import { preparePairing } from "./fixtures/pairing-invite.js";
import { HOST_PROFILE_KEY } from "../../src/hub/host-profile.js";
import { openMobileSearch } from "./fixtures/mobile.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { closeSettings } from "./fixtures/settings.js";
import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';

const back = (page: Page) => page.evaluate(() => !window.dispatchEvent(new Event('tarocub-native-back', { cancelable:true })));
const home = (page: Page) => page.locator('.host-workspace:not([hidden]) .mobile-home');
async function pair(page: Page, hub: HubServer, name='Mac mini', savedName=name) {
  await hub.store.db.run("INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)", [HOST_PROFILE_KEY, JSON.stringify({ name, revision: 1 })]);
  await hub.profile.update({ name, revision: (await hub.profile.read()).revision });
  await page.getByLabel('主机名称', {exact:true}).fill(savedName);
  await page.getByLabel('Hub 地址', {exact:true}).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole('button',{name:'配对此设备',exact:true}).click();
  await hub.auth.approve(await page.getByLabel('配对码',{exact:true}).innerText(),'local-owner');
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await expect(home(page)).toBeVisible();
  // These journeys include cached/offline history; opt into the full directory.
  await setListOption(page, '显示未连接 Bot', true);
}
async function openRow(page: Page, title: string) {
  await home(page).getByRole('button').filter({has:page.getByText(title,{exact:true})}).click();
  await expect(page.locator('.host-workspace:not([hidden]) .conversation-main')).toBeVisible();
}

test('phone chat keeps a compact header and Bot browsing in menu and details without losing drafts', async ({page}, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mobile-chat-browse-'));
  const hub = await HubServer.start({stateDir:root, clientDir:path.resolve('dist')});
  try {
    for (const [id, name] of [['alpha', '产品助手'], ['beta', '研究助手']])
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,'fixture')", [id, name]);
    const design = await hub.store.createConversation('owner', ['alpha'], '设计讨论', 'design');
    await hub.store.createConversation('owner', ['alpha'], '其他方案', 'other');
    await hub.store.createConversation('owner', ['beta'], '研究报告', 'research');
    await page.setViewportSize({width:390, height:844}); await page.goto(hub.url); await pair(page, hub);
    await openRow(page, '设计讨论');
    await page.getByRole('textbox', {name:'消息', exact:true}).fill('保留我的草稿');
    const header = page.locator('.host-workspace:not([hidden]) .conversation-header');
    await expect(header.locator('.header-bot-name')).toHaveCount(0);
    await expect(header.getByRole('heading', {name:'设计讨论', exact:true})).toBeVisible();
    const reply = await hub.store.publishBotMessage('alpha', {conversationId:design.id, status:'streaming', blocks:[{type:'text', text:'正在整理设计方案…'}]});
    await expect(header.locator('.header-activity')).toHaveText('正在回复');
    await page.screenshot({path:info.outputPath('phone-chat-header.png'), animations:'disabled'});
    // Crossing the phone layout boundary preserves the conversation and draft;
    // desktop keeps its Bot identity while the compact header drops it again.
    await page.setViewportSize({width:1280, height:844});
    await expect(header.locator('.header-bot-name')).toHaveText('产品助手');
    await page.setViewportSize({width:390, height:844});
    await expect(header.locator('.header-bot-name')).toHaveCount(0);
    await expect(page.getByRole('textbox', {name:'消息', exact:true})).toHaveValue('保留我的草稿');
    await hub.store.publishBotMessage('alpha', {id:reply.id, conversationId:design.id, status:'complete', blocks:[{type:'text', text:'设计方案已整理。'}]});
    await page.getByRole('button', {name:'更多聊天操作', exact:true}).click();
    const actions = page.getByRole('dialog', {name:'聊天操作', exact:true});
    await expect(actions).toBeVisible();
    await page.screenshot({path:info.outputPath('phone-bot-shortcut.png'), animations:'disabled'});
    await actions.getByRole('button', {name:'查看此 Bot 的全部对话', exact:true}).click();
    await expect(home(page).getByRole('heading', {name:'产品助手 的对话', exact:true})).toBeVisible();
    await expect(home(page).locator('.mh-row')).toHaveCount(2);
    await expect(home(page).getByText('研究报告', {exact:true})).toHaveCount(0);
    await page.screenshot({path:info.outputPath('phone-bot-conversations-from-chat.png')});
    await openRow(page, '设计讨论');
    await expect(page.getByRole('textbox', {name:'消息', exact:true})).toHaveValue('保留我的草稿');
    await page.getByRole('button', {name:'更多聊天操作', exact:true}).click();
    await actions.getByRole('button', {name:'查看此 Bot 的全部对话', exact:true}).click();
    await expect(home(page)).toBeVisible();
    await openRow(page, '设计讨论');
    await page.getByRole('button', {name:'查看对话详情', exact:true}).click();
    await page.getByRole('button', {name:/查看此 Bot 的全部对话/}).click();
    await expect(home(page).locator('.mh-row')).toHaveCount(2);
    await openRow(page, '设计讨论');
    await hub.close();
    const notice = page.locator('.phone-connection-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('与「Mac mini」已断开');
    await expect(notice).toContainText('正在重连…');
    await expect(page.locator('.offline-banner,.error-banner')).toHaveCount(0);
    expect((await notice.boundingBox())!.height).toBeLessThanOrEqual(46);
    await page.screenshot({path:info.outputPath('phone-compact-offline.png')});
    await notice.locator('summary').click();
    await expect(notice.locator('div')).toContainText('已缓存的消息仍可阅读');
    await notice.locator('summary').click();
    await page.getByRole('button', {name:'更多聊天操作', exact:true}).click();
    await actions.getByRole('button', {name:'查看此 Bot 的全部对话', exact:true}).click();
    await expect(home(page).locator('.mh-row')).toHaveCount(2);
    await openRow(page, '设计讨论');
    await expect(page.getByRole('textbox', {name:'消息', exact:true})).toHaveValue('保留我的草稿');
  } finally { await page.close(); await hub.close(); await rm(root, {recursive:true, force:true}); }
});

test('mobile Bot browsing combines scope, search and filters and survives a chat round trip', async ({page}, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mobile-bot-scope-'));
  const hub = await HubServer.start({stateDir:root, clientDir:path.resolve('dist')});
  try {
    for (const [id, name] of [['alpha', '产品助手'], ['beta', '研究助手'], ['empty', '新助手']]) {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,'fixture')", [id, name]);
    }
    const direct = await hub.store.createConversation('owner', ['alpha'], '设计讨论', 'design');
    await hub.store.createConversation('owner', ['alpha'], '旧项目', 'old');
    const group = await hub.store.createConversation('owner', ['alpha', 'beta'], '产品工作群', 'group', {type:'group'});
    await hub.store.createConversation('owner', [], '界面体验', 'topic', {parentId:group.id});
    await hub.store.createConversation('owner', ['beta'], '研究报告', 'research');
    const archived = await hub.store.createConversation('owner', ['alpha'], '归档讨论', 'archived');
    await hub.store.updateConversation('owner', archived.id, {archived:true});
    await hub.store.publishBotMessage('alpha', {conversationId:direct.id, blocks:[{type:'text', text:'设计进展'}], status:'complete'});
    await page.setViewportSize({width:390, height:844}); await page.goto(hub.url); await pair(page, hub);
    await home(page).getByRole('navigation', {name:'主导航'}).getByRole('button', {name:'Bot', exact:true}).click();
    await openMobileSearch(page);
    const botSearch = home(page).getByLabel('查找会话或 Bot', {exact:true});
    await botSearch.dispatchEvent('compositionstart');
    await botSearch.fill('chanpin');
    await expect(home(page).getByRole('button', {name:'查看 研究助手 的全部对话', exact:true})).toBeVisible();
    await botSearch.press('Enter'); await expect(botSearch).toBeFocused();
    await botSearch.fill('产品'); await botSearch.dispatchEvent('compositionend', {data:'产品'});
    await expect(home(page).getByRole('button', {name:'查看 研究助手 的全部对话', exact:true})).toHaveCount(0);
    const entry = home(page).getByRole('button', {name:'查看 产品助手 的全部对话', exact:true});
    await expect(entry).toContainText('3 个会话');
    await entry.click();
    await expect(home(page).getByRole('heading', {name:'产品助手 的对话', exact:true})).toBeVisible();
    await expect(home(page).getByLabel('查找此 Bot 的会话', {exact:true})).toHaveCount(0);
    await expect(home(page).locator('.mh-row')).toHaveCount(3);
    await expect(home(page).getByText('研究报告', {exact:true})).toHaveCount(0);
    await expect(home(page).getByText('归档讨论', {exact:true})).toHaveCount(0);
    await expect(home(page).getByText('界面体验', {exact:true})).toHaveCount(0);
    await expect(home(page).getByRole('button', {name:'与 产品助手 新建对话', exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath('phone-bot-conversations.png')});
    await home(page).getByRole('navigation', {name:'主导航'}).getByRole('button', {name:'Bot', exact:true}).click();
    await expect(home(page).getByLabel('查找会话或 Bot', {exact:true})).toHaveValue('产品');
    await entry.click();
    await openMobileSearch(page);
    const search = home(page).getByLabel('查找此 Bot 的会话', {exact:true});
    await search.fill('研究助手');
    await expect(home(page).getByRole('button', {name:'搜索历史消息', exact:true})).toHaveCount(0);
    await expect(home(page).locator('.mh-bot-row')).toHaveCount(0);
    await expect(home(page).locator('.mh-row')).toHaveCount(1); // participating group
    await search.fill('设计');
    await home(page).getByRole('button', {name:'未读', exact:true}).click();
    await openRow(page, '设计讨论');
    await page.getByRole('textbox', {name:'消息', exact:true}).fill('保留草稿');
    expect(await back(page)).toBe(true);
    await expect(search).toHaveValue('设计');
    await expect(home(page).getByRole('button', {name:'未读', exact:true})).toHaveAttribute('aria-pressed', 'true');
    await expect(home(page).getByRole('heading', {name:'产品助手 的对话', exact:true})).toBeVisible();
    await home(page).getByRole('button', {name:'全部', exact:true}).click();
    await openRow(page, '设计讨论');
    await expect(page.getByRole('textbox', {name:'消息', exact:true})).toHaveValue('保留草稿');
    expect(await back(page)).toBe(true);
    await search.fill('界面体验');
    await home(page).getByRole('button', {name:'群组', exact:true}).click();
    await expect(home(page).locator('.mh-row')).toHaveCount(1);
    await expect(home(page).getByText('产品工作群', {exact:true})).toBeVisible();
    expect(await back(page)).toBe(true); // close search before leaving the scoped list
    await expect(search).toHaveCount(0);
    expect(await back(page)).toBe(true); // then clear Bot scope
    await expect(home(page).getByRole('heading', {name:'消息', exact:true})).toBeVisible();
    await home(page).getByRole('button', {name:'全部', exact:true}).click();
    await home(page).getByRole('navigation', {name:'主导航'}).getByRole('button', {name:'Bot', exact:true}).click();
    await home(page).getByRole('button', {name:'清除搜索', exact:true}).click();
    await home(page).getByRole('button', {name:'查看 新助手 的全部对话', exact:true}).click();
    await expect(home(page).getByText('还没有与此 Bot 的会话', {exact:true})).toBeVisible();
    await page.setViewportSize({width:320, height:568});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath('phone-empty-bot-320.png')});
    await home(page).getByRole('button', {name:'新建对话', exact:true}).click();
    const dialog = page.getByRole('dialog', {name:'新建对话', exact:true});
    await expect(dialog.getByRole('checkbox', {name:/新助手/})).toBeChecked();
  } finally { await page.close(); await hub.close(); await rm(root, {recursive:true, force:true}); }
});

test('mobile Bot scope isolates identical IDs across hosts and restores the scoped scroll position', async ({page}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mobile-bot-hosts-'));
  const a = await HubServer.start({stateDir:path.join(root, 'a'), clientDir:path.resolve('dist')});
  const b = await HubServer.start({stateDir:path.join(root, 'b'), origins:[a.url]});
  try {
    for (const hub of [a,b]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','同名助手','fixture')");
    await a.store.botStatus('alpha', { engine: 'antigravity', model: 'gemini-3.7-pro' });
    await b.store.botStatus('alpha', { engine: 'antigravity', model: 'claude-opus-5-5' });
    await a.store.createConversation('owner', ['alpha'], '台式机私聊', 'chat');
    for (let i = 0; i < 16; i++) await b.store.createConversation('owner', ['alpha'], `笔记本项目 ${i}`, `chat-${i}`);
    await page.setViewportSize({width:320, height:568}); await page.goto(a.url); await pair(page, a, '台式机');
    await home(page).getByRole('button', {name:'我的', exact:true}).click();
    await home(page).getByRole('button', {name:'设备与网络', exact:true}).click();
    await page.getByRole('dialog', {name:'设备与网络', exact:true}).getByRole('button', {name:/^此设备连接另一台主机/}).click();
    await pair(page, b, '笔记本');
    await home(page).getByRole('button', {name:'我的', exact:true}).click();
    await home(page).getByRole('button', {name:/台式机 已连接/}).click();
    await home(page).getByRole('navigation', {name:'主导航'}).getByRole('button', {name:/^消息/}).click();
    await home(page).getByRole('navigation', {name:'主导航'}).getByRole('button', {name:'Bot', exact:true}).click();
    await home(page).locator('.mh-body section').filter({has:page.getByText('笔记本', {exact:true})}).getByRole('button', {name:'查看 同名助手 的全部对话', exact:true}).click();
    await expect(home(page).locator('.mh-scope-host')).toHaveText('笔记本');
    await expect(home(page).locator('.mh-row')).toHaveCount(16);
    await expect(home(page).getByText('台式机私聊', {exact:true})).toHaveCount(0);
    await openMobileSearch(page); await home(page).getByLabel('查找此 Bot 的会话', {exact:true}).fill('笔记本项目');
    const row = home(page).locator('.mh-row').last();
    const title = await row.locator('.mh-row-title').innerText();
    await row.scrollIntoViewIfNeeded();
    const position = await home(page).locator('.mh-body').evaluate(node => node.scrollTop);
    expect(position).toBeGreaterThan(400);
    await row.click();
    await expect(page.getByRole('heading', {name:title, exact:true})).toBeVisible();
    expect(await back(page)).toBe(true);
    await expect(home(page).getByRole('heading', {name:'同名助手 的对话', exact:true})).toBeVisible();
    await expect(home(page).locator('.mh-scope-host')).toHaveText('笔记本');
    await expect(home(page).getByLabel('查找此 Bot 的会话', {exact:true})).toHaveValue('笔记本项目');
    await expect.poll(() => home(page).locator('.mh-body').evaluate(node => node.scrollTop)).toBeGreaterThan(position - 2);
    await expect(home(page).getByText(title, {exact:true})).toBeInViewport();
    await home(page).getByRole('button', {name:'清除搜索', exact:true}).click();
    await home(page).getByRole('navigation', {name:'主导航'}).getByRole('button', {name:'Bot', exact:true}).click();
    await home(page).locator('.mh-body section').filter({has:page.getByText('台式机', {exact:true})}).getByRole('button', {name:'查看 同名助手 的全部对话', exact:true}).click();
    await expect(home(page).locator('.mh-scope-host')).toHaveText('台式机');
    await expect(home(page).locator('.mh-row')).toHaveCount(1);
    await expect(home(page).getByText('台式机私聊', {exact:true})).toBeVisible();
    await home(page).getByRole('button', {name:'显示全部 Bot 的对话', exact:true}).click();
    await expect(home(page).locator('.mh-row')).toHaveCount(17);
    await expect(home(page).locator('.mh-row').filter({ hasText: '台式机私聊' }).locator('[data-bot-name="alpha"]')).toHaveAttribute('data-model-brand', 'gemini');
    await expect(home(page).locator('.mh-row').filter({ hasText: '笔记本项目' }).first().locator('[data-bot-name="alpha"]')).toHaveAttribute('data-model-brand', 'claude');
    expect(await back(page)).toBe(false);
    await page.setViewportSize({ width: 1360, height: 900 });
    const active = page.locator('.host-workspace:not([hidden])');
    await setListOption(page, '按主机分组', true);
    for (const [host, brand] of [['台式机', 'gemini'], ['笔记本', 'claude']]) {
      await expect(active.getByRole('region', { name: `主机：${host}`, exact: true }).locator('[data-bot-name="alpha"]')).toHaveAttribute('data-model-brand', brand);
    }
  } finally { await page.close(); await a.close(); await b.close(); await rm(root, {recursive:true, force:true}); }
});

test('mobile IM root, unread, group topics, drafts and native Back follow visible pages', async ({page}, info) => {
  const root=await mkdtemp(path.join(os.tmpdir(),'mobile-im-'));
  const hub=await HubServer.start({stateDir:root,clientDir:path.resolve('dist')});
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','产品助手','fixture')");
    const direct=await hub.store.createConversation('owner',['alpha'],'设计讨论','direct');
    const group=await hub.store.createConversation('owner',['alpha'],'产品工作群','group',{type:'group'});
    const topic=await hub.store.createConversation('owner',[],'界面体验','topic',{parentId:group.id});
    const archived=await hub.store.createConversation('owner',['alpha'],'归档群','archive',{type:'group'});
    await hub.store.createConversation('owner',[],'不可泄漏到列表的话题','archived-topic',{parentId:archived.id});
    await hub.store.updateConversation('owner',archived.id,{archived:true});
    await hub.store.publishBotMessage('alpha',{conversationId:direct.id,blocks:[{type:'text',text:'独立对话摘要'}],status:'complete'});
    await hub.store.publishBotMessage('alpha',{conversationId:topic.id,blocks:[{type:'text',text:'话题最新消息'}],status:'complete'});
    await page.setViewportSize({width:390,height:844});await page.goto(hub.url);await pair(page,hub);
    await expect(page.locator('.sidebar')).toBeHidden();await expect(page.locator('.conversation-main')).toBeHidden();
    await expect(home(page).getByRole('combobox')).toHaveCount(0);
    await page.screenshot({path:info.outputPath('phone-inbox-compact.png'), animations:'disabled'});
    await expect(home(page).getByText('设计讨论',{exact:true})).toBeVisible();
    await expect(home(page).getByText('产品工作群',{exact:true})).toBeVisible();
    await expect(home(page).getByText('归档群',{exact:true})).toHaveCount(0);
    expect(await back(page)).toBe(false);
    await expect(home(page).locator(`[data-conversation-id="${group.id}"] .mh-badge`)).toContainText('1');
    await home(page).getByRole('button',{name:'新建',exact:true}).click();
    await expect(home(page).getByRole('menu')).toBeVisible();
    expect(await back(page)).toBe(true);await expect(home(page).getByRole('menu')).toHaveCount(0);
    // New replies on the landing page must remain unread, even if internally selected.
    await hub.store.publishBotMessage('alpha',{conversationId:direct.id,blocks:[{type:'text',text:'列表中收到的新回复'}],status:'complete'});
    await expect(home(page).getByText(/列表中收到的新回复/)).toBeVisible();
    await page.waitForTimeout(500); // Exceed the read-debounce window while the inbox is visible.
    await expect.poll(async()=>Number((await hub.store.db.get<{seq:number}>("SELECT seq FROM reads WHERE conversation_id=? AND user_id='owner'",[direct.id]))?.seq??0)).toBe(0);
    await openRow(page,'设计讨论');await expect(page.locator('.message-blocks').getByText('列表中收到的新回复',{exact:true})).toBeVisible();
    const composer=page.getByRole('textbox',{name:'消息',exact:true});await composer.fill('返回后保留这份草稿');
    expect(await back(page)).toBe(true);await expect(home(page)).toBeVisible();
    expect(await back(page)).toBe(false);
    const beforeRead=(await hub.store.db.get<{seq:number}>("SELECT seq FROM reads WHERE conversation_id=? AND user_id='owner'",[direct.id]))?.seq??0;
    await hub.store.publishBotMessage('alpha',{conversationId:direct.id,blocks:[{type:'text',text:'返回首页之后再到一条'}],status:'complete'});
    // An unsent draft takes preview priority; the arriving reply stays unread.
    await expect(home(page).locator(`[data-conversation-id="${direct.id}"] .mh-row-preview`)).toContainText('草稿：返回后保留这份草稿');
    await page.waitForTimeout(500);
    expect((await hub.store.db.get<{seq:number}>("SELECT seq FROM reads WHERE conversation_id=? AND user_id='owner'",[direct.id]))?.seq??0).toBe(beforeRead);
    await openRow(page,'设计讨论');await expect(composer).toHaveValue('返回后保留这份草稿');
    await expect(page.locator('.message-blocks').getByText('返回首页之后再到一条',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'更多聊天操作',exact:true}).click();
    await expect(page.getByRole('dialog',{name:'聊天操作',exact:true})).toBeVisible();
    const actions=page.getByRole('dialog',{name:'聊天操作',exact:true});
    await expect(actions.getByRole('button',{name:'打开连接设置',exact:true})).toHaveAccessibleDescription(/主机直连|ms/);
    // This fixture has no active steerable run; only active tasks expose steering.
    await expect(actions.getByRole('button',{name:'引导当前任务',exact:true})).toHaveCount(0);
    await expect(actions.getByRole('button',{name:'停止当前轮次',exact:true})).toHaveAccessibleDescription(/未检测到进行中的回复/);
    await actions.getByRole('button',{name:/^已归档对话/}).click();
    const archives=page.getByRole('dialog',{name:'已归档对话',exact:true});
    await expect(archives.getByRole('article',{name:'归档群',exact:true}).getByRole('button',{name:'恢复',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'关闭已归档对话',exact:true}).click();
    await expect(composer).toHaveValue('返回后保留这份草稿');
    await page.getByRole('button',{name:'更多聊天操作',exact:true}).click();
    expect(await back(page)).toBe(true);await expect(home(page)).toBeHidden();
    await page.getByRole('button',{name:'打开会话列表',exact:true}).click();
    await openRow(page,'产品工作群');await clickAppAction(page, '全部话题', page.getByRole('button',{name:'全部话题',exact:true}));
    await page.getByRole('dialog',{name:'群内话题',exact:true}).getByRole('button').filter({has:page.getByText('界面体验',{exact:true})}).click();
    await expect(page.getByRole('heading',{name:'界面体验',exact:true})).toBeVisible();
    await expect(page.locator('.message-blocks')).toContainText('话题最新消息');
    expect(await back(page)).toBe(true);await expect(home(page)).toBeVisible();
    await page.reload();await expect(home(page)).toBeVisible();
    await openRow(page,'设计讨论');await expect(composer).toHaveValue('返回后保留这份草稿');
    // Returning to desktop restores the full workspace, without losing the draft.
    await page.setViewportSize({width:1360,height:900});await expect(page.locator('.sidebar')).toBeVisible();
    await expect(home(page)).toBeHidden();await expect(composer).toHaveValue('返回后保留这份草稿');
    expect(errors).toEqual([]);await page.screenshot({path:info.outputPath('desktop-preserved.png')});
  } finally {await page.close();await hub.close();await rm(root,{recursive:true,force:true});}
});

test('mobile host switching keeps same-ID chats and drafts separate; search and settings fit 320px', async ({page},info)=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'mobile-hosts-'));
  const a=await HubServer.start({stateDir:path.join(root,'a'),clientDir:path.resolve('dist')});
  const b=await HubServer.start({stateDir:path.join(root,'b'),origins:[a.url]});
  try{
    const sharedBotId = `client_${"d".repeat(24)}`;
    for(const [hub,name] of [[a,'主机 A 内容'],[b,'主机 B 内容']] as const){
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,'fixture')", [sharedBotId, hub === a ? "A 的专属助手" : "B 的专属助手"]);
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','同名助手','fixture')");
      await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES('same','direct','同名对话','owner',1,'same')");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same','user','owner',0)");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same','bot','alpha',0)");
      await hub.store.publishBotMessage('alpha',{conversationId:'same',blocks:[{type:'text',text:name}],status:'complete'});
    }
    await page.setViewportSize({width:320,height:812});await page.goto(a.url);await pair(page,a,'Mac mini','我的主机');
    await openRow(page,'同名对话');await page.getByRole('textbox',{name:'消息',exact:true}).fill('A 的私人草稿');
    await page.getByRole('button',{name:'打开会话列表',exact:true}).click();
    await home(page).getByRole('button',{name:'我的',exact:true}).click();
    await home(page).getByRole('button',{name:'设备与网络',exact:true}).click();
    await page.getByRole('dialog',{name:'设备与网络',exact:true}).getByRole('button',{name:/^此设备连接另一台主机/}).click();
    await pair(page,b,'笔记本');
    await home(page).locator('.mh-row[data-conversation-id="same"]').filter({hasText:'笔记本'}).click();
    await expect(page.locator('.host-workspace:not([hidden]) .message-blocks')).toContainText('主机 B 内容');
    await page.getByRole('textbox',{name:'消息',exact:true}).fill('B 的私人草稿');
    await page.getByRole('button',{name:'打开会话列表',exact:true}).click();
    await home(page).locator('.mh-row[data-conversation-id="same"]').filter({hasText:'Mac mini'}).click();
    await expect(page.getByRole('textbox',{name:'消息',exact:true})).toHaveValue('A 的私人草稿');
    await page.getByRole('button',{name:'打开会话列表',exact:true}).click();
    await openMobileSearch(page); await home(page).getByLabel('查找会话或 Bot',{exact:true}).fill('不存在');
    await expect(home(page).getByText('同名对话',{exact:true})).toHaveCount(0);
    await openMobileSearch(page); await home(page).getByLabel('查找会话或 Bot',{exact:true}).fill('');
    await b.store.publishBotMessage('alpha',{conversationId:'same',blocks:[{type:'text',text:'主机 B 内容'}],status:'complete'});
    await openMobileSearch(page); await home(page).getByLabel('查找会话或 Bot',{exact:true}).fill('同名');
    await home(page).getByRole('button',{name:'未读',exact:true}).click();
    await home(page).locator('.mh-row[data-conversation-id="same"]').filter({hasText:'笔记本'}).click();
    await page.getByRole('button',{name:'打开会话列表',exact:true}).click();
    await expect(home(page).getByLabel('查找会话或 Bot',{exact:true})).toHaveValue('同名');
    await expect(home(page).getByRole('button',{name:'未读',exact:true})).toHaveAttribute('aria-pressed','true');
    await openMobileSearch(page); await home(page).getByLabel('查找会话或 Bot',{exact:true}).fill('');
    await home(page).getByRole('button',{name:'全部',exact:true}).click();
    await home(page).getByRole('button',{name:'我的',exact:true}).click();
    await expect(home(page).getByRole('heading', {name:'运行 Bot 的电脑', exact:true})).toBeVisible();
    await expect(home(page).locator('.mh-me-sub')).toHaveText('语言、外观与个人头像');
    await expect(home(page).getByText('我的主机', {exact:true})).toHaveCount(0);
    for (const [computer, ownBot, otherBot] of [['Mac mini', 'A 的专属助手', 'B 的专属助手'], ['笔记本', 'B 的专属助手', 'A 的专属助手']]) {
      const selector = home(page).locator('.mh-cell[aria-pressed]').filter({has:page.getByText(computer, {exact:true})});
      await selector.click();
      await expect(selector).toHaveAttribute('aria-pressed', 'true');
      await home(page).getByRole('button', {name:'运行状态', exact:true}).click();
      const operations = page.getByRole('dialog', {name:'运行状态', exact:true});
      await expect(operations).toContainText(ownBot);
      await expect(operations).not.toContainText(otherBot);
      await operations.getByRole('button', {name:'返回', exact:true}).click();
    }
    await page.screenshot({path:info.outputPath('phone-computer-tools.png')});
    await home(page).getByRole('button',{name:'设置',exact:true}).click();
    await page.getByRole('navigation',{name:'设置分类'}).getByRole('button',{name:/^通用/}).click();
    await page.locator('#language').selectOption('en');
    await closeSettings(page, true);
    await expect(home(page).getByRole('heading', {name:'Computers running Bots', exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath('phone-320-english.png')});
    // Native Back returns from Me to Messages before allowing backgrounding.
    expect(await back(page)).toBe(true);expect(await back(page)).toBe(false);
    const more = home(page).getByRole('button', {name:'List options',exact:true});
    const firstFilter = home(page).getByRole('button', {name:'All',exact:true});
    expect(Math.abs((await more.boundingBox())!.y - (await firstFilter.boundingBox())!.y)).toBeLessThan(2);
    await home(page).getByRole('button', {name:'Groups',exact:true}).click(); // scrolls inside the filter strip if needed
    await expect(more).toBeInViewport();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await more.click();
    await expect(page.getByRole('dialog', {name:'List options',exact:true}).getByRole('checkbox', {name:'Show disconnected Bots',exact:true})).toBeChecked();
    await page.screenshot({path:info.outputPath('phone-list-options-320-english.png'),animations:'disabled'});
    await page.getByRole('button',{name:'Close list options',exact:true}).click();
    await firstFilter.click();
    await home(page).locator('.mh-row[data-conversation-id="same"]').filter({hasText:'笔记本'}).click();
    await expect(page.getByRole('textbox',{name:'Message',exact:true})).toHaveValue('B 的私人草稿');
    await page.screenshot({path:info.outputPath('phone-320-chat.png')});
    // Clear the verified drafts before checking last-message preview authors.
    await page.getByRole('textbox',{name:'Message',exact:true}).fill('');
    await page.getByRole('button',{name:'Open conversation list',exact:true}).click();
    await home(page).locator('.mh-row[data-conversation-id="same"]').filter({hasText:'Mac mini'}).click();
    await page.getByRole('textbox',{name:'Message',exact:true}).fill('');
    // A managed ID can exist on both hosts with different names. The unified
    // inbox must resolve every preview against its own host, not the open chat.
    for (const hub of [a,b]) await hub.store.publishBotMessage('alpha',{conversationId:'same',blocks:[{type:'text',text:`请交给 ${sharedBotId} 继续`}],status:'complete'});
    await page.getByRole('button',{name:'Open conversation list',exact:true}).click();
    await expect(home(page).locator('.mh-row').filter({hasText:'Mac mini'}).locator('.mh-row-preview')).toHaveText('请交给 A 的专属助手 继续');
    await expect(home(page).locator('.mh-row').filter({hasText:'笔记本'}).locator('.mh-row-preview')).toHaveText('请交给 B 的专属助手 继续');
  }finally{await page.close();await a.close();await b.close();await rm(root,{recursive:true,force:true});}
});

test.describe('legacy computer names', () => {
test.use({ serviceWorkers: 'block' });
test('Me labels an old default pairing as a computer without inventing its name', async ({page}, info) => {
  await page.context().route('**/api/host-profile', route => route.fulfill({status:404, contentType:'application/json', body:'{}'}));
  const root = await mkdtemp(path.join(os.tmpdir(), 'mobile-legacy-host-'));
  const hub = await HubServer.start({stateDir:root, clientDir:path.resolve('dist')});
  try {
    await page.setViewportSize({width:390, height:844});
    await page.goto(hub.url); await pair(page, hub, '我的主机');
    await home(page).getByRole('button', {name:'我的', exact:true}).click();
    await expect(home(page).locator('.mh-cell[aria-pressed="true"] .mh-cell-label')).toHaveText('已配对电脑');
    await expect(home(page).getByText('选择一台电脑，查看它的文件、能力与运行状态。', {exact:true})).toBeVisible();
    await expect(home(page).getByRole('heading', {name:'所选电脑的工具', exact:true})).toBeVisible();
    await expect(home(page).getByText('我的主机', {exact:true})).toHaveCount(0);
    await page.screenshot({path:info.outputPath('phone-legacy-computer.png')});
  } finally { await page.close(); await hub.close(); await rm(root, {recursive:true, force:true}); }
});
});

test('opening a long conversation follows latest messages while explicit history jumps keep their target', async ({page}) => {
  const root=await mkdtemp(path.join(os.tmpdir(),'mobile-scroll-'));
  const hub=await HubServer.start({stateDir:root,clientDir:path.resolve('dist')});
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const chat=await hub.store.createConversation('owner',['alpha'],'长对话','long');
    for(let i=0;i<45;i++) await hub.store.publishBotMessage('alpha',{conversationId:chat.id,blocks:[{type:'text',text:`历史记录 ${i}：这是一条用于验证滚动位置的较长回复。`}],status:'complete'});
    await page.setViewportSize({width:390,height:844}); await page.goto(hub.url); await pair(page,hub);
    await openRow(page,chat.title);
    const scroll=page.locator('.host-workspace:not([hidden]) .message-scroll');
    const distance=()=>scroll.evaluate(n=>n.scrollHeight-n.scrollTop-n.clientHeight);
    await expect.poll(distance).toBeLessThan(80);
    await hub.store.publishBotMessage('alpha',{conversationId:chat.id,blocks:[{type:'text',text:'实时最新消息'}],status:'complete'});
    await expect(page.locator('.message-blocks').getByText('实时最新消息',{exact:true})).toBeInViewport();
    await expect.poll(distance).toBeLessThan(80);
    await page.getByRole('button',{name:'打开会话列表',exact:true}).click();
    await openMobileSearch(page); await home(page).getByLabel('查找会话或 Bot',{exact:true}).fill('历史记录 5：');
    await home(page).getByRole('button',{name:'搜索历史消息',exact:true}).click();
    await page.locator('.search-results > button').filter({hasText:'历史记录 5：'}).click();
    await expect(page.locator('.message-blocks').getByText(/^历史记录 5：/)).toBeInViewport();
    await page.getByRole('button',{name:'打开会话列表',exact:true}).click();
    await home(page).getByRole('button',{name:'清除搜索',exact:true}).click();
    await openRow(page,chat.title); await expect.poll(distance).toBeLessThan(80);
    await page.setViewportSize({width:1360,height:900}); await expect.poll(distance).toBeLessThan(80);
  } finally {await page.close();await hub.close();await rm(root,{recursive:true,force:true});}
});

test('closing history search returns to the phone inbox without opening the cached chat', async ({page}) => {
  const root=await mkdtemp(path.join(os.tmpdir(),'mobile-search-return-'));
  const hub=await HubServer.start({stateDir:root,clientDir:path.resolve('dist')});
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const chat=await hub.store.createConversation('owner',['alpha'],'保留的聊天','chat');
    await page.setViewportSize({width:320,height:568}); await page.goto(hub.url); await pair(page,hub);
    await openRow(page,chat.title); await page.getByRole('textbox',{name:'消息',exact:true}).fill('仍然属于原对话的草稿');
    await page.getByRole('button',{name:'打开会话列表',exact:true}).click();
    await hub.store.publishBotMessage('alpha',{conversationId:chat.id,blocks:[{type:'text',text:'搜索期间保留未读'}],status:'complete'});
    await openMobileSearch(page); await home(page).getByLabel('查找会话或 Bot',{exact:true}).fill('搜索期间');
    await home(page).getByRole('button',{name:'搜索历史消息',exact:true}).click();
    await expect(page.getByRole('heading',{name:/搜索结果/})).toBeVisible();
    await expect(page.getByRole('heading',{name:'搜索历史消息',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'更多聊天操作',exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'调整 Bot 思考强度',exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:'关闭搜索',exact:true}).click();
    await expect(home(page)).toBeVisible();
    await expect(home(page).getByLabel('查找会话或 Bot',{exact:true})).toHaveValue('搜索期间');
    await page.waitForTimeout(500);
    expect(Number((await hub.store.db.get<{seq:number}>("SELECT seq FROM reads WHERE conversation_id=? AND user_id='owner'",[chat.id]))?.seq??0)).toBe(0);
    await home(page).getByRole('button',{name:'清除搜索',exact:true}).click();
    await openRow(page,chat.title); await expect(page.getByRole('textbox',{name:'消息',exact:true})).toHaveValue('仍然属于原对话的草稿');
  } finally { await page.close(); await hub.close(); await rm(root,{recursive:true,force:true}); }
});

test('the unified inbox restores its scroll position after opening another host', async ({page}) => {
  const root=await mkdtemp(path.join(os.tmpdir(),'mobile-inbox-scroll-'));
  const a=await HubServer.start({stateDir:path.join(root,'a'),clientDir:path.resolve('dist')});
  const b=await HubServer.start({stateDir:path.join(root,'b'),origins:[a.url]});
  try {
    for(const hub of [a,b]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','助手','fixture')");
    const destination=await b.store.createConversation('owner',['alpha'],'列表底部的笔记本对话','destination');
    for(let i=0;i<30;i++) await a.store.createConversation('owner',['alpha'],`主机对话 ${i}`,`chat-${i}`);
    await page.setViewportSize({width:320,height:568}); await page.goto(a.url); await pair(page,a,'Mac mini');
    await home(page).getByRole('button',{name:'我的',exact:true}).click();
    await home(page).getByRole('button',{name:'设备与网络',exact:true}).click();
    await page.getByRole('dialog',{name:'设备与网络',exact:true}).getByRole('button',{name:/^此设备连接另一台主机/}).click();
    await pair(page,b,'笔记本');
    await home(page).getByRole('button',{name:'我的',exact:true}).click();
    await home(page).getByRole('button',{name:/Mac mini 已连接/}).click();
    await home(page).getByRole('navigation',{name:'主导航'}).getByRole('button',{name:/^消息/}).click();
    const row=home(page).locator('.mh-row').filter({has:page.getByText(destination.title,{exact:true})});
    await row.scrollIntoViewIfNeeded();
    const position=await home(page).locator('.mh-body').evaluate(n=>n.scrollTop); expect(position).toBeGreaterThan(500);
    await row.click(); await expect(page.getByRole('heading',{name:destination.title,exact:true})).toBeVisible();
    await page.getByRole('button',{name:'打开会话列表',exact:true}).click();
    await expect.poll(()=>home(page).locator('.mh-body').evaluate(n=>n.scrollTop)).toBeGreaterThan(position-2);
    await expect(row).toBeInViewport();
  } finally {await page.close();await a.close();await b.close();await rm(root,{recursive:true,force:true});}
});

test('compact inbox search opens from the title bar and closes without hidden filtering', async ({page}, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mobile-search-entry-'));
  const hub = await HubServer.start({stateDir:root, clientDir:path.resolve('dist')});
  try {
    for (const [id, name] of [['alpha','产品助手'], ['beta','研究助手']]) {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,'fixture')", [id,name]);
      await hub.store.createConversation('owner', [id], name + '的对话', id);
    }
    await page.setViewportSize({width:390,height:844}); await page.goto(hub.url); await pair(page,hub);
    await expect(home(page).locator('.mh-search')).toHaveCount(0);
    await expect(home(page).locator('.mh-titlebar').getByRole('button', {name:'搜索会话或 Bot',exact:true})).toBeVisible();
    const noLines = () => home(page).locator('.mh-list > li').evaluateAll(rows => rows.every(row => getComputedStyle(row,'::before').content === 'none'));
    expect(await noLines()).toBe(true);
    await page.screenshot({path:info.outputPath('compact-inbox.png')});
    await openMobileSearch(page); const search = home(page).getByRole('searchbox'); await expect(search).toBeFocused();
    await search.fill('产品'); await expect(home(page).locator('.mh-row')).toHaveCount(1);
    await search.press('Escape'); await expect(search).toHaveCount(0); await expect(home(page).locator('.mh-row')).toHaveCount(2);
    await expect(home(page).getByRole('button', {name:'搜索会话或 Bot',exact:true})).toBeFocused();
    await openMobileSearch(page); await search.fill('研究'); expect(await back(page)).toBe(true);
    await expect(search).toHaveCount(0); await expect(home(page).locator('.mh-row')).toHaveCount(2);
    await home(page).getByRole('navigation', {name:'主导航'}).getByRole('button',{name:'Bot',exact:true}).click();
    expect(await noLines()).toBe(true); await expect(home(page).locator('.mh-search')).toHaveCount(0);
    await openMobileSearch(page); await search.fill('产品'); await expect(home(page).locator('.mh-bot-row')).toHaveCount(1);
  } finally { await page.close(); await hub.close(); await rm(root,{recursive:true,force:true}); }
});

test('phone unread counts sit on the avatar corner while the spoken count stays after the preview', async ({page}) => {
  const root=await mkdtemp(path.join(os.tmpdir(),'mobile-avatar-unread-'));
  const hub=await HubServer.start({stateDir:root,clientDir:path.resolve('dist')});
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','产品助手','fixture')");
    const chat=await hub.store.createConversation('owner',['alpha'],'设计讨论','direct');
    for (const text of ['第一条','第二条']) await hub.store.publishBotMessage('alpha',{conversationId:chat.id,blocks:[{type:'text',text}],status:'complete'});
    await page.setViewportSize({width:390,height:844});await page.goto(hub.url);await pair(page,hub);
    const row=home(page).locator(`[data-conversation-id="${chat.id}"]`);
    await expect(row.locator('.mh-avatar>.mh-badge>[aria-hidden=true]')).toHaveText('2');
    // Screen readers still hear the count once, after the preview.
    await expect(row.locator('.mh-row-bottom>.mh-sr-only')).toHaveText('2 条未读');
    await expect(row.locator('.mh-badge .mh-sr-only')).toHaveCount(0);
    const corner=await row.evaluate(node=>{
      const avatar=node.querySelector('.mh-avatar')!.getBoundingClientRect(), badge=node.querySelector('.mh-badge')!;
      const box=badge.getBoundingClientRect();
      return {onTop:box.top<avatar.top+4&&box.bottom>avatar.top, onRight:box.right>avatar.right&&box.left<avatar.right, ring:getComputedStyle(badge).boxShadow};
    });
    expect(corner).toMatchObject({onTop:true,onRight:true});
    expect(corner.ring).not.toBe('none');
  } finally { await page.close(); await hub.close(); await rm(root,{recursive:true,force:true}); }
});
