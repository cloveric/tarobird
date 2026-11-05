import { app, BrowserWindow, MessageChannelMain, ipcMain } from 'electron';
import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { ScreenViewers } from '../../screen-viewer.mjs';
import { readScreenFrame } from '../../../../src/client-protocol/screen-wire.ts';
async function run() {
const root = process.argv.at(-1); app.setPath('userData', path.join(root, 'profile'));
const quality=process.env.TAROBOT_SCREEN_SMOKE_QUALITY==='sharp'?'sharp':'balanced';
const display = { id:'d',nativeId:'1',name:'Synthetic',revision:1,x:0,y:0,width:640,height:360,scale:1,rotation:0 };
const join = {...(quality==='sharp'?{quality}:{}),session:{id:'synthetic_viewer',desktopId:'synthetic_desktop',deviceId:'isolated',deviceName:'Smoke',generation:'synthetic_generation',display,controlAllowed:false,state:'viewing',createdAt:Date.now()},controlTicket:'c'.repeat(43),mediaTicket:'m'.repeat(43),expiresAt:Date.now()+30000,serverTime:Date.now()};
let control, media, source, viewers, sourcePackets=0, started=false, captureProbeRequests=0, captureProbeGesture, ticks=0, maxGap=0, last=performance.now();
const records=new Map();
const heartbeat=setInterval(()=>{const n=performance.now();maxGap=Math.max(maxGap,n-last);last=n;ticks++;},20);
const server=http.createServer(async(req,res)=>{if(req.url==='/renderer.js'){res.setHeader('Content-Type','application/javascript');res.end(await readFile(path.join(root,'renderer.js')));}else res.end('<!doctype html><meta charset="utf-8"><canvas id="view" width="320" height="180"></canvas><script src="/renderer.js"></script>');});
const sockets=new WebSocketServer({noServer:true,maxPayload:1024*1024});
const maybeStart=()=>{if(!started&&source&&control&&media){started=true;source.postMessage({type:'start'});}};
server.on('upgrade',(req,socket,head)=>sockets.handleUpgrade(req,socket,head,ws=>{
 const role=req.url?.split('/').at(-1);let attached=false;
 ws.on('message',(raw,binary)=>{if(binary)throw new Error('unexpected_viewer_binary');const v=JSON.parse(raw.toString());
  if(!attached){if(v.type!=='hello'||v.ticket!==(role==='media'?join.mediaTicket:join.controlTicket))throw new Error('bad_ticket');attached=true;if(role==='media')media=ws;else control=ws;ws.send(JSON.stringify({type:'attached',sessionId:join.session.id}));maybeStart();return;}
  if(v.type==='ack'){const record=records.get(v.frameSequence);if(!record)throw new Error('ack_without_sent_frame');records.delete(v.frameSequence);control.send(JSON.stringify({type:'frame-ready',sessionId:join.session.id,generation:join.session.generation,streamGeneration:1,frameSequence:v.frameSequence,expiresAt:record.captureMs+2000}));source.postMessage({type:'credit',sequence:v.frameSequence});}
  if(v.type==='input')throw new Error('no_native_input_in_smoke');
 });
}));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
await app.whenReady();app.dock?.hide();
const window=new BrowserWindow({show:false,width:800,height:500,webPreferences:{preload:path.join(root,'preload.cjs'),contextIsolation:true,sandbox:true,backgroundThrottling:false}});
// Probe permission routing only. Never grant a desktop source or start capture.
window.webContents.session.setDisplayMediaRequestHandler((request,callback)=>{captureProbeRequests++;captureProbeGesture=request.userGesture;callback(null);});
window.webContents.session.setPermissionRequestHandler((_contents,permission,callback)=>callback(permission==='display-capture'));
// This viewing fixture needs a foreground paintable window. On macOS an
// inactive window can decode frames but suspend the rAF that returns credits.
// Focus only this synthetic window; no desktop capture or native input is used.
window.show(); app.focus({ steal: true }); window.focus();
viewers=new ScreenViewers(window,{MessageChannelMain});
ipcMain.handle('screen-smoke',async(event,command,args)=>{
 if(event.sender!==window.webContents)throw new Error('wrong_document');
 if(command==='probe-result'){console.log(JSON.stringify({captureProbeRequests,captureProbeGesture,...args}));return{captureProbeRequests,captureProbeGesture};}
 if(command==='setup')return{join,quality,network:{url:`http://127.0.0.1:${server.address().port}`,publicKey:'a'.repeat(59)+'='}};
 if(command==='screen_viewer_open')return viewers.open(args,()=>true);
 if(command==='screen_viewer_close'){viewers.close(args.sessionId);return null;}
 if(command==='result'){
  viewers.retire();const passed=args.decoded>=40&&sourcePackets>=40&&ticks>=50&&maxGap<2000&&args.copyPreserved&&args.pixelVerified&&args.canvasResizes===2&&args.stateChanges<=5;
  await writeFile(path.join(root,'verification.json'),JSON.stringify({passed,quality,...args,sourcePackets,captureProbeRequests,captureProbeGesture,mainHeartbeatTicks:ticks,mainHeartbeatMaxMs:maxGap,scope:'Actual Electron MessagePortMain copy in both directions, production ScreenViewers and RemoteScreenViewer, loopback WebSocket and WebCodecs; synthetic pixels only. No capture or native input.'},null,2));
  setTimeout(()=>app.exit(passed?0:1),100);return null;
 }
 if(command==='failure'){console.error(args);app.exit(1);return null;}
 throw new Error('unknown_command');
});
window.webContents.once('did-finish-load',()=>{const channel=new MessageChannelMain();source=channel.port1;source.on('message',({data})=>{
 if(data instanceof ArrayBuffer){const frame=readScreenFrame(new Uint8Array(data));records.set(frame.sequence,frame);sourcePackets++;if(media?.readyState===WebSocket.OPEN)media.send(Buffer.from(data));}
 else if(data.type==='stream'){media.send(JSON.stringify(data));control.send(JSON.stringify({type:'state',session:join.session,serverTime:Date.now(),streamGeneration:1}));}
});source.start();window.webContents.postMessage('screen-smoke-source',{},[channel.port2]);maybeStart();});
await window.loadURL(`http://127.0.0.1:${server.address().port}`);
app.on('before-quit',()=>{clearInterval(heartbeat);viewers.retire();source?.close();sockets.close();server.close();});

}
void run().catch(error=>{console.error(error);app.exit(1);});
