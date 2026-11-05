// Isolated real Electron window + production hook/IPC. No production Host/profile.
// node electron/tests/side-window.smoke.mjs <.noindex Electron binary> <.noindex lab>
import assert from 'node:assert/strict';
import {mkdir,writeFile,chmod} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {_electron} from '@playwright/test';
import {build} from 'esbuild';
import {isolatedRoot} from '../isolation.mjs';
const [binary,output]=process.argv.slice(2);
if(!binary?.includes('.noindex/'))throw Error('isolated Electron required');
const root=await isolatedRoot(output),client=fileURLToPath(new URL('../..',import.meta.url));
const assets=path.join(root,'assets'),preload=path.join(root,'preload.cjs'),helper=path.join(root,'helper.mjs');
await mkdir(assets,{recursive:true});
await build({entryPoints:[path.join(client,'e2e/fixtures/side-window-native.tsx')],bundle:true,format:'esm',platform:'browser',jsx:'automatic',outfile:path.join(assets,'probe.js'),target:'chrome140',loader:{'.woff2':'file','.woff':'file','.ttf':'file','.svg':'file','.png':'file'},logLevel:'silent'});
await writeFile(path.join(assets,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/probe.css"><div id="root"></div><script type="module" src="/probe.js"></script>');
await build({entryPoints:[path.join(client,'electron/preload.mjs')],outfile:preload,bundle:true,format:'cjs',platform:'node',target:'node22',external:['electron'],logLevel:'silent'});
await writeFile(helper,String.raw`#!/usr/bin/env node
let buffer='',documents=0;process.stdin.on('data',chunk=>{buffer+=chunk;for(let i;(i=buffer.indexOf('\n'))>=0;){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line)continue;const {id,command}=JSON.parse(line);process.stdout.write(JSON.stringify({id,result:command==='helper_info'?{protocol:1}:command==='net_document'?'doc-'+(++documents):null})+'\n');}});process.stdin.on('end',()=>process.exit(0));
`);await chmod(helper,0o755);
const config=path.join(root,'config.json');await writeFile(config,JSON.stringify({assets,preload,helper}));
const app=await _electron.launch({executablePath:binary,args:[path.join(client,'electron/tests/browser-runtime-main.mjs'),`--tarobot-browser-acceptance=${config}`]});
const results=[];
try{
 const ui=await app.firstWindow();ui.setDefaultTimeout(15000);ui.on("pageerror",error=>console.error("fixture page:",error.message));await ui.waitForFunction(()=>window.sideAudit&&window.tarobotDesktop);
 const resize=(width,height=700)=>app.evaluate((_e,{width,height})=>globalThis.__acceptance.window.setContentSize(width,height),{width,height});
 const geometry=()=>ui.evaluate(()=>window.sideAudit.geometry());
 const minimum=()=>app.evaluate(()=>globalThis.__acceptance.window.getMinimumSize());
 const recordFrames=()=>ui.evaluate(()=>{
  const frames=[];window.sideFrames={frames,active:true};
  const sample=()=>{if(!window.sideFrames.active)return;frames.push(window.sideAudit.geometry());requestAnimationFrame(sample);};sample();
 });
 const checkFrames=async(surface,phase,before)=>{
  // Wait for paint, not only the native size acknowledgement.
  await ui.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const frames=await ui.evaluate(()=>{window.sideFrames.active=false;return window.sideFrames.frames;});
  assert.ok(frames.length>0);
  assert.ok(frames.every(frame=>Math.abs(frame.main-before.main)<=1),`${surface} ${phase} resized chat: ${JSON.stringify(frames)}`);
  results.push({surface,phase,frames});
 };

 const stable=async(check)=>{for(let i=0;i<80;i++){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw Error('geometry timeout '+JSON.stringify(await geometry()));};
 for(const surface of ['side','workbench']){
  await ui.goto(`tarobot://app/index.html#surface=${surface}`);await ui.reload();await ui.waitForFunction(()=>window.sideAudit);
  await app.evaluate(()=>{const w=globalThis.__acceptance.window;w.setPosition(30,40);w.setContentSize(1000,700);});
  await stable(async()=>(await geometry()).viewport===1000);const before=await geometry(),original=await minimum();
  await recordFrames();
  await ui.getByRole('button',{name:'侧边对话',exact:true}).click();await stable(async()=>(await geometry()).layout==='expanded');
  await checkFrames(surface,'opening',before);
  for(const width of [1580,1320,1460]){
   await recordFrames();
   await resize(width);await stable(async()=>{const g=await geometry();return g.viewport===width&&Math.abs(g.main-before.main)<1&&Math.abs(g.side-(width-1000))<1;});
   await checkFrames(surface,`resize-${width}`,before);
   results.push({surface,width,...await geometry()});
  }
  assert.ok((await minimum())[0]>=1320,'native minimum protects base chat and usable side');
  await resize(1100);await stable(async()=>{const g=await geometry();return g.viewport>=1320&&Math.abs(g.main-before.main)<1;});
  await recordFrames();
  await ui.getByRole('button',{name:'关闭侧边',exact:true}).click();await stable(async()=>(await geometry()).viewport===1000);
  await checkFrames(surface,'closing',before);
  assert.deepEqual(await minimum(),original,'closing restores previous minimum');
  results.push({surface,closed:true,...await geometry()});
  for(let cycle=0;cycle<3;cycle++){
   await recordFrames();
   await ui.getByRole('button',{name:'侧边对话',exact:true}).click();await stable(async()=>(await geometry()).layout==='expanded');
   await ui.getByRole('button',{name:'关闭侧边',exact:true}).click();await stable(async()=>(await geometry()).viewport===1000);
   await checkFrames(surface,`repeat-${cycle}`,before);
  }
 }
 // Renderer retirement must not leave the window stuck at the temporary minimum.
 await ui.getByRole('button',{name:'侧边对话',exact:true}).click();await stable(async()=>(await geometry()).layout==='expanded');
 await ui.reload();await ui.waitForFunction(()=>window.sideAudit);assert.deepEqual(await minimum(),[600,480]);
 await writeFile(path.join(root,'verification.json'),JSON.stringify({passed:true,results,retirementMinimum:await minimum(),boundary:'Real Electron window/IPC and production hook; fixture content, no production Host. Native size API emulates edge-resize bounds; no claim of manual OS pointer drag.'},null,2));
 console.log('PASS real Electron right-edge allocation, minimum enforcement, close restore and document retirement');
}finally{await app.close();}
