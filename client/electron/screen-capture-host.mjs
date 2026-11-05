import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CAPTURE_CSP, CAPTURE_ORIGIN, CAPTURE_PORT_CHANNEL, CAPTURE_URL } from './screen-capture-contract.mjs';
export { CAPTURE_CSP, CAPTURE_ORIGIN, CAPTURE_PORT_CHANNEL, CAPTURE_URL };
const FILES = { '/capture.html': 'text/html; charset=utf-8', '/capture.js': 'text/javascript; charset=utf-8', '/indicator.html': 'text/html; charset=utf-8', '/indicator.js': 'text/javascript; charset=utf-8' };
// The badge needs its inline stylesheet; scripts stay 'self' only everywhere.
const CSP = { '/indicator.html': `${CAPTURE_CSP}; style-src 'unsafe-inline'` };
const MAX_MESSAGE_BYTES = 1024 * 1024 + 4096;

/** The macOS display source for `display`, matched by CGDirectDisplayID. Only
 * called for an admitted session after screen recording is already granted. */
export async function desktopSource(desktopCapturer, display) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
  return sources.find(source => source.display_id === display.nativeId);
}

/** Serves only the capture and indicator files from a main-fixed directory. */
export function captureAsset(root) {
  return async request => {
    let url; try { url = new URL(request.url); } catch { return new Response(null, { status: 400 }); }
    const type = url.protocol === 'tarobot-screen:' && url.host === 'capture' && !url.search && !url.username && FILES[url.pathname];
    if (!type) return new Response(null, { status: 404 });
    return new Response(await readFile(path.join(root, url.pathname.slice(1))), { headers: { 'Content-Type': type, 'Content-Security-Policy': CSP[url.pathname] ?? CAPTURE_CSP, 'X-Content-Type-Options': 'nosniff' } });
  };
}

/** One hidden, sandboxed capture renderer for all screen sessions. It has its
 * own in-memory session (no persistent storage), no network, no App preload or
 * token, and can only obtain the display source that main bound for the
 * session it is starting. Created on the first session, destroyed after the last. */
export class ScreenCaptureHost {
  #window; #port; #ready; #pending; #starting = Promise.resolve(); #sessions = new Set(); #generation = 0; #waiters = new Map(); #requests = new Map(); #closes = 0;
  #openAbort; #discard = 0; #detach; #opened = false;
  constructor({ electron, root, preload, resolveSource, onMessage, onGone, partition = 'screen-capture-v1', startTimeoutMs = 15000 }) {
    Object.assign(this, { electron, root, preload, resolveSource, onMessage, onGone, partition, startTimeoutMs });
  }
  get active() { return !!this.#window && !this.#window.isDestroyed(); }

  async #open() {
    if (this.#ready) return this.#ready;
    const generation = ++this.#generation;
    // A close() during any await below supersedes this open: whatever it already
    // created is destroyed here and the open rejects, so no orphan renderer remains.
    const superseded = () => generation !== this.#generation;
    const opening = this.#ready = (async () => {
      const { BrowserWindow, MessageChannelMain, session } = this.electron;
      const ses = session.fromPartition(this.partition);
      const owned = contents => !!this.#window && !this.#window.isDestroyed() && contents === this.#window.webContents;
      ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${CAPTURE_ORIGIN}/capture.`) }));
      const handled = await ses.protocol.isProtocolHandled('tarobot-screen');
      // Checked before touching the protocol: a late, superseded open must not
      // unregister the handler a newer open installed.
      if (superseded()) throw new Error('screen_capture_cancelled');
      if (handled) ses.protocol.unhandle('tarobot-screen');
      ses.protocol.handle('tarobot-screen', captureAsset(this.root));
      const mediaAllowed = (contents, permission, details) => owned(contents) && ['media', 'display-capture'].includes(permission)
        && (details?.requestingUrl ?? details?.requestingOrigin ?? '').startsWith(CAPTURE_ORIGIN)
        && (!details?.mediaTypes || details.mediaTypes.every(type => type === 'video'));
      ses.setPermissionCheckHandler((contents, permission, _origin, details) => mediaAllowed(contents, permission, details));
      ses.setPermissionRequestHandler((contents, permission, callback, details) => callback(mediaAllowed(contents, permission, details)));
      ses.setDevicePermissionHandler(() => false);
      // The session outlives each renderer: this open's listener is removed by
      // close(), so reopening never accumulates listeners on it.
      const preventDownload = event => event.preventDefault();
      ses.on('will-download', preventDownload);
      this.#detach = () => ses.removeListener('will-download', preventDownload);
      // The only way this renderer gets pixels: the source main bound for the
      // session being started. No system picker; TCC still applies to screens.
      ses.setDisplayMediaRequestHandler((request, callback) => {
        const main = this.#window && !this.#window.isDestroyed() ? this.#window.webContents.mainFrame : undefined;
        const ours = !!main && !!request.frame && request.frame.processId === main.processId && request.frame.routingId === main.routingId;
        // A cancelled start's request that was already on its way: it arrives
        // first (one renderer, in order) and must not take the next session's source.
        if (ours && this.#discard > 0) { this.#discard--; callback({}); return; }
        const source = this.#pending; this.#pending = undefined;
        if (!source || !ours || request.audioRequested) { callback({}); return; }
        callback({ video: source });
      }, { useSystemPicker: false });
      const window = new BrowserWindow({ show: false, width: 64, height: 64, skipTaskbar: true, focusable: false, paintWhenInitiallyHidden: true,
        webPreferences: { preload: this.preload, session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true, backgroundThrottling: false, devTools: false, spellcheck: false } });
      this.#window = window;
      const contents = window.webContents;
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', event => event.preventDefault());
      contents.on('will-attach-webview', event => event.preventDefault());
      contents.on('render-process-gone', () => this.#gone(generation, 'screen_capture_failed'));
      contents.on('destroyed', () => this.#gone(generation, 'screen_capture_failed'));
      const abandon = () => { if (!window.isDestroyed()) window.destroy(); if (this.#window === window) this.#window = undefined; throw new Error('screen_capture_cancelled'); };
      await window.loadURL(CAPTURE_URL);
      if (superseded()) abandon();
      const { port1, port2 } = new MessageChannelMain();
      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('screen_capture_unavailable')), 10000);
        // close() aborts this wait at once: timer cleared, port closed.
        this.#openAbort = { generation, abort: () => { clearTimeout(timer); port1.close(); reject(new Error('screen_capture_cancelled')); } };
        port1.on('message', ({ data }) => {
          if (generation !== this.#generation) return;
          if (data?.type === 'ready') { clearTimeout(timer); resolve(); return; }
          if (!data || typeof data.type !== 'string' || typeof data.sessionId !== 'string' || !this.#sessions.has(data.sessionId)) return;
          if (data.type === 'frame' && !(data.bytes instanceof Uint8Array && data.bytes.byteLength <= MAX_MESSAGE_BYTES)) return;
          if (data.type === 'started' || data.type === 'ended') this.#waiters.get(data.sessionId)?.(data.type);
          if (data.type === 'ended') this.#sessions.delete(data.sessionId);
          this.onMessage(data);
          if (!this.#sessions.size) this.#closeSoon(generation);
        });
      });
      port1.start();
      contents.postMessage(CAPTURE_PORT_CHANNEL, null, [port2]);
      try { await ready; } finally { if (this.#openAbort?.generation === generation) this.#openAbort = undefined; }
      if (superseded()) { port1.close(); abandon(); }
      this.#port = port1; this.#opened = true;
    })();
    // Only the current generation may tear down; a superseded open must never
    // close a newer generation's renderer.
    try { await opening; } catch (error) { if (!superseded()) this.close(); throw error; }
    return opening;
  }
  /** Drops an UNFINISHED open (its owner start was cancelled or timed out) so
   * the next start makes a fresh one instead of reusing a hung #ready. No
   * session can be live on a renderer that never finished opening; queued
   * starts are not cancelled. */
  #abandonOpening() {
    if (!this.#ready || this.#opened) return;
    ++this.#generation;
    this.#openAbort?.abort(); this.#openAbort = undefined;
    try { this.#detach?.(); } catch { /* listener already gone */ }
    this.#detach = undefined;
    const window = this.#window;
    this.#window = undefined; this.#port?.close(); this.#port = undefined; this.#ready = undefined;
    if (window && !window.isDestroyed()) window.destroy();
  }
  #gone(generation, reason) {
    if (generation !== this.#generation) return;
    const sessions = [...this.#sessions];
    this.close();
    // A crashed renderer never resumes old sessions; the service ends them.
    this.onGone(sessions, reason);
  }
  /** Releases the renderer (and its capture tracks) once nothing uses it. */
  #closeSoon(generation = this.#generation) {
    setTimeout(() => { if (generation === this.#generation && !this.#sessions.size && ![...this.#requests.values()].some(r => !r.cancelled)) this.close(); }, 0).unref?.();
  }
  #send(message) { if (!this.#port) throw new Error('screen_capture_unavailable'); this.#port.postMessage(message); }

  /** Starts encoding `display` for a session. Starts are serialized until the
   * page reports `started`/`ended`, so each getDisplayMedia request is answered
   * with exactly the source bound for that session, never a later one. A stop
   * or close at any point (queued, opening, resolving, awaiting the page)
   * cancels it at once: the promise rejects promptly, nothing is sent after it,
   * and the queue moves on. */
  start({ sessionId, display, streamGeneration, codecs, encode, fps = 15, profile }) {
    if (this.#requests.has(sessionId) || this.#sessions.has(sessionId)) return Promise.reject(new Error('screen_capture_duplicate'));
    let cancel, release;
    const cancelled = new Promise((_, reject) => { cancel = (reason = 'screen_capture_cancelled') => reject(new Error(reason)); });
    cancelled.catch(() => {});
    // Each start keeps its predecessor's barrier. Cancelling the ACTIVE start
    // releases its successor at once (its abandoned awaits are discarded by the
    // live checks); cancelling a start that is still QUEUED only releases once
    // its predecessor has, so nothing can overtake a still-running earlier start.
    const previous = this.#starting;
    let active = false;
    const released = new Promise(resolve => { release = () => { if (active) resolve(); else void previous.then(resolve); }; });
    const request = { cancelled: false, closes: this.#closes, cancel: (reason) => {
      if (request.cancelled) return;
      request.cancelled = true; clearTimeout(request.deadline);
      // Forget it now: an abandoned await that never returns must not keep the
      // id (a retry would be refused as a duplicate) or the opening alive.
      if (this.#requests.get(sessionId) === request) this.#requests.delete(sessionId);
      if (request.source && this.#pending === request.source) { this.#pending = undefined; this.#discard++; }
      if (active) this.#abandonOpening();
      this.#waiters.get(sessionId)?.('ended'); cancel(reason); release();
    } };
    this.#requests.set(sessionId, request);
    const live = () => { if (request.cancelled || request.closes !== this.#closes) throw new Error('screen_capture_cancelled'); };
    const run = previous.then(async () => {
      active = true;
      // One deadline for the whole start (open, source, page): a hung step can
      // neither hold this session forever nor block the starts queued behind it.
      request.deadline = setTimeout(() => { request.cancel('screen_capture_timeout'); this.stop(sessionId); }, this.startTimeoutMs);
      request.deadline.unref?.();
      live();
      await this.#open(); live();
      const source = await this.resolveSource(display); live();
      if (!source) throw new Error('screen_display_unavailable');
      this.#sessions.add(sessionId);
      const settled = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.#waiters.delete(sessionId); reject(new Error('screen_capture_timeout')); }, this.startTimeoutMs);
        this.#waiters.set(sessionId, outcome => { clearTimeout(timer); this.#waiters.delete(sessionId); outcome === 'started' ? resolve() : reject(new Error('screen_capture_failed')); });
      });
      this.#pending = source; request.source = source;
      try {
        this.#send({ type: 'start', sessionId, streamGeneration, geometryRevision: display.revision, codecs, encode, fps, ...(profile ? { profile } : {}) });
        await settled; live();
      } catch (error) {
        // Own failure: clean up here. A cancellation was already cleaned up by
        // its canceller, and must never stop a newer session reusing this id.
        if (!request.cancelled) {
          if (this.#requests.get(sessionId) === request) this.#requests.delete(sessionId);
          this.stop(sessionId);
        }
        throw error;
      } finally { if (this.#pending === source) this.#pending = undefined; }
    }).finally(() => {
      clearTimeout(request.deadline);
      if (this.#requests.get(sessionId) === request) this.#requests.delete(sessionId);
      if (request.cancelled) this.#closeSoon();
    });
    this.#starting = Promise.race([run.catch(() => {}), released]);
    return Promise.race([run, cancelled]);
  }
  /** True if the command reached the page (only once its start was sent). */
  reset(sessionId, streamGeneration, geometryRevision) { if (!this.#sessions.has(sessionId)) return false; this.#send({ type: 'reset', sessionId, streamGeneration, geometryRevision }); return true; }
  pause(sessionId, paused, streamGeneration) { if (!this.#sessions.has(sessionId)) return false; this.#send({ type: 'pause', sessionId, paused, streamGeneration }); return true; }
  credit(sessionId, frameSequence, streamGeneration) { if (this.#sessions.has(sessionId)) this.#send({ type: 'credit', sessionId, frameSequence, streamGeneration }); }
  keyframe(sessionId) { if (this.#sessions.has(sessionId)) this.#send({ type: 'keyframe', sessionId }); }
  stop(sessionId) {
    this.#requests.get(sessionId)?.cancel();
    if (!this.#sessions.delete(sessionId)) {
      // Only cancelled work left: release the renderer now, not after it settles.
      if (!this.#sessions.size && [...this.#requests.values()].every(request => request.cancelled)) this.close();
      return;
    }
    try { this.#send({ type: 'stop', sessionId }); } catch { /* window already gone */ }
    if (!this.#sessions.size) this.#closeSoon(this.#generation);
  }
  /** Releases the renderer, its capture tracks and encoders. */
  close() {
    ++this.#generation; ++this.#closes;
    for (const request of [...this.#requests.values()]) request.cancel();
    this.#discard = 0;
    this.#openAbort?.abort(); this.#openAbort = undefined;
    // Teardown must always complete.
    try { this.#detach?.(); } catch { /* listener already gone */ }
    this.#detach = undefined;
    const window = this.#window;
    this.#window = undefined; this.#port?.close(); this.#port = undefined; this.#ready = undefined; this.#pending = undefined; this.#sessions.clear(); this.#opened = false;
    for (const waiter of [...this.#waiters.values()]) waiter('ended');
    if (window && !window.isDestroyed()) window.destroy();
  }
}
