import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { hashSecret } from '../../src/hub/auth.js';
import { QwenAsrSetup } from '../../src/runtime/qwen-asr-setup.js';
import { openWorkspacePage, waitForClientOnline } from './fixtures/mobile.js';

test.use({serviceWorkers:'block'});
const idle={platform:'darwin',supported:true,installed:false,pythonPresent:true,modelPresent:false,running:false,managed:false,legacyService:false,activeRequests:null,watchdog:null,autostart:'disabled'};
async function fixture(page:Page,fail:boolean|string=false,initial:Record<string,unknown>={},showRecommendations=true){
  const root=await mkdtemp(path.join(os.tmpdir(),'asr-ui-'));let state:any={...idle,...initial},runs=0,release!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve);
  const setup=new QwenAsrSetup(path.join(root,'home'),async(args,signal,phase)=>{
    if(args.includes('--status'))return JSON.stringify(state);
    runs++;phase?.('model');await Promise.race([gate,new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('installation_interrupted')),{once:true}))]);
    if(fail)throw new Error(typeof fail === 'string' ? fail : 'insufficient_disk_space');
    state={...state,installed:true,modelPresent:true,running:true,managed:true,activeRequests:0,autostart:'login',watchdog:{enabled:true,available:true,reason:'explicit',memoryBytes:3*1024**3,limitBytes:5.5*1024**3,intervalSeconds:300}};return '';
  });
  const hub=await HubServer.start({stateDir:path.join(root,'hub'),clientDir:process.env.TAROBOT_E2E_CLIENT_DIR ?? path.resolve('dist'),asrSetup:setup});
  await hub.profile.update({revision:(await hub.profile.read()).revision,name:"语音验收主机"});
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','语音助手',?,'codex')",[hashSecret('secret'.repeat(8))]);
  await page.goto(hub.url);await preparePairing(page, hub); await page.getByRole('button',{name:'配对此设备',exact:true}).click();
  await hub.auth.approve(await page.getByLabel('配对码',{exact:true}).innerText(),'local-owner');
  await page.getByLabel('配对码',{exact:true}).waitFor({state:'hidden'});await waitForClientOnline(page);
  const open=async()=>{await openWorkspacePage(page,'Skills 与 MCP');await page.locator('.capabilities-overview > summary').click();await page.getByText('语音与搜索建议（可选）',{exact:true}).click();};
  if(showRecommendations) await open(); else await openWorkspacePage(page,'Skills 与 MCP');
  return{setup,hub,release,open,setState:(value:Record<string,unknown>)=>{state={...state,...value};},runs:()=>runs,close:async()=>{release();await page.close();await hub.close();await rm(root,{recursive:true,force:true});}};
}
test('collapsed recommendations do not poll ASR and retain feature choices when reopened', async({page})=>{
  let reads=0;page.on('request', request=>{if(new URL(request.url()).pathname==='/api/integrations/asr')reads++;});
  const f=await fixture(page,false,{},false);
  try{
    await expect(page.locator('.capabilities-overview')).toBeVisible();
    await page.waitForTimeout(5500);expect(reads).toBe(0);
    await page.locator('.capabilities-overview > summary').click();
    await page.getByText('语音与搜索建议（可选）',{exact:true}).click();
    await expect(page.locator('.local-asr-setup')).toContainText('尚未启用本地语音');
    const choices=page.locator('.integration-recommendations input[type=checkbox]');
    await choices.first().uncheck();
    await page.locator('.capabilities-overview > summary').click();
    await expect(page.locator('.local-asr-setup')).toHaveCount(0);
    const before=reads;await page.waitForTimeout(5500);expect(reads).toBe(before);
    await page.locator('.capabilities-overview > summary').click();
    await expect(choices.first()).not.toBeChecked();
    await expect(page.locator('.local-asr-setup')).toContainText('尚未启用本地语音');
    expect(reads).toBeGreaterThan(before);
  }finally{await f.close();}
});
for(const width of [1360,390])test(`ASR install confirmation, progress and verified service state at ${width}px`,async({page},info)=>{
  await page.setViewportSize({width,height:900});const f=await fixture(page),p=page.locator('.local-asr-setup');
  try{
    await expect(p.getByText('尚未启用本地语音',{exact:true})).toBeVisible();
    await p.getByRole('button',{name:'安装并启用本地语音',exact:true}).click();expect(f.runs()).toBe(0);
    await p.getByRole('button',{name:'确认安装',exact:true}).click();
    await expect(p.getByText('准备语音模型',{exact:true})).toBeVisible({timeout:10000});expect(f.runs()).toBe(1);
    await expect(p.getByRole('button',{name:'安装并启用本地语音',exact:true})).toHaveCount(0);
    f.release();await f.setup.wait();await p.getByRole('button',{name:'刷新语音服务状态',exact:true}).click();
    await expect(p.getByText('本地语音已启用',{exact:true})).toBeVisible();await expect(p).toContainText('3.0 GB');
    await page.reload();await waitForClientOnline(page);await f.open();
    await expect(p.getByText('本地语音已启用',{exact:true})).toBeVisible();expect(f.runs()).toBe(1);
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
    await p.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath(`asr-${width}.png`)});
  }finally{await f.close();}
});

test('failed installation stays failed and does not claim the service is enabled',async({page})=>{
  const f=await fixture(page,true),p=page.locator('.local-asr-setup');
  try{await p.getByRole('button',{name:'安装并启用本地语音',exact:true}).click();await p.getByRole('button',{name:'确认安装',exact:true}).click();f.release();await f.setup.wait();
    await expect(p.getByText('主机存储空间不足，请释放空间或让 Bot 协助选择安装位置。',{exact:true})).toBeVisible({timeout:10000});
    await expect(p.getByText('本地语音已启用',{exact:true})).toHaveCount(0);expect(f.runs()).toBe(1);
  }finally{await f.close();}
});

test('missing host endpoint gives update guidance',async({page})=>{
  await page.route('**/api/integrations/asr',route=>route.fulfill({status:404,contentType:'application/json',body:'{"error":"not_found"}'}));
  const f=await fixture(page);try{await expect(page.locator('.local-asr-setup').getByText('请更新主机后使用本地语音安装。',{exact:true})).toBeVisible();expect(f.runs()).toBe(0);}finally{await f.close();}
});


test('lost installation response uses the same receipt and never repeats the installer',async({page})=>{
  const f=await fixture(page),p=page.locator('.local-asr-setup');let posts=0;
  await page.route('**/api/integrations/asr/install',async route=>{posts++;const response=await route.fetch();if(posts===1)await route.abort();else await route.fulfill({response});});
  try{
    await p.getByRole('button',{name:'安装并启用本地语音',exact:true}).click();await p.getByRole('button',{name:'确认安装',exact:true}).click();
    await expect.poll(()=>f.runs()).toBe(1);
    const retry=p.getByRole('button',{name:'确认上次安装请求',exact:true});
    // A fresh GET may already have recovered the receipt; otherwise explicit retry uses its ID.
    if(await retry.isVisible())await retry.click();
    f.release();await f.setup.wait();await p.getByRole('button',{name:'刷新语音服务状态',exact:true}).click();
    await expect(p.getByText('本地语音已启用',{exact:true})).toBeVisible();expect(f.runs()).toBe(1);
    expect(await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('tarobot.asr-install.')).length)).toBe(0);
  }finally{await f.close();}
});


test('existing legacy service remains usable and has no doomed install action',async({page})=>{
  const f=await fixture(page,false,{running:true,legacyService:true,modelPresent:true}),p=page.locator('.local-asr-setup');
  try{await expect(p.getByText('检测到现有语音服务',{exact:true})).toBeVisible();await expect(p.getByRole('button',{name:'安装并启用本地语音',exact:true})).toHaveCount(0);await expect(p).toContainText('请让 Bot 协助迁移');expect(f.runs()).toBe(0);}finally{await f.close();}
});

test('verified external recovery supersedes a historical installation failure',async({page})=>{
  const f=await fixture(page,true),p=page.locator('.local-asr-setup');
  try{await p.getByRole('button',{name:'安装并启用本地语音',exact:true}).click();await p.getByRole('button',{name:'确认安装',exact:true}).click();f.release();await f.setup.wait();
    // Service status polls every 5 s; allow that whole interval plus transport.
    await expect(p.getByRole('alert')).toContainText('存储空间不足',{timeout:10000});
    f.setState({running:true,managed:true,modelPresent:true});await p.getByRole('button',{name:'刷新语音服务状态',exact:true}).click();
    await expect(p.getByText('本地语音已启用',{exact:true})).toBeVisible({timeout:10000});await expect(p.getByRole('alert')).toHaveCount(0);
  }finally{await f.close();}
});


test('registered service loading window is not mistaken for an uninstalled service',async({page})=>{
  const f=await fixture(page,false,{autostart:'login',installed:true,modelPresent:true,running:false}),p=page.locator('.local-asr-setup');
  try{await expect(p.getByText('后台服务已注册，正在启动或暂时不可用',{exact:true})).toBeVisible();await expect(p.getByRole('button',{name:'安装并启用本地语音',exact:true})).toHaveCount(0);expect(f.runs()).toBe(0);}finally{await f.close();}
});

test('missing service manager explains the session requirement without claiming installation',async({page})=>{
  const f=await fixture(page,'service_manager_unavailable'),p=page.locator('.local-asr-setup');
  try{await p.getByRole('button',{name:'安装并启用本地语音',exact:true}).click();await p.getByRole('button',{name:'确认安装',exact:true}).click();f.release();await f.setup.wait();
    await expect(p.getByRole('alert')).toContainText('Mac 请登录桌面后重试',{timeout:10000});
    await expect(p.getByText('本地语音已启用',{exact:true})).toHaveCount(0);expect(f.runs()).toBe(1);
  }finally{await f.close();}
});
