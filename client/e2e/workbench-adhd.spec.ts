import { workbenchContentTargets } from "./fixtures/workbench-targets.js";
import { widgetBlock } from "../../src/client-protocol/widget.js";
import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import type { WorkbenchBroker } from '../../src/hub/workbench.js';
import { preparePairing } from './fixtures/pairing-invite.js';
import { showDisconnectedBots, selectConversation, waitForClientOnline } from './fixtures/mobile.js';
import { openSettings, closeSettings } from './fixtures/settings.js';

test.use({ serviceWorkers: 'block' });
const card = (page: Page, id: string) => page.locator(`.adhd-card[data-pane-conversation="${id}"]`);
const workbench = (page: Page) => page.getByRole('complementary', { name: '工作台', exact: true });
async function fixture(page: Page, adhd = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workbench-adhd-'));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  await hub.profile.update({ name: '测试主机', revision: (await hub.profile.read()).revision });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','工作台助手','fixture')");
  const a = await hub.store.createConversation('owner', ['alpha'], '资料浏览', 'chat_a');
  const b = await hub.store.createConversation('owner', ['alpha'], '第二项工作', 'chat_b');
  for (const conversation of [a, b]) await hub.store.publishBotMessage('alpha', { conversationId: conversation.id, status: 'complete', blocks: [{ type: 'text', text: `这是${conversation.title}的历史` }, widgetBlock({ title: '示例图表', summary: 'Synthetic fixture', report: { version: 1, columns: ['项目', '数量'], rows: [['A', 2]], chart: { kind: 'bar', category: 0, values: [1] } } })] });
  await page.goto(hub.url); await preparePairing(page, hub);
  await page.getByRole('button', { name: '配对此设备', exact: true }).click();
  await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
  await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
  await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, a.title);
  // Only the native boundary is simulated. App, IndexedDB, Host broker and
  // authenticated connection are real. Native WebContentsView acceptance is separate.
  await page.evaluate(() => {
    const calls: any[] = [], layouts: any[] = [], tabs = new Map<string, any>(), listeners = new Set<(event: any) => void>();
    Object.assign(window, { browserFixture: { calls, layouts, tabs, listeners }, tarobotDesktop: {
      version: 1, engine: 'electron', platform: 'darwin', openSocket: async () => { throw Error('unexpected_socket'); },
      on: (event: string, receive: (payload: any) => void) => { if (event === 'workbench-browser') listeners.add(receive); return () => listeners.delete(receive); },
      invoke: async (command: string, args: any) => {
        calls.push({command, args});
        if (command === 'desktop_window_read') return {width:innerWidth,height:innerHeight,outerWidth:innerWidth,outerHeight:innerHeight,x:0,y:0,scale:1,maximized:true,fullscreen:false,resizable:true,visible:true,minimized:false,work:{x:0,y:0,width:3000,height:1600}};
        if (command === 'workbench_browser_layout') { layouts.push(args); return; }
        if (command !== 'workbench_browser') return null;
        if (args.action === 'capabilities') return { status: 'ok', window: 'native-window' };
        if (args.action === 'list') return { status: 'ok', tabs: [...tabs.values()].filter(tab => JSON.stringify(tab.scope) === JSON.stringify(args.scope)) };
        if (args.action === 'open' || args.action === 'navigate') {
          const tab = args.restore && tabs.get(args.tab) || { tab: args.tab, scope: args.scope, url: args.url, title: '资料网页', navigation: 1, canGoBack: false, canGoForward: false };
          tabs.set(args.tab, tab); queueMicrotask(() => listeners.forEach(receive => receive({ ...tab, kind: 'state' }))); return {status:'ok', ...tab};
        }
        if (args.action === 'close') tabs.delete(args.tab);
        return {status:'ok', tab:args.tab};
      },
    } });
  });
  // Install the native boundary before mounting ADHD panes and their browser dock.
  if (adhd) {
    await page.getByRole('button', { name: '打开 ADHD 模式', exact: true }).click();
    for (const conversation of [a,b]) await page.getByRole('checkbox', { name: `加入面板：测试主机 · ${conversation.title}`, exact: true }).check();
    await expect(card(page, a.id).locator('.composer textarea')).toBeVisible();
  }
  const broker = (hub as unknown as {workbench:WorkbenchBroker}).workbench;
  const actor = (conversationId: string) => ({ userId:'owner', conversationId, validate:async () => undefined });
  return {hub, a, b, broker, actor, close:async () => { await page.close(); await hub.close(); await rm(root,{recursive:true,force:true}); }};
}
async function openChartFromMessage(page: Page, id: string) {
  await card(page,id).getByRole('button',{name:'在工作台打开',exact:true}).click();
}
async function openBrowser(page: Page, id: string) {
  await openChartFromMessage(page,id);
  await expect(card(page,id)).toHaveClass(/is-expanded/);
  await expect(workbench(page).getByRole('tab',{name:'示例图表',exact:true})).toBeVisible();
  await workbench(page).getByRole('button',{name:'新建内容',exact:true}).click();
  await workbench(page).getByRole('button',{name:'新建网页',exact:true}).click();
  await expect(workbench(page).getByRole('textbox',{name:'网址或搜索',exact:true})).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).browserFixture.layouts.at(-1)?.views.length)).toBe(1);
}
async function nativeViews(page: Page) { return page.evaluate(() => (window as any).browserFixture.layouts.at(-1)?.views.map((view:any) => view.tab) ?? []); }

test('ADHD hides workbench and screen shortcuts in overview and expanded panes, ordinary chat retains both', async ({page}) => {
  const f = await fixture(page);
  try {
    const shortcuts = page.locator('.adhd-card .workbench-trigger, .adhd-card .screen-trigger');
    await expect(shortcuts).toHaveCount(0);
    await expect(page.locator('.adhd-toolbar .adhd-browser-entry')).toBeVisible();
    await card(page, f.a.id).locator('.composer textarea').fill('Keep the pane draft');
    await card(page, f.a.id).getByRole('button', {name:'放大此面板', exact:true}).click();
    await expect(card(page, f.a.id)).toHaveClass(/is-expanded/);
    await expect(shortcuts).toHaveCount(0);
    await card(page, f.a.id).getByRole('button', {name:'在单对话中打开', exact:true}).click();
    const header = page.locator('.host-workspace:not([hidden]) .conversation-header');
    await expect(header.getByRole('button', {name:'工作台', exact:true})).toBeVisible();
    await expect(header.getByRole('button', {name:'查看屏幕', exact:true})).toBeVisible();
    await expect(page.locator('.host-workspace:not([hidden]) .composer textarea')).toHaveValue('Keep the pane draft');
    await header.getByRole('button', {name:'工作台', exact:true}).click();
    await expect(workbench(page)).toBeVisible();
    await workbench(page).getByRole('button', {name:'返回聊天', exact:true}).click();
    await page.getByRole('button', {name:'打开 ADHD 模式', exact:true}).click();
    await expect(card(page, f.a.id).locator('.composer textarea')).toHaveValue('Keep the pane draft');
    await expect(shortcuts).toHaveCount(0);
  } finally { await f.close(); }
});

test('switching conversations while workbench initializes keeps B closed and restores A', async ({page}) => {
  const f = await fixture(page, false);
  try {
    await page.evaluate(conversationId => {
      const fixture = (window as any).browserFixture, bridge = (window as any).tarobotDesktop, invoke = bridge.invoke;
      bridge.invoke = async (command: string, args: any) => {
        if (command === 'workbench_browser' && args.action === 'list' && args.scope.conversation === conversationId) {
          await new Promise<void>(resolve => { fixture.releaseInitialize = resolve; });
          fixture.initializationFinished = true;
        }
        return invoke(command, args);
      };
    }, f.a.id);
    const toggle = page.getByRole('button', {name:'工作台', exact:true});
    await toggle.click();
    await expect.poll(() => page.evaluate(() => !!(window as any).browserFixture.releaseInitialize)).toBe(true);
    await selectConversation(page, f.b.title);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(workbench(page)).toBeHidden();
    await page.evaluate(() => (window as any).browserFixture.releaseInitialize());
    await expect.poll(() => page.evaluate(() => !!(window as any).browserFixture.initializationFinished)).toBe(true);
    await expect(workbench(page)).toBeHidden();
    expect(await workbenchContentTargets(f.broker, f.actor(f.b.id))).toEqual([]);
    await selectConversation(page, f.a.title);
    await expect(workbench(page).locator('.workbench-tabrow')).toBeVisible();
    await expect.poll(async () => (await workbenchContentTargets(f.broker, f.actor(f.a.id))).length).toBe(1);
  } finally { await f.close(); }
});

test('a delayed initialization failure in A does not show an error in B', async ({page}) => {
  const f = await fixture(page, false);
  try {
    await page.evaluate(conversationId => {
      const fixture = (window as any).browserFixture, bridge = (window as any).tarobotDesktop, invoke = bridge.invoke;
      let fail = true;
      bridge.invoke = async (command: string, args: any) => {
        if (command === 'workbench_browser' && args.action === 'list' && args.scope.conversation === conversationId && fail) {
          fail = false;
          await new Promise<void>(resolve => { fixture.releaseFailure = resolve; });
          throw Error('A delayed initialization failed');
        }
        return invoke(command, args);
      };
    }, f.a.id);
    await page.getByRole('button', {name:'工作台', exact:true}).click();
    await expect.poll(() => page.evaluate(() => !!(window as any).browserFixture.releaseFailure)).toBe(true);
    await selectConversation(page, f.b.title);
    await page.evaluate(() => (window as any).browserFixture.releaseFailure());
    await expect.poll(() => page.evaluate(() => (window as any).browserFixture.listeners.size)).toBe(0);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText('A delayed initialization failed', {exact:true})).toHaveCount(0);
    await expect(workbench(page)).toBeHidden();
    await selectConversation(page, f.a.title);
    await expect(workbench(page)).toBeVisible();
  } finally { await f.close(); }
});

test('an initialization failure while an ADHD pane is hidden stays with that pane', async ({page}) => {
  const f = await fixture(page);
  try {
    await page.evaluate(conversationId => {
      const fixture = (window as any).browserFixture, bridge = (window as any).tarobotDesktop, invoke = bridge.invoke;
      let fail = true;
      bridge.invoke = async (command: string, args: any) => {
        if (command === 'workbench_browser' && args.action === 'list' && args.scope.conversation === conversationId && fail) {
          fail = false;
          await new Promise<void>(resolve => { fixture.releaseHiddenFailure = resolve; });
          throw Error('Hidden A initialization failed');
        }
        return invoke(command, args);
      };
    }, f.a.id);
    await openChartFromMessage(page,f.a.id);
    await expect.poll(() => page.evaluate(() => !!(window as any).browserFixture.releaseHiddenFailure)).toBe(true);
    await card(page,f.a.id).getByRole('button',{name:'回到面板总览',exact:true}).click();
    await card(page,f.b.id).getByRole('button',{name:'放大此面板',exact:true}).click();
    await expect(card(page,f.a.id)).toBeHidden();
    await page.evaluate(() => (window as any).browserFixture.releaseHiddenFailure());
    await expect.poll(() => page.evaluate(() => (window as any).browserFixture.listeners.size)).toBe(0);
    await expect(card(page,f.b.id).getByText('Hidden A initialization failed',{exact:true})).toHaveCount(0);
    await card(page,f.b.id).getByRole('button',{name:'回到面板总览',exact:true}).click();
    await card(page,f.a.id).getByRole('button',{name:'放大此面板',exact:true}).click();
    await expect(card(page,f.a.id).locator('.error-banner')).toHaveText('Hidden A initialization failed');
    await openChartFromMessage(page,f.a.id);
    await expect(workbench(page)).toBeVisible();
  } finally { await f.close(); }
});

test('failed initialization releases the native listener and a fresh attempt opens normally', async ({page}) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const f = await fixture(page, false);
  try {
    await page.evaluate(() => {
      const bridge = (window as any).tarobotDesktop, invoke = bridge.invoke; let fail = true;
      bridge.invoke = async (command:string, args:any) => {
        const result = await invoke(command, args);
        if (args?.action === 'list' && fail) { fail = false; throw Error('fixture_native_list_failed'); }
        return result;
      };
    });
    const trigger = page.getByRole('button',{name:'工作台',exact:true});
    await trigger.click();
    await expect(page.getByText('fixture_native_list_failed', {exact:true})).toBeVisible();
    expect(await page.evaluate(() => (window as any).browserFixture.listeners.size)).toBe(0);
    await trigger.click(); await trigger.click();
    await expect(workbench(page)).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).browserFixture.listeners.size)).toBe(1);
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('leaving an initializing ADHD pane cannot attach late listeners or restore pages', async ({page}) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const f = await fixture(page);
  try {
    await page.evaluate(() => {
      const fixture = (window as any).browserFixture, bridge = (window as any).tarobotDesktop, invoke = bridge.invoke;
      bridge.invoke = async (command:string, args:any) => {
        const result = await invoke(command,args);
        if (args?.action === 'capabilities') await new Promise<void>(resolve => { fixture.release = resolve; });
        return result;
      };
    });
    await openChartFromMessage(page,f.a.id);
    await expect.poll(() => page.evaluate(() => typeof (window as any).browserFixture.release)).toBe('function');
    await card(page,f.a.id).getByRole('button',{name:'在单对话中打开',exact:true}).click();
    await expect(page.locator('.adhd-shell')).toHaveCount(0);
    const result = await page.evaluate(async () => {
      const fixture = (window as any).browserFixture; fixture.release();
      await new Promise(resolve => setTimeout(resolve, 50));
      return {listeners:fixture.listeners.size, actions:fixture.calls.filter((call:any) => call.command === 'workbench_browser').map((call:any) => call.args.action)};
    });
    expect(result).toEqual({listeners:0,actions:['capabilities']}); expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('streaming DOM outside a browser pane sends no unchanged native layouts', async ({page}, info) => {
  const f = await fixture(page);
  try {
    await openBrowser(page, f.a.id);
    await expect.poll(() => workbench(page).evaluate(node => node.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0);
    const sample = await page.evaluate(async () => {
      const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      await frame(); await frame();
      const layouts = (window as any).browserFixture.layouts, before = layouts.length;
      const node = document.createElement('span'); node.hidden = true; document.body.append(node);
      for (let i = 0; i < 30; i++) { node.textContent = `stream ${i}`; node.className = `stream-${i}`; await frame(); }
      node.remove(); await frame(); await frame();
      return { mutations: 30, redundantLayouts: layouts.length - before };
    });
    await info.attach('layout-ipc.json', {body: JSON.stringify(sample), contentType:'application/json'});
    expect(sample.redundantLayouts).toBe(0);
    // Geometry changes and hiding still cross the real App layout pipeline.
    await page.setViewportSize({width:1100,height:800});
    await expect.poll(() => page.evaluate(() => {
      const node = document.querySelector('.workbench-browser-viewport');
      const layout = (window as any).browserFixture.layouts.at(-1);
      return !!node && layout?.views.some((view:any) => Math.abs(view.width - node.getBoundingClientRect().width) < 1);
    })).toBe(true);
    await workbench(page).getByRole('button',{name:'返回聊天',exact:true}).click();
    await expect.poll(() => nativeViews(page)).toEqual([]);
  } finally { await f.close(); }
});

test('ADHD browser expands the owning card, preserves drafts and isolates hidden targets', async ({page},info) => {
  const f = await fixture(page);
  try {
    await card(page,f.a.id).locator('.composer textarea').fill('资料浏览草稿');
    await card(page,f.b.id).locator('.composer textarea').fill('第二项工作草稿');
    // Native visibility reads happen when the panes mount. Opening their
    // Workbench must not add any native frame reads, resizing or repositioning.
    const frameCalls = await page.evaluate(() => (window as any).browserFixture.calls.filter((call:any) => /^desktop_window_(read|size|position)$/.test(call.command)));
    expect(frameCalls.every((call:any) => call.command === 'desktop_window_read')).toBe(true);
    await openBrowser(page,f.a.id);
    const aTab = (await nativeViews(page))[0];
    await workbench(page).getByRole('textbox',{name:'网址或搜索',exact:true}).fill('https://example.com/first');
    await workbench(page).getByRole('button',{name:'打开网址',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window as any).browserFixture.calls.findLast((call:any)=>call.command==='workbench_browser'&&call.args.action==='navigate')?.args.url)).toBe('https://example.com/first');
    await workbench(page).getByRole('textbox',{name:'网址或搜索',exact:true}).fill('https://example.com/keyboard');
    // The first navigation can redirect while the still-focused address field
    // is already editing the next URL. Native state must not erase that edit.
    await page.evaluate(tabId => {
      const f = (window as any).browserFixture, tab = { ...f.tabs.get(tabId), url: 'https://example.com/first/redirected', navigation: 2 };
      f.tabs.set(tabId, tab); f.listeners.forEach((receive: (event: any) => void) => receive({ ...tab, kind: 'state' }));
    }, aTab);
    await expect(workbench(page).getByRole('textbox',{name:'网址或搜索',exact:true})).toHaveValue('https://example.com/keyboard');
    // Exercise keyboard Go independently of macOS/WebKit's button Tab policy.
    await workbench(page).getByRole('button',{name:'打开网址',exact:true}).focus(); await page.keyboard.press('Enter');
    await expect.poll(()=>page.evaluate(()=>(window as any).browserFixture.calls.findLast((call:any)=>call.command==='workbench_browser'&&call.args.action==='navigate')?.args.url)).toBe('https://example.com/keyboard');
    await expect.poll(async () => (await workbenchContentTargets(f.broker, f.actor(f.a.id))).filter(target => target.visible && target.tabs.some(tab => tab.id === aTab)).length).toBe(1);
    const targetA = (await workbenchContentTargets(f.broker, f.actor(f.a.id)))[0]!;
    const noteA=await f.broker.request(f.actor(f.a.id),{requestId:'same_note_id',operation:'markdown.create',target:{deviceId:targetA.deviceId,windowId:targetA.windowId},payload:{title:'A 笔记.md',content:'A 的内容'}});
    expect(noteA).toMatchObject({status:'applied',saved:true});
    await workbench(page).getByRole('tab',{name:'资料网页',exact:true}).click();
    expect(targetA.tabs).toEqual(expect.arrayContaining([expect.objectContaining({id:aTab,kind:'browser'})]));
    await expect(card(page,f.a.id).locator('.composer textarea')).toHaveValue('资料浏览草稿');
    await expect(card(page,f.b.id)).toBeHidden();
    const geometry = await workbench(page).evaluate(node => {
      const wb=node.getBoundingClientRect(), shell=node.parentElement!, main=shell.querySelector('.conversation-main')!.getBoundingClientRect(), row=node.querySelector('.workbench-tabrow')!.getBoundingClientRect(), header=shell.querySelector('.conversation-header')!.getBoundingClientRect();
      return {gap:Math.abs(wb.left-main.right), height:Math.abs(row.height-header.height), overflow:node.scrollWidth-node.clientWidth, inside:wb.right<=shell.getBoundingClientRect().right+1};
    });
    expect(geometry).toEqual({gap:0,height:0,overflow:0,inside:true});
    await page.screenshot({path:info.outputPath('adhd-browser-docked.png')});
    await workbench(page).getByRole('button',{name:'新建内容',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window as any).browserFixture.layouts.at(-1)?.hidden)).toBe(true);
    await workbench(page).getByRole('button',{name:'新建内容',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window as any).browserFixture.layouts.at(-1)?.hidden)).toBe(false);
    await workbench(page).getByRole('button',{name:'展开到主区',exact:true}).click();
    await expect(card(page,f.a.id).locator('.message-scroll')).toBeHidden();
    await expect(card(page,f.a.id).locator('.composer textarea')).toBeVisible();
    const readBefore=(await f.hub.store.db.get<{seq:number}>("SELECT seq FROM reads WHERE user_id='owner' AND conversation_id=?",[f.a.id]))?.seq??0;
    await f.hub.store.publishBotMessage('alpha',{conversationId:f.a.id,blocks:[{type:'text',text:'工作台展开期间的新消息'}]});
    await page.waitForTimeout(600);
    expect((await f.hub.store.db.get<{seq:number}>("SELECT seq FROM reads WHERE user_id='owner' AND conversation_id=?",[f.a.id]))?.seq??0).toBe(readBefore);
    await workbench(page).getByRole('button',{name:'返回右侧',exact:true}).click();
    await card(page,f.a.id).getByRole('button',{name:'回到面板总览',exact:true}).click();
    await expect(workbench(page)).toHaveCount(0); await expect.poll(() => nativeViews(page)).toEqual([]);
    await expect(card(page,f.b.id).locator('.composer textarea')).toHaveValue('第二项工作草稿');
    await expect.poll(async () => (await workbenchContentTargets(f.broker, f.actor(f.a.id)))[0]?.visible).toBe(false);
    await expect(f.broker.request(f.actor(f.a.id), {requestId:'hidden-browser',operation:'browser',target:{deviceId:targetA.deviceId,windowId:targetA.windowId,tabId:aTab},payload:{action:'observe'}})).resolves.toMatchObject({status:'not_executed',error:'workbench_hidden'});
    await openBrowser(page,f.b.id); const bTab=(await nativeViews(page))[0]; expect(bTab).not.toBe(aTab);
    const targetB=(await workbenchContentTargets(f.broker, f.actor(f.b.id)))[0]!;
    const noteB=await f.broker.request(f.actor(f.b.id),{requestId:'same_note_id',operation:'markdown.create',target:{deviceId:targetB.deviceId,windowId:targetB.windowId},payload:{title:'B 笔记.md',content:'B 的内容'}});
    expect(noteB).toMatchObject({status:'applied',saved:true});
    expect(noteB.result).toMatchObject({tabId:(noteA.result as {tabId:string}).tabId});
    const ids=await page.locator('.workbench, .workbench [id]').evaluateAll(nodes=>nodes.map(node=>node.id)); expect(new Set(ids).size).toBe(ids.length);
    await expect.poll(async () => (await workbenchContentTargets(f.broker, f.actor(f.b.id)))[0]?.visible).toBe(true);
    await card(page,f.b.id).getByRole('button',{name:'回到面板总览',exact:true}).click();
    await card(page,f.a.id).getByRole('button',{name:'放大此面板',exact:true}).click();
    await expect.poll(() => nativeViews(page)).toEqual([aTab]);
    await expect(workbench(page).getByRole('textbox',{name:'网址或搜索',exact:true})).toHaveValue('https://example.com/keyboard');
    await expect(card(page,f.a.id).locator('.composer textarea')).toHaveValue('资料浏览草稿');
    expect(await page.evaluate(() => (window as any).browserFixture.calls.filter((call:any)=>/^desktop_window_(read|size|position)$/.test(call.command)))).toEqual(frameCalls);
    await workbench(page).getByRole('button',{name:'返回聊天',exact:true}).click();
    await expect.poll(() => nativeViews(page)).toEqual([]);
  } finally { await f.close(); }
});

test('narrow ADHD browser keeps composer reachable and recovers after mode changes', async ({page},info) => {
  const f=await fixture(page);
  try {
    await card(page,f.a.id).locator('.composer textarea').fill('切换后保留的草稿');
    await openBrowser(page,f.a.id); const tab=(await nativeViews(page))[0];
    await page.setViewportSize({width:1000,height:900});
    await expect(workbench(page)).toHaveClass(/workbench-wide/);
    await expect(card(page,f.a.id).locator('.composer textarea')).toBeVisible();
    const fit=await workbench(page).evaluate(node=>{const r=node.getBoundingClientRect(),shell=node.parentElement!,c=shell.querySelector('.composer-wrap')!.getBoundingClientRect();return {bottom:r.bottom<=c.top+1,width:r.width,overflow:node.scrollWidth-node.clientWidth};});
    expect(fit.bottom).toBe(true);expect(fit.width).toBeGreaterThan(450);expect(fit.overflow).toBe(0);
    const fits = () => workbench(page).locator('.workbench-tabrow').evaluate(node => {
      const row = node.getBoundingClientRect();
      return [...node.querySelectorAll('.workbench-tab-actions>button')].every(button => { const r = button.getBoundingClientRect(); return r.left >= row.left && r.right <= row.right && r.top >= row.top && r.bottom <= row.bottom; });
    });
    await expect.poll(fits).toBe(true);
    await workbench(page).getByRole('button',{name:'全部标签和已关闭内容',exact:true}).click();
    await workbench(page).getByRole('button',{name:'标签选项：资料网页',exact:true}).click();
    const menu = workbench(page).getByRole('menu');
    await expect(menu.getByRole('button',{name:'重命名',exact:true})).toBeVisible();
    expect(await menu.evaluate(node => {
      const r=node.getBoundingClientRect(), wb=node.closest('.workbench')!.getBoundingClientRect();
      return r.left >= wb.left && r.right <= wb.right && r.top >= wb.top && r.bottom <= wb.bottom;
    })).toBe(true);
    await page.screenshot({path:info.outputPath('adhd-browser-narrow-menu.png')});
    await page.keyboard.press('Escape');
    await page.screenshot({path:info.outputPath('adhd-browser-narrow.png')});
    await page.getByRole('button',{name:'打开 Agent Bus',exact:true}).click();
    await expect(page.locator('.agent-bus-dock')).toHaveClass(/is-open/);
    await expect.poll(()=>page.evaluate(()=>(window as any).browserFixture.layouts.at(-1)?.hidden)).toBe(true);
    await page.getByRole('button',{name:'收起 Agent Bus',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window as any).browserFixture.layouts.at(-1)?.hidden)).toBe(false);
    await page.setViewportSize({width:700,height:900});
    await expect(page.getByRole('heading',{name:'拉宽窗口，继续多对话',exact:true})).toBeVisible();
    await expect.poll(()=>nativeViews(page)).toEqual([]);
    await page.setViewportSize({width:1360,height:900});
    await expect(workbench(page)).toHaveClass(/conversation-side-panel/);
    await expect.poll(()=>nativeViews(page)).toEqual([tab]);
    await card(page,f.a.id).getByRole('button',{name:'在单对话中打开',exact:true}).click();
    await expect(page.locator('.adhd-shell')).toHaveCount(0);
    await expect(page.locator('.host-workspace:not([hidden]) .composer textarea')).toHaveValue('切换后保留的草稿');
    await page.getByRole('button',{name:'工作台',exact:true}).click();
    await expect.poll(()=>nativeViews(page)).toEqual([tab]);
    await expect(workbench(page).getByRole('tab')).toHaveText(['示例图表', '资料网页']);
  } finally {await f.close();}
});

test('ADHD personal browser opens beside the board, keeps pages across conversations and mode changes', async ({page},info) => {
  const f=await fixture(page);
  try {
    await card(page,f.a.id).locator('.composer textarea').fill('第一项草稿');
    await card(page,f.b.id).locator('.composer textarea').fill('第二项草稿');
    const toggle=page.locator('.adhd-toolbar .adhd-browser-entry');
    await expect(toggle).toBeVisible();
    const before=await page.locator('.adhd-card').count();
    await toggle.click();
    const dock=page.getByRole('complementary',{name:'浏览器',exact:true});
    await expect(dock).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const left = document.querySelector('.adhd-toolbar')!.getBoundingClientRect();
      const right = document.querySelector('.adhd-browser-header')!.getBoundingClientRect();
      return Math.abs(left.bottom - right.bottom);
    })).toBeLessThanOrEqual(1);
    await expect(dock.getByRole('textbox',{name:'网址或搜索',exact:true})).toBeVisible();
    await expect(page.locator('.adhd-card.is-expanded')).toHaveCount(0);
    await expect(page.locator('.adhd-card')).toHaveCount(before);
    await expect.poll(()=>nativeViews(page)).toHaveLength(1);
    const first=await page.evaluate(()=>(window as any).browserFixture.layouts.at(-1).views[0].tab);
    await card(page,f.a.id).locator('.composer textarea').click();
    expect(await nativeViews(page)).toEqual([first]);
    await expect(dock.getByText('可在主对话中让 Bot 操作此页',{exact:true})).toHaveCount(0);
    const entry=await toggle.boundingBox(),bus=await page.getByRole('button',{name:'打开 Agent Bus',exact:true}).boundingBox();
    expect(entry!.x-bus!.x-bus!.width).toBeLessThan(15);
    await page.screenshot({path:info.outputPath('adhd-personal-browser.png'),animations:'disabled'});
    await dock.getByRole('button',{name:'新建浏览器标签',exact:true}).click();
    await expect(dock.getByRole('tab')).toHaveCount(2);
    await expect.poll(()=>nativeViews(page)).not.toEqual([first]);
    const second=await page.evaluate(()=>(window as any).browserFixture.layouts.at(-1).views[0].tab);
    expect(second).not.toBe(first);
    await dock.getByRole('tab').first().click();
    await expect.poll(()=>nativeViews(page)).toEqual([first]);
    await dock.getByRole('button',{name:'关闭浏览器侧栏',exact:true}).click();
    await expect(dock).toBeHidden();await expect(toggle).toBeFocused();
    await expect.poll(()=>nativeViews(page)).toEqual([]);
    await toggle.click();await expect(dock.getByRole('tab')).toHaveCount(2);
    await expect.poll(()=>nativeViews(page)).toEqual([first]);
    await page.getByRole('button',{name:'打开 Agent Bus',exact:true}).click();
    await expect(dock).toBeHidden();await expect.poll(()=>nativeViews(page)).toEqual([]);
    await toggle.click();await expect(dock).toBeVisible();
    await expect(page.locator('.agent-bus-dock')).not.toHaveClass(/is-open/);
    await expect(card(page,f.a.id).locator('.composer textarea')).toHaveValue('第一项草稿');
    await expect(card(page,f.b.id).locator('.composer textarea')).toHaveValue('第二项草稿');
    const scopeCalls=await page.evaluate(()=>(window as any).browserFixture.calls.filter((c:any)=>c.command==='workbench_browser').map((c:any)=>c.args));
    expect(scopeCalls.every((args:any)=>args.source==='user'&&args.scope.host==='tarobot-personal-browser-v1'&&args.scope.conversation==='personal')).toBe(true);
    await page.getByRole('button',{name:'返回聊天',exact:true}).click();
    await expect(page.locator('.adhd-shell')).toHaveCount(0);
    await expect.poll(()=>nativeViews(page)).toEqual([]);
    await page.getByRole('button',{name:'打开 ADHD 模式',exact:true}).click();
    await toggle.click();await expect(dock.getByRole('tab')).toHaveCount(2);
    await expect.poll(()=>nativeViews(page)).toEqual([first]);
  } finally {await f.close();}
});

test('ADHD personal browser can retry native registration failure and hides behind its tools',async({page})=>{
  const f=await fixture(page);
  try{
    await card(page,f.a.id).locator('.composer textarea').click();
    await page.evaluate(()=>{
      const bridge=(window as any).tarobotDesktop,invoke=bridge.invoke;let fail=true;
      bridge.invoke=async(command:string,args:any)=>{
        if(args?.action==='list'&&fail){fail=false;throw Error('fixture_browser_list_failed');}
        return invoke(command,args);
      };
    });
    await page.locator('.adhd-toolbar .adhd-browser-entry').click();
    const dock=page.getByRole('complementary',{name:'浏览器',exact:true});
    await expect(dock.getByRole('alert')).toContainText('fixture_browser_list_failed');
    await dock.getByRole('button',{name:'重试',exact:true}).click();
    await expect(dock.getByRole('tab')).toHaveCount(1);
    await expect.poll(()=>nativeViews(page)).toHaveLength(1);
    await dock.getByRole('button',{name:'网页工具与下载',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window as any).browserFixture.layouts.at(-1)?.hidden)).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(()=>page.evaluate(()=>(window as any).browserFixture.layouts.at(-1)?.hidden)).toBe(false);
  }finally{await f.close();}
});

// Real React opening hook and geometry, with only the OS frame IPC replaced.
// The native browser itself has a separate WebContentsView acceptance run.
test('ADHD personal dock waits for native expansion and restores on close or mode switch', async ({page}) => {
  const f=await fixture(page);
  try {
    await card(page,f.a.id).locator('.composer textarea').click();
    await page.evaluate(()=>{
      const fixture=(window as any).browserFixture, bridge=(window as any).tarobotDesktop, invoke=bridge.invoke;
      const state=fixture.frame={width:innerWidth,height:innerHeight,x:0,y:0};let first=true;
      bridge.invoke=async(command:string,args:any)=>{
        if(command==='desktop_window_read'){
          if(first){first=false;await new Promise<void>(resolve=>{fixture.releaseFrame=resolve;});}
          return {...state,outerWidth:state.width,outerHeight:state.height,scale:1,maximized:false,fullscreen:false,resizable:true,work:{x:0,y:0,width:3000,height:1600}};
        }
        if(command==='desktop_window_size'){state.width=args.width;state.height=args.height;return;}
        if(command==='desktop_window_position'){state.x=args.x;state.y=args.y;return;}
        return invoke(command,args);
      };
    });
    const root=page.locator('.adhd-shell'),toggle=page.locator('.adhd-browser-entry'),dock=page.locator('#adhd-personal-browser');
    const baseline=await page.locator('.adhd-workbench').evaluate(node=>node.getBoundingClientRect().width);
    await toggle.click();await expect(root).toHaveAttribute('data-side-window','pending');
    await expect(dock).toBeHidden();
    await expect.poll(()=>page.evaluate(()=>typeof (window as any).browserFixture.releaseFrame)).toBe('function');
    await page.evaluate(()=>(window as any).browserFixture.releaseFrame());
    await expect.poll(()=>page.evaluate(()=>(window as any).browserFixture.frame.width)).toBeGreaterThan(1360);
    const wide=await page.evaluate(()=>(window as any).browserFixture.frame.width);
    await page.setViewportSize({width:wide,height:900});
    await expect(root).toHaveAttribute('data-side-window','expanded');await expect(dock).toBeVisible();
    await expect.poll(()=>page.locator('.adhd-workbench').evaluate(node=>node.getBoundingClientRect().width)).toBeCloseTo(baseline,0);
    await dock.getByRole('button',{name:'关闭浏览器侧栏',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window as any).browserFixture.frame.width)).toBe(1360);
    await expect(root).toHaveAttribute('data-side-window','restoring');
    await page.setViewportSize({width:1360,height:900});await expect(root).not.toHaveAttribute('data-side-window','restoring');
    await expect.poll(()=>page.locator('.adhd-workbench').evaluate(node=>node.getBoundingClientRect().width)).toBeCloseTo(baseline,0);
    await toggle.click();await expect.poll(()=>page.evaluate(()=>(window as any).browserFixture.frame.width)).toBe(wide);
    await page.setViewportSize({width:wide,height:900});await expect(dock).toBeVisible();
    await page.getByRole('button',{name:'返回聊天',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window as any).browserFixture.frame.width)).toBe(1360);
    await page.setViewportSize({width:1360,height:900});await expect.poll(()=>nativeViews(page)).toEqual([]);
  }finally{await f.close();}
});

test('CLI sidebar portraits have the same compact size in conversation and ADHD lists', async ({page},info) => {
  const f=await fixture(page);
  try {
    await openSettings(page); await page.locator('input[name="color-palette"][value="cli"]').check(); await closeSettings(page);
    const avatars=page.locator('.adhd-shell .sidebar .conversation-row>.avatar');
    await expect(avatars.first()).toBeVisible();
    await expect(avatars.first()).toHaveCSS('width','26px');
    await expect(avatars.first().locator(':scope>.profile-avatar')).toHaveCSS('width','26px');
    await page.locator('.adhd-shell .sidebar').screenshot({path:info.outputPath('cli-adhd-avatars.png')});
    await page.locator('.adhd-shell .sidebar').getByRole('button',{name:'按对话',exact:true}).click();
    await expect(page.locator('html')).toHaveAttribute('data-palette','cli');
    const row=page.locator('.app-shell:not([hidden]) .sidebar .conversation-row>.avatar').first();
    await expect(row).toHaveCSS('width','26px');
    await expect(row.locator(':scope>.profile-avatar')).toHaveCSS('width','26px');
    await page.locator('.app-shell:not([hidden]) .sidebar').screenshot({path:info.outputPath('cli-conversation-avatars.png')});
    await page.evaluate(() => { document.documentElement.dataset.palette='mono'; });
    await expect(row).not.toHaveCSS('width','26px');
  } finally {await f.close();}
});


for (const delayed of ['initialize', 'component'] as const) for (const cancel of [false,true]) test(`ordinary workbench reserves its column while ${delayed} is delayed (${cancel ? 'cancel' : 'finish'})`, async ({page}, info) => {
  const f = await fixture(page, false);
  let releaseComponent = () => {};
  try {
    if (delayed === 'component') {
      const gate = new Promise<void>(resolve => { releaseComponent = resolve; });
      await page.route(/\/Workbench-[^/]+\.js$/, async route => { await gate; await route.continue(); });
    }
    await page.evaluate(delayed => {
      const fixture = (window as any).browserFixture, bridge = (window as any).tarobotDesktop, invoke = bridge.invoke;
      const state = fixture.frame = {width:innerWidth,height:innerHeight,x:0,y:0};
      bridge.invoke = async (command:string,args:any) => {
        if (command === 'desktop_window_read') return {...state,outerWidth:state.width,outerHeight:state.height,scale:1,maximized:false,fullscreen:false,resizable:true,work:{x:0,y:0,width:3000,height:1600}};
        if (command === 'desktop_window_size') { state.width=args.width;state.height=args.height;return; }
        if (command === 'desktop_window_position') { state.x=args.x;state.y=args.y;return; }
        if (delayed === 'initialize' && command === 'workbench_browser' && args.action === 'list') await new Promise<void>(resolve => {fixture.releaseInitialize=resolve;});
        return invoke(command,args);
      };
    },delayed);
    const main = page.locator('.host-workspace:not([hidden]) .conversation-main'), shell = page.locator('.host-workspace:not([hidden]) .app-shell');
    const original = (await main.boundingBox())!.width;
    const toggle = page.getByRole('button',{name:'工作台',exact:true});
    await toggle.click();
    await expect.poll(()=>page.evaluate(()=>(window as any).browserFixture.frame.width)).toBe(1760);
    await page.setViewportSize({width:1760,height:900});
    await expect(shell).toHaveAttribute('data-side-window','expanded');
    const waiting = (await main.boundingBox())!.width;
    await info.attach('delayed-workbench-width',{body:JSON.stringify({original,waiting,delayed}),contentType:'application/json'});
    expect.soft(waiting).toBeCloseTo(original,0);
    const releaseLoad=async()=>{
      releaseComponent();
      if(delayed === 'initialize') await page.evaluate(()=>(window as any).browserFixture.releaseInitialize());
    };
    if(!cancel){
      await releaseLoad();
      await expect(workbench(page).locator('.workbench-tabrow')).toBeVisible();
      expect((await main.boundingBox())!.width).toBeCloseTo(original,0);
      // The initialized surface replaces the observed loading column.
      const separator=workbench(page).locator('.side-resize-handle');await separator.focus();await separator.press('ArrowLeft');
      await expect.poll(()=>page.evaluate(()=>(window as any).browserFixture.calls.filter((call:any)=>call.command==='desktop_window_side_minimum').at(-1)?.args.width)).toBe(1672);
      await separator.press('Enter');
      await expect.poll(async()=>(await main.boundingBox())!.width).toBeCloseTo(original,0);
    }
    // Closing during loading must immediately restore, and a late component
    // or initialization response must not reopen or resize the window.
    await toggle.click();
    await expect.poll(()=>page.evaluate(()=>(window as any).browserFixture.frame.width)).toBe(1360);
    await page.setViewportSize({width:1360,height:900});
    if(cancel) await releaseLoad();
    await expect(shell).not.toHaveAttribute('data-side-window');
    await expect(workbench(page)).toBeHidden();
    expect((await main.boundingBox())!.width).toBeCloseTo(original,0);
    await toggle.click();
    await expect.poll(()=>page.evaluate(()=>(window as any).browserFixture.frame.width)).toBe(1760);
    await page.setViewportSize({width:1760,height:900});
    await expect(workbench(page)).toBeVisible();
    expect((await main.boundingBox())!.width).toBeCloseTo(original,0);

  }finally{releaseComponent();await f.close();}
});
