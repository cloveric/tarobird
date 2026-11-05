import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserExtensions, compatibility, extensionId } from '../browser-extensions.mjs';
import { optionsPath, optionsTarget, optionsURL } from '../extension-options.mjs';
import { BROWSER_ACTIONS, USER_ONLY, parseBrowserAction } from '../browser-contract.mjs';
import { installRequestFilter, partitionFor } from '../browser-policy.mjs';
import { PERSONAL_BROWSER_SCOPE } from '../../shared/personal-browser.mjs';

const conversation = { host: 'host-key', user: 'user-1', conversation: 'conv-1' };
const ID = 'abcdefghijklmnopabcdefghijklmnop';
const temp = () => mkdtemp(path.join(tmpdir(), 'tarobot-options-'));
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, ms = 2000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('condition not reached'); await tick(2); } };
const navigation = (url, isMainFrame = true) => ({ url, isMainFrame, prevented: false, preventDefault() { this.prevented = true; } });

// Fake Electron: page sessions (as in browser-extensions.test.mjs) plus
// BrowserWindow, whose page load the test decides (`control.load(url)`).
function fakeElectron({ chosen, control = { load: () => 'ready' } } = {}) {
  const sessions = new Map(), windows = [], dialogs = [], opened = [];
  let ids = 0;
  function makeSession(name) {
    const loaded = new Map(), manifests = new Map(), session = { name, loaded, cleared: [], listener: undefined, filtered: false, handled: new Set(), workerStarts: [],
      registerPreloadScript(options) { session.preload = options; },
      serviceWorkers: { on() {}, getWorkerFromVersionID() {}, async startWorkerForScope(scope) { session.workerStarts.push(scope); return control.startWorker ? control.startWorker(scope) : {}; } },
      webRequest: { onBeforeRequest(filter, listener) { session.listener = filter === null ? undefined : listener; session.filtered = filter !== null; } },
      protocol: { handle(scheme) { session.handled.add(scheme); }, unhandle(scheme) { session.handled.delete(scheme); } },
      extensions: {
        async loadExtension(directory) {
          const data = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')), id = extensionId(Buffer.from(data.key, 'base64'));
          if (data.name === 'TaroBird page policy') {
            const url = /fetch\("([^"]+)"\)/.exec(await readFile(path.join(directory, 'policy.js'), 'utf8'))[1];
            setTimeout(() => session.listener?.({ url, resourceType: 'other' }, () => {}), 5);
          }
          loaded.set(id, data.version); manifests.set(id, data); return { id };
        },
        removeExtension(id) { loaded.delete(id); },
        getExtension(id) { return loaded.has(id) ? { id, manifest: manifests.get(id) } : undefined; },
      }, async clearStorageData(options) { session.cleared.push({ ...options, openWindows: windows.filter(item => !item.destroyed).length }); } };
    return session;
  }
  class Contents extends EventEmitter {
    constructor() { super(); this.id = ++ids; this.destroyed = false; this.loads = []; }
    setWindowOpenHandler(fn) { if (control.wiringFails) throw new Error('wiring failed'); this.openHandler = fn; }
    loadURL(url) {
      this.loads.push(url);
      const mode = control.load(url);
      if (mode === 'ready') setTimeout(() => { if (!this.destroyed) this.emit('dom-ready'); }, 1);
      if (mode === 'fail') setTimeout(() => { if (!this.destroyed) this.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', url, true); }, 1);
      if (mode === 'reject') return Promise.reject(Object.assign(new Error('ERR_FAILED (-2)'), { errno: -2, code: 'ERR_FAILED' }));
      // Replaced by the page's own navigation, whose document then becomes ready.
      if (mode === 'abort') { setTimeout(() => { if (!this.destroyed) this.emit('dom-ready'); }, 20); return Promise.reject(Object.assign(new Error('ERR_ABORTED (-3)'), { errno: -3, code: 'ERR_ABORTED' })); }
      return new Promise(() => {});
    }
    isDestroyed() { return this.destroyed; }
  }
  class BrowserWindow extends EventEmitter {
    constructor(options) { super(); this.options = options; this.id = 100 + windows.length; this.webContents = new Contents(); this.shown = false; this.destroyed = false; windows.push(this); }
    show() { this.shown = true; } focus() { this.focused = (this.focused ?? 0) + 1; } isMinimized() { return false; } restore() {}
    isDestroyed() { return this.destroyed; }
    // Finally observed gone (a `stuck` destroy completing later).
    complete() { this.destroyed = true; this.webContents.destroyed = true; this.webContents.emit('destroyed'); this.emit('closed'); }
    destroy() {
      // `stuck`: a renderer whose destruction is never observed.
      if (control.stuck) { this.destroyRequested = true; return; }
      if (this.destroyed) return; this.destroyed = true; this.webContents.destroyed = true; this.webContents.emit('destroyed'); this.emit('closed');
    }
  }
  return { windows, dialogs, opened, sessions, control, BrowserWindow, session: { defaultSession: makeSession('default'), fromPartition: name => { if (!sessions.has(name)) sessions.set(name, makeSession(name)); return sessions.get(name); } },
    dialog: { showOpenDialog: async (_window, options) => { dialogs.push(options); const value = await chosen(); return value ? { canceled: false, filePaths: [value] } : { canceled: true, filePaths: [] }; },
      showMessageBox: async (_window, options) => { dialogs.push(options); return { response: 1 }; } } };
}
const limits = { extensions: 50, loadMs: 300, policyMs: 300, downloadMs: 1000, optionsWindows: 4, optionsMs: 300, optionsWorkerMs: 400, optionsCloseMs: 150 };
const passDrain = async () => ({ ok: true, commit: fn => { fn(); return true; }, release() {} });
// An App window: options windows are its children and close with it.
const appWindow = (id = 1) => { const window = Object.assign(new EventEmitter(), { id, closed: false, isDestroyed: () => window.closed }); return window; };
// A fixed key keeps the ID across reinstalls after a reset.
const KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const manifest = (fields = {}) => JSON.stringify({ manifest_version: 3, name: 'Settings sample', version: '1.0.0', key: KEY, content_scripts: [{ matches: ['<all_urls>'], js: ['cs.js'] }],
  background: { service_worker: 'sw.js' }, options_ui: { page: 'options.html' }, ...fields });

async function setup(root, { drain = passDrain, fields } = {}) {
  const folder = path.join(root, 'src'), store = path.join(root, 'profile.noindex', 'workbench-browser-extensions');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'manifest.json'), manifest(fields)); await writeFile(path.join(folder, 'cs.js'), '1'); await writeFile(path.join(folder, 'sw.js'), '1'); await writeFile(path.join(folder, 'options.html'), '<p>settings</p>');
  const state = { pick: folder }, electron = fakeElectron({ chosen: () => state.pick });
  const manager = new BrowserExtensions(store, electron, { limits, drain, openTab: async (session, url, active) => { electron.opened.push({ session, url, active }); return {}; } });
  const personal = electron.session.fromPartition(partitionFor(PERSONAL_BROWSER_SCOPE)), page = electron.session.fromPartition(partitionFor(conversation));
  installRequestFilter(personal); installRequestFilter(page);
  await manager.attach(personal, PERSONAL_BROWSER_SCOPE); await manager.attach(page, conversation);
  const installed = await manager.request({ action: 'install', source: 'folder' });
  assert.equal(installed.status, 'ok');
  // `prepare` is WorkbenchBrowser.#session: the scope's session with page policy, attached.
  const options = (scope, { window, ...extra } = {}) => manager.request({ action: 'options', id: installed.extension.id, scope, ...extra }, { window, prepare: value => manager.attach(electron.session.fromPartition(partitionFor(value)), value) });
  return { folder, store, state, electron, manager, personal, page, id: installed.extension.id, installed, options };
}
const live = electron => electron.windows.filter(item => !item.destroyed);

test('options pages: only validated package paths, only this extension, web links leave for managed pages', () => {
  assert.deepEqual(optionsPath({ options_ui: { page: 'html/options.html' }, options_page: 'old.html' }), { parts: ['html', 'options.html'], page: 'html/options.html' });
  assert.equal(optionsPath({ options_page: '/options.html?tab=general#filters' }).page, 'options.html?tab=general#filters');
  assert.equal(optionsPath({ options_page: './a b.html' }).page, 'a%20b.html');
  for (const bad of ['../options.html', 'a/../../b.html', 'https://evil.example/x.html', '//otherextension/x.html', 'javascript:alert(1)', 'data:text/html,x', 'a\\b.html',
    'C:/x.html', '', '/', '%2e%2e/x.html', 'a//b.html', 'file:///etc/hosts', 'a\nb.html', 'x'.repeat(1025)])
    assert.equal(optionsPath({ options_page: bad }), undefined, bad);
  assert.equal(optionsPath({ options_ui: { page: 42 } }), undefined);
  assert.equal(optionsPath({}), undefined);
  assert.equal(optionsURL(ID, 'options.html?x=1'), `chrome-extension://${ID}/options.html?x=1`);
  assert.equal(optionsURL(ID, '//other/x'), undefined); assert.equal(optionsURL('bad', 'x.html'), undefined);
  const own = `chrome-extension://${ID}/options.html`;
  assert.equal(optionsTarget(own, ID, true).kind, 'own');
  assert.deepEqual(optionsTarget('https://example.com/help', ID, true), { kind: 'web', url: 'https://example.com/help' });
  for (const bad of [`chrome-extension://${'b'.repeat(32)}/options.html`, 'file:///etc/hosts', 'tarobot://app/index.html', 'chrome://settings', 'about:blank', 'data:text/html,x', 'javascript:1', 'mailto:a@example.com', 'https://u:p@example.com/'])
    assert.equal(optionsTarget(bad, ID, true).kind, 'blocked', bad);
  for (const ok of ['https://example.com/frame', 'about:blank', 'about:srcdoc', 'data:text/html,x', own]) assert.notEqual(optionsTarget(ok, ID, false).kind, 'blocked', ok);
  for (const bad of [`chrome-extension://${'b'.repeat(32)}/x.html`, 'file:///etc/hosts', 'tarobot://app/', 'chrome://gpu']) assert.equal(optionsTarget(bad, ID, false).kind, 'blocked', bad);
  // New installs report it as supported; an unusable declaration stays unavailable.
  const report = page => Object.fromEntries(compatibility({ manifest_version: 3, name: 'x', version: '1', background: { service_worker: 'sw.js' }, options_page: page }).features.map(item => [item.code, item.status]));
  assert.equal(report('options.html').options_page, 'supported'); assert.equal(report('https://evil.example/').options_page, 'unavailable');
});

test('options are not a Bot browser action', () => {
  assert.ok(!BROWSER_ACTIONS.includes('options')); assert.ok(!USER_ONLY.has('options'));
  assert.throws(() => parseBrowserAction({ action: 'options', scope: conversation, id: ID }), /invalid_browser_args/);
});

test('summary: options availability comes from the installed package; an older registry report is corrected, not rewritten', async () => {
  const root = await temp();
  try {
    const { store, manager, id, installed, electron } = await setup(root);
    assert.equal(installed.extension.optionsAvailable, true);
    assert.equal(installed.extension.report.features.find(item => item.code === 'options_page').status, 'supported');
    // A registry written before this change: options_page unavailable, verdict limited.
    const file = path.join(store, 'registry.json'), registry = JSON.parse(await readFile(file, 'utf8'));
    registry.extensions[0].report.features = registry.extensions[0].report.features.map(item => item.code === 'options_page' ? { ...item, status: 'unavailable' } : item);
    registry.extensions[0].report.verdict = 'limited';
    await writeFile(file, JSON.stringify(registry));
    const restarted = new BrowserExtensions(store, electron, { limits, drain: passDrain });
    const [listed] = (await restarted.request({ action: 'list' })).extensions;
    assert.equal(listed.optionsAvailable, true); assert.equal(listed.report.verdict, 'works');
    assert.equal(listed.report.features.find(item => item.code === 'options_page').status, 'supported');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).extensions[0].report.verdict, 'limited', 'registry untouched');
    // The page file must exist in the package (and not be a link out of it).
    await rm(path.join(store, 'packages', id, 'options.html'));
    await symlink('/etc/hosts', path.join(store, 'packages', id, 'options.html'));
    const third = new BrowserExtensions(store, electron, { limits, drain: passDrain });
    const [linked] = (await third.request({ action: 'list' })).extensions;
    assert.equal(linked.optionsAvailable, false); assert.equal(linked.report.features.find(item => item.code === 'options_page').status, 'unavailable');
    assert.equal((await manager.request({ action: 'list' })).extensions[0].optionsAvailable, true, 'cached per installed version');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('open: exact page session, sandboxed window without preload, one per extension and scope, scope never widened', async () => {
  const root = await temp();
  try {
    const { electron, personal, page, id, options, manager } = await setup(root), parent = appWindow(7);
    // Personal-only extension from a conversation pane: refused, nothing loads there.
    assert.deepEqual(await options(conversation), { status: 'failed', error: 'extension_not_in_scope' });
    assert.equal(electron.windows.length, 0); assert.ok(!page.loaded.has(id));
    const opened = await options(PERSONAL_BROWSER_SCOPE, { window: parent, english: true });
    assert.deepEqual(opened, { status: 'ok' });
    const [window] = electron.windows, prefs = window.options.webPreferences;
    assert.equal(prefs.session, personal, 'the same session object the extension is loaded in');
    assert.equal(prefs.preload, undefined);
    for (const [key, value] of Object.entries({ sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false, devTools: false }))
      assert.equal(prefs[key], value, key);
    assert.equal(window.options.parent, parent); assert.equal(window.options.show, false); assert.ok(window.shown);
    assert.deepEqual(window.webContents.loads, [`chrome-extension://${id}/options.html`]);
    assert.equal(window.options.title, 'Settings sample — Settings');
    // A second click focuses the open one.
    assert.deepEqual(await options(PERSONAL_BROWSER_SCOPE), { status: 'ok', existing: true });
    assert.equal(electron.windows.length, 1); assert.ok(window.focused >= 2);
    // Allowed in conversation pages: its own window in that session.
    await manager.request({ action: 'set', id, scope: 'all' });
    assert.deepEqual(await options(conversation), { status: 'ok' });
    assert.equal(electron.windows[1].options.webPreferences.session, page);
    assert.equal(live(electron).length, 2);
    // Disabled, unknown, no options page.
    await manager.request({ action: 'set', id, enabled: false });
    assert.equal(live(electron).length, 0, 'disabling closes its settings');
    assert.deepEqual(await options(PERSONAL_BROWSER_SCOPE), { status: 'failed', error: 'extension_disabled' });
    assert.deepEqual(await manager.request({ action: 'options', id: ID, scope: PERSONAL_BROWSER_SCOPE }), { status: 'failed', error: 'extension_not_found' });
    assert.throws(() => manager.request({ action: 'options', id, scope: { ...conversation, extra: 1 } }), /invalid_extension_args/);
    assert.throws(() => manager.request({ action: 'options', id, scope: conversation, url: 'https://example.com/' }), /invalid_extension_args/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('open: no options page, load failures and the total bound', async () => {
  const root = await temp();
  try {
    const { electron, options, folder, manager, id } = await setup(root, { fields: { options_ui: undefined } });
    assert.deepEqual(await options(PERSONAL_BROWSER_SCOPE), { status: 'failed', error: 'extension_options_unavailable' });
    assert.equal(electron.windows.length, 0);
    await writeFile(path.join(folder, 'manifest.json'), manifest({ version: '1.1.0' }));
    assert.equal((await manager.request({ action: 'install', source: 'folder' })).extension.optionsAvailable, true);
    // A main-frame failure (e.g. the file is missing) closes the window.
    electron.control.load = () => 'fail';
    assert.deepEqual(await options(PERSONAL_BROWSER_SCOPE), { status: 'failed', error: 'options_load_failed' });
    assert.equal(live(electron).length, 0);
    // A page that never becomes ready is bounded, and the queue is not held meanwhile.
    electron.control.load = () => 'hang';
    const started = Date.now(), pending = options(PERSONAL_BROWSER_SCOPE);
    await until(() => electron.windows.length === 2);
    assert.equal((await manager.request({ action: 'list' })).status, 'ok', 'other extension commands run while it loads');
    assert.deepEqual(await pending, { status: 'failed', error: 'options_load_timeout' });
    assert.ok(Date.now() - started < 3000); assert.equal(live(electron).length, 0); assert.ok(!electron.windows[1].shown);
    // A window that cannot be guarded is destroyed and never registered.
    electron.control.wiringFails = true;
    assert.deepEqual(await options(PERSONAL_BROWSER_SCOPE), { status: 'failed', error: 'options_load_failed' });
    assert.equal(live(electron).length, 0); electron.control.wiringFails = false;
    // At most four settings windows in total.
    electron.control.load = () => 'ready';
    await manager.request({ action: 'set', id, scope: 'all' });
    const scopes = [PERSONAL_BROWSER_SCOPE, conversation, { ...conversation, conversation: 'conv-2' }, { ...conversation, conversation: 'conv-3' }];
    for (const scope of scopes) assert.equal((await options(scope)).status, 'ok');
    assert.deepEqual(await options({ ...conversation, conversation: 'conv-4' }), { status: 'failed', error: 'options_limit' });
    assert.equal(live(electron).length, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('window policy: own pages only, web links to managed pages, no popups, webviews, title spoofing or unload traps', async () => {
  const root = await temp();
  try {
    const { electron, personal, id, options } = await setup(root);
    await options(PERSONAL_BROWSER_SCOPE);
    const [window] = electron.windows, contents = window.webContents, own = `chrome-extension://${id}/`;
    const emit = (name, event) => { contents.emit(name, event); return event.prevented; };
    assert.equal(emit('will-frame-navigate', navigation(`${own}other.html`)), false);
    assert.equal(emit('will-frame-navigate', navigation('https://example.com/help')), true);
    await until(() => electron.opened.length === 1);
    assert.equal(electron.opened[0].session, personal, 'same scope as the extension'); assert.equal(electron.opened[0].url, 'https://example.com/help');
    for (const bad of [`chrome-extension://${'b'.repeat(32)}/x.html`, 'file:///etc/hosts', 'tarobot://app/index.html', 'chrome://settings/', 'data:text/html,x'])
      assert.equal(emit('will-frame-navigate', navigation(bad)), true, bad);
    assert.equal(emit('will-redirect', navigation('http://127.0.0.1:1/')), true);
    assert.equal(emit('will-frame-navigate', navigation('https://example.com/embed', false)), false, 'web sub-frames as in pages');
    assert.equal(emit('will-frame-navigate', navigation('file:///etc/hosts', false)), true);
    for (const url of ['https://example.com/new', `${own}popup.html`, 'file:///etc/hosts', 'tarobot://app/'])
      assert.deepEqual(contents.openHandler({ url, disposition: 'new-window' }), { action: 'deny' }, url);
    await until(() => electron.opened.length === 2); await tick(10);
    assert.equal(electron.opened.length, 2, 'only the web link was handed over'); assert.equal(electron.opened[1].url, 'https://example.com/new');
    for (const name of ['will-attach-webview', 'will-prevent-unload']) assert.equal(emit(name, navigation('about:blank')), true, name);
    const title = { prevented: false, preventDefault() { this.prevented = true; } };
    window.emit('page-title-updated', title); assert.ok(title.prevented);
    // A navigation that skipped will-frame-navigate (e.g. chrome.tabs.update) closes it.
    contents.emit('did-start-navigation', { url: `${own}#tab`, isMainFrame: true, isSameDocument: true });
    contents.emit('did-start-navigation', { url: `${own}x.html`, isMainFrame: true, isSameDocument: false });
    contents.emit('did-start-navigation', { url: 'https://example.com/f', isMainFrame: false, isSameDocument: false });
    // The page's own link: Electron emits this before will-frame-navigate, which decides it.
    contents.emit('did-start-navigation', { url: 'https://example.com/help', isMainFrame: true, isSameDocument: false, initiator: { url: `${own}options.html` } });
    assert.equal(window.destroyed, false);
    contents.emit('did-start-navigation', { url: 'file:///etc/hosts', isMainFrame: true, isSameDocument: false });
    assert.equal(window.destroyed, true);
    assert.deepEqual(await options(PERSONAL_BROWSER_SCOPE), { status: 'ok' }, 'can be opened again');
    electron.windows[1].webContents.emit('did-navigate', {}, 'https://example.com/', 200);
    assert.equal(electron.windows[1].destroyed, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('lifetime: closed on scope downgrade, reload, update, removal, Host removal, reset and parent close; a late load never shows', async () => {
  const root = await temp();
  try {
    const { electron, manager, id, options, folder, personal } = await setup(root);
    await manager.request({ action: 'set', id, scope: 'all' });
    const parent = appWindow(9);
    await options(PERSONAL_BROWSER_SCOPE, { window: parent }); await options(conversation);
    // Scope downgrade: only the conversation one closes.
    await manager.request({ action: 'set', id, scope: 'personal' });
    assert.deepEqual(electron.windows.map(item => item.destroyed), [false, true]);
    assert.deepEqual(await options(conversation), { status: 'failed', error: 'extension_not_in_scope' });
    // Parent App window closed.
    parent.closed = true; parent.emit('closed'); assert.equal(live(electron).length, 0);
    assert.equal(parent.listenerCount('closed'), 0, 'no listener left on the App window');
    await options(PERSONAL_BROWSER_SCOPE, { window: appWindow(11) }); manager.windowClosed(11); assert.equal(live(electron).length, 0, 'browser disposal');
    await options(PERSONAL_BROWSER_SCOPE); await manager.request({ action: 'reload', id }); assert.equal(live(electron).length, 0, 'reload');
    await options(PERSONAL_BROWSER_SCOPE);
    await writeFile(path.join(folder, 'manifest.json'), manifest({ version: '1.2.0' }));
    await manager.request({ action: 'install', source: 'folder' }); assert.equal(live(electron).length, 0, 'update');
    assert.deepEqual(await options(PERSONAL_BROWSER_SCOPE), { status: 'ok' }, 'the updated version opens');
    await manager.request({ action: 'remove', id });
    assert.equal(live(electron).length, 0, 'removal');
    assert.equal(personal.cleared.at(-1).openWindows, 0, 'closed before its storage is cleared');
    // Host removal and full reset close synchronously, before their queue step.
    await manager.request({ action: 'install', source: 'folder' }); await manager.request({ action: 'set', id, scope: 'all' });
    await options(conversation);
    const forgetting = manager.forget([partitionFor(conversation)]); assert.equal(live(electron).length, 0, 'Host removal'); await forgetting;
    await options(PERSONAL_BROWSER_SCOPE);
    const clearing = manager.clear(); assert.equal(live(electron).length, 0, 'reset'); await clearing;
    // A load still running when the extension stops: cancelled, never shown.
    await manager.request({ action: 'install', source: 'folder' });
    electron.control.load = () => 'hang';
    const pending = options(PERSONAL_BROWSER_SCOPE);
    await until(() => live(electron).length === 1);
    const late = live(electron)[0];
    await manager.request({ action: 'set', id, enabled: false });
    assert.deepEqual(await pending, { status: 'cancelled', error: 'options_closed' });
    late.webContents.emit('dom-ready'); await tick(10);
    assert.ok(late.destroyed && !late.shown);
    // The person closing it while it loads.
    await manager.request({ action: 'set', id, enabled: true });
    const second = options(PERSONAL_BROWSER_SCOPE);
    await until(() => live(electron).length === 1);
    live(electron)[0].destroy();
    assert.deepEqual(await second, { status: 'cancelled', error: 'options_closed' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a reset or Host removal between the click and the queue step opens nothing', async () => {
  const root = await temp();
  try {
    const { electron, manager, id, options } = await setup(root);
    await manager.request({ action: 'set', id, scope: 'all' });
    const first = options(PERSONAL_BROWSER_SCOPE); void manager.clear();
    assert.deepEqual(await first, { status: 'cancelled', error: 'extensions_reset' });
    await manager.request({ action: 'install', source: 'folder' });
    const second = options(conversation); void manager.forget([partitionFor(conversation)]);
    assert.deepEqual(await second, { status: 'cancelled', error: 'extensions_reset' });
    assert.equal(electron.windows.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('compatibility mode: settings of that scope are gone before the filter is removed, and closed when it turns off', async () => {
  const root = await temp();
  try {
    const seen = [];
    let electronRef;
    const drain = async session => ({ ok: true, release() {}, commit: fn => {
      seen.push({ session, open: live(electronRef).filter(item => item.options.webPreferences.session === session).length, filtered: session.filtered });
      fn(); return true;
    } });
    const { electron, manager, id, options, personal, page } = await setup(root, { drain });
    electronRef = electron;
    await manager.request({ action: 'set', id, scope: 'all' });
    await options(PERSONAL_BROWSER_SCOPE); await options(conversation);
    const on = await manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true });
    assert.equal(on.active, true); assert.equal(personal.filtered, false);
    assert.deepEqual(seen.map(item => [item.session === personal, item.open, item.filtered]), [[true, 0, true]], 'closed while the filter still stood');
    assert.deepEqual(electron.windows.map(item => item.destroyed), [true, false], 'another scope keeps its settings');
    // Opening in compatibility mode works; turning it off closes it again.
    assert.deepEqual(await options(PERSONAL_BROWSER_SCOPE), { status: 'ok' });
    await manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: false });
    assert.equal(personal.filtered, true); assert.equal(electron.windows[2].destroyed, true);
    assert.equal(electron.windows[1].destroyed, false); assert.equal(page.filtered, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cold start: the MV3 worker is started first (bounded retries outside the queue); nothing opens if it never starts, or the parent, extension or scope goes meanwhile', async () => {
  const root = await temp();
  try {
    const { electron, manager, id, options, personal } = await setup(root);
    // Electron still registering the worker after a load: retried, then the window.
    let failures = 3;
    electron.control.startWorker = async () => { if (failures-- > 0) throw new Error('Failed to start service worker.'); return {}; };
    assert.deepEqual(await options(PERSONAL_BROWSER_SCOPE), { status: 'ok' });
    assert.equal(personal.workerStarts.length, 4); assert.ok(personal.workerStarts.every(scope => scope === `chrome-extension://${id}/`));
    await manager.request({ action: 'reload', id });
    // Never starts: bounded, actionable, no window; the queue is free meanwhile.
    electron.control.startWorker = async () => { throw new Error('Failed to start service worker.'); };
    const started = Date.now(), never = options(PERSONAL_BROWSER_SCOPE);
    assert.equal((await manager.request({ action: 'list' })).status, 'ok');
    assert.deepEqual(await never, { status: 'failed', error: 'extension_background_not_ready' });
    assert.ok(Date.now() - started < 2000); assert.equal(live(electron).length, 0);
    // The requesting App window closes, or its browser is disposed, while waiting.
    let release; electron.control.startWorker = () => new Promise(resolve => { release = resolve; });
    const parent = appWindow(21), closing = options(PERSONAL_BROWSER_SCOPE, { window: parent });
    await until(() => release); parent.closed = true; parent.emit('closed'); release({});
    assert.deepEqual(await closing, { status: 'cancelled', error: 'options_closed' });
    assert.equal(parent.listenerCount('closed'), 0);
    release = undefined; const other = appWindow(22), disposing = options(PERSONAL_BROWSER_SCOPE, { window: other });
    await until(() => release); manager.windowClosed(22); release({});
    assert.deepEqual(await disposing, { status: 'cancelled', error: 'options_closed' });
    // Disposed after the worker started, while the final step waits behind another queue step.
    let confirm; const showMessageBox = electron.dialog.showMessageBox;
    electron.dialog.showMessageBox = () => new Promise(resolve => { confirm = resolve; });
    let blocking;
    electron.control.startWorker = async () => { blocking = manager.request({ action: 'set', id, scope: 'all' }); return {}; };
    const queued = options(PERSONAL_BROWSER_SCOPE, { window: appWindow(24) });
    await until(() => confirm); manager.windowClosed(24); confirm({ response: 0 });
    assert.deepEqual(await queued, { status: 'cancelled', error: 'options_closed' }); await blocking;
    electron.dialog.showMessageBox = showMessageBox; electron.control.startWorker = () => new Promise(resolve => { release = resolve; });
    // Disabled meanwhile: the second check refuses it.
    release = undefined; const disabled = options(PERSONAL_BROWSER_SCOPE);
    await until(() => release); await manager.request({ action: 'set', id, enabled: false }); release({});
    assert.deepEqual(await disabled, { status: 'failed', error: 'extension_disabled' });
    await manager.request({ action: 'set', id, enabled: true });
    // A reset meanwhile.
    release = undefined; const reset = options(PERSONAL_BROWSER_SCOPE);
    await until(() => release); const clearing = manager.clear(); release({});
    assert.deepEqual(await reset, { status: 'cancelled', error: 'extensions_reset' });
    // (An install reviewed before the reset finishes is itself cancelled by it.)
    await clearing;
    assert.equal(electron.windows.length, 1, 'only the first, successful open created a window');
    // The App window still open later: a new request for it works (no permanent fence).
    electron.control.startWorker = undefined; await manager.request({ action: 'install', source: 'folder' });
    assert.deepEqual(await options(PERSONAL_BROWSER_SCOPE, { window: appWindow(23) }), { status: 'ok' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('load outcome: a rejected load fails at once, an aborted one waits for the replacing document', async () => {
  const root = await temp();
  try {
    const { electron, options } = await setup(root);
    electron.control.load = () => 'reject';
    const started = Date.now();
    assert.deepEqual(await options(PERSONAL_BROWSER_SCOPE), { status: 'failed', error: 'options_load_failed' });
    assert.ok(Date.now() - started < 250, 'not the load timeout'); assert.equal(live(electron).length, 0);
    electron.control.load = () => 'abort';
    assert.deepEqual(await options(PERSONAL_BROWSER_SCOPE), { status: 'ok' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('compatibility mode stays off while a settings window is not seen to close, also on retry; its key cannot reopen until it is gone', async () => {
  const root = await temp();
  try {
    let commits = 0;
    const drain = async () => ({ ok: true, release() {}, commit: fn => { commits++; fn(); return true; } });
    const { electron, manager, options, personal } = await setup(root, { drain });
    await options(PERSONAL_BROWSER_SCOPE);
    electron.control.stuck = true;
    const on = await manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true, english: true });
    assert.equal(on.active, false); assert.equal(on.error, 'compatibility_unavailable');
    assert.equal(commits, 0, 'the filter was never offered for removal'); assert.equal(personal.filtered, true);
    assert.ok(!manager.compatible(personal)); assert.ok(electron.windows[0].destroyRequested);
    // The native confirmation names both extension parts that gain local access.
    assert.match(electron.dialogs.at(-1).detail, /background scripts and settings pages/);
    // The person retries while the same renderer is still not gone: still protected.
    const retry = await manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true });
    assert.equal(retry.active, false); assert.equal(retry.error, 'compatibility_unavailable'); assert.equal(commits, 0); assert.equal(personal.filtered, true);
    // Neither deduplicated onto it nor opened beside it.
    assert.deepEqual(await options(PERSONAL_BROWSER_SCOPE), { status: 'failed', error: 'options_closing' });
    assert.equal(electron.windows.length, 1);
    // Once it is gone: the next attempt switches, and settings open again.
    electron.control.stuck = false; electron.windows[0].complete(); await tick();
    const third = await manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true });
    assert.equal(third.active, true); assert.equal(commits, 1); assert.equal(personal.filtered, false);
    assert.deepEqual(await options(PERSONAL_BROWSER_SCOPE), { status: 'ok' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a crashed settings page is closed, so it can be opened again; a crash before ready fails the open', async () => {
  const root = await temp();
  try {
    const { electron, options } = await setup(root);
    assert.deepEqual(await options(PERSONAL_BROWSER_SCOPE), { status: 'ok' });
    electron.windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    assert.equal(electron.windows[0].destroyed, true);
    assert.deepEqual(await options(PERSONAL_BROWSER_SCOPE), { status: 'ok' }, 'a new window, not the crashed one');
    assert.equal(electron.windows.length, 2);
    electron.windows[1].destroy();
    electron.control.load = () => 'hang';
    const pending = options(PERSONAL_BROWSER_SCOPE);
    await until(() => electron.windows.length === 3);
    electron.windows[2].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    assert.deepEqual(await pending, { status: 'failed', error: 'options_load_failed' });
    assert.equal(live(electron).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
