// Run from the source checkout against an independently installed production directory.
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { integrationAssets } from './integration-assets.mjs';
import { verifyHostLauncher } from './verify-host-launcher.mjs';
const root = path.resolve(process.argv[2] || 'dist/standalone-package');
await verifyHostLauncher(root);
const requirePackage = createRequire(path.join(root, 'package.json'));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (manifest.dependencies?.['@larksuiteoapi/node-sdk'] || manifest.scripts?.postinstall) throw new Error('Unexpected platform install dependency');
try { requirePackage.resolve('@larksuiteoapi/node-sdk'); throw new Error('SDK installed'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
for (const relative of ['src/lark', 'adapters', 'dist/src/lark', 'dist/src/legacy-index.js', 'dist/src/telegram', 'dist/src/commands', 'dist/src/service.js', 'dist/src/runtime/telegram-out.js', 'dist/src/runtime/cron-executor.js', 'dist/src/runtime/cron-runtime.js', 'dist/src/tools/telegram-tool-executor.js', 'dist/src/tools/telegram-tool-registry.js', 'dist/src/tools/telegram-tool-types.js']) {
 if (await access(path.join(root, relative)).then(() => true, () => false)) throw new Error('Legacy transport packaged: '+relative);
}
const helpers = ['dist/src/codex/claude-permission-mcp-server.js', 'dist/src/codex/deepseek-app-plugin.js', 'dist/deepseek-harness-plugin/src/search-mcp-server.js', 'dist/relay-runtime.mjs', 'client/dist/index.html', 'client/dist/widget-sandbox.html'];
for (const relative of helpers) await access(path.join(root, relative));
for (const relative of integrationAssets) await access(path.join(root, relative));
const state = await mkdtemp(path.join(os.tmpdir(), 'tarobot-package-start-'));
const freePort = async () => { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port=server.address().port; await new Promise(resolve=>server.close(resolve)); return port; };
const port = await freePort(), instancePort = await freePort();
const home = path.join(state,'home'); await mkdir(home);
const env = { PATH:process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows','System32') : '/usr/bin:/bin', HOME:home, TMPDIR:os.tmpdir(),
 ...(process.platform === 'win32' ? { SystemRoot:process.env.SystemRoot, WINDIR:process.env.WINDIR, USERPROFILE:home, TEMP:os.tmpdir(), TMP:os.tmpdir() } : {}) };
const entry = path.join(root,'dist/src/index.js');
let identity;
try {
 // Startup deliberately refuses an uninitialized directory. Exercise the
 // public first-install flow instead of bypassing the identity safety gate.
 await promisify(execFile)(process.execPath, [entry,'init','--state-dir',state,'--name','Package validation','--json'], { cwd:root, env, timeout:15000 });
 identity = await readFile(path.join(state,'identity.json'));
 await writeFile(path.join(state, 'config.json'), JSON.stringify({ host:'127.0.0.1', port, instancePort }));
} catch (error) { await rm(state, { recursive:true, force:true }); throw error; }
const child = spawn(process.execPath, [entry, 'hub','run','--state-dir',state], { cwd:root, env, stdio:['ignore','pipe','pipe'] });
const childClosed = once(child, 'close');
let log=''; child.stdout.on('data',data=>log+=data); child.stderr.on('data',data=>log+=data);
let success=false;
try {
 const deadline=Date.now()+15000;
 while (Date.now()<deadline) {
  if (child.exitCode!==null) throw new Error('Hub exited: '+log);
  const response=await fetch(`http://127.0.0.1:${port}/health`).catch(()=>null);
  if (response?.ok) { const health=await response.json(); if(!health.ok)throw new Error('Invalid health response'); success=true; break; }
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 if(!success)throw new Error('Hub startup timed out: '+log);
 const page=await fetch(`http://127.0.0.1:${port}/`); if(!page.ok || !(await page.text()).includes('<html'))throw new Error('Packaged client missing');
 if (!(await readFile(path.join(state,'identity.json'))).equals(identity)) throw new Error('Initialized identity changed during startup');
 console.log(JSON.stringify({ packageRoot:root, sdkInstalled:false, feishuCredentials:false, cliOnPath:false, explicitInitialization:true, identityPreserved:true, hubCliStartup:true, clientAssetsServed:true, helperEntrypoints:helpers, stateDirectory:state },null,2));
} finally {
 // Subscribe before probing: an early startup exit must retain its real error,
 // not leave a never-resolving exit wait that Node masks as status 13.
 if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
 const watchdog=setTimeout(()=>child.kill('SIGKILL'),10000);
 try { await childClosed; } finally { clearTimeout(watchdog); await rm(state, { recursive:true, force:true }); }
}
