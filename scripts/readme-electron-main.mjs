// Documentation-only Electron harness. It uses the production native browser
// with a disposable profile and a synthetic local website; no installed App state.
import * as electron from 'electron';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { WorkbenchBrowser, BROWSER_COMMANDS } from '../client/electron/browser.mjs';
const { app, BrowserWindow, ipcMain } = electron;
const configFile = process.argv.find(value => value.startsWith('--readme-config='))?.slice(16);
if (!configFile || !configFile.includes('.noindex/')) throw new Error('isolated_readme_config_required');
const config = JSON.parse(await readFile(configFile,'utf8'));
if (!config.profile.includes('.noindex/')) throw new Error('isolated_readme_profile_required');
await mkdir(config.profile,{recursive:true});
app.setPath('userData',config.profile);
app.setName('TaroBird Documentation');
app.commandLine.appendSwitch('host-resolver-rules','MAP studio.test 127.0.0.1');
void app.whenReady().then(async () => {
const window = new BrowserWindow({width:1440,height:900,useContentSize:true,frame:false,show:true,webPreferences:{preload:config.preload,contextIsolation:true,nodeIntegration:false,sandbox:true}});
const browser = new WorkbenchBrowser(window,electron,{emit:payload=>window.webContents.send('readme:browser-event',payload),registry:path.join(config.profile,'browser-registry.json'),partitionRoot:path.join(config.profile,'Partitions')});
// Electron captures the renderer and native child surfaces separately. Join
// the unmodified pixels at the actual child bounds, exactly as displayed.
const capture = async () => {
 const base = await window.webContents.capturePage();
 const {width,height} = base.getSize();
 const pixels = base.toBitmap({scaleFactor:1});
 for (const view of window.contentView.children) {
  if (!view.webContents || view.webContents === window.webContents || view.webContents.isDestroyed() || !view.getVisible()) continue;
  const rect = view.getBounds();
  if (rect.width < 1 || rect.height < 1) continue;
  const frame = (await view.webContents.capturePage()).resize({width:rect.width,height:rect.height});
  const data = frame.toBitmap({scaleFactor:1});
  for (let y=0;y<rect.height && rect.y+y<height;y++) {
   if(rect.y+y<0)continue;
   const x=Math.max(0,rect.x), count=Math.min(width,rect.x+rect.width)-x;
   if(count>0)data.copy(pixels,((rect.y+y)*width+x)*4,(y*rect.width+x-rect.x)*4,(y*rect.width+x-rect.x+count)*4);
  }
 }
 return electron.nativeImage.createFromBitmap(pixels,{width,height,scaleFactor:1}).toPNG().toString('base64');
};
globalThis.__readme = {window,browser,capture};
ipcMain.handle('readme:browser',async(event,command,args)=>{
 if(event.sender!==window.webContents || new URL(event.sender.getURL()).origin!==new URL(config.url).origin)throw new Error('untrusted_readme_sender');
 if(BROWSER_COMMANDS.includes(command))return browser.request(command,args,()=>!window.isDestroyed());
 if(command==='desktop_window_read')return {fullscreen:false,fullscreenTransitioning:false};
 return null;
});
await window.loadURL(config.url);
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>browser.dispose());

});
