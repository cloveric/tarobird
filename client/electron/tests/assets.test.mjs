import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assetPath, assetHandler, APP_CSP } from '../assets.mjs';
import { developmentPaths, isolatedRoot } from '../isolation.mjs';
import { internalResource, secureContents, secureSession, secureWebPreferences } from '../security.mjs';
import { EventEmitter } from 'node:events';

async function fixture(t) {
  const parent = path.join(tmpdir(), 'tarobot-electron-tests.noindex'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'dist')); await writeFile(path.join(root, 'dist/index.html'), 'app');
  await writeFile(path.join(root, 'dist/widget-sandbox.html'), 'widget');
  await writeFile(path.join(root, 'dist/design-loader.html'), 'trusted design trampoline');
  await writeFile(path.join(root, 'outside.txt'), 'outside');
  return { root, dist: path.join(root, 'dist') };
}
test('asset serving confines physical paths and gives Widget a separate origin', async t => {
  const { root, dist } = await fixture(t);
  assert.equal(await assetPath(dist, 'tarobot://app/index.html'), await realpath(path.join(dist, 'index.html')));
  assert.equal(await assetPath(dist, 'tarobot-widget://sandbox/widget-sandbox.html', { widget: true }), await realpath(path.join(dist, 'widget-sandbox.html')));
  await symlink(path.join(root, 'outside.txt'), path.join(dist, 'linked.txt'));
  await symlink(path.join(dist, 'widget-sandbox.html'), path.join(dist, 'widget-alias.html'));
  for (const url of ['tarobot://app/linked.txt', 'tarobot://app/%2e%2e%2foutside.txt', 'tarobot://app/%5c..%5coutside.txt', 'tarobot://app/%00', 'tarobot://app/.env', 'tarobot://app/widget-sandbox.html', 'tarobot://app/WIDGET-SANDBOX.HTML', 'tarobot://app/widget-alias.html', 'tarobot://user@app/index.html', 'tarobot://app:90/index.html']) await assert.rejects(assetPath(dist, url), undefined, url);
  await assert.rejects(assetPath(dist, 'tarobot-widget://sandbox/index.html', { widget: true }));
});
test('static handler sets CSP/nosniff and denies untrusted initiators and writes', async t => {
  const { dist } = await fixture(t); let reads = 0;
  const handler = assetHandler(dist, async () => { reads++; return new Response('app'); });
  const input = { url: 'tarobot://app/index.html', method: 'GET' };
  const response = await handler(input);
  assert.equal(await response.text(), 'app'); assert.equal(response.headers.get('Content-Security-Policy'), APP_CSP);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal((await handler({ ...input, initiatorOrigin: 'https://evil.example' })).status, 403);
  assert.equal((await handler({ ...input, method: 'POST' })).status, 405); assert.equal(reads, 1);
});
test('module workers use JavaScript MIME under nosniff', async t => {
  const { dist } = await fixture(t); await writeFile(path.join(dist, 'pdf.worker.mjs'), 'self.onmessage=()=>{};');
  const handler = assetHandler(dist, async () => new Response('worker'));
  const response = await handler({ method: 'GET', url: 'tarobot://app/pdf.worker.mjs' });
  assert.equal(response.headers.get('Content-Type'), 'text/javascript; charset=utf-8');
});
test('development state requires a physical .noindex ancestor and refuses redirected child directories before writing below them', async t => {
  const { root } = await fixture(t); const paths = await developmentPaths(path.join(root, 'lab'));
  assert.ok(paths.stateDir.startsWith(await realpath(root))); assert.notEqual(paths.profile, paths.hostStateDir);
  // The caller may itself put TMPDIR under .noindex. Find an indexed ancestor
  // for this negative case, and remove this exact small fixture after the test.
  let indexedParent = await realpath(tmpdir());
  while (indexedParent.split(path.sep).some(part => part.endsWith('.noindex'))) indexedParent = path.dirname(indexedParent);
  const outside = await mkdtemp(path.join(indexedParent, 'tarobot-indexed-test-')); t.after(() => rm(outside, { recursive: true, force: true }));
  const disguise = path.join(root, 'fake.noindex'); await symlink(outside, disguise);
  await assert.rejects(isolatedRoot(disguise), /physical_noindex/);
  await assert.rejects(isolatedRoot(outside), /absolute_noindex/);
  const redirected = path.join(root, 'redirected'); await mkdir(redirected); await symlink(outside, path.join(redirected, 'resources'));
  await assert.rejects(developmentPaths(redirected), /redirected/);
  await assert.rejects(access(path.join(outside, 'host')));
});
test('default shell refuses arbitrary network, popup, webview and unsafe main-frame navigation', () => {
  for (const url of ['https://example.com', 'http://127.0.0.1:1', 'file:///etc/passwd', 'tarocub://conversation/x', 'tarobot://user@app/index.html']) assert.equal(internalResource(url), false);
  assert.equal(internalResource('tarobot://app/assets/index.js'), true);
  const contents = new EventEmitter(); contents.setWindowOpenHandler = callback => { contents.popup = callback; };
  secureContents(contents); assert.deepEqual(contents.popup(), { action: 'deny' });
  let prevented = 0; const event = { preventDefault: () => prevented++ };
  contents.emit('will-attach-webview', event); contents.emit('will-navigate', event, 'https://example.com');
  contents.emit('will-navigate', event, 'tarobot://app/index.html#x'); assert.equal(prevented, 2);
  const options = secureWebPreferences('/isolated/preload.cjs', {});
  assert.equal(options.sandbox, true); assert.equal(options.webSecurity, true); assert.equal(options.nodeIntegration, false); assert.equal(options.contextIsolation, true);
});
test('both permission check and request paths deny unimplemented capabilities', () => {
  const session = new EventEmitter(); Object.assign(session, {
    setPermissionRequestHandler: fn => session.request = fn, setPermissionCheckHandler: fn => session.check = fn,
    setDevicePermissionHandler: fn => session.device = fn, webRequest: { onBeforeRequest: fn => session.network = fn },
  });
  secureSession(session); assert.equal(session.check(), false); assert.equal(session.device(), false);
  session.request({}, 'media', accepted => assert.equal(accepted, false));
  session.network({ url: 'https://evil.example' }, result => assert.deepEqual(result, { cancel: true }));
});

test('design loader stays off the App origin and only its fixed path can load', async t => {
 const {dist}=await fixture(t);
 await assert.rejects(assetPath(dist,'tarobot://app/design-loader.html'));
 await assert.rejects(assetPath(dist,'tarobot-widget://sandbox/design-loader.html?code=bad',{widget:true}));
 assert.equal(await assetPath(dist,'tarobot-widget://sandbox/design-loader.html',{widget:true}),await realpath(path.join(dist,'design-loader.html')));
 const response=await assetHandler(dist,async()=>new Response('trusted'),{widget:true})({url:'tarobot-widget://sandbox/design-loader.html',method:'GET',initiatorOrigin:'tarobot://app'});
 assert.equal(response.status,200);assert.equal(response.headers.get('Content-Security-Policy'),'frame-ancestors tarobot://app');
 assert.ok(APP_CSP.includes("script-src 'self'"));assert.ok(!APP_CSP.includes('unsafe-eval'));
});
