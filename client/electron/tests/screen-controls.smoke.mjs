// Actual Electron/OS fullscreen and production permission policy; synthetic
// viewing fixture only. Never captures a desktop or posts native remote input.
import { build } from 'esbuild';
import { _electron as electron, expect } from '@playwright/test';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedRoot } from '../isolation.mjs';
const [binary, output] = process.argv.slice(2);
if (!binary || !output) throw new Error('explicit isolated Electron binary and output required');
if (!(await realpath(binary)).split(path.sep).some(p => p.endsWith('.noindex'))) throw new Error('physical_noindex_binary_required');
const root = await isolatedRoot(output), here = path.dirname(fileURLToPath(import.meta.url));
await mkdir(path.join(root, 'profile'), { recursive: true });
await build({ entryPoints: [path.resolve(here, '../../e2e/fixtures/remote-screen.tsx')], outfile: path.join(root, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: {'.woff2':'file','.woff':'file','.ttf':'file','.png':'file','.svg':'file'}, define: {'process.env.NODE_ENV':'"development"','import.meta.env.PROD':'false','import.meta.env.DEV':'true'} });
await writeFile(path.join(root,'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/renderer.css"><div id="root"></div><script src="/renderer.js"></script>');
await writeFile(path.join(root,'preload.cjs'), "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('screenReadNativeWindow',()=>ipcRenderer.invoke('fixture:window-read'));");
await writeFile(path.join(root,'main.mjs'), `
import * as electron from 'electron';
const { app, BrowserWindow, protocol, session, net, ipcMain } = electron;
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { secureSession, secureContents, secureWebPreferences } from ${JSON.stringify(path.resolve(here,'../security.mjs'))};
import { DesktopServices } from ${JSON.stringify(path.resolve(here,'../desktop-services.mjs'))};
async function run(){
const root=${JSON.stringify(root)};
app.setPath('userData',path.join(root,'profile'));
protocol.registerSchemesAsPrivileged([{scheme:'tarobot',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
await app.whenReady();app.dock?.hide();
const owned=session.fromPartition('persist:screen-controls');let window;
secureSession(owned,{owns:contents=>contents===window?.webContents});
owned.protocol.handle('tarobot',request=>{const file=path.resolve(root,'.'+new URL(request.url).pathname);if(!file.startsWith(root+path.sep))return new Response('',{status:403});return net.fetch(pathToFileURL(file).href);});
window=new BrowserWindow({title:'TaroBot Remote Screen Controls Acceptance',width:1100,height:760,show:false,titleBarStyle:'hiddenInset',webPreferences:secureWebPreferences(path.join(root,'preload.cjs'),owned)});
secureContents(window.webContents);
const services=new DesktopServices(window,electron);
ipcMain.handle('fixture:window-read',event=>{if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('not_fixture');return services.request('desktop_window_read',{},()=>!window.isDestroyed());});
window.on('closed',()=>services.dispose());
globalThis.screenControlEvents=[];
for(const event of ['enter-html-full-screen','leave-html-full-screen'])window.webContents.on(event,()=>globalThis.screenControlEvents.push(event));
for(const event of ['enter-full-screen','leave-full-screen'])window.on(event,()=>globalThis.screenControlEvents.push(event));
await window.loadURL('tarobot://app/index.html');window.show();
}
void run().catch(error=>{console.error(error);app.exit(1);});
`);
await build({entryPoints:[path.join(root,'main.mjs')],outfile:path.join(root,'main.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron']});
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
 app=await electron.launch({executablePath:binary,args:[path.join(root,'main.cjs')],env,timeout:25000});
 const page=await app.firstWindow();page.setDefaultTimeout(10000);
 await page.getByRole('button',{name:'连接屏幕',exact:true}).click();await expect(page.getByRole('button',{name:'开始控制',exact:true})).toBeEnabled();
 const before=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getBounds());
 const initialSequence=await page.evaluate(()=>window.screenFixture.seq);
 await page.getByRole('button',{name:'全屏',exact:true}).click();
 await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true);
 await expect.poll(()=>page.evaluate(()=>document.fullscreenElement?.classList.contains('remote-screen-panel'))).toBe(true);
 await expect.poll(()=>page.evaluate(()=>{const v=document.querySelector('.screen-viewport').getBoundingClientRect();return Math.abs(v.width-innerWidth)+Math.abs(v.height-innerHeight);})).toBeLessThan(3);
 await expect.poll(()=>page.evaluate(()=>{const v=document.querySelector('.screen-viewport').getBoundingClientRect(),c=document.querySelector('canvas'),b=c.getBoundingClientRect(),f=Math.min(v.width/c.width,v.height/c.height);return Math.abs(b.width-c.width*f)+Math.abs(b.height-c.height*f);})).toBeLessThan(3);
 await page.mouse.move(600,400);await expect(page.getByRole('button',{name:'显示屏幕工具栏',exact:true})).toBeVisible({timeout:7000});
 await expect.poll(()=>page.evaluate(()=>window.screenFixture.seq)).toBeGreaterThan(initialSequence+2);
 await expect(page.locator('.screen-state')).toContainText('查看中');
 await page.screenshot({path:path.join(root,'native-fullscreen.png')});
 const fullscreenSequence=await page.evaluate(()=>window.screenFixture.seq);
 await page.getByRole('button',{name:'显示屏幕工具栏',exact:true}).click();await page.getByRole('button',{name:'退出全屏',exact:true}).click();
 await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(false);
 await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(false);
 await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getBounds())).toEqual(before);
 await expect.poll(()=>page.evaluate(()=>window.screenFixture.seq)).toBeGreaterThan(fullscreenSequence);
 await expect(page.locator('.screen-state')).toContainText('查看中');
 await page.getByLabel('本地聊天草稿').fill('全屏退出后可继续输入');
 await expect(page.getByLabel('本地聊天草稿')).toHaveValue('全屏退出后可继续输入');
 await page.getByRole('button',{name:'展开屏幕',exact:true}).click();await page.screenshot({path:path.join(root,'native-toolbar.png')});
 // Closing the fullscreen surface must restore the actual OS window before
 // the viewer disappears, not just clear document.fullscreenElement.
 await page.getByRole('button',{name:'全屏',exact:true}).click();
 await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true);
 await page.getByRole('button',{name:'断开并关闭屏幕',exact:true}).click();
 await page.screenshot({path:path.join(root,'native-after-close.png')});
 await expect.poll(()=>app.evaluate(()=>globalThis.screenControlEvents.filter(event=>event==='leave-full-screen').length),{timeout:10000}).toBe(2);
 await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(false);
 await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(false);
 await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getBounds())).toEqual(before);
 await expect(page.getByRole('complementary',{name:'远程屏幕'})).toHaveCount(0);
 await page.getByLabel('本地聊天草稿').fill('全屏点叉后可继续输入');
 await expect(page.getByLabel('本地聊天草稿')).toHaveValue('全屏点叉后可继续输入');
 await page.screenshot({path:path.join(root,'native-close-restored.png')});
 // Also close after the macOS entry animation has completed; isFullScreen()
 // alone can become true before enter-full-screen is delivered.
 await page.reload();
 await page.getByRole('button',{name:'连接屏幕',exact:true}).click();await expect(page.getByRole('button',{name:'开始控制',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'全屏',exact:true}).click();
 await expect.poll(()=>app.evaluate(()=>globalThis.screenControlEvents.filter(event=>event==='enter-full-screen').length)).toBe(3);
 await page.getByRole('button',{name:'断开并关闭屏幕',exact:true}).click();
 await expect.poll(()=>app.evaluate(()=>globalThis.screenControlEvents.filter(event=>event==='leave-full-screen').length)).toBe(3);
 await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(false);
 await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getBounds())).toEqual(before);
 await expect(page.getByRole('complementary',{name:'远程屏幕'})).toHaveCount(0);
 await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(false);
 await page.getByLabel('本地聊天草稿').fill('转场完成后点叉也能继续聊天');
 await expect(page.getByLabel('本地聊天草稿')).toHaveValue('转场完成后点叉也能继续聊天');
 await page.screenshot({path:path.join(root,'native-settled-close-restored.png')});
 // Browser/Escape can finish HTML fullscreen before macOS finishes leaving
 // its Space. Closing at that point must still restore native state and input.
 await page.reload();
 await page.getByRole('button',{name:'连接屏幕',exact:true}).click();await expect(page.getByRole('button',{name:'开始控制',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'全屏',exact:true}).click();
 await expect.poll(()=>app.evaluate(()=>globalThis.screenControlEvents.filter(event=>event==='enter-full-screen').length)).toBe(4);
 await page.evaluate(()=>document.exitFullscreen());
 await page.getByRole('button',{name:'断开并关闭屏幕',exact:true}).click();
 await expect.poll(()=>app.evaluate(()=>globalThis.screenControlEvents.filter(event=>event==='leave-full-screen').length)).toBe(4);
 await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(false);
 await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getBounds())).toEqual(before);
 await expect(page.getByRole('complementary',{name:'远程屏幕'})).toHaveCount(0);
 await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(false);
 await page.getByLabel('本地聊天草稿').fill('先退出全屏再关闭仍可输入');
 await expect(page.getByLabel('本地聊天草稿')).toHaveValue('先退出全屏再关闭仍可输入');
 await page.screenshot({path:path.join(root,'native-external-exit-close-restored.png')});
 const events=await app.evaluate(()=>globalThis.screenControlEvents);
 const visibility=await page.evaluate(()=>({document:document.visibilityState,commands:window.screenFixture.commands.filter(value=>value.type==='visibility').map(value=>value.visible),frames:window.screenFixture.seq}));
 const result={passed:true,events,windowBounds:before,visibility,scope:'Real isolated Electron window + production secureSession/secureContents policy, HTML and native fullscreen enter/exit including close X, geometry restoration, control auto-hide, draft editing. Synthetic pixels and transport fixture; no desktop capture or native remote input.'};
 await writeFile(path.join(root,'verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} catch(error) {
 if(app) {
  await (await app.firstWindow()).screenshot({path:path.join(root,'native-failure.png')}).catch(()=>{});
  await writeFile(path.join(root,'failure.json'),JSON.stringify(await app.evaluate(({BrowserWindow})=>({events:globalThis.screenControlEvents,fullscreen:BrowserWindow.getAllWindows()[0].isFullScreen(),bounds:BrowserWindow.getAllWindows()[0].getBounds()})),null,2));
 }
 throw error;
} finally { await app?.close(); }
