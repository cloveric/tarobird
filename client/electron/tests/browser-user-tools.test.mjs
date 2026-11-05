import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkbenchBrowser } from '../browser.mjs';
import { BROWSER_ACTIONS, BROWSER_LIMITS, USER_ONLY, parseBrowserAction } from '../browser-contract.mjs';
import { BrowserUserStore, HISTORY_LIMIT } from '../browser-user-store.mjs';
import { scopeKey } from '../browser-policy.mjs';
import { devicePreview, fitDevice, historyURL, saveName, shortcutCommand, zoomStep } from '../browser-user-tools.mjs';

const scope = { host: 'host-key', user: 'user-1', conversation: 'conv-1' };
const other = { ...scope, conversation: 'conv-2' };
const otherHost = { ...scope, host: 'host-other' };
const TOOLS = ['find', 'stop_find', 'zoom', 'device', 'print', 'save_screenshot', 'history', 'clear_history', 'settings', 'settings_set'];
const SETTINGS = { searchEngine: 'bing', defaultZoom: 1.25, recordHistory: true };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let ids = 500;

class Contents extends EventEmitter {
  constructor(webPreferences) {
    super(); this.id = ++ids; this.webPreferences = webPreferences; this.session = webPreferences?.session; this.url = ''; this.title = ''; this.destroyed = false;
    this.zoom = 1; this.zoomMode = 'default'; this.finds = []; this.stops = []; this.inputs = []; this.prints = []; this.page = {}; this.nextFind = 0;
    this.navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} };
    this.image = { isEmpty: () => false, getSize: () => ({ width: 320, height: 240 }), toPNG: () => Buffer.from('\x89PNG fake') };
  }
  isDestroyed() { return this.destroyed; }
  getURL() { return this.url; } getTitle() { return this.title || this.url; } isLoading() { return false; } isCurrentlyAudible() { return false; }
  getZoomFactor() { return this.zoom; } setZoomFactor(value) { this.zoom = value; } setZoomMode(mode) { this.zoomMode = mode; }
  setWindowOpenHandler() {}
  stop() { this.stopped = true; }
  async loadURL(url, code = 200) {
    this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
    // The beforeunload probe's request is held by the session and never commits.
    if (url.includes('tarobot-unload-probe.invalid')) return;
    await null; this.url = url; this.title = '';
    this.emit('did-navigate', {}, url, code); this.emit('dom-ready'); this.emit('did-stop-loading');
  }
  findInPage(text, options) { const id = this.nextFind++; this.finds.push({ id, text, ...options }); return id; }
  stopFindInPage(action) { this.stops.push(action); }
  print(options, callback) { this.prints.push({ options, callback }); }
  async printToPDF() { return this.pdf ?? Buffer.from('%PDF-1.7 fake'); }
  async capturePage() { if (this.captureHook) await this.captureHook(); return this.image; }
  sendInputEvent(event) { this.inputs.push(event); }
  async executeJavaScriptInIsolatedWorld(_world, [{ code }]) {
    const operation = /return \(function (\w+)\(/.exec(code)?.[1], reply = this.page[operation];
    const args = JSON.parse(/\}\)\(lib, (.*)\); \}\)\(\)$/s.exec(code)[1]);
    return typeof reply === 'function' ? reply(args) : reply ?? {};
  }
  close() { if (!this.destroyed) { this.destroyed = true; this.emit('destroyed'); } }
}
class View { constructor({ webPreferences, webContents } = {}) { this.webContents = webContents ?? new Contents(webPreferences); } setBounds(bounds) { this.bounds = bounds; } setVisible(value) { this.shown = value; } setBackgroundColor() {} }

async function fixture({ root, saves = [], platform = 'darwin', limits } = {}) {
  const directory = root ?? await mkdtemp(path.join(tmpdir(), 'tarobot-page-tools-'));
  const window = new EventEmitter(), events = [], sessions = new Map(), dialogs = [];
  let visible = true;
  Object.assign(window, { isVisible: () => visible, isMinimized: () => false, isDestroyed: () => false, show() { visible = true; }, isFullScreen: () => false, setFullScreen() {},
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), webContents: { getZoomFactor: () => 1, send() {}, focus() { window.focused = (window.focused ?? 0) + 1; } },
    contentView: { addChildView() {}, removeChildView() {} } });
  const session = { fromPartition(name) {
    if (!sessions.has(name)) sessions.set(name, Object.assign(new EventEmitter(), { webRequest: { onBeforeRequest() {} }, getUserAgent: () => 'Mozilla/5.0 Chrome/140 Safari/537.36', setUserAgent() {},
      setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, setDevicePermissionHandler() {}, setDisplayMediaRequestHandler() {},
      clearStorageData: async () => {}, clearCache: async () => {}, clearAuthCache: async () => {}, clearHostResolverCache: async () => {} }));
    return sessions.get(name);
  } };
  const created = [];
  class TrackedView extends View { constructor(options) { super(options); created.push(this); } }
  const electron = { WebContentsView: TrackedView, session, app: { getLocale: () => 'zh-CN', getPath: () => directory },
    dialog: { showMessageBoxSync: () => 0, showMessageBox: async () => ({ response: 0 }),
      showSaveDialog: async (_window, options) => { dialogs.push(options); const next = saves.shift(); return typeof next === 'function' ? next(options) : next ?? { canceled: true, filePath: '' }; } },
    shell: {}, Menu: {}, clipboard: {} };
  const browser = new WorkbenchBrowser(window, electron, { emit: payload => events.push(payload), platform, ...(limits ? { limits } : {}), registry: path.join(directory, 'workbench-browser-partitions.json'), partitionRoot: path.join(directory, 'Partitions') });
  let seq = 0;
  const call = (args, active = () => true) => browser.request('workbench_browser', { scope, source: 'user', requestId: `u${++seq}`, ...args }, active);
  const bot = args => browser.request('workbench_browser', { scope, requestId: `b${++seq}`, ...args }, () => true);
  const layout = (views, extra = {}) => browser.request('workbench_browser_layout', { seq: ++seq, views, ...extra }, () => true);
  // The View created while opening or waking a Tab is that Tab's page.
  const views = new Map();
  const install = async (tab, args) => { const before = created.length, result = await call({ tab, ...args }); if (created.length > before) views.set(tab, created.at(-1)); return result; };
  const open = (tab, url = 'https://example.org/', extra = {}) => install(tab, { action: 'open', url, ...extra });
  const wake = tab => install(tab, { action: 'wake' });
  const contents = tab => views.get(tab)?.webContents, view = tab => views.get(tab);
  return { browser, window, events, call, bot, layout, open, wake, contents, view, directory, dialogs, saves, setVisible: value => { visible = value; } };
}

test('page tools are trusted-UI only, listed in capabilities, and Bot key presses cannot reach their shortcuts', async () => {
  for (const action of TOOLS) {
    assert.ok(USER_ONLY.has(action) && BROWSER_ACTIONS.includes(action), action);
    const input = { scope, action, requestId: 'r', ...(['history', 'clear_history', 'settings', 'settings_set'].includes(action) ? {} : { tab: 't1' }),
      ...(action === 'find' ? { text: 'x' } : action === 'zoom' ? { factor: 1.5 } : action === 'device' ? { preset: 'phone' } : action === 'settings_set' ? { settings: SETTINGS } : {}) };
    assert.throws(() => parseBrowserAction(input), /browser_user_action_required/, action);
    assert.doesNotThrow(() => parseBrowserAction({ ...input, source: 'user' }), action);
  }
  for (const [key, modifiers] of [['p', ['meta']], ['F', ['control']], ['0', ['meta']], ['f', ['shift', 'control']], ['g', ['meta']], ['G', ['shift', 'meta']]])
    assert.throws(() => parseBrowserAction({ scope, tab: 't1', action: 'press', requestId: 'r', key, modifiers }), /browser_user_action_required/, `${modifiers}+${key}`);
  assert.doesNotThrow(() => parseBrowserAction({ scope, tab: 't1', action: 'press', requestId: 'r', key: 'a', modifiers: ['meta'] }));
  assert.doesNotThrow(() => parseBrowserAction({ scope, tab: 't1', action: 'press', requestId: 'r', key: 'p' }));
  // Strict shapes: no renderer path, full settings, bounded values.
  for (const bad of [{ action: 'save_screenshot', tab: 't1', path: '/tmp/x.png' }, { action: 'print', tab: 't1', mode: 'silent' }, { action: 'zoom', tab: 't1', factor: 5 },
    { action: 'find', tab: 't1', text: '' }, { action: 'find', tab: 't1', text: 'x'.repeat(1025) }, { action: 'device', tab: 't1', preset: 'watch' },
    { action: 'settings_set', settings: { searchEngine: 'google', defaultZoom: 1 } }, { action: 'settings_set', settings: { ...SETTINGS, defaultZoom: 0.1 } },
    { action: 'history', limit: 501 }, { action: 'history', query: 'x'.repeat(257) }])
    assert.throws(() => parseBrowserAction({ scope, source: 'user', ...bad }), /invalid_browser_args/, JSON.stringify(bad).slice(0, 80));
  const f = await fixture();
  const capabilities = await f.call({ action: 'capabilities' });
  for (const action of TOOLS) assert.ok(capabilities.actions.includes(action), action);
  await assert.rejects(f.bot({ action: 'history' }), /browser_user_action_required/);
});

test('history URLs drop fragments and refuse credentials, secret-bearing queries and non-web pages', () => {
  assert.equal(historyURL('https://example.org/a?q=hello+world#section'), 'https://example.org/a?q=hello+world');
  assert.equal(historyURL('https://www.google.com/search?q=token+rings'), 'https://www.google.com/search?q=token+rings');
  for (const url of ['https://u:p@example.org/', 'https://example.org/cb?code=abc&state=1', 'https://example.org/?access_token=x', 'https://example.org/?id_token=x',
    'https://example.org/reset?password=x', 'https://s3.example.org/f?X-Amz-Signature=x', 'https://example.org/?client_secret=x', 'https://example.org/?sessionid=1',
    'about:blank', 'blob:https://example.org/uuid', 'data:text/html,x', 'file:///etc/hosts', `https://example.org/${'a'.repeat(2100)}`])
    assert.equal(historyURL(url), undefined, url.slice(0, 60));
});

test('zoom steps, device letterbox, shortcuts and save names are deterministic', () => {
  assert.equal(zoomStep(1, 1), 1.1); assert.equal(zoomStep(1, -1), 0.9); assert.equal(zoomStep(3, 1), 3); assert.equal(zoomStep(0.25, -1), 0.25); assert.equal(zoomStep(1.12, 1), 1.25);
  const fitted = fitDevice({ x: 100, y: 50, width: 400, height: 600 }, { width: 390, height: 844 });
  assert.equal(fitted.height, 600); assert.equal(fitted.width, Math.round(390 * 600 / 844)); assert.ok(fitted.x >= 100 && fitted.x + fitted.width <= 500);
  assert.ok(Math.abs(fitted.scale - fitted.width / 390) < 1e-9);
  assert.deepEqual(fitDevice({ x: 0, y: 0, width: 2000, height: 2000 }, { width: 390, height: 844 }), { x: 805, y: 578, width: 390, height: 844, scale: 1 });
  assert.deepEqual(devicePreview({ preset: 'tablet', landscape: true }, 0.5), { preset: 'tablet', landscape: true, width: 1024, height: 768, scale: 0.5 });
  assert.deepEqual(devicePreview(undefined), { preset: 'desktop', landscape: false, width: 0, height: 0, scale: 1 });
  const key = (key, extra = {}) => ({ type: 'keyDown', key, meta: false, control: false, alt: false, shift: false, ...extra });
  assert.equal(shortcutCommand(key('f', { meta: true }), 'darwin'), 'find');
  assert.equal(shortcutCommand(key('f', { control: true }), 'darwin'), undefined);
  assert.equal(shortcutCommand(key('p', { control: true }), 'win32'), 'print');
  assert.equal(shortcutCommand(key('=', { meta: true }), 'darwin'), 'zoom_in');
  assert.equal(shortcutCommand(key('-', { meta: true }), 'darwin'), 'zoom_out');
  assert.equal(shortcutCommand(key('0', { meta: true }), 'darwin'), 'zoom_reset');
  assert.equal(shortcutCommand({ ...key('f', { meta: true }), type: 'keyUp' }), undefined);
  assert.equal(shortcutCommand(key('f', { meta: true, alt: true }), 'darwin'), undefined);
  // Find next/previous and Escape belong to the page unless a find session is active.
  assert.equal(shortcutCommand(key('g', { meta: true }), 'darwin'), undefined);
  assert.equal(shortcutCommand(key('g', { meta: true }), 'darwin', true), 'find_next');
  assert.equal(shortcutCommand(key('G', { meta: true, shift: true }), 'darwin', true), 'find_prev');
  assert.equal(shortcutCommand(key('g', { control: true }), 'win32', true), 'find_next');
  assert.equal(shortcutCommand(key('Escape'), 'darwin'), undefined);
  assert.equal(shortcutCommand(key('Escape'), 'darwin', true), 'escape');
  assert.equal(shortcutCommand(key('Escape', { meta: true }), 'darwin', true), undefined);
  const name = saveName('a/b:c*?"<>| \x07 .hidden', 'https://example.org/', 'png', new Date(2026, 9, 31, 9, 5, 7));
  assert.equal(name, 'a b c .hidden 2026-10-31 09.05.07.png'); assert.ok(!/[\\/:*?"<>|]/.test(name.replace(/\.png$/, '')));
  assert.match(saveName('', 'https://docs.example.org/x', 'pdf'), /^docs\.example\.org \d{4}-/);
});

test('history store: bounded, per scope, honours recording off, and a clear or Host reset cannot be revived by late events', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tarobot-history-'));
  let now = 1000;
  const store = new BrowserUserStore(root, { now: () => ++now, debounceMs: 5 });
  const ticket = store.ticket(scope);
  for (let i = 0; i < HISTORY_LIMIT + 20; i++) await store.record(ticket, { url: `https://example.org/${i}`, title: `Page ${i}` });
  const again = await store.record(ticket, { url: 'https://example.org/3', title: 'Again' });
  const listed = await store.list(scope, { limit: 500 });
  assert.equal(listed.length, HISTORY_LIMIT); assert.equal(listed[0].url, 'https://example.org/3'); assert.equal(listed[0].id, again);
  assert.equal(listed.filter(entry => entry.url === 'https://example.org/3').length, 1, 'a revisit moves to the top instead of duplicating');
  assert.deepEqual(Object.keys(listed[0]).sort(), ['id', 'title', 'url', 'visitedAt']);
  assert.equal((await store.list(scope, { query: 'page 51', limit: 10 }))[0]?.title, 'Page 519');
  assert.equal((await store.list(other)).length, 0, 'another conversation has its own history');
  await store.flush();
  // Persisted with private permissions and read back by a fresh store (another launch).
  const files = await readdir(path.join(root, 'v1'), { recursive: true });
  assert.ok(files.some(file => file.endsWith('.history.json')));
  assert.equal((await new BrowserUserStore(root).list(scope, { limit: 500 })).length, HISTORY_LIMIT);
  // Late record/retitle on a ticket taken before the clear are dropped.
  const stale = store.ticket(scope), id = listed[0].id;
  assert.equal(await store.clear(scope), HISTORY_LIMIT);
  assert.equal(await store.record(stale, { url: 'https://late.example.org/', title: 'Late' }), undefined);
  await store.retitle(stale, id, 'Revived'); await store.flush();
  assert.deepEqual(await store.list(scope), []);
  assert.deepEqual(await new BrowserUserStore(root).list(scope), [], 'the file is gone too');
  // Recording off for this scope only.
  await store.setSettings(scope, { ...SETTINGS, recordHistory: false });
  assert.equal(await store.record(store.ticket(scope), { url: 'https://off.example.org/', title: '' }), undefined);
  assert.ok(await store.record(store.ticket(other), { url: 'https://on.example.org/', title: '' }));
  assert.deepEqual(await new BrowserUserStore(root).settings(scope), { ...SETTINGS, recordHistory: false });
  assert.deepEqual(await new BrowserUserStore(root).settings(other), { searchEngine: 'google', defaultZoom: 1, recordHistory: true });
  await assert.rejects(store.setSettings(scope, { ...SETTINGS, searchEngine: 'evil' }), /invalid_browser_args/);
  // Host reset removes only that Host's metadata, including pending writes.
  const keep = store.ticket(otherHost); await store.record(keep, { url: 'https://keep.example.org/', title: 'Keep' });
  const pending = store.ticket(other); await store.record(pending, { url: 'https://pending.example.org/', title: '' });
  await store.flush(); await store.record(pending, { url: 'https://unflushed.example.org/', title: '' });
  await store.purgeHost(scope.host); await delay(20); await store.flush();
  const fresh = new BrowserUserStore(root);
  assert.deepEqual(await fresh.list(other), []); assert.deepEqual(await fresh.settings(scope), { searchEngine: 'google', defaultZoom: 1, recordHistory: true });
  assert.equal((await fresh.list(otherHost))[0]?.url, 'https://keep.example.org/');
});

// Released histories are recognised by content written to disk behind the store's back.
async function historyFile(root, s) {
  const name = `${scopeKey(s)}.history.json`;
  const found = (await readdir(path.join(root, 'v1'), { recursive: true })).find(file => path.basename(file) === name);
  assert.ok(found, 'history file exists'); return path.join(root, 'v1', found);
}
const diskEntry = { id: 'disk', url: 'https://disk.example.org/', title: 'disk', visitedAt: 1 };
const spill = async (store, count, tag, flush = true) => { for (let i = 0; i < count; i++) await store.record(store.ticket({ ...scope, conversation: `${tag}-${i}` }), { url: `https://example.org/${tag}/${i}`, title: '' }); if (flush) await store.flush(); };

test('idle, saved histories leave memory and are read back from disk; the most recently used stay cached', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tarobot-history-idle-'));
  const store = new BrowserUserStore(root, { debounceMs: 5, idleHistories: 2 });
  const scopes = Array.from({ length: 6 }, (_, i) => ({ ...scope, conversation: `idle-${i}` }));
  for (const s of scopes) await store.record(store.ticket(s), { url: `https://example.org/${s.conversation}`, title: s.conversation });
  await store.flush();
  for (const s of scopes) await writeFile(await historyFile(root, s), JSON.stringify({ version: 1, entries: [diskEntry] }));
  const reloaded = []; for (const s of [...scopes].reverse()) reloaded.push((await store.list(s))[0]?.id === 'disk');
  assert.deepEqual(reloaded, [false, false, true, true, true, true]);
});

test('a released history keeps live tickets valid and never loses saved or unsaved visits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tarobot-history-live-'));
  const store = new BrowserUserStore(root, { debounceMs: 5, idleHistories: 1 });
  const live = store.ticket(scope), first = await store.record(live, { url: 'https://example.org/first', title: 'First' });
  await store.flush(); await spill(store, 3, 'released');
  // The tab's ticket from before the release still retitles and records.
  await store.retitle(live, first, 'Renamed');
  assert.ok(await store.record(live, { url: 'https://example.org/second', title: 'Second' }));
  await store.flush(); await spill(store, 3, 'again');
  assert.deepEqual((await new BrowserUserStore(root).list(scope)).map(e => [e.url, e.title]), [['https://example.org/second', 'Second'], ['https://example.org/first', 'Renamed']]);
  assert.equal((await store.list(scope)).length, 2, 'released, then read back intact');
  // Unsaved changes are never released, however many other histories are used meanwhile.
  const slow = await mkdtemp(path.join(tmpdir(), 'tarobot-history-unsaved-'));
  const unsaved = new BrowserUserStore(slow, { debounceMs: 60_000, idleHistories: 1 });
  for (let i = 0; i < 5; i++) await unsaved.record(unsaved.ticket({ ...scope, conversation: `unsaved-${i}` }), { url: `https://example.org/u${i}`, title: '' });
  await unsaved.flush();
  for (let i = 0; i < 5; i++) assert.equal((await new BrowserUserStore(slow).list({ ...scope, conversation: `unsaved-${i}` }))[0]?.url, `https://example.org/u${i}`);
  // A visit still awaiting its settings read survives a release of other histories.
  const held = await mkdtemp(path.join(tmpdir(), 'tarobot-history-held-'));
  const inflight = new BrowserUserStore(held, { debounceMs: 5, idleHistories: 1 }), settings = inflight.settings.bind(inflight);
  let open; const gate = new Promise(resolve => { open = resolve; });
  inflight.settings = s => scopeKey(s) === scopeKey(scope) ? gate.then(() => settings(s)) : settings(s);
  const pending = inflight.record(inflight.ticket(scope), { url: 'https://example.org/held', title: '' });
  // flush() would wait for the held visit; let the other histories save on their own.
  await spill(inflight, 3, 'meanwhile', false); await delay(50); open();
  assert.ok(await pending); await inflight.flush();
  assert.equal((await new BrowserUserStore(held).list(scope))[0]?.url, 'https://example.org/held');
});

test('clearing or resetting a released history still retires its old tickets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tarobot-history-retire-'));
  const store = new BrowserUserStore(root, { debounceMs: 5, idleHistories: 1 });
  const stale = store.ticket(scope), id = await store.record(stale, { url: 'https://example.org/old', title: 'Old' });
  await store.flush(); await spill(store, 3, 'before-clear');
  assert.equal(await store.clear(scope), 1, 'the released history is counted from disk');
  assert.equal(await store.record(stale, { url: 'https://late.example.org/', title: '' }), undefined);
  await store.retitle(stale, id, 'Revived'); await store.flush(); await spill(store, 3, 'after-clear');
  assert.deepEqual(await store.list(scope), []); assert.deepEqual(await new BrowserUserStore(root).list(scope), []);
  const hosted = { ...scope, host: 'host-released' }, before = store.ticket(hosted);
  await store.record(before, { url: 'https://example.org/hosted', title: '' }); await store.flush(); await spill(store, 3, 'before-reset');
  await store.purgeHost(hosted.host);
  assert.equal(await store.record(before, { url: 'https://late.example.org/hosted', title: '' }), undefined);
  await store.flush();
  assert.deepEqual(await new BrowserUserStore(root).list(hosted), []);
});

test('a corrupted store layout (a file where a directory belongs) fails closed for settings and history, and is read again once repaired', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tarobot-settings-'));
  await writeFile(path.join(root, 'v1'), 'not a directory');
  const store = new BrowserUserStore(root);
  await assert.rejects(store.setSettings(scope, SETTINGS), 'a failed write');
  await assert.rejects(store.settings(scope), /settings_unavailable/, 'ENOTDIR is not "never saved"');
  // A saved "recording off" behind a corrupted parent must not turn into the default "on".
  const saved = await mkdtemp(path.join(tmpdir(), 'tarobot-enotdir-'));
  await new BrowserUserStore(saved).setSettings(scope, { ...SETTINGS, recordHistory: false });
  const host = path.join(saved, 'v1', (await readdir(path.join(saved, 'v1')))[0]);
  await rename(host, `${host}.moved`); await writeFile(host, 'not a directory');
  const broken = new BrowserUserStore(saved);
  await assert.rejects(broken.settings(scope), /settings_unavailable/);
  assert.equal(await broken.record(broken.ticket(scope), { url: 'https://private.example.org/', title: '' }), undefined);
  await assert.rejects(broken.list(scope), /history_unavailable/);
  // Repaired on disk: the same store reads again (no failure is cached).
  await (await import('node:fs/promises')).rm(host); await rename(`${host}.moved`, host);
  assert.deepEqual(await broken.settings(scope), { ...SETTINGS, recordHistory: false });
  assert.deepEqual(await broken.list(scope), []);
});

test('unknown settings fail closed: no history is recorded and the settings read reports it until a save repairs it', async () => {
  for (const damage of ['directory', 'malformed']) {
    const root = await mkdtemp(path.join(tmpdir(), `tarobot-settings-${damage}-`));
    await new BrowserUserStore(root).setSettings(scope, { ...SETTINGS, recordHistory: false });
    const host = path.join(root, 'v1', (await readdir(path.join(root, 'v1')))[0]), file = path.join(host, (await readdir(host)).find(name => name.endsWith('.settings.json')));
    if (damage === 'directory') { await rename(file, `${file}.original`); await mkdir(file); } else await writeFile(file, '{"version":1,"settings":{"searchEngine":"bing"');
    const store = new BrowserUserStore(root);
    await assert.rejects(store.settings(scope), /settings_unavailable/, damage);
    assert.equal(await store.record(store.ticket(scope), { url: 'https://private.example.org/', title: '' }), undefined, `${damage}: a possibly disabled history is not recorded`);
    assert.deepEqual(await store.list(scope), []);
    if (damage === 'malformed') {
      assert.deepEqual(await store.setSettings(scope, SETTINGS), SETTINGS, 'a complete save repairs the file');
      assert.deepEqual(await new BrowserUserStore(root).settings(scope), SETTINGS);
      assert.ok(await store.record(store.ticket(scope), { url: 'https://after.example.org/', title: '' }));
    }
  }
  const f = await fixture();
  await f.call({ action: 'settings_set', settings: SETTINGS });
  const v1 = path.join(f.directory, 'workbench-browser-user', 'v1'), host = path.join(v1, (await readdir(v1))[0]);
  const file = path.join(host, (await readdir(host)).find(name => name.endsWith('.settings.json')));
  await rename(file, `${file}.original`); await mkdir(file);
  const fresh = new WorkbenchBrowser(f.window, { ...f.browser.electron }, { emit() {}, store: new BrowserUserStore(path.join(f.directory, 'workbench-browser-user')) });
  const read = await fresh.request('workbench_browser', { scope, source: 'user', action: 'settings' }, () => true);
  assert.deepEqual([read.status, read.error], ['failed', 'settings_unavailable']);
});

test('a settings save that started before a Host reset cannot restore that Host\'s settings', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tarobot-settings-race-'));
  const store = new BrowserUserStore(root), settings = store.settings.bind(store);
  let release, first = true; const gate = new Promise(resolve => { release = resolve; });
  store.settings = async (...args) => { const value = await settings(...args).catch(() => undefined); if (first) { first = false; await gate; } return value; };
  const pending = store.setSettings(scope, { ...SETTINGS, recordHistory: false });
  await new Promise(resolve => setImmediate(resolve));
  await store.purgeHost(scope.host); release();
  await assert.rejects(pending, /scope_reset/);
  await store.flush();
  assert.deepEqual(await new BrowserUserStore(root).settings(scope), { searchEngine: 'google', defaultZoom: 1, recordHistory: true });
  assert.deepEqual(await readdir(path.join(root, 'v1')).catch(() => []), [], 'nothing written after the reset');
  // A save after the reset is a new decision and is kept.
  delete store.settings;
  assert.deepEqual(await store.setSettings(scope, SETTINGS), SETTINGS);
});

test('native reset fences settings: a save during the reset is refused, one started before it cannot write afterwards', async () => {
  const f = await fixture();
  const root = path.join(f.directory, 'gated-store'), store = new BrowserUserStore(root), read = store.settings.bind(store);
  let release, hold = true; const gate = new Promise(resolve => { release = resolve; });
  store.settings = async (...args) => { const value = read(...args); if (hold) { hold = false; await gate; } return value; };
  const events = [], browser = new WorkbenchBrowser(f.window, f.browser.electron, { emit: payload => events.push(payload), store });
  const set = settings => browser.request('workbench_browser', { scope, source: 'user', action: 'settings_set', settings }, () => true);
  const before = set({ ...SETTINGS, recordHistory: false });
  await new Promise(resolve => setImmediate(resolve));
  const reset = browser.request('workbench_browser_reset', { host: scope.host, scopes: [scope] }, () => true);
  const during = await set(SETTINGS);
  assert.deepEqual([during.status, during.error], ['cancelled', 'scope_resetting'], 'queued behind the reset fence');
  assert.deepEqual((await reset).failed, []);
  release();
  const late = await before;
  assert.deepEqual([late.status, late.error], ['cancelled', 'scope_reset']);
  assert.ok(!events.some(event => event.kind === 'settings'), 'no settings broadcast for a refused save');
  await store.flush();
  assert.deepEqual(await readdir(path.join(root, 'v1')).catch(() => []), [], 'the reset Host has no metadata on disk');
  assert.deepEqual((await browser.request('workbench_browser', { scope, source: 'user', action: 'settings' }, () => true)).settings, { searchEngine: 'google', defaultZoom: 1, recordHistory: true });
  browser.dispose();
});

test('reads during a Host purge wait for its removal, including overlapping purges; other Hosts are unaffected', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tarobot-purge-barrier-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new BrowserUserStore(root, { debounceMs: 5 }), defaults = { searchEngine: 'google', defaultZoom: 1, recordHistory: true };
  await store.setSettings(scope, { ...SETTINGS, recordHistory: false });
  await store.setSettings(otherHost, SETTINGS);
  const ticket = store.ticket(other);
  for (let index = 0; index < 50; index++) await store.record(ticket, { url: `https://example.org/${index}`, title: 'page' });
  // The shared writer is busy, so the removal waits in the queue. Overlapping
  // purges of the same Host; reads that start meanwhile must not load and cache
  // the files about to be deleted (e.g. an in-flight navigation's settings read).
  const flushing = store.flush(), first = store.purgeHost(scope.host), second = store.purgeHost(scope.host);
  const settings = store.settings(scope), history = store.list(other), isolated = store.settings(otherHost);
  await Promise.all([flushing, first, second]);
  assert.deepEqual(await settings, defaults);
  assert.deepEqual(await history, []);
  assert.deepEqual(await isolated, SETTINGS, 'another Host is neither purged nor held');
  assert.deepEqual(await store.settings(scope), defaults, 'nothing purged remains cached');
  assert.deepEqual(await new BrowserUserStore(root).settings(otherHost), SETTINGS);
});

// The Host reset check below uses real POSIX permission denial. Windows ACLs
// and a root user bypass mode bits, so it runs only where that applies.
const noPermissionDenial = process.platform === 'win32' || process.getuid?.() === 0;
const hostMetadata = (root, host) => path.join(root, 'v1', createHash('sha256').update(`tarobot-browser-user-v1\0${host}`).digest('hex').slice(0, 32));

test('overlapping purges: the first removal cannot release reads held for the second, and a failed removal is reported without holding reads', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tarobot-purge-overlap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Controlled I/O: each removal waits until the test settles it.
  const removals = [], defaults = { searchEngine: 'google', defaultZoom: 1, recordHistory: true };
  const store = new BrowserUserStore(root, { remove: directory => new Promise((resolve, reject) => removals.push({ directory, resolve, reject })) });
  const until = async check => { for (let index = 0; index < 200 && !check(); index++) await new Promise(resolve => setImmediate(resolve)); assert.ok(check()); };
  await store.setSettings(scope, SETTINGS);
  const first = store.purgeHost(scope.host), second = store.purgeHost(scope.host);
  await until(() => removals.length === 1);
  removals[0].resolve(); await first;
  await until(() => removals.length === 2);
  // The file is still on disk and the second removal is pending.
  let answered = false;
  const read = store.settings(scope).then(value => { answered = true; return value; });
  await delay(50);
  assert.equal(answered, false, 'the finished first purge must not release the second purge\'s barrier');
  await rm(removals[1].directory, { recursive: true, force: true }); removals[1].resolve(); await second;
  assert.deepEqual(await read, defaults);
  // A removal that fails is reported to the caller; it is not a completed purge.
  await store.setSettings(scope, SETTINGS);
  const failing = store.purgeHost(scope.host);
  await until(() => removals.length === 3);
  removals[2].reject(new Error('removal_denied'));
  await assert.rejects(failing, /removal_denied/);
  assert.deepEqual(await store.settings(scope), SETTINGS, 'later reads answer from what remains instead of waiting or hiding it');
});

test('a Host reset whose browser metadata cannot be removed reports it as failed, and a retry clears it', { skip: noPermissionDenial && 'POSIX permission denial unavailable' }, async t => {
  const f = await fixture(), defaults = { searchEngine: 'google', defaultZoom: 1, recordHistory: true };
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  await f.call({ action: 'settings_set', settings: SETTINGS });
  const hostDirectory = hostMetadata(path.join(f.directory, 'workbench-browser-user'), scope.host);
  await chmod(hostDirectory, 0o500);
  try {
    const reset = await f.browser.request('workbench_browser_reset', { host: scope.host, scopes: [scope] }, () => true);
    assert.ok(reset.failed.includes('history'), 'an incomplete removal is not reported as a cleared Host');
  } finally { await chmod(hostDirectory, 0o700); }
  assert.deepEqual((await f.call({ action: 'settings' })).settings, SETTINGS, 'the retained file is still visible, not hidden as defaults');
  const retry = await f.browser.request('workbench_browser_reset', { host: scope.host, scopes: [scope] }, () => true);
  assert.deepEqual(retry.failed, []);
  assert.deepEqual((await f.call({ action: 'settings' })).settings, defaults);
});

test('zoom is per page, isolated from same-site pages, invalidates Bot refs and survives sleep; default zoom applies only to new or woken pages', async () => {
  const f = await fixture();
  await f.call({ action: 'settings_set', settings: { ...SETTINGS, defaultZoom: 1.5 } });
  await f.open('a'); await f.open('b');
  const a = f.contents('a'), b = f.contents('b');
  assert.equal(a.webPreferences.zoomMode, 'isolated'); assert.equal(a.zoomMode, 'isolated');
  assert.equal(a.zoom, 1.5, 'new pages start at the scope default');
  const zoomed = await f.call({ action: 'zoom', tab: 'a', factor: 2 });
  assert.equal(zoomed.status, 'ok'); assert.equal(zoomed.zoomFactor, 2); assert.equal(a.zoom, 2); assert.equal(b.zoom, 1.5);
  assert.ok(f.events.some(event => event.kind === 'state' && event.tab === 'a' && event.zoomFactor === 2));
  // Changing the default does not move open pages.
  await f.call({ action: 'settings_set', settings: { ...SETTINGS, defaultZoom: 0.8 } });
  assert.equal(a.zoom, 2); assert.equal(b.zoom, 1.5);
  // A Bot ref taken before the zoom is stale afterwards.
  await f.layout([{ tab: 'b', x: 400, y: 60, width: 600, height: 500 }]);
  b.page.observe = args => ({ url: b.url, title: '', viewport: { width: 600, height: 500 }, scroll: { x: 0, y: 0 }, text: '', elements: [{ ref: `${args.prefix}1` }] });
  const ref = (await f.bot({ action: 'observe', tab: 'b' })).observation.elements[0].ref;
  await f.call({ action: 'zoom', tab: 'b', factor: 1 });
  assert.equal((await f.bot({ action: 'click', tab: 'b', ref })).error, 'stale_ref');
  // Sleep and wake keep the person's zoom; an untouched page takes the current default.
  await f.layout([]);
  assert.equal((await f.call({ action: 'sleep', tab: 'a' })).status, 'ok');
  await f.wake('a');
  assert.equal(f.contents('a').zoom, 2); assert.equal(f.contents('a').zoomMode, 'isolated');
  await f.open('c');
  assert.equal(f.contents('c').zoom, 0.8);
  assert.equal((await f.call({ action: 'list' })).tabs.find(tab => tab.tab === 'a').zoomFactor, 2);
  // Keyboard zoom on the focused page, never from Bot-synthesized input.
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  f.contents('c').emit('before-input-event', event, { type: 'keyDown', key: '=', meta: true, control: false, alt: false, shift: false });
  assert.ok(event.prevented); assert.equal(f.contents('c').zoom, 0.9);
});

test('device preview letterboxes the page, keeps the CSS viewport at the device size and keeps Bot clicks on target', async () => {
  const f = await fixture();
  await f.open('p'); const page = f.contents('p');
  const pane = { tab: 'p', x: 400, y: 60, width: 400, height: 600 };
  await f.layout([pane]);
  const preview = await f.call({ action: 'device', tab: 'p', preset: 'phone' });
  assert.equal(preview.status, 'ok'); assert.deepEqual([preview.devicePreview.preset, preview.devicePreview.width, preview.devicePreview.height], ['phone', 390, 844]);
  const bounds = f.view('p').bounds, scale = bounds.width / 390;
  assert.equal(bounds.height, 600); assert.ok(bounds.x > pane.x && bounds.x + bounds.width < pane.x + pane.width, JSON.stringify(bounds));
  assert.ok(Math.abs(preview.devicePreview.scale - scale) < 1e-3);
  assert.ok(Math.abs(page.zoom - scale) < 1e-9, 'effective zoom = person zoom × preview scale: CSS viewport stays 390 wide');
  await f.call({ action: 'zoom', tab: 'p', factor: 1.5 });
  assert.ok(Math.abs(page.zoom - 1.5 * scale) < 1e-9);
  // A Bot click maps the CSS point with the live zoom into the letterboxed view.
  page.page.observe = args => ({ url: page.url, title: '', viewport: { width: 260, height: 563 }, scroll: { x: 0, y: 0 }, text: '', elements: [{ ref: `${args.prefix}1` }] });
  page.page.prepare = { x: 100, y: 200, target: 'button' }; page.page.settle = { delivered: true };
  const ref = (await f.bot({ action: 'observe', tab: 'p' })).observation.elements[0].ref;
  const clicked = await f.bot({ action: 'click', tab: 'p', ref });
  assert.equal(clicked.status, 'ok');
  const down = page.inputs.find(input => input.type === 'mouseDown');
  assert.deepEqual([down.x, down.y], [Math.round(100 * page.zoom), Math.round(200 * page.zoom)]);
  // A smaller pane rescales the same preview without changing the CSS viewport.
  await f.layout([{ ...pane, height: 300 }]);
  assert.equal(f.view('p').bounds.height, 300); assert.ok(Math.abs(page.zoom - 1.5 * f.view('p').bounds.width / 390) < 1e-9);
  const landscape = await f.call({ action: 'device', tab: 'p', preset: 'tablet', landscape: true });
  assert.deepEqual([landscape.devicePreview.width, landscape.devicePreview.height, landscape.devicePreview.landscape], [1024, 768, true]);
  const off = await f.call({ action: 'device', tab: 'p', preset: 'desktop' });
  assert.deepEqual(off.devicePreview, { preset: 'desktop', landscape: false, width: 0, height: 0, scale: 1 });
  assert.equal(page.zoom, 1.5); assert.deepEqual(f.view('p').bounds, { x: 400, y: 60, width: 400, height: 300 });
});

test('find answers only the newest request (ids may start at 0), ignores late results after stop and reports supersession', async () => {
  const f = await fixture();
  await f.open('f'); const page = f.contents('f');
  const first = f.call({ action: 'find', tab: 'f', text: 'ne', findNext: true });
  await null;
  const second = f.call({ action: 'find', tab: 'f', text: 'needle', findNext: true });
  await delay(5);
  page.emit('found-in-page', {}, { requestId: 0, matches: 9, activeMatchOrdinal: 1, finalUpdate: true });
  page.emit('found-in-page', {}, { requestId: 1, matches: 3, activeMatchOrdinal: 1, finalUpdate: true });
  const [older, newer] = await Promise.all([first, second]);
  assert.equal(older.findRequestId, 0); assert.equal(older.superseded, true);
  assert.equal(newer.findRequestId, 1); assert.deepEqual(newer.find, { requestId: 1, matches: 3, activeMatchOrdinal: 1, finalUpdate: true });
  const finds = f.events.filter(event => event.kind === 'find');
  assert.deepEqual(finds.map(event => event.requestId), [1], 'results of a superseded request are not forwarded');
  assert.equal(finds[0].navigation, newer.navigation);
  // Next / previous move within the session unless the text changes.
  const next = f.call({ action: 'find', tab: 'f', text: 'needle', forward: false });
  await delay(5); page.emit('found-in-page', {}, { requestId: 2, matches: 3, activeMatchOrdinal: 3, finalUpdate: true });
  await next;
  assert.deepEqual(page.finds.map(item => [item.text, item.findNext, item.forward]), [['ne', true, true], ['needle', true, true], ['needle', false, false]]);
  await f.call({ action: 'stop_find', tab: 'f' });
  assert.deepEqual(page.stops, ['clearSelection']);
  page.emit('found-in-page', {}, { requestId: 2, matches: 3, activeMatchOrdinal: 2, finalUpdate: true });
  assert.equal(f.events.filter(event => event.kind === 'find').length, 2);
  await f.call({ action: 'sleep', tab: 'f' });
  assert.equal((await f.call({ action: 'find', tab: 'f', text: 'x' })).error, 'tab_sleeping');
});

test('print: system dialog only, honest outcomes, Bot steps paused meanwhile, and one tool dialog at a time', async () => {
  const f = await fixture();
  await f.open('p'); const page = f.contents('p');
  const pending = f.call({ action: 'print', tab: 'p' });
  await delay(5);
  assert.equal(page.prints.length, 1); assert.equal(page.prints[0].options.silent, false);
  assert.equal((await f.bot({ action: 'observe', tab: 'p' })).error, 'page_tool_active');
  assert.equal((await f.call({ action: 'save_screenshot', tab: 'p' })).error, 'tool_busy');
  page.prints[0].callback(true, '');
  const done = await pending;
  assert.equal(done.status, 'ok'); assert.deepEqual(done.print, { mode: 'dialog', submitted: true });
  const cancelled = f.call({ action: 'print', tab: 'p' }); await delay(5); page.prints[1].callback(false, 'Print job canceled');
  assert.equal((await cancelled).status, 'cancelled');
  const failed = f.call({ action: 'print', tab: 'p' }); await delay(5); page.prints[2].callback(false, 'Print job failed');
  assert.deepEqual([(await failed).status, (await failed).error, (await failed).detail.reason], ['failed', 'print_failed', 'Print job failed']);
  // Observed on a Mac without printers: Electron answers at once and shows no dialog.
  const none = f.call({ action: 'print', tab: 'p' }); await delay(5); page.prints[3].callback(false, 'No printers available on the network');
  assert.deepEqual([(await none).status, (await none).error], ['failed', 'print_no_printers']);
  const closing = f.call({ action: 'print', tab: 'p' }); await delay(5); assert.equal(page.prints.length, 5);
  await f.call({ action: 'close', tab: 'p', force: true });
  assert.deepEqual([(await closing).status, (await closing).error], ['cancelled', 'tab_closed']);
});

test('PDF and screenshot bytes are frozen before the save dialog, written only to the chosen path, and never after a scope reset', async () => {
  const f = await fixture();
  await f.open('s'); const page = f.contents('s');
  page.emit('page-title-updated', {}, 'Report: Q4/2026');
  await f.layout([{ tab: 's', x: 400, y: 60, width: 600, height: 500 }]);
  const target = path.join(f.directory, 'chosen.png');
  f.saves.push(options => { page.emit('did-navigate', {}, 'https://example.org/after', 200); return { canceled: false, filePath: target }; });
  const saved = await f.call({ action: 'save_screenshot', tab: 's', english: true });
  assert.deepEqual([saved.status, saved.saved, saved.name, saved.width], ['ok', true, 'chosen.png', 320]);
  assert.equal((await readFile(target)).toString(), '\x89PNG fake');
  assert.equal(f.dialogs[0].title, 'Save page screenshot'); assert.match(path.basename(f.dialogs[0].defaultPath), /^Report Q4 2026 \d{4}-\d\d-\d\d/);
  assert.ok(!('path' in saved) && !JSON.stringify(saved).includes(f.directory), 'the receipt carries a name, not the local path');
  // Cancel, and a page that navigates while being captured.
  assert.equal((await f.call({ action: 'save_screenshot', tab: 's' })).status, 'cancelled');
  page.captureHook = async () => { page.emit('did-navigate', {}, 'https://example.org/moved', 200); };
  const moved = await f.call({ action: 'save_screenshot', tab: 's' });
  assert.deepEqual([moved.status, moved.error], ['failed', 'stale_navigation']); page.captureHook = undefined;
  // Hidden layout (a menu still open) waits briefly, then fails rather than saving a blank image.
  await f.layout([], { hidden: true });
  const hidden = await f.call({ action: 'save_screenshot', tab: 's' });
  assert.deepEqual([hidden.status, hidden.error, hidden.detail?.reason], ['failed', 'capture_failed', 'not_visible']);
  const revealed = f.call({ action: 'save_screenshot', tab: 's' });
  await delay(60); await f.layout([{ tab: 's', x: 400, y: 60, width: 600, height: 500 }]);
  assert.equal((await revealed).status, 'cancelled', 'captured after the page became visible; then the dialog was cancelled');
  // PDF: rendered first, then saved.
  const pdf = path.join(f.directory, 'page.pdf');
  f.saves.push({ canceled: false, filePath: pdf });
  const printed = await f.call({ action: 'print', tab: 's', mode: 'pdf' });
  assert.deepEqual([printed.status, printed.saved, printed.name], ['ok', true, 'page.pdf']);
  assert.equal((await readFile(pdf)).toString(), '%PDF-1.7 fake');
  // A Host reset while the dialog is open discards the captured page.
  const discarded = path.join(f.directory, 'discarded.png');
  f.saves.push(async () => { await f.browser.request('workbench_browser_reset', { host: scope.host, scopes: [scope] }, () => true); return { canceled: false, filePath: discarded }; });
  await f.open('t'); await f.layout([{ tab: 't', x: 400, y: 60, width: 600, height: 500 }]);
  const reset = await f.call({ action: 'save_screenshot', tab: 't' });
  assert.equal(reset.status, 'cancelled'); await assert.rejects(readFile(discarded));
});

test('history records committed http(s) visits per conversation, shares one store across windows and is cleared by Host reset', async () => {
  const first = await fixture(), second = await fixture({ root: first.directory });
  await first.open('h'); const page = first.contents('h');
  await page.loadURL('https://example.org/a?q=kittens#top');
  page.title = 'Kittens'; page.emit('page-title-updated', {}, 'Kittens');
  await page.loadURL('https://example.org/missing', 404);
  await page.loadURL('https://login.example.org/cb?code=secret');
  page.emit('did-navigate-in-page', {}, 'https://example.org/app#tab-1', true);
  page.emit('did-navigate-in-page', {}, 'https://example.org/app#tab-2', true);
  await delay(10);
  const listed = await second.call({ action: 'history' });
  assert.equal(listed.status, 'ok');
  assert.deepEqual(listed.entries.map(entry => entry.url), ['https://example.org/app', 'https://example.org/a?q=kittens', 'https://example.org/']);
  assert.equal(listed.entries[1].title, 'Kittens');
  assert.equal((await second.call({ action: 'history', scope: other })).entries.length, 0);
  // Settings changes reach every window's panes of this conversation.
  await second.call({ action: 'settings_set', settings: SETTINGS });
  for (const f of [first, second]) assert.ok(f.events.some(event => event.kind === 'settings' && event.settings.searchEngine === 'bing' && event.scope.conversation === scope.conversation));
  // Clearing drops late title updates for visits from before the clear.
  assert.equal((await first.call({ action: 'clear_history' })).removed, 3);
  page.emit('page-title-updated', {}, 'Late title');
  await delay(10);
  assert.deepEqual((await second.call({ action: 'history' })).entries, []);
  await page.loadURL('https://example.org/after');
  await delay(10);
  assert.equal((await first.call({ action: 'history' })).entries.length, 1);
  const reset = await first.browser.request('workbench_browser_reset', { host: scope.host, scopes: [scope] }, () => true);
  assert.ok(!reset.failed.includes('history'));
  assert.deepEqual((await second.call({ action: 'history' })).entries, []);
  assert.deepEqual((await second.call({ action: 'settings' })).settings, { searchEngine: 'google', defaultZoom: 1, recordHistory: true });
});

test('a live page keeps recording after its idle history was released from memory', async () => {
  const f = await fixture(); await f.open('h'); const page = f.contents('h');
  await page.loadURL('https://example.org/live'); await f.browser.store.flush();
  const [visit] = (await f.call({ action: 'history' })).entries; assert.equal(visit.url, 'https://example.org/live');
  const store = f.browser.store; await spill(store, 20, 'other-conversations');
  // Written behind the store: visible only if the released history is read back.
  const root = path.join(f.directory, 'workbench-browser-user');
  await writeFile(await historyFile(root, scope), JSON.stringify({ version: 1, entries: [visit, diskEntry] }));
  page.title = 'Later'; page.emit('page-title-updated', {}, 'Later');
  await page.loadURL('https://example.org/next');
  // Navigation starts an async history write. Await its completion instead of
  // assuming disk reads and the record callback finish within ten milliseconds.
  await store.flush();
  const entries = (await f.call({ action: 'history' })).entries;
  assert.deepEqual(entries.map(e => [e.url, e.title]), [['https://example.org/next', ''], ['https://example.org/live', 'Later'], ['https://disk.example.org/', 'disk']]);
});

test('page shortcuts reach the App only for the person: find focuses the App document, Bot input is ignored', async () => {
  const f = await fixture();
  await f.open('k'); const page = f.contents('k');
  const press = (key, extra = {}) => { const event = { prevented: false, preventDefault() { this.prevented = true; } }; page.emit('before-input-event', event, { type: 'keyDown', key, meta: true, control: false, alt: false, shift: false, ...extra }); return event.prevented; };
  assert.equal(press('f'), true); assert.equal(f.window.focused, 1);
  assert.equal(press('p'), true);
  assert.deepEqual(f.events.filter(event => event.kind === 'shortcut').map(event => [event.tab, event.command]), [['k', 'find'], ['k', 'print']]);
  assert.equal(press('a'), false);
  // Escape and ⌘G stay with the page until the person starts finding.
  assert.equal(press('Escape', { meta: false }), false); assert.equal(press('g'), false);
  const finding = f.call({ action: 'find', tab: 'k', text: 'needle' });
  await delay(5); page.emit('found-in-page', {}, { requestId: 0, matches: 2, activeMatchOrdinal: 1, finalUpdate: true }); await finding;
  assert.equal(press('g'), true); assert.equal(press('G', { shift: true }), true);
  assert.equal(press('Escape', { meta: false }), false, 'Escape is reported but still reaches the page');
  assert.equal(f.window.focused, 1, 'only find takes the keyboard back to the App document');
  await f.call({ action: 'stop_find', tab: 'k' });
  assert.equal(press('Escape', { meta: false }), false);
  assert.equal(f.events.filter(event => event.command === 'escape').length, 1, 'no escape event outside a find session');
  assert.deepEqual(f.events.filter(event => event.kind === 'shortcut').map(event => event.command), ['find', 'print', 'find_next', 'find_prev', 'escape']);
  // During a Bot input step the same keys are not page tools.
  await f.layout([{ tab: 'k', x: 400, y: 60, width: 600, height: 500 }]);
  page.page.keyTarget = { target: 'body' }; page.page.settle = { delivered: true };
  await f.bot({ action: 'press', tab: 'k', key: 'Enter' });
  assert.equal(press('f'), false);
  assert.equal(f.events.filter(event => event.kind === 'shortcut').length, 5);
});

test('quitting writes pending history first; a replaced App document ends the page find session', async () => {
  const f = await fixture();
  await f.open('q'); const page = f.contents('q');
  await page.loadURL('https://example.org/pending');
  assert.equal(await f.browser.prepareQuit(), true);
  const fresh = new BrowserUserStore(path.join(f.directory, 'workbench-browser-user'));
  assert.deepEqual((await fresh.list(scope)).map(entry => entry.url), ['https://example.org/pending', 'https://example.org/']);
  f.browser.quitCancelled();
  const find = f.call({ action: 'find', tab: 'q', text: 'x' });
  await delay(5);
  f.browser.retire();
  assert.equal((await find).superseded, true);
  assert.deepEqual(page.stops, ['clearSelection']);
  page.emit('found-in-page', {}, { requestId: 0, matches: 1, activeMatchOrdinal: 1, finalUpdate: true });
  assert.equal(f.events.filter(event => event.kind === 'find').length, 0);
});

test('history recording never breaks navigation bookkeeping, even for an event without a URL', async () => {
  const f = await fixture();
  await f.open('n'); const page = f.contents('n');
  const before = (await f.call({ action: 'list' })).tabs[0].navigation;
  assert.doesNotThrow(() => page.emit('did-navigate'));
  assert.doesNotThrow(() => page.emit('did-navigate-in-page', {}, undefined, true));
  const after = (await f.call({ action: 'list' })).tabs[0];
  assert.equal(after.navigation, before + 1);
  assert.ok(f.events.some(event => event.kind === 'state' && event.tab === 'n' && event.navigation === before + 1));
  await delay(10);
  assert.deepEqual((await f.call({ action: 'history' })).entries.map(entry => entry.url), ['https://example.org/']);
});

test('a hung page cannot hold the window\'s print/save dialog: tools wait for it to respond, and PDF rendering is bounded', async () => {
  const f = await fixture({ limits: { ...BROWSER_LIMITS, pdfMs: 50 } });
  await f.open('u'); const page = f.contents('u');
  await f.layout([{ tab: 'u', x: 400, y: 60, width: 600, height: 500 }]);
  page.emit('unresponsive');
  for (const args of [{ action: 'print' }, { action: 'print', mode: 'pdf' }, { action: 'save_screenshot' }, { action: 'find', text: 'x' }])
    assert.equal((await f.call({ tab: 'u', ...args })).error, 'page_unavailable', JSON.stringify(args));
  assert.equal(page.prints.length, 0);
  page.emit('responsive');
  // A renderer that stops answering while rendering: bounded, and the dialog lock is released.
  page.printToPDF = () => new Promise(() => {});
  const hung = await f.call({ tab: 'u', action: 'print', mode: 'pdf' });
  assert.deepEqual([hung.status, hung.error, hung.detail?.reason], ['failed', 'pdf_failed', 'timeout']);
  assert.equal((await f.call({ tab: 'u', action: 'save_screenshot' })).status, 'cancelled', 'not tool_busy: the save dialog opened and was cancelled');
  // A woken page starts responsive.
  page.emit('unresponsive'); await f.layout([]);
  await f.call({ tab: 'u', action: 'sleep' }); await f.wake('u');
  assert.equal((await f.call({ tab: 'u', action: 'find', text: 'x', findNext: true })).error, undefined);
});
