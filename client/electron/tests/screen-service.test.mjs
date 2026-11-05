import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ScreenService } from '../screen-service.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
/** Scripted WebSocket: the test decides when each socket opens or receives. */
function sockets() {
  const all = [];
  class FakeSocket extends EventEmitter {
    static OPEN = 1;
    constructor(url) { super(); this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; all.push(this); }
    send(data, options, callback) { const done = typeof options === 'function' ? options : callback; this.sent.push(typeof data === 'string' ? JSON.parse(data) : data); done?.(); }
    open() { this.readyState = 1; this.emit('open'); }
    receive(value) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
    close(code = 1005, reason = '') { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', code, Buffer.from(reason)); }
    terminate() { this.close(1006); }
  }
  return { FakeSocket, all, find: suffix => all.filter(s => s.url.endsWith(suffix)) };
}
async function lab(t, { startCapture, updating = () => false, attachTimeoutMs } = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'screen-service-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let hooks;
  const ws = sockets(), capture = { starts: [], stops: [] };
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1, rotation: 0, label: 'Display' };
  const electron = { screen: Object.assign(new EventEmitter(), { getAllDisplays: () => [display] }), powerMonitor: new EventEmitter(),
    systemPreferences: { getMediaAccessStatus: () => 'granted', isTrustedAccessibilityClient: () => true }, shell: {} };
  const addon = { screenSession: () => ({ available: true, onConsole: true, locked: false, unique: '00000000-0000-0000-0000-000000000001' }), screenDisplayUuid: () => 'display',
    screenMouse() {}, screenReleaseAll: () => 0, screenMonitorStop() {}, screenMonitorPoll: () => ({ alive: false, foreign: 0, interrupted: 0 }) };
  const service = new ScreenService({ electron, addon, stateDir, platform: 'darwin', WebSocketClass: ws.FakeSocket, isUpdating: () => updating(), ...(attachTimeoutMs ? { attachTimeoutMs } : {}),
    hostControl: { ticket: async () => ({ ticket: 'T'.repeat(43), instancePort: 1234 }) },
    captureHost: callbacks => (hooks = callbacks, { start: async s => { capture.starts.push(s.sessionId); return startCapture?.(s); }, stop: id => capture.stops.push(id),
      reset() {}, pause() {}, credit() {}, keyframe() {}, close() {} }) });
  t.after(() => service.dispose());
  await service.start(); await tick();
  const [control] = ws.find('/screen/v1/target');
  control.open(); control.receive({ type: 'registered', epoch: 'desktop_epoch', serverTime: Date.now() });
  const session = { id: 'screen_1', desktopId: service.desktopId, deviceId: 'viewer', deviceName: 'Viewer', generation: 'generation_1',
    display: service.status().desktop.displays[0], controlAllowed: true, state: 'connecting', createdAt: Date.now() };
  control.receive({ type: 'start', session, mediaTicket: 'M'.repeat(43), streamGeneration: 1, codecs: ['h264'] });
  const [media] = ws.find('/screen/v1/target-media');
  return { service, control, media, capture, session, addon, hooks: () => hooks };
}

test('a late `attached` for a session that already ended never starts capture', async t => {
  const { service, media, capture, session } = await lab(t);
  media.open();
  assert.deepEqual(media.sent[0], { type: 'hello', ticket: 'M'.repeat(43) });
  service.stop(session.id);
  media.receive({ type: 'attached', sessionId: session.id });
  await tick();
  assert.deepEqual(capture.starts, []);
});

test('a capture start that completes after the session ended is stopped again', async t => {
  let release;
  const { service, media, capture, session } = await lab(t, { startCapture: () => new Promise(resolve => { release = resolve; }) });
  media.open(); media.receive({ type: 'attached', sessionId: session.id }); await tick();
  assert.deepEqual(capture.starts, [session.id]);
  service.stop(session.id);
  const before = capture.stops.length;
  release(); await tick(); await tick();
  assert.ok(capture.stops.length > before, 'late completion is torn down');
});

test('media socket accepts exactly one matching `attached`; anything else closes it', async t => {
  const { media, capture, session } = await lab(t);
  media.open();
  media.receive({ type: 'attached', sessionId: 'someone_else' });
  assert.equal(media.readyState, 3);
  assert.deepEqual(capture.starts, []);
  void session;
});

test('per-session stop only releases the lease held by that session', async t => {
  const { service, session } = await lab(t);
  let released = 0;
  service.input.release = () => { released++; return true; };
  Object.defineProperty(service.input, 'lease', { get: () => ({ sessionId: 'other_session' }) });
  service.stop(session.id);
  assert.equal(released, 0);
  service.stop();
  assert.equal(released, 1);
});

test('a late `attached` after dispose never starts capture', async t => {
  const { service, media, capture, session } = await lab(t);
  media.open(); service.dispose();
  media.receive({ type: 'attached', sessionId: session.id }); await tick();
  assert.deepEqual(capture.starts, []);
});

test('an `attached` that arrives after an App update began ends the session instead of capturing', async t => {
  let installing = false;
  const { service, control, media, capture, session } = await lab(t, { updating: () => installing });
  media.open(); installing = true;
  media.receive({ type: 'attached', sessionId: session.id }); await tick();
  assert.deepEqual(capture.starts, []);
  assert.deepEqual(service.status().sessions, []);
  assert.ok(control.sent.some(m => m.type === 'stop' && m.sessionId === session.id && m.reason === 'screen_service_stopped'));
});

/** Attach, confirm one fresh frame and receive a Host lease with `poll` as the monitor. */
async function leased(t, poll) {
  const f = await lab(t);
  f.addon.screenMonitorStart = () => {}; f.addon.screenMonitorPoll = poll;
  f.media.open(); f.media.receive({ type: 'attached', sessionId: f.session.id }); await tick();
  const captureMs = Date.now();
  f.hooks().onMessage({ type: 'frame', sessionId: f.session.id, sequence: 1, streamGeneration: 1, captureMs, geometryRevision: 1, bytes: new Uint8Array([1]) });
  f.control.receive({ type: 'ack', sessionId: f.session.id, frameSequence: 1, streamGeneration: 1 });
  f.control.receive({ type: 'lease', sessionId: f.session.id, generation: f.session.generation, leaseId: 'L'.repeat(43), expiresAt: captureMs + 5000, frameSequence: 1, streamGeneration: 1 });
  return f;
}
const settled = async (control, ms = 300) => { const end = Date.now() + ms; while (Date.now() < end && !control.sent.some(m => ['lease-ready', 'lease-denied', 'stop'].includes(m.type))) await new Promise(r => setTimeout(r, 5)); };

test('local input seen while the monitor becomes ready is a takeover, not swallowed', async t => {
  let reads = 0;
  const f = await leased(t, () => ({ alive: true, failed: false, foreign: reads++ === 0 ? 1 : 0, interrupted: 0 }));
  await settled(f.control);
  assert.equal(f.control.sent.some(m => m.type === 'lease-ready'), false);
  assert.ok(f.control.sent.some(m => m.type === 'stop' && m.reason === 'screen_local_takeover'));
  assert.equal(f.service.input.lease, undefined);
});

test('a monitor gap during readiness denies the lease as takeover-unavailable', async t => {
  let reads = 0;
  const f = await leased(t, () => ({ alive: true, failed: false, foreign: 0, interrupted: reads++ === 0 ? 1 : 0 }));
  await settled(f.control);
  assert.ok(f.control.sent.some(m => m.type === 'lease-denied' && m.reason === 'screen_takeover_unavailable'));
  assert.equal(f.control.sent.some(m => m.type === 'lease-ready'), false);
});

test('input after the marker write is checked again before lease-ready', async t => {
  let reads = 0;
  const f = await leased(t, () => ({ alive: true, failed: false, foreign: reads++ === 1 ? 1 : 0, interrupted: 0 })); // ready poll clean, post-marker poll sees input
  await settled(f.control);
  assert.equal(f.control.sent.some(m => m.type === 'lease-ready'), false);
  assert.ok(f.control.sent.some(m => m.type === 'stop' && m.reason === 'screen_local_takeover'));
});

test('a superseded readiness wait stops polling and cannot consume a newer monitor count', async t => {
  let reads = 0;
  const f = await leased(t, () => { reads++; return { alive: false, failed: false, foreign: 0, interrupted: 0 }; });
  await new Promise(r => setTimeout(r, 30));
  f.control.receive({ type: 'release', sessionId: f.session.id, reason: 'screen_control_stopped' });
  const after = reads;
  await new Promise(r => setTimeout(r, 120));
  assert.ok(reads - after <= 1, `old waiter kept polling: ${reads - after} more reads`);
  assert.equal(f.control.sent.some(m => m.type === 'lease-ready'), false);
});

test('a clean, live monitor yields exactly one lease-ready', async t => {
  const f = await leased(t, () => ({ alive: true, failed: false, foreign: 0, interrupted: 0 }));
  await settled(f.control);
  assert.deepEqual(f.control.sent.filter(m => m.type === 'lease-ready').map(m => m.leaseId), ['L'.repeat(43)], JSON.stringify(f.control.sent.filter(m => m.type !== 'status')));
});

test('an unanswered target registration is dropped after its deadline and retried', async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'screen-register-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const ws = sockets();
  const service = new ScreenService({ platform: 'darwin', stateDir, WebSocketClass: ws.FakeSocket, registerTimeoutMs: 40,
    electron: { screen: Object.assign(new EventEmitter(), { getAllDisplays: () => [] }), powerMonitor: new EventEmitter(), shell: {}, systemPreferences: { getMediaAccessStatus: () => 'granted', isTrustedAccessibilityClient: () => true } },
    addon: { screenMouse() {}, screenSession: () => ({ available: true, onConsole: true, locked: false, unique: '00000000-0000-0000-0000-000000000001' }), screenDisplayUuid: () => null, screenReleaseAll: () => 0, screenMonitorStop() {} },
    hostControl: { ticket: async () => ({ ticket: 'T'.repeat(43), instancePort: 1 }) }, captureHost: () => ({ close() {} }) });
  t.after(() => service.dispose());
  await service.start();
  for (let i = 0; i < 200 && !ws.all.length; i++) await new Promise(r => setTimeout(r, 5));
  ws.all[0].open();
  await new Promise(r => setTimeout(r, 80));
  assert.equal(ws.all[0].readyState, 3, 'the silent socket is terminated at the deadline');
  for (let i = 0; i < 300 && ws.all.length < 2; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(ws.all.length, 2, 'a new registration attempt follows');
  ws.all[1].open(); ws.all[1].receive({ type: 'registered', epoch: 'e', serverTime: Date.now() });
  await new Promise(r => setTimeout(r, 80));
  assert.equal(service.status().registered, true);
  assert.equal(ws.all[1].readyState, 1, 'a registered socket is not dropped by the old deadline');
});

test('a media socket the Host never attaches ends that session without starting capture', async t => {
  const { media, capture, service } = await lab(t, { attachTimeoutMs: 40 });
  media.open();
  await new Promise(r => setTimeout(r, 80));
  assert.equal(media.readyState, 3);
  assert.deepEqual(capture.starts, []);
  assert.deepEqual(service.status().sessions, []);
});

// ---------------- readiness: startup, registration, retry, permissions ----------------
const waitFor = async (predicate, ms = 1000) => { const end = Date.now() + ms; while (Date.now() < end && !predicate()) await new Promise(r => setTimeout(r, 5)); return predicate(); };
/** A service that has not registered yet; the test scripts tickets and sockets. */
async function bare(t, { ticket = async () => ({ ticket: 'T'.repeat(43), instancePort: 1234 }), stateDir, systemPreferences = {}, addon = {}, shell = {}, ...options } = {}) {
  const directory = stateDir ?? await mkdtemp(path.join(os.tmpdir(), 'screen-ready-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ws = sockets(), calls = { tickets: 0, prompts: [], opened: [] };
  const electron = { screen: Object.assign(new EventEmitter(), { getAllDisplays: () => [] }), powerMonitor: new EventEmitter(),
    shell: { openExternal: async url => { calls.opened.push(url); }, ...shell },
    systemPreferences: { getMediaAccessStatus: () => 'granted', isTrustedAccessibilityClient: prompt => { if (prompt) calls.prompts.push('accessibility'); return true; }, ...systemPreferences } };
  const native = { screenMouse() {}, screenSession: () => ({ available: true, onConsole: true, locked: false, unique: '00000000-0000-0000-0000-000000000001' }), screenDisplayUuid: () => null,
    screenReleaseAll: () => 0, screenMonitorStop() {},
    screenCaptureAccess: request => { if (request) calls.prompts.push('capture'); return false; },
    screenMonitorAccess: request => { if (request) calls.prompts.push('input-monitoring'); return false; }, ...addon };
  const service = new ScreenService({ platform: 'darwin', stateDir: directory, WebSocketClass: ws.FakeSocket, electron, addon: native,
    hostControl: { ticket: async id => { calls.tickets++; return ticket(id); } }, captureHost: () => ({ close() {} }), retryBaseMs: 20, ...options });
  t.after(() => service.dispose());
  return { service, ws, calls, stateDir: directory };
}

test('a startup failure is reported instead of swallowed, and an explicit retry starts again', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'screen-start-')); t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  await writeFile(stateDir, 'not a directory'); // screen-desktop.json cannot be read or written
  const { service, ws, calls } = await bare(t, { stateDir });
  await service.start(); // never rejects: main.mjs must not have to swallow it
  assert.equal(service.status().phase, 'failed');
  assert.equal(service.status().error, 'screen_service_start_failed');
  assert.equal(calls.tickets, 0);
  await rm(stateDir); await mkdir(stateDir);
  const status = await service.retry();
  assert.equal(typeof service.desktopId, 'string');
  assert.ok(['connecting', 'registered'].includes(status.phase), status.phase);
  assert.ok(await waitFor(() => ws.all.length === 1));
  ws.all[0].open(); ws.all[0].receive({ type: 'registered', epoch: 'e', serverTime: Date.now() });
  assert.equal(service.status().phase, 'registered');
  assert.equal(service.status().error, undefined);
});

test('a ticket failure keeps its bounded code, never a raw OS message or path', async t => {
  const { service } = await bare(t, { ticket: async () => { throw new Error("EACCES: permission denied, connect '/Users/someone/Library/x.sock'"); } });
  await service.start();
  assert.ok(await waitFor(() => service.status().error));
  assert.equal(service.status().error, 'screen_host_unavailable');
  assert.equal(service.status().phase, 'retrying');
  assert.equal(typeof service.status().retryAt, 'number');
});

test('a classified ticket failure is reported as is', async t => {
  const { service } = await bare(t, { ticket: async () => { throw new Error('screen_host_directory_conflict'); } });
  await service.start();
  assert.ok(await waitFor(() => service.status().error));
  assert.equal(service.status().error, 'screen_host_directory_conflict');
});

test('a registration the Host refuses records the Host reason', async t => {
  const { service, ws } = await bare(t, { retryBaseMs: 10000 });
  await service.start();
  assert.ok(await waitFor(() => ws.all.length === 1));
  ws.all[0].open();
  assert.equal(ws.all[0].sent[0].type, 'hello');
  ws.all[0].close(4000, 'screen_desktop_busy');
  assert.equal(service.status().error, 'screen_desktop_busy');
  assert.equal(service.status().phase, 'retrying');
  assert.equal(service.status().registered, false);
});

test('an unrecognised refusal, a failed connection and a silent Host each get their own code', async t => {
  const { service, ws } = await bare(t, { registerTimeoutMs: 30 });
  await service.start();
  assert.ok(await waitFor(() => ws.all.length === 1));
  ws.all[0].open(); ws.all[0].close(4000, 'Some Free Text');
  assert.equal(service.status().error, 'screen_registration_rejected');
  assert.ok(await waitFor(() => ws.all.length === 2));
  ws.all[1].emit('error', new Error('connect ECONNREFUSED 127.0.0.1:1234')); ws.all[1].close(1006);
  assert.equal(service.status().error, 'screen_host_connect_failed');
  assert.ok(await waitFor(() => ws.all.length === 3, 2000));
  ws.all[2].open();
  assert.ok(await waitFor(() => ws.all[2].readyState === 3));
  assert.equal(service.status().error, 'screen_registration_timeout');
  assert.ok(await waitFor(() => ws.all.length === 4, 2000));
  ws.all[3].open(); ws.all[3].receive({ type: 'nonsense' });
  assert.equal(service.status().error, 'screen_registration_invalid');
});

test('losing a registered Host is reported and reconnects promptly', async t => {
  const { service, ws } = await bare(t);
  await service.start();
  assert.ok(await waitFor(() => ws.all.length === 1));
  ws.all[0].open(); ws.all[0].receive({ type: 'registered', epoch: 'e1', serverTime: Date.now() });
  ws.all[0].close(1001);
  assert.equal(service.status().error, 'screen_host_disconnected');
  assert.equal(service.status().registered, false);
  assert.ok(await waitFor(() => ws.all.length === 2));
  ws.all[1].open(); ws.all[1].receive({ type: 'registered', epoch: 'e2', serverTime: Date.now() });
  assert.equal(service.status().registered, true);
  assert.equal(service.status().error, undefined);
});

test('retry skips the backoff once and never runs two attempts at the same time', async t => {
  let release;
  const pending = [];
  const { service, ws, calls } = await bare(t, { retryBaseMs: 60000,
    ticket: () => { if (calls.tickets === 1) return Promise.reject(new Error('screen_host_unavailable')); return new Promise(resolve => { release = resolve; pending.push(resolve); }); } });
  await service.start();
  assert.ok(await waitFor(() => service.status().phase === 'retrying'));
  assert.equal(calls.tickets, 1);
  await service.retry();
  assert.equal(calls.tickets, 2, 'retry connects now instead of waiting a minute');
  assert.equal(service.status().phase, 'connecting');
  await service.retry(); await service.retry();
  assert.equal(calls.tickets, 2, 'an attempt in flight is not duplicated');
  release({ ticket: 'T'.repeat(43), instancePort: 1234 });
  assert.ok(await waitFor(() => ws.all.length === 1));
  await service.retry();
  assert.equal(calls.tickets, 2); assert.equal(ws.all.length, 1);
  ws.all[0].open(); ws.all[0].receive({ type: 'registered', epoch: 'e', serverTime: Date.now() });
  await service.retry();
  assert.equal(calls.tickets, 2, 'a registered service is left alone');
  assert.equal(pending.length, 1);
});

test('a socket that cannot even be constructed is retried rather than ending the retry chain', async t => {
  let constructed = 0;
  const ws = sockets();
  class Throwing extends ws.FakeSocket { constructor(url, options) { if (constructed++ === 0) throw new Error('invalid url'); super(url, options); } }
  const { service } = await bare(t, { WebSocketClass: Throwing });
  await service.start();
  assert.ok(await waitFor(() => ws.all.length === 1, 2000), 'a later attempt follows the failure');
  assert.equal(service.status().error, 'screen_host_connect_failed');
});

test('a capture permission click requests access even though Electron never reports not-determined', async t => {
  // Electron 45 / Chromium 156: getMediaAccessStatus('screen') is
  // CGPreflightScreenCaptureAccess() ? 'granted' : 'denied'.
  const { service, calls } = await bare(t, { systemPreferences: { getMediaAccessStatus: () => 'denied' } });
  await service.start();
  const result = await service.permission('capture');
  assert.deepEqual(calls.prompts, ['capture']);
  assert.deepEqual(calls.opened, ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture']);
  assert.equal(result.requested, true); assert.equal(result.opened, true);
  assert.equal(result.permissions.capture, 'denied');
});

test('each Set-permission button requests only its own ungranted permission and always opens its own pane', async t => {
  let trusted = false, listening = false;
  const { service, calls } = await bare(t, {
    systemPreferences: { getMediaAccessStatus: () => 'granted', isTrustedAccessibilityClient: prompt => { if (prompt) calls.prompts.push('accessibility'); return trusted; } },
    addon: { screenMonitorAccess: request => { if (request) calls.prompts.push('input-monitoring'); return listening; } } });
  await service.start();
  const pane = name => `x-apple.systempreferences:com.apple.preference.security?${name}`;
  // Already granted: no request, but the pane still opens (the owner asked to see it).
  const capture = await service.permission('capture');
  assert.deepEqual([capture.requested, capture.opened, capture.requestError, calls.prompts.length], [false, true, undefined, 0]);
  assert.deepEqual(calls.opened, [pane('Privacy_ScreenCapture')]);
  const accessibility = await service.permission('accessibility');
  assert.deepEqual(calls.prompts, ['accessibility']);
  assert.deepEqual([accessibility.requested, accessibility.opened], [true, true]);
  const monitor = await service.permission('input-monitoring');
  assert.deepEqual(calls.prompts, ['accessibility', 'input-monitoring']);
  assert.deepEqual([monitor.requested, monitor.opened], [true, true]);
  assert.deepEqual(calls.opened, [pane('Privacy_ScreenCapture'), pane('Privacy_Accessibility'), pane('Privacy_ListenEvent')]);
  trusted = true; listening = true;
  const after = await service.permission('accessibility');
  assert.deepEqual([after.requested, after.opened, after.permissions.accessibility, after.permissions.inputMonitoring], [false, true, true, true]);
  assert.equal(calls.prompts.length, 2, 'a granted permission is never requested again');
  assert.equal(calls.opened.at(-1), pane('Privacy_Accessibility'));
  await assert.rejects(service.permission('camera'), /screen_permission_invalid/);
  assert.equal(calls.opened.length, 4, 'an invalid kind opens nothing');
});

test('a failed permission request still opens the pane and is returned as requestError', async t => {
  const { service, calls } = await bare(t, { systemPreferences: { getMediaAccessStatus: () => 'denied' },
    addon: { screenCaptureAccess: request => { if (request) throw new Error('CGRequestScreenCaptureAccess unavailable'); return false; } } });
  await service.start();
  const result = await service.permission('capture');
  assert.deepEqual([result.requested, result.opened, result.requestError], [true, true, 'screen_permission_request_failed']);
  assert.deepEqual(calls.opened, ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture']);
});

test('a System Settings pane that cannot be opened throws a stable code', async t => {
  const { service, calls } = await bare(t, { systemPreferences: { getMediaAccessStatus: () => 'denied' }, shell: { openExternal: async () => { throw new Error('no handler for /some/path'); } } });
  await service.start();
  await assert.rejects(service.permission('capture'), error => error.message === 'screen_permission_settings_failed');
  assert.deepEqual(calls.prompts, ['capture'], 'the ungranted permission was still requested first');
  const granted = await bare(t, { shell: { openExternal: async () => { throw new Error('no handler'); } } });
  await granted.service.start();
  await assert.rejects(granted.service.permission('capture'), /^Error: screen_permission_settings_failed$/);
});

test('no registration starts while an App update is installing; it resumes afterwards', async t => {
  let installing = true;
  const { service, ws, calls } = await bare(t, { isUpdating: () => installing });
  await service.start();
  await service.retry();
  await new Promise(r => setTimeout(r, 60));
  assert.equal(calls.tickets, 0, 'no ticket and no registration during the install');
  assert.equal(ws.all.length, 0);
  assert.equal(service.status().error, 'screen_service_updating');
  assert.equal(service.status().phase, 'retrying');
  installing = false;
  await service.retry();
  assert.ok(await waitFor(() => ws.all.length === 1));
  assert.equal(calls.tickets, 1);
});

test('startup, status, registration and health ticks never ask macOS for a permission', async t => {
  const { service, ws, calls } = await bare(t, { systemPreferences: { getMediaAccessStatus: () => 'denied', isTrustedAccessibilityClient: prompt => { if (prompt) calls.prompts.push('accessibility'); return false; } } });
  await service.start();
  assert.ok(await waitFor(() => ws.all.length === 1));
  ws.all[0].open(); ws.all[0].receive({ type: 'registered', epoch: 'e', serverTime: Date.now() });
  const status = service.status();
  await new Promise(r => setTimeout(r, 1100)); // at least one health tick
  assert.deepEqual(calls.prompts, []); assert.deepEqual(calls.opened, []);
  assert.deepEqual(status.permissions, { capture: 'denied', accessibility: false, inputMonitoring: false });
  assert.equal(ws.all[0].sent[0].desktop.capture, 'denied');
});

test('viewing needs only screen recording: a session starts without Accessibility or Input Monitoring', async t => {
  const starts = [];
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1, rotation: 0, label: 'Display' };
  const { service, ws } = await bare(t, {
    systemPreferences: { getMediaAccessStatus: () => 'granted', isTrustedAccessibilityClient: () => false },
    captureHost: () => ({ start: async s => { starts.push(s.sessionId); }, stop() {}, reset() {}, pause() {}, credit() {}, keyframe() {}, close() {} }) });
  service.electron.screen.getAllDisplays = () => [display];
  await service.start();
  assert.ok(await waitFor(() => ws.all.length === 1));
  const control = ws.all[0];
  control.open(); control.receive({ type: 'registered', epoch: 'e', serverTime: Date.now() });
  const session = { id: 'screen_view', desktopId: service.desktopId, deviceId: 'viewer', deviceName: 'Viewer', generation: 'generation_1',
    display: service.status().desktop.displays[0], controlAllowed: false, state: 'connecting', createdAt: Date.now() };
  control.receive({ type: 'start', session, mediaTicket: 'M'.repeat(43), streamGeneration: 1, codecs: ['h264'] });
  const [media] = ws.find('/screen/v1/target-media');
  media.open(); media.receive({ type: 'attached', sessionId: session.id }); await tick();
  assert.deepEqual(starts, [session.id]);
  assert.equal(control.sent.some(m => m.type === 'stop'), false);
});

test('retry while the first start is still reading the desktop identity waits for it (no ticket without a desktop id)', async t => {
  const ids = [];
  const { service } = await bare(t, { ticket: id => { ids.push(id); return new Promise(() => {}); } });
  const starting = service.start();
  const status = await service.retry();
  await starting;
  assert.ok(await waitFor(() => ids.length > 0));
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(ids, [service.desktopId], 'exactly one attempt, bound to the persisted desktop id');
  assert.match(String(service.desktopId), /^desktop-/);
  assert.equal(status.phase, 'connecting');
});

test('an install that begins while the ticket is pending creates no socket and backs off recoverably', async t => {
  let installing = false, release;
  const { service, ws, calls } = await bare(t, { isUpdating: () => installing,
    ticket: () => calls.tickets === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ ticket: 'T'.repeat(43), instancePort: 1234 }) });
  await service.start();
  assert.ok(await waitFor(() => release));
  installing = true;
  release({ ticket: 'T'.repeat(43), instancePort: 1234 });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(ws.all.length, 0, 'no target socket after the install began');
  assert.equal(service.status().error, 'screen_service_updating');
  assert.equal(service.status().phase, 'retrying');
  installing = false;
  await service.retry();
  assert.ok(await waitFor(() => ws.all.length === 1));
  ws.all[0].open();
  assert.equal(ws.all[0].sent[0].type, 'hello');
});

test('an install that begins before the socket opens sends no hello and backs off recoverably', async t => {
  let installing = false;
  const { service, ws } = await bare(t, { isUpdating: () => installing });
  await service.start();
  assert.ok(await waitFor(() => ws.all.length === 1));
  installing = true;
  ws.all[0].open();
  assert.deepEqual(ws.all[0].sent, [], 'no hello during the install');
  assert.equal(ws.all[0].readyState, 3);
  assert.equal(service.status().error, 'screen_service_updating');
  assert.equal(service.status().phase, 'retrying');
  installing = false;
  await service.retry();
  assert.ok(await waitFor(() => ws.all.length === 2));
  ws.all[1].open(); ws.all[1].receive({ type: 'registered', epoch: 'e', serverTime: Date.now() });
  assert.equal(service.status().registered, true);
});
