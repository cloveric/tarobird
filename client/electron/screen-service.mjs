import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { SCREEN_CONTROL_QUALITY_CAPABILITY, SCREEN_MAX_CONTROL_BYTES, SCREEN_MAX_VIEWERS, SCREEN_SERVICE_QUALITY_FEATURE, screenDesktopSchema, screenServiceCommandSchema, screenServiceEventSchema } from '../../src/client-protocol/remote-screen.ts';
import { screenQualityProfile } from '../../src/client-protocol/screen-quality.ts';
import { ScreenGeometry, encodeSize } from './screen-geometry.mjs';
import { ScreenInput, SCREEN_FRAME_FRESH_MS } from './screen-input.mjs';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const registeredSchema = z.object({ type: z.literal('registered'), epoch: z.union([z.string().regex(ID), z.number().int().nonnegative()]), serverTime: z.number().int().nonnegative() }).strict();
/** Missing, failed or interrupted local-takeover monitor. */
const TAKEOVER_UNAVAILABLE = 'screen_takeover_unavailable';
const LEASE_DENIED = new Set(['screen_frame_stale', 'screen_lease_invalid', 'screen_input_denied', 'screen_geometry_changed', 'screen_locked', TAKEOVER_UNAVAILABLE]);
const STOPS = new Set(['screen_local_takeover', 'screen_capture_failed', 'screen_input_failed', 'screen_locked', 'screen_service_stopped', 'screen_congested', 'screen_geometry_changed', 'screen_capture_stale']);
/** Session stop reasons are a closed set; internal lease reasons map onto it. */
const stopReason = reason => STOPS.has(reason) ? reason : reason === 'screen_frame_stale' ? 'screen_capture_stale' : reason === 'screen_input_denied' ? 'screen_input_failed' : 'screen_service_stopped';
const attachedSchema = z.object({ type: z.literal('attached'), sessionId: z.string().regex(ID) }).strict();
const CONTROL_BACKLOG = 16 * 1024;
const MEDIA_BACKLOG = 2 * 1024 * 1024, LEDGER = 64, TAKEOVER_POINTS = 12, CLOCK_JUMP_MS = 1000;
const captureState = status => status === 'granted' ? 'granted' : status === 'not-determined' ? 'not-determined' : ['denied', 'restricted'].includes(status) ? 'denied' : 'unavailable';
/** Service readiness errors (`status().error`) are bounded `[a-z_]` codes; the
 * ticket step reports screen-host-control's codes, a Host refusal before
 * registration its `close(4000, screen_*)` reason. Never OS text or paths. */
const CODE = /^[a-z_]{1,64}$/, HOST_REASON = /^screen_[a-z_]{1,57}$/;
const ticketError = error => CODE.test(error?.message ?? '') ? error.message : 'screen_host_unavailable';
const PANES = { capture: 'Privacy_ScreenCapture', accessibility: 'Privacy_Accessibility', 'input-monitoring': 'Privacy_ListenEvent' };

/** App-level target service for this Mac's desktop. Lives for the App's
 * lifetime, independent of the chat window and its document/NativeOwner: a
 * chat reload neither ends nor inherits screen sessions. Registers with the
 * canonical Host only through the private control-socket ticket and the
 * loopback instance listener. Nothing is captured until the Host starts a
 * session; the capture renderer is released after the last one ends. */
export class ScreenService {
  #ws; #registered = false; #epoch; #timer; #retry; #retryAt; #retryDelay; #disposed = false; #started = false; #startFailed = false;
  #connecting = false; #attempt = 0; #wsFailure;
  #sessions = new Map(); #instancePort; #lastError; #clock; #takeover; #hostRelease = false; #lockedEvent = false; #readyCache; #leaseReady;
  constructor({ electron, addon, stateDir, hostControl, captureHost, platform = process.platform, WebSocketClass = WebSocket,
    wall = Date.now, monotonic = () => performance.now(), onSharing = () => {}, isUpdating = () => false, log = () => {},
    registerTimeoutMs = 10000, attachTimeoutMs = 10000, retryBaseMs = 1000, retryMaxMs = 30000 }) {
    Object.assign(this, { electron, addon, stateDir, hostControl, platform, WebSocketClass, wall, monotonic, onSharing, isUpdating, log, registerTimeoutMs, attachTimeoutMs, retryBaseMs, retryMaxMs });
    this.#retryDelay = retryBaseMs;
    this.supported = platform === 'darwin' && !!addon?.screenMouse;
    this.instanceId = `screen-${randomUUID()}`;
    this.geometry = new ScreenGeometry({ screen: electron.screen, uuidOf: id => addon?.screenDisplayUuid?.(id) ?? null });
    this.capture = captureHost?.({ onMessage: message => this.#capture(message), onGone: (sessions, reason) => { for (const id of sessions) this.#end(id, reason, true); } });
    this.input = new ScreenInput({ native: this.#native(), geometry: this.geometry, frames: (id, sequence, generation) => this.#frame(id, sequence, generation),
      ready: () => this.#ready(), wall, monotonic, onReleased: (lease, reason) => this.#released(lease, reason) });
  }

  // ---------------- lifecycle ----------------
  /** Never rejects: a failure is kept as `status().error` (phase `failed`)
   * and an explicit `retry()` starts again. Concurrent callers share the one
   * in-flight start, which connects only once the desktop id is known. */
  start() {
    if (!this.supported || this.#disposed) return Promise.resolve();
    if (this.#starting) return this.#starting;
    if (this.#started) return Promise.resolve();
    this.#starting = this.#start().finally(() => { this.#starting = undefined; });
    return this.#starting;
  }
  #starting;
  async #start() {
    this.#started = true; this.#startFailed = false;
    try {
      this.desktopId = await this.#desktopId();
      await this.#recoverStaleInput();
      if (this.#disposed) return;
      const { powerMonitor, screen } = this.electron;
      this.#watch(powerMonitor, 'lock-screen', () => { this.#lockedEvent = true; this.#readyCache = undefined; this.#invalidate('screen_locked'); });
      this.#watch(powerMonitor, 'unlock-screen', () => { this.#lockedEvent = false; this.#readyCache = undefined; });
      this.#watch(powerMonitor, 'user-did-resign-active', () => { this.#lockedEvent = true; this.#readyCache = undefined; this.#invalidate('screen_locked'); });
      this.#watch(powerMonitor, 'user-did-become-active', () => { this.#lockedEvent = false; this.#readyCache = undefined; });
      this.#watch(powerMonitor, 'suspend', () => { this.#readyCache = undefined; this.#invalidate('screen_lease_invalid', true); });
      for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) this.#watch(screen, name, () => this.#geometryChanged());
      this.#clock = { wall: this.wall(), mono: this.monotonic() };
    } catch (error) {
      for (const stop of this.#listeners.splice(0)) stop();
      this.#started = false; this.#startFailed = true; this.#lastError = 'screen_service_start_failed';
      this.log(`screen_service_start_failed:${String(error?.code ?? 'error').slice(0, 32)}`);
      return;
    }
    this.#connect();
  }
  #listeners = [];
  #watch(target, name, fn) { target?.on?.(name, fn); this.#listeners.push(() => target?.removeListener?.(name, fn)); }

  /** Ends every session and releases input before the App quits. */
  async prepareQuit() { this.stop(undefined, 'screen_service_stopped'); return true; }
  dispose() {
    if (this.#disposed) return;
    this.stop(undefined, 'screen_service_stopped');
    this.#disposed = true;
    clearTimeout(this.#retry); clearInterval(this.#timer);
    for (const stop of this.#listeners.splice(0)) stop();
    this.#ws?.close(1001, 'screen_service_stopped'); this.#ws = undefined;
    this.capture?.close();
  }

  // ---------------- management (DesktopServices) ----------------
  /** `phase`: starting | connecting | registered | retrying | failed. `error`
   * is the latest readiness failure, cleared on registration. Permission
   * values are preflight checks only; reading them never prompts. */
  status() {
    if (!this.supported) return { supported: false };
    const phase = this.#registered ? 'registered' : this.#startFailed ? 'failed' : !this.#started ? 'starting'
      : this.#connecting ? 'connecting' : this.#retry ? 'retrying' : 'starting';
    const permissions = { capture: this.#permission('capture'), accessibility: this.#permission('accessibility'), inputMonitoring: this.#permission('input-monitoring') };
    let desktop = null; try { desktop = this.desktopId ? this.#desktop() : null; } catch { /* reported as no desktop */ }
    return { supported: true, phase, registered: this.#registered, error: this.#lastError, ...(phase === 'retrying' ? { retryAt: this.#retryAt } : {}),
      permissions, inputMonitoring: permissions.inputMonitoring, desktop,
      sessions: [...this.#sessions.values()].map(r => ({ id: r.session.id, deviceName: r.session.deviceName, controlling: this.input.lease?.sessionId === r.session.id })) };
  }
  /** Explicit user action: starts again after a startup failure, or skips the
   * current backoff once. Never requests a permission or changes any grant;
   * an attempt already in flight or a registered service is left alone. */
  async retry() {
    if (!this.supported) throw new Error('screen_service_unavailable');
    if (this.#disposed) return this.status();
    if (this.#starting || !this.#started) await this.start(); // the start itself connects
    else if (!this.#registered && !this.#connecting) { this.#retryDelay = this.retryBaseMs; this.#connect(); }
    return this.status();
  }
  /** Preflight only (no prompt): capture via Electron's
   * CGPreflightScreenCaptureAccess, Accessibility via AXIsProcessTrusted,
   * Input Monitoring via CGPreflightListenEventAccess. */
  #permission(kind) {
    try {
      if (kind === 'capture') return captureState(this.electron.systemPreferences.getMediaAccessStatus('screen'));
      if (kind === 'accessibility') return this.electron.systemPreferences.isTrustedAccessibilityClient(false) === true;
      return this.addon.screenMonitorAccess?.(false) === true;
    } catch { return kind === 'capture' ? 'unavailable' : false; }
  }
  /** Explicit "Set … permission" gesture only, one permission per button.
   * Not yet granted: ask macOS first (it may prompt, and lists the App in the
   * pane; Electron never reports `not-determined` for the screen on macOS, so
   * capture uses CGRequestScreenCaptureAccess directly). Then always open that
   * System Settings pane, granted or not. A failed request still opens the
   * pane and is returned as `requestError`; a pane that cannot be opened
   * throws `screen_permission_settings_failed`. Grants nothing by itself. */
  async permission(kind) {
    if (!this.supported) throw new Error('screen_service_unavailable');
    if (!Object.hasOwn(PANES, kind)) throw new Error('screen_permission_invalid');
    const granted = kind === 'capture' ? this.#permission(kind) === 'granted' : this.#permission(kind);
    let requested = false, requestError;
    if (!granted) {
      requested = true;
      try {
        if (kind === 'capture') this.addon.screenCaptureAccess(true);
        else if (kind === 'accessibility') this.electron.systemPreferences.isTrustedAccessibilityClient(true);
        else this.addon.screenMonitorAccess(true);
      } catch { requestError = 'screen_permission_request_failed'; this.log(`${requestError}:${kind}`); }
    }
    this.#readyCache = undefined;
    try { await this.electron.shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PANES[kind]}`); }
    catch { this.log(`screen_permission_settings_failed:${kind}`); throw new Error('screen_permission_settings_failed'); }
    return { ...this.status(), requested, opened: true, ...(requestError ? { requestError } : {}) };
  }
  /** Local owner stop (tray, shortcut, settings): releases input first. */
  stop(sessionId, reason = 'screen_service_stopped') {
    if (!sessionId || this.input.lease?.sessionId === sessionId) this.input.release(reason);
    const ids = sessionId ? [sessionId] : [...this.#sessions.keys()];
    for (const id of ids) this.#end(id, reason, !!sessionId);
    if (!sessionId && this.#registered) this.#emit({ type: 'stop', reason: stopReason(reason) });
    return { ok: true };
  }

  // ---------------- Host registration ----------------
  /** One registration attempt at a time; every failure path records its
   * code and schedules the next attempt (the chain never ends silently). */
  #connect() {
    if (this.#disposed || this.#connecting || this.#ws || !this.desktopId) return;
    clearTimeout(this.#retry); this.#retry = undefined; this.#retryAt = undefined;
    // An App update replaces this process: no new registration while it installs.
    if (this.isUpdating()) { this.#lastError = 'screen_service_updating'; this.#scheduleRetry(); return; }
    this.#connecting = true;
    const attempt = ++this.#attempt;
    void this.#register(attempt).catch(() => {
      const ws = this.#ws;
      if (!ws || attempt !== this.#attempt) { this.#attemptFailed(attempt, 'screen_host_connect_failed'); return; }
      this.#wsFailure ??= 'screen_host_connect_failed';
      try { ws.terminate(); } catch { this.#disconnected(ws, this.#wsFailure); }
    });
  }
  async #register(attempt) {
    let ticket;
    try { ticket = await this.hostControl.ticket(this.desktopId); }
    catch (error) { this.#attemptFailed(attempt, ticketError(error)); return; }
    if (this.#disposed || attempt !== this.#attempt) return;
    // An install may have begun while the ticket was pending.
    if (this.isUpdating()) { this.#attemptFailed(attempt, 'screen_service_updating'); return; }
    this.#instancePort = ticket.instancePort;
    const ws = new this.WebSocketClass(`ws://127.0.0.1:${ticket.instancePort}/screen/v1/target`, { perMessageDeflate: false, maxPayload: SCREEN_MAX_CONTROL_BYTES, handshakeTimeout: 5000 });
    this.#ws = ws; this.#wsFailure = undefined;
    let opened = false;
    // Bounded registration: an unanswered socket is dropped and retried.
    const deadline = setTimeout(() => { if (this.#ws === ws && !this.#registered) { this.#wsFailure ??= 'screen_registration_timeout'; ws.terminate(); } }, this.registerTimeoutMs);
    deadline.unref?.();
    ws.on('open', () => {
      opened = true;
      if (this.isUpdating()) { this.#wsFailure ??= 'screen_service_updating'; ws.terminate(); return; }
      // Optional features only for a Host that advertised them on the ticket
      // reply: an older Hub parses this hello strictly and would refuse it.
      const features = Array.isArray(ticket.capabilities) && ticket.capabilities.includes(SCREEN_CONTROL_QUALITY_CAPABILITY) ? [SCREEN_SERVICE_QUALITY_FEATURE] : undefined;
      try { this.#send(ws, { type: 'hello', ticket: ticket.ticket, desktop: this.#desktop(), ...(features ? { features } : {}) }); }
      catch { this.#wsFailure ??= 'screen_desktop_invalid'; ws.terminate(); }
    });
    ws.on('message', (data, binary) => { this.#hostMessage(ws, data, binary); if (this.#registered) clearTimeout(deadline); });
    ws.on('error', () => {});
    ws.on('close', (code, reason) => {
      clearTimeout(deadline);
      if (this.#ws !== ws) return;
      const text = Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason ?? '');
      // A Host refusal is close(4000, <HubError code>) before `registered`.
      this.#disconnected(ws, this.#registered ? 'screen_host_disconnected' : this.#wsFailure ?? (!opened ? 'screen_host_connect_failed'
        : code === 4000 && HOST_REASON.test(text) ? text : 'screen_registration_rejected'));
    });
  }
  #attemptFailed(attempt, code) {
    if (this.#disposed || attempt !== this.#attempt || this.#ws) return;
    this.#connecting = false; this.#lastError = code;
    this.log(`screen_registration_failed:${code}`);
    this.#scheduleRetry();
  }
  #scheduleRetry() {
    if (this.#disposed) return;
    clearTimeout(this.#retry);
    const delay = this.#retryDelay;
    this.#retryAt = this.wall() + delay;
    this.#retry = setTimeout(() => { this.#retry = undefined; this.#connect(); }, delay); this.#retry.unref?.();
    this.#retryDelay = Math.min(this.retryMaxMs, delay * 2);
  }
  #disconnected(ws, error) {
    if (this.#ws !== ws) return;
    this.#ws = undefined; this.#registered = false; this.#connecting = false; clearInterval(this.#timer);
    this.#lastError = error;
    if (error) this.log(`screen_registration_failed:${error}`);
    // Without the Host there is no authority: release and end everything locally.
    this.input.release('screen_lease_invalid');
    for (const id of [...this.#sessions.keys()]) this.#end(id, 'screen_service_stopped', false);
    this.#scheduleRetry();
  }
  /** Bounded JSON send. A full socket or failed write ends that channel
   * (the control socket, or the session owning a media socket). */
  #send(ws, message, onFail = () => ws?.terminate?.()) {
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) > SCREEN_MAX_CONTROL_BYTES) throw new Error('screen_message_too_large');
    if (ws?.readyState !== this.WebSocketClass.OPEN) return false;
    if (ws.bufferedAmount + Buffer.byteLength(text) > CONTROL_BACKLOG) { onFail(); return false; }
    try { ws.send(text, error => { if (error) onFail(); }); } catch { onFail(); return false; }
    return true;
  }
  #emit(event) { if (this.#registered) this.#send(this.#ws, screenServiceEventSchema.parse(event)); }
  #hostMessage(ws, data, binary) {
    if (ws !== this.#ws) return;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const invalid = () => { if (!this.#registered) this.#wsFailure ??= 'screen_registration_invalid'; ws.close(1008, 'screen_control_invalid'); };
    if (binary || bytes.length > SCREEN_MAX_CONTROL_BYTES) { invalid(); return; }
    let message;
    try { message = JSON.parse(bytes.toString('utf8')); } catch { invalid(); return; }
    if (!this.#registered) {
      const registered = registeredSchema.safeParse(message);
      if (!registered.success) { this.#wsFailure ??= 'screen_registration_invalid'; ws.close(1008, 'screen_control_invalid'); return; }
      this.#registered = true; this.#connecting = false; this.#epoch = registered.data.epoch; this.#retryDelay = this.retryBaseMs; this.#lastError = undefined;
      this.#timer = setInterval(() => this.#tick(), 1000); this.#timer.unref?.();
      return;
    }
    const command = screenServiceCommandSchema.safeParse(message);
    if (!command.success) { this.log('screen_command_invalid'); return; }
    try { this.#command(command.data); } catch (error) { this.log(`screen_command_failed:${error?.message}`); }
  }

  // ---------------- commands ----------------
  #command(c) {
    const record = this.#sessions.get(c.type === 'start' ? c.session.id : c.sessionId);
    switch (c.type) {
      case 'start': return this.#startSession(c);
      case 'stop': if (record) this.#end(record.session.id, c.reason, false); return;
      case 'pause':
        if (!record) return;
        // Hide retires the current generation and announces the next one; show
        // resumes with that same announced generation. Only a resume while
        // paused, to a newer generation, restarts the stream: a repeated
        // resume never restarts the same reference chain.
        if (c.paused) { this.#releaseFor(record, 'screen_lease_invalid'); record.paused = true; record.pauseGeneration = c.streamGeneration; record.ledger.clear(); this.#reconcile(record); return; }
        if (!record.paused || c.streamGeneration <= record.streamGeneration) return;
        record.paused = false; record.streamGeneration = c.streamGeneration; record.ledger.clear();
        this.#reconcile(record); return;
      case 'reset':
        if (!record || c.streamGeneration <= record.streamGeneration) return;
        this.#releaseFor(record, 'screen_lease_invalid');
        record.streamGeneration = c.streamGeneration; record.ledger.clear();
        this.#reconcile(record); return;
      case 'keyframe': if (record) this.capture.keyframe(record.session.id); return;
      case 'ack': if (record) this.#ack(record, c); return;
      case 'lease': return this.#lease(record, c);
      case 'release':
        if (record && this.input.lease?.sessionId === record.session.id) { this.#hostRelease = true; try { this.input.release(c.reason); } finally { this.#hostRelease = false; } }
        return;
      case 'input': {
        // No input before this service has announced lease-ready (marker on disk).
        if (!record || c.desktopId !== this.desktopId || record.paused || c.leaseId !== this.#leaseReady) return;
        if (this.#localTakeover()) return;
        const refused = this.input.apply(c);
        if (refused) this.log(`screen_input_refused:${refused}`);
        return;
      }
      default: return;
    }
  }
  #startSession({ session, mediaTicket, streamGeneration, codecs, quality }) {
    if (this.#sessions.has(session.id)) return;
    const fail = reason => this.#emit({ type: 'stop', sessionId: session.id, reason });
    // An App update replaces this process: no new sessions while it installs.
    if (session.desktopId !== this.desktopId || this.#sessions.size >= SCREEN_MAX_VIEWERS || this.isUpdating()) return fail('screen_service_stopped');
    if (captureState(this.electron.systemPreferences.getMediaAccessStatus('screen')) !== 'granted') return fail('screen_capture_failed');
    const display = this.geometry.find(session.display.id);
    if (!display || display.revision !== session.display.revision) return fail('screen_geometry_changed');
    const media = new this.WebSocketClass(`ws://127.0.0.1:${this.#instancePort}/screen/v1/target-media`, { perMessageDeflate: false, maxPayload: SCREEN_MAX_CONTROL_BYTES, handshakeTimeout: 5000 });
    // `sent*` = what the capture page has actually been told (generation/paused).
    const record = { session, display, media, streamGeneration, ledger: new Map(), lastCaptureMs: 0, lastCaptureMono: 0, paused: false, cursor: 'unknown',
      sentGeneration: 0, sentPaused: false, started: false };
    this.#sessions.set(session.id, record);
    this.#sharing();
    const failed = () => { if (this.#sessions.get(session.id) === record) this.#end(session.id, 'screen_capture_failed', true); };
    record.fail = failed;
    // Bounded attach: a media socket the Host never binds ends the session.
    const attachDeadline = setTimeout(() => { if (this.#sessions.get(session.id) === record && !record.attached) media.terminate(); }, this.attachTimeoutMs);
    attachDeadline.unref?.();
    media.on('error', () => {});
    media.on('close', () => { clearTimeout(attachDeadline); if (this.#sessions.get(session.id) === record) this.#end(session.id, 'screen_capture_failed', false); });
    // Exactly one `attached` for this session, then the socket is send-only.
    // Capture starts only after the Host has bound this media socket.
    media.on('message', (data, binary) => {
      if (this.#sessions.get(session.id) !== record || this.#disposed) return; // ended before the Host attached it
      if (this.isUpdating()) { this.#end(session.id, 'screen_service_stopped', true); return; }
      const text = !binary && (Buffer.isBuffer(data) ? data : Buffer.from(data));
      let attached;
      try { attached = !record.attached && text && text.length <= 1024 && attachedSchema.parse(JSON.parse(text.toString('utf8'))); } catch { attached = undefined; }
      if (!attached || attached.sessionId !== session.id) { media.close(1008, 'screen_media_invalid'); return; }
      record.attached = true; clearTimeout(attachDeadline);
      record.sentGeneration = record.streamGeneration;
      // The session's fixed quality sets the real capture constraints, encoder
      // size, frame rate and quantizer/bitrate (omitted = legacy balanced).
      const profile = screenQualityProfile(quality);
      this.capture.start({ sessionId: session.id, display, streamGeneration: record.streamGeneration, codecs, encode: encodeSize(display, profile),
        fps: profile.fps, profile: { qpBase: profile.qpBase, qpMax: profile.qpMax, bitrate: profile.bitrate, h264Only: profile.h264Only } })
        .then(() => {
          if (this.#sessions.get(session.id) !== record || this.#disposed) { this.capture?.stop(session.id); return; }
          record.started = true;
          this.#reconcile(record);
        }, failed);
    });
    media.on('open', () => { if (!this.#send(media, { type: 'hello', ticket: mediaTicket }, failed)) failed(); });
  }
  /** Brings the capture page to the Host's latest generation/visibility. While
   * capture is still starting, pause/reset cannot reach the page; they are
   * applied once it has started, so the page never keeps an old generation. */
  #reconcile(record) {
    if (!record.started || this.#sessions.get(record.session.id) !== record) return;
    const id = record.session.id;
    if (record.paused) {
      if (!record.sentPaused && this.capture.pause(id, true, record.pauseGeneration ?? record.streamGeneration)) record.sentPaused = true;
      return;
    }
    if (!record.sentPaused && record.sentGeneration === record.streamGeneration) return;
    const sent = record.sentPaused ? this.capture.pause(id, false, record.streamGeneration) : this.capture.reset(id, record.streamGeneration, record.display.revision);
    if (sent) { record.sentPaused = false; record.sentGeneration = record.streamGeneration; }
  }
  #capture(message) {
    const record = this.#sessions.get(message.sessionId);
    if (!record) return;
    switch (message.type) {
      case 'stream':
        if (message.stream?.streamGeneration !== record.streamGeneration) return;
        this.#send(record.media, message.stream, record.fail); return;
      case 'started': record.cursor = message.cursor === 'always' ? 'always' : 'unknown'; return;
      case 'captured': record.lastCaptureMs = message.captureMs; record.lastCaptureMono = this.monotonic() - Math.max(0, this.wall() - message.captureMs); return;
      case 'frame': {
        if (message.streamGeneration !== record.streamGeneration || record.paused) return;
        if (record.media.readyState !== this.WebSocketClass.OPEN || record.media.bufferedAmount + message.bytes.byteLength > MEDIA_BACKLOG) {
          this.#end(record.session.id, 'screen_congested', true); return;
        }
        const captureMono = this.monotonic() - Math.max(0, this.wall() - message.captureMs);
        record.ledger.set(message.sequence, { captureMs: message.captureMs, captureMono, streamGeneration: message.streamGeneration,
          geometryRevision: message.geometryRevision, displayId: record.display.id, confirmed: false });
        while (record.ledger.size > LEDGER) record.ledger.delete(record.ledger.keys().next().value);
        try { record.media.send(message.bytes, { binary: true }, error => { if (error) record.fail(); }); } catch { record.fail(); }
        return;
      }
      case 'ended': this.#end(record.session.id, LEASE_DENIED.has(message.reason) || message.reason === 'screen_congested' ? message.reason : 'screen_capture_failed', true); return;
      default: return;
    }
  }
  /** Confirms a viewer-decoded frame only if this service actually sent it in the
   * current generation, it is still fresh, and capture/geometry are healthy. */
  #ack(record, { frameSequence, streamGeneration }) {
    const entry = record.ledger.get(frameSequence);
    if (!entry || entry.confirmed || streamGeneration !== record.streamGeneration || entry.streamGeneration !== streamGeneration) return;
    this.capture.credit(record.session.id, frameSequence, streamGeneration);
    const display = this.geometry.find(record.display.id);
    const fresh = this.wall() <= entry.captureMs + SCREEN_FRAME_FRESH_MS && this.monotonic() <= entry.captureMono + SCREEN_FRAME_FRESH_MS;
    if (!fresh || !display || display.revision !== entry.geometryRevision) return;
    entry.confirmed = true;
    this.#emit({ type: 'frame-confirmed', sessionId: record.session.id, frameSequence, streamGeneration, captureMs: entry.captureMs });
  }
  #frame(sessionId, sequence, generation) {
    const record = this.#sessions.get(sessionId), entry = record?.ledger.get(sequence);
    if (!entry?.confirmed || entry.streamGeneration !== record.streamGeneration || generation !== undefined && generation !== entry.streamGeneration) return undefined;
    return { captureMs: entry.captureMs, receivedMono: entry.captureMono, displayId: entry.displayId, geometryRevision: entry.geometryRevision };
  }
  #lease(record, c) {
    const deny = reason => this.#emit({ type: 'lease-denied', sessionId: c.sessionId, leaseId: c.leaseId, reason });
    if (!record || record.paused || c.generation !== record.session.generation || !record.session.controlAllowed) return deny('screen_lease_invalid');
    if (this.isUpdating()) return deny('screen_input_denied');
    if (c.streamGeneration !== record.streamGeneration) return deny('screen_frame_stale');
    const renewal = this.input.lease?.leaseId === c.leaseId;
    const result = this.input.grant(c);
    if (!result.ok) return deny(LEASE_DENIED.has(result.reason) ? result.reason : 'screen_lease_invalid');
    if (renewal) { this.#emit({ type: 'lease-ready', sessionId: c.sessionId, leaseId: c.leaseId }); return; }
    // The local-takeover monitor must run before any remote input is posted;
    // without it the person at the Mac could not take over by keyboard.
    try { this.addon.screenMonitorStart(); } catch { this.input.release(TAKEOVER_UNAVAILABLE); return; }
    // Then the crash-recovery marker must be on disk before any input is posted.
    const current = () => this.input.lease?.leaseId === c.leaseId && this.input.lease.sessionId === c.sessionId;
    void this.#monitorReady(current).then(state => {
      if (state === 'ready') return this.#marker();
      if (current()) this.input.release(state === 'takeover' ? 'screen_local_takeover' : TAKEOVER_UNAVAILABLE);
      return false;
    }).then(written => {
      if (!written || !current()) { if (current()) this.input.release('screen_input_denied'); return; }
      // Monitor health again after the marker await, immediately before ready.
      if (this.#localTakeover()) return;
      this.#leaseReady = c.leaseId;
      this.#watchTakeover();
      this.#sharing();
      this.#emit({ type: 'lease-ready', sessionId: c.sessionId, leaseId: c.leaseId });
    });
  }
  #releaseFor(record, reason) { if (this.input.lease?.sessionId === record.session.id) this.input.release(reason); }
  #released(lease, reason) {
    clearInterval(this.#takeover); this.#takeover = undefined;
    try { this.addon.screenMonitorStop(); } catch { /* already stopped */ }
    if (this.#leaseReady === lease.leaseId) this.#leaseReady = undefined;
    void this.#marker();
    this.#sharing();
    if (this.#hostRelease || !this.#sessions.has(lease.sessionId)) return;
    if (reason === 'screen_local_takeover') this.#emit({ type: 'stop', sessionId: lease.sessionId, reason });
    else if (LEASE_DENIED.has(reason)) this.#emit({ type: 'lease-denied', sessionId: lease.sessionId, leaseId: lease.leaseId, reason });
  }
  #end(sessionId, reason, notify) {
    const record = this.#sessions.get(sessionId);
    if (!record) return;
    this.#releaseFor(record, LEASE_DENIED.has(reason) ? reason : 'screen_lease_invalid');
    this.#sessions.delete(sessionId);
    this.capture?.stop(sessionId);
    if (record.media.readyState <= this.WebSocketClass.OPEN) record.media.close(1000, 'screen_session_ended');
    if (notify) this.#emit({ type: 'stop', sessionId, reason: stopReason(reason) });
    this.#sharing();
  }

  // ---------------- health ----------------
  #tick() {
    const wall = this.wall(), mono = this.monotonic();
    // A wall-clock jump (or sleep the suspend event missed) invalidates every
    // freshness proof: the Host and target share this clock.
    if (this.#clock && Math.abs((wall - this.#clock.wall) - (mono - this.#clock.mono)) > CLOCK_JUMP_MS) this.#invalidate('screen_lease_invalid', true);
    this.#clock = { wall, mono };
    this.#readyCache = undefined;
    if (this.isUpdating() && this.#sessions.size) { this.stop(undefined, 'screen_service_stopped'); }
    const blocked = this.#ready();
    if (blocked && this.input.lease) this.input.release(blocked);
    const lease = this.input.lease, record = lease && this.#sessions.get(lease.sessionId);
    if (record && mono - record.lastCaptureMono > SCREEN_FRAME_FRESH_MS + 500) this.input.release('screen_frame_stale');
    if (this.#registered) { try { this.#send(this.#ws, { type: 'status', desktop: this.#desktop() }); } catch (error) { this.log(`screen_status_failed:${error?.message?.slice(0, 64)}`); } }
  }
  #invalidate(reason, forgetFrames = false) {
    this.input.release(reason);
    if (forgetFrames) for (const record of this.#sessions.values()) for (const entry of record.ledger.values()) entry.confirmed = false;
  }
  #geometryChanged() {
    for (const record of [...this.#sessions.values()]) {
      const display = this.geometry.find(record.display.id);
      if (!display || display.revision !== record.display.revision) this.#end(record.session.id, 'screen_geometry_changed', true);
    }
  }
  #session() {
    try { return this.addon.screenSession(); } catch { return { available: false, onConsole: false, locked: false }; }
  }
  #ready() {
    const now = this.monotonic();
    if (this.#readyCache && now - this.#readyCache.at < 250) return this.#readyCache.value;
    const session = this.#session();
    const value = !session.available || !session.onConsole || session.locked || this.#lockedEvent ? 'screen_locked'
      : !this.electron.systemPreferences.isTrustedAccessibilityClient(false) ? 'screen_input_denied' : null;
    this.#readyCache = { at: now, value };
    return value;
  }
  /** The person at the Mac moved the pointer away from where remote input
   * left it: stop remote control immediately; regaining it needs a new request. */
  /** Waits (bounded, without blocking main) until the monitor reports its tap
   * is live. Bound to one lease: a superseded wait stops polling so it cannot
   * consume a newer monitor's counts. Counts read here are acted on exactly
   * like during control: foreign input = takeover, a gap = unavailable.
   * Returns 'ready' | 'takeover' | 'unavailable' | 'stale'. */
  async #monitorReady(current, limitMs = 1000) {
    const end = this.monotonic() + limitMs;
    while (this.monotonic() < end) {
      if (!current()) return 'stale';
      let poll; try { poll = this.addon.screenMonitorPoll(); } catch { return 'unavailable'; }
      if (poll.foreign) return 'takeover';
      if (poll.failed || poll.interrupted) return 'unavailable';
      if (poll.alive) return 'ready';
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return current() ? 'unavailable' : 'stale';
  }
  /** True (and control released) if the person at the Mac used keyboard or
   * mouse, or the monitor stopped seeing input. Counts only; no key content. */
  #localTakeover() {
    let monitor;
    try { monitor = this.addon.screenMonitorPoll(); } catch { monitor = { alive: false, failed: true, foreign: 0, interrupted: 0 }; }
    if (!monitor.alive || monitor.failed || monitor.interrupted) { this.input.release(TAKEOVER_UNAVAILABLE); return true; }
    if (monitor.foreign) { this.input.release('screen_local_takeover'); return true; }
    return false;
  }
  #watchTakeover() {
    if (this.#takeover) return;
    this.#takeover = setInterval(() => {
      if (!this.input.lease || this.#localTakeover()) return;
      const pointer = this.input.pointer;
      if (!pointer || this.monotonic() - pointer.at < 300) return;
      let cursor; try { cursor = this.addon.screenCursor(); } catch { return; }
      if (Math.hypot(cursor.x - pointer.x, cursor.y - pointer.y) > TAKEOVER_POINTS) this.input.release('screen_local_takeover');
    }, 250);
    this.#takeover.unref?.();
  }

  // ---------------- desktop description ----------------
  #desktop() {
    const session = this.#session();
    const login = session.unique ? `cgs-${session.unique}` : Number.isSafeInteger(session.audit) ? `asid-${session.audit}` : 'unknown';
    return screenDesktopSchema.parse({ desktopId: this.desktopId, instanceId: this.instanceId, loginSession: login, platform: 'macos',
      capture: captureState(this.electron.systemPreferences.getMediaAccessStatus('screen')),
      accessibility: this.electron.systemPreferences.isTrustedAccessibilityClient(false),
      locked: !session.available || !session.onConsole || session.locked || this.#lockedEvent, displays: this.geometry.displays() });
  }
  async #desktopId() {
    const file = path.join(this.stateDir, 'screen-desktop.json');
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (value?.format === 1 && typeof value.desktopId === 'string' && ID.test(value.desktopId)) return value.desktopId;
    } catch (error) { if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    const desktopId = `desktop-${randomUUID()}`;
    await mkdir(this.stateDir, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ format: 1, desktopId }), { mode: 0o600 });
    await rename(temporary, file);
    return desktopId;
  }
  /** Present only while a control lease is live. Found at startup it means the
   * App died mid-control: lift modifiers and buttons once. Writes and removals
   * are serialized and always converge on the current lease state, so a late
   * removal can never delete a newer lease's marker. Resolves true if the file
   * now matches an active lease. */
  #markers = Promise.resolve();
  #marker() {
    const file = path.join(this.stateDir, 'screen-control.active');
    const run = this.#markers.then(async () => {
      const active = !!this.input.lease;
      try {
        if (active) { await mkdir(this.stateDir, { recursive: true }); await writeFile(file, String(this.wall()), { mode: 0o600 }); }
        else await rm(file, { force: true });
        return active;
      } catch { return false; }
    });
    this.#markers = run.catch(() => false);
    return run;
  }
  async #recoverStaleInput() {
    const file = path.join(this.stateDir, 'screen-control.active');
    try { await readFile(file); } catch { return; }
    try { this.addon.screenReleaseStale(); } catch { /* reported by status */ }
    await rm(file, { force: true }).catch(() => {});
  }
  #native() {
    const addon = () => this.addon;
    return {
      mouse: (action, button, x, y, clicks, flags) => addon().screenMouse(action, button, x, y, clicks, flags),
      scroll: (x, y, wheel1, wheel2, flags) => addon().screenScroll(x, y, wheel1, wheel2, flags),
      key: (keycode, down, flags, { modifier, repeat }) => addon().screenKey(keycode, down, flags, modifier, repeat),
      text: text => addon().screenText(text),
      location: () => addon().screenCursor(),
      releaseAll: () => addon().screenReleaseAll(),
    };
  }
  #sharing() {
    try { this.onSharing([...this.#sessions.values()].map(r => ({ id: r.session.id, deviceName: r.session.deviceName, displayId: r.display.id, nativeId: r.display.nativeId,
      controlling: this.input.lease?.sessionId === r.session.id }))); } catch { /* presentation only */ }
  }
}
