// Isolated Design acceptance only. Never opens the installed App or real Host.
import { app, BrowserWindow, net, protocol, session } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMES, assetHandler } from '../assets.mjs';
import { secureContents, secureSession, secureWebPreferences } from '../security.mjs';
import { isolatedRoot } from '../isolation.mjs';
import { prepareDesignQuit, cancelDesignQuit } from '../design-quit.mjs';
globalThis.designQuitTest = { prepareDesignQuit, cancelDesignQuit };
protocol.registerSchemesAsPrivileged(SCHEMES);app.enableSandbox();
const flag=process.argv.find(arg=>arg.startsWith('--design-acceptance='));if(!flag)throw Error('acceptance_config_required');
const config=JSON.parse(await readFile(flag.slice('--design-acceptance='.length),'utf8'));
await isolatedRoot(config.root);app.setPath('userData',path.join(config.root,'profile'));app.setPath('sessionData',path.join(config.root,'cache'));app.setName('TaroBot Design Acceptance');
void app.whenReady().then(async()=>{
 let owned;
 const ses=session.fromPartition('design-acceptance');
 globalThis.designPermissionEvents=[];
 const setRequest=ses.setPermissionRequestHandler.bind(ses);
 ses.setPermissionRequestHandler=handler=>setRequest((contents,permission,callback,details)=>{
  handler(contents,permission,allowed=>{
   globalThis.designPermissionEvents.push({permission,url:details.requestingUrl,allowed});
   callback(allowed);
  },details);
 });
 secureSession(ses,{owns:contents=>contents===owned});
 ses.protocol.handle('tarobot',assetHandler(config.assets,url=>net.fetch(url)));
 ses.protocol.handle('tarobot-widget',assetHandler(config.assets,url=>net.fetch(url),{widget:true}));
 const win=new BrowserWindow({show:config.show===true,width:1100,height:760,webPreferences:secureWebPreferences(config.preload,ses)});
 globalThis.designFullscreenEvents=[];
 for(const event of ['enter-full-screen','leave-full-screen'])win.on(event,()=>globalThis.designFullscreenEvents.push(event));
 owned=win.webContents;secureContents(win.webContents);
 await win.loadURL('tarobot://app/index.html');
}).catch(error=>{console.error(error);app.exit(1);});
app.on('window-all-closed',()=>app.quit());
