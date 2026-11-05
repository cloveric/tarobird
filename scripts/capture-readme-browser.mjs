// Actual shared App and production Electron WorkbenchBrowser, isolated profile.
// The browsed site is a local fictional studio page; no account or model is used.
import { _electron, expect } from '../client/node_modules/@playwright/test/index.mjs';
import { HubServer } from '../dist/src/hub/server.js';
import { BOT_AVATAR_DEFAULT_PREFIX } from '../dist/src/hub/bot-avatar-default.js';
import { prepareReadmePairing } from './readme-pairing.mjs';
import { readmePreferences, readmeAvatars } from './readme-appearance.mjs';
import { recordReadmeMotion } from './readme-motion.mjs';
import { captureProvenance } from './readme-provenance.mjs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir,mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
const root=fileURLToPath(new URL('../',import.meta.url)),output=path.join(root,'assets/product');
const binary=process.env.README_ELECTRON;
if(!binary?.includes('.noindex/'))throw new Error('Set README_ELECTRON to the isolated Electron executable');
const images=[],animations=[];
for(const locale of ['zh','en']){
 const zh=locale==='zh',words=(cn,en)=>zh?cn:en;
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'tarobird-browser-docs-'));
 if(!stateDir.includes('.noindex/'))throw new Error('TMPDIR must be below .noindex');
 const hub=await HubServer.start({stateDir:path.join(stateDir,'hub'),clientDir:path.join(root,'client/dist')});
 const website=createServer((req,res)=>{
  const article=req.url?.startsWith('/journal/less-switching');
  res.setHeader('content-type','text/html;charset=utf-8');
  res.end(`<!doctype html><html lang="${zh?'zh-CN':'en'}"><meta charset="utf-8"><title>${article?'Less Switching':'Field Guide'} · Studio Notes</title><style>*{box-sizing:border-box}body{margin:0;background:#fcfbf8;color:#292d29;font:17px/1.75 -apple-system,BlinkMacSystemFont,sans-serif}nav{padding:18px 44px;border-bottom:1px solid #deded5;display:flex;align-items:center;gap:28px;font-size:13px}nav b{margin-right:auto;letter-spacing:3px}a{color:#38594a;text-decoration:none}a:hover{text-decoration:underline}.wrap{padding:36px 44px 70px;max-width:1100px;margin:auto}.eyebrow{font:11px monospace;letter-spacing:2px;color:#7c8479}h1{font-size:46px;line-height:1.18;letter-spacing:-1.2px;max-width:780px;margin:16px 0 22px}.lead{font-size:19px;max-width:690px;color:#6c7369}.columns{display:grid;grid-template-columns:1fr 220px;gap:44px;margin-top:32px}article{border-top:1px solid #d5d9cf;padding:22px 0}article h2{font-size:25px;margin:8px 0 10px}article p{color:#6c7369;font-size:16px;margin:0 0 12px}aside{border-left:1px solid #d5d9cf;padding-left:25px;font-size:14px;color:#697064}aside b{color:#303c31}aside p{margin:22px 0}small{color:#899184;font-size:12px}.reading{max-width:720px}.reading h2{font-size:26px;margin-top:38px}.reading p{color:#5b655b}.pull{border-left:3px solid #a8b59a;padding:10px 22px;margin:28px 0;background:#f0f3ec;font-size:22px}</style><nav><b>FIELD GUIDE</b><a href="/journal">${words('观察手记','Journal')}</a><span>${words('设计与工作','Design & work')}</span><span>${words('关于','About')}</span></nav><main class="wrap">${article?`<div class="eyebrow">ESSAY / 06 MIN READ</div><h1>${words('少一些切换，多一些专注。','Less switching. More room to think.')}</h1><p class="lead">${words('把资料、讨论与作品放在一起，让思路自然延续。','Bring references, conversation and creative work together, so the thought can continue.')}</p><div class="reading"><p>${words('一个好想法，常常从不起眼的观察开始。我们把资料收集起来，在讨论中理解问题，然后尝试做出一个可以修改的草稿。','A good idea often starts with a small observation. We collect references, understand the problem in conversation, and make a first draft we can improve.')}</p><div class="pull">${words('先保留思路，再追求完整。','Keep the thought alive before making it complete.')}</div><h2>${words('01 让线索留在手边','01 Keep the references close')}</h2><p>${words('当网页、笔记和画布可以放在同一个工作区，来回寻找的时间就少了。注意力可以更多地留给判断与创作。','When pages, notes and canvases share a workspace, less time goes into finding things again. More attention stays with the decisions and the work.')}</p><h2>${words('02 用草稿继续对话','02 Continue with a draft')}</h2><p>${words('可见的草稿让反馈更具体，也让下一步更清楚。','A visible draft makes feedback specific and the next step clearer.')}</p><a href="/journal">← ${words('返回观察手记','Back to the journal')}</a></div>`:`<div class="eyebrow">NOTES ON MAKING THINGS</div><h1>${words('关于更好工作的观察手记。','Notes on a more thoughtful way to work.')}</h1><p class="lead">${words('记录工具、创作和日常工作中的小发现。','Observations on tools, creative practice and everyday work.')}</p><div class="columns"><section><article><small>WORKFLOW · 06 MIN READ</small><h2><a id="feature-article" href="/journal/less-switching">${words('少一些切换，多一些专注。','Less switching. More room to think.')}</a></h2><p>${words('把资料、讨论与作品放在一起，让思路自然延续。','Bring references, conversation and creative work together.')}</p><a href="/journal/less-switching">${words('阅读全文','Read the essay')} →</a></article><article><small>DESIGN · 04 MIN READ</small><h2>${words('从一句话开始的设计','A design that starts with one sentence')}</h2><p>${words('先说清楚为什么，再决定它看起来怎样。','First explain why it matters. Then decide how it looks.')}</p></article><article><small>PRACTICE · 05 MIN READ</small><h2>${words('让每周回顾轻一点','A lighter weekly review')}</h2><p>${words('保留三个发现，写下一个下一步。','Keep three observations and one clear next step.')}</p></article></section><aside><b>${words('本期话题','IN THIS EDITION')}</b><p>01 / ${words('保持专注','Stay focused')}</p><p>02 / ${words('从草稿开始','Start with a draft')}</p><p>03 / ${words('每周回顾','Reflect each week')}</p><hr><p>${words('由工作室整理的虚构演示内容。','Fictional notes for this product demonstration.')}</p></aside></div>`}</main></html>`);
 });
 await new Promise(resolve=>website.listen(0,'127.0.0.1',resolve));let app;
 try{
  await hub.profile.update({name:words('演示工作室','Demo Studio'),revision:(await hub.profile.read()).revision});
  const chats=[];
  for(const [i,id] of ['codex','claude','kimi','deepseek','gemini','agy','studio'].entries()){
   await hub.store.db.run('INSERT INTO bots(id,name,secret_hash,engine,online) VALUES(?,?,?,?,1)',[id,['Codex','Claude','Kimi','DeepSeek','Gemini','Antigravity','Studio'][i],'documentation-only',({codex:'codex',claude:'claude',kimi:'kimi',deepseek:'deepseek',gemini:'antigravity',agy:'antigravity',studio:'claude'})[id]]);
   await hub.store.db.run('INSERT INTO meta(key,value) VALUES(?,?)',[BOT_AVATAR_DEFAULT_PREFIX+id,readmeAvatars[id]]);
   const chat=await hub.store.createConversation('owner',[id],words(['浏览参考资料','首页文案','用户研究','代码审阅','视觉方向','资料归档','每周回顾'][i],['Browse references','Homepage copy','User research','Code review','Visual direction','Reference library','Weekly review'][i]),`browser-chat-${i}`);chats.push(chat);
   await hub.store.publishBotMessage(id,{conversationId:chat.id,blocks:[{type:'text',text:words('资料已整理，随时继续。','Notes are organized and ready to continue.')}]});await hub.store.markRead('owner',chat.id,Number.MAX_SAFE_INTEGER);
  }
  await writeFile(path.join(stateDir,'config.json'),JSON.stringify({url:hub.url,profile:path.join(stateDir,'profile'),preload:path.join(root,'scripts/readme-electron-preload.cjs')}));
  app=await _electron.launch({executablePath:binary,args:[path.join(root,'scripts/readme-electron-main.mjs'),`--readme-config=${path.join(stateDir,'config.json')}`],timeout:30000});
  const page=await app.firstWindow();page.setDefaultTimeout(20000);await page.waitForLoadState('domcontentloaded');
  await prepareReadmePairing(page,hub);await page.getByRole('button',{name:'配对此设备',exact:true}).click();await hub.auth.approve(await page.getByLabel('配对码',{exact:true}).innerText(),'local-owner');await page.getByLabel('配对码',{exact:true}).waitFor({state:'hidden'});
  await readmePreferences(page,locale,'conversations');await page.reload();await page.locator('.app-shell').filter({visible:true}).waitFor();
  await page.evaluate(()=>{window.tarobotDesktop=window.__readmeBrowser;});
  await page.locator(`.conversation-row[data-conversation-id="${chats[0].id}"]`).filter({visible:true}).click();
  await page.getByRole('button',{name:words('工作台','Workbench'),exact:true}).click();
  const panel=page.getByRole('complementary',{name:words('工作台','Workbench'),exact:true});
  await panel.getByRole('button',{name:words('新建内容','New content'),exact:true}).click();
  await panel.getByRole('button',{name:words('新建网页','New webpage'),exact:true}).click();
  await panel.getByRole('button',{name:words('展开到主区','Expand workbench'),exact:true}).click();
  const address=panel.getByRole('textbox',{name:words('网址或搜索','Address or search'),exact:true});
  await address.fill(`http://studio.test:${website.address().port}/journal`);await address.press('Enter');
  await expect.poll(()=>app.evaluate(({webContents})=>webContents.getAllWebContents().some(c=>c.getTitle()==='Field Guide · Studio Notes'))).toBe(true);
  await page.waitForTimeout(1000);await address.blur();
  const capture={screenshot:async options=>{const png=await app.evaluate(async()=>globalThis.__readme.capture());await writeFile(options.path,Buffer.from(png,'base64'));}};
  const file=`workbench-browser-${locale}.png`;await capture.screenshot({path:path.join(output,file)});
  images.push({file,locale,viewport:{width:1440,height:900},sha256:createHash('sha256').update(await readFile(path.join(output,file))).digest('hex')});
  const motion=await recordReadmeMotion(capture,path.join(stateDir,'motion'),path.join(output,`browser-demo-${locale}.gif`),async()=>{
   await page.waitForTimeout(1400);
   await panel.getByRole('button',{name:words('接管','Take control'),exact:true}).click();
   await expect(panel.getByRole('button',{name:words('允许 Bot 操作','Allow Bot'),exact:true})).toBeVisible();
   await page.waitForTimeout(600);
   await app.evaluate(async({webContents})=>{const guest=webContents.getAllWebContents().find(c=>c.getTitle()==='Field Guide · Studio Notes');guest.sendInputEvent({type:'mouseWheel',x:400,y:350,deltaY:-300,deltaX:0});});
   await expect.poll(()=>app.evaluate(async({webContents})=>webContents.getAllWebContents().find(c=>c.getTitle()==='Field Guide · Studio Notes').executeJavaScript('window.scrollY'))).toBeGreaterThan(100);
   await page.waitForTimeout(1200);
   await app.evaluate(async({webContents})=>{const guest=webContents.getAllWebContents().find(c=>c.getTitle()==='Field Guide · Studio Notes');await guest.executeJavaScript('window.scrollTo({top:0,behavior:"smooth"})');});
   await page.waitForTimeout(800);
   await app.evaluate(async({webContents})=>{
    const guest=webContents.getAllWebContents().find(c=>c.getTitle()==='Field Guide · Studio Notes');
    const point=await guest.executeJavaScript('(()=>{const r=document.querySelector("#feature-article").getBoundingClientRect();return {x:Math.round(r.x+30),y:Math.round(r.y+r.height/2)}})()');
    guest.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});guest.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
   });
   await expect.poll(()=>app.evaluate(({webContents})=>webContents.getAllWebContents().some(c=>c.getTitle()==='Less Switching · Studio Notes'))).toBe(true);
   await page.waitForTimeout(2000);
   await app.evaluate(async({webContents})=>{const guest=webContents.getAllWebContents().find(c=>c.getTitle()==='Less Switching · Studio Notes');guest.sendInputEvent({type:'mouseWheel',x:400,y:350,deltaY:-270,deltaX:0});});
   await expect.poll(()=>app.evaluate(async({webContents})=>webContents.getAllWebContents().find(c=>c.getTitle()==='Less Switching · Studio Notes').executeJavaScript('window.scrollY'))).toBeGreaterThan(100);
   await page.waitForTimeout(1800);
  });animations.push({...motion,locale,actions:['Loaded journal webpage','Take control','Scroll the journal','Open an article link','Read and scroll the article']});
  console.log(`Captured ${file} and ${motion.file}`);
 }catch(error){if(app&&process.env.DEMO_KEEP){const page=await app.firstWindow();await page.screenshot({path:path.join(process.env.DEMO_KEEP,`browser-failure-${locale}.png`)});console.error((await page.locator('body').innerText()).slice(-3500));}throw error;}
 finally{if(app)await app.close();await hub.close();await new Promise(resolve=>website.close(resolve));await rm(stateDir,{recursive:true,force:true});}
}
await writeFile(path.join(output,'browser-capture.json'),JSON.stringify({...await captureProvenance(root),source:'Production Electron WorkbenchBrowser and built App in an isolated documentation harness. Loopback pairing, fictional site and conversations. The window renderer and native webpage surfaces are captured separately and composited without pixel edits at their actual child-view bounds. No real account, model or installed-App acceptance.',images,animations},null,2)+'\n');
