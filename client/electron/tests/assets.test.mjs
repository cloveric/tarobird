import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assetPath, assetHandler, APP_CSP, PLUGIN_CSP } from '../assets.mjs';
import { developmentPaths, isolatedRoot } from '../isolation.mjs';
import { internalResource, pluginNetworkRequest, secureContents, secureSession, secureWebPreferences, widgetNetworkRequest } from '../security.mjs';
import { EventEmitter } from 'node:events';

async function fixture(t) {
  const parent = path.join(tmpdir(), 'tarobot-electron-tests.noindex'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'dist')); await writeFile(path.join(root, 'dist/index.html'), 'app');
  await writeFile(path.join(root, 'dist/widget-sandbox.html'), 'widget');
  await writeFile(path.join(root, 'dist/plugin-sandbox.html'), 'plugin');
  await writeFile(path.join(root, 'dist/design-loader.html'), 'trusted design trampoline');
  await writeFile(path.join(root, 'outside.txt'), 'outside');
  return { root, dist: path.join(root, 'dist') };
}
test('asset serving confines physical paths and gives Widget a separate origin', async t => {
  const { root, dist } = await fixture(t);
  assert.equal(await assetPath(dist, 'tarobot://app/index.html'), await realpath(path.join(dist, 'index.html')));
  assert.equal(await assetPath(dist, 'tarobot-widget://sandbox/widget-sandbox.html', { widget: true }), await realpath(path.join(dist, 'widget-sandbox.html')));
  assert.equal(await assetPath(dist, 'tarobot-widget://sandbox/plugin-sandbox.html', { widget: true }), await realpath(path.join(dist, 'plugin-sandbox.html')));
  await symlink(path.join(root, 'outside.txt'), path.join(dist, 'linked.txt'));
  await symlink(path.join(dist, 'widget-sandbox.html'), path.join(dist, 'widget-alias.html'));
  await symlink(path.join(dist, 'plugin-sandbox.html'), path.join(dist, 'plugin-alias.html'));
  for (const url of ['tarobot://app/linked.txt', 'tarobot://app/%2e%2e%2foutside.txt', 'tarobot://app/%5c..%5coutside.txt', 'tarobot://app/%00', 'tarobot://app/.env', 'tarobot://app/widget-sandbox.html', 'tarobot://app/WIDGET-SANDBOX.HTML', 'tarobot://app/widget-alias.html', 'tarobot://app/plugin-sandbox.html', 'tarobot://app/PLUGIN-SANDBOX.HTML', 'tarobot://app/plugin-alias.html', 'tarobot://user@app/index.html', 'tarobot://app:90/index.html']) await assert.rejects(assetPath(dist, url), undefined, url);
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
  // Widget network access: https/wss from a widget guest only, never local or private hosts.
  const relay = { url: 'tarobot-widget://sandbox/widget-sandbox.html', parent: { url: 'tarobot://app/index.html', parent: null } };
  const guest = { url: 'about:srcdoc', parent: relay }, app = relay.parent, design = { url: 'tarobot-widget://sandbox/design-loader.html', parent: app };
  assert.equal(widgetNetworkRequest({ url: 'https://cdn.example.com/lib.js', resourceType: 'xhr', frame: guest }), true);
  assert.equal(widgetNetworkRequest({ url: 'wss://echo.example.com/', resourceType: 'webSocket', frame: guest }), true);
  for (const resourceType of ['xhr', 'webSocket', 'other']) assert.equal(widgetNetworkRequest({ url: 'wss://echo.example.com/', resourceType, frame: null }), false, resourceType);
  assert.equal(widgetNetworkRequest({ url: 'https://cdn.example.com/a.png', resourceType: 'image', frame: app }), false);
  assert.equal(widgetNetworkRequest({ url: 'https://cdn.example.com/a.png', resourceType: 'image', frame: design }), false);
  assert.equal(widgetNetworkRequest({ url: 'https://cdn.example.com/', resourceType: 'subFrame', frame: guest }), false);
  for (const url of ['http://cdn.example.com/a.js', 'https://127.0.0.1/', 'https://192.168.1.2/', 'https://10.0.0.1/', 'https://[::1]/', 'https://nas.internal/', 'https://router/', 'https://user:pw@cdn.example.com/', 'file:///etc/passwd'])
    assert.equal(widgetNetworkRequest({ url, resourceType: 'xhr', frame: guest }), false, url);
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
    setDevicePermissionHandler: fn => session.device = fn, webRequest: { onBeforeRequest: fn => session.network = fn, onBeforeSendHeaders: fn => session.send = fn, onHeadersReceived: fn => session.receive = fn },
  });
  secureSession(session); assert.equal(session.check(), false); assert.equal(session.device(), false);
  session.request({}, 'media', accepted => assert.equal(accepted, false));
  session.network({ url: 'https://evil.example' }, result => assert.deepEqual(result, { cancel: true }));
  session.network({ url: 'https://evil.example', resourceType: 'image', frame: { url: 'tarobot://app/index.html', parent: null } }, result => assert.deepEqual(result, { cancel: true }));
  const guest = { url: 'about:srcdoc', parent: { url: 'tarobot-widget://sandbox/widget-sandbox.html', parent: { url: 'tarobot://app/index.html', parent: null } } };
  // Widgets have no network (1.5.1 policy, restored 2026-11-23): a request from a widget guest is cancelled like any other.
  for (const [url, resourceType] of [['https://cdn.example.com/a.png', 'image'], ['https://cdn.example.com/lib.js', 'xhr'], ['wss://echo.example.com/', 'webSocket']])
    session.network({ url, resourceType, frame: guest }, result => assert.deepEqual(result, { cancel: true }));
  session.send({ url: 'https://cdn.example.com/a.png', resourceType: 'image', frame: guest, requestHeaders: { Cookie: 'a=1', Authorization: 'x', Accept: '*/*' } }, result => assert.deepEqual(result, { requestHeaders: { Accept: '*/*' } }));
  session.receive({ url: 'https://cdn.example.com/a.png', resourceType: 'image', frame: guest, responseHeaders: { 'Set-Cookie': ['a=1'], 'Content-Type': ['image/png'] } }, result => assert.deepEqual(result, { responseHeaders: { 'Content-Type': ['image/png'] } }));
  session.send({ url: 'https://evil.example', resourceType: 'image', requestHeaders: { Cookie: 'a=1' } }, result => assert.deepEqual(result, { requestHeaders: {} }));
});

// Electron documents details.frame as null once the frame is gone. A widget
// request allowed while its frame was alive must not gain or send cookies
// when the frame detaches before its headers.
test('widget requests whose frame detached still lose cookies and credentials', () => {
  const session = new EventEmitter(); Object.assign(session, {
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {},
    webRequest: { onBeforeRequest: fn => session.network = fn, onBeforeSendHeaders: fn => session.send = fn, onHeadersReceived: fn => session.receive = fn },
  });
  secureSession(session);
  const guest = { url: 'about:srcdoc', parent: { url: 'tarobot-widget://sandbox/widget-sandbox.html', parent: { url: 'tarobot://app/index.html', parent: null } } };
  session.network({ url: 'https://cdn.example.com/data.json', resourceType: 'xhr', frame: guest }, result => assert.deepEqual(result, { cancel: true }));
  for (const frame of [null, undefined]) {
    session.send({ url: 'https://cdn.example.com/data.json', resourceType: 'xhr', frame, requestHeaders: { Cookie: 'a=1', Authorization: 'x', 'Proxy-Authorization': 'y', Accept: '*/*' } }, result => assert.deepEqual(result, { requestHeaders: { Accept: '*/*' } }));
    session.receive({ url: 'https://cdn.example.com/data.json', resourceType: 'xhr', frame, responseHeaders: { 'Set-Cookie': ['a=1'], 'set-cookie2': ['b=2'], 'Content-Type': ['application/json'] } }, result => assert.deepEqual(result, { responseHeaders: { 'Content-Type': ['application/json'] } }));
  }
  // App resources keep their headers.
  session.send({ url: 'tarobot://app/index.html', resourceType: 'mainFrame', requestHeaders: { Accept: '*/*' } }, result => assert.deepEqual(result, {}));
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

test('plugin sandbox stays off the App origin and is permitted on the sandbox scheme', async t => {
  const { dist } = await fixture(t);
  await assert.rejects(assetPath(dist, 'tarobot://app/plugin-sandbox.html'));
  await assert.rejects(assetPath(dist, 'tarobot-widget://sandbox/plugin-sandbox.html?x=1', { widget: true }));
  assert.equal(await assetPath(dist, 'tarobot-widget://sandbox/plugin-sandbox.html', { widget: true }), await realpath(path.join(dist, 'plugin-sandbox.html')));
  assert.equal(internalResource('tarobot-widget://sandbox/plugin-sandbox.html'), true);
  const response = await assetHandler(dist, async () => new Response('plugin'), { widget: true })({
    url: 'tarobot-widget://sandbox/plugin-sandbox.html',
    method: 'GET',
    initiatorOrigin: 'tarobot://app',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Security-Policy'), PLUGIN_CSP);
  assert.ok(PLUGIN_CSP.includes('img-src data: blob: https:'));
  assert.ok(PLUGIN_CSP.includes('connect-src https: wss:'));
  // Plugin guest requests may reach public https/wss endpoints (still blocking local/private hosts and stripping cookies),
  // while widget guests remain completely offline.
  const pluginRelay = { url: 'tarobot-widget://sandbox/plugin-sandbox.html', parent: { url: 'tarobot://app/index.html', parent: null } };
  const pluginGuest = { url: 'about:srcdoc', parent: pluginRelay };
  assert.equal(pluginNetworkRequest({ url: 'https://api.openai.com/v1/images/generations', resourceType: 'xhr', frame: pluginGuest }), true);
  assert.equal(pluginNetworkRequest({ url: 'https://cdn.example.com/out.png', resourceType: 'image', frame: pluginGuest }), true);
  assert.equal(pluginNetworkRequest({ url: 'https://127.0.0.1:8788/api/devices', resourceType: 'xhr', frame: pluginGuest }), false);
  assert.equal(pluginNetworkRequest({ url: 'https://192.168.1.5/admin', resourceType: 'xhr', frame: pluginGuest }), false);
  assert.equal(pluginNetworkRequest({ url: 'https://api.openai.com/', resourceType: 'subFrame', frame: pluginGuest }), false);
  const pluginSession = new EventEmitter(); Object.assign(pluginSession, {
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {},
    webRequest: { onBeforeRequest: fn => pluginSession.network = fn, onBeforeSendHeaders: fn => pluginSession.send = fn, onHeadersReceived: fn => pluginSession.receive = fn },
  });
  secureSession(pluginSession);
  pluginSession.network({ url: 'https://api.openai.com/v1/images/generations', resourceType: 'xhr', frame: pluginGuest }, result => assert.deepEqual(result, { cancel: false }));
  pluginSession.network({ url: 'https://127.0.0.1:8788/api/devices', resourceType: 'xhr', frame: pluginGuest }, result => assert.deepEqual(result, { cancel: true }));
  pluginSession.send({ url: 'https://api.openai.com/v1/images/generations', resourceType: 'xhr', frame: pluginGuest, requestHeaders: { Cookie: 'a=1', Authorization: 'Bearer user-key', 'Proxy-Authorization': 'p', 'Content-Type': 'application/json' } }, result => assert.deepEqual(result, { requestHeaders: { Authorization: 'Bearer user-key', 'Content-Type': 'application/json' } }));
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = () => ({ action: 'deny' });
  secureContents(contents);
  let allowedNavPrevented = 0;
  contents.emit('will-frame-navigate', { isMainFrame: false, url: 'tarobot-widget://sandbox/plugin-sandbox.html', preventDefault: () => allowedNavPrevented++ });
  assert.equal(allowedNavPrevented, 0);
  let blockedNavPrevented = 0;
  contents.emit('will-frame-navigate', { isMainFrame: false, url: 'tarobot://app/plugin-sandbox.html', preventDefault: () => blockedNavPrevented++ });
  assert.equal(blockedNavPrevented, 1);
});
