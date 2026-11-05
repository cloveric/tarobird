import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { BRIDGE_PRELOAD, ExtensionBridge } from '../extension-bridge.mjs';

// Run the worker preload against fake extension globals: a native-like `chrome`
// and the separate `browser` namespace Chromium 156 exposes.
function worker(manifest, { tabs = true, id = 'a'.repeat(32) } = {}) {
  const calls = [], listened = [], handlers = {};
  let dispatcher;
  const chrome = { runtime: { id, getManifest: () => manifest, lastError: undefined }, ...(tabs ? { tabs: { onUpdated: { native: true }, query() {} } } : {}), action: {} };
  const browser = { runtime: chrome.runtime, ...(tabs ? { tabs: { onUpdated: { native: true } } } : {}), action: {} };
  const ipcRenderer = { on: (channel, fn) => { handlers[channel] = fn; }, send: (channel, name) => listened.push([channel, name]),
    invoke: async (channel, method, args) => { calls.push([method, args]); if (method === 'webNavigation.getFrame') throw new Error("Error invoking remote method 'tarobot-extension:call': Error: No frame"); return { method }; } };
  const contextBridge = { executeInMainWorld: ({ func, args }) => { const [bridge] = args; func({ ...bridge, dispatcher: fn => { dispatcher = fn; bridge.dispatcher(fn); } }); } };
  const context = vm.createContext({ require: name => { assert.equal(name, 'electron'); return { contextBridge, ipcRenderer }; }, process: { type: 'service-worker' }, globalThis: undefined, console, URL });
  context.globalThis = context; context.chrome = chrome; context.browser = browser;
  vm.runInContext(BRIDGE_PRELOAD, context);
  return { chrome, browser, calls, listened, emit: (name, args) => handlers['tarobot-extension:event']?.({}, name, args) };
}

test('worker preload adds missing APIs to both chrome and browser, only as declared', async () => {
  const full = worker({ permissions: ['webNavigation', 'contextMenus', 'tabs'], action: {} });
  for (const target of [full.chrome, full.browser]) {
    assert.equal(typeof target.webNavigation.onBeforeNavigate.addListener, 'function');
    assert.equal(typeof target.contextMenus.create, 'function');
    assert.equal(typeof target.windows.update, 'function');
    assert.equal(typeof target.action.setBadgeText, 'function');
    assert.equal(target.tabs.onUpdated.native, undefined, 'never-dispatched native tab events are replaced');
  }
  assert.ok(Object.is(full.chrome.webNavigation, full.browser.webNavigation), 'one shared object');
  const bare = worker({ permissions: ['storage'] });
  assert.equal(bare.chrome.webNavigation, undefined); assert.equal(bare.chrome.contextMenus, undefined); assert.equal(bare.chrome.action.setBadgeText, undefined);
  // Not an extension worker (a website's service worker): nothing is installed.
  const page = worker({ permissions: ['webNavigation'] }, { id: null });
  assert.equal(page.chrome.webNavigation, undefined); assert.equal(page.chrome.windows, undefined);
});

test('events dispatch with URL filters; calls support promises and callbacks with lastError', async () => {
  const { chrome, calls, listened, emit } = worker({ permissions: ['webNavigation', 'contextMenus'] });
  const seen = [];
  chrome.webNavigation.onCommitted.addListener(details => seen.push(['all', details.url]));
  chrome.webNavigation.onCommitted.addListener(details => seen.push(['filtered', details.url]), { url: [{ hostSuffix: 'example.com', schemes: ['https'] }] });
  assert.deepEqual(listened, [['tarobot-extension:listen', 'webNavigation.onCommitted']], 'one registration per event name');
  emit('webNavigation.onCommitted', [{ url: 'https://www.example.com/a' }]);
  emit('webNavigation.onCommitted', [{ url: 'http://other.test/' }]);
  assert.deepEqual(seen, [['all', 'https://www.example.com/a'], ['filtered', 'https://www.example.com/a'], ['all', 'http://other.test/']]);
  assert.deepEqual(await chrome.webNavigation.getAllFrames({ tabId: 3 }), { method: 'webNavigation.getAllFrames' });
  const error = await new Promise(resolve => chrome.webNavigation.getFrame({ tabId: 3, frameId: 9 }, () => resolve(chrome.runtime.lastError?.message)));
  assert.equal(error, 'No frame'); assert.equal(chrome.runtime.lastError, undefined, 'lastError only during the callback');
  const id = chrome.contextMenus.create({ title: 'Block', contexts: ['all'], onclick() {} });
  assert.equal(id, 1); assert.equal(JSON.stringify(calls.at(-1)), JSON.stringify(['contextMenus.create', [{ title: 'Block', contexts: ['all'], id: 1 }]]));
});

function fakeSession() {
  const session = new EventEmitter();
  session.registerPreloadScript = options => { session.preload = options; };
  session.serviceWorkers = Object.assign(new EventEmitter(), { workers: new Map(), getWorkerFromVersionID: id => session.serviceWorkers.workers.get(id),
    startWorkerForScope: async scope => [...session.serviceWorkers.workers.values()].find(worker => worker.scope === scope) });
  session.extensions = { getExtension: id => ({ manifest: { name: `Ext ${id.slice(0, 2)}`, permissions: id.startsWith('a') ? ['webNavigation', 'contextMenus', 'tabs'] : [] } }) };
  return session;
}
function fakeWorker(id) {
  const ipc = new EventEmitter(), sent = [];
  ipc.handle = (channel, fn) => { ipc.handlers = { ...(ipc.handlers ?? {}), [channel]: fn }; };
  return { scope: `chrome-extension://${id}/`, ipc, sent, send: (...args) => sent.push(args) };
}
function fakeContents(session, id = 7) {
  const contents = new EventEmitter();
  const frame = { url: 'https://site.test/', processId: 1, routingId: 1, frameTreeNodeId: 1, parent: null };
  frame.top = frame;
  Object.assign(contents, { id, session, mainFrame: { ...frame, framesInSubtree: [frame] }, getURL: () => 'https://site.test/', getTitle: () => 'Site', isLoading: () => false, isCurrentlyAudible: () => false, isDestroyed: () => false });
  contents.mainFrame.framesInSubtree = [contents.mainFrame]; contents.mainFrame.top = contents.mainFrame;
  return contents;
}

test('main answers only the person’s extensions in their own session, with permission checks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tarobot-bridge-')), allowed = new Set(['a'.repeat(32), 'b'.repeat(32)]);
  try {
    const bridge = new ExtensionBridge(root, { extensionAllowed: (_session, id) => allowed.has(id), openTab: async (_session, url) => ({ id: 99, url }) });
    const session = fakeSession(), other = fakeSession();
    await bridge.enable(session);
    assert.equal(session.preload.type, 'service-worker');
    const good = fakeWorker('a'.repeat(32)), plain = fakeWorker('b'.repeat(32)), website = { scope: 'https://site.test/', ipc: new EventEmitter() };
    session.serviceWorkers.workers.set(1, good).set(2, plain).set(3, website);
    for (const versionId of [1, 2, 3]) session.serviceWorkers.emit('running-status-changed', { versionId });
    assert.equal(website.ipc.listenerCount('tarobot-extension:listen'), 0, 'website workers get no bridge');
    const call = (worker, method, args) => worker.ipc.handlers['tarobot-extension:call']({}, method, args);
    const contents = fakeContents(session), window = { id: 5, isDestroyed: () => false, isFocused: () => true, getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }), isFullScreen: () => false, isMinimized: () => false, isMaximized: () => false, isAlwaysOnTop: () => false };
    bridge.observe(contents, window);
    assert.equal((await call(good, 'webNavigation.getAllFrames', [{ tabId: 7 }]))[0].frameId, 0);
    await assert.rejects(call(plain, 'webNavigation.getAllFrames', [{ tabId: 7 }]), /Permission webNavigation required/);
    await assert.rejects(call(good, 'runtime.reload', []), /Not available/);
    assert.deepEqual((await call(good, 'windows.getAll', [])).map(item => item.id), [5]);
    // A page of another session is not visible to this extension.
    bridge.observe(fakeContents(other, 8), { ...window, id: 6 });
    assert.equal(await call(good, 'webNavigation.getAllFrames', [{ tabId: 8 }]), null);
    assert.deepEqual((await call(good, 'windows.getAll', [])).map(item => item.id), [5]);
    assert.deepEqual(await call(good, 'tabs.create', [{ url: 'https://x.test/' }]), { id: 99, url: 'https://x.test/' });
    await call(good, 'action.setBadgeText', [{ text: '12345678901234567890', tabId: 7 }]);
    assert.equal(await call(good, 'action.getBadgeText', [{ tabId: 7 }]), '1234567890123456');
    // Listening + events: only listening extensions, url/title only with tabs/host access.
    good.ipc.emit('tarobot-extension:listen', {}, 'tabs.onUpdated'); plain.ipc.emit('tarobot-extension:listen', {}, 'tabs.onUpdated');
    contents.emit('page-title-updated', {}, 'New title');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(good.sent.at(-1).slice(0, 2), ['tarobot-extension:event', 'tabs.onUpdated']);
    assert.deepEqual(good.sent.at(-1)[2][1], { title: 'New title' }); assert.equal(good.sent.at(-1)[2][2].title, 'Site');
    assert.deepEqual(plain.sent.at(-1)[2][1], {}, 'no title without tabs permission'); assert.equal(plain.sent.at(-1)[2][2].title, undefined);
    // Menus: built per extension, submenu for several items, click reports onClicked.
    await call(good, 'contextMenus.create', [{ id: 'one', title: 'Block %s', contexts: ['selection'] }]);
    await call(good, 'contextMenus.create', [{ id: 'two', title: 'Pause', contexts: ['all'] }]);
    await assert.rejects(call(plain, 'contextMenus.create', [{ id: 'x', title: 'x' }]), /Permission contextMenus required/);
    good.ipc.emit('tarobot-extension:listen', {}, 'contextMenus.onClicked');
    const items = bridge.menuItems(session, { pageURL: 'https://site.test/', selectionText: 'word', mediaType: 'none' }, { id: 7 });
    assert.equal(items[0].type, 'separator'); assert.equal(items[1].label, 'Ext aa'); assert.deepEqual(items[1].submenu.map(item => item.label), ['Block word', 'Pause']);
    assert.deepEqual(bridge.menuItems(session, { pageURL: 'https://site.test/', mediaType: 'none' }, { id: 7 }).map(item => item.label), [undefined, 'Pause'], 'selection-only item hidden');
    items[1].submenu[1].click(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(good.sent.at(-1)[1], 'contextMenus.onClicked'); assert.equal(good.sent.at(-1)[2][0].menuItemId, 'two');
    allowed.delete('a'.repeat(32));
    assert.deepEqual(bridge.menuItems(session, { pageURL: 'https://site.test/', mediaType: 'none' }, { id: 7 }), [], 'a removed extension adds nothing');
    await assert.rejects(call(good, 'windows.getAll', []), /Not available/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('tab URLs and titles need the tabs permission or a matching host; window and action state stay scoped', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tarobot-bridge-hosts-'));
  try {
    const bridge = new ExtensionBridge(root, { extensionAllowed: () => true, openTab: async () => {} });
    const session = fakeSession(), other = fakeSession(), limited = fakeWorker('c'.repeat(32));
    session.extensions.getExtension = () => ({ manifest: { permissions: [], host_permissions: ['https://allowed.test/*'] } });
    await bridge.enable(session); await bridge.enable(other);
    session.serviceWorkers.workers.set(1, limited); session.serviceWorkers.emit('running-status-changed', { versionId: 1 });
    limited.ipc.emit('tarobot-extension:listen', {}, 'tabs.onUpdated'); limited.ipc.emit('tarobot-extension:listen', {}, 'windows.onRemoved');
    const contents = fakeContents(session, 11); let url = 'https://private.test/?token=PRIVATE';
    contents.getURL = () => url; contents.getTitle = () => (url.includes('allowed') ? 'Allowed' : 'Private');
    const window = { id: 21, isDestroyed: () => false };
    bridge.observe(contents, window);
    contents.emit('page-title-updated', {}, 'Private'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(limited.sent.at(-1)[2][1].title, undefined); assert.equal(limited.sent.at(-1)[2][2].url, undefined);
    url = 'https://allowed.test/a'; contents.emit('page-title-updated', {}, 'Allowed'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(limited.sent.at(-1)[2][1].title, 'Allowed'); assert.equal(limited.sent.at(-1)[2][2].url, url);
    // A window closing is reported only to sessions that had pages in it.
    const elsewhere = fakeWorker('d'.repeat(32)); other.serviceWorkers.workers.set(1, elsewhere); other.serviceWorkers.emit('running-status-changed', { versionId: 1 });
    elsewhere.ipc.emit('tarobot-extension:listen', {}, 'windows.onRemoved');
    bridge.windowClosed(21); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(limited.sent.at(-1).slice(1), ['windows.onRemoved', [21]]); assert.equal(elsewhere.sent.length, 0);
    // Per-tab toolbar state only for a live page of the same session.
    const call = (method, args) => limited.ipc.handlers['tarobot-extension:call']({}, method, args);
    await call('action.setBadgeText', [{ text: '3', tabId: 11 }]); assert.equal(await call('action.getBadgeText', [{ tabId: 11 }]), '3');
    await assert.rejects(call('action.setBadgeText', [{ text: 'x', tabId: 123456 }]), /No tab with id: 123456/);
    bridge.observe(fakeContents(other, 12), { id: 22, isDestroyed: () => false });
    await assert.rejects(call('action.setTitle', [{ title: 'x', tabId: 12 }]), /No tab with id: 12/, 'another session’s page');
  } finally { await rm(root, { recursive: true, force: true }); }
});
