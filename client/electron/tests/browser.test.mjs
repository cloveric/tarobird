import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WorkbenchBrowser } from '../browser.mjs';
import { parseBrowserAction, parseBrowserLayout, parseBrowserReset, BROWSER_ACTIONS } from '../browser-contract.mjs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyURL, installRequestFilter, navigationURL, partitionFor, privateHost, browserUserAgent, removeRequestFilter } from '../browser-policy.mjs';
import { pageScript, PAGE_OPERATIONS } from '../browser-page.mjs';
import { DESKTOP_COMMANDS, DESKTOP_EVENTS } from '../contract.mjs';
import { DesktopServices } from '../desktop-services.mjs';

const scope = { host: 'host-key', user: 'user-1', conversation: 'conv-1' };
const other = { ...scope, conversation: 'conv-2' };
let ids = 100;

class Contents extends EventEmitter {
  constructor(webPreferences) {
    super(); this.id = ++ids; this.webPreferences = webPreferences; this.session = webPreferences?.session; this.url = ''; this.title = ''; this.destroyed = false;
    this.inputs = []; this.inserted = []; this.page = {}; this.unload = 'allow'; this.zoom = 1;
    this.navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} };
    this.debugger = { attach() {}, detach() {}, sendCommand: async () => ({}) };
  }
  isDestroyed() { return this.destroyed; }
  getURL() { return this.url; } getTitle() { return this.title; } isLoading() { return false; } getZoomFactor() { return this.zoom; }
  isCurrentlyAudible() { return false; }
  setWindowOpenHandler(handler) { this.openHandler = handler; }
  async loadURL(url) {
    if (this.unload !== 'allow' && this.url) {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      this.emit('will-prevent-unload', event);
      if (!event.defaultPrevented) throw new Error('ERR_ABORTED');
    }
    this.halted = false; this.loads = (this.loads ?? 0) + 1;
    this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
    await null; if (this.halted) throw new Error('ERR_ABORTED');
    // Real Electron signature: (event, url, httpResponseCode, httpStatusText).
    this.url = url; this.emit('did-navigate', {}, url, 200, 'OK'); this.emit('dom-ready'); this.emit('did-stop-loading');
  }
  reload() { void this.loadURL(this.url); } stop() { this.stopped = true; this.halted = true; }
  sendInputEvent(event) { this.inputs.push(event); }
  async insertText(text) { if (this.insertHold) await this.insertHold; this.inserted.push(text); }
  async executeJavaScriptInIsolatedWorld(world, [{ code }]) {
    assert.equal(world, 1093);
    const operation = /return \(function (\w+)\(/.exec(code)?.[1];
    const args = JSON.parse(/\}\)\(lib, (.*)\); \}\)\(\)$/s.exec(code)[1]);
    this.calls = [...(this.calls ?? []), { operation, args }];
    const reply = this.page[operation];
    return typeof reply === 'function' ? reply(args) : reply ?? {};
  }
  close(options) {
    if (options?.waitForBeforeUnload && this.unload !== 'allow') {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      this.emit('will-prevent-unload', event);
      if (!event.defaultPrevented) return;
    }
    // Real pages are destroyed only after the renderer answers; tests may delay it.
    const destroy = () => { if (!this.destroyed) { this.destroyed = true; this.emit('destroyed'); } };
    if (this.closeDelay) setTimeout(destroy, this.closeDelay); else destroy();
  }
}
class View { constructor({ webPreferences, webContents } = {}) { this.webContents = webContents ?? new Contents(webPreferences); this.bounds = undefined; this.shown = undefined; }
  setBounds(bounds) { this.bounds = bounds; } setVisible(value) { this.shown = value; } setBackgroundColor() {} }

function fixture({ visible = true, zoom = 1, dialogs = [], options = {}, userAgent = 'Mozilla/5.0 Chrome/140 Electron/45.1.0 Safari/537.36' } = {}) {
  const window = new EventEmitter(), children = [], events = [], sessions = new Map();
  let fullScreen = false;
  Object.assign(window, { isVisible: () => visible, isMinimized: () => false, isDestroyed: () => false, show() { visible = true; },
    isFullScreen: () => fullScreen, setFullScreen(value) { fullScreen = value; },
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), webContents: { getZoomFactor: () => zoom, send() {} },
    contentView: { addChildView: view => children.push(view), removeChildView: view => children.splice(children.indexOf(view), 1) } });
  const session = { fromPartition(name) {
    if (!sessions.has(name)) sessions.set(name, Object.assign(new EventEmitter(), { name, webRequest: { onBeforeRequest: (filter, fn) => { sessions.get(name).requests = { filter, fn }; },
      onBeforeSendHeaders: (filter, fn) => { sessions.get(name).headers = filter === null ? undefined : { filter, fn }; } }, agent: userAgent, getUserAgent() { return this.agent; }, setUserAgent(value) { this.agent = value; },
      setPermissionCheckHandler(fn) { this.check = fn; }, setPermissionRequestHandler(fn) { this.permission = fn; }, setDevicePermissionHandler(fn) { this.device = fn; },
      setDisplayMediaRequestHandler() {},
      clearStorageData: async () => { sessions.get(name).cleared = true; }, clearCache: async () => {}, clearAuthCache: async () => {}, clearHostResolverCache: async () => {} }));
    return sessions.get(name);
  } };
  const electron = { WebContentsView: View, session, app: { getLocale: () => 'zh-CN', getName: () => 'TaroBird', getVersion: () => '1.0.0', getPath: () => '/tmp' },
    dialog: { showMessageBoxSync: () => dialogs.shift() ?? 0, showMessageBox: async () => ({ response: dialogs.shift() ?? 0 }) }, shell: {}, Menu: {}, clipboard: {} };
  const browser = new WorkbenchBrowser(window, electron, { emit: payload => events.push(payload), now: Date.now, ...options });
  let generation = 0;
  const call = (args, active = () => true) => browser.request('workbench_browser', { scope, ...args }, active);
  const layout = (views, extra = {}) => browser.request('workbench_browser_layout', { seq: ++generation, views, ...extra }, () => true);
  return { browser, window, children, events, sessions, call, layout, setVisible: value => { visible = value; }, setFullScreen: value => { fullScreen = value; }, isFullScreen: () => fullScreen };
}

test('desktop contract adds two browser commands and one event without changing the system-browser command', () => {
  assert.ok(DESKTOP_COMMANDS.includes('workbench_browser') && DESKTOP_COMMANDS.includes('workbench_browser_layout') && DESKTOP_COMMANDS.includes('desktop_open_url'));
  assert.ok(DESKTOP_EVENTS.includes('workbench-browser'));
  assert.ok(BROWSER_ACTIONS.includes('observe') && !BROWSER_ACTIONS.some(action => /eval|script|execute/.test(action)));
});

test('action schema rejects scripts, ambiguous targets and Bot side effects without a request identity', () => {
  const base = { scope, tab: 't1' };
  assert.throws(() => parseBrowserAction({ ...base, action: 'evaluate', code: '1' }), /invalid_browser_args/);
  assert.throws(() => parseBrowserAction({ ...base, action: 'click', requestId: 'r', ref: 'r1.0.1', point: { x: 1, y: 1 }, snapshot: 1 }), /invalid_browser_args/);
  assert.throws(() => parseBrowserAction({ ...base, action: 'click', requestId: 'r', point: { x: 1, y: 1 } }), /invalid_browser_args/);
  assert.throws(() => parseBrowserAction({ ...base, action: 'click', ref: 'r1.0.1' }), /request_id_required/);
  assert.throws(() => parseBrowserAction({ ...base, action: 'observe', partition: 'persist:desktop-v1' }), /invalid_browser_args/);
  assert.throws(() => parseBrowserAction({ scope: { ...scope, host: 'a b' }, action: 'list' }), /invalid_browser_args/);
  assert.throws(() => parseBrowserAction({ ...base, tab: '../x', action: 'observe' }), /invalid_browser_args/);
  assert.doesNotThrow(() => parseBrowserAction({ ...base, action: 'navigate', source: 'user', url: 'example.org' }));
  for (const action of ['clear_data', 'revoke_scope']) {
    assert.throws(() => parseBrowserAction({ scope, action, requestId: 'r' }), /user_action_required/);
    assert.doesNotThrow(() => parseBrowserAction({ scope, action, source: 'user' }));
  }
  assert.throws(() => parseBrowserAction({ scope, action: 'download_open', download: '00000000-0000-4000-8000-000000000000' }), /user_action_required/);
  assert.throws(() => parseBrowserAction({ scope, tab: 't1', action: 'resume' }), /user_action_required/, 'a Bot cannot end the person\'s takeover');
  assert.doesNotThrow(() => parseBrowserAction({ scope, tab: 't1', action: 'resume', source: 'user' }));
  assert.throws(() => parseBrowserLayout({ seq: 1, views: [{ tab: 'a', x: 0, y: 0, width: 1, height: 1 }, { tab: 'a', x: 0, y: 0, width: 1, height: 1 }] }), /invalid_browser_layout/);
  assert.throws(() => parseBrowserLayout({ seq: 1, views: Array.from({ length: 6 }, (_, i) => ({ tab: `t${i}`, x: 0, y: 0, width: 1, height: 1 })) }), /invalid_browser_layout/);
});

test('page operations are fixed functions with JSON data, never caller-provided script', () => {
  assert.throws(() => pageScript('eval', {}), /unsupported_page_operation/);
  const code = pageScript('observe', { prefix: 'r1.0.', note: '"); alert(1); ("' });
  assert.ok(code.includes(JSON.stringify({ prefix: 'r1.0.', note: '"); alert(1); ("' })));
  assert.ok(PAGE_OPERATIONS.includes('observe') && PAGE_OPERATIONS.includes('settle'));
});

test('URL policy keeps http(s) in pages, confirms mail/tel and blocks file, App and script schemes', () => {
  assert.equal(classifyURL('https://example.org/a').kind, 'web');
  assert.equal(classifyURL('blob:https://example.org/uuid').kind, 'web');
  assert.equal(classifyURL('mailto:a@example.org').kind, 'external');
  for (const url of ['file:///etc/passwd', 'tarobot://app/index.html', 'tarobot-widget://sandbox/widget-sandbox.html', 'javascript:alert(1)', 'chrome://settings', 'tarocub://conversation/x', 'https://u:p@example.org', 'data:text/html,x', 'blob:tarobot://app/x'])
    assert.equal(classifyURL(url).kind, 'blocked', url);
  assert.equal(navigationURL('example.org/path'), 'https://example.org/path');
  assert.throws(() => navigationURL('file:///etc/hosts'), /navigation_blocked/);
  assert.throws(() => navigationURL('mailto:x@example.org'), /unsupported_scheme/);
  for (const host of ['localhost', 'a.localhost', '127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '[::1]', '169.254.1.1']) assert.equal(privateHost(host), true, host);
  for (const host of ['example.org', '8.8.8.8', ['172', '32', '0', '1'].join('.')]) assert.equal(privateHost(host), false, host);
  for (const app of ['TaroBird/1.0.121', 'TaroBotElectronAcceptance/45.1.0', 'tarobot-desktop/1.0.0']) {
    const own = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ${app} Chrome/140.0 Electron/45.1.0 Safari/537.36`;
    assert.equal(browserUserAgent(own), 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36');
    assert.equal(browserUserAgent(own, true), 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Electron/45.1.0 Safari/537.36', 'the engine form never names the App');
  }
});

test("YouTube's integrity-token request names the Electron engine while everything else stays stripped", async () => {
  const f = fixture();
  await f.call({ action: 'open', tab: 't1', url: 'https://www.youtube.com/watch?v=x', requestId: 'o' });
  const session = f.sessions.get(partitionFor(scope)), engine = 'Mozilla/5.0 Chrome/140 Electron/45.1.0 Safari/537.36', stripped = 'Mozilla/5.0 Chrome/140 Safari/537.36';
  assert.equal(session.agent, stripped, 'pages and all other requests keep the stripped User-Agent');
  // Only this endpoint: not the page, captions, other YouTube APIs or other hosts.
  assert.deepEqual(session.headers?.filter, { urls: ['https://www.youtube.com/api/jnn/*'] });
  const send = requestHeaders => new Promise(resolve => session.headers.fn({ url: 'https://www.youtube.com/api/jnn/v1/GenerateIT', requestHeaders }, resolve));
  assert.deepEqual(await send({ 'User-Agent': stripped, Accept: '*/*' }), { requestHeaders: { Accept: '*/*', 'User-Agent': engine } });
  assert.deepEqual(await send({ 'user-agent': stripped }), { requestHeaders: { 'User-Agent': engine } }, 'one header whatever its case');
  const headers = { 'USER-AGENT': stripped, 'User-Agent': stripped, Accept: '*/*', 'X-Example': 'keep' };
  assert.deepEqual(await send(headers), { requestHeaders: { Accept: '*/*', 'X-Example': 'keep', 'User-Agent': engine } });
  assert.equal(headers['USER-AGENT'], stripped, 'does not mutate the supplied headers');
  for (const url of ['https://www.youtube.com/watch?v=x', 'https://www.youtube.com/api/timedtext',
    'https://www.youtube.com/api/jnn-other/x', 'http://www.youtube.com/api/jnn/x',
    'https://www.youtube.com:8443/api/jnn/x', 'https://www.youtube.com.evil.test/api/jnn/x',
    'https://youtube.com/api/jnn/x', 'https://user@www.youtube.com/api/jnn/x', 'invalid']) {
    assert.deepEqual(await new Promise(resolve => session.headers.fn({ url, requestHeaders: headers }, resolve)), {}, url);
  }
  // Extension compatibility mode removes the session's listeners together and restores them together.
  removeRequestFilter(session); assert.equal(session.headers, undefined); assert.equal(session.requests.filter, null);
  installRequestFilter(session); assert.deepEqual(session.headers.filter, { urls: ['https://www.youtube.com/api/jnn/*'] });
  assert.deepEqual(await send({ 'User-Agent': stripped }), { requestHeaders: { 'User-Agent': engine } });
});

test('caption compatibility retains each session engine and never fabricates a missing engine', async () => {
  const agents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TaroBird/1.0.0 Chrome/156.0 Electron/45.3.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) TaroBird/1.0.0 Chrome/155.0 Electron/44.0.0 Safari/537.36',
    'Mozilla/5.0 Chrome/156.0 Safari/537.36',
  ];
  const sessions = [];
  for (const userAgent of agents) {
    const f = fixture({ userAgent });
    await f.call({ action: 'open', tab: 't1', url: 'https://example.org/', requestId: 'o' });
    sessions.push(f.sessions.get(partitionFor(scope)));
  }
  for (const [index, session] of sessions.entries()) {
    assert.equal(session.agent, browserUserAgent(agents[index]));
    if (index === 2) { assert.equal(session.headers, undefined); continue; }
    const result = await new Promise(resolve => session.headers.fn({ url: 'https://www.youtube.com/api/jnn/v1/GenerateIT', requestHeaders: {} }, resolve));
    assert.equal(result.requestHeaders['User-Agent'], agents[index].replace(' TaroBird/1.0.0', ''));
  }
});

test('partitions are derived in main from the scope and never shared across conversations', () => {
  assert.equal(partitionFor(scope), partitionFor({ ...scope }));
  assert.notEqual(partitionFor(scope), partitionFor(other));
  assert.match(partitionFor({ host: '../../x', user: 'persist:desktop-v1', conversation: '/etc' }), /^persist:tarobot-browser-v1-[0-9a-f]{32}$/);
  assert.notEqual(partitionFor(scope), 'persist:desktop-v1');
});

test('open creates an isolated page lazily, with no preload and its own session; restore keeps only metadata', async () => {
  const f = fixture();
  const restored = await f.call({ action: 'open', tab: 'r1', url: 'https://example.org', restore: true, source: 'user' });
  assert.equal(restored.status, 'ok'); assert.equal(restored.state, 'sleeping'); assert.equal(f.children.length, 0);
  const opened = await f.call({ action: 'open', tab: 't1', url: 'https://example.org/a', requestId: 'open-1' });
  assert.equal(opened.status, 'ok'); assert.equal(opened.url, 'https://example.org/a'); assert.equal(opened.navigation, 1);
  const prefs = f.children[0].webContents.webPreferences;
  assert.equal(prefs.preload, undefined); assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.webSecurity, true); assert.equal(prefs.webviewTag, false);
  assert.equal(prefs.session.name, partitionFor(scope)); assert.doesNotMatch(prefs.session.agent, /Electron/);
  assert.equal(f.children[0].shown, false, 'a page is not shown before the App reports its layout');
  const mismatch = await f.browser.request('workbench_browser', { scope: other, action: 'observe', tab: 't1' }, () => true);
  assert.equal(mismatch.error, 'tab_scope_mismatch');
  const list = await f.call({ action: 'list' });
  assert.deepEqual(list.tabs.map(tab => [tab.tab, tab.state]).sort(), [['r1', 'sleeping'], ['t1', 'live']]);
});

test('requestId replays the same receipt, conflicts on changed input and never repeats the side effect', async () => {
  const f = fixture();
  await f.call({ action: 'open', tab: 't1', url: 'https://example.org', requestId: 'o' });
  await f.layout([{ tab: 't1', x: 0, y: 0, width: 600, height: 400 }]);
  const contents = f.children[0].webContents;
  contents.page.prepare = { x: 10, y: 20, target: { tag: 'button' } };
  contents.page.settle = { delivered: true };
  const args = { action: 'click', tab: 't1', ref: 'r1.0.4', requestId: 'click-1' };
  const [first, second] = await Promise.all([f.call(args), f.call(args)]);
  assert.equal(first.status, 'ok'); assert.deepEqual(second, first);
  assert.equal(contents.inputs.filter(event => event.type === 'mouseDown').length, 1);
  const conflict = await f.call({ ...args, ref: 'r1.0.5' });
  assert.equal(conflict.error, 'request_conflict');
  assert.equal(contents.inputs.filter(event => event.type === 'mouseDown').length, 1);
});

test('layout converts App CSS pixels to DIP, clamps to the window and hides pages not listed', async () => {
  const f = fixture({ zoom: 1.25 });
  await f.call({ action: 'open', tab: 'a', url: 'https://a.example', requestId: '1' });
  await f.call({ action: 'open', tab: 'b', url: 'https://b.example', requestId: '2' });
  await f.layout([{ tab: 'a', x: 100, y: 40, width: 500, height: 2000 }]);
  const [a, b] = f.children;
  assert.deepEqual(a.bounds, { x: 125, y: 50, width: 625, height: 750 }); assert.equal(a.shown, true); assert.equal(b.shown, false);
  await f.browser.request('workbench_browser_layout', { seq: 1, views: [{ tab: 'b', x: 0, y: 0, width: 10, height: 10 }] }, () => true);
  assert.equal(b.shown, false, 'an older layout frame is ignored');
  await f.layout([{ tab: 'a', x: 0, y: 0, width: 10, height: 10 }], { hidden: true });
  assert.equal(a.shown, false, 'an App overlay hides the native page layer');
});

test('Bot input waits for a visible target, stops for takeover and needs a fresh observation after resume', async () => {
  const f = fixture();
  await f.call({ action: 'open', tab: 't1', url: 'https://example.org', requestId: 'o' });
  const contents = f.children[0].webContents;
  contents.page.prepare = { x: 5, y: 5, target: null }; contents.page.settle = { delivered: true };
  assert.equal((await f.call({ action: 'click', tab: 't1', ref: 'r1.0.1', requestId: 'c1' })).error, 'tab_not_visible');
  await f.layout([{ tab: 't1', x: 0, y: 0, width: 300, height: 300 }]);
  f.setVisible(false);
  const hidden = await f.call({ action: 'click', tab: 't1', ref: 'r1.0.1', requestId: 'c2' });
  assert.equal(hidden.status, 'paused'); assert.equal(hidden.error, 'window_hidden');
  for (const action of [{ action: 'observe' }, { action: 'navigate', url: 'https://x.example', requestId: 'n1' }, { action: 'screenshot' }]) {
    const result = await f.call({ tab: 't1', ...action });
    assert.equal(result.error, 'window_hidden', `${action.action} while hidden`);
  }
  assert.equal((await f.call({ action: 'list' })).status, 'ok', 'metadata stays readable');
  f.setVisible(true);
  let hold; contents.page.observe = () => new Promise(resolve => { hold = resolve; });
  const running = f.call({ action: 'observe', tab: 't1' }), waiting = f.call({ action: 'scroll', tab: 't1', direction: 'down', requestId: 'sh' });
  await new Promise(resolve => setImmediate(resolve));
  f.setVisible(false); f.window.emit('hide');
  assert.equal((await waiting).error, 'window_hidden', 'hiding pauses queued Bot steps');
  hold({ scroll: { x: 0, y: 0 } }); assert.equal((await running).error, 'window_hidden');
  f.setVisible(true); delete contents.page.observe;
  await f.call({ action: 'takeover', tab: 't1', source: 'user' });
  const paused = await f.call({ action: 'observe', tab: 't1' });
  assert.equal(paused.status, 'paused'); assert.equal(paused.error, 'user_control');
  await f.call({ action: 'resume', tab: 't1', source: 'user' });
  const stale = await f.call({ action: 'click', tab: 't1', ref: 'r1.0.1', requestId: 'c3' });
  assert.equal(stale.error, 'stale_ref');
  assert.equal(contents.inputs.length, 0, 'no input reached the page');
  contents.page.observe = args => ({ scroll: { x: 0, y: 0 }, elements: [{ ref: `${args.prefix}1` }] });
  const observed = await f.call({ action: 'observe', tab: 't1' });
  assert.equal(observed.snapshot, 1); assert.notEqual(observed.observation.elements[0].ref, 'r1.0.1');
  const fresh = await f.call({ action: 'click', tab: 't1', ref: observed.observation.elements[0].ref, requestId: 'c4' });
  assert.equal(fresh.status, 'ok'); assert.equal(fresh.evidence.delivered, true);
  assert.deepEqual(contents.inputs.map(event => event.type), ['mouseMove', 'mouseDown', 'mouseUp']);
});

test('a person using the page pauses queued Bot steps; App document replacement cancels them without closing pages', async () => {
  const f = fixture();
  await f.call({ action: 'open', tab: 't1', url: 'https://example.org', requestId: 'o' });
  await f.layout([{ tab: 't1', x: 0, y: 0, width: 300, height: 300 }]);
  const contents = f.children[0].webContents;
  let release; contents.page.observe = () => new Promise(resolve => { release = () => resolve({ scroll: { x: 0, y: 0 } }); });
  const first = f.call({ action: 'observe', tab: 't1' }), queued = f.call({ action: 'scroll', tab: 't1', direction: 'down', requestId: 's1' });
  await new Promise(resolve => setImmediate(resolve));
  contents.emit('input-event', {}, { type: 'mouseDown' });
  const paused = await queued; assert.equal(paused.status, 'paused'); assert.equal(paused.error, 'user_input');
  release(); assert.equal((await first).status, 'paused', 'the running read stops before returning stale data');
  let slow; contents.page.observe = () => new Promise(resolve => { slow = resolve; });
  const reading = f.call({ action: 'observe', tab: 't1', requestId: 'keep' });
  const wanted = f.call({ action: 'scroll', tab: 't1', direction: 'down', requestId: 'drop' }), other = f.call({ action: 'scroll', tab: 't1', direction: 'up', requestId: 'stay' });
  await new Promise(resolve => setImmediate(resolve));
  const cancelled = await f.call({ action: 'cancel', tab: 't1', source: 'user', targetRequestId: 'drop' });
  assert.equal(cancelled.cancelled, 1); assert.equal((await wanted).status, 'cancelled');
  contents.page.scroll = { moved: true }; slow({ scroll: { x: 0, y: 0 }, elements: [], text: '' });
  assert.equal((await reading).status, 'ok', 'only the targeted request is cancelled'); assert.equal((await other).status, 'ok');
  contents.page.observe = () => ({ scroll: { x: 0, y: 0 }, text: '字'.repeat(48000), elements: Array.from({ length: 300 }, (_, i) => ({ ref: `r1.2.${i}`, name: 'x'.repeat(2000) })) });
  const big = await f.call({ action: 'observe', tab: 't1' });
  assert.ok(Buffer.byteLength(JSON.stringify(big.observation)) <= 384 * 1024 && big.observation.truncated, 'observation fits the Host receipt');
  let hold; contents.page.observe = () => new Promise(resolve => { hold = resolve; });
  const running = f.call({ action: 'observe', tab: 't1' }), later = f.call({ action: 'scroll', tab: 't1', direction: 'down', requestId: 's2' });
  await new Promise(resolve => setImmediate(resolve));
  f.browser.retire();
  assert.equal((await later).status, 'cancelled');
  hold({ scroll: { x: 0, y: 0 } }); await running;
  assert.equal(contents.destroyed, false); assert.equal(f.children[0].shown, false);
});

test('close respects beforeunload: a Bot gets needs_user, a person decides; quit asks first and closes nothing', async () => {
  const f = fixture({ dialogs: [0, 1, 0, 1] });
  await f.call({ action: 'open', tab: 'a', url: 'https://a.example', requestId: '1' });
  await f.call({ action: 'open', tab: 'b', url: 'https://b.example', requestId: '2' });
  const [a, b] = f.children.map(view => view.webContents);
  a.unload = 'prevent';
  const bot = await f.call({ action: 'close', tab: 'a', requestId: 'close-a' });
  assert.equal(bot.status, 'needs_user'); assert.equal(a.destroyed, false);
  const stay = await f.call({ action: 'close', tab: 'a', source: 'user' });
  assert.equal(stay.status, 'needs_user'); assert.equal(a.destroyed, false);
  const leave = await f.call({ action: 'close', tab: 'a', source: 'user' });
  assert.equal(leave.status, 'ok'); assert.equal(a.destroyed, true);
  b.unload = 'prevent'; const url = b.url;
  assert.equal(await f.browser.prepareQuit(), false, 'the person keeps the page: quitting is cancelled');
  assert.equal(b.destroyed, false); assert.equal(b.url, url, 'the probe never replaced the page');
  f.browser.quitCancelled();
  assert.equal((await f.call({ action: 'observe', tab: 'b' })).status, 'ok', 'Bot work resumes after a cancelled quit');
  assert.equal(await f.browser.prepareQuit(), true, 'the person confirmed quitting');
  const list = await f.call({ action: 'list' });
  assert.deepEqual(list.tabs.map(tab => [tab.tab, tab.state]), [['b', 'live']], 'nothing is closed before the App really quits');
  f.browser.dispose(); assert.equal(b.destroyed, true);
});

test('live pages are bounded: only safe background pages sleep, otherwise the person decides', async () => {
  const f = fixture();
  f.browser.limits = { ...f.browser.limits, liveTabs: 2 };
  await f.call({ action: 'open', tab: 'a', url: 'https://a.example', requestId: '1' });
  await f.call({ action: 'open', tab: 'b', url: 'https://b.example', requestId: '2' });
  f.children[0].webContents.emit('input-event', {}, { type: 'keyDown' });
  await f.layout([{ tab: 'b', x: 0, y: 0, width: 100, height: 100 }]);
  const blocked = await f.call({ action: 'open', tab: 'c', url: 'https://c.example', requestId: '3' });
  assert.equal(blocked.status, 'needs_user'); assert.equal(blocked.error, 'live_limit');
  await f.layout([]);
  const opened = await f.call({ action: 'open', tab: 'd', url: 'https://d.example', requestId: '4' });
  assert.equal(opened.status, 'ok');
  const states = Object.fromEntries((await f.call({ action: 'list' })).tabs.map(tab => [tab.tab, tab.state]));
  assert.deepEqual(states, { a: 'live', b: 'sleeping', c: 'sleeping', d: 'live' });
});

test('session policy routes permissions/downloads only for managed pages and blocks loopback subresources from public pages', async () => {
  const f = fixture({ dialogs: [1] });
  await f.call({ action: 'open', tab: 't1', url: 'https://example.org', requestId: 'o' });
  const contents = f.children[0].webContents, session = f.sessions.get(partitionFor(scope));
  const decide = (target, permission, details) => new Promise(resolve => session.permission(target, permission, resolve, details));
  assert.equal(await decide(new Contents(), 'media', { requestingUrl: 'https://example.org' }), false, 'unknown contents are denied');
  assert.equal(await decide(contents, 'hid', { requestingUrl: 'https://example.org' }), false);
  assert.equal(await decide(contents, 'geolocation', { requestingUrl: 'https://example.org/x' }), true, 'person allowed in the native prompt');
  assert.equal(session.check(contents, 'geolocation', 'https://example.org'), true);
  assert.equal(session.check(contents, 'geolocation', 'https://other.example'), false);
  assert.equal(session.device(), false);
  const request = details => new Promise(resolve => session.requests.fn(details, resolve));
  assert.deepEqual(await request({ resourceType: 'xhr', url: 'http://127.0.0.1:9/x', frame: { origin: 'https://evil.example' } }), { cancel: true });
  assert.deepEqual(await request({ resourceType: 'xhr', url: 'http://127.0.0.1:9/x', frame: { origin: 'http://localhost:3000' } }), { cancel: false });
  assert.deepEqual(await request({ resourceType: 'mainFrame', url: 'http://127.0.0.1:9/' }), {});
  const item = Object.assign(new EventEmitter(), { getFilename: () => '../report.pdf', getURL: () => 'https://example.org/r.pdf', getTotalBytes: () => 10, getReceivedBytes: () => 10,
    setSaveDialogOptions(value) { this.options = value; }, getSavePath: () => '/tmp/report.pdf' });
  session.emit('will-download', { preventDefault() { assert.fail('managed download was refused'); } }, item, contents);
  let refused = false; session.emit('will-download', { preventDefault() { refused = true; } }, item, new Contents());
  assert.equal(refused, true);
  item.emit('done', {}, 'completed');
  const downloads = await f.call({ action: 'downloads' });
  assert.equal(downloads.downloads.length, 1); assert.equal(downloads.downloads[0].name, 'report.pdf'); assert.equal(downloads.downloads[0].path, undefined);
  const elsewhere = await f.browser.request('workbench_browser', { scope: other, action: 'download_open', source: 'user', download: downloads.downloads[0].download }, () => true);
  assert.equal(elsewhere.error, 'download_not_found');
});

test('new-tab requests stay in the opener scope; popups keep opener semantics without App privileges', async () => {
  const f = fixture();
  await f.call({ action: 'open', tab: 't1', url: 'https://example.org', requestId: 'o' });
  const contents = f.children[0].webContents;
  assert.deepEqual(contents.openHandler({ url: 'file:///etc/passwd', disposition: 'foreground-tab', features: '' }), { action: 'deny' });
  const popup = contents.openHandler({ url: 'https://login.example/auth', disposition: 'new-window', features: 'width=480,height=600' });
  assert.equal(popup.action, 'allow'); assert.equal(popup.overrideBrowserWindowOptions.webPreferences.preload, undefined);
  assert.equal(popup.overrideBrowserWindowOptions.webPreferences.session, contents.session);
  assert.equal(popup.overrideBrowserWindowOptions.width, 480);
  const tab = contents.openHandler({ url: 'https://example.org/next', disposition: 'foreground-tab', features: '' });
  const created = tab.createWindow({ webContents: new Contents({ session: contents.session }), webPreferences: {} });
  const opened = f.events.find(event => event.kind === 'opened');
  assert.equal(opened.opener, 't1'); assert.equal(created.session, contents.session); assert.deepEqual(opened.scope, scope);
  assert.ok(f.events.filter(event => event.tab).every(event => JSON.stringify(event.scope) === JSON.stringify(scope)), 'every tab event names its scope');
  const list = await f.call({ action: 'list' });
  assert.equal(list.tabs.length, 2);
});

test('DesktopServices keeps browser commands behind the migration gate and retires them with the document', async () => {
  const window = new EventEmitter();
  Object.assign(window, { isDestroyed: () => false, webContents: { send() {} } });
  const service = new DesktopServices(window, { app: { getLocale: () => 'en' } }, { migration: { ready: false, retire() {} } });
  await assert.rejects(service.request('workbench_browser', { action: 'list', scope }, () => true), /migration_not_complete/);
  service.migration.ready = true;
  const listed = await service.request('workbench_browser', { action: 'list', scope }, () => true);
  assert.deepEqual(listed.tabs, []);
  service.dispose();
});

test('targeted cancel only stops its own Host dispatch: races with a person, a newer Bot step, another tab and dispatched input', async () => {
  const f = fixture();
  await f.call({ action: 'open', tab: 't1', url: 'https://one.example', requestId: 'o1' });
  await f.call({ action: 'open', tab: 't2', url: 'https://two.example', requestId: 'o2' });
  await f.layout([{ tab: 't1', x: 0, y: 0, width: 300, height: 300 }, { tab: 't2', x: 300, y: 0, width: 300, height: 300 }]);
  const [one, two] = f.children.map(view => view.webContents);
  const hold = contents => { let release; contents.page.observe = () => new Promise(resolve => { release = () => resolve({ scroll: { x: 0, y: 0 }, elements: [], text: '' }); }); return () => release(); };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const cancel = (tab, targetRequestId) => f.call({ action: 'cancel', tab, source: 'user', targetRequestId });

  // 1. The person's own read on the same tab survives cancelling the Bot dispatch.
  let release = hold(one);
  const bot = f.call({ action: 'observe', tab: 't1', requestId: 'bot-A' }); await tick();
  // (A person's page-changing input would itself pause the Bot step first; a
  // read keeps this case about cancel scope only.)
  one.page.selection = { text: 'person selection' };
  const person = f.call({ action: 'selection', tab: 't1', source: 'user' });
  const first = await cancel('t1', 'bot-A');
  assert.equal(first.cancel.outcome, 'cancel_requested');
  const read = await person;
  assert.equal(read.status, 'ok', 'a person\'s operation is never cancelled by a dispatch cancel'); assert.equal(read.selection.text, 'person selection');
  release(); assert.equal((await bot).status, 'cancelled');

  // 2. A finished request and an unknown one are explicit no-ops; the newer Bot step continues.
  assert.equal((await f.call({ action: 'scroll', tab: 't1', direction: 'down', requestId: 'bot-old' })).status, 'ok');
  release = hold(one);
  const newer = f.call({ action: 'observe', tab: 't1', requestId: 'bot-new' }); await tick();
  const stale = await cancel('t1', 'bot-old'), unknown = await cancel('t1', 'never-sent');
  assert.deepEqual([stale.cancel.outcome, stale.cancel.finalStatus, stale.cancelled], ['finished', 'ok', 0]);
  assert.deepEqual([unknown.cancel.outcome, unknown.cancelled], ['not_current', 0]);
  release(); assert.equal((await newer).status, 'ok', 'a stale cancel must not stop the newer Bot step');

  // 3. A request queued behind another is removed alone; the running one finishes.
  release = hold(one);
  const running = f.call({ action: 'observe', tab: 't1', requestId: 'bot-run' }); await tick();
  const queued = f.call({ action: 'scroll', tab: 't1', direction: 'up', requestId: 'bot-queued' });
  assert.equal((await cancel('t1', 'bot-queued')).cancel.outcome, 'cancelled');
  assert.equal((await queued).status, 'cancelled');
  release(); assert.equal((await running).status, 'ok');

  // 4. Another tab's dispatch is not visible from this tab and keeps running.
  const releaseTwo = hold(two);
  const elsewhere = f.call({ action: 'observe', tab: 't2', requestId: 'bot-two' }); await tick();
  assert.equal((await cancel('t1', 'bot-two')).cancel.outcome, 'not_current');
  releaseTwo(); assert.equal((await elsewhere).status, 'ok');

  // 5. Input already dispatched cannot be recalled: report too_late and keep the real result.
  one.page.prepare = { x: 5, y: 5, target: null };
  let settle; one.page.settle = () => new Promise(resolve => { settle = resolve; });
  const click = f.call({ action: 'click', tab: 't1', ref: 'r1.0.1', requestId: 'bot-click' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await cancel('t1', 'bot-click')).cancel.outcome, 'too_late');
  for (let i = 0; i < 40 && !settle; i++) await new Promise(resolve => setTimeout(resolve, 10));
  settle({ delivered: true });
  const clicked = await click;
  assert.equal(clicked.status, 'ok'); assert.equal(one.inputs.filter(event => event.type === 'mouseDown').length, 1);
});

test('takeover can only be ended from the trusted UI; after the person resumes, the Bot regains control with fresh refs', async () => {
  const f = fixture();
  await f.call({ action: 'open', tab: 't1', url: 'https://example.org', requestId: 'o' });
  await f.layout([{ tab: 't1', x: 0, y: 0, width: 300, height: 300 }]);
  const contents = f.children[0].webContents;
  contents.page.observe = args => ({ scroll: { x: 0, y: 0 }, text: '', elements: [{ ref: `${args.prefix}1` }] });
  contents.page.prepare = { x: 5, y: 5, target: null }; contents.page.settle = { delivered: true };
  const before = await f.call({ action: 'observe', tab: 't1' });
  assert.equal((await f.call({ action: 'takeover', tab: 't1', requestId: 'bot-hands-over' })).status, 'ok', 'a Bot may hand control to the person');
  await assert.rejects(f.call({ action: 'resume', tab: 't1', requestId: 'bot-resume' }), /browser_user_action_required/);
  const blocked = await f.call({ action: 'click', tab: 't1', ref: before.observation.elements[0].ref, requestId: 'c1' });
  assert.equal(blocked.status, 'paused'); assert.equal(blocked.error, 'user_control');
  assert.equal((await f.call({ action: 'list' })).tabs[0].control, 'user', 'the takeover is still in force');
  const resumed = await f.call({ action: 'resume', tab: 't1', source: 'user' });
  assert.equal(resumed.status, 'ok'); assert.equal(resumed.control, 'bot'); assert.equal(resumed.observeRequired, true);
  assert.equal((await f.call({ action: 'click', tab: 't1', ref: before.observation.elements[0].ref, requestId: 'c2' })).error, 'stale_ref');
  const fresh = await f.call({ action: 'observe', tab: 't1' });
  const clicked = await f.call({ action: 'click', tab: 't1', ref: fresh.observation.elements[0].ref, requestId: 'c3' });
  assert.equal(clicked.status, 'ok'); assert.equal(contents.inputs.filter(event => event.type === 'mouseDown').length, 1);
  assert.deepEqual(f.events.filter(event => event.kind === 'control').map(event => event.control), ['user', 'bot']);
});

test('HTML fullscreen fills the window with that page above the App and restores the split layout on exit', async () => {
  const f = fixture();
  await f.call({ action: 'open', tab: 'a', url: 'https://a.example', requestId: '1' });
  await f.call({ action: 'open', tab: 'b', url: 'https://b.example', requestId: '2' });
  const [a, b] = f.children;
  await f.layout([{ tab: 'a', x: 400, y: 0, width: 400, height: 400 }, { tab: 'b', x: 800, y: 0, width: 400, height: 400 }]);
  a.webContents.emit('enter-html-full-screen');
  assert.deepEqual(a.bounds, { x: 0, y: 0, width: 1200, height: 800 }); assert.equal(a.shown, true); assert.equal(b.shown, false);
  assert.equal(f.children.at(-1), a, 'the fullscreen page is on top');
  await f.layout([{ tab: 'a', x: 400, y: 0, width: 400, height: 400 }, { tab: 'b', x: 800, y: 0, width: 400, height: 400 }]);
  assert.deepEqual(a.bounds, { x: 0, y: 0, width: 1200, height: 800 }, 'App layout frames do not shrink a fullscreen page');
  a.webContents.emit('leave-html-full-screen');
  assert.deepEqual(a.bounds, { x: 400, y: 0, width: 400, height: 400 }); assert.equal(b.shown, true);
  assert.deepEqual(f.events.filter(event => event.kind === 'fullscreen').map(event => event.enabled), [true, false]);
});

test('a fullscreen page is asked to leave fullscreen before it closes; a page that vanishes still releases the window', async () => {
  const f = fixture();
  await f.call({ action: 'open', tab: 'a', url: 'https://a.example', requestId: '1' });
  await f.call({ action: 'open', tab: 'b', url: 'https://b.example', requestId: '2' });
  const [a, b] = f.children;
  await f.layout([{ tab: 'a', x: 400, y: 0, width: 400, height: 400 }, { tab: 'b', x: 800, y: 0, width: 400, height: 400 }]);
  a.webContents.emit('enter-html-full-screen'); f.setFullScreen(true);
  a.webContents.page.exitFullscreen = () => { setImmediate(() => { f.setFullScreen(false); a.webContents.emit('leave-html-full-screen'); }); return { active: true }; };
  assert.equal((await f.call({ action: 'close', tab: 'a', source: 'user' })).status, 'ok');
  assert.ok(a.webContents.calls.some(call => call.operation === 'exitFullscreen'), 'the page was asked to leave fullscreen first');
  assert.equal(f.isFullScreen(), false); assert.equal(b.shown, true); assert.equal(f.browser.stats().fullscreen, null);
  // A page that is destroyed while fullscreen (no leave event) releases the window it took over.
  b.webContents.emit('enter-html-full-screen'); f.setFullScreen(true);
  b.webContents.destroyed = true; b.webContents.emit('destroyed');
  assert.equal(f.isFullScreen(), false); assert.equal(f.browser.stats().fullscreen, null);
});

test('a fullscreen page that never answers, or vanishes, still releases the window and the UI (user window fullscreen kept)', async () => {
  const f = fixture();
  await f.call({ action: 'open', tab: 'a', url: 'https://a.example', requestId: '1' });
  await f.call({ action: 'open', tab: 'b', url: 'https://b.example', requestId: '2' });
  const [a, b] = f.children;
  await f.layout([{ tab: 'a', x: 400, y: 0, width: 400, height: 400 }, { tab: 'b', x: 800, y: 0, width: 400, height: 400 }]);
  // Hung page: the exit request never produces a leave event.
  a.webContents.emit('enter-html-full-screen'); f.setFullScreen(true);
  a.webContents.page.exitFullscreen = () => new Promise(() => {});
  assert.equal((await f.call({ action: 'close', tab: 'a', source: 'user' })).status, 'ok');
  assert.equal(f.isFullScreen(), false, 'the window the page took over is released');
  assert.deepEqual(f.events.filter(event => event.kind === 'fullscreen' && event.tab === 'a').map(event => event.enabled), [true, false]);
  assert.equal(b.shown, true);
  // The person had the window fullscreen before the page did: keep it.
  f.setFullScreen(true);
  b.webContents.emit('enter-html-full-screen');
  b.webContents.destroyed = true; b.webContents.emit('destroyed');
  assert.equal(f.isFullScreen(), true, 'a person\'s own window fullscreen is kept');
  assert.deepEqual(f.events.filter(event => event.kind === 'fullscreen' && event.tab === 'b').map(event => event.enabled), [true, false]);
});

test('one tab gets one native page when an open, a layout reveal and a Bot wake race an eviction', async () => {
  const live = f => f.children.filter(view => !view.webContents.destroyed);
  // A person opens a page at the live limit: the Workbench layout frame for the
  // new Tab arrives while the oldest background page is still unloading.
  const f = fixture();
  f.browser.limits = { ...f.browser.limits, liveTabs: 2 };
  await f.call({ action: 'open', tab: 'a', url: 'https://a.example', requestId: '1' });
  await f.call({ action: 'open', tab: 'b', url: 'https://b.example', requestId: '2' });
  for (const view of f.children) view.webContents.closeDelay = 5;
  const opening = f.call({ action: 'open', tab: 'c', url: 'https://c.example', source: 'user' });
  await new Promise(resolve => setImmediate(resolve));
  await f.layout([{ tab: 'c', x: 0, y: 0, width: 400, height: 300 }]);
  assert.equal((await opening).status, 'ok'); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(live(f).length, 2); assert.equal(f.browser.stats().live, 2); assert.equal(f.browser.stats().routes, 2);
  assert.equal(live(f).filter(view => view.webContents.url === 'https://c.example/').length, 1);
  // A sleeping Tab revealed by layout while a Bot wake for it is queued.
  const g = fixture();
  g.browser.limits = { ...g.browser.limits, liveTabs: 2 };
  await g.call({ action: 'open', tab: 'a', url: 'https://a.example', requestId: '1' });
  await g.call({ action: 'open', tab: 'b', url: 'https://b.example', requestId: '2' });
  await g.call({ action: 'open', tab: 'c', url: 'https://c.example', restore: true, source: 'user' });
  for (const view of g.children) view.webContents.closeDelay = 5;
  await g.layout([{ tab: 'c', x: 0, y: 0, width: 400, height: 300 }]);
  const woken = await g.call({ action: 'wake', tab: 'c', requestId: 'wake-c' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(woken.status, 'ok'); assert.equal(woken.existing, true, 'the second waker reuses the installed page');
  assert.equal(live(g).length, 2); assert.equal(g.browser.stats().live, 2); assert.equal(g.browser.stats().routes, 2);
});

test('pages waiting for a slot count toward the live limit', async () => {
  const f = fixture();
  f.browser.limits = { ...f.browser.limits, liveTabs: 2 };
  await f.call({ action: 'open', tab: 'a', url: 'https://a.example', requestId: '1' });
  await f.call({ action: 'open', tab: 'b', url: 'https://b.example', restore: true, source: 'user' });
  await f.call({ action: 'open', tab: 'c', url: 'https://c.example', restore: true, source: 'user' });
  await f.layout([{ tab: 'b', x: 0, y: 0, width: 300, height: 300 }, { tab: 'c', x: 300, y: 0, width: 300, height: 300 }]);
  await new Promise(resolve => setTimeout(resolve, 20));
  const states = Object.fromEntries((await f.call({ action: 'list' })).tabs.map(tab => [tab.tab, tab.state]));
  assert.equal(f.browser.stats().live, 2, 'one layout frame revealing two sleeping pages stays within the limit');
  assert.deepEqual(states, { a: 'sleeping', b: 'live', c: 'live' });
});

test('an automatic sleep that times out never turns into a closed Tab when the page answers late', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.browser.limits = { ...f.browser.limits, liveTabs: 1 };
  await f.call({ action: 'open', tab: 'a', url: 'https://a.example', requestId: '1' });
  const a = f.children[0].webContents;
  a.closeDelay = 5600; // a busy page answers beforeunload after the 5 s sleep timer
  const opening = f.call({ action: 'open', tab: 'b', url: 'https://b.example', requestId: '2' });
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(5000);
  const opened = await opening;
  assert.equal(opened.status, 'needs_user'); assert.equal(opened.error, 'live_limit');
  t.mock.timers.tick(600);
  assert.equal(a.destroyed, true);
  const states = Object.fromEntries((await f.call({ action: 'list' })).tabs.map(tab => [tab.tab, tab.state]));
  assert.equal(states.a, 'sleeping', 'the person never closed page a; it can be woken again');
  assert.ok(!f.events.some(event => event.kind === 'closed' && event.tab === 'a'));
  assert.ok(f.events.some(event => event.kind === 'sleep' && event.tab === 'a'));
  assert.equal(f.browser.stats().routes, 0);
  // A person's own close afterwards still closes it.
  const closed = await f.call({ action: 'close', tab: 'a', source: 'user' });
  assert.equal(closed.status, 'ok');
  assert.deepEqual((await f.call({ action: 'list' })).tabs.map(tab => tab.tab), ['b']);
});

test('a timed-out Bot input makes no later page change and the next Bot input never interleaves with it', async () => {
  const f = fixture();
  await f.call({ action: 'open', tab: 't1', url: 'https://example.org', requestId: 'o' });
  await f.layout([{ tab: 't1', x: 0, y: 0, width: 300, height: 300 }]);
  const contents = f.children[0].webContents;
  f.browser.limits = { ...f.browser.limits, actionMs: 60 };
  let commit; contents.insertHold = new Promise(resolve => { commit = resolve; });
  contents.page.prepare = { before: 0, target: null, x: 1, y: 1 }; contents.page.field = { matches: false, length: 0 };
  contents.page.keyTarget = { target: { tag: 'input' } }; contents.page.settle = { delivered: true };
  const typed = f.call({ action: 'type', tab: 't1', ref: 'r1.0.1', text: 'hello', requestId: 'type-1' });
  const pressed = f.call({ action: 'press', tab: 't1', key: 'Enter', requestId: 'press-1' });
  const first = await typed;
  assert.deepEqual([first.status, first.error], ['unknown', 'timeout'], 'text was dispatched: its outcome is unknown');
  const second = await pressed;
  assert.deepEqual([second.status, second.error], ['failed', 'timeout'], 'the next input waited and was never dispatched');
  assert.equal(contents.inputs.length, 0, 'no Enter reached the page while text was still being committed');
  commit(); await new Promise(resolve => setTimeout(resolve, 80));
  assert.ok(!contents.calls.some(call => call.operation === 'domType'), 'no DOM fallback write after the timeout');
  // A hung input step never blocks recovery: a Bot reload does not wait for
  // it, and inputs on the new document do not wait for the old one.
  contents.insertHold = new Promise(() => {});
  const hung = await f.call({ action: 'type', tab: 't1', ref: `r${(await f.call({ action: 'list' })).tabs[0].navigation}.0.1`, text: 'x', requestId: 'type-2' });
  assert.deepEqual([hung.status, hung.error], ['unknown', 'timeout']);
  const reloaded = await f.call({ action: 'reload', tab: 't1', requestId: 'reload-1' });
  assert.equal(reloaded.status, 'ok', 'navigation recovers a page with a hung input step');
  contents.page.scroll = { moved: true };
  const scrolled = await f.call({ action: 'scroll', tab: 't1', direction: 'down', requestId: 'scroll-1' });
  assert.equal(scrolled.status, 'ok', 'inputs on the new document do not wait for the hung step');
});

test('a page that cannot wake at the live limit is not retried on every layout frame; the person wakes it explicitly', async () => {
  const f = fixture();
  f.browser.limits = { ...f.browser.limits, liveTabs: 1 };
  await f.call({ action: 'open', tab: 'a', url: 'https://a.example', requestId: '1' });
  f.children[0].webContents.emit('input-event', {}, { type: 'keyDown' }); // edited: never put to sleep automatically
  await f.call({ action: 'open', tab: 'b', url: 'https://b.example', restore: true, source: 'user' });
  const failures = () => f.events.filter(event => event.kind === 'sleep' && event.tab === 'b' && event.reason === 'live_limit').length;
  const view = [{ tab: 'b', x: 0, y: 0, width: 300, height: 300 }];
  await f.layout(view); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(failures(), 1);
  // Each failure publishes App state, which re-sends the same layout.
  for (let i = 0; i < 5; i++) { await f.layout(view); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(failures(), 1, 'no retry loop on identical layout frames');
  assert.equal((await f.call({ action: 'wake', tab: 'b', source: 'user' })).error, 'live_limit');
  assert.equal((await f.call({ action: 'close', tab: 'a', source: 'user' })).status, 'ok');
  const woken = await f.call({ action: 'wake', tab: 'b', source: 'user' });
  assert.equal(woken.status, 'ok'); assert.equal(f.browser.stats().live, 1);
});

test('repeated prevented or timed-out closes leave no listeners behind on the page', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  await f.call({ action: 'open', tab: 'a', url: 'https://a.example', requestId: 'o' });
  const page = f.children[0].webContents, counts = () => ['destroyed', 'will-prevent-unload'].map(name => page.listenerCount(name));
  const before = counts();
  page.unload = 'prevent';
  for (let i = 0; i < 10; i++) assert.equal((await f.call({ action: 'close', tab: 'a', requestId: `c${i}` })).status, 'needs_user');
  page.unload = 'allow'; page.closeDelay = 60000; // a busy page that does not answer the sleep in time
  for (let i = 0; i < 10; i++) {
    const sleeping = f.call({ action: 'sleep', tab: 'a', source: 'user' });
    for (let n = 0; n < 3; n++) await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(5000); assert.equal((await sleeping).status, 'needs_user');
  }
  assert.deepEqual(counts(), before);
});

test('a Bot open can be cancelled until its page exists; after navigation is dispatched the cancel is too_late', async () => {
  const f = fixture();
  f.browser.limits = { ...f.browser.limits, liveTabs: 1 };
  await f.call({ action: 'open', tab: 'a', url: 'https://a.example', requestId: '1' });
  const a = f.children[0].webContents; a.closeDelay = 50; // the background page unloads first
  const opening = f.call({ action: 'open', tab: 'b', url: 'https://b.example', requestId: 'open-b' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await f.call({ action: 'list' })).tabs.find(tab => tab.tab === 'b').current, 'wake', 'the waiting open is the tab\'s current Bot step');
  const cancel = await f.call({ action: 'cancel', tab: 'b', source: 'user', targetRequestId: 'open-b' });
  assert.deepEqual([cancel.cancelled, cancel.cancel.outcome], [1, 'cancel_requested']);
  const opened = await opening; await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual([opened.action, opened.status, opened.state], ['open', 'cancelled', 'closed'], 'no page and no native record for the App to keep');
  assert.ok(!f.children.some(view => view.webContents.url === 'https://b.example/'), 'nothing was created or navigated after the cancel');
  assert.deepEqual((await f.call({ action: 'list' })).tabs.map(tab => [tab.tab, tab.state]), [['a', 'sleeping']], 'the background page only slept; it was never force-closed');
  assert.equal(f.browser.stats().tasks, 0);
  // Navigation already dispatched: the page stays and the cancel says so.
  const g = fixture();
  // A page whose first load takes a while (navigation already dispatched).
  g.browser.electron = { ...g.browser.electron, WebContentsView: class extends View {
    constructor(options) { super(options); const page = this.webContents, load = page.loadURL.bind(page); page.loadURL = async url => { await new Promise(resolve => setTimeout(resolve, 50)); return load(url); }; } } };
  const slow = g.call({ action: 'open', tab: 'c', url: 'https://c.example', requestId: 'open-c' });
  await new Promise(resolve => setTimeout(resolve, 10));
  const page = g.children[0].webContents;
  const late = await g.call({ action: 'cancel', tab: 'c', source: 'user', targetRequestId: 'open-c' });
  assert.equal(late.cancel.outcome, 'too_late');
  const result = await slow;
  assert.equal(result.status, 'ok'); assert.equal(page.destroyed, false); assert.equal(g.browser.stats().live, 1);
  // A person's own open is not a Bot step and is unaffected.
  assert.equal((await g.call({ action: 'open', tab: 'd', url: 'https://d.example', source: 'user' })).status, 'ok');
});

test('a still-loading Bot open survives hide, retire, quit and cancels after another Bot step ran on its tab', async () => {
  for (const interrupt of ['hide', 'retire', 'quit', 'cancel', 'targeted']) {
    const f = fixture();
    // The open's first load is dispatched and then held until the interrupt has run;
    // later loads (the quit unload probe) pass straight through.
    let entered, release; const loading = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
    f.browser.electron = { ...f.browser.electron, WebContentsView: class extends View {
      constructor(options) { super(options); const page = this.webContents, load = page.loadURL.bind(page); let first = true;
        page.loadURL = async url => { if (first) { first = false; entered(); await held; } return load(url); }; } } };
    const opening = f.call({ action: 'open', tab: 'a', url: 'https://a.example', requestId: 'open-a' });
    await loading;
    // The Host deadline passed; the Bot reads the same tab while the open still runs.
    f.children[0].webContents.page.observe = { scroll: { x: 0, y: 0 }, elements: [], text: '' };
    assert.equal((await f.call({ action: 'observe', tab: 'a', requestId: 'read-a' })).status, 'ok', interrupt);
    assert.deepEqual(pick((await f.call({ action: 'list' })).tabs.find(tab => tab.tab === 'a'), ['pending', 'current']), { pending: 1, current: null }, 'the open still runs but is no longer current');
    if (interrupt === 'hide') { f.setVisible(false); assert.doesNotThrow(() => f.window.emit('hide')); }
    if (interrupt === 'retire') assert.doesNotThrow(() => f.browser.retire());
    if (interrupt === 'quit') assert.equal(await f.browser.prepareQuit(), true);
    if (interrupt === 'cancel') assert.deepEqual(pick(await f.call({ action: 'cancel', tab: 'a', requestId: 'stop-a' }), ['status', 'cancelled']), { status: 'ok', cancelled: 1 });
    if (interrupt === 'targeted') assert.equal((await f.call({ action: 'cancel', tab: 'a', source: 'user', targetRequestId: 'open-a' })).cancel.outcome, 'too_late');
    // Its navigation was already dispatched: the page stays, nothing is left queued.
    release(); const opened = await opening;
    assert.equal(opened.action, 'open', interrupt); assert.equal(f.children[0].webContents.destroyed, false, interrupt);
    assert.equal(f.browser.stats().tasks, 0, interrupt);
  }
});
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));

test('a typed result is ok only when the text really reached the target; focus taken by the page is reported, never retyped', async () => {
  const f = fixture();
  await f.call({ action: 'open', tab: 't1', url: 'https://example.org', requestId: 'o' });
  await f.layout([{ tab: 't1', x: 0, y: 0, width: 300, height: 300 }]);
  const page = f.children[0].webContents;
  const type = (requestId, text, mode, field, before = 3) => {
    page.page.prepare = { before, sensitive: false }; page.page.field = field; page.calls = [];
    return f.call({ action: 'type', tab: 't1', ref: 'r1.0.1', text, mode, requestId });
  };
  // Field already ends with "c" but did not grow, and the page moved focus: the
  // committed "c" went elsewhere (reproduced in real Electron). Not ok, no DOM retype.
  const stolen = await type('append-stolen', 'c', 'append', { matches: true, length: 3, focused: false });
  assert.deepEqual([stolen.status, stolen.error, stolen.evidence.focusLost], ['unknown', 'focus_lost', true]);
  assert.ok(!page.calls.some(call => call.operation === 'domType'));
  const lost = await type('replace-stolen', 'hello', 'replace', { matches: false, length: 0, focused: false }, 0);
  assert.equal(lost.error, 'focus_lost'); assert.ok(!page.calls.some(call => call.operation === 'domType'));
  // Unfocused frame (focus unchanged inside the page): the DOM fallback still applies.
  let typed = false; page.page.field = () => typed ? { matches: true, length: 4, focused: true } : { matches: false, length: 3, focused: true };
  page.page.domType = () => { typed = true; return { method: 'dom' }; }; page.page.prepare = { before: 3, sensitive: false };
  const fallback = await f.call({ action: 'type', tab: 't1', ref: 'r1.0.1', text: 'd', mode: 'append', requestId: 'append-dom' });
  assert.deepEqual([fallback.status, fallback.evidence.method], ['ok', 'dom']);
  const grown = await type('append-grown', 'c', 'append', { matches: true, length: 4, focused: true });
  assert.deepEqual([grown.status, grown.evidence.method], ['ok', 'ime']);
});

test('Host reset clears only that Host: pages close without prompts, new work is fenced, partitions are cleared without creating new ones', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'tarobot-browser-reset-')), partitions = path.join(root, 'Partitions'), registry = path.join(root, 'registry.json');
  await mkdir(partitions);
  const name = value => partitionFor(value).slice('persist:'.length);
  // Reset fences and purges a Host in every window of the process: use Hosts no other test uses.
  const hostA = { host: 'reset-host-a', user: 'user-1', conversation: 'conv-a' }, notesOnly = { ...hostA, conversation: 'notes-only' }, legacy = { ...hostA, conversation: 'legacy' }, hostB = { host: 'reset-host-b', user: 'user-1', conversation: 'conv-b' };
  // A partition this registry attributes to Host A from an earlier run; its directory exists.
  await mkdir(path.join(partitions, name(legacy)));
  const hash = (await import('node:crypto')).createHash('sha256').update(`tarobot-browser-v1\0${hostA.host}`).digest('hex').slice(0, 32);
  await writeFile(registry, JSON.stringify({ version: 1, partitions: { [name(legacy)]: hash } }));
  const f = fixture({ options: { registry, partitionRoot: partitions } });
  const other = args => f.browser.request('workbench_browser', { scope: hostB, ...args }, () => true), mine = args => f.browser.request('workbench_browser', { scope: hostA, ...args }, () => true);
  await mine({ action: 'open', tab: 'a1', url: 'https://a.example', requestId: 'a1' });
  await mine({ action: 'open', tab: 'a2', url: 'https://a.example/2', restore: true, source: 'user' });
  await other({ action: 'open', tab: 'b1', url: 'https://b.example', requestId: 'b1' });
  const [a1, b1] = f.children.map(view => view.webContents);
  a1.unload = 'prevent'; a1.closeDelay = 30;                              // would normally ask before leaving
  // File IO is queued across windows. Observe the completed atomic write,
  // rather than assuming a busy CI runner flushes it within 20 ms.
  await t.waitFor(async () => assert.equal(JSON.parse(await readFile(registry, 'utf8')).partitions[name(hostA)], hash), { timeout: 2_000 });
  assert.deepEqual(JSON.parse(await readFile(registry, 'utf8')).partitions[name(hostA)], hash);
  const resetting = f.browser.request('workbench_browser_reset', { host: hostA.host, scopes: [hostA, notesOnly] }, () => true);
  const fenced = await mine({ action: 'open', tab: 'a3', url: 'https://a.example/3', requestId: 'a3' });
  assert.deepEqual([fenced.status, fenced.error], ['cancelled', 'scope_resetting']);
  assert.equal((await other({ action: 'open', tab: 'b2', url: 'https://b.example/2', requestId: 'b2' })).status, 'ok', 'another Host is not blocked');
  const result = await resetting;
  assert.deepEqual(result, { closed: 1, cleared: 2, skipped: 1, failed: [] });
  assert.equal(f.sessions.has(partitionFor(notesOnly)), false, 'no session or directory created for a notes-only conversation');
  assert.equal(f.sessions.get(partitionFor(hostA)).cleared, true); assert.equal(f.sessions.get(partitionFor(legacy)).cleared, true);
  assert.equal(f.sessions.get(partitionFor(hostB)).cleared, undefined);
  assert.equal(a1.destroyed, true); assert.equal(b1.destroyed, false);
  assert.deepEqual((await mine({ action: 'list' })).tabs, []);
  assert.deepEqual((await other({ action: 'list' })).tabs.map(tab => tab.tab).sort(), ['b1', 'b2']);
  assert.deepEqual(JSON.parse(await readFile(registry, 'utf8')).partitions, { [name(hostB)]: (await import('node:crypto')).createHash('sha256').update(`tarobot-browser-v1\0${hostB.host}`).digest('hex').slice(0, 32) });
  assert.equal((await mine({ action: 'open', tab: 'a4', url: 'https://a.example/4', requestId: 'a4' })).status, 'ok', 'the fence ends with the reset');
  // A failed clear is reported and stays registered for a retry.
  f.sessions.get(partitionFor(hostA)).clearStorageData = async () => { throw new Error('disk'); };
  const failed = await f.browser.request('workbench_browser_reset', { host: hostA.host, scopes: [hostA] }, () => true);
  assert.deepEqual(failed.failed, [name(hostA)]);
  assert.ok(Object.hasOwn(JSON.parse(await readFile(registry, 'utf8')).partitions, name(hostA)));
  // Strict input; never a browser action a Bot could request.
  assert.throws(() => parseBrowserReset({ host: hostA.host, scopes: [hostB] }), /invalid_browser_reset/);
  assert.throws(() => parseBrowserReset({ host: hostA.host }), /invalid_browser_reset/);
  assert.throws(() => parseBrowserAction({ scope, action: 'reset', requestId: 'r' }), /invalid_browser_args/);
  assert.ok(!BROWSER_ACTIONS.some(action => /reset/.test(action)));
  assert.ok(DESKTOP_COMMANDS.includes('workbench_browser_reset'));
});

test('DesktopServices keeps Host reset behind the migration gate', async () => {
  const window = new EventEmitter();
  Object.assign(window, { isDestroyed: () => false, webContents: { send() {} } });
  const service = new DesktopServices(window, { app: { getLocale: () => 'en' } }, { migration: { ready: false, retire() {} } });
  await assert.rejects(service.request('workbench_browser_reset', { host: 'h', scopes: [] }, () => true), /migration_not_complete/);
  service.migration.ready = true;
  assert.deepEqual(await service.request('workbench_browser_reset', { host: 'h', scopes: [] }, () => true), { closed: 0, cleared: 0, skipped: 0, failed: [] });
  service.dispose();
});

test('a Host reset fences and purges every window, including one created during the reset; other Hosts keep working', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tarobot-browser-reset-windows-')), registry = path.join(root, 'registry.json');
  const hostA = { host: 'windows-host-a', user: 'user-1', conversation: 'conv-a' }, hostB = { host: 'windows-host-b', user: 'user-1', conversation: 'conv-b' };
  const first = fixture({ options: { registry, partitionRoot: path.join(root, 'Partitions') } }), second = fixture({ options: { registry, partitionRoot: path.join(root, 'Partitions') } });
  const ask = (f, target, args) => f.browser.request('workbench_browser', { scope: target, ...args }, () => true);
  await ask(first, hostA, { action: 'open', tab: 'a-first', url: 'https://a.example/1', requestId: '1' });
  await ask(second, hostA, { action: 'open', tab: 'a-second', url: 'https://a.example/2', requestId: '2' });
  await ask(second, hostB, { action: 'open', tab: 'b-second', url: 'https://b.example', requestId: '3' });
  const pageA = second.children[0].webContents, pageB = second.children[1].webContents;
  pageA.closeDelay = 40;                                                    // still closing while we probe the fence
  // Bot work queued in the other window is stopped, not left running against a clearing partition.
  let hold; pageA.page.observe = () => new Promise(resolve => { hold = resolve; });
  const queued = ask(second, hostA, { action: 'observe', tab: 'a-second' });
  await new Promise(resolve => setImmediate(resolve));
  const unlisted = { ...hostA, conversation: 'not-in-layout-yet' };     // open page, scope not passed by the App
  await ask(second, unlisted, { action: 'open', tab: 'a-unlisted', url: 'https://a.example/u', requestId: 'u' });
  const resetting = first.browser.request('workbench_browser_reset', { host: hostA.host, scopes: [hostA] }, () => true);
  const late = fixture({ options: { registry } });                         // a window created during the reset
  const reopen = await ask(late, hostA, { action: 'open', tab: 'a-late', url: 'https://a.example/3', requestId: '4' });
  assert.deepEqual([reopen.status, reopen.error], ['cancelled', 'scope_resetting']);
  assert.deepEqual([(await ask(second, hostA, { action: 'wake', tab: 'a-second', requestId: '5' })).error], ['scope_resetting']);
  assert.equal((await ask(late, hostB, { action: 'open', tab: 'b-late', url: 'https://b.example/2', requestId: '6' })).status, 'ok');
  const result = await resetting; hold?.({ scroll: { x: 0, y: 0 } });
  assert.equal(result.closed, 3); assert.deepEqual(result.failed, []);
  assert.equal(first.sessions.get(partitionFor(unlisted)).cleared, true, 'a captured page partition is cleared without being listed');
  assert.ok(['cancelled', 'failed'].includes((await queued).status), 'the queued step in the other window did not complete');
  assert.equal(pageA.destroyed, true); assert.equal(pageB.destroyed, false);
  for (const f of [first, second, late]) assert.deepEqual((await ask(f, hostA, { action: 'list' })).tabs, []);
  assert.deepEqual((await ask(second, hostB, { action: 'list' })).tabs.map(tab => tab.tab), ['b-second']);
  assert.equal(first.sessions.get(partitionFor(hostA)).cleared, true);
  // The fence ends with the reset in every window; a reused partition is registered again.
  assert.equal((await ask(late, hostA, { action: 'open', tab: 'a-again', url: 'https://a.example/4', requestId: '7' })).status, 'ok');
  await t.waitFor(async () => assert.ok(Object.hasOwn(JSON.parse(await readFile(registry, 'utf8')).partitions, partitionFor(hostA).slice('persist:'.length))), { timeout: 2_000 });
  for (const f of [first, second, late]) f.browser.dispose();
});

test('an unreadable registry is an unresolved reset failure on every attempt and is never discarded', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tarobot-browser-reset-registry-')), registry = path.join(root, 'registry.json');
  const host = { host: 'registry-host', user: 'user-1', conversation: 'conv' }, corrupt = '{"version":1,"partitions":';
  await writeFile(registry, corrupt);                                       // torn write / corrupt file
  const f = fixture({ options: { registry } });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await f.browser.request('workbench_browser_reset', { host: host.host, scopes: [host] }, () => true);
    assert.deepEqual(result.failed, ['registry'], 'unknown attribution is a failure, not an empty registry');
  }
  assert.equal(await readFile(registry, 'utf8'), corrupt, 'the attribution file is kept for recovery');
  // Registration never overwrites it either.
  await f.browser.request('workbench_browser', { scope: host, action: 'open', tab: 'r1', url: 'https://r.example', requestId: 'r1' }, () => true);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await readFile(registry, 'utf8'), corrupt);
  f.browser.dispose();
});


test('personal browser refuses every Bot source and accepts five bounded native surfaces', () => {
  const scope = { host: 'tarobot-personal-browser-v1', user: 'local', conversation: 'personal' };
  for (const action of ['list', 'capabilities', 'observe', 'open', 'screenshot']) for (const source of [undefined, 'bot']) {
    const input = { action, scope, ...(source ? { source } : {}), requestId: 'personal-denied', ...(['list', 'capabilities'].includes(action) ? {} : { tab: 'personal-tab' }) };
    assert.throws(() => parseBrowserAction(input), /browser_user_action_required/);
  }
  assert.equal(parseBrowserAction({ action:'open', scope, source:'user', tab:'personal-tab', requestId:'personal-open' }).source, 'user');
  for (const action of ['observe','selection','screenshot','click','type','press','scroll','select','upload_begin','upload_write','upload','takeover','resume','cancel','reveal','revoke_scope']) {
    const fields = action === 'type' ? {ref:'r1.1.1',text:'text'} : action === 'press' ? {key:'Enter'} : action === 'select' ? {ref:'r1.1.1',values:['one']} : action === 'upload_begin' ? {name:'file.txt',size:0} : action === 'upload_write' ? {upload:'00000000-0000-4000-8000-000000000000',data:''} : action === 'upload' ? {ref:'r1.1.1',files:['00000000-0000-4000-8000-000000000000']} : {};
    const common = ['upload_begin','upload_write','revoke_scope'].includes(action);
    assert.throws(() => parseBrowserAction({action,scope,source:'user',...(common?{}:{tab:'personal-tab'}),requestId:'user-denied',...fields}), /browser_user_action_required/);
  }
  assert.equal(parseBrowserLayout({seq:1,views:Array.from({length:5},(_,i)=>({tab:`t${i}`,x:i*10,y:0,width:10,height:10}))}).views.length,5);
});


test('personal profile is untouched by a Host removal and cleared by its explicit local reset', async () => {
  const scope = { host:'tarobot-personal-browser-v1', user:'local', conversation:'personal' };
  const host = { host:'regular-host', user:'owner', conversation:'chat' };
  const f = fixture();
  const ask = (scope, action, tab) => f.browser.request('workbench_browser', {scope,source:'user',action,...(tab?{tab}:{})}, () => true);
  try {
    await ask(scope,'open','personal'); await ask(host,'open','chat');
    await f.browser.request('workbench_browser_reset',{host:host.host,scopes:[host]},()=>true);
    assert.equal((await ask(scope,'list')).tabs.length,1);
    assert.notEqual(f.sessions.get(partitionFor(scope)).cleared,true);
    const reset=await f.browser.request('workbench_browser_reset',{host:scope.host,scopes:[scope]},()=>true);
    assert.deepEqual(reset.failed,[]); assert.equal((await ask(scope,'list')).tabs.length,0);
    assert.equal(f.sessions.get(partitionFor(scope)).cleared,true);
  } finally { f.browser.dispose(); }
});

test('popup-created tabs cannot evict another conversation or overbook pending page slots', async () => {
  const { BROWSER_LIMITS } = await import('../browser-contract.mjs');
  const f = fixture({options:{limits:{...BROWSER_LIMITS,liveTabs:3}}});
  try {
    await f.call({action:'open',tab:'other-live',scope:other,url:'https://other.example/',source:'user'});
    await f.call({action:'open',tab:'opener',url:'https://opener.example/',source:'user'});
    const opener=f.children.find(view=>view.webContents.url==='https://opener.example/').webContents;
    const popup=Object.assign(new EventEmitter(),{webContents:new Contents({session:opener.session}),show(){},showInactive(){},close(){this.emit('closed');}});
    opener.emit('did-create-window',popup);
    for(let i=0;i<12;i++)popup.webContents.openHandler({url:`https://opener.example/child-${i}`,disposition:'foreground-tab'});
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal((await f.call({action:'list',scope:other})).tabs[0].state,'live');
    const children=(await f.call({action:'list'})).tabs;
    assert.equal(children.length,2,'one free slot is available; the rest need an explicit user decision');
    assert.equal(f.events.filter(event=>event.kind==='sleep').length,0);
    assert.ok(f.events.some(event=>event.kind==='tab-request'&&event.tab==='opener'));
  } finally { f.browser.dispose(); }
});

test('a wake resumed after Host removal cannot restore its partition or attach extensions', async () => {
  const { BROWSER_LIMITS } = await import('../browser-contract.mjs');
  const root=await mkdtemp(path.join(tmpdir(),'tarobot-stale-wake-')),registry=path.join(root,'registry.json'),attached=[];
  const extensions={attach:async(_session,scope)=>{attached.push(scope.host);},ready:async()=>{},observe(){},activated(){},windowClosed(){},forget:async()=>{},clear:async()=>{},refreshCompat:async()=>{}};
  const f=fixture({options:{registry,partitionRoot:path.join(root,'Partitions'),extensions,limits:{...BROWSER_LIMITS,liveTabs:1}}});
  const removed={host:'stale-wake-removed',user:'u',conversation:'a'},kept={host:'stale-wake-kept',user:'u',conversation:'b'};
  try {
    await f.call({action:'open',scope:removed,tab:'victim',url:'https://removed.example/',source:'user'});
    await f.call({action:'sleep',scope:removed,tab:'victim',source:'user'});
    await f.call({action:'open',scope:kept,tab:'other',url:'https://kept.example/',source:'user'});
    f.children.at(-1).webContents.closeDelay=250;
    const wake=f.call({action:'wake',scope:removed,tab:'victim',source:'user'});
    await new Promise(resolve=>setImmediate(resolve));
    const reset=await f.browser.reset({host:removed.host,scopes:[removed]});
    assert.deepEqual(reset.failed,[]);attached.length=0;
    const result=await wake;assert.equal(result.error,'tab_closed');
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(attached.includes(removed.host),false);
    assert.equal(Object.hasOwn(JSON.parse(await readFile(registry,'utf8')).partitions,partitionFor(removed).slice('persist:'.length)),false);
  } finally { f.browser.dispose(); }
});
