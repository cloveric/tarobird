import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Chrome extension APIs that Electron 45 does not implement but common
// extensions (e.g. AdBlock 6.51) call from their service worker: webNavigation,
// contextMenus, action state, tabs.create/getCurrent and windows. Implemented
// from main's own page records, in the same session as the extension, after the
// approach of the MIT electron-chrome-extensions project (service-worker preload
// + ServiceWorkerMain IPC). Only workers of the person's loaded extensions are
// answered; the preload installs nothing outside extension service workers.

// Written by main at runtime (the bundled main has no separate preload asset).
export const BRIDGE_PRELOAD = String.raw`'use strict';
const { contextBridge, ipcRenderer } = require('electron');
if (process.type === 'service-worker') {
  let dispatch;
  ipcRenderer.on('tarobot-extension:event', (_event, name, args) => { try { dispatch?.(name, args); } catch { /* listener error */ } });
  contextBridge.executeInMainWorld({ func: install, args: [{
    call: (method, args) => ipcRenderer.invoke('tarobot-extension:call', method, args),
    listen: name => ipcRenderer.send('tarobot-extension:listen', name),
    dispatcher: fn => { dispatch = fn; },
  }] });
}
function install(bridge) {
  const chrome = globalThis.chrome;
  if (!chrome?.runtime?.id) return;
  // Chromium 156 also exposes a separate native 'browser' namespace, which
  // webextension-polyfill then uses as is: every addition goes on both.
  const targets = [chrome, globalThis.browser].filter((value, index, all) => value && typeof value === 'object' && all.indexOf(value) === index);
  const provide = (name, value) => { for (const target of targets) if (!target[name]) target[name] = value; };
  const extend = (name, member, value) => { for (const target of targets) if (target[name] && !target[name][member]) target[name][member] = value; };
  const manifest = chrome.runtime.getManifest(), permissions = new Set(manifest.permissions ?? []);
  const listeners = new Map();
  const matches = (filters, details) => {
    if (!filters?.url?.length) return true;
    let url; try { url = new URL(details.url); } catch { return false; }
    return filters.url.some(filter => Object.entries(filter).every(([key, value]) => {
      switch (key) {
        case 'schemes': return value.includes(url.protocol.slice(0, -1));
        case 'hostEquals': return url.hostname === value; case 'hostContains': return url.hostname.includes(value);
        case 'hostPrefix': return url.hostname.startsWith(value); case 'hostSuffix': return url.hostname.endsWith(value);
        case 'urlEquals': return url.href === value; case 'urlContains': return url.href.includes(value);
        case 'urlPrefix': return url.href.startsWith(value); case 'urlSuffix': return url.href.endsWith(value);
        case 'pathEquals': return url.pathname === value; case 'pathContains': return url.pathname.includes(value);
        case 'pathPrefix': return url.pathname.startsWith(value); case 'pathSuffix': return url.pathname.endsWith(value);
        case 'queryEquals': return url.search.slice(1) === value; case 'queryContains': return url.search.includes(value);
        case 'queryPrefix': return url.search.slice(1).startsWith(value); case 'querySuffix': return url.search.endsWith(value);
        case 'urlMatches': try { return new RegExp(value).test(url.href); } catch { return false; }
        case 'ports': return value.some(port => Array.isArray(port) ? Number(url.port || (url.protocol === 'https:' ? 443 : 80)) >= port[0] && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) <= port[1] : Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === port);
        default: return true;
      }
    }));
  };
  bridge.dispatcher((name, args) => { for (const [fn, filters] of [...(listeners.get(name) ?? [])]) if (matches(filters, args[0] ?? {})) try { fn(...args); } catch (error) { console.error(error); } });
  const event = name => ({
    addListener(fn, filters) { if (typeof fn !== 'function') return; let set = listeners.get(name); if (!set) listeners.set(name, set = new Map()); if (!set.size) bridge.listen(name); set.set(fn, filters); },
    removeListener(fn) { listeners.get(name)?.delete(fn); }, hasListener(fn) { return !!listeners.get(name)?.has(fn); }, hasListeners() { return !!listeners.get(name)?.size; },
  });
  const setError = message => { try { Object.defineProperty(chrome.runtime, 'lastError', { configurable: true, get: () => message === undefined ? undefined : { message } }); } catch { /* read-only */ } };
  // Promise style, or the classic trailing callback with runtime.lastError.
  const call = (method, args) => {
    const callback = typeof args.at(-1) === 'function' ? args.pop() : undefined, pending = bridge.call(method, args);
    if (!callback) return pending;
    pending.then(value => callback(value), error => { setError(String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); try { callback(); } finally { setError(undefined); } });
  };
  const method = name => (...args) => call(name, args);
  if (permissions.has('webNavigation')) provide('webNavigation', {
    getFrame: method('webNavigation.getFrame'), getAllFrames: method('webNavigation.getAllFrames'),
    ...Object.fromEntries(['onBeforeNavigate', 'onCommitted', 'onDOMContentLoaded', 'onCompleted', 'onErrorOccurred', 'onHistoryStateUpdated', 'onReferenceFragmentUpdated', 'onCreatedNavigationTarget', 'onTabReplaced']
      .map(name => [name, event('webNavigation.' + name)])),
  });
  if (permissions.has('contextMenus')) {
    let next = 1;
    provide('contextMenus', {
      ACTION_MENU_TOP_LEVEL_LIMIT: 6,
      ContextType: { ALL: 'all', PAGE: 'page', FRAME: 'frame', SELECTION: 'selection', LINK: 'link', EDITABLE: 'editable', IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio', LAUNCHER: 'launcher', BROWSER_ACTION: 'browser_action', PAGE_ACTION: 'page_action', ACTION: 'action' },
      ItemType: { NORMAL: 'normal', CHECKBOX: 'checkbox', RADIO: 'radio', SEPARATOR: 'separator' },
      create(properties, callback) { const id = properties?.id ?? next++; const { onclick: _onclick, ...rest } = properties ?? {}; call('contextMenus.create', [{ ...rest, id }, ...(callback ? [callback] : [])])?.catch?.(() => {}); return id; },
      update: method('contextMenus.update'), remove: method('contextMenus.remove'), removeAll: method('contextMenus.removeAll'),
      onClicked: event('contextMenus.onClicked'),
    });
  }
  if (manifest.action) for (const name of ['setIcon', 'setTitle', 'getTitle', 'setBadgeText', 'getBadgeText', 'setBadgeBackgroundColor', 'getBadgeBackgroundColor', 'setBadgeTextColor', 'getBadgeTextColor', 'setPopup', 'getPopup', 'enable', 'disable', 'isEnabled', 'getUserSettings', 'openPopup']) {
    // Image data stays in the worker: TaroBird records only that an icon was set.
    extend('action', name, name === 'setIcon' ? (details, ...rest) => call('action.setIcon', [{ tabId: details?.tabId, path: typeof details?.path === 'string' ? details.path : undefined, imageData: !!details?.imageData }, ...rest]) : method('action.' + name));
  }
  if (manifest.action) extend('action', 'onClicked', event('action.onClicked'));
  // Electron 45 defines these tab events but never dispatches them for pages
  // (verified natively); TaroBird reports them from its own page records.
  for (const name of ['onCreated', 'onUpdated', 'onActivated', 'onRemoved']) for (const target of targets) {
    if (!target.tabs) continue;
    try { Object.defineProperty(target.tabs, name, { configurable: true, enumerable: true, value: event('tabs.' + name) }); } catch { /* fixed by the runtime */ }
  }
  extend('tabs', 'create', method('tabs.create'));
  // A service worker is not a tab: Chrome returns undefined here too.
  extend('tabs', 'getCurrent', callback => { if (callback) { callback(undefined); return; } return Promise.resolve(undefined); });
  provide('windows', {
    WINDOW_ID_NONE: -1, WINDOW_ID_CURRENT: -2, get: method('windows.get'), getAll: method('windows.getAll'), getCurrent: method('windows.getCurrent'), getLastFocused: method('windows.getLastFocused'), update: method('windows.update'),
    onCreated: event('windows.onCreated'), onRemoved: event('windows.onRemoved'), onFocusChanged: event('windows.onFocusChanged'),
  });
}
`;

const CALLS = new Set(['webNavigation.getFrame', 'webNavigation.getAllFrames', 'contextMenus.create', 'contextMenus.update', 'contextMenus.remove', 'contextMenus.removeAll',
  'action.setIcon', 'action.setTitle', 'action.getTitle', 'action.setBadgeText', 'action.getBadgeText', 'action.setBadgeBackgroundColor', 'action.getBadgeBackgroundColor',
  'action.setBadgeTextColor', 'action.getBadgeTextColor', 'action.setPopup', 'action.getPopup', 'action.enable', 'action.disable', 'action.isEnabled', 'action.getUserSettings', 'action.openPopup',
  'tabs.create', 'windows.get', 'windows.getAll', 'windows.getCurrent', 'windows.getLastFocused', 'windows.update']);
const frameId = frame => !frame?.parent ? 0 : frame.frameTreeNodeId;
const parentFrameId = frame => frame?.parent ? frameId(frame.parent) : -1;
const frameType = frame => frame?.parent ? 'sub_frame' : 'outermost_frame';
// Chrome-style match patterns (<all_urls>, scheme://host/path with * wildcards).
function patternMatches(patterns, raw) {
  if (!Array.isArray(patterns) || !patterns.length) return true;
  let url; try { url = new URL(raw); } catch { return false; }
  return patterns.some(pattern => {
    if (pattern === '<all_urls>') return ['http:', 'https:', 'file:', 'ftp:'].includes(url.protocol);
    const match = /^(\*|https?|file|ftp):\/\/(\*|\*\.[^/*]+|[^/*]+)?(\/.*)$/.exec(String(pattern));
    if (!match) return false;
    const [, scheme, host = '', route] = match;
    if (scheme === '*' ? !['http:', 'https:'].includes(url.protocol) : url.protocol !== `${scheme}:`) return false;
    if (host && host !== '*' && !(host.startsWith('*.') ? url.hostname === host.slice(2) || url.hostname.endsWith(host.slice(1)) : url.hostname === host)) return false;
    return new RegExp(`^${route.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(url.pathname + url.search);
  });
}

/** One bridge per profile, shared by every App window. `extensionAllowed(session,
 * id)` (the manager) says whether `id` is a loaded user extension there;
 * `openTab(session, url, active)` opens a page in that session's scope. */
export class ExtensionBridge {
  #root; #allowed; #openTab; #sessions = new WeakSet(); #workers = new WeakSet(); #listening = new Map(); #menus = new Map(); #action = new Map(); #documents = new WeakMap();
  // Managed pages by webContents ID (Chrome tab ID) → { contents, window }; last URL per frame.
  #pages = new Map(); #urls = new WeakMap(); #active = new Map(); #windowSessions = new Map(); #preload;
  constructor(root, { extensionAllowed, openTab }) { this.#root = root; this.#allowed = extensionAllowed; this.#openTab = openTab; }
  async #preloadFile() {
    if (!this.#preload) this.#preload = (async () => {
      const file = path.join(this.#root, 'extension-bridge-preload.cjs');
      await mkdir(this.#root, { recursive: true, mode: 0o700 }); await writeFile(file, BRIDGE_PRELOAD, { mode: 0o600 });
      return file;
    })().catch(error => { this.#preload = undefined; throw error; });
    return this.#preload;
  }
  /** Before the person's first extension loads into a page session. */
  async enable(session) {
    if (this.#sessions.has(session)) return;
    const filePath = await this.#preloadFile();
    if (this.#sessions.has(session)) return;
    this.#sessions.add(session);
    session.registerPreloadScript({ type: 'service-worker', id: 'tarobot-extension-bridge', filePath });
    const hook = ({ versionId }) => {
      let worker;
      try { worker = session.serviceWorkers.getWorkerFromVersionID(versionId); } catch { return; }
      const id = /^chrome-extension:\/\/([a-p]{32})\/$/.exec(worker?.scope ?? '')?.[1];
      if (!id || this.#workers.has(worker)) return;
      this.#workers.add(worker);
      worker.ipc.on('tarobot-extension:listen', (_event, name) => {
        if (typeof name !== 'string' || name.length > 64 || !this.#allowed(session, id)) return;
        const key = `${id}`;
        let entry = this.#listening.get(session);
        if (!entry) this.#listening.set(session, entry = new Map());
        if (!entry.has(key)) entry.set(key, new Set());
        entry.get(key).add(name);
      });
      worker.ipc.handle('tarobot-extension:call', (_event, method, args) => this.#call(session, id, method, Array.isArray(args) ? args : []));
    };
    session.serviceWorkers.on('running-status-changed', hook);
  }
  /** The extension was unloaded or removed: its menus, action state and listeners go. */
  forgetExtension(session, id) { this.#listening.get(session)?.delete(id); this.#menus.get(session)?.delete(id); this.#action.get(session)?.delete(id); }

  #manifest(session, id) { try { return (session.extensions ?? session).getExtension(id)?.manifest ?? {}; } catch { return {}; } }
  async #emit(session, name, args, only, shape) {
    const listening = this.#listening.get(session);
    if (!listening?.size) return;
    for (const [id, names] of listening) {
      if (only && only !== id || !names.has(name) || !this.#allowed(session, id)) continue;
      // Like Chrome, an event wakes a stopped extension worker.
      try { const worker = await session.serviceWorkers.startWorkerForScope(`chrome-extension://${id}/`); worker.send('tarobot-extension:event', name, shape ? shape(id) : args); } catch { /* worker unavailable */ }
    }
  }
  // Chrome includes url/title only with the tabs permission, or host access to that page's URL.
  #tabFor(session, id, contents, window) {
    const manifest = this.#manifest(session, id), permissions = (manifest.permissions ?? []).filter(value => typeof value === 'string');
    const hosts = [...permissions.filter(value => value.includes('://') || value === '<all_urls>'), ...(manifest.host_permissions ?? []).filter(value => typeof value === 'string')];
    const windowId = window && !window.isDestroyed() ? window.id : -1;
    let url = '', title = '', loading = false, audible = false;
    try { url = contents.getURL(); title = contents.getTitle(); loading = contents.isLoading(); audible = contents.isCurrentlyAudible(); } catch { /* gone */ }
    const sees = permissions.includes('tabs') || hosts.length > 0 && patternMatches(hosts, url);
    return { id: contents.id, index: -1, windowId, active: this.#active.get(windowId) === contents.id, highlighted: this.#active.get(windowId) === contents.id, pinned: false, incognito: false,
      discarded: false, autoDiscardable: false, groupId: -1, status: loading ? 'loading' : 'complete', audible, mutedInfo: { muted: false }, ...(sees ? { url, title } : {}) };
  }
  #tabEvent(contents, name, extra) {
    const session = contents.session, window = this.#pages.get(contents.id)?.window;
    if (!this.#listening.get(session)?.size) return;
    void this.#emit(session, `tabs.${name}`, [], undefined, id => {
      const tab = this.#tabFor(session, id, contents, window);
      if (name === 'onUpdated') { const sees = 'url' in tab, change = sees ? extra : Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'url' && key !== 'title')); return [contents.id, change, tab]; }
      return [tab];
    });
  }
  /** TaroBird showed this page (its surface's current page). */
  activated(contents, window) {
    if (!window || window.isDestroyed() || this.#active.get(window.id) === contents.id) return;
    this.#active.set(window.id, contents.id);
    if (this.#listening.get(contents.session)?.size) void this.#emit(contents.session, 'tabs.onActivated', [{ tabId: contents.id, windowId: window.id }]);
  }
  #frame(contents, details) {
    const frame = details.frame;
    return { tabId: contents.id, frameId: frameId(frame), parentFrameId: parentFrameId(frame), frameType: frameType(frame), processId: frame?.processId ?? -1, timeStamp: Date.now() };
  }
  #document(frame, renew = false) {
    if (!frame) return undefined;
    if (renew || !this.#documents.has(frame)) this.#documents.set(frame, randomBytes(16).toString('hex').toUpperCase());
    return this.#documents.get(frame);
  }
  /** Every managed page (WorkbenchBrowser): navigation events reach only
   * extensions of its own session that listen for them. */
  observe(contents, window) {
    const session = contents.session;
    this.#pages.set(contents.id, { contents, window });
    if (window) { if (!this.#windowSessions.has(window.id)) this.#windowSessions.set(window.id, new Set()); this.#windowSessions.get(window.id).add(session); }
    const send = (name, details) => { if (this.#listening.get(session)?.size) void this.#emit(session, `webNavigation.${name}`, [details]); };
    this.#tabEvent(contents, 'onCreated');
    contents.on('did-start-loading', () => this.#tabEvent(contents, 'onUpdated', { status: 'loading' }));
    contents.on('did-stop-loading', () => this.#tabEvent(contents, 'onUpdated', { status: 'complete' }));
    contents.on('did-navigate', (_event, url) => this.#tabEvent(contents, 'onUpdated', { url }));
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) this.#tabEvent(contents, 'onUpdated', { url }); });
    contents.on('page-title-updated', (_event, title) => this.#tabEvent(contents, 'onUpdated', { title: String(title).slice(0, 512) }));
    contents.on('audio-state-changed', event => this.#tabEvent(contents, 'onUpdated', { audible: !!event.audible }));
    contents.on('did-start-navigation', event => {
      if (event.isSameDocument || !event.frame) return;
      send('onBeforeNavigate', { ...this.#frame(contents, event), url: event.url, parentDocumentId: this.#document(event.frame.parent) });
    });
    contents.on('did-frame-navigate', (_event, url, _code, _status, isMainFrame, processId, routingId) => {
      const frame = this.#lookup(contents, isMainFrame, processId, routingId);
      if (frame) this.#urls.set(frame, url);
      send('onCommitted', { ...this.#frame(contents, { frame }), url, transitionType: 'link', transitionQualifiers: [], documentId: this.#document(frame, true), documentLifecycle: 'active' });
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame, processId, routingId) => {
      const frame = this.#lookup(contents, isMainFrame, processId, routingId), previous = frame && this.#urls.get(frame);
      const fragment = !!previous && previous.split('#')[0] === url.split('#')[0];
      if (frame) this.#urls.set(frame, url);
      send(fragment ? 'onReferenceFragmentUpdated' : 'onHistoryStateUpdated', { ...this.#frame(contents, { frame }), url, transitionType: 'link', transitionQualifiers: [], documentId: this.#document(frame), documentLifecycle: 'active' });
    });
    const ready = frame => send('onDOMContentLoaded', { ...this.#frame(contents, { frame }), url: frame.url, documentId: this.#document(frame), documentLifecycle: 'active' });
    contents.on('dom-ready', () => { try { ready(contents.mainFrame); } catch { /* gone */ } });
    contents.on('frame-created', (_event, { frame }) => { if (frame && frame !== frame.top) frame.on('dom-ready', () => ready(frame)); });
    contents.on('did-frame-finish-load', (_event, isMainFrame, processId, routingId) => {
      const frame = this.#lookup(contents, isMainFrame, processId, routingId);
      if (frame) send('onCompleted', { ...this.#frame(contents, { frame }), url: frame.url, documentId: this.#document(frame), documentLifecycle: 'active' });
    });
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame, processId, routingId) => {
      const frame = this.#lookup(contents, isMainFrame, processId, routingId);
      send('onErrorOccurred', { ...this.#frame(contents, { frame }), url, error: `net::${description || code}`, documentId: this.#document(frame), documentLifecycle: 'active' });
    });
    const id = contents.id;
    contents.once('destroyed', () => {
      const windowId = window && !window.isDestroyed() ? window.id : -1;
      if (this.#active.get(windowId) === id) this.#active.delete(windowId);
      if (this.#listening.get(session)?.size) void this.#emit(session, 'tabs.onRemoved', [id, { windowId, isWindowClosing: !window || window.isDestroyed() }]);
      this.#pages.delete(id); for (const state of this.#action.get(session)?.values() ?? []) state.tabs.delete(id);
    });
  }
  #lookup(contents, isMainFrame, processId, routingId) {
    try { return isMainFrame ? contents.mainFrame : contents.mainFrame.framesInSubtree.find(frame => frame.processId === processId && frame.routingId === routingId); } catch { return undefined; }
  }
  #frameDetails(frame) {
    return { url: frame.url, frameId: frameId(frame), parentFrameId: parentFrameId(frame), frameType: frameType(frame), processId: frame.processId, errorOccurred: false, documentId: this.#document(frame), documentLifecycle: 'active' };
  }
  #contents(session, tabId) {
    const contents = this.#pages.get(tabId)?.contents;
    return contents && !contents.isDestroyed() && contents.session === session ? contents : undefined;
  }
  #windowList(session) { return [...new Set([...this.#pages.values()].filter(page => !page.contents.isDestroyed() && page.contents.session === session).map(page => page.window))].filter(window => window && !window.isDestroyed()); }
  #window(session, id) { return this.#windowList(session).find(window => window.id === id); }
  #windowInfo(window) {
    const bounds = window.getBounds();
    return { id: window.id, focused: window.isFocused(), top: bounds.y, left: bounds.x, width: bounds.width, height: bounds.height, incognito: false, type: 'normal',
      state: window.isFullScreen() ? 'fullscreen' : window.isMinimized() ? 'minimized' : window.isMaximized() ? 'maximized' : 'normal', alwaysOnTop: window.isAlwaysOnTop() };
  }
  /** An App window that hosted pages closed. */
  windowClosed(id) {
    // Only extensions whose sessions had pages in that window learn of it.
    for (const session of this.#windowSessions.get(id) ?? []) void this.#emit(session, 'windows.onRemoved', [id]);
    this.#windowSessions.delete(id); this.#active.delete(id);
  }

  async #call(session, id, method, args) {
    if (!CALLS.has(method) || !this.#allowed(session, id)) throw new Error('Not available in TaroBird');
    const permissions = new Set(this.#manifest(session, id).permissions ?? []);
    const [first, second] = args;
    switch (method) {
      case 'webNavigation.getFrame': case 'webNavigation.getAllFrames': {
        if (!permissions.has('webNavigation')) throw new Error('Permission webNavigation required');
        const contents = this.#contents(session, first?.tabId);
        if (!contents) return method === 'webNavigation.getFrame' ? null : null;
        const frames = contents.mainFrame.framesInSubtree.map(frame => this.#frameDetails(frame));
        return method === 'webNavigation.getAllFrames' ? frames : frames.find(frame => frame.frameId === first?.frameId) ?? null;
      }
      case 'contextMenus.create': case 'contextMenus.update': case 'contextMenus.remove': case 'contextMenus.removeAll': {
        if (!permissions.has('contextMenus')) throw new Error('Permission contextMenus required');
        let all = this.#menus.get(session);
        if (!all) this.#menus.set(session, all = new Map());
        if (!all.has(id)) all.set(id, new Map());
        const menus = all.get(id), key = value => typeof value === 'number' || typeof value === 'string' ? String(value) : undefined;
        if (method === 'contextMenus.removeAll') { menus.clear(); return; }
        if (method === 'contextMenus.remove') { if (!menus.delete(key(first))) throw new Error(`Cannot find menu item with id ${first}`); for (const [child, item] of menus) if (item.parentId === key(first)) menus.delete(child); return; }
        const properties = method === 'contextMenus.create' ? first : second, itemId = key(method === 'contextMenus.create' ? first?.id : first);
        if (!itemId || menus.size >= 1000 && !menus.has(itemId)) throw new Error('Invalid menu item');
        if (method === 'contextMenus.update' && !menus.has(itemId)) throw new Error(`Cannot find menu item with id ${first}`);
        const previous = menus.get(itemId) ?? { id: method === 'contextMenus.create' ? first.id : first, title: '', contexts: ['page'], type: 'normal', enabled: true, visible: true };
        const clean = { ...previous };
        if (typeof properties?.title === 'string') clean.title = properties.title.slice(0, 256);
        if (Array.isArray(properties?.contexts)) clean.contexts = properties.contexts.filter(value => typeof value === 'string');
        for (const name of ['type']) if (typeof properties?.[name] === 'string') clean[name] = properties[name];
        for (const name of ['enabled', 'visible', 'checked']) if (typeof properties?.[name] === 'boolean') clean[name] = properties[name];
        for (const name of ['documentUrlPatterns', 'targetUrlPatterns']) if (Array.isArray(properties?.[name])) clean[name] = properties[name].filter(value => typeof value === 'string').slice(0, 64);
        if (properties?.parentId !== undefined) clean.parentId = key(properties.parentId);
        menus.set(itemId, clean); return;
      }
      case 'tabs.create': {
        const url = typeof first?.url === 'string' ? first.url : 'about:blank';
        return this.#openTab(session, url, first?.active !== false);
      }
      case 'windows.get': case 'windows.getCurrent': case 'windows.getLastFocused': case 'windows.getAll': {
        const windows = this.#windowList(session);
        if (method === 'windows.getAll') return windows.map(window => this.#windowInfo(window));
        const window = method === 'windows.get' ? this.#window(session, first) : windows.find(item => item.isFocused()) ?? windows[0];
        if (!window) throw new Error(`No window with id: ${first}`);
        return this.#windowInfo(window);
      }
      case 'windows.update': {
        const window = this.#window(session, first);
        if (!window) throw new Error(`No window with id: ${first}`);
        if (second?.focused === true) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
        return this.#windowInfo(window);
      }
    }
    // Toolbar state: kept per extension (and per page) though TaroBird shows no toolbar.
    let all = this.#action.get(session);
    if (!all) this.#action.set(session, all = new Map());
    if (!all.has(id)) all.set(id, { global: { enabled: true }, tabs: new Map() });
    const state = all.get(id), name = method.slice('action.'.length);
    // Per-tab state only for a live page of this session (removed with it), so it stays bounded.
    const scoped = tabId => {
      if (typeof tabId !== 'number') return state.global;
      if (!this.#contents(session, tabId)) throw new Error(`No tab with id: ${tabId}`);
      return state.tabs.get(tabId) ?? state.tabs.set(tabId, {}).get(tabId);
    };
    const read = (field, details) => (typeof details?.tabId === 'number' ? state.tabs.get(details.tabId)?.[field] : undefined) ?? state.global[field];
    switch (name) {
      case 'setTitle': scoped(first?.tabId).title = String(first?.title ?? '').slice(0, 256); return;
      case 'getTitle': return read('title', first) ?? this.#manifest(session, id).action?.default_title ?? '';
      case 'setBadgeText': scoped(first?.tabId).badge = String(first?.text ?? '').slice(0, 16); return;
      case 'getBadgeText': return read('badge', first) ?? '';
      case 'setBadgeBackgroundColor': scoped(first?.tabId).badgeColor = first?.color; return;
      case 'getBadgeBackgroundColor': return read('badgeColor', first) ?? [0, 0, 0, 0];
      case 'setBadgeTextColor': scoped(first?.tabId).badgeTextColor = first?.color; return;
      case 'getBadgeTextColor': return read('badgeTextColor', first) ?? [255, 255, 255, 255];
      case 'setPopup': scoped(first?.tabId).popup = String(first?.popup ?? ''); return;
      case 'getPopup': { const popup = read('popup', first) ?? this.#manifest(session, id).action?.default_popup ?? ''; return popup && !popup.includes('://') ? `chrome-extension://${id}/${popup.replace(/^\//, '')}` : popup; }
      case 'setIcon': scoped(first?.tabId).icon = first?.path ?? (first?.imageData ? 'imageData' : undefined); return;
      case 'enable': scoped(first).enabled = true; return;
      case 'disable': scoped(first).enabled = false; return;
      case 'isEnabled': return (typeof first === 'number' ? state.tabs.get(first)?.enabled : undefined) ?? state.global.enabled;
      case 'getUserSettings': return { isOnToolbar: false };
      case 'openPopup': throw new Error('TaroBird does not show extension popups');
    }
    throw new Error('Not available in TaroBird');
  }

  /** Items for the page context menu; `click` reports contextMenus.onClicked. */
  menuItems(session, params, tab) {
    const out = [], all = this.#menus.get(session);
    if (!all) return out;
    const kinds = new Set(['all', 'page']);
    if (params.frameURL) kinds.add('frame'); if (params.selectionText) kinds.add('selection'); if (params.linkURL) kinds.add('link');
    if (params.isEditable) kinds.add('editable'); if (['image', 'video', 'audio'].includes(params.mediaType)) kinds.add(params.mediaType);
    const info = item => ({ menuItemId: item.id, ...(item.parentId ? { parentMenuItemId: item.parentId } : {}), pageUrl: params.pageURL,
      ...(params.frameURL ? { frameUrl: params.frameURL } : {}), ...(params.linkURL ? { linkUrl: params.linkURL } : {}), ...(params.srcURL ? { srcUrl: params.srcURL } : {}),
      ...(params.mediaType && params.mediaType !== 'none' ? { mediaType: params.mediaType } : {}), ...(params.selectionText ? { selectionText: params.selectionText } : {}),
      editable: !!params.isEditable, frameId: 0, ...(item.type === 'checkbox' ? { wasChecked: !!item.checked, checked: !item.checked } : {}) });
    const shown = item => item.visible !== false && item.contexts.some(context => kinds.has(context))
      && patternMatches(item.documentUrlPatterns, params.frameURL || params.pageURL) && (!item.targetUrlPatterns || patternMatches(item.targetUrlPatterns, params.linkURL || params.srcURL));
    for (const [id, menus] of all) {
      if (!this.#allowed(session, id)) continue;
      const build = parentId => [...menus.values()].filter(item => item.parentId === parentId && shown(item)).map(item => {
        if (item.type === 'separator') return { type: 'separator' };
        const children = build(String(item.id)), label = String(item.title).replace(/%s/g, String(params.selectionText ?? '').slice(0, 32));
        const entry = { label, enabled: item.enabled !== false, type: item.type === 'checkbox' || item.type === 'radio' ? item.type : 'normal', checked: !!item.checked };
        return children.length ? { ...entry, type: 'submenu', submenu: children } : { ...entry, click: () => void this.#emit(session, 'contextMenus.onClicked', [info(item), tab], id) };
      });
      const items = build(undefined);
      if (items.length) out.push(items.length === 1 ? items[0] : { label: this.#manifest(session, id).name ?? id, submenu: items });
    }
    if (out.length) out.unshift({ type: 'separator' });
    return out;
  }
}
