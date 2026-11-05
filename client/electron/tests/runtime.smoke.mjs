import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { _electron } from '@playwright/test';
import { buildPreload } from '../../scripts/electron-preload.mjs';
import { electronRuntime } from '../../scripts/electron-runtime.mjs';
import { isolatedRoot } from '../isolation.mjs';
import { helperEnvironment } from '../helper-rpc.mjs';

const args = process.argv.slice(2);
if (args.length !== 6 || args[0] !== '--lab' || args[2] !== '--cache-root' || args[4] !== '--helper') throw new Error('usage: runtime.smoke.mjs --lab <.noindex> --cache-root <.noindex> --helper <built helper>');
const root = await isolatedRoot(args[1]);
const run = await mkdtemp(path.join(root, 'runtime-'));
const assets = path.join(run, 'assets'); await mkdir(assets);
await writeFile(path.join(assets, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>TaroBot Electron Acceptance</title><script type="module" src="/startup.mjs"></script></head><body><h1>Desktop bridge acceptance</h1></body></html>');
await writeFile(path.join(assets, 'startup.mjs'), 'window.earlyBridge=window.tarobotDesktop.invoke("net_document").catch(error=>({error:error.message}));');
await writeFile(path.join(assets, 'widget-sandbox.html'), '<!doctype html><html><body>Isolated widget</body></html>');
await writeFile(path.join(assets, 'worker.mjs'), 'self.onmessage=()=>self.postMessage("module-worker-ok");');
const preload = await buildPreload(path.join(run, 'preload'));
const executablePath = await electronRuntime(args[3]);
const config = path.join(run, 'config.json'); await writeFile(config, JSON.stringify({ assets, preload, helper: args[5] }));
const checks = [];
const fixtureRoot = path.join(run, 'tls'); await mkdir(fixtureRoot, { mode: 0o700 });
const fixture = spawn(process.execPath, ['--import', 'tsx', 'tests/helpers/native-tls-fixture.ts', fixtureRoot], {
  cwd: fileURLToPath(new URL('../../../', import.meta.url)), env: helperEnvironment(), stdio: ['pipe', 'pipe', 'inherit'],
});
const fixtureInfo = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { fixture.kill(); reject(new Error('native_tls_fixture_timeout')); }, 15000);
  const lines = createInterface({ input: fixture.stdout });
  const stop = () => { clearTimeout(timer); lines.close(); };
  fixture.once('error', error => { stop(); reject(error); });
  fixture.once('exit', () => { stop(); reject(new Error('native_tls_fixture_exited')); });
  lines.once('line', line => { stop(); try { resolve(JSON.parse(line)); } catch (error) { reject(error); } });
});
fixture.stdout.resume();
const certificateAuthority = (await readFile(path.join(fixtureRoot, 'ca.der'))).toString('base64');
let app;
try {
  app = await _electron.launch({ executablePath, args: [fileURLToPath(new URL('./runtime-main.mjs', import.meta.url)), `--tarobot-acceptance=${config}`], env: helperEnvironment(), timeout: 30000 });
  const window = await app.firstWindow(); await window.waitForLoadState('domcontentloaded');
  const properties = await window.evaluate(() => ({ version: window.tarobotDesktop?.version, engine: window.tarobotDesktop?.engine,
    node: typeof window.require, process: typeof window.process, tauri: typeof window.__TAURI_INTERNALS__ }));
  assert.deepEqual(properties, { version: 1, engine: 'electron', node: 'undefined', process: 'undefined', tauri: 'undefined' }); checks.push('sandboxed-explicit-bridge');
  assert.equal(typeof await window.evaluate(() => window.earlyBridge), 'string'); checks.push('initial-module-document-bootstrap');
  const worker = await window.evaluate(() => new Promise((resolve, reject) => {
    const worker = new Worker('tarobot://app/worker.mjs', { type: 'module' });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('module_worker_timeout')); }, 5000);
    worker.onmessage = event => { clearTimeout(timer); worker.terminate(); resolve(event.data); };
    worker.onerror = () => { clearTimeout(timer); worker.terminate(); reject(new Error('module_worker_failed')); };
    worker.postMessage('test');
  })); assert.equal(worker, 'module-worker-ok'); checks.push('module-worker-mime-and-csp');
  const document = await window.evaluate(() => window.tarobotDesktop.invoke('net_document'));
  assert.equal(typeof document, 'string'); assert.ok(document); checks.push('real-native-helper-handshake');
  const denied = await window.evaluate(async () => {
    try { await window.tarobotDesktop.invoke('helper_info'); return false; } catch (error) { return error.message.includes('unknown_native_command'); }
  }); assert.equal(denied, true); checks.push('main-only-command-denied');
  const slot = await window.evaluate(document => window.tarobotDesktop.invoke('net_allocate', { kind: 'http', document }), document);
  assert.equal(typeof slot, 'string'); await window.evaluate(id => window.tarobotDesktop.invoke('net_cancel', { id }), slot); checks.push('native-slot-allocate-cancel');
  const http = await window.evaluate(async ({ document, origin, hubKey, certificateAuthority }) => {
    const bridge = window.tarobotDesktop;
    const id = await bridge.invoke('net_allocate', { kind: 'http', document });
    const head = await bridge.invoke('net_http_open', { id, input: { origin, hubKey, certificateAuthority, path: '/health', method: 'GET', headers: [], body: null } });
    let body = '';
    for (;;) { const chunk = await bridge.invoke('net_http_read', { id }); if (!chunk.data) break; body += atob(chunk.data); }
    return { status: head.status, body: JSON.parse(body) };
  }, { document, origin: fixtureInfo.hub, hubKey: fixtureInfo.key, certificateAuthority });
  assert.equal(http.status, 200); assert.equal(http.body.publicKey, fixtureInfo.key); checks.push('renderer-ipc-pinned-tls-http-roundtrip');
  const impostor = await window.evaluate(async ({ document, origin, hubKey, certificateAuthority }) => {
    const id = await window.tarobotDesktop.invoke('net_allocate', { kind: 'http', document });
    try { await window.tarobotDesktop.invoke('net_http_open', { id, input: { origin, hubKey, certificateAuthority, path: '/health', method: 'GET', headers: [], body: null } }); return 'accepted'; }
    catch (error) { return error.message; } finally { await window.tarobotDesktop.invoke('net_cancel', { id }); }
  }, { document, origin: fixtureInfo.proxy, hubKey: fixtureInfo.key, certificateAuthority });
  assert.equal(impostor, 'tls_identity_mismatch'); checks.push('renderer-pinned-certificate-rejection');
  const socket = await window.evaluate(async ({ document, origin, hubKey, certificateAuthority }) => {
    window.acceptanceEvents = [];
    const id = await window.tarobotDesktop.invoke('net_allocate', { kind: 'socket', document });
    await window.tarobotDesktop.openSocket({ id, origin, hubKey, certificateAuthority }, event => window.acceptanceEvents.push(event));
    return id;
  }, { document, origin: fixtureInfo.rotating, hubKey: fixtureInfo.key, certificateAuthority });
  await window.waitForFunction(() => window.acceptanceEvents.some(event => event.kind === 'open'));
  await window.evaluate(id => window.tarobotDesktop.invoke('net_socket_send', { id, text: 'Electron 原生连接' }), socket);
  await window.waitForFunction(() => window.acceptanceEvents.some(event => event.kind === 'message'));
  const message = await window.evaluate(() => window.acceptanceEvents.find(event => event.kind === 'message'));
  assert.equal(message.data, 'Electron 原生连接'); assert.equal(message.sequence, 1);
  await window.evaluate(({ id, sequence }) => window.tarobotDesktop.invoke('net_socket_ack', { id, sequence }), { id: socket, sequence: message.sequence });
  await window.evaluate(id => window.tarobotDesktop.invoke('net_socket_close', { id, code: 1000, reason: 'acceptance' }), socket);
  await window.waitForFunction(() => window.acceptanceEvents.some(event => event.kind === 'close'));
  checks.push('renderer-websocket-callback-ack-close');
  await window.evaluate(() => { const frame = document.createElement('iframe'); frame.id = 'isolation-test'; frame.src = 'tarobot-widget://sandbox/widget-sandbox.html'; document.body.append(frame); });
  const widget = window.frame({ url: 'tarobot-widget://sandbox/widget-sandbox.html' }) ?? await new Promise(resolve => window.once('framenavigated', resolve));
  assert.equal(await widget.evaluate(() => typeof window.tarobotDesktop), 'undefined'); checks.push('widget-without-bridge');
  await window.reload(); await window.waitForLoadState('domcontentloaded');
  const freshDocument = await window.evaluate(() => window.earlyBridge);
  assert.equal(typeof freshDocument, 'string');
  assert.notEqual(freshDocument, document); checks.push('reload-retires-helper-document');
  const oldLeaseDenied = await window.evaluate(async document => {
    try { await window.tarobotDesktop.invoke('net_allocate', { kind: 'http', document }); return false; } catch { return true; }
  }, document); assert.equal(oldLeaseDenied, true); checks.push('retired-lease-denied');
  const preferences = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.webSecurity, true); checks.push('native-webpreferences');
  const receipt = { status: 'passed', checks, executablePath, helper: args[5], productionHostUsed: false, installedAppChanged: false, timestamp: new Date().toISOString() };
  await writeFile(path.join(run, 'verification.json'), JSON.stringify(receipt, null, 2) + '\n');
  await writeFile(path.join(root, 'electron-runtime-verification.json'), JSON.stringify({ ...receipt, run }, null, 2) + '\n');
  console.log(JSON.stringify({ status: receipt.status, checks, run }));
} finally {
  if (app) await app.close();
  fixture.stdin.end();
  if (fixture.exitCode === null) {
    const timer = setTimeout(() => fixture.kill('SIGKILL'), 2000);
    await new Promise(resolve => fixture.once('exit', resolve)); clearTimeout(timer);
  }
}
