import { classifyURL } from './browser-policy.mjs';
import { packagePath } from './extension-archive.mjs';

// An installed extension's own settings page (manifest `options_ui.page` or
// `options_page`), opened only from the trusted Extensions UI. Each page is a
// separate sandboxed window in the exact page session the extension is loaded
// in, so its storage, messaging and background agree with the extension. It has
// no preload, App IPC or App protocols, and may only show that extension's own
// pages: web links go to a managed page of the same scope, everything else is
// blocked. The manager (browser-extensions.mjs) closes it whenever the
// extension stops running there or that session's network policy changes.
export const OPTIONS_LIMITS = Object.freeze({ windows: 4, loadMs: 10000, closeMs: 3000, workerMs: 5000 });

/** The declared options page as a package-relative page (path plus any query or
 * fragment), or undefined. Paths that could leave the package, other origins
 * and schemes are refused. Chrome prefers `options_ui` over `options_page`. */
export function optionsPath(manifest) {
  const raw = typeof manifest?.options_ui?.page === 'string' ? manifest.options_ui.page : typeof manifest?.options_page === 'string' ? manifest.options_page : undefined;
  if (typeof raw !== 'string' || raw.length > 1024 || /[\0-\x1f\x7f]/.test(raw)) return undefined;
  const at = raw.search(/[?#]/), rest = at < 0 ? '' : raw.slice(at);
  // Chrome resolves the page against the extension's root: "/a.html" and "./a.html" are "a.html".
  let file = at < 0 ? raw : raw.slice(0, at);
  while (file.startsWith('./')) file = file.slice(2);
  if (file.startsWith('/')) file = file.slice(1);
  let parts;
  try { parts = packagePath(decodeURIComponent(file)); } catch { return undefined; }
  return { parts, page: parts.map(encodeURIComponent).join('/') + rest };
}

/** chrome-extension://ID/<page>, or undefined if it would not stay on that extension. */
export function optionsURL(id, page) {
  if (!/^[a-p]{32}$/.test(id)) return undefined;
  let url;
  try { url = new URL(page, `chrome-extension://${id}/`); } catch { return undefined; }
  return url.protocol === 'chrome-extension:' && url.host === id && !url.username && !url.password && !url.port ? url.href : undefined;
}

/** Where a navigation of the options window may go: `own` (this extension's
 * pages), `web` (main frame: handed to a managed page instead), `allow`
 * (sub-frame web content, as in managed pages) or `blocked`. */
export function optionsTarget(raw, id, main) {
  let url;
  try { url = new URL(raw); } catch { return { kind: 'blocked' }; }
  if (url.protocol === 'chrome-extension:') return url.host === id && !url.username && !url.password && !url.port ? { kind: 'own' } : { kind: 'blocked' };
  const web = classifyURL(raw);
  if (main) return web.kind === 'web' && ['http:', 'https:'].includes(url.protocol) ? { kind: 'web', url: web.url } : { kind: 'blocked' };
  return web.kind === 'web' || /^(data|about):/i.test(raw) ? { kind: 'allow' } : { kind: 'blocked' };
}

const settle = (promise, ms) => { let timer; return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms, 'timeout'); })]).finally(() => clearTimeout(timer)); };

/** Open options windows, at most one per partition and extension. */
export class OptionsWindows {
  #electron; #limits; #openTab; #windows = new Map();
  // Closed but not yet seen gone (window closed and contents destroyed). Kept
  // until then: a later close still waits for them (fails closed), and their
  // key cannot be reopened. They count towards the window limit.
  #retiring = new Set();
  constructor(electron, { limits = OPTIONS_LIMITS, openTab = async () => { throw new Error('unavailable'); } } = {}) {
    this.#electron = electron; this.#limits = { ...OPTIONS_LIMITS, ...limits }; this.#openTab = openTab;
  }
  get size() { return this.#windows.size + this.#retiring.size; }
  get full() { return this.size >= this.#limits.windows; }
  /** A window of this key is still going away. */
  closing(key) { return [...this.#retiring].some(record => record.key === key); }
  /** Bring an already open one forward. */
  focus(key) {
    const record = this.#windows.get(key);
    if (!record || record.window.isDestroyed()) return false;
    try { if (record.shown) { if (record.window.isMinimized?.()) record.window.restore?.(); record.window.show(); record.window.focus(); } } catch { /* closing */ }
    return true;
  }

  /** Creates and registers the window synchronously (the caller has just
   * checked that the extension runs in `session`); the returned promise is the
   * bounded outcome of its first load and must be awaited outside any queue. */
  open({ key, partition, id, session, url, title, parent }) {
    // Never an orphan: a requesting App window that closed meanwhile opens nothing.
    if (parent?.isDestroyed?.()) throw new Error('parent_closed');
    const owner = parent;
    const window = new this.#electron.BrowserWindow({ title, width: 860, height: 680, minWidth: 360, minHeight: 280, show: false, autoHideMenuBar: true,
      fullscreenable: false, backgroundColor: '#ffffff', ...(owner ? { parent: owner } : {}),
      // No preload, App IPC or App session: the extension's own page session only.
      webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        webviewTag: false, webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false, safeDialogs: true, devTools: false, spellcheck: false } });
    const contents = window.webContents;
    let finish;
    const record = { key, partition, id, window, parentId: owner?.id, shown: false };
    const outcome = new Promise(resolve => { finish = resolve; });
    try { this.#wire(record, { contents, owner, session, finish }); }
    catch (error) { try { window.destroy(); } catch { /* already gone */ } throw error; }
    // Registered only once fully guarded.
    this.#windows.set(key, record);
    // ERR_ABORTED only means another navigation replaced this one (its own outcome follows).
    void Promise.resolve().then(() => contents.loadURL(url)).catch(error => { if (error?.errno !== -3 && error?.code !== 'ERR_ABORTED') finish('failed'); });
    return settle(outcome, this.#limits.loadMs).then(result => {
      // Anything that closed or replaced it meanwhile wins: no late window.
      if (result === 'ready' && this.#windows.get(key) === record && !window.isDestroyed()) {
        record.shown = true;
        try { window.show(); window.focus(); } catch { /* closing */ }
        return { status: 'ok' };
      }
      if (result !== 'closed') void this.close(item => item === record);
      return result === 'timeout' ? { status: 'failed', error: 'options_load_timeout' } : result === 'failed' ? { status: 'failed', error: 'options_load_failed' } : { status: 'cancelled', error: 'options_closed' };
    });
  }
  #wire(record, { contents, owner, session, finish }) {
    const { key, id, window } = record;
    let closed = false, destroyed = false;
    record.gone = new Promise(resolve => {
      const done = () => { if (closed && destroyed) resolve(); };
      window.once('closed', () => { closed = true; done(); });
      contents.once('destroyed', () => { destroyed = true; done(); });
    });
    const onParent = () => this.close(item => item === record);
    window.once('closed', () => {
      if (this.#windows.get(key) === record) { this.#windows.delete(key); this.#retire(record); }
      owner?.removeListener?.('closed', onParent);
      finish('closed');
    });
    owner?.once?.('closed', onParent);
    const kill = () => { void this.close(item => item === record); };
    // A page cannot pose as TaroBird UI through its title.
    window.on('page-title-updated', event => event.preventDefault());
    contents.setWindowOpenHandler(details => {
      const target = optionsTarget(details.url || 'about:blank', id, true);
      if (target.kind === 'web') void Promise.resolve().then(() => this.#openTab(session, target.url, true)).catch(() => {});
      return { action: 'deny' };
    });
    // A followed link (not a redirect) to a web page opens as a managed page.
    const guard = (event, raw, main, link) => {
      const target = optionsTarget(raw, id, main);
      if (target.kind === 'own' || target.kind === 'allow') return;
      event.preventDefault();
      if (link && target.kind === 'web') void Promise.resolve().then(() => this.#openTab(session, target.url, true)).catch(() => {});
    };
    contents.on('will-frame-navigate', event => guard(event, event.url, event.isMainFrame, true));
    contents.on('will-redirect', event => guard(event, event.url, event.isMainFrame, false));
    // Electron emits will-frame-navigate only after this event (verified
    // natively), so a page's own link is decided there. A navigation no frame
    // started (e.g. Electron's own chrome.tabs.update) that leaves this
    // extension closes the window before its request; so does any commit elsewhere.
    contents.on('did-start-navigation', event => { if (event.isMainFrame && !event.isSameDocument && !event.initiator && optionsTarget(event.url, id, true).kind !== 'own') kill(); });
    contents.on('did-navigate', (_event, address) => { if (optionsTarget(address, id, true).kind !== 'own') kill(); });
    contents.on('will-attach-webview', event => event.preventDefault());
    // beforeunload never keeps the window open.
    contents.on('will-prevent-unload', event => event.preventDefault());
    contents.on('select-client-certificate', (event, _url, _list, callback) => { event.preventDefault(); callback(); });
    // A crashed page is closed (not kept as a blank, deduplicated window), so the person can open it again.
    contents.on('render-process-gone', () => { finish('failed'); kill(); });
    contents.once('dom-ready', () => finish('ready'));
    contents.on('did-fail-load', (_event, code, _description, _url, main) => { if (main && code !== -3) finish('failed'); });
  }

  #retire(record) {
    if (this.#retiring.has(record)) return;
    this.#retiring.add(record);
    void record.gone.then(() => this.#retiring.delete(record));
  }
  /** Destroy matching windows now (unregistered synchronously, so nothing can
   * reuse or re-show them). Resolves true once they and any matching earlier
   * ones are gone, false if one was not seen to go within the bound (callers
   * that need none left fail closed; it stays tracked for the next attempt). */
  close(match) {
    for (const [key, record] of [...this.#windows]) {
      if (!match(record)) continue;
      this.#windows.delete(key); this.#retire(record);
    }
    const waits = [];
    for (const record of this.#retiring) {
      if (!match(record)) continue;
      waits.push(record.gone);
      try { if (!record.window.isDestroyed()) record.window.destroy(); } catch { /* already gone */ }
    }
    return waits.length ? settle(Promise.all(waits).then(() => true), this.#limits.closeMs).then(value => value === true) : Promise.resolve(true);
  }
}
