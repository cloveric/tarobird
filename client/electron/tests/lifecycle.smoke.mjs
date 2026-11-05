// POSIX process-ownership acceptance: a real helper and fake local CLI/daemon.
// No installed App, production runtime, service manager or Host is used.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeHelper } from '../helper-rpc.mjs';
import { isolatedRoot, developmentPaths } from '../isolation.mjs';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--lab' || args[2] !== '--helper') throw new Error('usage: lifecycle.smoke.mjs --lab <.noindex> --helper <built helper>');
if (process.platform === 'win32') throw new Error('windows_process_ownership_acceptance_required');
const root = await isolatedRoot(args[1]);
const run = await mkdtemp(path.join(root, 'lifecycle-'));
const checks = [];
const live = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(predicate, label, timeout = 5000) {
  const limit = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() > limit) throw new Error(`${label}_timeout`); await delay(20); }
}
async function readPid(file) { try { return Number(await readFile(file, 'utf8')); } catch { return undefined; } }
async function scenario(name, workMs, shutdownMs, crash = false) {
  const paths = await developmentPaths(path.join(run, name));
  await mkdir(path.join(paths.resourcesDir, 'dist/src'), { recursive: true });
  await symlink(process.execPath, path.join(paths.resourcesDir, 'node'));
  await writeFile(path.join(paths.resourcesDir, 'dist/src/index.js'), `
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
if (process.argv[2] === '--fake-detached-hub') { setInterval(() => {}, 1000); }
else {
  const hub = spawn(process.execPath, [__filename, '--fake-detached-hub'], { detached: true, stdio: 'ignore' }); hub.unref();
  fs.writeFileSync(path.join(process.cwd(), 'hub.pid'), String(hub.pid));
  fs.writeFileSync(path.join(process.cwd(), 'cli.pid'), String(process.pid));
  process.stdin.resume();
  setTimeout(() => { fs.writeFileSync(path.join(process.cwd(), 'completed'), 'yes'); console.log(JSON.stringify({ available: true, running: false })); }, ${workMs});
}
`);
  const helper = new NativeHelper({ ...paths, executable: args[3], keyringService: 'com.tarobot.client.device.test-lifecycle' }, {
    shutdownMs: 100, hostShutdownMs: shutdownMs,
    // Capture only the process this test itself starts, for the crash scenario.
    ...(crash ? { spawnProcess: (...values) => {
      const child = processSpawner(...values); helperPid = child.pid; return child;
    } } : {}),
  });
  let cli, hub;
  try {
    await helper.ready();
    const pending = helper.call('desktop_host', { action: 'resume' });
    const rejected = assert.rejects(pending, /native_document_retired|native_helper_exited/);
    await until(async () => { cli = await readPid(path.join(paths.resourcesDir, 'cli.pid')); hub = await readPid(path.join(paths.resourcesDir, 'hub.pid')); return cli && hub; }, 'fake_cli_start');
    if (crash) process.kill(helperPid, 'SIGKILL'); else helper.close();
    await rejected;
    await until(() => !live(cli), 'control_cli_exit');
    assert.equal(live(hub), true, 'detached fixture daemon must survive helper/control cleanup');
    const completed = await readFile(path.join(paths.resourcesDir, 'completed'), 'utf8').catch(() => '');
    assert.equal(completed === 'yes', name === 'graceful');
    checks.push(name);
  } finally {
    helper.close();
    for (const pid of [cli, hub]) if (pid && live(pid)) process.kill(pid, 'SIGKILL');
  }
}
// Main's spawn is injected only for capturing the crash-test helper PID.
const { spawn: processSpawner } = await import('node:child_process');
let helperPid;
await scenario('graceful', 350, 2000);
await scenario('forced-group', 5000, 100);
await scenario('helper-crash', 5000, 2000, true);
const receipt = { status: 'passed', checks, productionHostUsed: false, run, timestamp: new Date().toISOString() };
await writeFile(path.join(root, 'electron-lifecycle-verification.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
