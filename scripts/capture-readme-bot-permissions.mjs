// Documentation capture: two disposable Hosts, real pairing and signed grants.
// Fictional names only. No engine starts and no production state is accessed.
import assert from 'node:assert/strict';
import { chromium } from '../client/node_modules/@playwright/test/index.mjs';
import { HubServer } from '../dist/src/hub/server.js';
import { messageHostId } from '../dist/src/hub/bot-messages.js';
import { networkId } from '../dist/src/hub/private-network.js';
import { networkManifestSchema } from '../dist/src/client-protocol/private-network.js';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { prepareReadmePairing } from './readme-pairing.mjs';
import { readmePreferences, readmeAppearance } from './readme-appearance.mjs';
import { captureProvenance } from './readme-provenance.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)), output=path.resolve(process.argv[2]??path.join(root,'assets/product'));
await mkdir(output,{recursive:true});
const provenance=await captureProvenance(root), captures=[];
const browser=await chromium.launch({headless:true});
const pair=async(page,hub,name)=>{
 await page.getByLabel('主机名称',{exact:true}).fill(name);
 await page.getByLabel('Hub 地址',{exact:true}).fill(hub.url);
 await prepareReadmePairing(page,hub);
 await page.getByRole('button',{name:'配对此设备',exact:true}).click();
 await hub.auth.approve(await page.getByLabel('配对码',{exact:true}).innerText(),'local-owner');
 await page.getByLabel('配对码',{exact:true}).waitFor({state:'hidden'});
 await page.locator('.host-workspace:not([hidden]) .connection-pill.online').waitFor();
};
const appAction=async(page,name)=>{
 const target=page.getByRole('button',{name,exact:true}).filter({visible:true});
 if(!await target.count())await page.getByRole('button',{name:/^(工作台：|Workspace:)/}).filter({visible:true}).click();
 await target.click();
};
try{
 for(const locale of ['en','zh']){
  const zh=locale==='zh', word=(en,cn)=>zh?cn:en;
  const directory=await mkdtemp(path.join(os.tmpdir(),'bird-permissions-'));
  const receiver=await HubServer.start({stateDir:path.join(directory,'receiver'),clientDir:path.join(root,'client/dist')});
  const source=await HubServer.start({stateDir:path.join(directory,'source'),origins:[receiver.url]});
  const context=await browser.newContext({viewport:{width:1360,height:980},deviceScaleFactor:2,serviceWorkers:'block'});
  const page=await context.newPage(), errors=[]; page.setDefaultTimeout(20000); page.on('pageerror',error=>errors.push(error.message));
  const names={receiver:word('Build PC','构建电脑'),source:word('Studio Mac','工作室 Mac'),coordinator:word('Coordinator','统筹助手'),build:word('Build & test','构建与测试'),review:word('Code review','代码审阅')};
  try{
   await receiver.profile.update({name:names.receiver,revision:0}); await source.profile.update({name:names.source,revision:0});
   await source.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('coordinator',?,'documentation-fixture','codex')",[names.coordinator]);
   for(const id of ['build','review'])await receiver.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES(?,?,'documentation-fixture','claude')",[id,names[id]]);
   const nonce=randomBytes(32).toString('base64url');
   const manifest=networkManifestSchema.parse({v:2,id:networkId(receiver.auth.publicKey,nonce),name:'Documentation network',authorityKey:receiver.auth.publicKey,genesisNonce:nonce,revision:1,hosts:[receiver,source].map((hub,i)=>({publicKey:hub.auth.publicKey,name:i?names.source:names.receiver,routes:[],protocol:2,state:'active',revoked:false})),devices:[],revokedMembers:[],blockedBindings:[]});
   const membership={manifest,signature:receiver.auth.signNetworkManifest(manifest)};
   for(const hub of [receiver,source])await hub.store.db.run("INSERT INTO meta(key,value) VALUES('private-network:v1',?)",[JSON.stringify({v:1,routes:[],membership,imported:{},revokedMembers:[],revokedHosts:[],retiredNetworks:[],admissions:[],peers:[],proofs:[],intents:{},lastSyncedAt:Date.now(),waiting:false})]);
   await page.goto(receiver.url); await pair(page,receiver,names.receiver);
   await appAction(page,'连接另一台主机'); await pair(page,source,names.source);
   await page.getByLabel('筛选运行主机').filter({visible:true}).first().selectOption({label:names.receiver});
   await readmePreferences(page,locale); await page.reload();
   await page.locator('.host-workspace:not([hidden]) .connection-pill.online').waitFor();
   // The standard settings button opens the unchanged product interface.
   const settings=page.getByRole('button',{name:word('Settings','设置'),exact:true}).filter({visible:true});
   if(!await settings.count())await page.getByRole('button',{name:word('More chat actions','更多聊天操作'),exact:true}).filter({visible:true}).click();
   await settings.click();
   await page.getByRole('navigation',{name:word('Settings categories','设置分类')}).getByRole('button',{name:word('Bot message permissions','Bot 消息授权'),exact:true}).click();
   await page.getByRole('button',{name:word('Cross-host','跨主机'),exact:true}).click();
   const panel=page.locator('.cross-host-message-grants');
   await panel.getByLabel(word('Source Bot','来源 Bot'),{exact:true}).selectOption('coordinator');
   await panel.getByLabel(word('Receiving Bot on this host','本机接收 Bot'),{exact:true}).selectOption('build');
   await panel.getByRole('button',{name:word('Allow sending','允许发送'),exact:true}).click();
   await panel.getByRole('status').filter({hasText:word('Sending allowed and verified','已允许发送，并从接收主机核对生效')}).waitFor();
   const snapshot=await receiver.botMessages.readCrossHostGrants('owner',async()=>{});
   assert.deepEqual(snapshot.grants,[{sourceHost:messageHostId(source.auth.publicKey),sourceBot:'coordinator',targetBot:'build'}]);
   // Scroll the source form to a clean boundary; keep the actual layout and CSS.
   await panel.locator('.cross-grants-form').evaluate(node=>{
    const scroller=node.closest('.settings-content');
    scroller.scrollTop+=node.getBoundingClientRect().top-scroller.getBoundingClientRect().top-16;
   });
   await page.mouse.move(0,0); await page.evaluate(async()=>{document.activeElement?.blur(); await document.fonts.ready;});
   assert.equal(await panel.evaluate(el=>el.scrollWidth>el.clientWidth),false);
   assert.deepEqual(errors,[]);
   const file=`bot-permissions-${locale}.png`, dialog=page.locator('dialog.preferences-dialog');
   await dialog.screenshot({path:path.join(output,file),animations:'disabled'});
   captures.push({file,locale,viewport:page.viewportSize(),scale:2,kind:'real-settings-dialog',...await readmeAppearance(page),sha256:createHash('sha256').update(await readFile(path.join(output,file))).digest('hex')});
   console.log(`Captured ${file}; real signed grant and readback verified`);
  }finally{await context.close();await source.close();await receiver.close();await rm(directory,{recursive:true,force:true});}
 }
 await writeFile(path.join(output,'bot-permissions-capture.json'),JSON.stringify({format:1,kind:'documentation-fixture',...provenance,notes:'Real App settings and signed permission changes against disposable Hosts. Fictional names; no model execution or physical-network acceptance.',captures},null,2)+'\n');
}finally{await browser.close();}
