import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron, expect } from '@playwright/test';
import { electronRuntime } from '../../scripts/electron-runtime.mjs';
import { buildPreload } from '../../scripts/electron-preload.mjs';
import { isolatedRoot } from '../isolation.mjs';
import { helperEnvironment } from '../helper-rpc.mjs';
const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--lab'||args[2]!=='--cache-root')throw Error('usage: design.smoke.mjs --lab .noindex --cache-root .noindex');
const root=await mkdtemp(path.join(await isolatedRoot(args[1]),'native-design-')),assets=path.join(root,'assets');await mkdir(assets);
const client=fileURLToPath(new URL('../../',import.meta.url));
for(const name of ['design-sandbox.html','design-loader.html'])await copyFile(path.join(process.env.TAROBOT_DESIGN_CLIENT_DIR || path.join(client,'dist'),name),path.join(assets,name));
await writeFile(path.join(assets,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><script type="module" src="/smoke.js"></script></head><body><div id="surface" style="width:100%;height:700px"></div></body></html>');
await build({stdin:{contents:`import { designFrame } from './src/design-frame.ts';import { DesignSession } from './src/workbench-design-session.ts';import { emptyDesign } from './src/workbench-design.ts';let disk=emptyDesign('native','Native Design');const session=new DesignSession(disk,async()=>disk,async(expected,next)=>{if(window.rejectDesignSave)throw Error('fixture_save_denied');if(window.holdDesignSave)await new Promise(resolve=>{window.resumeDesignSave=resolve;});if(expected!==disk.revision)throw Error('conflict');disk=next;},()=>{});window.designTest={session,read:()=>disk,open:()=>designFrame(session).attach(document.getElementById('surface'),error=>{window.designError=error;},()=>{})};window.designTest.open();`,resolveDir:client,loader:'ts'},bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:path.join(assets,'smoke.js')});
const preload=await buildPreload(path.join(root,'preload')),config=path.join(root,'config.json');await writeFile(config,JSON.stringify({root,assets,preload}));
let app;const checks=[];
try{
 app=await _electron.launch({executablePath:await electronRuntime(args[3]),args:[fileURLToPath(new URL('./design-smoke-main.mjs',import.meta.url)),`--design-acceptance=${config}`],env:helperEnvironment(),timeout:30000});
 const page=await app.firstWindow(),errors=[];page.on("console",m=>{if(m.type()==="error")console.error("DESIGN_CONSOLE",m.text().slice(0,300));});page.on('pageerror',e=>errors.push(e.message));
 // Electron handles this through will-prevent-unload; keep Playwright from
 // trying to dismiss a browser JavaScript dialog which does not exist here.
 page.on('dialog',()=>{});
 const titles=()=>Promise.all(page.frames().filter(frame=>frame.parentFrame()?.parentFrame()===page.mainFrame()).map(frame=>frame.locator('h1').textContent({timeout:300}).catch(()=>'')));
 await expect.poll(titles,{timeout:60000}).toContain('Native Design').catch(async error=>{console.error('DESIGN_BOOT',await page.evaluate(()=>({error:window.designError,body:document.body.innerText.slice(0,500),frames:document.querySelectorAll('iframe').length,fixture:!!window.designTest})));await page.screenshot({path:path.join(root,'boot-failure.png')});throw error;});checks.push('actual-upstream-canvas-under-production-electron-csp');
 const guest=page.frames().find(frame=>frame.parentFrame()===page.mainFrame());
 assert.deepEqual(await guest.evaluate(()=>({node:typeof require,bridge:typeof window.tarobotDesktop,parent:(()=>{try{return parent.document.title;}catch{return 'isolated';}})()})),{node:'undefined',bridge:'undefined',parent:'isolated'});checks.push('opaque-origin-no-parent-dom-or-native-bridge');
 assert.equal(await guest.evaluate(async()=>{try{await window.designHost.chat.suggestPrompt('Repair this canvas');return 'unexpected-success';}catch{return 'declined';}}),'declined');checks.push('repair-draft-requires-an-explicit-local-session-provider');
 const commentAccess=await guest.evaluate(async()=>{const response=await fetch('https://design.invalid/__comments');return {status:response.status,body:await response.json()};});assert.equal(commentAccess.status,404);assert.equal(commentAccess.body.code,'disabled');checks.push('comments-require-an-explicit-local-session-provider');
 const uploaded=await guest.evaluate(()=>window.designHost.assets.upload(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#82776a"/></svg>'],{type:'image/svg+xml'})));
 const read=await page.evaluate(()=>window.designTest.session.read({path:'project/Main.dc.html'}));
 const result=await page.evaluate(async({content,revision,asset})=>window.designTest.session.publish('native-edit',revision,{files:{'project/Main.dc.html':{content:content.replace('Native Design','Native Edited').replace('</div>',`<img alt="Local asset" src="${asset}" width="16" height="16"/></div>`),contentType:'text/html'}}},()=>{}),{content:read.result.content,revision:read.revision,asset:uploaded.url});assert.equal(result.revision,2);
 await expect.poll(titles,{timeout:25000}).toContain('Native Edited');checks.push('saved-edit-reloads-real-preview');
 await expect.poll(()=>Promise.all(page.frames().filter(frame=>frame.parentFrame()?.parentFrame()===page.mainFrame()).map(frame=>frame.locator('img[alt="Local asset"]').evaluate(node=>node.complete&&node.naturalWidth===16).catch(()=>false))),{timeout:15000}).toContain(true);checks.push('uploaded-asset-is-local-and-renders-after-reload');
 // Non-ASCII project files must survive the real editor's load/save cycle.
 const unicode = await page.evaluate(async()=>{
   const s=window.designTest.session, meta=await s.read({path:'project/canvas.json'}), source=await s.read({path:'project/Main.dc.html'});
   const canvas=JSON.parse(meta.result.content), file='页面 (2)+e\u0301.dc.html';
   canvas.boards[file]={x:1000,y:0,w:880,h:560,title:'Unicode board'};canvas.order.push(file);
   await s.publish('native-unicode',source.revision,{files:{['project/'+file]:{content:source.result.content.replace('Native Edited','Native Unicode'),contentType:'text/html'},'project/canvas.json':{content:JSON.stringify(canvas),contentType:'application/json'}}},()=>{});
   return {file,original:meta.result.content};
 });
 await expect.poll(titles,{timeout:25000}).toEqual(expect.arrayContaining(['Native Edited','Native Unicode']));
 await page.evaluate(()=>window.designTest.session.retire());await page.evaluate(()=>window.designTest.open());
 await expect.poll(titles,{timeout:25000}).toEqual(expect.arrayContaining(['Native Edited','Native Unicode']));
 // A persisted round trip must keep the exact Unicode filename, not an ASCII alias.
 const listing=await page.evaluate(()=>window.designTest.session.read({}));assert.ok(listing.result.files['project/'+unicode.file]);
 await page.evaluate(async({file,original})=>{const s=window.designTest.session;await s.publish('native-unicode-cleanup',window.designTest.read().revision,{files:{['project/'+file]:null,'project/canvas.json':{content:original,contentType:'application/json'}}},()=>{});},unicode);
 await expect.poll(titles,{timeout:25000}).toEqual(['Native Edited']);checks.push('unicode-artboard-renders-reopens-and-keeps-exact-path');
 const artboard=page.frames().find(frame=>frame.parentFrame()?.parentFrame()===page.mainFrame());
 await artboard.locator('h1').dblclick();await page.keyboard.press('Meta+A');await page.keyboard.type('Native human edit');await page.keyboard.press('Escape');
 const edited=await page.evaluate(()=>window.designTest.session.read({path:'project/Main.dc.html'}));
 assert.ok(edited.result.content.includes('Native human edit'));assert.ok(edited.result.content.includes(uploaded.url));assert.ok(!edited.result.content.includes('blob:null/'));checks.push('manual-flush-keeps-portable-asset-references');
 const liveEditor=page.frameLocator('.workbench-design-frame');
 await liveEditor.locator('html').evaluate(node=>{node.dataset.auditIdentity='same-native-editor';});
 await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await expect(liveEditor.locator('html')).toHaveAttribute('data-theme','dark');
 await page.evaluate(()=>{document.documentElement.dataset.theme='light';});await expect(liveEditor.locator('html')).toHaveAttribute('data-theme','light');
 await expect(liveEditor.locator('html')).toHaveAttribute('data-audit-identity','same-native-editor');await expect(artboard.locator('h1')).toHaveText('Native human edit');checks.push('theme-change-preserves-live-editor');
 await app.evaluate(({BrowserWindow})=>{globalThis.designUnloadPrevented=0;BrowserWindow.getAllWindows()[0].webContents.on('will-prevent-unload',()=>{globalThis.designUnloadPrevented++;});});
 await artboard.locator('h1').dblclick();await page.keyboard.press('Meta+A');await page.keyboard.type('Native quit edit');
 // A real Electron close goes through the renderer's beforeunload guard.
 // No listener overrides it; the window must remain alive while saving.
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
 await expect.poll(()=>app.evaluate(()=>globalThis.designUnloadPrevented)).toBe(1);
 assert.equal(page.isClosed(),false);
 await expect.poll(()=>page.evaluate(()=>new TextDecoder().decode(Uint8Array.from(atob(window.designTest.read().files['project/Main.dc.html'].base64),c=>c.charCodeAt(0)))),{timeout:15000}).toContain('Native quit edit');checks.push('native-close-protects-and-saves-unsettled-text');
 await page.locator('#surface').evaluate(node=>{node.style.width='230px';});
 await expect.poll(()=>page.evaluate(()=>Math.abs(document.querySelector('.workbench-design-frame').getBoundingClientRect().width-document.querySelector('#surface').getBoundingClientRect().width))).toBeLessThan(1);checks.push('surface-resize-after-bot-reload');
 await page.evaluate(()=>window.designTest.session.retire());await expect(page.locator('.workbench-design-frame')).toHaveCount(0);checks.push('retirement-destroys-editor');assert.deepEqual(errors,[]);
 await page.evaluate(()=>window.designTest.open());await expect.poll(titles,{timeout:25000}).toContain('Native quit edit');
 const prepare=()=>app.evaluate(({BrowserWindow})=>globalThis.designQuitTest.prepareDesignQuit(BrowserWindow.getAllWindows()[0].webContents));
 assert.equal(await prepare(),true);await expect(page.locator('.workbench-design-frame')).toHaveJSProperty('inert',true);
 assert.equal(await page.evaluate(async()=>{try{await window.designTest.session.publish('quit-blocked',window.designTest.read().revision,{files:{'project/New.dc.html':{content:'<p>blocked</p>',contentType:'text/html'}}},()=>{});return 'unexpected';}catch(e){return e.message;}}),'design_closing');checks.push('native-prequit-blocks-new-bot-writes');
 // A locked editor can finish a required restart even if the old bundle can
 // no longer save. This is checked per editor, not a stale main-process flag.
 await page.evaluate(()=>{window.savedDesignFlush=window.designTest.session.flush;window.designTest.session.flush=async()=>{throw Error('old_bundle_unavailable');};});
 assert.equal(await prepare(),true);checks.push('native-locked-editor-reuses-confirmed-save-without-reflush');
 await page.evaluate(()=>{window.designTest.session.flush=window.savedDesignFlush;delete window.savedDesignFlush;});
 await app.evaluate(({BrowserWindow})=>globalThis.designQuitTest.cancelDesignQuit(BrowserWindow.getAllWindows()[0].webContents));
 await expect(page.locator('.workbench-design-frame')).toHaveJSProperty('inert',false);checks.push('native-prequit-cancellation-restores-input');
 const finalText=page.frameLocator('.workbench-design-frame').frameLocator('iframe').locator('h1');
 await page.evaluate(()=>window.rejectDesignSave=true);
 await finalText.dblclick();await page.keyboard.press('Meta+A');await page.keyboard.type('Native failed save');
 assert.equal(await prepare(),false);assert.equal(page.isClosed(),false);
 await expect(page.locator('.workbench-design-frame')).toHaveJSProperty('inert',false);
 await page.evaluate(()=>window.rejectDesignSave=false);assert.equal(await prepare(),true);
 await app.evaluate(({BrowserWindow})=>globalThis.designQuitTest.cancelDesignQuit(BrowserWindow.getAllWindows()[0].webContents));
 await expect(page.locator('.workbench-design-frame')).toHaveJSProperty('inert',false);checks.push('native-failed-save-cancels-exit-and-retry-recovers');
 await page.evaluate(()=>window.holdDesignSave=true);
 await finalText.dblclick();await page.keyboard.press('Meta+A');await page.keyboard.type('Cancelled pending save');
 const pendingPrepare=prepare();await page.waitForFunction(()=>typeof window.resumeDesignSave==='function');
 await app.evaluate(({BrowserWindow})=>globalThis.designQuitTest.cancelDesignQuit(BrowserWindow.getAllWindows()[0].webContents));
 await page.evaluate(()=>{window.holdDesignSave=false;window.resumeDesignSave();});assert.equal(await pendingPrepare,false);
 await expect(page.locator('.workbench-design-frame')).toHaveJSProperty('inert',false);
 assert.equal(await page.evaluate(()=>window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),false);checks.push('native-cancel-rejects-late-save-permit');
 await finalText.dblclick();await page.keyboard.press('Meta+A');await page.keyboard.type('Native prepared exit');
 assert.equal(await prepare(),true);
 assert.ok((await page.evaluate(()=>new TextDecoder().decode(Uint8Array.from(atob(window.designTest.read().files['project/Main.dc.html'].base64),c=>c.charCodeAt(0))))).includes('Native prepared exit'));
 const closed=page.waitForEvent('close');await app.evaluate(({BrowserWindow})=>{setImmediate(()=>BrowserWindow.getAllWindows()[0].close());});await closed;checks.push('native-prequit-saves-second-edit-and-closes-without-warning');
 const receipt={status:'passed',checks,productionHostUsed:false,installedAppChanged:false,root};await writeFile(path.join(root,'verification.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{if(app){await app.evaluate(({app})=>{setImmediate(()=>app.exit(0));}).catch(()=>{});await app.close().catch(()=>{});}}
