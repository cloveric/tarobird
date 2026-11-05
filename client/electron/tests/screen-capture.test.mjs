import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCaptureCore, CAPTURE_CREDITS } from '../screen-capture-core.mjs';
import { ScreenCaptureHost, CAPTURE_PORT_CHANNEL, captureAsset } from '../screen-capture-host.mjs';
import { readScreenFrame, writeScreenFrame } from '../../../src/client-protocol/screen-wire.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

/** Fake browser APIs: encoders record encodes; tests emit their output. */
function browser({ configGate } = {}) {
  const sent = [], encoders = [], frames = [], timers = [];
  let clock = 1_800_000_000_000, perf = 0, pushFrame;
  class Encoder {
    static async isConfigSupported(config) { if (configGate) await configGate.promise; return { supported: config.bitrateMode === 'quantizer' }; }
    constructor({ output, error }) { this.output = output; this.error = error; this.state = 'unconfigured'; this.encodeQueueSize = 0; this.encodes = []; encoders.push(this); }
    configure(config) { this.config = config; this.state = 'configured'; }
    encode(frame, options) { this.encodes.push({ frame: frame.id, timestamp: frame.timestamp, options }); }
    close() { this.state = 'closed'; }
    /** Outputs the oldest not-yet-output encode (real encoders keep the input timestamp). */
    emit(type = 'delta') { const input = this.encodes[this.emitted = (this.emitted ?? 0) + 1, this.emitted - 1]; this.output({ type, timestamp: input?.timestamp, byteLength: 3, copyTo: target => target.set([1, 2, 3]) }); }
  }
  const frame = (id = frames.length + 1) => { const f = { id, displayWidth: 1280, displayHeight: 720, timestamp: id, closed: false, close() { this.closed = true; } }; frames.push(f); return f; };
  const track = { stopped: false, stop() { this.stopped = true; }, getSettings: () => ({ cursor: 'always', width: 1280, height: 720 }), addEventListener() {} };
  class Processor {
    constructor() {
      this.readable = { getReader: () => ({ read: () => new Promise(resolve => { pushFrame = value => resolve(value === undefined ? { done: true } : { value, done: false }); }), cancel() {} }) };
    }
  }
  const core = createCaptureCore({ send: m => sent.push(m), getDisplayMedia: async () => ({ getVideoTracks: () => [track], getTracks: () => [track] }),
    VideoEncoder: Encoder, VideoFrame: class { constructor() { this.close = () => {}; } }, OffscreenCanvas: class { getContext() { return { drawImage() {} }; } },
    MediaStreamTrackProcessor: Processor, writeScreenFrame, now: () => clock, perf: () => perf,
    timers: { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {} } });
  return { core, sent, encoders, frames, track, frame, push: value => { const p = pushFrame; pushFrame = undefined; p?.(value); },
    advance: ms => { perf += ms; clock += ms; }, timers };
}
const start = (b, extra = {}) => b.core.handle({ type: 'start', sessionId: 's1', streamGeneration: 1, geometryRevision: 1, codecs: ['h264'], encode: { width: 1280, height: 720 }, fps: 15, ...extra });
const frames = b => b.sent.filter(m => m.type === 'frame');

test('first frame of a generation is a key frame carrying the target capture time; header round-trips', async () => {
  const b = browser(); await start(b); await tick();
  assert.equal(b.sent.find(m => m.type === 'stream').stream.codecString, 'avc1.640028');
  assert.equal(b.encoders[0].config.bitrateMode, 'quantizer');
  b.push(b.frame()); await tick();
  assert.deepEqual(b.encoders[0].encodes[0].options, { keyFrame: true, avc: { quantizer: 28 } });
  b.encoders[0].emit('key');
  const header = readScreenFrame(frames(b)[0].bytes);
  assert.deepEqual([header.key, header.sequence, header.streamGeneration, header.captureMs], [true, 1, 1, 1_800_000_000_000]);
});

test('reset retires queued output of the old generation; the next generation starts with its own key frame', async () => {
  const b = browser(); await start(b); await tick();
  b.push(b.frame()); await tick();                       // seq 1 queued in encoder gen 1, no output yet
  await b.core.handle({ type: 'reset', sessionId: 's1', streamGeneration: 2, geometryRevision: 1 });
  b.encoders[0].emit('delta');                           // late output of the retired encoder
  assert.equal(frames(b).length, 0, 'old generation output must be discarded');
  b.advance(100); b.push(b.frame()); await tick();
  assert.equal(b.encoders[1].encodes[0].options.keyFrame, true);
  b.encoders[1].emit('key');
  const header = readScreenFrame(frames(b)[0].bytes);
  assert.deepEqual([header.streamGeneration, header.sequence, header.key], [2, 2, true]);
  await assert.doesNotReject(b.core.handle({ type: 'reset', sessionId: 's1', streamGeneration: 2, geometryRevision: 1 }));
  assert.equal(b.sent.at(-1).type, 'ended', 'a non-increasing generation is refused');
});

test('credits bound outstanding frames at 3; the newest frame waits (older ones dropped before encode)', async () => {
  const b = browser(); await start(b); await tick();
  for (let i = 0; i < 6; i++) { b.advance(100); b.push(b.frame()); await tick(); }
  assert.equal(b.encoders[0].encodes.length, CAPTURE_CREDITS);
  assert.ok(b.frames.slice(3, 5).every(f => f.closed), 'superseded frames are closed without encoding');
  await b.core.handle({ type: 'credit', sessionId: 's1', frameSequence: 2, streamGeneration: 1 });
  assert.equal(b.encoders[0].encodes.length, 4);
  assert.equal(b.encoders[0].encodes[3].frame, 6, 'the latest captured frame is encoded next');
  await b.core.handle({ type: 'credit', sessionId: 's1', frameSequence: 3, streamGeneration: 9 });
  assert.equal(b.encoders[0].encodes.length, 4, 'cross-generation credit is ignored');
});

test('pause drops the held raw frame; resume never encodes a frame captured before the pause', async () => {
  const b = browser(); await start(b); await tick();
  for (let i = 0; i < 4; i++) { b.advance(100); b.push(b.frame()); await tick(); }
  const held = b.frames[3];
  await b.core.handle({ type: 'pause', sessionId: 's1', paused: true, streamGeneration: 1 });
  assert.equal(held.closed, true);
  await b.core.handle({ type: 'pause', sessionId: 's1', paused: false, streamGeneration: 2 });
  assert.equal(b.encoders[1].encodes.length, 0, 'nothing old is reused');
  b.advance(100); b.push(b.frame()); await tick();
  assert.deepEqual([b.encoders[1].encodes[0].frame, b.encoders[1].encodes[0].options.keyFrame], [5, true]);
});

test('stop while a start awaits encoder configuration leaves no encoder, stream or track behind', async () => {
  const gate = deferred(), b = browser({ configGate: gate });
  const running = start(b); await tick();
  const stopped = b.core.handle({ type: 'stop', sessionId: 's1' }); // applied synchronously
  assert.equal(b.core.sessions.size, 0);
  gate.resolve(); await Promise.all([running, stopped]); await tick();
  assert.equal(b.encoders.length, 0);
  assert.equal(b.sent.some(m => m.type === 'stream' || m.type === 'started'), false);
  assert.equal(b.track.stopped, true);
  assert.equal(b.core.sessions.size, 0);
});

test('stop that arrives before its start runs cancels that start', async () => {
  const b = browser();
  const first = start(b); const stopped = b.core.handle({ type: 'stop', sessionId: 's1' });
  await Promise.all([first, stopped]); await tick();
  assert.equal(b.core.sessions.size, 0);
  assert.equal(b.encoders.filter(e => e.state === 'configured').length, 0);
});

// ---------------- capture host (main) ----------------
function electronFake() {
  const handlers = {}, windows = [];
  const ses = { webRequest: { onBeforeRequest: fn => { handlers.request = fn; } }, protocol: { isProtocolHandled: async () => false, handle: (s, fn) => { handlers.asset = fn; }, unhandle() {} },
    setPermissionCheckHandler: fn => { handlers.check = fn; }, setPermissionRequestHandler: fn => { handlers.permission = fn; }, setDevicePermissionHandler: fn => { handlers.device = fn; },
    setDisplayMediaRequestHandler: (fn, options) => { handlers.display = fn; handlers.displayOptions = options; }, on() {}, removeListener() {} };
  class Port extends EventEmitter { postMessage(data) { this.peer.emit('message', { data: structuredClone(data) }); } start() {} close() {} }
  class BrowserWindow {
    constructor(options) { this.options = options; windows.push(this); const contents = new EventEmitter();
      Object.assign(contents, { mainFrame: { processId: 7, routingId: 9 }, setWindowOpenHandler() {}, postMessage: (channel, _m, [port]) => { this.channel = channel; this.page = port; port.on('message', ({ data }) => this.onPage?.(data)); port.postMessage({ type: 'ready' }); } });
      this.webContents = contents; this.destroyed = false; }
    async loadURL(url) { this.url = url; }
    isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; }
  }
  class MessageChannelMain { constructor() { this.port1 = new Port(); this.port2 = new Port(); this.port1.peer = this.port2; this.port2.peer = this.port1; } }
  return { electron: { BrowserWindow, MessageChannelMain, session: { fromPartition: () => ses } }, handlers, windows };
}

test('host answers each getDisplayMedia with its own bound source: a second start waits for the first to be started', async () => {
  const fake = electronFake(), messages = [], resolved = [];
  const host = new ScreenCaptureHost({ electron: fake.electron, root: '/x', preload: '/p.cjs', onMessage: m => messages.push(m), onGone() {},
    resolveSource: async display => { resolved.push(display.id); return { id: `source-${display.id}` }; } });
  const one = host.start({ sessionId: 'a', display: { id: 'A', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
  const two = host.start({ sessionId: 'b', display: { id: 'B', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
  await new Promise(r => setTimeout(r, 20));
  const window = fake.windows[0];
  assert.equal(window.channel, CAPTURE_PORT_CHANNEL);
  assert.equal(window.options.webPreferences.sandbox, true); assert.equal(window.options.show, false); assert.equal(fake.handlers.displayOptions.useSystemPicker, false);
  assert.deepEqual(resolved, ['A'], 'second source is not resolved before the first start completes');
  const answer = () => new Promise(resolve => fake.handlers.display({ frame: { processId: 7, routingId: 9 }, audioRequested: false }, resolve));
  assert.deepEqual(await answer(), { video: { id: 'source-A' } });
  assert.deepEqual(await answer(), {}, 'a second request before `started` gets nothing');
  window.page.postMessage({ type: 'started', sessionId: 'a' }); await one;
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(resolved, ['A', 'B']);
  assert.deepEqual(await answer(), { video: { id: 'source-B' } });
  window.page.postMessage({ type: 'started', sessionId: 'b' }); await two;
  assert.deepEqual(await new Promise(resolve => fake.handlers.display({ frame: { processId: 1, routingId: 1 }, audioRequested: false }, resolve)), {}, 'other frames never get a source');
  host.close();
});

test('capture session blocks network and serves only the two capture files with CSP', async () => {
  const fake = electronFake();
  const host = new ScreenCaptureHost({ electron: fake.electron, root: new URL('.', import.meta.url).pathname, preload: '/p.cjs', onMessage() {}, onGone() {}, resolveSource: async () => ({}) });
  const run = host.start({ sessionId: 'a', display: { id: 'A', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
  await new Promise(r => setTimeout(r, 20));
  const verdict = url => new Promise(resolve => fake.handlers.request({ url }, resolve));
  assert.deepEqual(await verdict('https://example.com/'), { cancel: true });
  assert.deepEqual(await verdict('ws://127.0.0.1:1/'), { cancel: true });
  assert.deepEqual(await verdict('tarobot-screen://capture/capture.js'), { cancel: false });
  assert.equal(fake.handlers.device(), false);
  assert.equal(fake.handlers.check(fake.windows[0].webContents, 'media', '', { requestingUrl: 'tarobot-screen://capture/capture.html', mediaTypes: ['video'] }), true);
  assert.equal(fake.handlers.check(fake.windows[0].webContents, 'media', '', { requestingUrl: 'tarobot-screen://capture/capture.html', mediaTypes: ['audio'] }), false);
  assert.equal(fake.handlers.check(fake.windows[0].webContents, 'notifications', '', { requestingUrl: 'tarobot-screen://capture/capture.html' }), false);
  assert.equal(fake.handlers.check({}, 'media', '', { requestingUrl: 'tarobot-screen://capture/capture.html' }), false);
  const serve = captureAsset(new URL('.', import.meta.url).pathname);
  assert.equal((await serve({ url: 'tarobot-screen://capture/../package.json' })).status, 404);
  assert.equal((await serve({ url: 'tarobot-screen://capture/other.js' })).status, 404);
  assert.equal((await serve({ url: 'tarobot-screen://evil/capture.html' })).status, 404);
  fake.windows[0].page.postMessage({ type: 'ended', sessionId: 'a', reason: 'screen_capture_failed' });
  await assert.rejects(run, /screen_capture_failed/);
  host.close();
});

// ---------------- sharing indicator ----------------
test('indicator: one inactive, click-through, capturable badge per shared display; removed when sharing ends', async () => {
  const { ScreenIndicator } = await import('../screen-indicator.mjs');
  const windows = [], loads = [];
  class BrowserWindow {
    constructor(options) { this.options = options; this.calls = []; this.destroyed = false; windows.push(this);
      this.webContents = { setWindowOpenHandler() {}, on() {} }; }
    setIgnoreMouseEvents(v) { this.calls.push(['ignoreMouse', v]); } setAlwaysOnTop(...v) { this.calls.push(['top', ...v]); }
    setVisibleOnAllWorkspaces(v) { this.calls.push(['workspaces', v]); } once(name, fn) { if (name === 'ready-to-show') this.ready = fn; }
    showInactive() { this.calls.push(['showInactive']); } setBounds(b) { this.calls.push(['bounds', b]); }
    loadURL(url) { loads.push(url); return Promise.resolve(); } isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; }
  }
  const ses = { webRequest: { onBeforeRequest() {} }, protocol: { handle() {} }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
  const electron = { BrowserWindow, app: { getLocale: () => 'zh-CN' }, session: { fromPartition: () => ses },
    screen: { getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 25, width: 1512, height: 957 } }, { id: 2, workArea: { x: -1920, y: 0, width: 1920, height: 1080 } }] } };
  const indicator = new ScreenIndicator({ electron, root: '/x' });
  indicator.update([{ nativeId: '1', deviceName: 'Windows <b>PC</b>', controlling: true }, { nativeId: '2', deviceName: 'MacBook', controlling: false }]);
  assert.equal(windows.length, 2);
  for (const window of windows) {
    assert.equal(window.options.focusable, false); assert.equal(window.options.type, 'panel'); assert.equal(window.options.show, false);
    assert.equal(window.options.webPreferences.sandbox, true);
    assert.deepEqual(window.calls.find(c => c[0] === 'ignoreMouse'), ['ignoreMouse', true]);
    window.ready(); assert.ok(window.calls.some(c => c[0] === 'showInactive'));
  }
  assert.equal(windows[1].options.x, -1920 + 1920 - 330 - 12, 'placed on its own (negative-origin) display');
  const hash = new URLSearchParams(new URL(loads[0]).hash.slice(1));
  assert.deepEqual([hash.get('names'), hash.get('control'), hash.get('lang')], ['Windows <b>PC</b>', '1', 'zh']);
  indicator.update([{ nativeId: '2', deviceName: 'MacBook', controlling: false }]);
  assert.equal(windows[0].destroyed, true); assert.equal(windows[1].destroyed, false);
  indicator.update([]);
  assert.equal(windows[1].destroyed, true);
});

test('host: stop or close while a start is queued, opening or resolving cancels it promptly with no start sent and no renderer left', async () => {
  for (const phase of ['resolving', 'queued', 'closed']) {
    const fake = electronFake(), sent = [];
    let releaseSource;
    const host = new ScreenCaptureHost({ electron: fake.electron, root: '/x', preload: '/p.cjs', onMessage() {}, onGone() {},
      resolveSource: display => display.id === 'A' ? new Promise(resolve => { releaseSource = () => resolve({ id: 'source-A' }); }) : Promise.resolve({ id: 'source-B' }) });
    const first = host.start({ sessionId: 'a', display: { id: 'A', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
    const second = host.start({ sessionId: 'b', display: { id: 'B', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
    await new Promise(r => setTimeout(r, 20));
    fake.windows[0].onPage = data => sent.push(data);
    const started = Date.now();
    if (phase === 'resolving') host.stop('a');
    else if (phase === 'queued') host.stop('b');
    else host.close();
    if (phase !== 'queued') await assert.rejects(first, /screen_capture_cancelled/);
    if (phase !== 'resolving') await assert.rejects(second, /screen_capture_cancelled/);
    assert.ok(Date.now() - started < 200, `${phase}: cancellation settles promptly`);
    releaseSource(); await new Promise(r => setTimeout(r, 20));
    if (phase === 'queued') {
      assert.deepEqual(sent.map(m => [m.type, m.sessionId]), [['start', 'a']], 'the cancelled queued start never reaches the page');
      fake.windows[0].page.postMessage({ type: 'started', sessionId: 'a' }); await first;
    } else assert.deepEqual(sent.filter(m => m.type === 'start' && m.sessionId === 'a'), [], `${phase}: no start after stop`);
    if (phase === 'resolving') { await new Promise(r => setTimeout(r, 20)); assert.deepEqual(sent.map(m => m.sessionId), ['b'], 'the next queued start proceeds'); }
    if (phase === 'closed') assert.equal(fake.windows[0].destroyed, true);
    host.close();
    if (phase === 'resolving') await assert.rejects(second, /screen_capture_cancelled/, 'close also cancels a start awaiting the page');
  }
});

test('core: a synchronous encode failure ends the whole session instead of escaping the pump', async () => {
  const b = browser(); await start(b); await tick();
  b.encoders[0].encode = () => { throw new Error('encode_boom'); };
  b.push(b.frame()); await tick();
  assert.equal(b.core.sessions.size, 0);
  assert.equal(b.sent.at(-1).type, 'ended'); assert.equal(b.sent.at(-1).reason, 'screen_capture_failed');
  assert.equal(b.track.stopped, true);
});

test('core: a raw frame that waited too long for a credit is dropped, never encoded stale', async () => {
  const b = browser(); await start(b); await tick();
  for (let i = 0; i < 4; i++) { b.advance(100); b.push(b.frame()); await tick(); }   // 3 credits used, frame 4 held
  b.advance(1600);
  await b.core.handle({ type: 'credit', sessionId: 's1', frameSequence: 3, streamGeneration: 1 });
  assert.equal(b.encoders[0].encodes.length, 3, 'the stale held frame is not encoded');
  assert.equal(b.frames[3].closed, true);
});

test('host: stop or close while the renderer is still opening leaves no window, and never tears down a newer one', async () => {
  for (const step of ['protocol', 'load']) {
    for (const how of ['stop', 'close']) {
      const fake = electronFake(), gate = deferred();
      if (step === 'protocol') { const original = fake.electron.session.fromPartition(); original.protocol.isProtocolHandled = async () => { await gate.promise; return false; }; }
      const host = new ScreenCaptureHost({ electron: fake.electron, root: '/x', preload: '/p.cjs', onMessage() {}, onGone() {}, resolveSource: async () => ({ id: 'src' }) });
      if (step === 'load') {
        const Base = fake.electron.BrowserWindow;
        fake.electron.BrowserWindow = class extends Base { async loadURL(url) { await gate.promise; this.url = url; } };
      }
      const pending = host.start({ sessionId: 'a', display: { id: 'A', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
      await new Promise(r => setTimeout(r, 10));
      if (how === 'stop') host.stop('a'); else host.close();
      await assert.rejects(pending, /screen_capture_cancelled/);
      gate.resolve(); await new Promise(r => setTimeout(r, 20));
      assert.equal(host.active, false, `${step}/${how}: no renderer after cancellation`);
      assert.ok(fake.windows.every(w => w.destroyed), `${step}/${how}: any created window is destroyed`);
      host.close();
    }
  }
  // A superseded open that fails late must not close the renderer of a newer open.
  const fake = electronFake(), gate = deferred(), Base = fake.electron.BrowserWindow;
  let first = true;
  fake.electron.BrowserWindow = class extends Base { async loadURL(url) { if (first) { first = false; await gate.promise; } this.url = url; } };
  const host = new ScreenCaptureHost({ electron: fake.electron, root: '/x', preload: '/p.cjs', onMessage() {}, onGone() {}, resolveSource: async () => ({ id: 'src' }) });
  const old = host.start({ sessionId: 'a', display: { id: 'A', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
  await new Promise(r => setTimeout(r, 10)); host.close(); await assert.rejects(old, /screen_capture_cancelled/);
  const fresh = host.start({ sessionId: 'b', display: { id: 'B', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
  await new Promise(r => setTimeout(r, 10));
  gate.resolve(); await new Promise(r => setTimeout(r, 20));
  assert.equal(host.active, true, 'the newer renderer survives the old open failing');
  fake.windows.at(-1).page.postMessage({ type: 'started', sessionId: 'b' }); await fresh;
  host.close();
});

test('host: a cancelled start releases the queue at once; its late open neither unregisters the new protocol nor touches the new renderer', async () => {
  const fake = electronFake(), gate = deferred(), calls = [];
  const ses = fake.electron.session.fromPartition();
  let first = true;
  ses.protocol.isProtocolHandled = async () => { if (first) { first = false; await gate.promise; return true; } return false; };
  ses.protocol.unhandle = () => calls.push('unhandle'); const handle = ses.protocol.handle; ses.protocol.handle = (...a) => { calls.push('handle'); return handle(...a); };
  const host = new ScreenCaptureHost({ electron: fake.electron, root: '/x', preload: '/p.cjs', onMessage() {}, onGone() {}, resolveSource: async () => ({ id: 'src' }) });
  const old = host.start({ sessionId: 'old', display: { id: 'A', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
  await new Promise(r => setTimeout(r, 10)); host.stop('old'); await assert.rejects(old, /screen_capture_cancelled/);
  const fresh = host.start({ sessionId: 'fresh', display: { id: 'B', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(fake.windows.length, 1, 'the fresh start opened without waiting for the old await');
  fake.windows[0].page.postMessage({ type: 'started', sessionId: 'fresh' }); await fresh;
  gate.resolve(); await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(calls, ['handle'], 'the late old open did not unhandle the new protocol');
  assert.equal(host.active, true); assert.equal(fake.windows[0].destroyed, false);
  host.close();
});

test('host: a stop while the page has not yet reported ready settles at once, without the 10 s ready timer', async () => {
  const fake = electronFake(), Base = fake.electron.BrowserWindow;
  let quiet = true;
  fake.electron.BrowserWindow = class extends Base {
    constructor(options) { super(options); const post = this.webContents.postMessage;
      this.webContents.postMessage = (channel, message, ports) => { if (!quiet) return post(channel, message, ports); this.channel = channel; this.page = ports[0]; }; }
  };
  const host = new ScreenCaptureHost({ electron: fake.electron, root: '/x', preload: '/p.cjs', onMessage() {}, onGone() {}, resolveSource: async () => ({ id: 'src' }) });
  const old = host.start({ sessionId: 'old', display: { id: 'A', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
  await new Promise(r => setTimeout(r, 10));
  const at = Date.now(); host.stop('old'); await assert.rejects(old, /screen_capture_cancelled/);
  quiet = false;
  const fresh = host.start({ sessionId: 'fresh', display: { id: 'B', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
  await new Promise(r => setTimeout(r, 30));
  assert.ok(Date.now() - at < 500, 'no wait for the old ready timer');
  assert.equal(fake.windows[0].destroyed, true, 'the never-ready renderer is gone');
  fake.windows.at(-1).page.postMessage({ type: 'started', sessionId: 'fresh' }); await fresh;
  host.close();
});

test('host: a cancelled start whose display request is still in flight cannot take the next session\'s source', async () => {
  const fake = electronFake();
  const host = new ScreenCaptureHost({ electron: fake.electron, root: '/x', preload: '/p.cjs', onMessage() {}, onGone() {},
    resolveSource: async display => ({ id: `source-${display.id}` }) });
  const answer = () => new Promise(resolve => fake.handlers.display({ frame: { processId: 7, routingId: 9 }, audioRequested: false }, resolve));
  const a = host.start({ sessionId: 'a', display: { id: 'A', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
  await new Promise(r => setTimeout(r, 20));                     // 'start' sent to the page; its request not yet handled
  const b = host.start({ sessionId: 'b', display: { id: 'B', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
  host.stop('a'); await assert.rejects(a, /screen_capture_cancelled/);
  await new Promise(r => setTimeout(r, 20));                     // b has bound its own source
  assert.deepEqual(await answer(), {}, 'a\'s late request gets nothing');
  assert.deepEqual(await answer(), { video: { id: 'source-B' } }, 'b gets exactly its own source');
  fake.windows[0].page.postMessage({ type: 'started', sessionId: 'b' }); await b;
  host.close();
});

test('host: a start stopped while its source is still resolving releases the queue before that resolution returns', async () => {
  const fake = electronFake(), sent = [];
  let releaseOld;
  const host = new ScreenCaptureHost({ electron: fake.electron, root: '/x', preload: '/p.cjs', onMessage() {}, onGone() {},
    resolveSource: display => display.id === 'A' ? new Promise(resolve => { releaseOld = () => resolve({ id: 'source-A' }); }) : Promise.resolve({ id: 'source-B' }) });
  const other = host.start({ sessionId: 'keep', display: { id: 'K', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
  await new Promise(r => setTimeout(r, 10));
  fake.windows[0].onPage = data => sent.push([data.type, data.sessionId]);
  fake.windows[0].page.postMessage({ type: 'started', sessionId: 'keep' }); await other;   // renderer stays open for a live session
  const old = host.start({ sessionId: 'old', display: { id: 'A', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
  await new Promise(r => setTimeout(r, 10));                                                  // old is now awaiting resolveSource
  host.stop('old'); await assert.rejects(old, /screen_capture_cancelled/);
  const fresh = host.start({ sessionId: 'fresh', display: { id: 'B', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(sent, [['start', 'fresh']], 'fresh started while the old resolution is still outstanding');
  const answer = () => new Promise(resolve => fake.handlers.display({ frame: { processId: 7, routingId: 9 }, audioRequested: false }, resolve));
  assert.deepEqual(await answer(), { video: { id: 'source-B' } });
  fake.windows[0].page.postMessage({ type: 'started', sessionId: 'fresh' }); await fresh;
  releaseOld(); await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(sent, [['start', 'fresh']], 'the abandoned resolution, when it returns, sends nothing');
  assert.deepEqual(await answer(), {}, 'and binds no source');
  assert.equal(host.active, true);
  host.close();
});

test('host: cancelling a QUEUED start never lets a later start overtake the still-active earlier one', async () => {
  const fake = electronFake(), sent = [];
  let releaseA;
  const host = new ScreenCaptureHost({ electron: fake.electron, root: '/x', preload: '/p.cjs', onMessage() {}, onGone() {},
    resolveSource: display => display.id === 'A' ? new Promise(resolve => { releaseA = () => resolve({ id: 'source-A' }); }) : Promise.resolve({ id: `source-${display.id}` }) });
  const start = id => host.start({ sessionId: id, display: { id, revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
  const a = start('A');
  await new Promise(r => setTimeout(r, 10));                    // A is active, awaiting resolveSource
  fake.windows[0].onPage = data => sent.push(data.sessionId);
  const b = start('B');
  host.stop('B'); await assert.rejects(b, /screen_capture_cancelled/);   // B was only queued
  const c = start('C');
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(sent, [], 'C waits behind the still-active A');
  releaseA(); await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(sent, ['A']);
  const answer = () => new Promise(resolve => fake.handlers.display({ frame: { processId: 7, routingId: 9 }, audioRequested: false }, resolve));
  assert.deepEqual(await answer(), { video: { id: 'source-A' } });
  fake.windows[0].page.postMessage({ type: 'started', sessionId: 'A' }); await a;
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(sent, ['A', 'C'], 'one pending source/start at a time, in order');
  assert.deepEqual(await answer(), { video: { id: 'source-C' } });
  fake.windows[0].page.postMessage({ type: 'started', sessionId: 'C' }); await c;
  host.close();
});

test('host: reopening the renderer never accumulates session listeners; close removes its own', async () => {
  const fake = electronFake();
  const ses = fake.electron.session.fromPartition();
  const emitter = new EventEmitter();
  ses.on = (name, fn) => { emitter.on(name, fn); return ses; };
  ses.removeListener = (name, fn) => { emitter.removeListener(name, fn); return ses; };
  const host = new ScreenCaptureHost({ electron: fake.electron, root: '/x', preload: '/p.cjs', onMessage() {}, onGone() {}, resolveSource: async () => ({ id: 'src' }) });
  for (let cycle = 0; cycle < 12; cycle++) {
    const run = host.start({ sessionId: `s${cycle}`, display: { id: 'A', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
    await new Promise(r => setTimeout(r, 5));
    fake.windows.at(-1).page.postMessage({ type: 'started', sessionId: `s${cycle}` }); await run;
    assert.equal(emitter.listenerCount('will-download'), 1, `cycle ${cycle}: exactly one listener while open`);
    host.stop(`s${cycle}`); await new Promise(r => setTimeout(r, 5));
    assert.equal(host.active, false);
    assert.equal(emitter.listenerCount('will-download'), 0, `cycle ${cycle}: removed with the renderer`);
  }
  // A start cancelled before its open passed the protocol check registers nothing.
  const gate = deferred(); ses.protocol.isProtocolHandled = async () => { await gate.promise; return false; };
  const cancelled = host.start({ sessionId: 'late', display: { id: 'A', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
  await new Promise(r => setTimeout(r, 5)); host.stop('late'); await assert.rejects(cancelled, /screen_capture_cancelled/);
  gate.resolve(); await new Promise(r => setTimeout(r, 10));
  assert.equal(emitter.listenerCount('will-download'), 0);
  host.close();
});

test('host: one overall start deadline bounds a hung open/source step and lets later starts proceed', async () => {
  const fake = electronFake();
  const host = new ScreenCaptureHost({ electron: fake.electron, root: '/x', preload: '/p.cjs', onMessage() {}, onGone() {}, startTimeoutMs: 80,
    resolveSource: display => display.id === 'hang' ? new Promise(() => {}) : Promise.resolve({ id: 'ok' }) });
  const hung = host.start({ sessionId: 'a', display: { id: 'hang', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
  const next = host.start({ sessionId: 'b', display: { id: 'fine', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
  await assert.rejects(hung, /screen_capture_timeout/);
  await new Promise(r => setTimeout(r, 20));
  fake.windows.at(-1).page.postMessage({ type: 'started', sessionId: 'b' }); await next;
  host.stop('b'); await new Promise(r => setTimeout(r, 10));
  assert.equal(host.active, false, 'renderer released after the timed-out and the finished start');
  host.close();
});

test('service+host: pause/reset that arrive while capture is still opening are applied once it has started', async t => {
  const { ScreenService } = await import('../screen-service.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises'); const os = await import('node:os'); const pathModule = await import('node:path');
  // Real Hub protocol: hide = pause(true, g+1); show = pause(false, g+1) (same generation).
  for (const [label, commands, expected, afterStart] of [
    ['still opening: hidden then shown', [{ paused: true, streamGeneration: 2 }, { paused: false, streamGeneration: 2 }], ['start:1', 'reset:2'], []],
    ['still opening: stays hidden', [{ paused: true, streamGeneration: 2 }], ['start:1', 'pause:2'], []],
    ['started: hidden then shown', [], ['start:1', 'pause:2', 'pause:2'], [{ paused: true, streamGeneration: 2 }, { paused: false, streamGeneration: 2 }]],
    ['started: a repeated resume does not restart the chain', [], ['start:1', 'pause:2', 'pause:2'], [{ paused: true, streamGeneration: 2 }, { paused: false, streamGeneration: 2 }, { paused: false, streamGeneration: 2 }]],
    ['started: a second hide/show uses the next generation', [], ['start:1', 'pause:2', 'pause:2', 'pause:3', 'pause:3'],
      [{ paused: true, streamGeneration: 2 }, { paused: false, streamGeneration: 2 }, { paused: true, streamGeneration: 3 }, { paused: false, streamGeneration: 3 }]],
  ]) {
    const fake = electronFake(), pageLog = [], gate = deferred();
    const stateDir = await mkdtemp(pathModule.join(os.tmpdir(), 'screen-reconcile-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
    const sockets = [];
    class Socket extends EventEmitter { static OPEN = 1;
      constructor(url) { super(); this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
      send(data, options, callback) { (typeof options === 'function' ? options : callback)?.(); this.sent.push(typeof data === 'string' ? JSON.parse(data) : data); }
      open() { this.readyState = 1; this.emit('open'); } receive(v) { this.emit('message', Buffer.from(JSON.stringify(v)), false); }
      close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); } terminate() { this.close(); } }
    const display = { id: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1, rotation: 0, label: 'D' };
    let host;
    const service = new ScreenService({ platform: 'darwin', stateDir, WebSocketClass: Socket,
      electron: { screen: Object.assign(new EventEmitter(), { getAllDisplays: () => [display] }), powerMonitor: new EventEmitter(), shell: {},
        systemPreferences: { getMediaAccessStatus: () => 'granted', isTrustedAccessibilityClient: () => true } },
      addon: { screenMouse() {}, screenSession: () => ({ available: true, onConsole: true, locked: false, unique: '00000000-0000-0000-0000-000000000001' }), screenDisplayUuid: () => 'display', screenReleaseAll: () => 0, screenMonitorStop() {} },
      hostControl: { ticket: async () => ({ ticket: 'T'.repeat(43), instancePort: 1 }) },
      captureHost: hooks => (host = new ScreenCaptureHost({ electron: fake.electron, root: '/x', preload: '/p.cjs', ...hooks, resolveSource: async () => { await gate.promise; return { id: 'src' }; } })) });
    t.after(() => service.dispose());
    await service.start();
    for (let i = 0; i < 200 && !sockets.length; i++) await new Promise(r => setTimeout(r, 5));
    const [control] = sockets; control.open(); control.receive({ type: 'registered', epoch: 'e', serverTime: Date.now() });
    const session = { id: 'screen_1', desktopId: service.desktopId, deviceId: 'v', deviceName: 'V', generation: 'g', display: service.status().desktop.displays[0], controlAllowed: true, state: 'connecting', createdAt: Date.now() };
    control.receive({ type: 'start', session, mediaTicket: 'M'.repeat(43), streamGeneration: 1, codecs: ['h264'] });
    const media = sockets.find(s => s.url.endsWith('/target-media')); media.open(); media.receive({ type: 'attached', sessionId: session.id });
    await new Promise(r => setTimeout(r, 10));
    fake.windows[0].onPage = data => pageLog.push(`${data.type}:${data.streamGeneration ?? ''}`);
    for (const c of commands) control.receive({ type: 'pause', sessionId: session.id, ...c });
    gate.resolve(); await new Promise(r => setTimeout(r, 10));
    fake.windows[0].page.postMessage({ type: 'started', sessionId: session.id }); await new Promise(r => setTimeout(r, 10));
    for (const c of afterStart) control.receive({ type: 'pause', sessionId: session.id, ...c });
    await new Promise(r => setTimeout(r, 10));
    assert.deepEqual([...pageLog], expected, label);
    host.close();
  }
});

test('host: a cancelled start whose await never returns frees its id, and a queued start recovers from its hung opening', async () => {
  // Same id retried after the first attempt timed out on a source that never resolves.
  {
    const fake = electronFake(); let calls = 0;
    const host = new ScreenCaptureHost({ electron: fake.electron, root: '/x', preload: '/p.cjs', onMessage() {}, onGone() {}, startTimeoutMs: 60,
      resolveSource: () => ++calls === 1 ? new Promise(() => {}) : Promise.resolve({ id: 'src' }) });
    const s = () => host.start({ sessionId: 'same', display: { id: 'A', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
    await assert.rejects(s(), /screen_capture_timeout/);
    const retry = s(); await new Promise(r => setTimeout(r, 20));
    fake.windows.at(-1).page.postMessage({ type: 'started', sessionId: 'same' }); await retry;
    host.close();
  }
  // The first opening never gets past the protocol check; the queued start opens afresh.
  {
    const fake = electronFake(), ses = fake.electron.session.fromPartition(); let checks = 0;
    ses.protocol.isProtocolHandled = () => ++checks === 1 ? new Promise(() => {}) : Promise.resolve(false);
    const host = new ScreenCaptureHost({ electron: fake.electron, root: '/x', preload: '/p.cjs', onMessage() {}, onGone() {}, startTimeoutMs: 60, resolveSource: async () => ({ id: 'src' }) });
    const a = host.start({ sessionId: 'a', display: { id: 'A', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
    const b = host.start({ sessionId: 'b', display: { id: 'B', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
    await assert.rejects(a, /screen_capture_timeout/);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(checks, 2, 'b began a fresh opening');
    fake.windows.at(-1).page.postMessage({ type: 'started', sessionId: 'b' }); await b;
    assert.equal(host.active, true);
    host.close();
  }
});

test('host: a cancelled run reaching its cleanup late never stops a newer session that reuses the id', async () => {
  const fake = electronFake();
  const host = new ScreenCaptureHost({ electron: fake.electron, root: '/x', preload: '/p.cjs', onMessage() {}, onGone() {}, resolveSource: async () => ({ id: 'src' }) });
  const keep = host.start({ sessionId: 'keep', display: { id: 'K', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
  await new Promise(r => setTimeout(r, 10)); fake.windows[0].page.postMessage({ type: 'started', sessionId: 'keep' }); await keep;
  const sent = []; fake.windows[0].onPage = data => sent.push(`${data.type}:${data.sessionId}`);
  const first = host.start({ sessionId: 'x', display: { id: 'A', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
  await new Promise(r => setTimeout(r, 10));                // first 'x' is waiting for the page
  host.stop('x'); await assert.rejects(first, /screen_capture_cancelled/);
  const second = host.start({ sessionId: 'x', display: { id: 'A', revision: 1 }, streamGeneration: 1, codecs: ['h264'], encode: { width: 2, height: 2 } });
  await new Promise(r => setTimeout(r, 10));
  fake.windows[0].page.postMessage({ type: 'started', sessionId: 'x' }); await second;
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(sent, ['start:x', 'stop:x', 'start:x'], 'exactly one stop, for the first attempt');
  host.close();
});
