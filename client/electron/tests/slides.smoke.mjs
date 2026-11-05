// Real upstream Slides in an isolated Electron window, production CSP and quit hooks.
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
import { DESIGN_BOOTSTRAP_URL, isDesignDocumentURL } from '../design-document.mjs';
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--lab'||args[2]!=='--cache-root')throw Error('usage: slides.smoke.mjs --lab .noindex --cache-root .noindex');
const root=await mkdtemp(path.join(await isolatedRoot(args[1]),'native-slides-')),assets=path.join(root,'assets');await mkdir(assets);
const client=fileURLToPath(new URL('../../',import.meta.url));
for(const name of ['slides-sandbox.html','design-loader.html'])await copyFile(path.join(process.env.TAROBOT_DESIGN_CLIENT_DIR || path.join(client,'dist'),name),path.join(assets,name));
await writeFile(path.join(assets,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><script type="module" src="/smoke.js"></script></head><body><div id="surface" style="width:100%;height:700px"></div></body></html>');
await build({stdin:{contents:`import { designFrame } from './src/design-frame.ts';import { DesignSession } from './src/workbench-design-session.ts';import { emptySlides } from './src/workbench-design.ts';let disk=emptySlides('native','Native PPT');const session=new DesignSession(disk,async()=>disk,async(expected,next)=>{if(window.rejectDesignSave)throw Error('fixture_save_denied');if(expected!==disk.revision)throw Error('conflict');disk=next;},()=>{});window.designTest={session,openSecond:({session,surface})=>designFrame(session).attach(surface,()=>{},()=>{}),read:()=>disk,open:()=>designFrame(session).attach(document.getElementById('surface'),error=>{window.designError=error;},()=>{})};window.designTest.open();`,resolveDir:client,loader:'ts'},bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:path.join(assets,'smoke.js')});
const preload=await buildPreload(path.join(root,'preload')),config=path.join(root,'config.json');await writeFile(config,JSON.stringify({root,assets,preload,show:true}));
let app;const checks=[];
try {
 app=await _electron.launch({executablePath:await electronRuntime(args[3]),args:[fileURLToPath(new URL('./design-smoke-main.mjs',import.meta.url)),`--design-acceptance=${config}`],env:helperEnvironment(),timeout:30000});
 const page=await app.firstWindow(),errors=[];
 const deadline=setTimeout(()=>{console.error('NATIVE_TEST_DEADLINE',checks);void app.evaluate(({app})=>app.exit(1));},90000);deadline.unref();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',()=>{});
 const editor=page.frameLocator('.workbench-design-frame').first(), heading=editor.getByRole('heading',{level:1}).first();
 await expect(heading).toHaveText('Native PPT',{timeout:25000});checks.push('real-slides-under-production-electron-csp');
 let guest=page.frames().find(f=>f.parentFrame()===page.mainFrame());
 assert.deepEqual(await guest.evaluate(()=>({node:typeof require,bridge:typeof window.tarobotDesktop,parent:(()=>{try{return parent.document.title;}catch{return 'isolated';}})()})),{node:'undefined',bridge:'undefined',parent:'isolated'});checks.push('opaque-origin-no-native-bridge');
 // Playwright renderer evaluation marks a synthetic user activation. Wait for
 // that earlier isolation read to expire before testing a genuine no-gesture call.
 await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.mainFrame.frames[0].executeJavaScript('navigator.userActivation.isActive',false)),{timeout:8000}).toBe(false);
 assert.equal(await app.evaluate(async({BrowserWindow})=>{
  const frame=BrowserWindow.getAllWindows()[0].webContents.mainFrame.frames[0];
  return frame.executeJavaScript('document.documentElement.requestFullscreen().then(()=>true,()=>false)',false);
 }),false);checks.push('fullscreen-requires-user-activation');
 for(const duplicate of [false,true]) {
  const url=duplicate?guest.url():DESIGN_BOOTSTRAP_URL+'#b33b01c0-1280-4000-8000-000000000003';
  await guest.evaluate(url=>{const f=document.createElement('iframe');f.id='untrusted';f.allow='fullscreen *';f.sandbox='allow-scripts allow-same-origin';f.src=url;document.body.appendChild(f);},url);
  await expect.poll(()=>guest.childFrames().some(f=>f.url()===url)).toBe(true);
  const nested=guest.childFrames().find(f=>f.url()===url);
  assert.equal(await nested.evaluate(()=>document.fullscreenEnabled),true);
  assert.equal(await app.evaluate(async({BrowserWindow},url)=>{
   const main=BrowserWindow.getAllWindows()[0].webContents.mainFrame;
   const frame=main.framesInSubtree.find(f=>f.url===url&&f.parent?.parent===main);
   return frame.executeJavaScript("window.fullscreenProbe='pending';document.documentElement.requestFullscreen().then(()=>window.fullscreenProbe='allowed',()=>window.fullscreenProbe='denied');'requested'",true);
  },url),'requested');
  // Electron may leave a rejected nested-frame Fullscreen promise pending.
  // Assert the actual permission decision and native/DOM state, not settlement.
  await expect.poll(()=>app.evaluate((_,url)=>globalThis.designPermissionEvents.filter(e=>e.url===url&&e.permission==='fullscreen').at(-1)?.allowed,url)).toBe(false);
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFullScreen()),false);
  assert.equal(await nested.evaluate(()=>document.fullscreenElement),null);
  assert.equal(await page.evaluate(()=>document.fullscreenElement),null);
  // A denied nested request can remain pending in Chromium; retire the test
  // document before the next independent permission scenario.
  await page.evaluate(async()=>{await window.designTest.session.retire();window.designTest.open();});
  await expect(heading).toHaveText('Native PPT',{timeout:25000});
  guest=page.frames().find(f=>f.parentFrame()===page.mainFrame());
 }
 checks.push('nested-and-duplicate-bootstrap-cannot-borrow-fullscreen');
 await page.evaluate(async()=>{
  document.getElementById('surface').style.width='calc(100% - 300px)';
  const surface=document.createElement('div');surface.id='second';surface.style.cssText='position:fixed;right:10px;top:10px;width:260px;height:260px';document.body.appendChild(surface);
  const {session}=window.designTest;window.designTestSecond={surface,session:new session.constructor({...session.document,id:'second',title:'Second PPT'},async()=>({...session.document,id:'second'}),async()=>{},()=>{})};
 });
 // A second real editor uses the same production loader and a different URL.
 await page.evaluate(()=>window.designTest.openSecond(window.designTestSecond));
 await expect(page.frameLocator('.workbench-design-frame').nth(1).getByRole('heading',{level:1}).first()).toBeVisible({timeout:25000});
 const documents=page.frames().filter(f=>f.parentFrame()===page.mainFrame()).map(f=>f.url());
 assert.equal(documents.length,2);assert.equal(new Set(documents).size,2);assert.ok(documents.every(isDesignDocumentURL));
 await editor.getByRole('button',{name:'Present',exact:true}).click();
 await editor.getByText('Present',{exact:true}).last().click();
 await expect(editor.getByRole('button',{name:'Exit full screen (F)',exact:true})).toBeVisible({timeout:8000});
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFullScreen()),true);
 assert.equal(await page.evaluate(()=>document.fullscreenElement===document.querySelector('.workbench-design-frame')),true);
 assert.equal(await guest.evaluate(()=>document.fullscreenElement===document.documentElement),true);
 await expect.poll(()=>app.evaluate(()=>globalThis.designFullscreenEvents.includes('enter-full-screen'))).toBe(true);
 await page.screenshot({path:path.join(root,'slides-native-fullscreen.png')});
 await editor.getByRole('button',{name:'Exit full screen (F)',exact:true}).click();
 await expect.poll(()=>guest.evaluate(()=>document.fullscreenElement===null)).toBe(true);
 await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(false);
 // The slideshow intentionally auto-hides its toolbar; state and native exit
 // remain observable without depending on pointer-hover timing.
 await expect(editor.getByRole('button',{name:'Full screen (F)',exact:true,includeHidden:true})).toHaveCount(1);
 await expect.poll(()=>app.evaluate(()=>globalThis.designFullscreenEvents.includes('leave-full-screen'))).toBe(true);
 await page.keyboard.press('f');
 await expect.poll(()=>app.evaluate(()=>globalThis.designFullscreenEvents.filter(e=>e==='enter-full-screen').length)).toBe(2);
 assert.equal(await guest.evaluate(()=>document.fullscreenElement===document.documentElement),true);
 await page.keyboard.press('f');
 await expect.poll(()=>app.evaluate(()=>globalThis.designFullscreenEvents.filter(e=>e==='leave-full-screen').length)).toBe(2);
 assert.equal(await guest.evaluate(()=>document.fullscreenElement),null);
 await page.keyboard.press('Escape');
 await expect(heading).toBeVisible();checks.push('native-presentation-fullscreen-button-and-keyboard-with-two-editors');
 await page.evaluate(async()=>{await window.designTestSecond.session.retire();window.designTestSecond.surface.remove();});
 await page.evaluate(async()=>{const s=window.designTest.session,r=await s.read({path:'project/slides/cover.html'});await s.publish('native-edit',r.revision,{files:{'project/slides/cover.html':{content:r.result.content.replace('Native PPT','Native Bot edit'),contentType:'text/html'}}},()=>{});});
 await expect(heading).toHaveText('Native Bot edit',{timeout:25000});checks.push('bot-publish-visible');
 await heading.dblclick();await page.keyboard.press('Meta+A');await page.keyboard.type('Native human edit');
 await page.evaluate(()=>window.designTest.session.retire());await expect(page.locator('.workbench-design-frame')).toHaveCount(0);
 await page.evaluate(()=>window.designTest.open());await expect(heading).toHaveText('Native human edit',{timeout:25000});checks.push('active-caret-save-before-retire-reopen');
 await editor.locator('html').evaluate(node=>node.dataset.identity='same');
 await page.evaluate(()=>document.documentElement.dataset.theme='dark');await expect(editor.locator('html')).toHaveAttribute('data-theme','dark');
 await expect(editor.locator('html')).toHaveAttribute('data-identity','same');checks.push('theme-preserves-editor');
 await page.locator('#surface').evaluate(node=>node.style.width='440px');
 await expect.poll(()=>page.evaluate(()=>Math.abs(document.querySelector('.workbench-design-frame').getBoundingClientRect().width-document.querySelector('#surface').getBoundingClientRect().width))).toBeLessThan(1);checks.push('resizes-after-bot-reload');
 const prepare=()=>app.evaluate(({BrowserWindow})=>globalThis.designQuitTest.prepareDesignQuit(BrowserWindow.getAllWindows()[0].webContents));
 const cancel=()=>app.evaluate(({BrowserWindow})=>globalThis.designQuitTest.cancelDesignQuit(BrowserWindow.getAllWindows()[0].webContents));
 await page.evaluate(()=>window.rejectDesignSave=true);await heading.dblclick();await page.keyboard.press('Meta+A');await page.keyboard.type('Saved on retry');
 assert.equal(await prepare(),false);assert.equal(page.isClosed(),false);await expect(page.locator('.workbench-design-frame')).toHaveJSProperty('inert',false);
 await page.evaluate(()=>window.rejectDesignSave=false);assert.equal(await prepare(),true);await cancel();checks.push('failed-save-prevents-quit-and-retry-recovers');
 await page.keyboard.press('Escape');await expect(editor.getByText('Saved on retry',{exact:true}).first()).toBeVisible();await page.screenshot({path:path.join(root,'slides-electron.png')});
 await heading.dblclick();await page.keyboard.press('Meta+A');await page.keyboard.type('Prepared final edit');
 assert.equal(await prepare(),true);
 assert.ok((await page.evaluate(()=>new TextDecoder().decode(Uint8Array.from(atob(window.designTest.read().files['project/slides/cover.html'].base64),c=>c.charCodeAt(0))))).includes('Prepared final edit'));
 const closed=page.waitForEvent('close');await app.evaluate(({BrowserWindow})=>setImmediate(()=>BrowserWindow.getAllWindows()[0].close()));await closed;checks.push('real-native-quit-saves-active-text');
 assert.deepEqual(errors,[]);
 const receipt={status:'passed',checks,productionHostUsed:false,installedAppChanged:false,root};await writeFile(path.join(root,'verification.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}catch(error){
 console.error('NATIVE_ERROR',error);
 if(app) console.log('NATIVE_DIAGNOSTICS',await app.evaluate(({BrowserWindow})=>({events:globalThis.designFullscreenEvents,permissions:globalThis.designPermissionEvents.map(e=>({...e,url:e.url.slice(-36)})),windows:BrowserWindow.getAllWindows().map(w=>({url:w.webContents.getURL(),visible:w.isVisible(),fullscreen:w.isFullScreen(),frames:w.webContents.mainFrame.framesInSubtree.map(f=>({url:f.url.slice(0,100),detached:f.detached}))}))})).catch(()=>null));
 if(app){const p=await app.firstWindow();await p.screenshot({path:path.join(root,'failure.png')}).catch(()=>{});console.log('NATIVE_FAILURE_STATE',await p.frameLocator('.workbench-design-frame').locator('body').ariaSnapshot().catch(()=>''));}throw error;
}finally{if(app){await app.evaluate(({app})=>setImmediate(()=>app.exit(0))).catch(()=>{});await app.close().catch(()=>{});}}
