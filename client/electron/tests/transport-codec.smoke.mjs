// Real sandboxed Electron + pinned Rust transport + native file quarantine.
// Only the save-dialog destination is supplied by the harness. No installed
// App, production Host, model or user file is accessed.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';
import { build } from 'esbuild';
import { buildPreload } from '../../scripts/electron-preload.mjs';
import { electronRuntime } from '../../scripts/electron-runtime.mjs';
import { helperEnvironment } from '../helper-rpc.mjs';
import { isolatedRoot } from '../isolation.mjs';

const [lab, cache, helper, addon] = process.argv.slice(2);
if (process.platform !== 'darwin' || !lab || !cache || !helper || !addon) throw new Error('Mac: explicit isolated lab, cache, helper and addon required');
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const run = await mkdtemp(path.join(await isolatedRoot(lab), 'codec-'));
const assets = path.join(run, 'assets'); await mkdir(assets);
const bundled = await build({ stdin: { contents: `import {hubFetch, hubSocket, recoverDesktopTransport} from './transport.ts'; import {rememberRouteTrust} from './route-trust.ts'; import {encodeDesktopBytes} from './desktop-base64.ts'; import {exportAttachment} from './attachment-export.ts'; window.codecApi={hubFetch,hubSocket,recoverDesktopTransport,rememberRouteTrust,encodeDesktopBytes,exportAttachment};`, resolveDir: path.join(repo, 'client/src'), loader: 'ts' }, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', define: { 'import.meta.env': JSON.stringify({ PROD: false, DEV: false, MODE: 'test' }) } });
await writeFile(path.join(assets, 'codec.mjs'), bundled.outputFiles[0].contents);
await writeFile(path.join(assets, 'index.html'), '<!doctype html><meta charset="utf-8"><script type="module" src="/codec.mjs"></script><textarea aria-label="Draft"></textarea>');
const config = path.join(run, 'config.json');
await writeFile(config, JSON.stringify({ assets, preload: await buildPreload(path.join(run, 'preload')), helper, addon }));
const tls = path.join(run, 'tls'); await mkdir(tls, { mode: 0o700 });
const fixture = spawn(process.execPath, ['--import', 'tsx', 'tests/helpers/native-tls-fixture.ts', tls], { cwd: repo, env: helperEnvironment(), stdio: ['pipe', 'pipe', 'inherit'] });
let app;
const checks = [];
try {
  const info = await new Promise((resolve, reject) => {
    const lines = createInterface({ input: fixture.stdout });
    const timer = setTimeout(() => reject(new Error('fixture_timeout')), 15000);
    const done = () => { clearTimeout(timer); lines.close(); };
    fixture.once('error', e => { done(); reject(e); });
    fixture.once('exit', () => { done(); reject(new Error('fixture_exited')); });
    lines.once('line', line => { done(); try { resolve(JSON.parse(line)); } catch (e) { reject(e); } });
  });
  fixture.stdout.resume();
  const certificateAuthority = (await readFile(path.join(tls, 'ca.der'))).toString('base64');
  app = await _electron.launch({ executablePath: await electronRuntime(cache), args: [fileURLToPath(new URL('./runtime-main.mjs', import.meta.url)), `--tarobot-acceptance=${config}`], env: helperEnvironment() });
  const page = await app.firstWindow(); await page.waitForFunction(() => !!window.codecApi);
  const result = await page.evaluate(async ({ origin, key, certificateAuthority }) => {
    const api = window.codecApi, native = Uint8Array.prototype.toBase64;
    if (typeof native !== 'function') throw new Error('native_encoder_required');
    api.rememberRouteTrust([{ url: origin, certificateAuthority }], key);
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    const rejects = async (job, reason) => { try { await job(); } catch (e) { check(e.message === reason, `wrong error: ${e.message}`); return; } throw new Error('expected rejection'); };
    let calls = 0;
    Uint8Array.prototype.toBase64 = function() { calls++; return native.call(this); };
    try {
      // Real native semantics, every byte value, padding, offsets and fallback.
      for (const length of [0, 1, 2, 3, 255, 256, 257, 16383, 16384, 16385, 1024 * 1024 + 2]) {
        const bytes = Uint8Array.from({ length: length + 11 }, (_, i) => i % 256).subarray(5, length + 5);
        const encoded = api.encodeDesktopBytes(bytes);
        Uint8Array.prototype.toBase64 = undefined;
        const fallback = api.encodeDesktopBytes(bytes);
        Uint8Array.prototype.toBase64 = function() { calls++; return native.call(this); };
        check(encoded === fallback, 'native/fallback mismatch');
      }
      const data = Uint8Array.from({ length: 1030 }, (_, i) => i % 256), view = data.subarray(5, 1028);
      const text = '中文🙂\u0000A';
      const bodies = [[text, new TextEncoder().encode(text)], [new Blob([view]), view], [view.buffer, data], [new DataView(data.buffer, 5, 1023), view], [view, view], [new Uint8Array(), new Uint8Array()]];
      for (const [body, expected] of bodies) {
        const before = calls;
        const response = await api.hubFetch(origin, '/api/echo', key, { method: 'POST', body });
        const actual = new Uint8Array(await response.arrayBuffer());
        check(actual.length === expected.length && actual.every((v, i) => v === expected[i]), 'body mismatch');
        check(calls === before + 1, 'native encoder not used');
      }
      let read = false;
      const oversize = new Blob([new Uint8Array(8 * 1024 * 1024 + 1)]);
      oversize.arrayBuffer = () => { read = true; throw new Error('oversize body read'); };
      const before = calls;
      await rejects(() => api.hubFetch(origin, '/api/echo', key, { method: 'POST', body: oversize }), 'native_body_too_large');
      await rejects(() => api.hubFetch(origin, '/api/echo', key, { method: 'POST', body: new Uint8Array(8 * 1024 * 1024 + 1) }), 'native_body_too_large');
      check(!read && calls === before, 'limit must precede read/encoding');
      const controller = new AbortController(); controller.abort(new Error('cancelled-before-encode'));
      await rejects(() => api.hubFetch(origin, '/api/echo', key, { method: 'POST', body: view, signal: controller.signal }), 'cancelled-before-encode');
      check(calls === before, 'pre-aborted upload encoded');
      const nativeError = new Error('native-encoding-failed');
      Uint8Array.prototype.toBase64 = () => { throw nativeError; };
      await rejects(() => api.hubFetch(origin, '/api/echo', key, { method: 'POST', body: view }), nativeError.message);
      Uint8Array.prototype.toBase64 = native;
      // Rotate the document lease while one upload awaits a Blob read.
      // An old document must never send that POST on the replacement lease.
      let release, entered;
      const reading = new Promise(resolve => { entered = resolve; });
      const delayed = new Blob([view]);
      delayed.arrayBuffer = () => { entered(); return new Promise(resolve => { release = resolve; }); };
      const pending = api.hubFetch(origin, '/api/echo', key, { method: 'POST', body: delayed }).then(() => 'sent', e => e.message);
      await reading;
      document.querySelector('textarea').value = 'unsent draft';
      await api.recoverDesktopTransport(() => window.tarobotDesktop.invoke('desktop_recover'));
      release(view.slice().buffer);
      check(await pending === 'native_document_retired', 'retired upload replayed');
      check(document.querySelector('textarea').value === 'unsent draft', 'recovery lost draft');
      const fresh = await api.hubFetch(origin, '/api/echo', key, { method: 'POST', body: view });
      check(new Uint8Array(await fresh.arrayBuffer()).every((v, i) => v === view[i]), 'fresh lease upload failed');
      const open = async () => {
        const socket = api.hubSocket(origin, key);
        await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('open timeout')), 5000); socket.onopen = () => { clearTimeout(timer); resolve(); }; socket.onerror = e => { clearTimeout(timer); reject(new Error(e.message)); }; });
        return socket;
      };
      const socket = await open();
      await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('close timeout')), 5000); socket.onclose = () => { clearTimeout(timer); resolve(); }; socket.send('$audit:terminate'); });
      const replacement = await open();
      await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('echo timeout')), 5000); replacement.onmessage = e => { clearTimeout(timer); e.data === 'new socket' ? resolve() : reject(new Error('unexpected echo')); }; replacement.send('new socket'); });
      replacement.close();
      return { native: true, bodyKinds: bodies.length, equivalenceCases: 11 };
    } finally { Uint8Array.prototype.toBase64 = native; }
  }, { origin: info.rotating, key: info.key, certificateAuthority });
  checks.push('native-and-fallback-byte-equivalence', 'six-real-pinned-upload-body-kinds', 'body-limits-before-read-and-encoding', 'abort-and-encoding-failure', 'lease-rotation-rejects-old-post-and-preserves-draft', 'socket-disconnect-and-new-socket-echo');
  await page.evaluate(async ({ origin, key }) => {
    const socket = window.codecApi.hubSocket(origin, key);
    window.helperClosed = false;
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('open timeout')), 5000); socket.onopen = () => { clearTimeout(timer); resolve(); }; socket.onerror = e => { clearTimeout(timer); reject(new Error(e.message)); }; });
    socket.onclose = () => { window.helperClosed = true; };
  }, { origin: info.rotating, key: info.key });
  // Fail closed on ownership ambiguity: only the exact helper executable that
  // is a direct child of THIS isolated Electron main may be fault-injected.
  const helperPath = await realpath(helper), mainPid = app.process().pid;
  const children = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match && Number(match[2]) === mainPid && match[3] === helperPath ? [Number(match[1])] : [];
  });
  const beforeKill = children(); assert.equal(beforeKill.length, 1);
  process.kill(beforeKill[0], 'SIGKILL');
  await page.waitForFunction(async () => window.helperClosed && (await window.tarobotDesktop.invoke('desktop_native_state')).failed);
  await page.evaluate(() => window.codecApi.recoverDesktopTransport(() => window.tarobotDesktop.invoke('desktop_recover')));
  const afterKill = children(); assert.equal(afterKill.length, 1); assert.notEqual(afterKill[0], beforeKill[0]);
  assert.equal(await page.evaluate(async ({ origin, key }) => {
    const response = await window.codecApi.hubFetch(origin, '/api/echo', key, { method: 'POST', body: 'after helper crash' });
    return await response.text() === 'after helper crash' && document.querySelector('textarea').value === 'unsent draft';
  }, { origin: info.rotating, key: info.key }), true);
  checks.push('owned-helper-sigkill-recovery-new-pid-and-upload');
  const saved = path.join(run, 'saved.bin');
  await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, saved);
  const expected = Buffer.from(Uint8Array.from({ length: 2 * 1024 * 1024 + 177 }, (_, i) => i % 256));
  const save = await page.evaluate(async () => {
    const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 + 177 }, (_, i) => i % 256);
    const delivered = [];
    const ok = await window.codecApi.exportAttachment(new Blob([bytes]), 'saved.bin', { delivered: (...args) => delivered.push(args) });
    return { ok, delivered };
  });
  assert.equal(save.ok, true); assert.deepEqual(save.delivered, [['saved', saved]]);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(await readFile(saved)), hash(expected));
  assert.match(execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', saved], { encoding: 'utf8' }), /./);
  checks.push('actual-chunked-save-hash-and-quarantine');
  // A runtime failure after obtaining a save grant must discard its temporary
  // sibling and preserve the previous destination.
  const failed = await page.evaluate(async () => {
    const original = Uint8Array.prototype.toBase64, delivered = [];
    Uint8Array.prototype.toBase64 = () => { throw new Error('forced encoding failure'); };
    try { await window.codecApi.exportAttachment(new Blob(['new content']), 'saved.bin', { delivered: value => delivered.push(value) }); return { failed: false }; }
    catch { return { failed: true, delivered }; }
    finally { Uint8Array.prototype.toBase64 = original; }
  });
  assert.deepEqual(failed, { failed: true, delivered: [] });
  assert.equal(hash(await readFile(saved)), hash(expected));
  assert.equal((await readdir(run)).some(name => name.startsWith('.tarobot-save-')), false);
  await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
  assert.equal(await page.evaluate(() => window.codecApi.exportAttachment(new Blob(['cancel']), 'cancel.bin')), false);
  checks.push('failed-save-preserves-destination-and-discards-partial', 'save-dialog-cancellation');
  await writeFile(path.join(run, 'verification.json'), JSON.stringify({ status: 'passed', checks, result, sha256: hash(expected), installedAppChanged: false, productionHostUsed: false }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', run, checks }));
} finally {
  await app?.close(); fixture.stdin.end();
  if (fixture.exitCode === null) { const timer = setTimeout(() => fixture.kill('SIGKILL'), 2000); await new Promise(resolve => fixture.once('exit', resolve)); clearTimeout(timer); }
}
