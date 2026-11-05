import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { HubServer } from '../../src/hub/server.js';
import { hashSecret } from '../../src/hub/auth.js';
import { attachGateway } from '../../src/gateway/service.js';
import { createCoreServiceRuntime } from '../../src/core/runtime.js';
import { widgetBlock } from '../../src/client-protocol/widget.js';
import { selectConversation, waitForClientOnline } from './fixtures/mobile.js';
import { monoAccents } from '../src/palettes.js';

test.use({serviceWorkers:'block'});
async function fixture(page:Page, html?:string, compatibility=false) {
 const root=await mkdtemp(path.join(os.tmpdir(),'inline-widget-')),stateDir=path.join(root,'bot');await mkdir(stateDir);
 const hub=await HubServer.start({stateDir:path.join(root,'hub'),clientDir:path.resolve('dist')});
 const secret=randomBytes(32).toString('base64url');await hub.store.db.run('INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)',['alpha','可视化助手',hashSecret(secret)]);
 await writeFile(path.join(stateDir,'config.json'),JSON.stringify({engine:'codex',locale:'zh'}));
 const widget={title:'本周交付节奏',summary:'示例数据：6 天完成 24 项，10 月 20 日完成 8 项。',html:html??await readFile(new URL('../../docs/examples/widget-release-timeline.html', import.meta.url),'utf8')};
 let calls=0;const receipts:unknown[]=[];
 const gateway=await attachGateway({stateDir,url:hub.instanceUrl.replace('http','ws')+'/instance',secret,botId:'alpha',engine:'codex',model:'fixture',effort:'high',runtime:createCoreServiceRuntime(),bridge:{handleAuthorizedMessage:async input=>{
   calls++;if(compatibility)return{text:'```tool-call\n'+JSON.stringify({name:'send.widget',payload:widget})+'\n```'};expect(input.appPlatformTools!.instructions).toContain('proactively');
   const call={name:'app_show_widget',arguments:widget,sessionId:'fixture',callId:'visual',abortSignal:input.abortSignal!};
   const first=await input.appPlatformTools!.call(call),replay=await input.appPlatformTools!.call(call);expect(replay).toEqual(first);receipts.push(JSON.parse(first.text));return{text:'周二交付较集中，可点柱子查看示例明细。'};
 }}});
 const conv=await hub.store.createConversation('owner',['alpha'],'交互报告','widget_chat');
 await page.goto(hub.url);await preparePairing(page, hub); await page.getByRole('button',{name:'配对此设备',exact:true}).click();await hub.auth.approve(await page.getByLabel('配对码',{exact:true}).innerText(),'local-owner');await page.getByLabel('配对码',{exact:true}).waitFor({state:'hidden'});await waitForClientOnline(page);await selectConversation(page,conv.title);
 return {root,hub,conv,widget,receipts,calls:()=>calls,dispose:async()=>{await page.close();await gateway.disconnect();await hub.close();await rm(root,{recursive:true,force:true});}};
}
const guest=(page:Page)=>page.frameLocator('.widget-panel:visible > iframe').frameLocator('iframe');
async function requestWidget(page:Page){await page.getByLabel('消息',{exact:true}).fill('比较本周交付节奏');await page.getByRole('button',{name:'发送消息',exact:true}).click();}

test('native tool report: local filters, themes, expansion, reload, phone and ADHD',async({page},info)=>{
 const f=await fixture(page);try{
  await requestWidget(page);await expect(guest(page).getByRole('button',{name:'10 月 20 日，8 项'})).toBeVisible();
  await expect(page.getByText('正在加载交互组件…')).toHaveCount(0);await expect(page.getByText('组件未能完整运行，文字摘要仍可阅读。')).toHaveCount(0);
  expect(f.receipts).toEqual([expect.objectContaining({delivered:true})]);expect(f.calls()).toBe(1);await expect(page.locator('.inline-widget')).toHaveCount(1);
  await page.locator('.inline-widget').screenshot({path:info.outputPath('widget-desktop.png'),animations:'disabled'});
  await guest(page).getByRole('button',{name:'10 月 20 日，8 项'}).click();await expect(guest(page).locator('#result-count')).toHaveText('8 项交付');await expect(guest(page).locator('tbody tr')).toHaveCount(8);
  // The new detail view reports its content height asynchronously; wait for
  // the host layout before targeting a header that moves with scroll anchoring.
  const detailHeight=await guest(page).locator('body').evaluate(node=>Math.ceil(node.getBoundingClientRect().height));
  await expect.poll(()=>page.locator('.widget-panel > iframe').evaluate(node=>node.getBoundingClientRect().height)).toBe(Math.max(80,Math.min(720,detailHeight)));
  await page.getByRole('button',{name:'放大交互组件'}).click();await expect(page.locator('.widget-expanded')).toBeVisible();expect(await page.locator('.widget-expanded').evaluate(node=>getComputedStyle(node).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');await expect(guest(page).locator('#day-filter')).toHaveValue('20');
  await guest(page).locator('#day-filter').selectOption('all');await expect(guest(page).locator('tbody tr')).toHaveCount(24);
  await page.getByRole('button',{name:'收起交互组件'}).click();await expect(page.locator('.widget-expanded')).toHaveCount(0);await expect(guest(page).locator('#day-filter')).toHaveValue('all');
  await guest(page).getByRole('button',{name:'概览',exact:true}).click();
  const before=await guest(page).locator('body').evaluate(node=>getComputedStyle(node).color);
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');await expect.poll(()=>guest(page).locator('body').evaluate(node=>getComputedStyle(node).color)).not.toBe(before);
  await page.locator('.inline-widget').screenshot({path:info.outputPath('widget-dark.png'),animations:'disabled'});
  await page.reload();await waitForClientOnline(page);await selectConversation(page,f.conv.title);await expect(guest(page).getByRole('button',{name:'10 月 20 日，8 项'})).toBeVisible();expect(f.calls()).toBe(1);
  await page.setViewportSize({width:390,height:844});await selectConversation(page,f.conv.title);await expect(guest(page).locator('#delivery')).toBeVisible();
  expect(await guest(page).locator('body').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await page.getByRole('button',{name:'放大交互组件'}).click();await page.locator('.widget-expanded').screenshot({path:info.outputPath('widget-phone.png'),animations:'disabled'});await page.getByRole('button',{name:'收起交互组件'}).click();
  await page.setViewportSize({width:1360,height:900});
  for(let i=2;i<=6;i++)await f.hub.store.createConversation('owner',['alpha'],'窄屏窗口'+i,'narrow_'+i);
  await page.reload();await waitForClientOnline(page);
  await page.getByRole('button',{name:'打开 ADHD 模式',exact:true}).click();await page.getByRole('checkbox',{name:/加入面板：.*交互报告/}).check();
  for(let i=2;i<=6;i++)await page.getByRole('checkbox',{name:new RegExp('加入面板：.*窄屏窗口'+i)}).check();
  await page.getByRole('combobox',{name:'ADHD 每行窗口数'}).selectOption('6');await expect(page.locator('.adhd-card')).toHaveCount(6);await expect(guest(page).locator('#delivery')).toBeVisible();
  expect(await guest(page).locator('body').evaluate(node=>node.clientWidth)).toBeLessThan(300);
  expect(await guest(page).locator('body').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await expect.poll(()=>guest(page).locator('body').evaluate(node=>getComputedStyle(node).fontSize)).toBe('12px');
  await page.getByRole('combobox',{name:'ADHD 窗口字号'}).selectOption('16');
  await expect.poll(()=>guest(page).locator('body').evaluate(node=>getComputedStyle(node).fontSize)).toBe('16px');
  await page.screenshot({path:info.outputPath('widget-adhd-six.png'),animations:'disabled'});
 }finally{await f.dispose()}
});

test('sandbox blocks parent, storage, network and self-navigation',async({page})=>{
 const target='https://widget-exfil.invalid';let requests=0;await page.route(target+'/**',route=>{requests++;return route.abort()});
 const html=`<p id="isolation">checking</p><button id="navigate">navigate</button><script>
 let parentBlocked=false,storageBlocked=false;try{parent.document.body.innerHTML='escaped'}catch{parentBlocked=true}try{localStorage.setItem('x','1')}catch{storageBlocked=true}
 document.getElementById('isolation').textContent=JSON.stringify({parentBlocked,storageBlocked});fetch('${target}/fetch').catch(()=>{});const image=new Image();image.src='${target}/image';document.getElementById('navigate').onclick=()=>location.href='${target}/navigate';
 </script>`;
 const f=await fixture(page,html);try{
  await requestWidget(page);await expect(guest(page).locator('#isolation')).toHaveText('{"parentBlocked":true,"storageBlocked":true}');
  await guest(page).getByRole('button',{name:'navigate'}).click();
  await page.locator('.widget-summary').evaluate(node=>{(node as HTMLDetailsElement).open=true});await expect(page.getByText(f.widget.summary,{exact:true})).toBeVisible();
  expect(requests).toBe(0);await expect(page.getByLabel('消息',{exact:true})).toBeVisible();
 }finally{await f.dispose()}
});

test('WebRTC cannot send loopback UDP or restore its constructors after reopening',async({page})=>{
 const udp=createSocket('udp4');let packets=0;udp.on('message',()=>packets++);
 await new Promise<void>(resolve=>udp.bind(0,'127.0.0.1',resolve));
 const address=udp.address();if(typeof address==='string')throw new Error('unexpected_udp_address');
 const html=`<p id="rtc">checking</p><script>
  const Peer=window.RTCPeerConnection;let restored=false;try{Object.defineProperty(window,'RTCPeerConnection',{value:()=>{},configurable:true});restored=true}catch{}
  try{const pc=new Peer({iceServers:[{urls:'stun:127.0.0.1:${address.port}'}]});pc.createDataChannel('d');pc.createOffer().then(o=>pc.setLocalDescription(o));document.getElementById('rtc').textContent='available'}catch{document.getElementById('rtc').textContent=restored?'restored':'blocked'}
 </script>`;
 let f:Awaited<ReturnType<typeof fixture>>|undefined;
 try{
  f=await fixture(page,html);await requestWidget(page);
  for(let view=0;view<2;view++){
   await expect(guest(page).locator('#rtc')).toHaveText('blocked');
   // A bounded observation window is necessary to catch asynchronous STUN.
   await page.waitForTimeout(1500);expect(packets).toBe(0);
   if(!view){await page.reload();await waitForClientOnline(page);await selectConversation(page,f.conv.title);}
  }
 }finally{udp.close();await f?.dispose()}
});

test('headless publication uses membership and idempotency; persists without triggering a Bot',async({page})=>{
 const f=await fixture(page);try{
  const block=widgetBlock(f.widget);
  await expect(f.hub.store.publishUserWidget('stranger',f.conv.id,'bad',block)).rejects.toThrow();
  const message=await f.hub.store.publishUserWidget('owner',f.conv.id,'cli_widget',block);
  expect(await f.hub.store.publishUserWidget('owner',f.conv.id,'cli_widget',block)).toEqual(message);
  await expect(f.hub.store.publishUserWidget('owner',f.conv.id,'cli_widget',widgetBlock({...f.widget,title:'changed'}))).rejects.toThrow('idempotency_conflict');
  await expect(guest(page).locator('#delivery')).toBeVisible();expect(f.calls()).toBe(0);
  expect(await page.locator('.inline-widget').evaluate(node=>node.getBoundingClientRect().width)).toBeGreaterThan(500);
  await page.setViewportSize({width:390,height:844});
  await expect.poll(()=>page.locator('.inline-widget').evaluate(node=>{const r=node.getBoundingClientRect();return r.width>=260&&r.left>=0&&r.right<=window.innerWidth;})).toBe(true);
  expect(await f.hub.store.db.get('SELECT COUNT(*) AS count FROM deliveries')).toEqual({count:0});
  await page.reload();await waitForClientOnline(page);await selectConversation(page,f.conv.title);await expect(guest(page).locator('#delivery')).toBeVisible();
 }finally{await f.dispose()}
});

 test('compatibility engines publish the same widget through the output directive',async({page})=>{
 const f=await fixture(page,undefined,true);try{await requestWidget(page);await expect(guest(page).getByRole('button',{name:'10 月 20 日，8 项'})).toBeVisible();await guest(page).getByRole('button',{name:'10 月 20 日，8 项'}).click();await expect(guest(page).locator('#result-count')).toHaveText('8 项交付');expect(f.receipts).toHaveLength(0);expect(f.calls()).toBe(1);await expect(page.locator('.inline-widget')).toHaveCount(1);}finally{await f.dispose()}
});

for (const platform of ['android', 'ios']) test(`an unguarded ${platform} bridge keeps the summary and never mounts executable content`,async({page})=>{
 const f=await fixture(page);try{
  await page.evaluate(platform=>{
   const runtime=(window as unknown as {Capacitor:{getPlatform:()=>string;isNativePlatform:()=>boolean};tarobotWidgetIsolation?:{supported:()=>boolean}});
   runtime.Capacitor.getPlatform=()=>platform;runtime.Capacitor.isNativePlatform=()=>true;
   runtime.tarobotWidgetIsolation={supported:()=>false};
   const marker=document.createElement('meta');marker.name='tarobot-widget-guard';marker.content='1';document.head.append(marker);
  },platform);
  await f.hub.store.publishUserWidget('owner',f.conv.id,'unguarded_'+platform,widgetBlock(f.widget));
  await expect(page.locator('.widget-unavailable')).toContainText(f.widget.summary);
  await expect(page.locator('.widget-unavailable')).toContainText('当前版本不支持交互组件');
  await expect(page.locator('.inline-widget iframe')).toHaveCount(0);
 }finally{await f.dispose()}
});

test('widget reader closes from guest Escape and preserves local state',async({page})=>{
 const f=await fixture(page);try{
  await requestWidget(page);await expect(guest(page).getByRole('button',{name:'10 月 20 日，8 项'})).toBeVisible();
  await page.getByRole('button',{name:'放大交互组件'}).click();
  await expect(page.locator('.widget-expanded')).toBeVisible();
  await guest(page).getByRole('button',{name:'10 月 20 日，8 项'}).click();
  await expect(guest(page).locator('tbody tr')).toHaveCount(8);
  await guest(page).getByRole('button',{name:'交付明细',exact:true}).press('Escape');
  await expect(page.locator('.widget-expanded')).toHaveCount(0);
  await expect(guest(page).getByRole('combobox',{name:'日期',exact:true})).toHaveValue('20');
  await expect(page.getByRole('button',{name:'放大交互组件'})).toBeFocused();
 }finally{await f.dispose()}
});

test('widget appearance follows host font size, dark surface and accessible primary colors',async({page})=>{
 const f=await fixture(page,'<button class="primary">查看数据</button>');try{
  await requestWidget(page);await expect(guest(page).getByRole('button',{name:'查看数据'})).toBeVisible();
  await page.evaluate(()=>{document.documentElement.dataset.theme='dark';document.documentElement.dataset.palette='mono';document.documentElement.style.setProperty('--font-size','20px')});
  await expect.poll(()=>guest(page).locator('body').evaluate(node=>getComputedStyle(node).fontSize)).toBe('20px');
  const colors=await guest(page).getByRole('button',{name:'查看数据'}).evaluate(node=>({fg:getComputedStyle(node).color,bg:getComputedStyle(node).backgroundColor}));
  const luminance=(rgb:string)=>{const c=rgb.match(/[\d.]+/g)!.slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return c[0]!*0.2126+c[1]!*0.7152+c[2]!*0.0722};
  const a=luminance(colors.fg),b=luminance(colors.bg);expect((Math.max(a,b)+.05)/(Math.min(a,b)+.05)).toBeGreaterThanOrEqual(4.5);
  const surface=await page.locator('.widget-panel').evaluate(node=>getComputedStyle(node).backgroundColor);
  await expect.poll(()=>guest(page).locator('html').evaluate(node=>getComputedStyle(node).backgroundColor)).toBe(surface);
 }finally{await f.dispose()}
});

test('a slow sandbox load recovers from timeout without leaving a false error',async({page})=>{
 const f=await fixture(page);try{
  await page.route('**/widget-sandbox.html',async route=>{await new Promise(resolve=>setTimeout(resolve,9500));await route.continue()});
  await requestWidget(page);await expect(page.getByText('组件未能完整运行，文字摘要仍可阅读。')).toBeVisible({timeout:12000});
  await expect(guest(page).getByRole('button',{name:'10 月 20 日，8 项'})).toBeVisible({timeout:12000});
  await expect(page.getByText('组件未能完整运行，文字摘要仍可阅读。')).toHaveCount(0);
 }finally{await f.dispose()}
});


test('embedded data images render while external resources stay blocked',async({page})=>{
 const html='<img alt="Embedded chart marker" width="32" height="32" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==">';
 const f=await fixture(page,html);try{
  await requestWidget(page);await expect.poll(()=>guest(page).getByRole('img',{name:'Embedded chart marker'}).evaluate(node=>(node as HTMLImageElement).naturalWidth)).toBe(1);
  await expect(page.getByText('组件未能完整运行，文字摘要仍可阅读。')).toHaveCount(0);
 }finally{await f.dispose()}
});

test('an arriving widget cannot steal composer typing before a user activates it',async({page})=>{
 const html='<input aria-label="组件搜索"><p id="done">waiting</p><script>setTimeout(()=>{document.querySelector("input").focus();document.getElementById("done").textContent="attempted"},500)</script>';
 const f=await fixture(page,html);try{
  await page.getByLabel('消息',{exact:true}).fill('我的草稿');
  await f.hub.store.publishUserWidget('owner',f.conv.id,'focus_widget',widgetBlock(f.widget));
  await expect(guest(page).locator('#done')).toHaveText('attempted');
  await page.keyboard.type('仍在这里');await expect(page.getByLabel('消息',{exact:true})).toHaveValue('我的草稿仍在这里');
  await guest(page).getByRole('textbox',{name:'组件搜索'}).click();await page.keyboard.type('可以输入');
  await expect(guest(page).getByRole('textbox',{name:'组件搜索'})).toHaveValue('可以输入');
 }finally{await f.dispose()}
});

test('responsive ResizeObserver layout completes without a false runtime error',async({page})=>{
 const html='<div id="chart" style="height:120px">布局中</div><script>let n=0;new ResizeObserver(entries=>{if(n++<10){entries[0].target.style.height=(120+n%2)+"px"}else document.getElementById("chart").textContent="布局完成"}).observe(document.getElementById("chart"));</script>';
 const f=await fixture(page,html);try{
  await requestWidget(page);await expect(guest(page).locator('#chart')).toHaveText('布局完成');
  await expect(page.getByText('组件未能完整运行，文字摘要仍可阅读。')).toHaveCount(0);
 }finally{await f.dispose()}
});

test('unrelated host geometry changes do not trigger widget theme redraws',async({page})=>{
 const html='<p id="count">0</p><script>let n=0;addEventListener("tarobot:theme",()=>document.getElementById("count").textContent=String(++n));</script>';
 const f=await fixture(page,html);try{
  await requestWidget(page);await expect(guest(page).locator('#count')).toHaveText('0');
  await page.evaluate(async()=>{document.documentElement.style.setProperty('--sidebar-width','281px');await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))});
  await expect(guest(page).locator('#count')).toHaveText('0');
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');await expect(guest(page).locator('#count')).toHaveText('1');
 }finally{await f.dispose()}
});

test('phone reader stays within the safe area and retry retains keyboard focus',async({page})=>{
 const f=await fixture(page,'<button onclick="throw new Error(\'test\')">触发错误</button>');try{
  await page.setViewportSize({width:390,height:844});await requestWidget(page);
  await expect(guest(page).getByRole('button',{name:'触发错误'})).toBeVisible();
  await expect(page.locator('.widget-panel')).toHaveAttribute('role','group');
  await guest(page).getByRole('button',{name:'触发错误'}).click();
  await page.getByRole('button',{name:'重新加载组件'}).click();
  await expect(page.getByRole('button',{name:'放大交互组件'})).toBeFocused();
  await page.evaluate(()=>{document.documentElement.style.setProperty('--app-safe-top','44px');document.documentElement.style.setProperty('--app-safe-bottom','34px')});
  await page.getByRole('button',{name:'放大交互组件'}).click();
  const box=await page.locator('.widget-expanded').boundingBox();expect(box!.y).toBeGreaterThanOrEqual(44);expect(box!.y+box!.height).toBeLessThanOrEqual(844-34);
 }finally{await f.dispose()}
});


test('a widget can consume Escape for its own control before the reader closes',async({page})=>{
 const f=await fixture(page,'<input aria-label="本地筛选"><p id="state">筛选中</p><script>addEventListener("keydown",e=>{if(e.key==="Escape"){e.preventDefault();document.getElementById("state").textContent="已取消筛选"}});</script>');try{
  await requestWidget(page);await expect(guest(page).getByRole('textbox',{name:'本地筛选'})).toBeVisible();
  await page.getByRole('button',{name:'放大交互组件'}).click();await guest(page).getByRole('textbox',{name:'本地筛选'}).press('Escape');
  await expect(guest(page).locator('#state')).toHaveText('已取消筛选');await expect(page.locator('.widget-expanded')).toBeVisible();
 }finally{await f.dispose()}
});

test.describe('installed browser service worker',()=>{
 test.use({serviceWorkers:'allow'});
 test('history widgets render on a service-worker-controlled page reload',async({page})=>{
  const f=await fixture(page);try{
   await page.evaluate(()=>navigator.serviceWorker.ready);
   await expect.poll(()=>page.evaluate(()=>!!navigator.serviceWorker.controller)).toBe(true);
   await requestWidget(page);await expect(guest(page).locator('#delivery')).toBeVisible();
   await page.reload();await waitForClientOnline(page);await selectConversation(page,f.conv.title);
   await expect(guest(page).locator('#delivery')).toBeVisible();
   await expect(page.getByText('组件未能完整运行，文字摘要仍可阅读。')).toHaveCount(0);
  }finally{await f.dispose()}
 });
});

test('custom selected controls remain legible and segmented controls retain distinct surfaces',async({page})=>{
 const html='<style>.choice{background:var(--surface)}</style><button class="choice" aria-pressed="true">10月20日</button><div class="tabs"><button aria-pressed="true">当前页</button><button>下一页</button></div>';
 const f=await fixture(page,html);try{
  await requestWidget(page);await expect(guest(page).getByRole('button',{name:'10月20日'})).toBeVisible();
  for(const theme of ['light','dark']){
   await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.palette='mono'},theme);
   const color=await page.locator('.widget-panel').evaluate(node=>getComputedStyle(node).color);
   await expect.poll(()=>guest(page).getByRole('button',{name:'10月20日'}).evaluate(node=>getComputedStyle(node).color)).toBe(color);
   const tab=await guest(page).getByRole('button',{name:'当前页'}).evaluate(node=>({selected:getComputedStyle(node).backgroundColor,track:getComputedStyle(node.parentElement!).backgroundColor}));expect(tab.selected).not.toBe(tab.track);
  }
 }finally{await f.dispose()}
});

test('viewport-height content settles without a resize feedback loop',async({page})=>{
 const f=await fixture(page,'<div style="min-height:100vh"><p id="done">sizing</p></div><script>setTimeout(()=>document.getElementById("done").textContent="settled",1200)</script>');try{
  await requestWidget(page);await expect(guest(page).locator('#done')).toHaveText('settled');
  const height=await page.locator('.widget-panel > iframe').evaluate(node=>node.getBoundingClientRect().height);expect(height).toBeGreaterThanOrEqual(320);expect(height).toBeLessThan(500);
 }finally{await f.dispose()}
});

test('custom charts receive stable palette series through live theme changes and expansion', async ({page}) => {
 const html='<button id="count">0</button><svg viewBox="0 0 200 90" aria-label="主题数据色">'+[1,2,3,4].map(i=>`<path id="series-${i}" d="M5 ${i*18}H195" stroke="var(--chart-series-${i},#123456)" stroke-width="3"/>`).join('')+'</svg><script>var count=0;document.getElementById("count").addEventListener("click",function(){count++;this.textContent=String(count);});</script>';
 const f=await fixture(page,html);
 try {
  await requestWidget(page);await expect(guest(page).locator('#count')).toHaveText('0');await guest(page).locator('#count').click();await expect(guest(page).locator('#count')).toHaveText('1');
  for(const palette of ['mono','white-orange','white-violet','pixel','paper'])for(const theme of ['light','dark']){
   await page.evaluate(({palette,theme})=>Object.assign(document.documentElement.dataset,{palette,theme}),{palette,theme});
   const expected=await page.evaluate(()=>{const probe=document.createElement('span');document.body.append(probe);const colors=[1,2,3,4].map(i=>{probe.style.color=`var(--chart-series-${i})`;return getComputedStyle(probe).color});probe.remove();return colors});
   await expect.poll(()=>guest(page).locator('path').evaluateAll(nodes=>nodes.map(n=>getComputedStyle(n).stroke))).toEqual(expected);
   expect(new Set(expected).size).toBe(4);await expect(guest(page).locator('#count')).toHaveText('1');
  }
  await page.getByRole('button',{name:'放大交互组件',exact:true}).click();await expect(guest(page).locator('#count')).toHaveText('1');
  await page.getByRole('button',{name:'收起交互组件',exact:true}).click();await expect(guest(page).locator('#count')).toHaveText('1');
 }finally{await f.dispose()}
});

test('open widgets follow monochrome accent-only changes without restarting state or recolouring semantic colours', async ({ page }, info) => {
 const html='<button class="primary" id="count">0</button><p id="emphasis" style="color:var(--accent)">重点指标</p><div class="card"><span id="card-ink" style="color:var(--accent)">选中说明</span><span id="semantic" style="color:#ba3030">作者定义的警告</span></div><div id="soft" style="background:var(--accent-soft)">选中区域</div><svg viewBox="0 0 200 90">'+[1,2,3,4].map(i=>`<path id="series-${i}" d="M5 ${i*18}H195" stroke="var(--chart-series-${i},#123456)" stroke-width="3"/>`).join('')+'</svg><span id="theme-events">0</span><script>var count=0,changes=0;document.getElementById("count").addEventListener("click",function(){count++;this.textContent=String(count);});window.addEventListener("tarobot:theme",function(){document.getElementById("theme-events").textContent=String(++changes);});</script>';
 const f=await fixture(page,html);
 try {
  await page.evaluate(()=>Object.assign(document.documentElement.dataset,{palette:'mono',theme:'light',monoAccent:'none'}));
  await requestWidget(page); await expect(guest(page).locator('#count')).toHaveText('0');
  await guest(page).locator('#count').click(); await expect(guest(page).locator('#count')).toHaveText('1');
  const semantic=await guest(page).locator('#semantic').evaluate(node=>getComputedStyle(node).color);
  const sets=new Set<string>();
  for(const theme of ['light','dark']) {
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   const surfaces=await page.locator('.conversation-main').first().evaluate(node=>({background:getComputedStyle(node).backgroundColor,text:getComputedStyle(node).color}));
   for(const accent of monoAccents) {
    // Only this attribute changes: catches a missing observer entry even if
    // switching the overall theme would accidentally refresh the guest.
    await page.evaluate(accent=>document.documentElement.dataset.monoAccent=accent,accent.id);
    const expected=await page.evaluate(()=>{
     const probe=document.createElement('span');document.body.append(probe);
     const names=['--chart-series-1','--chart-series-2','--chart-series-3','--chart-series-4','--data-accent','--data-primary-bg','--data-accent-soft'];
     const values=names.map(name=>{probe.style.color=`var(${name})`;return getComputedStyle(probe).color});probe.remove();return values;
    });
    await expect.poll(()=>guest(page).locator('path').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).stroke))).toEqual(expected.slice(0,4));
    await expect(guest(page).locator('#emphasis')).toHaveCSS('color',expected[4]);
    await expect(guest(page).locator('#count')).toHaveCSS('background-color',expected[5]);
    await expect(guest(page).locator('#soft')).toHaveCSS('background-color',expected[6]);
    await expect(guest(page).locator('#count')).toHaveText('1');
    expect(await guest(page).locator('#semantic').evaluate(node=>getComputedStyle(node).color)).toBe(semantic);
    expect(await page.locator('.conversation-main').first().evaluate(node=>({background:getComputedStyle(node).backgroundColor,text:getComputedStyle(node).color}))).toEqual(surfaces);
    const ratios=await guest(page).locator('body').evaluate(body=>{
     const rgb=(s:string)=>s.match(/[\d.]+/g)!.slice(0,3).map(Number);
     const lum=(s:string)=>rgb(s).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
     const ratio=(a:string,b:string)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
     const button=getComputedStyle(body.querySelector('#count')!),ink=getComputedStyle(body.querySelector('#card-ink')!),card=getComputedStyle(body.querySelector('.card')!);
     return [ratio(button.color,button.backgroundColor),ratio(ink.color,card.backgroundColor)];
    });
    expect(Math.min(...ratios),`${accent.id}/${theme}`).toBeGreaterThanOrEqual(4.5);
    sets.add(JSON.stringify(expected.slice(0,4)));
   }
  }
  expect(sets.size).toBe((monoAccents.length-1)*2); // graphite shares the neutral series
  await expect.poll(()=>guest(page).locator('#theme-events').innerText()).not.toBe('0');
  await page.evaluate(()=>Object.assign(document.documentElement.dataset,{palette:'white-blue',monoAccent:'mist'}));
  const blue=await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  await expect(guest(page).locator('#emphasis')).toHaveCSS('color',await page.evaluate(value=>{const el=document.createElement('span');el.style.color=value;document.body.append(el);const result=getComputedStyle(el).color;el.remove();return result;},blue));
  await page.evaluate(()=>document.documentElement.dataset.monoAccent='rose');
  await expect(guest(page).locator('#count')).toHaveText('1');
  await page.evaluate(()=>document.documentElement.dataset.palette='mono');
  await page.evaluate(()=>Object.assign(document.documentElement.dataset,{theme:'system',monoAccent:'mist'}));
  await page.emulateMedia({colorScheme:'light'});const light=await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--data-accent').trim());
  await expect(guest(page).locator('#emphasis')).toHaveCSS('color',await page.evaluate(value=>{const el=document.createElement('span');el.style.color=value;document.body.append(el);const result=getComputedStyle(el).color;el.remove();return result;},light));
  await page.emulateMedia({colorScheme:'dark'});await expect(guest(page).locator('#count')).toHaveText('1');
  await page.getByRole('button',{name:'放大交互组件',exact:true}).click();
  await page.evaluate(()=>document.documentElement.dataset.monoAccent='rose');
  await expect(guest(page).locator('#count')).toHaveText('1');
  await page.getByRole('button',{name:'收起交互组件',exact:true}).click();
  await page.setViewportSize({width:390,height:844}); await selectConversation(page,f.conv.title);
  expect(await guest(page).locator('body').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await page.locator('.inline-widget').screenshot({path:info.outputPath('mono-accent-widget-phone.png'),animations:'disabled'});
 }finally{await f.dispose()}
});
