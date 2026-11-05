import { test, expect } from '@playwright/test';
import { createServer } from './fixtures/vite.js';
import { microphone } from './fixtures/microphone.js';
import type { ViteDevServer } from 'vite';

// Native MediaRecorder encoding, synthetic microphone, actual draft hook/IDB.
// Hold only delivery of the final stop callback to make navigation deterministic.
const html = `<!doctype html><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {useVoiceRecorder} from '/src/useVoiceRecorder.ts';
import {useConversationDrafts} from '/src/conversation-drafts.ts';
import {ClientCache} from '/src/storage.ts';
const f=window.voiceDraftFixture={hosts:{}};
for(const id of ['hostA','hostB']){const identity={deviceId:id,hubPublicKey:id,publicKey:id,name:id,routes:[]};const cache=new ClientCache('voice-'+id);await cache.initializeIdentity(identity);f.hosts[id]={identity,cache};}
function Host({id,visible}){const [chat,select]=React.useState('A'),[error,setError]=React.useState('');const h=f.hosts[id];const draft=useConversationDrafts(chat,h.cache,h.identity);const voice=useVoiceRecorder(chat,file=>draft.setFiles(old=>[...old,file]),setError);Object.assign(h,{draft,voice,select});React.useEffect(()=>{if(!visible){if(voice.phase==='requesting')voice.cancel();else if(voice.phase==='recording')voice.finish();}},[visible,voice.phase]);return React.createElement('section',{id,hidden:!visible},React.createElement('button',{onClick:voice.start},'record'),React.createElement('output',null,JSON.stringify({chat,phase:voice.phase,files:draft.files.length,saving:draft.saving,error:draft.error||error})));}
function App(){const [active,activate]=React.useState('hostA');f.activate=activate;return ['hostA','hostB'].map(id=>React.createElement(Host,{key:id,id,visible:id===active}));}createRoot(document.getElementById('root')).render(React.createElement(App));
</script>`;
let server: ViteDevServer, url: string;
test.beforeAll(async()=>{server=await createServer({plugins:[{name:'voice-draft-fixture',configureServer(vite){vite.middlewares.use(async(req,res,next)=>{if(req.url!=='/__voice-draft')return next();res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/__voice-draft',html));});}}],server:{port:0,host:'127.0.0.1'}});await server.listen();url=server.resolvedUrls!.local[0]+'__voice-draft';});
test.afterAll(async()=>{await server.close();});
test.beforeEach(async({page})=>{await microphone(page);await page.goto(url);await expect(page.locator('#hostA output')).toContainText('"phase":"idle"');});
async function recordAndHold(page: import('@playwright/test').Page){
  await page.locator('#hostA button').click();await expect(page.locator('#hostA output')).toContainText('"phase":"recording"');
  await page.waitForTimeout(1100);
  await page.evaluate(()=>{const recorder=(window as any).__mic.recorder as MediaRecorder;const stopped=recorder.onstop!;recorder.onstop=event=>{(window as any).releaseVoice=()=>stopped.call(recorder,event);};});
}
async function release(page: import('@playwright/test').Page){await page.waitForFunction(()=>typeof(window as any).releaseVoice==='function');await page.evaluate(()=>(window as any).releaseVoice());}

test('finished recording survives switching chats before encoder stop delivery and restores only to its origin',async({page})=>{
  await recordAndHold(page);
  await page.evaluate(()=>{const h=(window as any).voiceDraftFixture.hosts.hostA;h.voice.finish();h.select('B');});
  await expect(page.locator('#hostA output')).toContainText('"chat":"B"');await release(page);
  await expect(page.locator('#hostA output')).toContainText('"files":0');
  await page.evaluate(()=>(window as any).voiceDraftFixture.hosts.hostA.select('A'));
  await expect(page.locator('#hostA output')).toContainText('"files":1');await expect(page.locator('#hostA output')).toContainText('"saving":false');
  const result=await page.evaluate(async()=>{const h=(window as any).voiceDraftFixture.hosts.hostA;const file=(await h.cache.conversationDraft('A',h.identity)).draft.files[0];return {size:file.size,type:file.type,other:(await h.cache.conversationDraft('B',h.identity)).draft.files.length};});
  expect(result.size).toBeGreaterThan(1000);expect(result.type).toMatch(/^audio\//);expect(result.other).toBe(0);
  await page.reload();await expect(page.locator('#hostA output')).toContainText('"files":1');
});

test('host hiding finishes into the original host and cannot reset a new recording in the other chat',async({page})=>{
  await recordAndHold(page);await page.evaluate(()=>(window as any).voiceDraftFixture.activate('hostB'));
  await page.waitForFunction(()=>typeof(window as any).releaseVoice==='function');
  await page.locator('#hostB button').click();await expect(page.locator('#hostB output')).toContainText('"phase":"recording"');await release(page);
  await expect(page.locator('#hostB output')).toContainText('"phase":"recording"');await expect(page.locator('#hostB output')).toContainText('"files":0');
  await page.evaluate(()=>(window as any).voiceDraftFixture.hosts.hostB.voice.cancel());
  await page.evaluate(()=>(window as any).voiceDraftFixture.activate('hostA'));
  await expect(page.locator('#hostA output')).toContainText('"files":1');
});

test('explicit cancel after finish still discards the held result',async({page})=>{
  await recordAndHold(page);await page.evaluate(()=>{const h=(window as any).voiceDraftFixture.hosts.hostA;h.voice.finish();h.voice.cancel();h.select('B');});await release(page);
  await page.evaluate(()=>(window as any).voiceDraftFixture.hosts.hostA.select('A'));await expect(page.locator('#hostA output')).toContainText('"files":0');
});

test('a persistence failure keeps the finished audio in its origin for retry',async({page})=>{
  await recordAndHold(page);await page.evaluate(()=>{const h=(window as any).voiceDraftFixture.hosts.hostA;const original=h.cache.saveConversationDraft.bind(h.cache);let fail=true;h.cache.saveConversationDraft=async(...args:any[])=>{if(fail){fail=false;throw Error('draft_capacity_exceeded');}return original(...args);};h.voice.finish();h.select('B');});await release(page);
  await page.evaluate(()=>(window as any).voiceDraftFixture.hosts.hostA.select('A'));
  await expect(page.locator('#hostA output')).toContainText('draft_capacity_exceeded');await expect(page.locator('#hostA output')).toContainText('"files":1');
  await page.evaluate(()=>(window as any).voiceDraftFixture.hosts.hostA.draft.retry());await expect(page.locator('#hostA output')).not.toContainText('draft_capacity_exceeded');await expect(page.locator('#hostA output')).toContainText('"saving":false');
  await page.reload();await expect(page.locator('#hostA output')).toContainText('"files":1');
});

test('an old completion does not finish or cancel a newer recording in the same workspace',async({page})=>{
  await recordAndHold(page);await page.evaluate(()=>{const h=(window as any).voiceDraftFixture.hosts.hostA;h.voice.finish();h.select('B');});
  await expect(page.locator('#hostA output')).toContainText('"chat":"B"');await page.waitForFunction(()=>typeof(window as any).releaseVoice==='function');
  await page.locator('#hostA button').click();await expect(page.locator('#hostA output')).toContainText('"phase":"recording"');
  await release(page);await release(page); // duplicate delivery must also be harmless
  await expect(page.locator('#hostA output')).toContainText('"phase":"recording"');await expect(page.locator('#hostA output')).toContainText('"files":0');
  await page.evaluate(()=>{const h=(window as any).voiceDraftFixture.hosts.hostA;h.voice.cancel();h.select('A');});await expect(page.locator('#hostA output')).toContainText('"files":1');
});

test('switching without finish still discards recording and retires a pending microphone permission',async({page})=>{
  await recordAndHold(page);await page.evaluate(()=>(window as any).voiceDraftFixture.hosts.hostA.select('B'));await release(page);
  await page.evaluate(()=>{(window as any).__mic.mode='pending';});await page.locator('#hostA button').click();await expect(page.locator('#hostA output')).toContainText('"phase":"requesting"');
  await page.evaluate(()=>(window as any).voiceDraftFixture.hosts.hostA.select('A'));await page.evaluate(()=>(window as any).__mic.resolve());
  await expect.poll(()=>page.evaluate(()=>(window as any).__mic.streams.every((stream:MediaStream)=>stream.getTracks().every(track=>track.readyState==='ended')))).toBe(true);
  await expect(page.locator('#hostA output')).toContainText('"files":0');await expect(page.locator('#hostA output')).toContainText('"phase":"idle"');
});
