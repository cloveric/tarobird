import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BROWSER_ACTIONS, BROWSER_EVENT, BROWSER_LIMITS, BROWSER_VERSION, BrowserError, MUTATING, NATIVE_INPUT, parseBrowserAction, parseBrowserLayout, parseBrowserReset } from './browser-contract.mjs';
import { PAGE_WORLD, pageScript } from './browser-page.mjs';
import { COMPAT_PROBE, UNLOAD_PROBE, classifyURL, isGoogleSignInURL, navigationURL, partitionFor, permissionLabel, scopeKey, secureBrowserSession } from './browser-policy.mjs';
import { EXTENSIONS_COMMAND, extensionsFor } from './browser-extensions.mjs';
import { PERSONAL_BROWSER_SCOPE } from '../shared/personal-browser.mjs';
import { executableName } from './files.mjs';
import { DEFAULT_SETTINGS, userStoreFor } from './browser-user-store.mjs';
import { clampZoom, deviceSize, devicePreview, effectiveZoom, fitDevice, historyURL, saveName, shortcutCommand, zoomStep } from './browser-user-tools.mjs';

export const BROWSER_COMMANDS = Object.freeze(['workbench_browser', 'workbench_browser_layout', 'workbench_browser_reset', EXTENSIONS_COMMAND]);
const READ_ONLY = new Set(['capabilities', 'list', 'observe', 'selection', 'screenshot', 'downloads']);
// Metadata and control requests that a hidden window does not pause. Every other
// Bot request acts on, reads or changes a page, which needs the visible window.
const HIDDEN_ALLOWED = new Set(['capabilities', 'list', 'downloads', 'cancel', 'takeover', 'reveal', 'upload_begin', 'upload_write']);
// User-only actions (see USER_ONLY) never reach here from a Bot.
const NAVIGATION = new Set(['open', 'navigate', 'back', 'forward', 'reload', 'wake']);
const USER_INPUT = new Set(['mouseDown', 'rawKeyDown', 'keyDown', 'char', 'touchStart', 'gestureTap']);
const KEYBOARD = new Set(['rawKeyDown', 'keyDown', 'char']);
const KEY_CODES = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Rendering a PDF never holds the window's tool dialog longer than this.
const PDF_MS = 60000;

// One registry for all windows: session handlers receive a webContents and
// must find the managed tab without trusting anything the page says.
const routes = new Map();
const configured = new WeakSet();
const route = contents => { try { return contents && !contents.isDestroyed() ? routes.get(contents.id) : undefined; } catch { return undefined; } };
// Partitions used in this run, and one write queue for the registry that maps a
// partition to its Host (directory names are hashes and cannot be attributed).
const PARTITION = /^tarobot-browser-v1-[0-9a-f]{32}$/;
const usedPartitions = new Set();
let registryWrite = Promise.resolve();
// Shared by every App window: partitions (cookies) are global, so a Host reset
// fences and purges that Host in all windows, including ones created meanwhile.
const resetting = new Set(), instances = new Set(), remembered = new Set();
// Sessions whose pages are being closed for an extension compatibility switch
// (session → promise settled when it is over). Documents committed while the
// request filter existed stay outside the extension policy once it is removed,
// so no page of such a session may start until the switch is decided.
const compatGates = new Map();
const hostHash = host => createHash('sha256').update(`tarobot-browser-v1\0${host}`).digest('hex').slice(0, 32);

/** Main-owned WebContentsView pages for one App window. The App renderer asks
 * through validated commands; pages never get preload, IPC, App protocols,
 * App permission grants, Host identity or the App session. */
export class WorkbenchBrowser {
  #tabs = new Map(); #receipts = new Map(); #downloads = new Map(); #uploads = new Map(); #grants = new Map();
  #generation = 0; #layoutSeq = 0; #layoutHidden = true; #layoutViews = []; #lastSize = { width: 1024, height: 768 }; #quitting = false; #disposed = false; #fullscreen; #fullscreenOwnsWindow = false;
  #prompts = Promise.resolve(); #uploadRoot; #toolBusy;
  #spawning = new Set();
  constructor(window, electron, { emit = () => {}, reveal, addon, platform = process.platform, devTools = false, limits = BROWSER_LIMITS, now = Date.now, registry, partitionRoot, store, extensions } = {}) {
    this.window = window; this.electron = electron; this.emitEvent = emit; this.reveal = reveal; this.addon = addon;
    // Optional (App wiring): partition→Host registry file and Chromium's Partitions directory.
    this.registry = registry; this.partitionRoot = partitionRoot;
    // History and browser settings of the person's page tools, beside the registry.
    this.store = store ?? userStoreFor(registry ? path.join(path.dirname(registry), 'workbench-browser-user') : undefined, { now });
    // The person's installed extensions (shared by all windows); absent in tests without a profile.
    this.extensions = extensions ?? extensionsFor(registry ? path.join(path.dirname(registry), 'workbench-browser-extensions') : undefined, electron,
      { changed: () => { for (const owner of instances) owner.#emit({ kind: 'extensions' }); }, openTab: (session, url, active) => WorkbenchBrowser.#openForExtension(session, url, active),
        drain: (session, options) => WorkbenchBrowser.drainForCompat(session, options) });
    this.windowId = window.id;
    instances.add(this);
    this.platform = platform; this.devTools = devTools; this.limits = limits; this.now = now; this.id = randomUUID();
    // Hiding to the tray or minimizing pauses every pending Bot step; the person
    // (or the Bot through `reveal` after they asked) must show the window first.
    this.onHidden = () => { for (const tab of this.#tabs.values()) this.#interrupt(tab, 'window_hidden', 'paused', false, true); };
    window.on?.('hide', this.onHidden); window.on?.('minimize', this.onHidden);
    // HTML fullscreen turns the whole window fullscreen; follow its size changes.
    this.onResize = () => { if (this.#fullscreen) this.#apply(); };
    window.on?.('resize', this.onResize);
  }
  #hidden() { return !this.window.isVisible() || this.window.isMinimized(); }
  get english() { try { return this.electron.app.getLocale().startsWith('en'); } catch { return false; } }
  // Events go only to this window's trusted App document. Each carries its
  // scope so several conversation panes can ignore each other's pages.
  #emit(payload, scope = this.#tabs.get(payload.tab)?.scope) {
    if (!this.#disposed) try { this.emitEvent({ window: this.id, ...(scope ? { scope } : {}), ...payload }); } catch { /* window gone */ }
  }

  async request(command, input, active) {
    if (this.#disposed) throw new Error('native_document_retired');
    if (command === 'workbench_browser_layout') { this.#layout(parseBrowserLayout(input)); return null; }
    if (command === 'workbench_browser_reset') return this.reset(parseBrowserReset(input));
    // Trusted App UI only: a separate command, never a browser action a Bot can request.
    if (command === EXTENSIONS_COMMAND) {
      if (!this.extensions) throw new Error('extensions_unavailable');
      // A scope's session is created with page policy before anything loads into it.
      return this.extensions.request(input, { window: this.window, english: this.english, prepare: scope => this.#session(scope) });
    }
    if (command !== 'workbench_browser') throw new Error('unknown_desktop_command');
    const args = parseBrowserAction(input), key = scopeKey(args.scope);
    if (!args.requestId) return this.#run(args, key, active).catch(error => this.#failure(args, error));
    const id = `${key}\0${args.requestId}`, hash = createHash('sha256').update(JSON.stringify(args)).digest('hex');
    const prior = this.#receipts.get(id);
    if (prior) return prior.hash === hash ? prior.promise : this.#receipt(args, undefined, 'failed', { error: 'request_conflict' });
    // Only side effects are replayed. Reads (observations, screenshots) simply
    // run again, so large page data is never retained in the receipt cache.
    if (!MUTATING.has(args.action)) return this.#run(args, key, active).catch(error => this.#failure(args, error));
    const now = this.now();
    for (const [entry, value] of this.#receipts) if (this.#receipts.size >= this.limits.receipts || now - value.at > this.limits.receiptMs) this.#receipts.delete(entry); else break;
    const promise = this.#run(args, key, active).catch(error => this.#failure(args, error));
    this.#receipts.set(id, { hash, promise, at: now });
    return promise;
  }

  #receipt(args, tab, status, extra = {}) {
    const state = tab ? this.#state(tab) : {};
    return { requestId: args.requestId, action: args.action, window: this.id, tab: tab?.id ?? args.tab, status, ...state, ...extra, untrusted: true };
  }
  #state(tab) {
    const contents = this.#live(tab) ? tab.contents : undefined;
    return { url: contents?.getURL() || tab.url, title: contents ? contents.getTitle() : tab.title, loading: contents ? contents.isLoading() : false,
      navigation: tab.navigation, state: tab.state, control: tab.control, visible: tab.visible,
      zoomFactor: tab.zoom ?? 1, devicePreview: devicePreview(tab.device, tab.previewScale ?? 1) };
  }
  #failure(args, error, tab = this.#tabs.get(args.tab), task) {
    if (error instanceof BrowserError) return this.#receipt(args, tab, error.status, { error: error.code, ...(error.detail ? { detail: error.detail } : {}) });
    const code = error instanceof Error && /^[a-z_]{3,64}$/.test(error.message) ? error.message : 'browser_action_failed';
    return this.#receipt(args, tab, task?.dispatched ? 'unknown' : 'failed', { error: code });
  }
  #live(tab) { try { return !!tab?.contents && !tab.contents.isDestroyed(); } catch { return false; } }
  #tab(args, key) {
    const tab = this.#tabs.get(args.tab);
    if (!tab) throw new BrowserError('tab_not_found');
    if (tab.key !== key) throw new BrowserError('tab_scope_mismatch');
    return tab;
  }

  async #run(args, key, active) {
    const source = args.source ?? 'bot';
    // A Host being reset cannot recreate pages, sessions or tasks meanwhile.
    if (resetting.has(args.scope.host) && !['capabilities', 'list'].includes(args.action)) throw new BrowserError('scope_resetting', 'cancelled');
    if (this.#quitting && !READ_ONLY.has(args.action)) throw new BrowserError('quitting', 'cancelled');
    if (source === 'bot' && !HIDDEN_ALLOWED.has(args.action) && this.#hidden()) throw new BrowserError('window_hidden', 'paused');
    switch (args.action) {
      case 'capabilities': return this.#receipt(args, undefined, 'ok', { version: BROWSER_VERSION, actions: BROWSER_ACTIONS, limits: this.limits, platform: this.platform });
      case 'list': return this.#receipt(args, undefined, 'ok', { tabs: [...this.#tabs.values()].filter(tab => tab.key === key).map(tab => this.#summary(tab)) });
      case 'open': return this.#open(args, key, active);
      case 'clear_data': return this.#clear(args, key);
      case 'revoke_scope': return this.#revoke(args, key);
      case 'reveal': {
        if (args.tab) this.#tab(args, key);
        if (!this.reveal) throw new BrowserError('reveal_unavailable');
        await this.reveal(); return this.#receipt(args, args.tab ? this.#tabs.get(args.tab) : undefined, 'ok');
      }
      case 'downloads': return this.#receipt(args, undefined, 'ok', { downloads: [...this.#downloads.values()].filter(entry => entry.key === key).map(entry => this.#downloadSummary(entry)) });
      case 'download_cancel': case 'download_open': case 'download_reveal': return this.#downloadAction(args, key);
      case 'upload_begin': case 'upload_write': return this.#stage(args, key, active);
      case 'history': case 'clear_history': case 'settings': case 'settings_set': return this.#userData(args, key);
    }
    const tab = this.#tab(args, key);
    if (args.navigation !== undefined && args.navigation !== tab.navigation) throw new BrowserError('stale_navigation');
    if (source === 'bot' && tab.revoked) throw new BrowserError('scope_revoked');
    if (source === 'bot' && tab.control === 'user' && !['cancel', 'takeover', 'resume'].includes(args.action)) throw new BrowserError('user_control', 'paused');
    switch (args.action) {
      case 'cancel':
        if (args.targetRequestId) return this.#cancelTarget(args, tab, key);
        return this.#receipt(args, tab, 'ok', { cancelled: this.#interrupt(tab, 'cancelled', 'cancelled', false) });
      case 'takeover':
        tab.control = 'user'; this.#interrupt(tab, 'user_control', 'paused', true);
        this.#emit({ kind: 'control', tab: tab.id, control: 'user' }); return this.#receipt(args, tab, 'ok');
      case 'resume':
        if (tab.revoked) throw new BrowserError('scope_revoked');
        tab.control = 'bot'; tab.epoch++;
        this.#emit({ kind: 'control', tab: tab.id, control: 'bot' }); return this.#receipt(args, tab, 'ok', { observeRequired: true });
      case 'close': {
        const result = await this.#close(tab, { prompt: source === 'user', force: args.force === true && source === 'user', reason: source });
        return result === 'closed' ? this.#receipt(args, tab, 'ok', { state: 'closed' }) : this.#receipt(args, tab, 'needs_user', { error: 'page_has_unsaved_changes' });
      }
      case 'sleep': return this.#sleep(args, tab);
      case 'find': return this.#find(args, tab);
      case 'stop_find': this.#stopFind(tab); return this.#receipt(args, tab, 'ok');
      case 'zoom': this.#setZoom(tab, args.factor); return this.#receipt(args, tab, 'ok');
      case 'device': return this.#device(args, tab);
      case 'print': return this.#print(args, tab);
      case 'save_screenshot': return this.#saveScreenshot(args, tab);
    }
    if (args.action !== 'wake' && tab.state === 'sleeping') throw new BrowserError('tab_sleeping');
    const task = { args, source, active, tab, generation: this.#generation, dispatched: false, cancelled: null };
    if (source === 'user') {
      if (MUTATING.has(args.action)) this.#interrupt(tab, 'user_input', 'paused', true);
      return this.#execute(tab, task);
    }
    return new Promise(resolve => {
      task.resolve = resolve; task.queued = true; tab.tasks.push(task); this.#activity(tab);
      tab.queue = tab.queue.then(() => task.done ? undefined : this.#execute(tab, task).then(resolve));
    });
  }

  async #execute(tab, task) {
    const ms = NAVIGATION.has(task.args.action) ? this.limits.navigationMs : this.limits.actionMs;
    let timer;
    task.startedAt = this.now();
    if (task.queued) { tab.current = task; this.#activity(tab); }
    try {
      this.#check(tab, task);
      // A late page reply after the deadline must not dispatch input anymore.
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { task.cancelled ??= { code: 'timeout', status: 'failed' }; reject(new BrowserError('timeout', task.dispatched ? 'unknown' : 'failed')); }, ms); });
      // A timed-out Bot input step may still be finishing on the page. The next
      // one waits for it (within its own deadline) so inputs never interleave.
      // Reads and navigation do not wait; a new document clears the chain.
      const serial = task.queued && MUTATING.has(task.args.action) && !NAVIGATION.has(task.args.action) && task.args.action !== 'stop';
      const previous = serial ? tab.unsettled : undefined;
      const run = previous ? previous.then(() => { this.#check(tab, task); return this.#perform(tab, task); }) : this.#perform(tab, task);
      if (serial) tab.unsettled = run.then(() => undefined, () => undefined);
      return await Promise.race([run, timeout]);
    } catch (error) { return this.#failure(task.args, error, tab, task); }
    finally {
      clearTimeout(timer); task.done = true;
      if (task.queued) {
        if (tab.current === task) tab.current = undefined;
        const index = tab.tasks.indexOf(task); if (index >= 0) tab.tasks.splice(index, 1);
        this.#activity(tab);
      }
    }
  }
  /** Re-checked before each side effect: a queued action never follows the user
   * to another tab, a replaced App document, a takeover or a hidden window. */
  #check(tab, task) {
    if (task.cancelled) throw new BrowserError(task.cancelled.code, task.cancelled.status);
    if (task.generation !== this.#generation || !task.active()) throw new BrowserError('native_document_retired', 'cancelled');
    if (resetting.has(tab.scope.host)) throw new BrowserError('scope_resetting', 'cancelled');
    if (this.#quitting) throw new BrowserError('quitting', 'cancelled');
    if (this.#tabs.get(tab.id) !== tab) throw new BrowserError('tab_closed');
    if (task.args.action === 'wake') return;
    if (!this.#live(tab)) throw new BrowserError(tab.state === 'sleeping' ? 'tab_sleeping' : 'tab_closed');
    if (task.source === 'bot' && tab.revoked) throw new BrowserError('scope_revoked');
    if (task.source === 'bot' && tab.control === 'user') throw new BrowserError('user_control', 'paused');
    if (task.source === 'bot' && tab.tool) throw new BrowserError('page_tool_active', 'paused');
    if (tab.crashed && !['reload', 'navigate'].includes(task.args.action)) throw new BrowserError('page_unavailable');
    if (task.source === 'bot' && this.#hidden()) throw new BrowserError('window_hidden', 'paused');
    if (task.source === 'bot' && NATIVE_INPUT.has(task.args.action) && (!tab.visible || this.#layoutHidden)) throw new BrowserError('tab_not_visible', 'paused');
  }
  /** Cancel exactly one Bot request on this tab (a Host dispatch). Another
   * Bot step, a person's own operation and other tabs are never touched; a
   * request that is no longer queued or running is an explicit no-op. */
  async #cancelTarget(args, tab, key) {
    const id = args.targetRequestId, task = tab.tasks.find(item => !item.done && item.args.requestId === id);
    if (!task) {
      const prior = this.#receipts.get(`${key}\0${id}`);
      const settled = prior ? await Promise.race([prior.promise, Promise.resolve(undefined)]) : undefined;
      const finished = settled?.tab === tab.id;
      return this.#receipt(args, tab, 'ok', { cancelled: 0, cancel: { targetRequestId: id, outcome: finished ? 'finished' : 'not_current', ...(finished ? { finalStatus: settled.status } : {}) } });
    }
    if (task === tab.current || !task.queued) {
      task.cancelled ??= { code: 'cancelled', status: 'cancelled' };
      // Already-dispatched input cannot be recalled; its real outcome follows.
      return this.#receipt(args, tab, 'ok', { cancelled: 1, cancel: { targetRequestId: id, outcome: task.dispatched ? 'too_late' : 'cancel_requested' } });
    }
    task.done = true; task.resolve(this.#receipt(task.args, tab, 'cancelled', { error: 'cancelled' }));
    tab.tasks = tab.tasks.filter(item => item !== task); this.#activity(tab);
    return this.#receipt(args, tab, 'ok', { cancelled: 1, cancel: { targetRequestId: id, outcome: 'cancelled' } });
  }
  #interrupt(tab, code, status, invalidate, botOnly = false) {
    let count = 0;
    if (botOnly && !tab.tasks.some(task => !task.done)) return 0;
    for (const task of tab.tasks) {
      // A running open is never queued: another Bot step may have become
      // current meanwhile, but only its own runner can settle it.
      if (task === tab.current || !task.queued) { if (!task.done) { task.cancelled ??= { code, status }; count++; } continue; }
      if (task.done) continue;
      task.done = true; count++; task.resolve(this.#receipt(task.args, tab, status, { error: code }));
    }
    tab.tasks = tab.tasks.filter(task => task === tab.current || !task.done);
    if (invalidate) tab.epoch++;
    this.#activity(tab);
    return count;
  }
  #activity(tab) {
    const pending = tab.tasks.filter(task => !task.done).length, current = tab.current?.args.action ?? null;
    if (tab.lastActivity === `${pending}:${current}`) return;
    tab.lastActivity = `${pending}:${current}`;
    this.#emit({ kind: 'activity', tab: tab.id, pending, current, bot: pending > 0 || !!current && tab.current.source === 'bot' });
  }

  async #page(tab, operation, args = {}, task) {
    const contents = tab.contents, navigation = tab.navigation;
    const result = await contents.executeJavaScriptInIsolatedWorld(PAGE_WORLD, [{ code: pageScript(operation, { prefix: `r${tab.navigation}.${tab.epoch}.`, ...args }) }], false);
    if (contents !== tab.contents || navigation !== tab.navigation) throw new BrowserError('stale_navigation', task?.dispatched ? 'unknown' : 'failed');
    if (result && typeof result === 'object' && typeof result.error === 'string') {
      const { error, ...detail } = result;
      throw new BrowserError(error, task?.dispatched ? 'unknown' : 'failed', Object.keys(detail).length ? detail : undefined);
    }
    return result;
  }
  #ref(tab, ref) {
    const [navigation, epoch] = ref.slice(1).split('.').map(Number);
    if (navigation !== tab.navigation || epoch !== tab.epoch) throw new BrowserError('stale_ref');
    return ref;
  }

  async #perform(tab, task) {
    const { args } = task, contents = tab.contents;
    switch (args.action) {
      case 'wake': return this.#wake(args, tab, task);
      case 'navigate': {
        const url = navigationURL(args.url);
        if (isGoogleSignInURL(url)) return this.#googleNavigate(args, tab, task, url);
        return this.#navigate(args, tab, task, () => contents.loadURL(url));
      }
      case 'back': case 'forward': {
        const history = contents.navigationHistory;
        if (!(args.action === 'back' ? history.canGoBack() : history.canGoForward())) throw new BrowserError('no_history');
        return this.#navigate(args, tab, task, () => args.action === 'back' ? history.goBack() : history.goForward());
      }
      case 'reload': tab.crashed = false; return this.#navigate(args, tab, task, () => contents.reload());
      case 'stop': task.dispatched = true; contents.stop(); return this.#receipt(args, tab, 'ok');
      case 'observe': {
        const observation = await this.#page(tab, 'observe', { mode: args.mode ?? 'viewport', maxText: args.maxText ?? 12000, maxElements: args.maxElements ?? 150 }, task);
        // Refs from a read that raced a takeover or user input are already stale.
        this.#check(tab, task);
        const size = () => Buffer.byteLength(JSON.stringify(observation));
        while (size() > this.limits.observationBytes && observation.elements.length) { observation.elements.length = Math.floor(observation.elements.length * 0.8); observation.truncated = true; }
        while (size() > this.limits.observationBytes && observation.text.length > 256) { observation.text = observation.text.slice(0, Math.floor(observation.text.length * 0.8)); observation.truncated = true; }
        this.#snapshot(tab, observation.scroll);
        return this.#receipt(args, tab, 'ok', { snapshot: tab.snapshot, observation });
      }
      case 'selection': return this.#receipt(args, tab, 'ok', { selection: await this.#page(tab, 'selection', { maxText: 12000 }, task) });
      case 'screenshot': return this.#screenshot(args, tab, task);
      case 'click': return args.ref ? this.#click(args, tab, task) : this.#pointClick(args, tab, task);
      case 'type': return this.#type(args, tab, task);
      case 'press': return this.#press(args, tab, task);
      case 'scroll': {
        if (args.ref) this.#ref(tab, args.ref);
        this.#check(tab, task);
        const evidence = await this.#page(tab, 'scroll', { ref: args.ref, direction: args.direction, amount: args.amount, to: args.to }, task)
          .catch(error => { if (!(error instanceof BrowserError)) task.dispatched = true; throw error; });
        task.dispatched = true;
        return this.#receipt(args, tab, 'ok', { evidence });
      }
      case 'select': {
        this.#ref(tab, args.ref);
        this.#check(tab, task);
        // The page validates every option before changing anything: a reported
        // error means no change; a lost reply after running means unknown.
        const evidence = await this.#page(tab, 'chooseOption', { ref: args.ref, values: args.values, labels: args.labels }, task)
          .catch(error => { if (!(error instanceof BrowserError)) task.dispatched = true; throw error; });
        task.dispatched = true; tab.edited = true;
        return this.#receipt(args, tab, evidence.matches ? 'ok' : 'unknown', { evidence });
      }
      case 'upload': return this.#upload(args, tab, task);
      default: throw new BrowserError('unsupported_action');
    }
  }

  /** A navigation is reported once its main document commits and is ready, not
   * when the API was called. Failures keep their Chromium error description. */
  async #navigate(args, tab, task, trigger) {
    const contents = tab.contents, start = tab.navigation;
    this.#check(tab, task);
    tab.blockedDuring = undefined;
    const outcome = await new Promise(resolve => {
      let finished = false;
      let done = value => { if (finished) return; finished = true; contents.off('dom-ready', ready); contents.off('did-navigate-in-page', inPage); contents.off('did-fail-load', fail); contents.off('did-stop-loading', stopped); contents.off('destroyed', gone); resolve(value); };
      const ready = () => { if (tab.navigation !== start) done({ committed: true }); };
      const inPage = (_event, _url, main) => { if (main) done({ committed: true, sameDocument: true }); };
      const fail = (_event, code, description, _url, main) => { if (main && code !== -3) done({ error: code, description }); };
      const stopped = () => setTimeout(() => done(tab.navigation !== start ? { committed: true } : { stopped: true }), 0);
      const gone = () => done({ gone: true });
      const limit = setTimeout(() => done({ timeout: true }), this.limits.navigationMs + 1000);
      const finish = done; done = value => { clearTimeout(limit); finish(value); };
      contents.on('dom-ready', ready); contents.on('did-navigate-in-page', inPage); contents.on('did-fail-load', fail); contents.on('did-stop-loading', stopped); contents.once('destroyed', gone);
      task.dispatched = true;
      try { const result = trigger(); if (result?.catch) result.catch(() => {}); } catch (error) { done({ thrown: error instanceof Error ? error.message : 'navigation_failed' }); }
    });
    if (outcome.committed) return this.#receipt(args, tab, 'ok', { evidence: { committed: true, sameDocument: !!outcome.sameDocument } });
    if (outcome.error) return this.#receipt(args, tab, 'failed', { error: 'navigation_failed', detail: { code: outcome.error, description: String(outcome.description).slice(0, 200) } });
    if (tab.blockedDuring) return this.#receipt(args, tab, 'failed', { error: 'navigation_blocked', detail: { reason: tab.blockedDuring } });
    if (outcome.thrown) return this.#receipt(args, tab, 'failed', { error: /^[a-z_]{3,64}$/.test(outcome.thrown) ? outcome.thrown : 'navigation_failed' });
    if (outcome.gone) return this.#receipt(args, tab, 'unknown', { error: 'tab_closed' });
    return this.#receipt(args, tab, 'unknown', { error: 'navigation_not_committed', evidence: { download: tab.lastDownloadAt > (task.startedAt ?? 0) } });
  }
  #snapshot(tab, scroll) { tab.snapshot++; tab.snapshotAt = { navigation: tab.navigation, epoch: tab.epoch, scroll }; }

  async #screenshot(args, tab, task) {
    const image = await tab.contents.capturePage(undefined, { stayHidden: true });
    if (image.isEmpty()) throw new BrowserError('capture_failed');
    const { viewport, ...scroll } = await this.#page(tab, 'scrollPosition', {}, task);
    let output = image, size = image.getSize();
    const width = args.maxWidth ?? 1600;
    if (size.width > width) { output = image.resize({ width, quality: 'good' }); size = output.getSize(); }
    // Always lossless PNG; a very detailed page is scaled down instead.
    const mime = 'image/png';
    let bytes = output.toPNG();
    while (bytes.length > this.limits.imageBytes && size.width > 480) { output = image.resize({ width: Math.round(size.width * 0.75), quality: 'good' }); size = output.getSize(); bytes = output.toPNG(); }
    if (bytes.length > this.limits.imageBytes) throw new BrowserError('capture_too_large');
    this.#snapshot(tab, scroll);
    return this.#receipt(args, tab, 'ok', { snapshot: tab.snapshot, image: { mime, data: bytes.toString('base64'), width: size.width, height: size.height }, scroll, viewport });
  }

  #mark(tab) { tab.syntheticUntil = this.now() + 600; }
  async #click(args, tab, task) {
    this.#ref(tab, args.ref);
    const token = randomUUID(), target = await this.#page(tab, 'prepare', { op: 'click', ref: args.ref, token }, task);
    this.#check(tab, task);
    const contents = tab.contents, zoom = contents.getZoomFactor(), x = Math.round(target.x * zoom), y = Math.round(target.y * zoom);
    const before = { url: contents.getURL(), navigation: tab.navigation, starts: tab.starts };
    task.dispatched = true; this.#mark(tab);
    contents.sendInputEvent({ type: 'mouseMove', x, y });
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    return this.#settle(args, tab, task, token, before, { target: target.target });
  }
  async #pointClick(args, tab, task) {
    const snapshot = tab.snapshotAt;
    if (args.snapshot !== tab.snapshot || !snapshot || snapshot.navigation !== tab.navigation || snapshot.epoch !== tab.epoch) throw new BrowserError('stale_snapshot');
    const token = randomUUID(), target = await this.#page(tab, 'pointTarget', { x: args.point.x, y: args.point.y, token }, task);
    if (target.scroll.x !== snapshot.scroll?.x || target.scroll.y !== snapshot.scroll?.y) { await this.#page(tab, 'settle', { token }).catch(() => {}); throw new BrowserError('stale_snapshot'); }
    this.#check(tab, task);
    const contents = tab.contents, zoom = contents.getZoomFactor(), x = Math.round(args.point.x * zoom), y = Math.round(args.point.y * zoom);
    const before = { url: contents.getURL(), navigation: tab.navigation, starts: tab.starts };
    task.dispatched = true; this.#mark(tab);
    contents.sendInputEvent({ type: 'mouseMove', x, y });
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    return this.#settle(args, tab, task, token, before, { target: target.target, frame: target.frame });
  }
  /** Success needs evidence: the page saw a trusted event on the target, or a
   * navigation started. Otherwise the side effect is reported as unknown. */
  async #settle(args, tab, task, token, before, extra) {
    await delay(150);
    let mark = null;
    if (this.#live(tab) && tab.navigation === before.navigation) mark = await this.#page(tab, 'settle', { token }).catch(() => null);
    const navigationStarted = tab.starts !== before.starts || tab.navigation !== before.navigation;
    const evidence = { delivered: !!mark?.delivered, navigationStarted, urlBefore: before.url, ...extra };
    return this.#receipt(args, tab, evidence.delivered || navigationStarted ? 'ok' : 'unknown', { evidence });
  }
  async #type(args, tab, task) {
    this.#ref(tab, args.ref);
    const mode = args.mode ?? 'replace';
    const prepared = await this.#page(tab, 'prepare', { op: 'type', ref: args.ref, mode }, task);
    this.#check(tab, task);
    task.dispatched = true; tab.edited = true;
    let method = 'ime';
    if (args.text) { await tab.contents.insertText(args.text); await delay(30); }
    let field = await this.#page(tab, 'field', { ref: args.ref, text: args.text, mode }, task);
    // A field that already ended with the text is not proof of an append.
    const landed = value => value.matches && (mode !== 'append' || value.length === prepared.before + args.text.length);
    if (!landed(field) && args.text && !field.focused && field.length === prepared.before) {
      // The page moved focus after preparation: the committed text may be in
      // another field. Writing the target too could duplicate it; report it.
      return this.#receipt(args, tab, 'unknown', { error: 'focus_lost', evidence: { method, focusLost: true, ...field } });
    }
    // IME commit reaches only a focused frame. If nothing changed, write the
    // same value through the DOM rather than taking keyboard focus from chat.
    if (!landed(field) && (field.length === prepared.before || !args.text)) {
      // Not after a timeout, cancel, takeover or hidden window.
      this.#check(tab, task);
      await this.#page(tab, 'domType', { ref: args.ref, text: args.text, mode }, task);
      field = await this.#page(tab, 'field', { ref: args.ref, text: args.text, mode }, task); method = 'dom';
    }
    return this.#receipt(args, tab, landed(field) ? 'ok' : 'unknown', { evidence: { method, ...field } });
  }
  async #press(args, tab, task) {
    const modifiers = args.modifiers ?? [], token = randomUUID();
    const key = args.key === 'Space' ? ' ' : args.key.length === 1 && modifiers.includes('shift') ? args.key.toUpperCase() : args.key;
    const target = await this.#page(tab, 'keyTarget', { key, token }, task);
    this.#check(tab, task);
    const contents = tab.contents, keyCode = KEY_CODES[args.key] ?? args.key;
    const before = { url: contents.getURL(), navigation: tab.navigation, starts: tab.starts };
    task.dispatched = true; this.#mark(tab);
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    const char = args.key === 'Enter' ? '\r' : args.key === 'Space' ? ' ' : args.key.length === 1 ? (modifiers.includes('shift') ? args.key.toUpperCase() : args.key) : undefined;
    if (char && !modifiers.some(value => value === 'control' || value === 'meta' || value === 'alt')) contents.sendInputEvent({ type: 'char', keyCode: char, modifiers });
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    if (['Enter', 'Space', 'Backspace', 'Delete'].includes(args.key) || char) tab.edited = true;
    return this.#settle(args, tab, task, token, before, { focused: target.target });
  }

  async #open(args, key, active = () => true) {
    const existing = this.#tabs.get(args.tab);
    if (existing) {
      if (existing.key !== key) throw new BrowserError('tab_scope_mismatch');
      return this.#receipt(args, existing, 'ok', { existing: true });
    }
    if (resetting.has(args.scope.host)) throw new BrowserError('scope_resetting', 'cancelled');
    if (this.#tabs.size >= this.limits.tabs) throw new BrowserError('tab_limit', 'needs_user');
    const url = args.url ? navigationURL(args.url) : 'about:blank';
    const tab = this.#newTab({ id: args.tab, scope: args.scope, key, url, title: args.title ?? '' });
    if (args.restore) { this.#emitState(tab); return this.#receipt(args, tab, 'ok', { restored: true }); }
    const task = { args: { ...args, action: 'wake' }, source: args.source ?? 'bot', active, tab, generation: this.#generation, dispatched: false, cancelled: null };
    // Until its page exists a Bot open may wait for a background page to
    // sleep. It is the tab's current Bot step then: a targeted cancel, hide,
    // takeover or document retirement stops it before anything is created.
    // Once navigation is dispatched it cannot be recalled (too_late).
    const tracked = task.source === 'bot';
    if (tracked) { tab.tasks.push(task); tab.current = task; this.#activity(tab); }
    let result;
    try { result = await this.#execute(tab, task); }
    finally { if (tracked) { if (tab.current === task) tab.current = undefined; tab.tasks = tab.tasks.filter(item => item !== task); this.#activity(tab); } }
    // Stopped before a page was created: leave no native record behind.
    if (task.cancelled && !task.dispatched && !this.#live(tab)) { this.#forget(tab, 'cancelled'); result = { ...result, ...this.#state(tab) }; }
    return { ...result, action: 'open' };
  }
  #newTab({ id, scope, key, url, title, opener }) {
    const tab = { id, scope: { ...scope }, key, url, title, opener, state: 'sleeping', navigation: 0, epoch: 0, snapshot: 0, starts: 0, control: 'bot',
      visible: false, edited: false, crashed: false, audible: false, tasks: [], queue: Promise.resolve(), downloads: new Set(), popups: new Set(), uploads: new Set(), shownAt: 0, wakeOnShow: true };
    this.#tabs.set(id, tab);
    return tab;
  }
  async #wake(args, tab, task) {
    if (!this.#live(tab)) {
      // One install per tab: a layout reveal, an open and a Bot wake can race
      // while capacity is being freed. Later wakers reuse the installed page.
      if (tab.installing) { await tab.installing.catch(() => {}); this.#check(tab, task); }
      if (this.#live(tab)) return this.#receipt(args, tab, 'ok', { existing: true });
      const reserved = this.#ensureCapacity(tab);
      tab.installing = reserved;
      try { await reserved; } finally { if (tab.installing === reserved) tab.installing = undefined; }
      this.#check(tab, task);
      // A new or woken page starts at the scope's default zoom unless the person chose one.
      await this.#defaultZoom(tab);
      // Capacity/zoom can await while a Host is removed. Re-check before
      // re-registering its partition or starting any extension workers.
      this.#check(tab, task);
      // Content scripts must be registered before the first navigation (bounded wait).
      const session = this.#session(tab.scope);
      await this.extensions?.ready(session, tab.scope);
      // A compatibility switch of this session is closing its pages (C1): wait.
      // No await between this check and the new page below.
      while (compatGates.has(session)) await compatGates.get(session);
      this.#check(tab, task);
      if (this.#live(tab)) return this.#receipt(args, tab, 'ok', { existing: true });
      this.#install(tab, new this.electron.WebContentsView({ webPreferences: this.#preferences(this.#session(tab.scope)) }));
      tab.wakeOnShow = false;
      if (isGoogleSignInURL(tab.url)) {
        const url = tab.url; tab.url = 'about:blank';
        const result = await this.#googleNavigate(args, tab, task, url);
        this.#apply(); return result;
      }
      const reloaded = tab.navigation > 0, result = await this.#navigate(args, tab, task, () => tab.contents.loadURL(tab.url));
      this.#apply();
      return { ...result, evidence: { ...result.evidence, reloaded } };
    }
    return this.#receipt(args, tab, 'ok', { existing: true });
  }
  #preferences(session) {
    return { session, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      webviewTag: false, webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false, backgroundThrottling: true,
      safeDialogs: true, devTools: this.devTools, autoplayPolicy: 'document-user-activation-required',
      // Per-page zoom: the default per-origin mode makes same-site Tabs (split
      // panes of one conversation) follow each other's zoom.
      zoomMode: 'isolated' };
  }
  #session(scope) {
    if (resetting.has(scope.host)) throw new BrowserError('scope_resetting', 'cancelled');
    const name = partitionFor(scope).slice('persist:'.length);
    usedPartitions.add(name); this.#remember(name, scope.host);
    const value = this.electron.session.fromPartition(partitionFor(scope));
    if (!configured.has(value)) { configured.add(value); secureBrowserSession(value, { route }); }
    // Only after page policy is installed: an extension's worker starts as soon as it loads.
    void this.extensions?.attach(value, scope);
    return value;
  }
  async #ensureCapacity(tab) {
    const others = [...this.#tabs.values()].filter(other => other !== tab), live = others.filter(other => this.#live(other));
    // Pages still waiting for a slot count too, or one layout frame that
    // reveals several sleeping tabs would exceed the limit.
    if (live.length + others.filter(other => other.installing && !this.#live(other)).length < this.limits.liveTabs) return;
    if (this.#spawning.has(tab.id)) throw new BrowserError('live_limit', 'needs_user');
    const candidates = live.filter(other => !other.closing && this.#sleepable(other).length === 0).sort((a, b) => a.shownAt - b.shownAt);
    for (const candidate of candidates) {
      if (await this.#close(candidate, { prompt: false, reason: 'limit', sleep: true }) === 'closed') return;
    }
    throw new BrowserError('live_limit', 'needs_user');
  }
  #sleepable(tab) {
    const reasons = [];
    if (tab.visible) reasons.push('visible');
    if (tab.tasks.length || tab.current) reasons.push('bot_task');
    if ([...tab.downloads].some(id => this.#downloads.get(id)?.state === 'progressing')) reasons.push('download');
    if (this.#live(tab) && tab.contents.isCurrentlyAudible()) reasons.push('media');
    if (tab.edited) reasons.push('edited');
    if (tab.popups.size) reasons.push('popup');
    if (tab.control === 'user') reasons.push('user_control');
    if (tab.tool) reasons.push('page_tool');
    return reasons;
  }

  #install(tab, view) {
    const contents = view.webContents;
    tab.view = view; tab.contents = contents; tab.state = 'live'; tab.crashed = false; tab.unresponsive = false; tab.visible = false; tab.edited = false; tab.unsettled = undefined;
    // A page that was never shown still needs a real viewport, or layout-based
    // reads of a background tab see nothing. Reuse the last workbench size.
    view.setBackgroundColor?.('#ffffff'); view.setBounds(this.#idleBounds(tab)); view.setVisible(false);
    this.window.contentView.addChildView(view);
    routes.set(contents.id, { manager: this, tab });
    this.#wire(tab, contents);
    this.extensions?.observe(contents, this.window);
    // Pages created by window.open get Electron-derived preferences; isolate them too.
    try { contents.setZoomMode('isolated'); } catch { /* not supported */ }
    this.#applyZoom(tab);
  }
  #guard(tab, event, url, main) {
    if (isGoogleSignInURL(url)) {
      event.preventDefault();
      this.blocked(tab, 'navigation', 'google_sign_in_external', url);
      if (main) void this.#openGoogleSignIn(tab, url);
      return;
    }
    const result = classifyURL(url);
    if (result.kind === 'web' || !main && /^(data|about):/i.test(url)) return;
    event.preventDefault();
    if (result.kind === 'external' && main) void this.openExternal(tab, url, true);
    else this.blocked(tab, 'navigation', result.reason ?? 'unsupported_scheme', url);
  }
  #wire(tab, contents) {
    const id = contents.id, state = () => this.#emitState(tab);
    contents.setWindowOpenHandler(details => this.#windowOpen(tab, details));
    contents.on('did-create-window', child => this.#popup(tab, child));
    contents.on('will-frame-navigate', event => this.#guard(tab, event, event.url, event.isMainFrame));
    contents.on('will-redirect', event => this.#guard(tab, event, event.url, event.isMainFrame));
    contents.on('did-start-navigation', event => { if (event.isMainFrame && !event.isSameDocument) tab.starts++; });
    contents.on('did-navigate', (_event, url, code) => {
      tab.navigation++; tab.edited = false; tab.crashed = false; tab.snapshotAt = undefined; tab.unsettled = undefined; tab.url = contents.getURL(); this.#discardUploads(tab);
      this.#applyZoom(tab); this.#visit(tab, contents, url, code); state();
    });
    contents.on('did-navigate-in-page', (_event, url, main) => { if (main) { tab.url = url; this.#visit(tab, contents, url, 0, true); state(); } });
    contents.on('page-title-updated', (_event, title) => { tab.title = String(title).slice(0, 512); this.#retitle(tab); state(); });
    contents.on('found-in-page', (_event, result) => this.#found(tab, contents, result));
    contents.on('before-input-event', (event, input) => this.#shortcut(tab, event, input));
    contents.on('zoom-changed', (_event, direction) => this.#setZoom(tab, zoomStep(tab.zoom ?? 1, direction === 'in' ? 1 : -1)));
    for (const name of ['did-start-loading', 'did-stop-loading', 'did-fail-load']) contents.on(name, state);
    contents.on('render-process-gone', (_event, details) => {
      tab.crashed = true; tab.navigation++; tab.unsettled = undefined; this.#interrupt(tab, 'page_unavailable', 'failed', true);
      this.#emit({ kind: 'gone', tab: tab.id, reason: details?.reason ?? 'crashed' }); state();
    });
    contents.on('unresponsive', () => { tab.unresponsive = true; this.#emit({ kind: 'gone', tab: tab.id, reason: 'unresponsive' }); });
    contents.on('responsive', () => { tab.unresponsive = false; this.#emit({ kind: 'state', tab: tab.id, responsive: true }); });
    contents.on('audio-state-changed', event => { tab.audible = !!event.audible; state(); });
    // Electron makes the window fullscreen but leaves this view at its split
    // rectangle. The page fills the window above the App until it exits.
    contents.on('enter-html-full-screen', () => {
      // Remember whether the page, not the person, made the window fullscreen.
      if (!this.#fullscreen) this.#fullscreenOwnsWindow = !this.window.isFullScreen();
      this.#fullscreen = tab; this.#apply(); this.#emit({ kind: 'fullscreen', tab: tab.id, enabled: true });
    });
    contents.on('leave-html-full-screen', () => { if (this.#fullscreen === tab) { this.#fullscreen = undefined; this.#fullscreenOwnsWindow = false; } this.#apply(); this.#emit({ kind: 'fullscreen', tab: tab.id, enabled: false }); });
    contents.on('input-event', (_event, input) => this.#userInput(tab, input));
    contents.on('select-client-certificate', (event, _url, _list, callback) => { event.preventDefault(); callback(); });
    contents.on('context-menu', (_event, params) => this.#contextMenu(tab, params));
    contents.once('destroyed', () => {
      routes.delete(id);
      if (tab.contents === contents) this.#detached(tab, tab.closing ?? 'page');
    });
  }
  #userInput(tab, input) {
    if (!USER_INPUT.has(input.type) || this.now() < (tab.syntheticUntil ?? 0)) return;
    if (KEYBOARD.has(input.type)) tab.edited = true;
    // Counted for a compatibility switch: any input while it asks cancels it.
    tab.inputs = (tab.inputs ?? 0) + 1;
    // The person is using this page now. Pending Bot steps would race their
    // edits, so they stop and the next Bot step must observe the page again.
    if (tab.tasks.some(task => !task.done)) this.#interrupt(tab, 'user_input', 'paused', true);
  }
  #emitState(tab) {
    const contents = this.#live(tab) ? tab.contents : undefined;
    this.#emit({ kind: 'state', tab: tab.id, ...this.#state(tab), crashed: tab.crashed, audible: tab.audible, opener: tab.opener,
      canGoBack: contents ? contents.navigationHistory.canGoBack() : false, canGoForward: contents ? contents.navigationHistory.canGoForward() : false });
  }
  #summary(tab) {
    return { tab: tab.id, ...this.#state(tab), crashed: tab.crashed, audible: tab.audible, edited: tab.edited, opener: tab.opener, revoked: !!tab.revoked,
      pending: tab.tasks.filter(task => !task.done).length, current: tab.current?.args.action ?? null, sleepable: this.#live(tab) ? this.#sleepable(tab).length === 0 : false };
  }
  blocked(tab, what, reason, url) {
    tab.blockedDuring = reason;
    let origin = '';
    try { const parsed = new URL(url); origin = ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : parsed.protocol; } catch { /* unparsable */ }
    this.#emit({ kind: 'blocked', tab: tab.id, what, reason, target: origin });
  }

  #windowOpen(tab, details) {
    if (isGoogleSignInURL(details.url)) { void this.#openGoogleSignIn(tab, details.url); return { action: 'deny' }; }
    const target = classifyURL(details.url || 'about:blank');
    if (target.kind === 'external') { void this.openExternal(tab, details.url, true); return { action: 'deny' }; }
    if (target.kind !== 'web' || this.#quitting || tab.revoked || resetting.has(tab.scope.host) || compatGates.has(tab.contents?.session)) { this.blocked(tab, 'window', target.reason ?? 'unavailable', details.url); return { action: 'deny' }; }
    if (details.disposition === 'new-window' || details.features) {
      if (tab.popups.size >= 4) { this.blocked(tab, 'window', 'popup_limit', details.url); return { action: 'deny' }; }
      const feature = name => { const match = new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*(\\d+)`, 'i').exec(details.features ?? ''); return match ? Number(match[1]) : undefined; };
      const size = (value, fallback) => Math.min(1400, Math.max(240, value ?? fallback));
      // Login popups keep opener semantics in this tab's session. They are not
      // App windows: no preload, no native IPC, closed with their tab.
      return { action: 'allow', outlivesOpener: false, overrideBrowserWindowOptions: { parent: this.window, width: size(feature('width'), 520), height: size(feature('height'), 680),
        show: false, autoHideMenuBar: true, fullscreenable: false, backgroundColor: '#ffffff', webPreferences: this.#preferences(tab.contents.session) } };
    }
    if (this.#tabs.size >= this.limits.tabs || this.#occupiedPages() >= this.limits.liveTabs) {
      this.blocked(tab, 'window', 'live_limit', details.url); this.#emit({ kind: 'tab-request', tab: tab.id, url: target.url }); return { action: 'deny' };
    }
    return { action: 'allow', outlivesOpener: true, createWindow: options => {
      const child = this.#newTab({ id: `w${randomUUID().replace(/-/g, '').slice(0, 24)}`, scope: tab.scope, key: tab.key, url: target.url, title: '', opener: tab.id });
      this.#install(child, new this.electron.WebContentsView({ webContents: options.webContents, webPreferences: options.webPreferences }));
      void this.#defaultZoom(child).then(() => { this.#applyZoom(child); this.#emitState(child); });
      this.#emit({ kind: 'opened', tab: child.id, opener: tab.id, url: target.url });
      return child.contents;
    } };
  }
  #popup(tab, child) {
    const contents = child.webContents, id = contents.id;
    tab.popups.add(child); routes.set(id, { manager: this, tab, popup: true });
    contents.setWindowOpenHandler(details => {
      if (isGoogleSignInURL(details.url)) { void this.#openGoogleSignIn(tab, details.url); return { action: 'deny' }; }
      const target = classifyURL(details.url || '');
      if (target.kind === 'web' && target.url !== 'about:blank') void this.#spawn(tab, target.url);
      else if (target.kind === 'external') void this.openExternal(tab, details.url, true);
      return { action: 'deny' };
    });
    contents.on('will-frame-navigate', event => this.#guard(tab, event, event.url, event.isMainFrame));
    contents.on('will-redirect', event => this.#guard(tab, event, event.url, event.isMainFrame));
    contents.on('select-client-certificate', (event, _url, _list, callback) => { event.preventDefault(); callback(); });
    child.once('closed', () => { tab.popups.delete(child); routes.delete(id); this.#emit({ kind: 'popup', tab: tab.id, state: 'closed' }); });
    // A popup opened by a Bot step must not take keyboard focus from chat.
    if (this.now() < (tab.syntheticUntil ?? 0) + 1000) child.showInactive(); else child.show();
    this.#emit({ kind: 'popup', tab: tab.id, state: 'opened' });
  }
  async #spawn(opener, url) {
    if (this.#disposed || this.#quitting || !this.#live(opener) || opener.revoked || resetting.has(opener.scope.host) || compatGates.has(opener.contents?.session)) return;
    if (this.#tabs.size >= this.limits.tabs || this.#occupiedPages() >= this.limits.liveTabs) {
      this.blocked(opener, 'window', 'live_limit', url); this.#emit({kind:'tab-request',tab:opener.id,url}); return;
    }
    const id = `w${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    this.#spawning.add(id);
    const result = await this.#open({ action: 'open', scope: opener.scope, tab: id, url, source: 'user' }, opener.key)
      .catch(error => this.#failure({ action: 'open', tab: id }, error)).finally(() => this.#spawning.delete(id));
    const tab = this.#tabs.get(id);
    if (tab) { tab.opener = opener.id; this.#emit({ kind: 'opened', tab: id, opener: opener.id, url, status: result.status }); }
    return tab;
  }
  #occupiedPages() { return [...this.#tabs.values()].filter(tab => this.#live(tab) || tab.installing || this.#spawning.has(tab.id)).length; }
  /** An extension's tabs.create: a web page in the same scope as its session,
   * opened like a link from a live page there (never a new scope or an App page). */
  static async #openForExtension(session, url, active) {
    const target = classifyURL(url);
    if (target.kind !== 'web') throw new Error('TaroBird can open only web pages for extensions');
    for (const owner of instances) {
      if (owner.#disposed || owner.#quitting) continue;
      const opener = [...owner.#tabs.values()].find(tab => owner.#live(tab) && tab.contents.session === session && !tab.revoked && !resetting.has(tab.scope.host));
      if (!opener) continue;
      const tab = await owner.#spawn(opener, target.url);
      if (!tab || !owner.#live(tab)) throw new Error('The page could not be opened');
      return { id: tab.contents.id, url: target.url, title: '', active: !!active, windowId: owner.windowId, index: -1, incognito: false, pinned: false, highlighted: false, status: 'loading' };
    }
    throw new Error('Open a page in this browser first');
  }
  /** Extension compatibility mode removes the request filter, but a document
   * committed while it existed stays outside the extension policy (C1). So,
   * before that switch: hold every new page of `session`, then close its pages
   * and popups in every window (Tabs sleep and keep their ID, URL and title).
   * Pages in use (Bot step, download, media, the person's control, a page
   * tool, fullscreen) refuse the switch: retry once they are done. Pages that
   * may hold input (beforeunload, typed input, popups) are listed first when
   * the person is deciding (`interactive`) and refuse an automatic switch.
   * Anything that changes while asking (a new page, navigation, input, risk)
   * cancels it rather than discarding under an older answer; a refusal changes
   * nothing. `commit(fn)` runs `fn` synchronously once no page document of the
   * session is left; `release()` lets pages start again (visible Tabs reload). */
  static async drainForCompat(session, { interactive = false, english = false, window } = {}) {
    const refused = reason => ({ ok: false, reason, release() {} });
    if (compatGates.has(session)) return refused('busy');
    let open; const gate = new Promise(resolve => { open = resolve; });
    compatGates.set(session, gate);
    const owners = [...instances].filter(owner => !owner.#disposed);
    const release = () => {
      if (compatGates.get(session) !== gate) return;
      compatGates.delete(session); open();
      for (const owner of owners) if (!owner.#disposed) owner.#apply();
    };
    const stop = reason => { release(); return refused(reason); };
    const livePages = () => owners.flatMap(owner => [...owner.#tabs.values()].filter(tab => owner.#live(tab) && tab.contents.session === session).map(tab => ({ owner, tab })));
    const inUse = ({ owner, tab }) => owner.#fullscreen === tab || owner.#sleepable(tab).some(reason => ['bot_task', 'download', 'media', 'user_control', 'page_tool'].includes(reason));
    // Document identity and input state, compared after every wait.
    const snapshot = () => new Map(livePages().map(page => [page.tab, { page, contents: page.tab.contents, navigation: page.tab.navigation, edited: page.tab.edited, inputs: page.tab.inputs ?? 0, popups: page.tab.popups.size }]));
    const same = (before, after) => before.size === after.size && [...after].every(([tab, now]) => {
      const was = before.get(tab);
      return !!was && was.contents === now.contents && was.navigation === now.navigation && was.edited === now.edited && was.inputs === now.inputs && was.popups === now.popups;
    });
    const assess = async () => {
      const pages = snapshot();
      if ([...pages.values()].some(({ page }) => inUse(page))) return { busy: true };
      const risky = [];
      for (const owner of owners) {
        const mine = [...pages.values()].filter(({ page }) => page.owner === owner).map(({ page }) => page.tab);
        if (!mine.length) continue;
        const probed = await owner.#unloadRisks(mine);
        for (const tab of mine) {
          const result = probed.find(item => item.tab === tab)?.result ?? (tab.edited ? 'edited' : tab.popups.size ? 'popup' : undefined);
          if (result) risky.push({ owner, tab, result });
        }
      }
      return { pages, risky };
    };
    try {
      let state = await assess();
      if (state.busy) return stop('pages_busy');
      if (state.risky.length) {
        if (!interactive) return stop('pages_busy');
        if (!await WorkbenchBrowser.#confirmCompatReload(state.risky, { english, window })) return stop('cancelled');
        // The answer covers exactly what was listed.
        const again = await assess(), listed = new Set(state.risky.map(item => item.tab));
        if (again.busy || !same(state.pages, again.pages) || again.risky.some(item => !listed.has(item.tab))) return stop('changed');
        state = again;
      }
      // Final check and every close start in one synchronous step: no input,
      // navigation or new page can slip in between.
      const now = snapshot();
      if (!same(state.pages, now) || [...now.values()].some(({ page }) => inUse(page))) return stop('changed');
      const closing = [...now.values()].map(({ page: { owner, tab } }) => {
        for (const child of tab.popups) try { child.destroy(); } catch { /* already closed */ }
        return owner.#close(tab, { prompt: false, force: true, reason: 'compatibility', sleep: true });
      });
      let timer;
      const results = await Promise.race([Promise.all(closing), new Promise(resolve => { timer = setTimeout(resolve, 10000, 'timeout'); })]).finally(() => clearTimeout(timer));
      if (results === 'timeout' || results.some(result => result !== 'closed')) return stop('pages_busy');
    } catch (error) { release(); throw error; }
    const contentsOf = owners[0]?.electron?.webContents;
    return { ok: true, release, commit: fn => {
      // In the same synchronous step as `fn`: no document can commit in between.
      if (livePages().length || (contentsOf?.getAllWebContents?.() ?? []).some(contents => {
        try { return !contents.isDestroyed() && contents.session === session && contents.getType() !== 'backgroundPage'; } catch { return true; }
      })) return false;
      fn(); return true;
    } };
  }
  static async #confirmCompatReload(risky, { english, window }) {
    const owner = risky[0].owner, target = window && !window.isDestroyed?.() ? window : owner.window;
    if (target.isDestroyed?.()) return false;
    if (!target.isVisible?.() || target.isMinimized?.()) target.show?.();
    const label = { blocked: english ? 'may have unsaved changes' : '可能有未保存的内容', unresponsive: english ? 'not responding' : '无响应',
      edited: english ? 'has typed input' : '有输入内容', popup: english ? 'its popup windows will close' : '其弹出窗口会关闭' };
    const names = risky.slice(0, 8).map(({ tab, result }) => `• ${(tab.title || tab.url).slice(0, 80)} (${label[result] ?? result})`);
    if (risky.length > 8) names.push(english ? `• and ${risky.length - 8} more` : `• 另外 ${risky.length - 8} 个网页`);
    names.push(english ? 'Their Tabs stay and each page reloads from its address. Cancel keeps compatibility mode off and these pages as they are.' : '标签会保留，每个网页会从原地址重新加载。取消将保持兼容模式关闭，这些网页保持原样。');
    const { response } = await owner.electron.dialog.showMessageBox(target, { type: 'warning', title: 'TaroBird',
      message: english ? 'Reload these web pages to turn on compatibility mode?' : '重新加载这些网页以开启兼容模式吗？',
      detail: names.join('\n'), buttons: english ? ['Cancel', 'Reload pages'] : ['取消', '重新加载网页'], defaultId: 0, cancelId: 0, noLink: true });
    return response === 1;
  }
  #contextMenu(tab, params) {
    const { Menu, clipboard } = this.electron, english = this.english, contents = tab.contents, items = [];
    const link = params.linkURL && classifyURL(params.linkURL).kind === 'web' ? params.linkURL : undefined;
    if (link) items.push({ label: english ? 'Open Link in New Tab' : '在新标签页打开链接', click: () => void this.#spawn(tab, link) },
      { label: english ? 'Copy Link' : '复制链接', click: () => clipboard.writeText(link) }, { type: 'separator' });
    if (params.isEditable) items.push({ role: 'cut', enabled: params.editFlags.canCut }, { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste }, { role: 'selectAll' }, { type: 'separator' });
    else if (params.selectionText) items.push({ role: 'copy' }, { type: 'separator' });
    items.push({ label: english ? 'Back' : '后退', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
      { label: english ? 'Forward' : '前进', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
      { label: english ? 'Reload' : '重新加载', click: () => contents.reload() });
    // Items the person's extensions in this page's session added (chrome.contextMenus).
    items.push(...(this.extensions?.menuItems(contents.session, params, { id: contents.id, url: contents.getURL(), title: contents.getTitle(), active: !!tab.visible, windowId: this.windowId, index: -1, incognito: false }) ?? []));
    Menu.buildFromTemplate(items).popup({ window: this.window });
  }

  #layout({ seq, views, hidden }) {
    if (seq <= this.#layoutSeq) return;
    this.#layoutSeq = seq; this.#layoutHidden = hidden === true; this.#layoutViews = views;
    this.#apply();
  }
  #apply() {
    const views = this.#layoutViews;
    if (this.#disposed || this.window.isDestroyed()) return;
    const full = this.#fullscreen;
    if (full && this.#live(full)) {
      const bounds = this.window.getContentBounds();
      full.view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
      this.window.contentView.addChildView(full.view);
      if (!full.visible) { full.view.setVisible(true); full.visible = true; }
      for (const tab of this.#tabs.values()) if (tab !== full && tab.visible) { tab.visible = false; if (this.#live(tab)) tab.view.setVisible(false); }
      this.#applyZoom(full);
      return;
    }
    this.#fullscreen = undefined;
    const zoom = this.window.webContents.getZoomFactor(), bounds = this.window.getContentBounds(), shown = new Set(), now = this.now();
    if (!this.#layoutHidden) for (const view of views) {
      const tab = this.#tabs.get(view.tab);
      if (!tab) continue;
      if (!this.#live(tab)) { if (tab.wakeOnShow && !tab.waking && !resetting.has(tab.scope.host)) this.#autoWake(tab); continue; }
      const x = Math.max(0, Math.min(bounds.width, Math.round(view.x * zoom))), y = Math.max(0, Math.min(bounds.height, Math.round(view.y * zoom)));
      const width = Math.max(0, Math.min(bounds.width - x, Math.round(view.width * zoom))), height = Math.max(0, Math.min(bounds.height - y, Math.round(view.height * zoom)));
      if (width < 1 || height < 1) continue;
      // Device preview: a letterboxed view of the preset size (at 100% page
      // zoom, scaled to fit), zoomed by page zoom × scale. The CSS viewport is
      // the preset at 100% and preset ÷ page zoom otherwise; page coordinates,
      // Bot input and captures keep their usual meaning (see fitDevice).
      const size = deviceSize(tab.device), rect = size ? fitDevice({ x, y, width, height }, size) : { x, y, width, height };
      tab.view.setBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }); this.#lastSize = { width, height };
      if (size && tab.previewScale !== rect.scale) { tab.previewScale = rect.scale; this.#emitState(tab); }
      this.#applyZoom(tab);
      if (!tab.visible) { tab.view.setVisible(true); tab.visible = true; this.extensions?.activated(tab.contents, this.window); }
      tab.shownAt = now; shown.add(tab);
    }
    for (const tab of this.#tabs.values()) if (!shown.has(tab) && tab.visible) { tab.visible = false; if (this.#live(tab)) tab.view.setVisible(false); }
  }
  #autoWake(tab) {
    tab.waking = true;
    const task = { args: { action: 'wake', scope: tab.scope, tab: tab.id }, source: 'user', active: () => true, tab, generation: this.#generation, dispatched: false, cancelled: null };
    void this.#execute(tab, task).then(result => {
      tab.waking = false;
      // At the live limit only the person can choose which page to free (the
      // sleeping placeholder wakes explicitly); never retry on every frame.
      if (result.status !== 'ok' && !this.#live(tab) && result.error === 'live_limit') tab.wakeOnShow = false;
      if (result.status !== 'ok' && !this.#live(tab)) this.#emit({ kind: 'sleep', tab: tab.id, reason: result.error ?? 'wake_failed' });
      this.#emitState(tab);
    });
  }

  /** Ask a fullscreen page to leave fullscreen before it goes away, so Electron
   * restores the window through its normal path (a destroyed page sends no
   * leave event and would leave the App window fullscreen). Fixed operation. */
  async #exitFullscreen(tab) {
    if (!this.#live(tab)) { this.#releaseFullscreen(tab); return; }
    const contents = tab.contents;
    let left = false;
    await new Promise(resolve => {
      const timer = setTimeout(done, 2000);
      function leave() { left = true; done(); }
      function done() { clearTimeout(timer); contents.off('leave-html-full-screen', leave); contents.off('destroyed', done); resolve(); }
      contents.once('leave-html-full-screen', leave); contents.once('destroyed', done);
      contents.executeJavaScriptInIsolatedWorld(PAGE_WORLD, [{ code: pageScript('exitFullscreen') }], true).then(value => { if (!value?.active) done(); }, done);
    });
    // No leave event (hung or vanished page): release window and UI ourselves.
    if (!left) this.#releaseFullscreen(tab);
  }
  /** End a page's fullscreen without a leave event from Chromium. The window
   * leaves fullscreen only if this page put it there; a person's own window
   * fullscreen (already on when the page entered) is kept. */
  #releaseFullscreen(tab) {
    if (this.#fullscreen === tab) this.#fullscreen = undefined;
    if (this.#fullscreenOwnsWindow && !this.window.isDestroyed() && this.window.isFullScreen()) this.window.setFullScreen(false);
    this.#fullscreenOwnsWindow = false;
    this.#emit({ kind: 'fullscreen', tab: tab.id, enabled: false }, tab.scope);
    this.#apply();
  }
  async #close(tab, { prompt, force = false, reason, sleep = false }) {
    if (!this.#live(tab)) { if (!sleep) this.#forget(tab, reason); return 'closed'; }
    if (this.#fullscreen === tab) await this.#exitFullscreen(tab);
    const contents = tab.contents;
    if (!sleep) this.#interrupt(tab, 'tab_closed', 'cancelled', false);
    // A newer close decides the outcome instead of an earlier timed-out sleep.
    tab.closing = reason; tab.lateSleep = undefined;
    const result = await new Promise(resolve => {
      let timer, finished = false;
      const done = value => { if (finished) return; finished = true; clearTimeout(timer); contents.off('will-prevent-unload', prevent); contents.off('destroyed', gone); resolve(value); };
      const prevent = event => {
        if (prompt && this.#confirmLeave(tab)) { event.preventDefault(); return; }
        done('prevented');
      };
      const gone = () => done('closed');
      contents.on('will-prevent-unload', prevent); contents.once('destroyed', gone);
      // A hung page cannot answer beforeunload. Only the person may decide to
      // discard it; automatic sleep and Bot requests leave it open. The close
      // request cannot be withdrawn: if the page answers late, a sleep still
      // ends as a sleeping Tab (see #detached), never as a vanished one.
      timer = setTimeout(() => { if (prompt || force) contents.close(); else { if (sleep) tab.lateSleep = contents; done('prevented'); } }, 5000);
      if (force) contents.close(); else contents.close({ waitForBeforeUnload: true });
    });
    if (result === 'prevented') { tab.closing = undefined; return result; }
    if (sleep) { tab.state = 'sleeping'; tab.wakeOnShow = true; this.#emit({ kind: 'sleep', tab: tab.id, reason }); this.#emitState(tab); }
    else this.#forget(tab, reason);
    return 'closed';
  }
  #confirmLeave(tab) {
    if (!this.window.isVisible()) this.window.show();
    const english = this.english;
    const result = this.electron.dialog.showMessageBoxSync(this.window, { type: 'question', title: 'TaroBird',
      message: english ? 'Leave this web page?' : '离开这个网页吗？',
      detail: `${tab.title || tab.url}\n${english ? 'Changes you made on this page may not be saved.' : '你在这个网页中填写的内容可能不会保存。'}`,
      buttons: english ? ['Stay', 'Leave'] : ['留在网页', '离开'], defaultId: 0, cancelId: 0, noLink: true });
    return result === 1;
  }
  /** The webContents is gone (closed, slept, page-closed or destroyed). */
  #detached(tab, reason) {
    try { this.window.contentView.removeChildView(tab.view); } catch { /* window destroyed */ }
    // The page closed itself while fullscreen: no leave event will follow.
    if (this.#fullscreen === tab) this.#releaseFullscreen(tab);
    for (const child of tab.popups) try { child.close(); } catch { /* already closed */ }
    const late = !!tab.lateSleep && tab.lateSleep === tab.contents;
    tab.popups.clear(); tab.view = undefined; tab.contents = undefined; tab.visible = false; tab.closing = undefined; tab.lateSleep = undefined;
    tab.find?.settle?.('gone'); tab.find = undefined; tab.visited = undefined;
    tab.navigation++; this.#discardUploads(tab);
    this.#interrupt(tab, 'tab_closed', 'cancelled', true);
    if (late) { tab.state = 'sleeping'; tab.wakeOnShow = true; this.#emit({ kind: 'sleep', tab: tab.id, reason: 'sleep' }); this.#emitState(tab); this.#apply(); }
    else if (reason === 'page') this.#forget(tab, 'page');
  }
  #forget(tab, reason) {
    if (this.#tabs.get(tab.id) !== tab) return;
    this.#tabs.delete(tab.id); tab.state = 'closed';
    this.#emit({ kind: 'closed', tab: tab.id, reason }, tab.scope);
  }
  async #sleep(args, tab) {
    if (!this.#live(tab)) return this.#receipt(args, tab, 'ok', { existing: true });
    const reasons = this.#sleepable(tab).filter(reason => reason !== 'visible' || (args.source ?? 'bot') === 'bot');
    if (reasons.length) return this.#receipt(args, tab, 'failed', { error: 'busy', detail: { reasons } });
    const result = await this.#close(tab, { prompt: false, reason: 'sleep', sleep: true });
    return result === 'closed' ? this.#receipt(args, tab, 'ok', { evidence: { reloadOnWake: true } }) : this.#receipt(args, tab, 'needs_user', { error: 'page_has_unsaved_changes' });
  }

  async #clear(args, key) {
    for (const tab of this.#tabs.values()) if (tab.key === key) this.#interrupt(tab, 'scope_cleared', 'cancelled', true);
    for (const grant of this.#grants.keys()) if (grant.startsWith(`${key}|`)) this.#grants.delete(grant);
    const session = this.#session(args.scope);
    await session.clearStorageData(); await session.clearCache(); await session.clearAuthCache(); await session.clearHostResolverCache();
    // Clearing can drop the compatibility policy's stored rules; re-arm them (filter restored meanwhile).
    await this.extensions?.refreshCompat(args.scope);
    this.#emit({ kind: 'cleared' }, args.scope);
    return this.#receipt(args, undefined, 'ok');
  }
  async #revoke(args, key) {
    const tabs = [...this.#tabs.values()].filter(tab => tab.key === key), kept = [];
    for (const tab of tabs) { tab.revoked = true; tab.control = 'user'; this.#interrupt(tab, 'scope_revoked', 'cancelled', true); }
    for (const grant of this.#grants.keys()) if (grant.startsWith(`${key}|`)) this.#grants.delete(grant);
    for (const [id, entry] of this.#uploads) if (entry.key === key) await this.#dropUpload(id, entry);
    // Ask once for every page that declares unsaved state, then close all or none.
    const risky = await this.#unloadRisks(tabs);
    if (risky.length && !await this.#confirmDiscard(risky, 0, 'revoke')) {
      kept.push(...tabs.filter(tab => this.#live(tab)).map(tab => tab.id));
      return this.#receipt(args, undefined, 'needs_user', { error: 'page_has_unsaved_changes', closed: 0, kept });
    }
    for (const tab of tabs) await this.#close(tab, { prompt: false, force: true, reason: 'revoke' });
    return this.#receipt(args, undefined, 'ok', { closed: tabs.length, kept });
  }

  /** Host removal / local reset (trusted App only; not a browser action, so a
   * Bot cannot request it). Closes this Host's pages without asking (the
   * person confirmed the reset), forgets its grants, downloads, uploads and
   * receipts, then clears the web data of the given scopes and of partitions
   * the registry attributes to this Host. Other Hosts are untouched. Partitions
   * created before the registry and absent from `scopes` cannot be attributed
   * and are kept. Partial failure is reported, never hidden. */
  async reset({ host, scopes }) {
    if (this.#disposed) throw new Error('native_document_retired');
    if (resetting.has(host)) throw new Error('browser_reset_busy');
    resetting.add(host);
    try {
      // Fence first (above), then collect every window's keys for this Host.
      const owners = [...instances].filter(owner => !owner.#disposed), keys = new Set(scopes.map(scopeKey)), captured = [];
      // Pages of this Host in any window are cleared even if their scope is not
      // yet in the App's layout list or their registration write failed.
      for (const owner of owners) for (const tab of owner.#tabs.values()) if (tab.scope.host === host) { keys.add(tab.key); captured.push(tab.scope); }
      let closed = 0; const pages = new Set();
      for (const owner of owners) closed += await owner.#purgeHost(host, keys, pages);
      const failed = [...pages], done = [];
      // Full local reset: installed extensions go with the personal profile, unloaded before its data is cleared.
      if (host === PERSONAL_BROWSER_SCOPE.host && this.extensions) try { await this.extensions.clear(); } catch { failed.push('extensions'); }
      // Registrations still being written belong to this read.
      // An unreadable registry is an unresolved failure on every attempt (the
      // file is kept): attributions it held cannot be cleared or assumed empty.
      let registered = {};
      try { await registryWrite; registered = await this.#readRegistry(); }
      catch { failed.push('registry'); }
      const hash = hostHash(host);
      const names = new Set([...scopes, ...captured].map(value => partitionFor(value).slice('persist:'.length)));
      for (const name of Object.keys(registered)) if (registered[name] === hash && PARTITION.test(name)) names.add(name);
      let cleared = 0, skipped = 0;
      // Compatibility mode ends (request filter restored) before these partitions are cleared.
      if (this.extensions) try { await this.extensions.forget([...names].map(name => `persist:${name}`)); } catch { failed.push('extensions'); }
      for (const name of names) {
        // Never create an empty partition just to clear it.
        if (!usedPartitions.has(name) && !await this.#partitionExists(name)) { skipped++; done.push(name); continue; }
        try {
          const session = this.electron.session.fromPartition(`persist:${name}`);
          await session.clearStorageData(); await session.clearCache(); await session.clearAuthCache(); await session.clearHostResolverCache();
          cleared++; done.push(name); remembered.delete(`${this.registry}\0${name}`); // re-registered if used again
        } catch { failed.push(name); }
      }
      // History and browser settings of this Host's conversations on this device.
      try { await this.store.purgeHost(host); } catch { failed.push('history'); }
      if (!failed.includes('registry')) {
        // A stale entry only causes a harmless re-clear, but the result says so.
        try { await this.#updateRegistry(partitions => { let changed = false; for (const name of done) if (Object.hasOwn(partitions, name)) { delete partitions[name]; changed = true; } return changed; }); }
        catch { failed.push('registry'); }
      }
      return { closed, cleared, skipped, failed };
    } finally { resetting.delete(host); }
  }
  /** One window's share of a Host reset: stop Bot steps, close pages and popups
   * without beforeunload prompts, drop grants, downloads, uploads and receipts. */
  async #purgeHost(host, keys, failed) {
    const tabs = [...this.#tabs.values()].filter(tab => tab.scope.host === host);
    let closed = 0;
    for (const tab of tabs) { tab.revoked = true; tab.control = 'user'; this.#interrupt(tab, 'scope_reset', 'cancelled', true); }
    for (const tab of tabs) {
      // A page that never finishes closing would keep writing its partition:
      // bounded, and reported instead of claiming the Host was cleared.
      let timer; const live = this.#live(tab);
      const result = await Promise.race([this.#close(tab, { prompt: false, force: true, reason: 'reset' }), new Promise(resolve => { timer = setTimeout(resolve, 10000, 'timeout'); })]).finally(() => clearTimeout(timer));
      if (result === 'timeout' || this.#live(tab)) failed.add('page'); else if (live) closed++;
    }
    for (const grant of [...this.#grants.keys()]) if (keys.has(grant.slice(0, grant.indexOf('|')))) this.#grants.delete(grant);
    for (const [id, entry] of [...this.#downloads]) if (keys.has(entry.key) || entry.scope?.host === host) { try { if (entry.state === 'progressing') entry.item?.cancel(); } catch { /* finished */ } this.#downloads.delete(id); }
    for (const [id, entry] of [...this.#uploads]) if (keys.has(entry.key)) await this.#dropUpload(id, entry);
    for (const id of [...this.#receipts.keys()]) if (keys.has(id.slice(0, id.indexOf('\0')))) this.#receipts.delete(id);
    return closed;
  }
  async #partitionExists(name) {
    if (!this.partitionRoot) return false;
    try { await lstat(path.join(this.partitionRoot, name)); return true; } catch { return false; }
  }
  /** Missing file = empty registry. Any other read/parse/shape failure throws:
   * attribution would be unknown, so callers must not treat it as empty. */
  async #readRegistry() {
    if (!this.registry) return {};
    let text;
    try { text = await readFile(this.registry, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return {}; throw error; }
    const value = JSON.parse(text);
    if (value?.version !== 1 || !value.partitions || typeof value.partitions !== 'object' || Array.isArray(value.partitions)) throw new Error('browser_registry_invalid');
    return { ...value.partitions };
  }
  /** Serialized read-modify-write with an atomic replace; `update` returns false for no change. */
  #updateRegistry(update) {
    if (!this.registry) return Promise.resolve();
    const file = this.registry;
    const next = registryWrite.then(async () => {
      const partitions = await this.#readRegistry(); if (update(partitions) === false) return;
      const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify({ version: 1, partitions }), { mode: 0o600 }); await rename(temp, file);
    });
    registryWrite = next.catch(() => undefined); return next;
  }
  #remember(name, host) {
    const key = `${this.registry}\0${name}`;
    if (!this.registry || remembered.has(key)) return;
    remembered.add(key);
    const hash = hostHash(host);
    void this.#updateRegistry(partitions => { if (partitions[name] === hash) return false; partitions[name] = hash; return true; }).catch(() => { remembered.delete(key); });
  }

  permissionGranted(tab, permission, origin) {
    let value; try { value = new URL(origin).origin; } catch { return false; }
    const grant = this.#grants.get(`${tab.key}|${value}|${permission}`);
    return grant ?? (permission === 'media' ? this.#grants.get(`${tab.key}|${value}|media:audio`) === true || this.#grants.get(`${tab.key}|${value}|media:video`) === true : false);
  }
  async requestPermission(tab, permission, details = {}) {
    let origin; try { origin = new URL(details.requestingUrl).origin; } catch { return false; }
    const keys = permission === 'media' ? (details.mediaTypes?.length ? details.mediaTypes : ['audio']).map(type => `${tab.key}|${origin}|media:${type}`) : [`${tab.key}|${origin}|${permission}`];
    if (keys.every(key => this.#grants.get(key) === true)) return true;
    if (keys.some(key => this.#grants.get(key) === false)) return false;
    if (this.#quitting || !this.window.isVisible() || this.#disposed) { this.#emit({ kind: 'permission', tab: tab.id, permission, origin, granted: false, reason: 'unavailable' }); return false; }
    const english = this.english, label = permissionLabel(permission, details, english);
    const ask = this.#prompts.then(async () => {
      if (this.#disposed || this.#tabs.get(tab.id) !== tab) return false;
      const { response } = await this.electron.dialog.showMessageBox(this.window, { type: 'question', title: 'TaroBird',
        message: english ? `${origin} wants to use your ${label}` : `${origin} 想使用你的${label}`,
        detail: `${tab.title || tab.url}\n${english ? 'This applies to this site in this workbench scope until TaroBird quits.' : '仅对这个工作台作用域中的该网站有效，退出 TaroBird 后失效。'}`,
        buttons: english ? ['Block', 'Allow'] : ['拒绝', '允许'], defaultId: 0, cancelId: 0, noLink: true });
      return response === 1;
    });
    this.#prompts = ask.catch(() => false);
    let granted = await ask.catch(() => false);
    if (granted && permission === 'media' && this.platform === 'darwin') granted = await this.#systemMedia(details.mediaTypes ?? []);
    for (const key of keys) this.#grants.set(key, granted);
    this.#emit({ kind: 'permission', tab: tab.id, permission, origin, granted });
    return granted;
  }
  async #systemMedia(types) {
    const preferences = this.electron.systemPreferences;
    if (!preferences) return false;
    for (const type of types) {
      if (!['audio', 'video'].includes(type)) return false;
      const media = type === 'audio' ? 'microphone' : 'camera', status = preferences.getMediaAccessStatus(media);
      if (status === 'granted') continue;
      if (status !== 'not-determined' || !await preferences.askForMediaAccess(media)) return false;
    }
    return true;
  }
  /** mailto/tel/sms only, after the person confirms in a native dialog. */
  async #googleNavigate(args, tab, task, url) {
    this.#check(tab, task);
    const opened = await this.#openGoogleSignIn(tab, url, () => { this.#check(tab, task); }, () => { task.dispatched = true; });
    this.#check(tab, task);
    return this.#receipt(args, tab, 'needs_user', { error: 'google_sign_in_external', evidence: { externalOpened: opened, committed: false } });
  }

  async #openGoogleSignIn(tab, url, check = () => {}, dispatch = () => {}) {
    this.blocked(tab, 'navigation', 'google_sign_in_external', url);
    const contents = tab.contents, navigation = tab.navigation, generation = this.#generation;
    const current = () => !this.#disposed && !this.#quitting && generation === this.#generation && this.#tabs.get(tab.id) === tab
      && this.#live(tab) && tab.contents === contents && tab.navigation === navigation && !tab.revoked
      && !resetting.has(tab.scope.host) && !compatGates.has(contents?.session) && !this.window.isDestroyed() && this.window.isVisible();
    if (!isGoogleSignInURL(url) || !current() || this.now() - (tab.googleSignInAt ?? 0) < 3000) return false;
    tab.googleSignInAt = this.now();
    const english = this.english;
    const ask = this.#prompts.then(async () => {
      if (!current()) return false;
      check();
      const { response } = await this.electron.dialog.showMessageBox(this.window, { type: 'question', title: 'TaroBird',
        message: english ? 'Continue Google sign-in in your default browser?' : '在默认浏览器中继续 Google 登录？',
        detail: english ? 'Google requires an external browser for this sign-in. Continue using the website there; its sign-in session will not be copied into TaroBird. App authorization returns through its own callback.'
          : 'Google 要求在外部浏览器中完成此登录。请在那里继续使用网页；网页登录状态不会复制回 TaroBird。应用授权会通过对应的回调完成。',
        buttons: english ? ['Cancel', 'Open browser'] : ['取消', '打开浏览器'], defaultId: 0, cancelId: 0, noLink: true });
      if (response !== 1 || !current()) return false;
      check();
      dispatch();
      await this.electron.shell.openExternal(url);
      return true;
    });
    this.#prompts = ask.catch(() => false);
    return ask.catch(() => false);
  }

  async openExternal(tab, raw, openHere = false) {
    const target = classifyURL(raw ?? '');
    if (target.kind !== 'external' || this.#quitting || !this.window.isVisible()) { this.blocked(tab, 'external', target.reason ?? 'unavailable', raw); return false; }
    if (this.now() - (tab.externalAt ?? 0) < 3000) { this.blocked(tab, 'external', 'rate_limited', raw); return false; }
    tab.externalAt = this.now();
    const english = this.english, scheme = new URL(target.url).protocol.slice(0, -1);
    const ask = this.#prompts.then(async () => (await this.electron.dialog.showMessageBox(this.window, { type: 'question', title: 'TaroBird',
      message: english ? `Open this ${scheme} link with another app?` : `用其他应用打开这个 ${scheme} 链接吗？`, detail: target.url.slice(0, 300),
      buttons: english ? ['Cancel', 'Open'] : ['取消', '打开'], defaultId: 0, cancelId: 0, noLink: true })).response === 1);
    this.#prompts = ask.catch(() => false);
    const allowed = await ask.catch(() => false);
    if (allowed && openHere) await this.electron.shell.openExternal(target.url).catch(() => {});
    return allowed;
  }

  download(tab, item, event) {
    if (this.#quitting || this.#disposed || resetting.has(tab.scope.host) || [...this.#downloads.values()].filter(entry => entry.state === 'progressing').length >= 16) { event.preventDefault(); this.blocked(tab, 'download', 'unavailable', item.getURL()); return; }
    const id = randomUUID(), name = path.basename(item.getFilename() || 'download').replace(/[\x00-\x1f]/g, '').slice(0, 240) || 'download';
    const entry = { id, tab: tab.id, key: tab.key, scope: tab.scope, item, name, total: item.getTotalBytes(), received: 0, state: 'progressing', started: this.now(), emitted: 0 };
    try { item.setSaveDialogOptions({ title: this.english ? 'Save download' : '保存下载文件', defaultPath: path.join(this.electron.app.getPath('downloads'), name) }); } catch { /* defaults */ }
    for (const [old, value] of this.#downloads) if (this.#downloads.size >= 100 && value.state !== 'progressing') this.#downloads.delete(old);
    this.#downloads.set(id, entry); tab.downloads.add(id); tab.lastDownloadAt = this.now();
    item.on('updated', (_event, state) => {
      entry.received = item.getReceivedBytes(); entry.total = item.getTotalBytes(); entry.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      if (this.now() - entry.emitted > 1000) { entry.emitted = this.now(); this.#emit({ kind: 'download', ...this.#downloadSummary(entry) }, entry.scope); }
    });
    item.once('done', (_event, state) => {
      entry.received = item.getReceivedBytes(); entry.state = state; entry.item = undefined; tab.downloads.delete(id);
      if (state === 'completed') {
        entry.path = item.getSavePath(); entry.name = path.basename(entry.path).slice(0, 240);
        // Chromium quarantines downloads; also apply the App's existing marker
        // so opening goes through the same OS checks as saved attachments.
        try { this.addon?.markSavedFile?.(entry.path); entry.marked = true; } catch { entry.marked = false; }
      }
      this.#emit({ kind: 'download', ...this.#downloadSummary(entry) }, entry.scope);
    });
    this.#emit({ kind: 'download', ...this.#downloadSummary(entry) }, entry.scope);
  }
  #downloadSummary(entry) { return { download: entry.id, tab: entry.tab, name: entry.name, total: entry.total, received: entry.received, state: entry.state, started: entry.started }; }
  async #downloadAction(args, key) {
    const entry = this.#downloads.get(args.download);
    if (!entry || entry.key !== key) throw new BrowserError('download_not_found');
    if (args.action === 'download_cancel') { if (entry.state !== 'progressing' || !entry.item) throw new BrowserError('download_finished'); entry.item.cancel(); return this.#receipt(args, undefined, 'ok', { download: this.#downloadSummary(entry) }); }
    if (entry.state !== 'completed' || !entry.path) throw new BrowserError('download_not_completed');
    let status; try { status = await lstat(entry.path); } catch { status = undefined; }
    if (!status?.isFile() || status.isSymbolicLink() || await realpath(entry.path).catch(() => '') !== entry.path) throw new BrowserError('download_not_found');
    if (args.action === 'download_reveal') { this.electron.shell.showItemInFolder(entry.path); return this.#receipt(args, undefined, 'ok'); }
    if (executableName(entry.path)) {
      const english = args.english ?? this.english;
      const { response } = await this.electron.dialog.showMessageBox(this.window, { type: 'warning', title: 'TaroBird',
        message: english ? 'This file can run programs or change your system. Open only if you trust its source.' : '这个文件可能运行程序或修改系统。请仅在确认来源可信时打开。',
        buttons: english ? ['Cancel', 'Open'] : ['取消', '打开'], defaultId: 0, cancelId: 0, noLink: true });
      if (response !== 1) return this.#receipt(args, undefined, 'cancelled');
    }
    if (await this.electron.shell.openPath(entry.path)) throw new BrowserError('download_open_failed');
    return this.#receipt(args, undefined, 'ok');
  }

  /** Upload bytes come only from the trusted App (an authorized attachment),
   * never from a page or a renderer-chosen path. Files live in a private
   * directory until the page navigates, the tab closes or the App quits. */
  async #stage(args, key, active) {
    if (args.action === 'upload_begin') {
      for (const [id, entry] of this.#uploads) if (!entry.tab && !entry.busy && this.now() - entry.at > 10 * 60000) await this.#dropUpload(id, entry);
      if (this.#uploads.size >= 32) throw new BrowserError('busy');
      this.#uploadRoot ??= await mkdtemp(path.join(tmpdir(), 'tarobot-browser-uploads-'));
      const id = randomUUID(), directory = path.join(this.#uploadRoot, id);
      await mkdir(directory, { mode: 0o700 });
      const file = path.join(directory, args.name);
      const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      if (!active()) { await handle.close(); await rm(directory, { recursive: true, force: true }); throw new Error('native_document_retired'); }
      this.#uploads.set(id, { key, handle, directory, file, size: args.size, written: 0, at: this.now() });
      return this.#receipt(args, undefined, 'ok', { upload: id });
    }
    const entry = this.#uploads.get(args.upload);
    if (!entry || entry.key !== key || entry.tab || entry.busy) throw new BrowserError('upload_not_found');
    const bytes = Buffer.from(args.data, 'base64');
    if (bytes.toString('base64') !== args.data || !bytes.length || bytes.length > 1024 * 1024 || entry.written + bytes.length > entry.size) throw new BrowserError('upload_invalid_chunk');
    entry.busy = true;
    try {
      for (let offset = 0; offset < bytes.length;) { const { bytesWritten } = await entry.handle.write(bytes, offset, bytes.length - offset, entry.written + offset); if (bytesWritten <= 0) throw new BrowserError('upload_write_failed'); offset += bytesWritten; }
      entry.written += bytes.length;
    } catch (error) { await this.#dropUpload(args.upload, entry); throw error; }
    finally { entry.busy = false; }
    return this.#receipt(args, undefined, 'ok', { upload: args.upload, written: entry.written, size: entry.size });
  }
  async #upload(args, tab, task) {
    this.#ref(tab, args.ref);
    const entries = args.files.map(id => [id, this.#uploads.get(id)]);
    let total = 0;
    for (const [, entry] of entries) {
      if (!entry || entry.key !== tab.key || entry.tab || entry.busy) throw new BrowserError('upload_not_found');
      if (entry.written !== entry.size) throw new BrowserError('upload_incomplete');
      total += entry.size;
    }
    if (total > this.limits.uploadBytes) throw new BrowserError('upload_too_large');
    const nonce = randomUUID(), debug = tab.contents.debugger;
    for (const [, entry] of entries) { await entry.handle.sync(); }
    this.#check(tab, task);
    await this.#page(tab, 'markUpload', { ref: args.ref, nonce, count: entries.length }, task);
    try {
      this.#check(tab, task);
      try { debug.attach('1.3'); } catch { throw new BrowserError('busy', 'failed', { reason: 'debugger_in_use' }); }
      try {
        for (const [id, entry] of entries) { await entry.handle.close(); entry.handle = undefined; entry.tab = tab.id; tab.uploads.add(id); }
        task.dispatched = true;
        const { root } = await debug.sendCommand('DOM.getDocument', { depth: 0 });
        const { nodeId } = await debug.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-tarobot-upload="${nonce}"]` });
        if (!nodeId) throw new BrowserError('stale_ref', 'unknown');
        await debug.sendCommand('DOM.setFileInputFiles', { nodeId, files: entries.map(([, entry]) => entry.file) });
      } finally { try { debug.detach(); } catch { /* page gone */ } }
    } catch (error) { await this.#page(tab, 'unmarkUpload', { ref: args.ref }).catch(() => {}); throw error; }
    const evidence = await this.#page(tab, 'unmarkUpload', { ref: args.ref }, task);
    tab.edited = true;
    return this.#receipt(args, tab, evidence.count === entries.length ? 'ok' : 'unknown', { evidence });
  }
  async #dropUpload(id, entry) {
    this.#uploads.delete(id);
    await entry.handle?.close().catch(() => {});
    await rm(entry.directory, { recursive: true, force: true }).catch(() => {});
  }
  #discardUploads(tab) {
    for (const id of tab.uploads) { const entry = this.#uploads.get(id); if (entry) void this.#dropUpload(id, entry); }
    tab.uploads.clear();
  }

  // The person's own page tools. These actions are USER_ONLY: a Bot request is
  // refused while parsing, so none of this runs for a Bot.
  #usable(tab) {
    if (tab.state === 'sleeping' || !this.#live(tab)) throw new BrowserError(tab.state === 'sleeping' ? 'tab_sleeping' : 'tab_closed');
    // A hung renderer may never answer print/printToPDF, which would hold the
    // window's single tool dialog; refuse until it responds again.
    if (tab.crashed || tab.unresponsive) throw new BrowserError('page_unavailable');
  }
  /** Zoom and preview change the page's coordinate space: earlier refs and
   * snapshots become stale and pending Bot steps stop until it observes again. */
  #invalidate(tab) { tab.snapshotAt = undefined; this.#interrupt(tab, 'user_input', 'paused', true); }
  async #defaultZoom(tab) {
    if (tab.zoomExplicit) return;
    const settings = await this.store.settings(tab.scope).catch(() => DEFAULT_SETTINGS);
    if (!tab.zoomExplicit) tab.zoom = settings.defaultZoom;
  }
  #applyZoom(tab) {
    if (!this.#live(tab)) return;
    const scale = tab.device && this.#fullscreen !== tab ? tab.previewScale ?? 1 : 1, value = effectiveZoom(tab.zoom ?? 1, scale);
    try { if (Math.abs(tab.contents.getZoomFactor() - value) > 0.0005) tab.contents.setZoomFactor(value); } catch { /* page gone */ }
  }
  #setZoom(tab, factor) {
    const next = clampZoom(factor), changed = next !== (tab.zoom ?? 1);
    tab.zoom = next; tab.zoomExplicit = true;
    if (!changed) return;
    this.#applyZoom(tab); this.#invalidate(tab); this.#emitState(tab);
  }
  /** Bounds for a page that is not laid out now: the last workbench size, letterboxed in preview. */
  #idleBounds(tab) {
    const pane = { x: 0, y: 0, ...this.#lastSize }, size = deviceSize(tab.device);
    if (!size) return pane;
    const fitted = fitDevice(pane, size);
    tab.previewScale = fitted.scale;
    return { x: 0, y: 0, width: fitted.width, height: fitted.height };
  }
  /** Responsive viewport preview (not device emulation: no user agent, touch or screen changes). */
  #device(args, tab) {
    const next = args.preset === 'desktop' ? undefined : { preset: args.preset, landscape: args.landscape === true };
    if (JSON.stringify(next) !== JSON.stringify(tab.device)) {
      tab.device = next; tab.previewScale = undefined;
      const bounds = this.#idleBounds(tab);
      if (this.#live(tab) && !tab.visible) tab.view.setBounds(bounds);
      this.#apply(); this.#applyZoom(tab); this.#invalidate(tab); this.#emitState(tab);
    }
    return this.#receipt(args, tab, 'ok');
  }

  /** Chromium answers only the newest find request of a page; an older one
   * never finishes. Results also arrive as events (requestId may be 0). */
  async #find(args, tab) {
    this.#usable(tab);
    const contents = tab.contents, matchCase = args.matchCase === true, previous = tab.find;
    // Electron: findNext true starts a new session, false moves within it.
    const findNext = args.findNext ?? (!previous || previous.contents !== contents || previous.text !== args.text || previous.matchCase !== matchCase);
    previous?.settle?.('superseded');
    const find = { text: args.text, matchCase, contents };
    tab.find = find;
    find.requestId = contents.findInPage(args.text, { forward: args.forward ?? true, findNext, matchCase });
    const outcome = await new Promise(resolve => {
      const timer = setTimeout(() => settle('pending'), 1000);
      function settle(value) { clearTimeout(timer); find.settle = undefined; resolve(value); }
      find.settle = settle;
    });
    if (outcome === 'gone') throw new BrowserError('tab_closed');
    const result = find.last && { requestId: find.requestId, ...find.last };
    return this.#receipt(args, tab, 'ok', { findRequestId: find.requestId, ...(result ? { find: result } : {}), ...(outcome === 'superseded' || outcome === 'stopped' ? { superseded: true } : {}) });
  }
  #found(tab, contents, result) {
    const find = tab.find;
    if (!find || find.contents !== contents || result?.requestId !== find.requestId) return;
    find.last = { matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal, finalUpdate: !!result.finalUpdate };
    this.#emit({ kind: 'find', tab: tab.id, navigation: tab.navigation, requestId: find.requestId, ...find.last });
    if (result.finalUpdate) find.settle?.('final');
  }
  #stopFind(tab) {
    const find = tab.find;
    tab.find = undefined; find?.settle?.('stopped');
    if (find && this.#live(tab)) try { tab.contents.stopFindInPage('clearSelection'); } catch { /* page gone */ }
  }
  /** Page-focused ⌘/Ctrl shortcuts (find, find next/previous, Escape while
   * finding, print, zoom). Bot key presses are excluded by the contract and by
   * the synthetic-input window; the App's find bar handles all but zoom. */
  #shortcut(tab, event, input) {
    if (this.now() < (tab.syntheticUntil ?? 0)) return;
    const command = shortcutCommand(input, this.platform, !!tab.find);
    if (!command) return;
    // Escape still reaches the page (its dialogs, HTML fullscreen); the App
    // only learns that the person pressed it while finding.
    if (command !== 'escape') event.preventDefault();
    if (!command.startsWith('zoom_')) {
      // The find field lives in the App document: give it the keyboard.
      if (command === 'find') try { this.window.webContents.focus(); } catch { /* window gone */ }
      this.#emit({ kind: 'shortcut', tab: tab.id, command });
      return;
    }
    this.#setZoom(tab, command === 'zoom_reset' ? 1 : zoomStep(tab.zoom ?? 1, command === 'zoom_in' ? 1 : -1));
  }

  /** System print dialog (never silent), or a PDF the person saves. The
   * receipt reports the dialog's own outcome, not a finished paper print. */
  async #print(args, tab) {
    this.#usable(tab);
    if (this.#hidden()) throw new BrowserError('window_hidden', 'paused');
    if (this.#toolBusy) throw new BrowserError('tool_busy');
    const token = {}, contents = tab.contents, navigation = tab.navigation;
    this.#toolBusy = token;
    try {
      if (args.mode === 'pdf') {
        // Rendered before the dialog: the file holds this page as it is now.
        let timer;
        const data = await Promise.race([contents.printToPDF({ printBackground: true, preferCSSPageSize: true }).catch(() => { throw new BrowserError('pdf_failed'); }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new BrowserError('pdf_failed', 'failed', { reason: 'timeout' })), this.limits.pdfMs ?? PDF_MS); })]).finally(() => clearTimeout(timer));
        if (contents !== tab.contents || navigation !== tab.navigation) throw new BrowserError('stale_navigation');
        if (!data?.length) throw new BrowserError('pdf_failed');
        return await this.#saveChosen(args, tab, data, 'pdf');
      }
      // Bot steps on this page wait while the dialog decides what it prints.
      tab.tool = token; this.#interrupt(tab, 'page_tool_active', 'paused', true);
      const outcome = await new Promise(resolve => {
        let finished = false;
        const done = value => { if (finished) return; finished = true; contents.off('destroyed', gone); resolve(value); };
        const gone = () => done({ gone: true });
        contents.once('destroyed', gone);
        try { contents.print({ silent: false, printBackground: true }, (success, reason) => done({ success: success === true, reason: String(reason ?? '') })); }
        catch (error) { done({ success: false, reason: error instanceof Error ? error.message : 'print_failed' }); }
      });
      if (outcome.gone) return this.#receipt(args, tab, 'cancelled', { error: 'tab_closed' });
      if (outcome.success) return this.#receipt(args, tab, 'ok', { print: { mode: 'dialog', submitted: true } });
      if (/cancel/i.test(outcome.reason)) return this.#receipt(args, tab, 'cancelled', { error: 'print_cancelled' });
      // macOS without a configured printer answers at once and shows no dialog.
      if (/no printers/i.test(outcome.reason)) return this.#receipt(args, tab, 'failed', { error: 'print_no_printers', detail: { reason: outcome.reason.slice(0, 120) } });
      return this.#receipt(args, tab, 'failed', { error: 'print_failed', detail: { reason: outcome.reason.slice(0, 120) } });
    } finally {
      if (this.#toolBusy === token) this.#toolBusy = undefined;
      if (tab.tool === token) tab.tool = undefined;
    }
  }
  /** PNG of the visible viewport, saved where the person chooses. */
  async #saveScreenshot(args, tab) {
    this.#usable(tab);
    if (this.#hidden()) throw new BrowserError('window_hidden', 'paused');
    if (this.#toolBusy) throw new BrowserError('tool_busy');
    const token = {};
    this.#toolBusy = token;
    try {
      // A menu that just closed can leave the page hidden for one layout frame.
      let waited = 0;
      while ((!tab.visible || this.#layoutHidden) && waited < 1000) { await delay(25); waited += 25; }
      this.#usable(tab);
      if (!tab.visible || this.#layoutHidden) throw new BrowserError('capture_failed', 'failed', { reason: 'not_visible' });
      if (waited) await delay(100);
      const contents = tab.contents, navigation = tab.navigation, image = await contents.capturePage();
      if (contents !== tab.contents || navigation !== tab.navigation) throw new BrowserError('stale_navigation');
      if (image.isEmpty()) throw new BrowserError('capture_failed');
      const size = image.getSize();
      // Captured before the dialog: a later navigation cannot change what is saved.
      return await this.#saveChosen(args, tab, image.toPNG(), 'png', { width: size.width, height: size.height });
    } finally { if (this.#toolBusy === token) this.#toolBusy = undefined; }
  }
  /** Write captured bytes to a path chosen in the system save dialog. The
   * renderer never supplies a path; a scope reset meanwhile discards them. */
  async #saveChosen(args, tab, bytes, extension, extra = {}) {
    const english = args.english ?? this.english, pdf = extension === 'pdf', name = saveName(tab.title, tab.url, extension, new Date(this.now()));
    let defaultPath = name;
    try { defaultPath = path.join(this.electron.app.getPath('downloads'), name); } catch { /* name only */ }
    const { canceled, filePath } = await this.electron.dialog.showSaveDialog(this.window, {
      title: english ? (pdf ? 'Save as PDF' : 'Save page screenshot') : (pdf ? '保存为 PDF' : '保存网页截图'), defaultPath,
      filters: [pdf ? { name: 'PDF', extensions: ['pdf'] } : { name: english ? 'PNG image' : 'PNG 图片', extensions: ['png'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'] });
    if (canceled || !filePath) return this.#receipt(args, tab, 'cancelled', { saved: false });
    if (resetting.has(tab.scope.host) || tab.revoked || this.#disposed) return this.#receipt(args, tab, 'cancelled', { saved: false, error: 'scope_reset' });
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return this.#receipt(args, tab, 'failed', { saved: false, error: 'save_failed' });
    // Written beside the target, then renamed: the chosen file is either complete or untouched.
    const temp = path.join(path.dirname(filePath), `.${path.basename(filePath).slice(0, 120)}.${randomUUID()}.tmp`);
    try { await writeFile(temp, bytes, { flag: 'wx', mode: 0o644 }); await rename(temp, filePath); }
    catch { await rm(temp, { force: true }).catch(() => {}); return this.#receipt(args, tab, 'failed', { saved: false, error: 'save_failed' }); }
    return this.#receipt(args, tab, 'ok', { saved: true, name: path.basename(filePath), ...extra });
  }

  /** History of this conversation on this device: committed http(s) main-frame
   * visits only; authentication URLs and fragments are never stored. */
  #visit(tab, contents, url, code = 0, inPage = false) {
    // Called from navigation events: history must never break page bookkeeping.
    try { this.#record(tab, contents, url, code, inPage); } catch { tab.visited = undefined; }
  }
  #record(tab, contents, url, code, inPage) {
    if (tab.revoked || resetting.has(tab.scope.host) || !inPage && code >= 400) { if (!inPage) tab.visited = undefined; return; }
    // The beforeunload probe never commits (its request is held); never record it anyway.
    const clean = typeof url !== 'string' || url.startsWith(UNLOAD_PROBE) || url.startsWith(COMPAT_PROBE) ? undefined : historyURL(url);
    if (!clean) { if (!inPage) tab.visited = undefined; return; }
    if (inPage && tab.visited?.url === clean) return;
    let title = ''; try { title = contents.getTitle(); } catch { /* page gone */ }
    const ticket = this.store.ticket(tab.scope);
    tab.visited = { url: clean, ticket, id: this.store.record(ticket, { url: clean, title: title === url ? '' : title }).catch(() => undefined) };
  }
  #retitle(tab) {
    const visit = tab.visited, title = tab.title;
    if (visit && title) void visit.id.then(id => id && this.store.retitle(visit.ticket, id, title)).catch(() => {});
  }
  async #userData(args, key) {
    switch (args.action) {
      case 'history': {
        let entries;
        try { entries = await this.store.list(args.scope, { query: args.query ?? '', limit: args.limit ?? 100 }); } catch { throw new BrowserError('history_unavailable'); }
        return this.#receipt(args, undefined, 'ok', { entries });
      }
      case 'clear_history': {
        let removed;
        try { removed = await this.store.clear(args.scope); } catch { throw new BrowserError('history_unavailable'); }
        for (const owner of instances) for (const tab of owner.#tabs.values()) if (tab.key === key) tab.visited = undefined;
        return this.#receipt(args, undefined, 'ok', { removed });
      }
      case 'settings': {
        let settings;
        try { settings = await this.store.settings(args.scope); } catch { throw new BrowserError('settings_unavailable'); }
        return this.#receipt(args, undefined, 'ok', { settings });
      }
      case 'settings_set': {
        let settings;
        try { settings = await this.store.setSettings(args.scope, args.settings); }
        catch (error) { throw error?.message === 'scope_reset' ? new BrowserError('scope_reset', 'cancelled') : new BrowserError('settings_write_failed'); }
        // Every window's panes of this conversation follow the change.
        for (const owner of instances) if (!owner.#disposed) owner.#emit({ kind: 'settings', settings }, args.scope);
        return this.#receipt(args, undefined, 'ok', { settings });
      }
    }
    throw new BrowserError('unsupported_action');
  }

  /** The App document was replaced or crashed. Pages and their form state stay;
   * every queued Bot step from the old document is cancelled and the native
   * layer is hidden until the new document reports its layout. */
  retire() {
    // A replaced App document cannot see a fullscreen page; end it (released
    // directly if the page does not answer) while the native layer is hidden.
    const full = this.#fullscreen;
    this.#generation++; this.#layoutSeq = 0; this.#layoutHidden = true; this.#layoutViews = []; this.#fullscreen = undefined;
    if (full) void this.#exitFullscreen(full);
    for (const tab of this.#tabs.values()) {
      // The replacement document must locate and observe again before acting.
      this.#interrupt(tab, 'native_document_retired', 'cancelled', true);
      if (tab.visible) { tab.visible = false; if (this.#live(tab)) tab.view.setVisible(false); }
      // The replacement document has no find bar for this page.
      if (tab.find) this.#stopFind(tab);
    }
    for (const [id, entry] of this.#uploads) if (!entry.tab) void this.#dropUpload(id, entry);
  }
  /** Ask every live page's beforeunload without closing anything. The probe is
   * a navigation stopped as soon as it starts (beforeunload has passed by then);
   * a blocked or unresponsive page is reported, never discarded. */
  #probeUnload(tab) {
    if (!this.#live(tab)) return Promise.resolve('clean');
    const contents = tab.contents;
    // A compatibility-mode session has no request filter to hold the probe; its
    // private scheme holds the response instead (browser-policy.mjs).
    const probe = this.extensions?.compatible(contents.session) ? COMPAT_PROBE : UNLOAD_PROBE;
    return new Promise(resolve => {
      let finished = false, timer;
      const done = value => { if (finished) return; finished = true; clearTimeout(timer); contents.off('will-prevent-unload', blocked); contents.off('did-start-navigation', started); contents.off('destroyed', gone); resolve(value); };
      const blocked = () => done('blocked');
      // Stopping inside did-start-navigation would tear the navigation down
      // re-entrantly; the session holds the probe request until this runs.
      const started = event => { if (event.isMainFrame && !event.isSameDocument && event.url === probe) { setImmediate(() => { if (!contents.isDestroyed()) contents.stop(); }); done('clean'); } };
      const gone = () => done('clean');
      contents.on('will-prevent-unload', blocked); contents.on('did-start-navigation', started); contents.once('destroyed', gone);
      timer = setTimeout(() => { if (!contents.isDestroyed()) contents.stop(); done('unresponsive'); }, 3000);
      contents.loadURL(probe).catch(() => {});
    });
  }
  async #unloadRisks(tabs) {
    // A crashed page has no document left to lose; probing would restart it.
    const live = tabs.filter(tab => this.#live(tab) && !tab.crashed);
    const results = await Promise.all(live.map(tab => this.#probeUnload(tab)));
    return live.map((tab, index) => ({ tab, result: results[index] })).filter(item => item.result !== 'clean');
  }
  async #confirmDiscard(risky, downloads, purpose) {
    if (this.window.isDestroyed()) return true;
    if (!this.window.isVisible() || this.window.isMinimized()) this.window.show();
    const english = this.english, names = risky.slice(0, 8).map(({ tab, result }) => `• ${(tab.title || tab.url).slice(0, 80)}${result === 'unresponsive' ? (english ? ' (not responding)' : '（无响应）') : ''}`);
    if (risky.length > 8) names.push(english ? `• and ${risky.length - 8} more` : `• 另外 ${risky.length - 8} 个网页`);
    if (downloads) names.push(english ? `• ${downloads} download(s) in progress will be cancelled` : `• ${downloads} 个进行中的下载将被取消`);
    const quit = purpose === 'quit';
    const { response } = await this.electron.dialog.showMessageBox(this.window, { type: 'warning', title: 'TaroBird',
      message: english ? (quit ? 'Quit TaroBird? Some web pages may have unsaved changes.' : 'Close these web pages? Some may have unsaved changes.') : (quit ? '退出 TaroBird 吗？有网页可能还有未保存的内容。' : '关闭这些网页吗？有网页可能还有未保存的内容。'),
      detail: names.join('\n'), buttons: english ? ['Keep open', quit ? 'Quit' : 'Close pages'] : ['继续使用', quit ? '退出' : '关闭网页'], defaultId: 0, cancelId: 0, noLink: true });
    return response === 1;
  }
  /** Before quit: stop new Bot work and ask every page first. Nothing closes
   * here; pages stay intact until the App really quits (will-quit → dispose),
   * so cancelling now or later in the App's own unsaved-work prompt loses none. */
  async prepareQuit() {
    if (this.#disposed) return true;
    this.#quitting = true;
    // Pending history first, bounded: a stalled disk must not hold up quitting.
    await Promise.race([this.store.flush().catch(() => {}), delay(2000)]);
    for (const tab of this.#tabs.values()) this.#interrupt(tab, 'quitting', 'cancelled', true);
    const downloads = [...this.#downloads.values()].filter(entry => entry.state === 'progressing').length;
    const risky = await this.#unloadRisks([...this.#tabs.values()]);
    if ((risky.length || downloads) && !await this.#confirmDiscard(risky, downloads, 'quit')) { this.#quitting = false; return false; }
    return true;
  }
  quitCancelled() { this.#quitting = false; this.#apply(); }
  /** Main-only counters for leak checks (no page data). */
  stats() {
    const tabs = [...this.#tabs.values()];
    return { tabs: tabs.length, live: tabs.filter(tab => this.#live(tab)).length, visible: tabs.filter(tab => tab.visible).length, routes: [...routes.values()].filter(owner => owner.manager === this).length,
      receipts: this.#receipts.size, downloads: this.#downloads.size, uploads: this.#uploads.size, popups: tabs.reduce((sum, tab) => sum + tab.popups.size, 0),
      tasks: tabs.reduce((sum, tab) => sum + tab.tasks.length, 0), fullscreen: this.#fullscreen?.id ?? null, fullscreenOwnsWindow: this.#fullscreenOwnsWindow };
  }
  dispose() {
    if (this.#disposed) return;
    instances.delete(this);
    this.extensions?.windowClosed(this.windowId);
    this.retire(); this.#disposed = true;
    this.window.removeListener?.('hide', this.onHidden); this.window.removeListener?.('minimize', this.onHidden); this.window.removeListener?.('resize', this.onResize);
    for (const tab of this.#tabs.values()) {
      for (const child of tab.popups) try { child.destroy(); } catch { /* closed */ }
      if (this.#live(tab)) { const contents = tab.contents; routes.delete(contents.id); try { this.window.contentView?.removeChildView(tab.view); } catch { /* destroyed */ } contents.close(); }
    }
    this.#tabs.clear(); this.#receipts.clear();
    void this.store.flush().catch(() => {});
    for (const [id, entry] of this.#uploads) void this.#dropUpload(id, entry);
    if (this.#uploadRoot) void rm(this.#uploadRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export { BROWSER_EVENT };
