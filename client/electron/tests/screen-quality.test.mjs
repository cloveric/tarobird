// Quality profiles on the target: real capture constraints, encoder size,
// frame rate and quantizer/bitrate; hello negotiation with old/new Hosts.
// Fakes only: no screen is captured and no input is posted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCaptureCore, CAPTURE_CREDITS, OUTPUT_MAX_AGE_MS, PACE_BURST_BYTES, PACE_BYTES_PER_MS } from '../screen-capture-core.mjs';
import { ScreenCaptureHost } from '../screen-capture-host.mjs';
import { ScreenService } from '../screen-service.mjs';
import { encodeSize, SCREEN_ENCODE_AREA, SCREEN_ENCODE_LONG_EDGE } from '../screen-geometry.mjs';
import { writeScreenFrame } from '../../../src/client-protocol/screen-wire.ts';
import { SCREEN_QUALITY_PROFILES, screenH264Codec, screenQualityProfile } from '../../../src/client-protocol/screen-quality.ts';
import { screenServiceCommandSchema, screenServiceHelloSchema, screenStreamSchema } from '../../../src/client-protocol/remote-screen.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));

// ---------------- capture core ----------------
function browser({ supported = ['quantizer', 'variable'], codecs = ['avc1.640028', 'avc1.640033', 'vp8'], chunkBytes = 3 } = {}) {
  const sent = [], encoders = [], requests = [], probes = [], pending = [];
  let pushFrame, perf = 0, clock = 1_800_000_000_000;
  class Encoder {
    static async isConfigSupported(config) { probes.push(config); return { supported: supported.includes(config.bitrateMode) && codecs.includes(config.codec) }; }
    constructor({ output }) { this.output = output; this.state = 'unconfigured'; this.encodeQueueSize = 0; this.encodes = []; this.timestamps = []; this.emitted = 0; encoders.push(this); }
    configure(config) { this.config = config; this.state = 'configured'; }
    encode(frame, options) { this.encodes.push(options); this.timestamps.push(frame.timestamp); }
    close() { this.state = 'closed'; }
    emit(type = 'delta', bytes = chunkBytes) { this.output({ type, timestamp: this.timestamps[this.emitted++], byteLength: bytes, copyTo: target => target.fill(1) }); }
    drop() { this.emitted++; }
  }
  const track = { stopped: false, stop() { this.stopped = true; }, getSettings: () => ({ cursor: 'always' }), addEventListener() {} };
  class Processor { constructor() { this.readable = { getReader: () => ({ read: () => new Promise(resolve => { pushFrame = value => resolve({ value, done: false }); }), cancel() {} }) }; } }
  let interval;
  const core = createCaptureCore({ send: m => sent.push(Object.assign(m, { at: perf })), getDisplayMedia: async constraints => { requests.push(constraints); return { getVideoTracks: () => [track], getTracks: () => [track] }; },
    VideoEncoder: Encoder, VideoFrame: class { constructor(_source, init) { this.timestamp = init?.timestamp; } close() {} }, OffscreenCanvas: class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return { drawImage() {} }; } },
    MediaStreamTrackProcessor: Processor, writeScreenFrame, now: () => clock, perf: () => perf,
    timers: { setTimeout: (fn, ms) => { const t = { fn, at: perf + ms }; pending.push(t); return t; }, clearTimeout: t => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); },
      setInterval: fn => { interval = fn; return 1; }, clearInterval() {} } });
  /** Runs due pacing timers (fake clock). */
  const run = () => { for (let t; (t = pending.find(x => x.at <= perf));) { pending.splice(pending.indexOf(t), 1); t.fn(); } };
  let id = 0;
  const frame = (width, height) => ({ id: ++id, displayWidth: width, displayHeight: height, timestamp: id, closed: false, close() { this.closed = true; } });
  return { core, sent, encoders, requests, probes, track, pending, run, push: f => { const p = pushFrame; pushFrame = undefined; p?.(f); }, frame,
    advance: ms => { perf += ms; clock += ms; }, adapt: () => interval?.() };
}
const startMessage = (quality, extra = {}) => {
  const profile = quality && screenQualityProfile(quality);
  const display = { width: 1440, height: 900, scale: 2 };
  const encode = encodeSize(display, profile ?? undefined);
  return { type: 'start', sessionId: 's1', streamGeneration: 1, geometryRevision: 1, codecs: ['h264'], encode,
    ...(profile ? { fps: profile.fps, profile: { qpBase: profile.qpBase, qpMax: profile.qpMax, bitrate: profile.bitrate, h264Only: profile.h264Only } } : { fps: 15 }), ...extra };
};

test('core: each quality sets the real capture constraints, encoder size/rate and quantizer; omitted = legacy balanced', async () => {
  // 1440×900 points @2x: balanced/legacy = 1818×1136 (H.264 level 4.0), sharp = native 2880×1800 (level 5.1).
  const expected = { smooth: [1280, 800, 32, 42, 'avc1.640028'], balanced: [1818, 1136, 28, 40, 'avc1.640028'], sharp: [2880, 1800, 28, 40, 'avc1.640033'], legacy: [1818, 1136, 28, 40, 'avc1.640028'] };
  for (const [quality, [width, height, qpBase, qpMax, codecString]] of Object.entries(expected)) {
    const b = browser(); await b.core.handle(startMessage(quality === 'legacy' ? undefined : quality)); await tick();
    assert.deepEqual(b.requests[0].video, { cursor: 'always', frameRate: { max: 15 }, width: { max: width }, height: { max: height } }, `${quality}: capture constraints`);
    assert.deepEqual([b.encoders[0].config.width, b.encoders[0].config.height, b.encoders[0].config.framerate, b.encoders[0].config.bitrateMode], [width, height, 15, 'quantizer']);
    const stream = b.sent.find(m => m.type === 'stream').stream;
    assert.deepEqual([stream.width, stream.height, stream.codecString, b.encoders[0].config.codec], [width, height, codecString, codecString]);
    assert.doesNotThrow(() => screenStreamSchema.parse(stream), `${quality}: stream fits the shared schema`);
    if (quality !== 'sharp') assert.ok(width <= 1920 && height <= 1920 && width * height <= 1920 * 1080, `${quality}: inside the pre-quality (old-viewer) contract`);
    b.push(b.frame(width, height)); await tick();
    assert.deepEqual(b.encoders[0].encodes[0], { keyFrame: true, avc: { quantizer: qpBase } }, `${quality}: resting quantizer`);
    // Congestion raises the quantizer only up to this profile's ceiling, and calm lowers it only to its base.
    const session = b.core.sessions.get('s1');
    for (let i = 0; i < 10; i++) { session.crowded = 3; b.adapt(); }
    assert.equal(session.qp, qpMax, `${quality}: congestion ceiling`);
    for (let i = 0; i < 60; i++) b.adapt();
    assert.equal(session.qp, qpBase, `${quality}: calm floor`);
  }
});

test('core: a variable-bitrate-only encoder gets the profile bitrate (legacy 2.5 Mbps unchanged)', async () => {
  for (const [quality, bitrate] of [['smooth', 1_200_000], ['balanced', 2_500_000], ['sharp', 3_200_000], [undefined, 2_500_000]]) {
    const b = browser({ supported: ['variable'] }); await b.core.handle(startMessage(quality)); await tick();
    assert.deepEqual([b.encoders[0].config.bitrateMode, b.encoders[0].config.bitrate], ['variable', bitrate], String(quality));
    b.push(b.frame(1818, 1136)); await tick();
    assert.deepEqual(b.encoders[0].encodes[0], { keyFrame: true }, 'no quantizer option in bitrate mode');
  }
});

test('core: out-of-range profile values from main are clamped, never trusted as-is', async () => {
  const b = browser();
  await b.core.handle(startMessage('sharp', { fps: 120, profile: { qpBase: -5, qpMax: 99, bitrate: 1e12 } })); await tick();
  assert.equal(b.requests[0].video.frameRate.max, 15);
  assert.equal(b.encoders[0].config.framerate, 15);
  const session = b.core.sessions.get('s1');
  assert.deepEqual([session.profile.qpBase, session.profile.qpMax, session.profile.bitrate, session.interval], [10, 51, 4_000_000, 1000 / 15]);
  const c = browser(); await c.core.handle(startMessage('sharp', { profile: { qpBase: 40, qpMax: 20 } })); await tick();
  assert.deepEqual([c.core.sessions.get('s1').profile.qpBase, c.core.sessions.get('s1').profile.qpMax], [40, 40], 'ceiling never below base');
});

test('core: a quality session keeps every generation rule (reset retires the old chain, new chain starts with a key)', async () => {
  const b = browser(); await b.core.handle(startMessage('smooth')); await tick();
  b.push(b.frame(1280, 800)); await tick();
  await b.core.handle({ type: 'reset', sessionId: 's1', streamGeneration: 2, geometryRevision: 1 });
  b.encoders[0].emit('key');
  assert.equal(b.sent.filter(m => m.type === 'frame').length, 0, 'late output of the retired encoder is discarded');
  b.advance(100); b.push(b.frame(1280, 800)); await tick();
  assert.deepEqual(b.encoders[1].encodes[0], { keyFrame: true, avc: { quantizer: 32 } });
  assert.deepEqual([b.encoders[1].config.width, b.encoders[1].config.height], [1280, 800], 'the reset keeps the session quality');
  assert.equal(b.probes.length, 1, 'the codec choice is made once per session, not re-probed per generation');
  await b.core.handle({ type: 'stop', sessionId: 's1' });
  assert.equal(b.core.sessions.size, 0); assert.equal(b.track.stopped, true);
});

// ---------------- geometry ----------------
test('encodeSize: every profile fits its caps and H.264 level, keeps the Hub aspect tolerance, never upscales; balanced = legacy unless legacy broke level 4.0', () => {
  const displays = [[1440, 900, 2], [1512, 982, 2], [1728, 1117, 2], [1920, 1080, 1], [2560, 1440, 2], [3440, 1440, 1], [5120, 1440, 1], [1280, 720, 1], [800, 600, 1], [1080, 1920, 1], [1366, 768, 1], [2048, 1152, 2.5]];
  const legacy = d => { const w = d.width * d.scale, h = d.height * d.scale; const f = Math.min(1, 1920 / Math.max(w, h), Math.sqrt(1920 * 1080 / (w * h))); const even = v => Math.max(2, Math.floor(v * f / 2) * 2); return { width: even(w), height: even(h) }; };
  for (const [width, height, scale] of displays) {
    const display = { width, height, scale };
    const old = legacy(display), blocks = s => Math.ceil(s.width / 16) * Math.ceil(s.height / 16);
    assert.deepEqual(encodeSize(display), encodeSize(display, SCREEN_QUALITY_PROFILES.balanced));
    if (blocks(old) <= 8192) assert.deepEqual(encodeSize(display), old, `${width}x${height}@${scale}: unchanged where the legacy size was valid`);
    else assert.ok(blocks(encodeSize(display)) <= 8192 && encodeSize(display).width * encodeSize(display).height >= 0.97 * old.width * old.height, 'minimal shrink to level 4.0');
    for (const [quality, profile] of Object.entries(SCREEN_QUALITY_PROFILES)) {
      const size = encodeSize(display, profile);
      assert.ok(size.width % 2 === 0 && size.height % 2 === 0, `${quality} even`);
      assert.ok(Math.max(size.width, size.height) <= profile.longEdge, `${quality} long edge`);
      assert.ok(size.width * size.height <= profile.area, `${quality} area`);
      assert.ok(Math.ceil(size.width / 16) * Math.ceil(size.height / 16) <= profile.macroblocks, `${quality} macroblocks`);
      if (!profile.h264Only) assert.ok(Math.max(size.width, size.height) <= SCREEN_ENCODE_LONG_EDGE && size.width * size.height <= SCREEN_ENCODE_AREA, `${quality} pre-quality contract`);
      assert.ok(size.width <= width * scale && size.height <= height * scale, `${quality} never upscales`);
      assert.ok(Math.abs(size.width / size.height - width / height) <= 0.02, `${quality} ${width}x${height}: Hub aspect check`);
      const codecString = screenH264Codec(size.width, size.height);
      assert.equal(codecString, profile.h264Only && Math.ceil(size.width / 16) * Math.ceil(size.height / 16) > 8192 ? 'avc1.640033' : 'avc1.640028');
      assert.doesNotThrow(() => screenStreamSchema.parse({ type: 'stream', streamGeneration: 1, geometryRevision: 1, codec: 'h264', codecString, width: size.width, height: size.height, contentRect: { x: 0, y: 0, ...size } }));
    }
    const smooth = encodeSize(display, SCREEN_QUALITY_PROFILES.smooth), balanced = encodeSize(display, SCREEN_QUALITY_PROFILES.balanced);
    assert.ok(smooth.width * smooth.height <= balanced.width * balanced.height, 'smooth never encodes more pixels than balanced');
    const sharp = encodeSize(display, SCREEN_QUALITY_PROFILES.sharp);
    assert.ok(sharp.width * sharp.height >= balanced.width * balanced.height, 'sharp never encodes fewer pixels than balanced');
  }
  // The measured regression: 16:10 Retina used to produce 1820×1138 = 8208 blocks (encoder refused avc1.640028).
  assert.deepEqual(legacy({ width: 1440, height: 900, scale: 2 }), { width: 1820, height: 1138 });
  assert.deepEqual(encodeSize({ width: 1440, height: 900, scale: 2 }), { width: 1818, height: 1136 });
});

test('core: a sharp (H.264-only) size is never re-encoded as VP8; balanced keeps its VP8 fallback', async () => {
  const sharp = browser({ codecs: ['vp8'] });
  await sharp.core.handle(startMessage('sharp', { codecs: ['h264', 'vp8'] })); await tick();
  assert.equal(sharp.encoders.length, 0);
  assert.deepEqual(sharp.sent.filter(m => m.type === 'ended').map(m => m.reason), ['screen_capture_failed']);
  assert.equal(sharp.sent.some(m => m.type === 'stream'), false);
  assert.equal(sharp.track.stopped, true, 'the failed sharp start leaves no capture');
  const balanced = browser({ codecs: ['vp8'] });
  await balanced.core.handle(startMessage('balanced', { codecs: ['h264', 'vp8'] })); await tick();
  assert.equal(balanced.sent.find(m => m.type === 'stream').stream.codec, 'vp8');
});

test('core pacer: a busy picture waits for byte budget and coarsens the quantizer; nothing encoded is dropped', async () => {
  const b = browser({ chunkBytes: 200_000 }); await b.core.handle(startMessage('balanced')); await tick();
  const session = b.core.sessions.get('s1');
  let encodes = 0;
  const step = async () => {
    b.advance(67); b.push(b.frame(1818, 1136)); await tick(); b.run();
    const encoder = b.encoders.at(-1);
    while (encoder.encodes.length > encodes) { encodes++; encoder.emit(encodes === 1 ? 'key' : 'delta'); await b.core.handle({ type: 'credit', sessionId: 's1', frameSequence: encodes, streamGeneration: 1 }); }
  };
  for (let i = 0; i < 150; i++) { await step(); if (i % 15 === 14) b.adapt(); } // 10 s at 15 fps of 200 kB frames = 24 Mbps offered
  const frames = b.sent.filter(m => m.type === 'frame'), bytes = frames.reduce((n, m) => n + m.bytes.byteLength, 0);
  assert.equal(frames.length, encodes, 'every encoded frame was sent');
  assert.ok(bytes <= PACE_BURST_BYTES + 150 * 67 * PACE_BYTES_PER_MS + 200_032, `sent ${bytes} bytes stays within the pacing budget`);
  assert.ok(bytes / (150 * 67) < 500, 'average below the Hub per-source refill (500 B/ms)');
  assert.ok(frames.length < 60 && frames.length > 10, `frame rate degraded (${frames.length} of 150), not stalled`);
  assert.equal(session.qp, 40, 'quantizer rose to the profile ceiling under byte pressure');
  // Calm again: small frames, and the quantizer returns to its base.
  for (const encoder of b.encoders) encoder.emit = function (type = 'delta') { this.output({ type, timestamp: this.timestamps[this.emitted++], byteLength: 500, copyTo: t => t.fill(1) }); };
  for (let i = 0; i < 600; i++) { await step(); if (i % 15 === 14) b.adapt(); }
  assert.equal(session.qp, 28);
});

test('core pacer: a quiet picture never waits on bytes (legacy pacing by frame interval only)', async () => {
  const b = browser(); await b.core.handle(startMessage('balanced')); await tick();
  for (let i = 1; i <= 30; i++) {
    b.advance(67); b.push(b.frame(1818, 1136)); await tick(); b.run();
    b.encoders[0].emit(i === 1 ? 'key' : 'delta');
    await b.core.handle({ type: 'credit', sessionId: 's1', frameSequence: i, streamGeneration: 1 });
  }
  assert.equal(b.sent.filter(m => m.type === 'frame').length, 30);
  assert.equal(b.core.sessions.get('s1').starved, 0);
});

// ---------------- capture host ----------------
function electronFake() {
  const windows = [];
  const ses = { webRequest: { onBeforeRequest() {} }, protocol: { isProtocolHandled: async () => false, handle() {}, unhandle() {} },
    setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, setDevicePermissionHandler() {}, setDisplayMediaRequestHandler() {}, on() {}, removeListener() {} };
  class Port extends EventEmitter { postMessage(data) { this.peer.emit('message', { data: structuredClone(data) }); } start() {} close() {} }
  class BrowserWindow {
    constructor() { windows.push(this); const contents = new EventEmitter();
      this.received = [];
      Object.assign(contents, { mainFrame: { processId: 7, routingId: 9 }, setWindowOpenHandler() {}, postMessage: (_c, _m, [port]) => { this.page = port; port.on('message', ({ data }) => this.received.push(data)); port.postMessage({ type: 'ready' }); } });
      this.webContents = contents; this.destroyed = false; }
    async loadURL() {} isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; }
  }
  class MessageChannelMain { constructor() { this.port1 = new Port(); this.port2 = new Port(); this.port1.peer = this.port2; this.port2.peer = this.port1; } }
  return { electron: { BrowserWindow, MessageChannelMain, session: { fromPartition: () => ses } }, windows };
}

test('host: forwards the profile to the page; a legacy start keeps the exact legacy message shape', async () => {
  for (const profile of [undefined, { qpBase: 28, qpMax: 40, bitrate: 3_200_000, h264Only: true }]) {
    const fake = electronFake();
    const host = new ScreenCaptureHost({ electron: fake.electron, root: '/x', preload: '/p.cjs', onMessage() {}, onGone() {}, resolveSource: async () => ({ id: 'src' }) });
    const started = host.start({ sessionId: 'a', display: { id: 'A', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 }, ...(profile ? { fps: 15, profile } : {}) });
    await new Promise(r => setTimeout(r, 20));
    const message = fake.windows[0].received.find(m => m.type === 'start');
    const keys = ['type', 'sessionId', 'streamGeneration', 'geometryRevision', 'codecs', 'encode', 'fps', ...(profile ? ['profile'] : [])];
    assert.deepEqual(Object.keys(message), keys);
    assert.equal(message.fps, 15);
    if (profile) assert.deepEqual(message.profile, profile);
    fake.windows[0].page.postMessage({ type: 'started', sessionId: 'a' }); await started;
    host.close();
  }
});

// ---------------- target service ----------------
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
async function target(t, { capabilities } = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'screen-quality-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const ws = sockets(), starts = [], stops = []; let hooks;
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2, rotation: 0, label: 'Display' };
  const electron = { screen: Object.assign(new EventEmitter(), { getAllDisplays: () => [display] }), powerMonitor: new EventEmitter(),
    systemPreferences: { getMediaAccessStatus: () => 'granted', isTrustedAccessibilityClient: () => true }, shell: {} };
  const addon = { screenSession: () => ({ available: true, onConsole: true, locked: false, unique: '00000000-0000-0000-0000-000000000001' }), screenDisplayUuid: () => 'display',
    screenMouse() {}, screenReleaseAll: () => 0, screenMonitorStop() {}, screenMonitorPoll: () => ({ alive: false, foreign: 0, interrupted: 0 }) };
  const service = new ScreenService({ electron, addon, stateDir, platform: 'darwin', WebSocketClass: ws.FakeSocket,
    hostControl: { ticket: async () => ({ ticket: 'T'.repeat(43), instancePort: 1234, ...(capabilities ? { capabilities } : {}) }) },
    captureHost: callbacks => (hooks = callbacks, { start: async s => { starts.push(s); }, stop: id => stops.push(id), reset() { return true; }, pause() { return true; }, credit() {}, keyframe() {}, close() {} }) });
  t.after(() => service.dispose());
  await service.start(); await tick();
  const [control] = ws.find('/screen/v1/target');
  control.open(); await tick();
  const hello = control.sent[0];
  control.receive({ type: 'registered', epoch: 'desktop_epoch', serverTime: Date.now() });
  let n = 0;
  const open = quality => {
    const session = { id: `screen_${++n}`, desktopId: service.desktopId, deviceId: 'viewer', deviceName: 'Viewer', generation: `generation_${n}`,
      display: service.status().desktop.displays[0], controlAllowed: true, state: 'connecting', createdAt: Date.now() };
    control.receive({ type: 'start', session, mediaTicket: 'M'.repeat(43), streamGeneration: 1, codecs: ['h264'], ...(quality !== undefined ? { quality } : {}) });
    const media = ws.find('/screen/v1/target-media').at(-1);
    return { session, media };
  };
  const attach = async ({ session, media }) => { media.open(); media.receive({ type: 'attached', sessionId: session.id }); await tick(); };
  return { service, control, hello, open, attach, starts, stops, ws, hooks: () => hooks };
}
const legacyHello = screenServiceHelloSchema.omit({ features: true }).strict();

test('service: the hello carries features only when the Host advertised quality; an old Host gets the exact legacy hello', async t => {
  const old = await target(t);
  assert.deepEqual(Object.keys(old.hello), ['type', 'ticket', 'desktop']);
  assert.doesNotThrow(() => legacyHello.parse(old.hello), 'an older Hub (strict hello) still accepts it');
  const unrelated = await target(t, { capabilities: ['target-stop', 'screen-service-ticket'] });
  assert.equal('features' in unrelated.hello, false);
  const current = await target(t, { capabilities: ['target-stop', 'screen-service-ticket', 'screen-quality-v1'] });
  assert.deepEqual(current.hello.features, ['screen.quality.v1']);
  assert.throws(() => legacyHello.parse(current.hello), 'proves why it must be gated');
  assert.doesNotThrow(() => screenServiceHelloSchema.parse(current.hello));
});

test('service: the start quality selects the real capture profile; omitted = legacy balanced', async t => {
  const f = await target(t, { capabilities: ['screen-quality-v1'] });
  for (const quality of [undefined, 'smooth', 'balanced', 'sharp']) {
    const opened = f.open(quality); await f.attach(opened);
    const start = f.starts.at(-1), profile = screenQualityProfile(quality);
    assert.equal(start.sessionId, opened.session.id);
    assert.deepEqual(start.encode, encodeSize({ width: 1440, height: 900, scale: 2 }, profile), String(quality));
    assert.deepEqual([start.fps, start.profile], [profile.fps, { qpBase: profile.qpBase, qpMax: profile.qpMax, bitrate: profile.bitrate, h264Only: profile.h264Only }]);
    f.service.stop(opened.session.id);
    assert.ok(f.stops.includes(opened.session.id), 'switching quality leaves no capture behind');
  }
  assert.deepEqual(f.starts.map(s => s.encode), [{ width: 1818, height: 1136 }, { width: 1280, height: 800 }, { width: 1818, height: 1136 }, { width: 2880, height: 1800 }]);
  assert.deepEqual(f.starts.map(s => [s.profile.qpBase, s.profile.h264Only]), [[28, false], [32, false], [28, false], [28, true]]);
  assert.equal(f.service.status().sessions.length, 0);
});

test('service: an unknown quality is refused by the command schema and creates no media socket or capture', async t => {
  const f = await target(t, { capabilities: ['screen-quality-v1'] });
  const before = f.ws.find('/screen/v1/target-media').length;
  f.control.receive({ type: 'start', session: { id: 'screen_x', desktopId: f.service.desktopId, deviceId: 'viewer', deviceName: 'Viewer', generation: 'generation_x',
    display: f.service.status().desktop.displays[0], controlAllowed: true, state: 'connecting', createdAt: Date.now() }, mediaTicket: 'M'.repeat(43), streamGeneration: 1, codecs: ['h264'], quality: 'ultra' });
  await tick();
  assert.equal(f.ws.find('/screen/v1/target-media').length, before);
  assert.equal(f.starts.length, 0);
  assert.equal(screenServiceCommandSchema.safeParse({ type: 'start', quality: 'ultra' }).success, false);
});

test('service: a late `attached` after a quality session was stopped never starts capture', async t => {
  const f = await target(t, { capabilities: ['screen-quality-v1'] });
  const opened = f.open('sharp');
  opened.media.open();
  f.service.stop(opened.session.id);
  opened.media.receive({ type: 'attached', sessionId: opened.session.id }); await tick();
  assert.equal(f.starts.length, 0);
});

test('core: an input the encoder dropped returns its credit; a delta before the generation key is never sent', async () => {
  const b = browser(); await b.core.handle(startMessage('balanced')); await tick();
  const session = b.core.sessions.get('s1');
  for (let i = 0; i < 3; i++) { b.advance(67); b.push(b.frame(1818, 1136)); await tick(); b.run(); }
  const encoder = b.encoders[0];
  assert.equal(encoder.encodes.length, 3); assert.equal(session.outstanding.size, 3);
  // The encoder drops the key-frame input and outputs the next one as a delta.
  encoder.drop(); encoder.emit('delta');
  assert.equal(b.sent.filter(m => m.type === 'frame').length, 0, 'a delta that would start the chain is never sent');
  assert.equal(session.outstanding.size, 1, 'credits of the dropped input and of the withheld delta came back');
  assert.equal(session.needKey, true);
  encoder.emit('delta'); // third input: still no key in this generation
  assert.equal(b.sent.filter(m => m.type === 'frame').length, 0);
  b.advance(67); b.push(b.frame(1818, 1136)); await tick(); b.run();
  assert.equal(encoder.encodes.at(-1).keyFrame, true, 'the next encode is a key frame');
  encoder.emit('key');
  const frames = b.sent.filter(m => m.type === 'frame');
  assert.deepEqual(frames.map(m => [m.sequence, m.key]), [[4, true]], 'metadata follows the timestamp, not output order');
  // Mid-chain drop: credits return, the chain continues (dropped inputs are no references).
  for (let i = 0; i < 2; i++) { b.advance(67); b.push(b.frame(1818, 1136)); await tick(); b.run(); }
  encoder.drop(); encoder.emit('delta');
  assert.deepEqual(b.sent.filter(m => m.type === 'frame').map(m => [m.sequence, m.key]), [[4, true], [6, false]]);
  assert.deepEqual([...session.outstanding.keys()], [4, 6]);
});

// ---------------- normal balanced path / reference chain ----------------
test('core pacer: a normal balanced stream (≈2.4 Mbps, 110 kB keys) is paced exactly as before — every frame, on the frame interval, QP unchanged', async () => {
  const b = browser(); await b.core.handle(startMessage('balanced')); await tick();
  const session = b.core.sessions.get('s1'), encodedAt = [];
  for (let i = 1; i <= 300; i++) {          // 20 s at 15 fps, a keyframe every 5 s (control/visibility resets)
    b.advance(67); b.push(b.frame(1818, 1136)); await tick(); b.run(); // integer ms, like Date.now()
    const encoder = b.encoders.at(-1);
    while (encoder.emitted < encoder.encodes.length) {
      const key = encoder.encodes[encoder.emitted].keyFrame;
      encoder.emit(key ? 'key' : 'delta', key ? 110_000 : 20_000); encodedAt.push(i);
      await b.core.handle({ type: 'credit', sessionId: 's1', frameSequence: session.sequence, streamGeneration: session.streamGeneration });
    }
    if (i % 15 === 0) b.adapt();
    if (i % 75 === 0) await b.core.handle({ type: 'reset', sessionId: 's1', streamGeneration: session.streamGeneration + 1, geometryRevision: 1 });
  }
  assert.equal(b.sent.filter(m => m.type === 'frame').length, 300, 'no frame waited or was dropped');
  assert.deepEqual(encodedAt, Array.from({ length: 300 }, (_, i) => i + 1), 'each frame encoded on arrival, as interval-only pacing would');
  assert.equal(session.qp, 28); assert.equal(session.starved, 0);
  assert.equal(b.pending.length, 0, 'no byte-wait timer was ever left pending');
});

test('reference chain: under byte pressure every output after the key is sent, in order, with no gap in the encoded sequence', async () => {
  const b = browser({ chunkBytes: 150_000 }); await b.core.handle(startMessage('sharp')); await tick();
  const session = b.core.sessions.get('s1');
  for (let i = 0; i < 120; i++) {
    b.advance(67); b.push(b.frame(2880, 1800)); await tick(); b.run();
    const encoder = b.encoders.at(-1);
    while (encoder.emitted < encoder.encodes.length) encoder.emit(encoder.emitted === 0 ? 'key' : 'delta');
    for (const m of b.sent.filter(m => m.type === 'frame' && !m.credited)) { m.credited = true; await b.core.handle({ type: 'credit', sessionId: 's1', frameSequence: m.sequence, streamGeneration: 1 }); }
    if (i % 15 === 14) b.adapt();
  }
  const sent = b.sent.filter(m => m.type === 'frame');
  assert.ok(sent.length < 60, `the pacer did hold raw frames back (${sent.length} of 120 sent)`);
  assert.deepEqual(sent.map(m => m.sequence), Array.from({ length: sent.length }, (_, i) => i + 1), 'raw frames wait BEFORE encode; encoded frames are never skipped');
  assert.equal(sent[0].key, true);
  assert.ok(sent.every(m => m.streamGeneration === 1));
});

test('reference chain: an encoded frame that cannot be framed ends the session; nothing of that generation follows it', async () => {
  const b = browser(); await b.core.handle(startMessage('balanced')); await tick();
  for (let i = 0; i < 3; i++) { b.advance(67); b.push(b.frame(1818, 1136)); await tick(); b.run(); }
  const encoder = b.encoders[0];
  encoder.emit('key');
  encoder.emit('delta', 1024 * 1024); // over the 1 MiB packet limit: cannot be sent
  encoder.emit('delta');              // a later delta depends on the unsent one
  assert.deepEqual(b.sent.filter(m => m.type === 'frame').map(m => m.sequence), [1]);
  assert.deepEqual(b.sent.filter(m => m.type === 'ended').map(m => m.reason), ['screen_congested']);
  assert.equal(b.core.sessions.size, 0); assert.equal(b.track.stopped, true); assert.equal(encoder.state, 'closed');
});

test('service: a frame the media socket cannot take ends the session (Host told), never skipped while the chain continues', async t => {
  const f = await target(t, { capabilities: ['screen-quality-v1'] });
  const opened = f.open('balanced'); await f.attach(opened);
  const hooks = f.hooks(), id = opened.session.id;
  const frame = (sequence, key = false) => hooks.onMessage({ type: 'frame', sessionId: id, sequence, streamGeneration: 1, captureMs: Date.now(), geometryRevision: 1, key,
    bytes: writeScreenFrame({ key, codec: 'h264', sequence, geometryRevision: 1, streamGeneration: 1, captureMs: Date.now(), width: 1818, height: 1136 }, new Uint8Array([0, 0, 0, 1, 0x65])) });
  frame(1, true);
  opened.media.bufferedAmount = 2 * 1024 * 1024;  // backlog full
  frame(2); opened.media.bufferedAmount = 0; frame(3);
  const binary = opened.media.sent.filter(m => m instanceof Uint8Array);
  assert.equal(binary.length, 1, 'only the frame before the backlog was sent; nothing after the refused one');
  assert.ok(f.stops.includes(id), 'capture stopped');
  assert.ok(f.control.sent.some(m => m.type === 'stop' && m.sessionId === id && m.reason === 'screen_congested'), 'the Host is told why');
  assert.equal(f.service.status().sessions.length, 0);
});

// ---------------- output gate: actual packet sizes vs the Hub per-source bucket ----------------
/** Replays the Hub's per-source bucket (remote-screen-sockets.ts: 500 B/ms, 1 MiB, full at accept) over send times. */
function hubReplay(frames) {
  let bucket = 1024 * 1024, last = frames[0]?.at ?? 0, min = bucket;
  for (const m of frames) { bucket = Math.min(1024 * 1024, bucket + (m.at - last) * 500) - m.bytes.byteLength; last = m.at; min = Math.min(min, bucket); }
  return min;
}
/** Advances the fake clock in small steps, running due timers. */
async function elapse(b, ms, step = 5) { for (let t = 0; t < ms; t += step) { b.advance(step); b.run(); await tick(); } }
async function inFlight(b, count, width = 1818, height = 1136, gap = 100) {
  for (let i = 0; i < count; i++) { b.advance(gap); b.push(b.frame(width, height)); await tick(); b.run(); }
}

test('output gate (GG1 probe): three in-flight encodes returning 400 KiB each at once leave paced, in order, inside the Hub bucket', async () => {
  const b = browser(); await b.core.handle(startMessage('balanced')); await tick();
  const session = b.core.sessions.get('s1');
  await inFlight(b, 3);                                   // 0/100/200 ms: all three encodes queued, no output yet
  const encoder = b.encoders[0];
  assert.equal(encoder.encodes.length, 3); assert.equal(session.outstanding.size, CAPTURE_CREDITS);
  const captured = b.sent.filter(m => m.type === 'captured').map(m => m.captureMs);
  for (const type of ['key', 'delta', 'delta']) encoder.emit(type, 400 * 1024); // same instant
  assert.equal(b.sent.filter(m => m.type === 'frame').length, 1, 'only what the bucket covers leaves at once');
  await elapse(b, 1500);
  const frames = b.sent.filter(m => m.type === 'frame');
  assert.deepEqual(frames.map(m => [m.sequence, m.key]), [[1, true], [2, false], [3, false]], 'FIFO reference chain, nothing dropped');
  assert.deepEqual(frames.map(m => m.captureMs), captured, 'original capture times, never re-stamped');
  assert.ok(hubReplay(frames) >= 0, `Hub bucket never exhausted (min ${hubReplay(frames)})`);
  assert.ok(frames.at(-1).at - frames[0].at >= (3 * 409_632 - PACE_BURST_BYTES) / PACE_BYTES_PER_MS - 10, 'the burst was spread at the paced rate');
  assert.equal(b.core.sessions.size, 1, 'session continues');
  assert.ok(session.outstanding.size <= CAPTURE_CREDITS);
});

test('output gate: a legal packet above the local burst waits for a full bucket with nothing unacknowledged, then fits the Hub', async () => {
  const b = browser(); await b.core.handle(startMessage('sharp')); await tick();
  await inFlight(b, 2, 2880, 1800);
  const encoder = b.encoders[0];
  encoder.emit('key', 300 * 1024);                        // sent at once
  encoder.emit('delta', 900 * 1024);                      // > 768 KiB local cap, < 1 MiB packet limit
  assert.equal(b.sent.filter(m => m.type === 'frame').length, 1);
  await elapse(b, 900);
  assert.equal(b.sent.filter(m => m.type === 'frame').length, 1, 'bucket refilled but the key is still unacknowledged');
  await b.core.handle({ type: 'credit', sessionId: 's1', frameSequence: 1, streamGeneration: 1 });
  const frames = b.sent.filter(m => m.type === 'frame');
  assert.deepEqual(frames.map(m => m.sequence), [1, 2]);
  assert.ok(hubReplay(frames) >= 0, `Hub bucket never exhausted (min ${hubReplay(frames)})`);
});

test('output gate: a packet that cannot leave before it is too old ends the whole session; no later packet of that chain is sent', async () => {
  const b = browser(); await b.core.handle(startMessage('sharp')); await tick();
  await inFlight(b, 3, 2880, 1800);
  const encoder = b.encoders[0];
  encoder.emit('key', 600 * 1024); encoder.emit('delta', 1000 * 1024); encoder.emit('delta', 10);
  assert.deepEqual(b.sent.filter(m => m.type === 'frame').map(m => m.sequence), [1]);
  await elapse(b, OUTPUT_MAX_AGE_MS + 50, 20);            // never ACKed: the oversize delta cannot leave
  assert.deepEqual(b.sent.filter(m => m.type === 'frame').map(m => m.sequence), [1], 'the stuck delta is not skipped, nothing after it is sent');
  assert.deepEqual(b.sent.filter(m => m.type === 'ended').map(m => m.reason), ['screen_congested']);
  assert.equal(b.core.sessions.size, 0); assert.equal(b.track.stopped, true); assert.equal(b.pending.length, 0, 'no timer left behind');
});

test('output gate: reset or stop with packets queued sends nothing of the retired chain; late encoder output is ignored', async () => {
  for (const action of ['reset', 'pause', 'stop']) {
    const b = browser(); await b.core.handle(startMessage('balanced')); await tick();
    await inFlight(b, 3);
    const encoder = b.encoders[0];
    encoder.emit('key', 700 * 1024); encoder.emit('delta', 400 * 1024); // second one waits in the outbox
    assert.equal(b.sent.filter(m => m.type === 'frame').length, 1);
    if (action === 'reset') await b.core.handle({ type: 'reset', sessionId: 's1', streamGeneration: 2, geometryRevision: 1 });
    else if (action === 'pause') await b.core.handle({ type: 'pause', sessionId: 's1', paused: true, streamGeneration: 2 });
    else await b.core.handle({ type: 'stop', sessionId: 's1' });
    encoder.emit('delta', 100);                           // late output of the retired encoder
    await elapse(b, 2500, 20);
    const frames = b.sent.filter(m => m.type === 'frame');
    assert.deepEqual(frames.map(m => [m.streamGeneration, m.sequence]), [[1, 1]], `${action}: queued and late packets of generation 1 never leave`);
    assert.equal(b.sent.some(m => m.type === 'ended'), false, `${action}: retiring is not a failure`);
    if (action === 'reset') {
      b.advance(67); b.push(b.frame(1818, 1136)); await tick(); b.run();
      b.encoders[1].emit('key', 1000);
      assert.deepEqual(b.sent.filter(m => m.type === 'frame').map(m => [m.streamGeneration, m.key]), [[1, true], [2, true]], 'new generation starts with its own key');
    } else assert.equal(b.pending.length, 0, `${action}: no output timer left`);
  }
});

test('output gate: randomized bursty outputs stay gapless, in order and inside the replayed Hub bucket', async () => {
  let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const b = browser(); await b.core.handle(startMessage('sharp')); await tick();
  const session = b.core.sessions.get('s1');
  for (let i = 0; i < 400 && b.core.sessions.size; i++) {
    b.advance(67); b.push(b.frame(2880, 1800)); await tick(); b.run();
    const encoder = b.encoders.at(-1);
    // The encoder sometimes holds outputs and releases them together; a page
    // change makes every in-flight output large at once (admission predicted small ones).
    if (rnd() < 0.5) { const big = rnd() < 0.2; while (encoder.emitted < encoder.encodes.length) encoder.emit(encoder.emitted === 0 ? 'key' : 'delta', big ? 380_000 + Math.floor(rnd() * 80_000) : 15_000 + Math.floor(rnd() * 10_000)); }
    for (const m of b.sent.filter(m => m.type === 'frame' && !m.acked)) if (rnd() < 0.9) { m.acked = true; await b.core.handle({ type: 'credit', sessionId: 's1', frameSequence: m.sequence, streamGeneration: 1 }); }
    if (i % 15 === 14) b.adapt();
    assert.ok(session.outstanding.size <= CAPTURE_CREDITS);
  }
  const frames = b.sent.filter(m => m.type === 'frame');
  assert.ok(frames.length > 50, `${frames.length} frames sent`);
  assert.ok(frames.filter(m => m.bytes.byteLength > 300_000).length >= 10, 'the run contained large simultaneous bursts');
  assert.deepEqual(frames.map(m => m.sequence), Array.from({ length: frames.length }, (_, i) => i + 1));
  assert.ok(hubReplay(frames) >= 0, `Hub bucket never exhausted (min ${hubReplay(frames)})`);
  for (let i = 1; i < frames.length; i++) assert.ok(frames[i].captureMs >= frames[i - 1].captureMs);
  for (const m of frames) assert.ok(m.at - (m.captureMs - 1_800_000_000_000) <= OUTPUT_MAX_AGE_MS, 'no packet left older than the age limit');
});
