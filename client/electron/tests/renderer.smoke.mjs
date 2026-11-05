import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { _electron } from '@playwright/test';
import { build } from '../../../node_modules/esbuild/lib/main.js';
import { buildPreload } from '../../scripts/electron-preload.mjs';
import { electronRuntime } from '../../scripts/electron-runtime.mjs';
import { isolatedRoot } from '../isolation.mjs';
import { helperEnvironment } from '../helper-rpc.mjs';

const args = process.argv.slice(2);
if (![6,8].includes(args.length) || args[0] !== '--lab' || args[2] !== '--cache-root' || args[4] !== '--helper') throw new Error('explicit isolated lab, cache and helper required');
const root = await isolatedRoot(args[1]), run = await mkdtemp(path.join(root, 'renderer-')), assets = path.join(run, 'assets');
await mkdir(assets);
const client = fileURLToPath(new URL('../../', import.meta.url));
await build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';
import{hubFetch,hubSocket}from'./src/transport.ts';import{DesktopRecovery}from'./src/DesktopRecovery.tsx';import{nativePlatform}from'./src/native.ts';import{rememberRouteTrust}from'./src/route-trust.ts';
window.probe={hubFetch,hubSocket,nativePlatform,rememberRouteTrust};
createRoot(document.getElementById('root')).render(<><textarea aria-label="Draft"/><input type="file" aria-label="Attachment" multiple/><DesktopRecovery/></>);`,
 resolveDir: client, loader: 'tsx' }, bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', outfile: path.join(assets, 'probe.js'), target: 'chrome140' });
await writeFile(path.join(assets, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Renderer acceptance</title><link rel="stylesheet" href="/probe.css"><script type="module" src="/probe.js"></script></head><body><div id="root"></div></body></html>');
const preload = await buildPreload(path.join(run, 'preload')), executablePath = await electronRuntime(args[3]);
const config = path.join(run, 'config.json'); await writeFile(config, JSON.stringify({ assets, preload, helper: args[5], ...(args[6] === "--addon" ? { addon: args[7] } : {}) }));
const fixtureRoot = path.join(run, 'tls'); await mkdir(fixtureRoot);
const fixture = spawn(process.execPath, ['--import', 'tsx', 'tests/helpers/native-tls-fixture.ts', fixtureRoot], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), env: helperEnvironment(), stdio: ['pipe', 'pipe', 'inherit'] });
const info = await new Promise((resolve, reject) => {
 const lines = createInterface({ input: fixture.stdout }); const timer = setTimeout(() => reject(new Error('fixture_timeout')),15000);
 fixture.once('error',reject); lines.once('line',line => { clearTimeout(timer);lines.close();resolve(JSON.parse(line)); });
}); fixture.stdout.resume();
const ca = (await readFile(path.join(fixtureRoot,'ca.der'))).toString('base64');
let app; const checks=[];
try {
 app = await _electron.launch({ executablePath, args: [fileURLToPath(new URL('./runtime-main.mjs',import.meta.url)),`--tarobot-acceptance=${config}`], env:helperEnvironment(), timeout:30000 });
 const window = await app.firstWindow(); await window.waitForFunction(() => !!window.probe);
 const errors=[]; window.on('pageerror', e=>errors.push(e.message));
 assert.equal(await window.evaluate(()=>window.probe.nativePlatform()),process.platform==='win32'?'windows':'macos');checks.push('real-frontend-desktop-platform');
 const roundtrip=()=>window.evaluate(async ({info,ca})=>{window.probe.rememberRouteTrust([{url:info.hub,certificateAuthority:ca}],info.key);const response=await window.probe.hubFetch(info.hub,'/health',info.key);return {status:response.status,key:(await response.json()).publicKey};},{info,ca});
 assert.deepEqual(await roundtrip(),{status:200,key:info.key});checks.push('frontend-pinned-fetch-and-chunk-decode');
 // The real native transport reads trust from its ordinary route registry. A
 // separate test bundle exposes only that existing setter, never an unsafe fetch.
 await window.getByRole('textbox',{name:'Draft'}).fill('尚未发送的草稿');
 await window.getByLabel('Attachment').setInputFiles([{name:'pending.txt',mimeType:'text/plain',buffer:Buffer.from('draft attachment')}]);
 await window.evaluate(()=>{window.originalDraft=document.querySelector('textarea');window.originalFile=document.querySelector('input').files[0];});
 await window.waitForTimeout(300);
 const helperPid=execFileSync('/bin/ps',['-axo','pid=,command='],{encoding:'utf8'}).split('\n').find(line=>line.includes(args[5])&&line.includes(path.join(run,'state','native-state')))?.trim().split(/\s+/,1)[0];
 assert.ok(helperPid,'exact isolated helper PID');process.kill(Number(helperPid),'SIGKILL');
 await window.getByRole('alert').waitFor();
 assert.equal(await window.getByRole('textbox',{name:'Draft'}).inputValue(),'尚未发送的草稿');
 await window.getByRole('button',{name:/恢复连接|Reconnect/}).click();
 await window.getByRole('alert').waitFor({state:'detached'});
 assert.deepEqual(await window.evaluate(()=>({same:window.originalDraft===document.querySelector('textarea'),file:window.originalFile===document.querySelector('input').files[0],text:document.querySelector('textarea').value})),{same:true,file:true,text:'尚未发送的草稿'});
 checks.push('actual-helper-crash-recovery-preserves-draft-and-file-objects');
 assert.deepEqual(await roundtrip(),{status:200,key:info.key});checks.push('frontend-pinned-fetch-after-explicit-recovery');
 if(args[6]==='--addon') {
   const permissions=await window.evaluate(async()=>({supported:await window.tarobotDesktop.invoke('desktop_notifications_supported'), permission:await window.tarobotDesktop.invoke('desktop_notification_permission',{request:false}), context:await window.tarobotDesktop.invoke('desktop_notification_context')}));
   assert.equal(permissions.supported,true);assert.ok(['prompt','denied','granted'].includes(permissions.permission));assert.ok(permissions.context);checks.push('real-native-notification-permission-read-without-prompt');
 }
 const state=await window.evaluate(()=>window.tarobotDesktop.invoke('desktop_window_read'));assert.ok(state.width>0&&state.scale>0);checks.push('real-window-geometry');
 const blocked=await window.evaluate(async()=>{try{await window.tarobotDesktop.invoke('desktop_open_url',{url:'file:///etc/passwd'});return false;}catch{return true;}});assert.equal(blocked,true);checks.push('renderer-cannot-open-arbitrary-local-path');
 assert.deepEqual(errors,[]);checks.push('no-renderer-exceptions');
 await writeFile(path.join(run,'verification.json'),JSON.stringify({status:'passed',checks,productionHostUsed:false,installedAppChanged:false},null,2)+'\n');
 console.log(JSON.stringify({status:'passed',checks,run}));
} finally {if(app)await app.close();fixture.stdin.end();fixture.kill();}
