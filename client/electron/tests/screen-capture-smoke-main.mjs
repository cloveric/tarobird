// Electron main for screen-capture.smoke.mjs (bundled into an isolated lab app).
import * as electron from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { SCHEMES } from '../assets.mjs';
import { ScreenCaptureHost } from '../screen-capture-host.mjs';
import { readScreenFrame } from '../../../src/client-protocol/screen-wire.ts';

const { app, BrowserWindow, MessageChannelMain, protocol, session } = electron;
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
protocol.registerSchemesAsPrivileged(SCHEMES);
app.setPath('userData', arg('smoke-profile'));
app.dock?.hide();
const here = path.dirname(new URL(import.meta.url).pathname);
const report = { failures: [], frames: [], streams: [], decoded: 0, decodeErrors: [], mainGapMaxMs: 0, events: [] };
const fail = text => { if (!report.failures.includes(text)) report.failures.push(text); };
const finish = () => { writeFileSync(arg('smoke-result'), JSON.stringify(report)); app.exit(0); };
setTimeout(() => { fail('timeout'); finish(); }, 45000);
let last = performance.now(), streaming = false;
setInterval(() => { const now = performance.now(); if (streaming) report.mainGapMaxMs = Math.max(report.mainGapMaxMs, Math.round(now - last - 50)); last = now; }, 50);
const wait = ms => new Promise(r => setTimeout(r, ms));

const SYNTHETIC = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff;font:13px Menlo">
<canvas id="c" width="1280" height="720"></canvas><script>
const c=document.getElementById('c'),x=c.getContext('2d');let t=0;
setInterval(()=>{t++;x.fillStyle='#2d4a6b';x.fillRect(0,0,1280,720);x.fillStyle='#fff';x.fillRect(40,40,700,600);x.fillStyle='#111';
for(let i=0;i<34;i++)x.fillText((i+t)+'  remote screen readable text 中文 '+i,52,64+i*17);x.fillStyle='#c0392b';x.fillRect(1060,4,210,20);
x.fillStyle='#fff';x.fillText('sharing '+Math.floor(t/15),1070,18);},66);</script>`;
const VIEWER = `<!doctype html><meta charset="utf-8"><script>
addEventListener('message',e=>{if(e.data!=='viewer-port')return;const port=e.ports[0];let d,gen=0;
port.onmessage=({data})=>{const v=new DataView(data.buffer,data.byteOffset,data.byteLength);const key=v.getUint8(1)===1,g=v.getUint32(12,true),seq=v.getUint32(4,true);
 if(!d||g!==gen){d&&d.state!=='closed'&&d.close();gen=g;d=new VideoDecoder({output:f=>{f.close();port.postMessage({decoded:seq})},error:x=>port.postMessage({error:x.message})});
 d.configure({codec:'avc1.640028',optimizeForLatency:true,hardwareAcceleration:'no-preference'});}
 d.decode(new EncodedVideoChunk({type:key?'key':'delta',timestamp:seq,data:data.subarray(32)}));};});</script>`;

app.whenReady().then(async () => {
  const synthetic = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { sandbox: true, backgroundThrottling: false } });
  await synthetic.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SYNTHETIC)}`);
  // WebCodecs needs a secure context: serve the decoder page from a secure scheme in its own session.
  const viewerSession = session.fromPartition('smoke-viewer');
  viewerSession.protocol.handle('tarobot-screen', () => new Response(VIEWER, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  const viewer = new BrowserWindow({ show: false, webPreferences: { session: viewerSession, sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: path.join(here, 'viewer-preload.cjs') } });
  viewer.webContents.on('console-message', e => report.events.push({ viewer: String(e.message ?? '').slice(0, 160) }));
  await viewer.loadURL('tarobot-screen://viewer/viewer.html');
  const channel = new MessageChannelMain(); channel.port1.start();
  channel.port1.on('message', ({ data }) => { if (data.decoded) report.decoded++; if (data.error) report.decodeErrors.push(data.error); });
  viewer.webContents.postMessage('viewer-port', null, [channel.port2]);

  const host = new ScreenCaptureHost({ electron, root: path.join(here, 'screen-capture'), preload: path.join(here, 'screen-capture-preload.cjs'),
    resolveSource: async () => synthetic.webContents.mainFrame,
    onGone: (sessions, reason) => { report.events.push({ gone: reason, sessions }); },
    onMessage: message => {
      if (message.type === 'stream') report.streams.push(message.stream);
      else if (message.type === 'started') report.events.push({ started: message.cursor });
      else if (message.type === 'ended') report.events.push({ ended: message.reason, detail: message.detail });
      else if (message.type === 'frame') {
        let header; try { header = readScreenFrame(message.bytes); } catch (error) { fail(`bad_frame:${error.message}`); return; }
        report.frames.push({ sequence: header.sequence, generation: header.streamGeneration, key: header.key, age: Date.now() - header.captureMs, integer: Number.isInteger(header.captureMs), bytes: message.bytes.byteLength });
        channel.port1.postMessage(message.bytes);
        // Act as the confirmed decoder ACK: free the credit.
        host.credit('s1', header.sequence, header.streamGeneration);
      }
    } });
  try {
    await host.start({ sessionId: 's1', display: { id: 'synthetic', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 1280, height: 720 } });
    streaming = true;
    await wait(3000);
    host.reset('s1', 2, 1); await wait(2000);
    host.pause('s1', true, 2); const pausedAt = report.frames.length; await wait(1000);
    if (report.frames.length > pausedAt + 1) fail('frames_while_paused');
    host.pause('s1', false, 3); await wait(2000);
    streaming = false;
    host.stop('s1'); await wait(1600);
    if (host.active) fail('capture_window_not_released');
  } catch (error) { fail(`host:${error.message}`); }
  const byGeneration = g => report.frames.filter(f => f.generation === g);
  for (const g of [1, 2, 3]) {
    const list = byGeneration(g);
    if (!list.length) fail(`no_frames_generation_${g}`);
    else if (!list[0].key) fail(`generation_${g}_not_key_first`);
  }
  if (report.frames.some((f, i, all) => i && f.sequence <= all[i - 1].sequence)) fail('sequence_not_increasing');
  if (!report.frames.every(f => f.integer && f.age >= 0 && f.age < 2000)) fail('capture_time_invalid');
  if (report.streams.map(s => s.streamGeneration).join() !== '1,2,3') fail('stream_messages');
  await wait(300);
  if (report.decodeErrors.length) fail('decode_errors');
  if (report.decoded < report.frames.length - 2) fail('not_all_decoded');
  report.summary = { frames: report.frames.length, decoded: report.decoded, keys: report.frames.filter(f => f.key).length,
    ageP95: report.frames.map(f => f.age).sort((a, b) => a - b)[Math.floor(report.frames.length * 0.95)] ?? null, maxBytes: Math.max(0, ...report.frames.map(f => f.bytes)) };
  report.frames = report.frames.slice(0, 5);
  finish();
});
