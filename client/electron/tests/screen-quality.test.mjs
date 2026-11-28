// Quality profiles on the target: real capture constraints, encoder size,
// frame rate and quantizer/bitrate; hello negotiation with old/new Hosts.
// Fakes only: no screen is captured and no input is posted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCaptureCore, CAPTURE_CREDITS, FLIGHT_BYTES, OUTPUT_MAX_AGE_MS, PACE_BURST_BYTES, PACE_BYTES_PER_MS, PACE_BYTES_PER_MS_MAX } from '../screen-capture-core.mjs';
import { ScreenCaptureHost } from '../screen-capture-host.mjs';
import { ScreenService } from '../screen-service.mjs';
import { encodeSize, SCREEN_ENCODE_AREA, SCREEN_ENCODE_LONG_EDGE } from '../screen-geometry.mjs';
import { writeScreenFrame } from '../../../src/client-protocol/screen-wire.ts';
import { SCREEN_QUALITY_PROFILES, screenH264Codec, screenH264EncoderCodec, screenQualityProfile, screenRateLadder } from '../../../src/client-protocol/screen-quality.ts';
import { screenServiceCommandSchema, screenServiceHelloSchema, screenStreamSchema } from '../../../src/client-protocol/remote-screen.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));

// ---------------- capture core ----------------
function browser({ supported = ['quantizer', 'variable'], codecs = ['avc1.640028', 'avc1.64002A', 'avc1.640033', 'avc1.640034', 'vp8'], chunkBytes = 3, maxRate = Infinity } = {}) {
  const sent = [], encoders = [], requests = [], probes = [], pending = [];
  let pushFrame, perf = 0, clock = 1_800_000_000_000;
  class Encoder {
    static async isConfigSupported(config) { probes.push(config); return { supported: supported.includes(config.bitrateMode) && codecs.includes(config.codec) && config.framerate <= maxRate }; }
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
    MediaStreamTrackProcessor: Processor, writeScreenFrame, now: () => Math.round(clock), perf: () => perf,
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
  // 1440×900 points @2x: balanced/legacy = 1818×1136, sharp = native 2880×1800.
  // Rate: smooth and balanced ask for 120, sharp for 60; the legacy start stays at 15.
  // The stream declares the size's own level (what viewers have always been sent: 4.0, or 5.1 above 1080p-class);
  // the encoder is given the level the size needs AT THAT RATE (4.2, 5.1 and 5.2 here).
  const expected = { smooth: [1280, 800, 32, 42, 'avc1.640028', 'avc1.64002A', 120], balanced: [1818, 1136, 28, 40, 'avc1.640028', 'avc1.640033', 120],
    qhd: [2428, 1516, 28, 40, 'avc1.640033', 'avc1.640033', 60],
    sharp: [2880, 1800, 28, 40, 'avc1.640033', 'avc1.640034', 60], legacy: [1818, 1136, 28, 40, 'avc1.640028', 'avc1.640028', 15] };
  for (const [quality, [width, height, qpBase, qpMax, codecString, level, fps]] of Object.entries(expected)) {
    const b = browser(); await b.core.handle(startMessage(quality === 'legacy' ? undefined : quality)); await tick();
    assert.deepEqual(b.requests[0].video, { cursor: 'always', frameRate: { max: fps }, width: { max: width }, height: { max: height } }, `${quality}: capture constraints`);
    assert.deepEqual([b.encoders[0].config.width, b.encoders[0].config.height, b.encoders[0].config.framerate, b.encoders[0].config.bitrateMode], [width, height, fps, 'quantizer']);
    const stream = b.sent.find(m => m.type === 'stream').stream;
    assert.deepEqual([stream.width, stream.height, stream.codecString, b.encoders[0].config.codec], [width, height, codecString, level]);
    assert.doesNotThrow(() => screenStreamSchema.parse(stream), `${quality}: stream fits the shared schema`);
    if (quality !== 'sharp' && quality !== 'qhd') assert.ok(width <= 1920 && height <= 1920 && width * height <= 1920 * 1080, `${quality}: inside the pre-quality (old-viewer) contract`);
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

test('core: above the legacy rate a viewer that follows faster than it keeps its quantizer; below it, or at 15 fps, crowding still coarsens', async () => {
  const b = browser(); await b.core.handle(startMessage('smooth')); await tick();
  const session = b.core.sessions.get('s1'), base = session.qp;
  // 40 of 60 frames could not be taken, 20 got through: slower than the source, not congested.
  for (let i = 0; i < 5; i++) { session.crowded = 40; session.encoded = 20; b.adapt(); }
  assert.equal(session.qp, base, 'a 20 fps viewer keeps the resting quantizer');
  // Fewer than a quarter got through: the congestion response applies.
  session.crowded = 52; session.encoded = 8; b.adapt();
  assert.equal(session.qp, base + 3);
  assert.deepEqual([session.crowded, session.encoded], [0, 0], 'both counters restart every second');
  // Byte starvation coarsens at any rate.
  session.starved = 1; session.encoded = 60; b.adapt();
  assert.equal(session.qp, base + 6);
  // A 15 fps session is judged exactly as before, whatever got through.
  const c = browser(); await c.core.handle(startMessage(undefined)); await tick();
  const legacy = c.core.sessions.get('s1'), legacyBase = legacy.qp;
  legacy.crowded = 3; legacy.encoded = 13; c.adapt();
  assert.equal(legacy.qp, legacyBase + 3);
});

/** Drives real frames through the core on the fake clock: a source that repaints
 * at `source` Hz while `moving(ms)`, an encoder that outputs at once, and a
 * viewer. A frame reaches the viewer half of `loop` ms after it was sent; the
 * viewer takes frames one at a time, `decode` ms each; its receipt travels the
 * other half back. With `held`, each receipt says how long the viewer kept the
 * frame. Returns the quantizer after every second, the frames sent and the
 * most frames ever unacknowledged at once. */
async function drive(b, { seconds, loop, decode = 0, held = false, moving = () => true, source = 60, width = 1280, height = 800 }) {
  const session = b.core.sessions.get('s1'), step = 1000 / source, receipts = [], qp = [];
  let at = 0, seen = 0, last = 0, second = 1000, most = 0;
  for (let ms = 0; ms < seconds * 1000; ms += step) {
    b.advance(step); at += step; b.run();
    while (receipts.length && receipts[0].at <= at) { const receipt = receipts.shift(); await b.core.handle({ type: 'credit', sessionId: 's1', frameSequence: receipt.sequence, streamGeneration: 1, ...(held ? { heldMs: receipt.heldMs } : {}) }); }
    if (moving(ms)) { b.push(b.frame(width, height)); await tick(); }
    const encoder = b.encoders.at(-1);
    while (encoder.encodes.length > encoder.emitted) encoder.emit(encoder.emitted ? 'delta' : 'key');
    const frames = b.sent.filter(m => m.type === 'frame');
    for (; seen < frames.length; seen++) { const arrived = at + loop / 2; last = Math.max(arrived, last) + decode; receipts.push({ at: last + loop / 2, sequence: frames[seen].sequence, heldMs: Math.round(last - arrived) }); }
    most = Math.max(most, session.outstanding.size);
    if (at >= second) { b.adapt(); qp.push(session.qp); second += 1000; }
  }
  return { qp, frames: b.sent.filter(m => m.type === 'frame').length, most };
}

/** One session on a modelled path, 1 ms resolution: a 60 Hz source, an encoder
 * that outputs at once (`size(key, session)` bytes), then in order a forward
 * link (`bw` bytes/ms, serial), `down` ms of delay, a phone bridge (`bridge`
 * ms a frame, serial, BEFORE the page stamps the frame, so not in `heldMs`), a
 * decoder (`decode` ms a frame, serial, in `heldMs`) and `up` ms back.
 * Returns frames delivered a second and the median time from leaving the
 * target to being decoded (both after `warm` seconds), the most frames and
 * bytes ever unacknowledged, and the reason if the session ended. */
async function link({ quality = 'smooth', fps, flight, held = true, source = 60, down = 50, up = 50, bw = Infinity, bridge = 0, decode = 0,
  size = key => key ? 60_000 : 3_000, seconds = 8, warm = 3, lie } = {}) {
  const b = browser(); await b.core.handle(startMessage(quality, { ...(fps ? { fps } : {}), ...(flight ? { flight } : {}) })); await tick();
  const session = b.core.sessions.get('s1'), receipts = [], frames = new Map();
  let seen = 0, linkFree = 0, bridgeFree = 0, decodeFree = 0, nextSource = 0, second = 1000, most = 0, mostBytes = 0, ended;
  for (let at = 1; at <= seconds * 1000 && !ended; at++) {
    b.advance(1); b.run();
    while (receipts.length && receipts[0].at <= at) { const r = receipts.shift(); await b.core.handle({ type: 'credit', sessionId: 's1', frameSequence: r.sequence, streamGeneration: 1, ...(held ? { heldMs: r.heldMs } : {}) }); }
    if (at >= nextSource) { nextSource += 1000 / source; b.push(b.frame(1280, 800)); await tick(); }
    const encoder = b.encoders.at(-1);
    while (encoder.encodes.length > encoder.emitted) { const key = encoder.encodes[encoder.emitted].keyFrame; encoder.emit(key ? 'key' : 'delta', Math.max(40, Math.round(size(key, session)))); }
    const sent = b.sent.filter(m => m.type === 'frame');
    for (; seen < sent.length; seen++) {
      const bytes = sent[seen].bytes.byteLength;
      const departed = Math.max(at, linkFree) + (Number.isFinite(bw) ? bytes / bw : 0); linkFree = departed;
      const page = Math.max(departed + down, bridgeFree) + bridge; bridgeFree = page;
      const done = Math.max(page, decodeFree) + decode; decodeFree = done;
      const truly = Math.min(2000, Math.round(done - page));
      frames.set(sent[seen].sequence, { sentAt: at, done, bytes });
      receipts.push({ at: done + up, sequence: sent[seen].sequence, heldMs: lie ? lie(truly) : truly }); receipts.sort((x, y) => x.at - y.at);
    }
    most = Math.max(most, session.outstanding.size);
    let bytes = 0; for (const entry of session.outstanding.values()) bytes += entry.bytes ?? 0; mostBytes = Math.max(mostBytes, bytes);
    if (at >= second) { b.adapt(); second += 1000; }
    ended = b.sent.find(m => m.type === 'ended')?.reason;
  }
  const settled = [...frames.values()].filter(f => f.sentAt >= warm * 1000 && f.done <= seconds * 1000), delays = settled.map(f => f.done - f.sentAt).sort((x, y) => x - y);
  return { fps: settled.length / (seconds - warm), delay: delays[Math.floor(delays.length / 2)], most, mostBytes, ended, rtt: session.rtt, cadence: session.cadence };
}

test('flight window: on a long path a viewer that keeps up gets the frame rate, at the profile ceiling too; without a capacity or a held time it stays at three', async () => {
  // 100 ms there and back, the source repainting at 60: six frames are in transit at any moment.
  for (const [name, options] of [['asked for 60', { fps: 60 }], ['the profile ceiling of 120, source still 60', {}], ['200 ms', { down: 100, up: 100 }]]) {
    const wide = await link({ flight: 16, ...options });
    assert.ok(wide.fps > 56, `${name}: about 60 a second (${wide.fps})`);
    assert.ok(wide.most <= 2 + Math.ceil((options.down ?? 50) * 2 / (1000 / 60)) && wide.most > 5, `${name}: the frames in transit plus two at most, not twice that (${wide.most})`);
    assert.ok(wide.delay < (options.down ?? 50) + 12, `${name}: nothing queues (${wide.delay} ms to decoded)`);
  }
  for (const [name, three] of [['no capacity named', await link({ fps: 60 })], ['no held time reported', await link({ fps: 60, flight: 16, held: false })]]) {
    assert.equal(three.most, 3, name);
    assert.ok(three.fps > 24 && three.fps < 34, `${name}: three a round trip (${three.fps})`);
  }
  assert.equal((await link({ flight: 5, down: 120, up: 120 })).most, 5, 'never beyond what the viewer said it holds');
});

test('flight window: a viewer or a link that returns frames slowly keeps a window near three however long the path', async () => {
  // Each row: the same path with three, then with a capacity of 16. More frames a second when there are any to gain, and never a queue.
  for (const [name, options, most, extra] of [
    ['decodes in 25 ms, 100 ms path', { decode: 25 }, 6, 60],
    ['decodes in 40 ms, 100 ms path', { decode: 40 }, 5, 90],
    ['decodes in 60 ms, 100 ms path', { decode: 60 }, 4, 90],
    ['decodes in 100 ms, 250 ms path', { decode: 100, down: 125, up: 125, seconds: 14, warm: 6 }, 5, 150],
    ['a 1 Mbit/s link, text scrolling', { bw: 125, size: key => key ? 150_000 : 2_400, seconds: 14, warm: 6 }, 16, 60],
    ['a 2 Mbit/s link, the whole picture repainting', { quality: 'balanced', bw: 250, size: (key, s) => (key ? 150_000 : 14_000) * 2 ** (-(s.qp - s.profile.qpBase) / 6), seconds: 16, warm: 8 }, 6, 120],
    ['a phone bridge of 35 ms a frame, 4 ms path', { bridge: 35, down: 2, up: 2 }, 3, 5],
    ['a short path, 60 ms decoder', { decode: 60, down: 2, up: 2 }, 3, 5],
  ]) {
    const three = await link(options), wide = await link({ ...options, flight: 16 });
    assert.equal(wide.ended, undefined, name);
    assert.ok(wide.most <= most, `${name}: at most ${most} in flight (${wide.most})`);
    assert.ok(wide.fps >= three.fps - 1.5, `${name}: no slower than with three (${wide.fps} against ${three.fps})`);
    assert.ok(wide.delay <= three.delay + extra, `${name}: at most ${extra} ms later than with three (${wide.delay} against ${three.delay})`);
  }
});

test('flight window: beyond three frames the unacknowledged bytes are bounded; a held time that cannot be true is left out', async () => {
  // 90 KB frames on a long, fast path: frames alone would allow sixteen (1.4 MB toward a viewer the Hub ends at 1 MiB).
  const heavy = await link({ quality: 'sharp', flight: 16, down: 150, up: 150, size: key => key ? 200_000 : 90_000, seconds: 6, warm: 2 });
  assert.equal(heavy.ended, undefined);
  assert.ok(heavy.mostBytes <= FLIGHT_BYTES + 90_032, `unacknowledged bytes ${heavy.mostBytes}`);
  assert.ok(heavy.most >= 3 && heavy.most < 9, `fewer frames than the path alone would take (${heavy.most})`);
  // A viewer that claims to have held every frame for longer than the frame has existed: no round trip, so three.
  const liar = await link({ flight: 16, lie: () => 2000 });
  assert.deepEqual([liar.most, liar.rtt], [3, Infinity]);
  // One such receipt among honest ones does not pin the session at three.
  let n = 0; const once = await link({ flight: 16, lie: truly => ++n === 4 ? 2000 : truly });
  assert.ok(once.most > 5 && once.fps > 56, `recovered: ${once.most} in flight, ${once.fps} a second`);
});

test('flight window: the round trip survives a new generation; the receipt pace is not read from a gap in which nothing was owed', async () => {
  const b = browser(); await b.core.handle(startMessage('smooth', { fps: 60, flight: 16 })); await tick();
  const session = b.core.sessions.get('s1');
  const send = async (sequence, generation) => { b.push(b.frame(1280, 800)); await tick(); b.encoders.at(-1).emit(session.outstanding.size === 1 && !session.chainStarted ? 'key' : 'delta'); assert.ok(session.outstanding.has(sequence)); return generation; };
  const receipt = (frameSequence, streamGeneration, heldMs) => b.core.handle({ type: 'credit', sessionId: 's1', frameSequence, streamGeneration, heldMs });
  await send(1, 1); b.advance(80); await receipt(1, 1, 10);
  assert.equal(session.rtt, 70);
  assert.equal(session.cadence, undefined, 'one receipt is not a pace');
  // Five seconds of an idle screen, then one frame: that gap says nothing about the viewer.
  b.advance(5000); await send(2, 1); b.advance(80); await receipt(2, 1, 10);
  assert.equal(session.cadence, undefined);
  // Two frames owed at once: the gap between their receipts is the pace. A receipt for the later one covers both.
  b.advance(100); await send(3, 1); b.advance(17); await send(4, 1); b.advance(17); await send(5, 1);
  b.advance(60); await receipt(3, 1, 5); b.advance(40); await receipt(5, 1, 5);
  assert.equal(session.cadence, 20, 'forty milliseconds for two frames');
  assert.equal(session.outstanding.size, 0);
  // A reset starts a new generation: the path is the same one.
  await b.core.handle({ type: 'reset', sessionId: 's1', streamGeneration: 2, geometryRevision: 1 });
  assert.deepEqual([session.rtt, session.cadence, session.owed], [70, 20, false]);
});

test('crowding, driven: motion in spurts over a long round trip keeps the resting quantizer', async () => {
  // 60 fps, receipts 100 ms after each frame: three credits are used up within 50 ms of any motion.
  for (const [name, moving] of [['typing: 100 ms in every 500', ms => ms % 500 < 100], ['scroll: 250 ms every 3 s', ms => ms % 3000 < 250], ['300 ms every 2 s', ms => ms % 2000 < 300]]) {
    const b = browser(); await b.core.handle(startMessage('smooth', { fps: 60 })); await tick();
    const run = await drive(b, { seconds: 12, loop: 100, moving });
    assert.deepEqual([...new Set(run.qp)], [32], name);
    assert.ok(run.frames > 20, `${name}: frames flowed (${run.frames})`);
  }
});

test('crowding, driven: a viewer that follows at 25 of 60 keeps its quantizer; one that follows at 10 is coarsened to the ceiling', async () => {
  const follow = browser(); await follow.core.handle(startMessage('smooth', { fps: 60 })); await tick();
  const quick = await drive(follow, { seconds: 8, loop: 10, decode: 40 });
  assert.deepEqual([...new Set(quick.qp)], [32]);
  assert.ok(quick.frames > 8 * 20 && quick.frames < 8 * 30, `about 25 a second got through (${quick.frames})`);
  const slow = browser(); await slow.core.handle(startMessage('smooth', { fps: 60 })); await tick();
  const run = await drive(slow, { seconds: 8, loop: 10, decode: 100 });
  assert.equal(run.qp.at(-1), 42, `rose to the ceiling: ${run.qp}`);
  assert.ok(run.qp[1] > 32, 'and started within two seconds');
});

test('crowding, driven: an encoder held to 15 by the fallback ladder is not crowded by the frames its schedule skips', async () => {
  const b = browser({ maxRate: 15 }); await b.core.handle(startMessage('smooth')); await tick();
  assert.deepEqual([b.encoders[0].config.framerate, b.requests[0].video.frameRate.max], [15, 120], 'the capture keeps the profile rate, the encoder runs at 15');
  const run = await drive(b, { seconds: 8, loop: 5 });
  assert.deepEqual([...new Set(run.qp)], [32]);
  assert.ok(run.frames >= 8 * 14 && run.frames <= 8 * 16, `15 a second were encoded (${run.frames})`);
});

test('crowding, driven: at the legacy rate a viewer that drops more than two frames a second is coarsened, as before', async () => {
  const b = browser(); await b.core.handle(startMessage(undefined)); await tick();
  const run = await drive(b, { seconds: 6, loop: 10, decode: 100, source: 15, width: 1818, height: 1136 });
  assert.equal(run.qp.at(-1), 40, `rose to the ceiling: ${run.qp}`);
});

test('codec: the declared string depends on size alone; the encoder level is the lowest that carries the size at the rate', () => {
  // Declared to viewers: unchanged by the rate.
  assert.equal(screenH264Codec(1920, 1080), 'avc1.640028');
  assert.equal(screenH264Codec(1818, 1136), 'avc1.640028');
  assert.equal(screenH264Codec(2880, 1800), 'avc1.640033');
  assert.equal(screenH264Codec(8192, 8192), undefined);
  // Given to the encoder.
  for (const [width, height, fps, level] of [[1920, 1080, 15, 'avc1.640028'], [1920, 1080, 30, 'avc1.640028'], [1280, 800, 60, 'avc1.640028'], [1280, 800, 120, 'avc1.64002A'],
    [1920, 1080, 60, 'avc1.64002A'], [1818, 1136, 60, 'avc1.64002A'], [1920, 1080, 120, 'avc1.640033'], [2880, 1800, 30, 'avc1.640033'], [2880, 1800, 60, 'avc1.640034'],
    [2880, 1800, 120, undefined], [8192, 8192, 15, undefined]]) assert.equal(screenH264EncoderCodec(width, height, fps), level, `${width}x${height}@${fps}`);
  assert.deepEqual([screenRateLadder(120), screenRateLadder(60), screenRateLadder(30), screenRateLadder(15), screenRateLadder(24)], [[120, 60, 30, 15], [60, 30, 15], [30, 15], [15], [24, 15]]);
});

test('core: an encoder that cannot take the profile rate gets H.264 at the next lower rate, before VP8 at any rate', async () => {
  // No level 5.1: a 1080p-class picture cannot be encoded at 120, so it runs at 60 (level 4.2).
  const b = browser({ codecs: ['avc1.640028', 'avc1.64002A', 'vp8'] }); await b.core.handle(startMessage('balanced')); await tick();
  const session = b.core.sessions.get('s1'), stream = b.sent.find(m => m.type === 'stream').stream;
  assert.deepEqual([b.encoders[0].config.codec, b.encoders[0].config.framerate, stream.codec, stream.codecString], ['avc1.64002A', 60, 'h264', 'avc1.640028']);
  assert.deepEqual([session.profile.fps, session.interval], [60, 1000 / 60], 'the whole session runs at the accepted rate');
  // A reset keeps the choice.
  await b.core.handle({ type: 'reset', sessionId: 's1', streamGeneration: 2, geometryRevision: 1 });
  assert.equal(b.encoders[1].config.framerate, 60);
  // Level 4.0 only: two steps down, to 30.
  const d = browser({ codecs: ['avc1.640028', 'vp8'] }); await d.core.handle({ ...startMessage('balanced'), codecs: ['h264', 'vp8'] }); await tick();
  assert.deepEqual([d.encoders[0].config.codec, d.encoders[0].config.framerate], ['avc1.640028', 30]);
  // VP8 only: the profile rate is still tried first.
  const c = browser({ codecs: ['vp8'] }); await c.core.handle({ ...startMessage('balanced'), codecs: ['h264', 'vp8'] }); await tick();
  assert.deepEqual([c.encoders[0].config.codec, c.encoders[0].config.framerate], ['vp8', 120]);
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
  await b.core.handle(startMessage('sharp', { fps: 240, profile: { qpBase: -5, qpMax: 99, bitrate: 1e12, bytesPerMs: 1e9 } })); await tick();
  assert.equal(b.requests[0].video.frameRate.max, 120, 'never above the renderer ceiling');
  // No H.264 level carries 2880×1800 at 120: it runs at the next lower rate.
  assert.equal(b.encoders[0].config.framerate, 60);
  const session = b.core.sessions.get('s1');
  assert.deepEqual([session.profile.qpBase, session.profile.qpMax, session.profile.bitrate, session.interval, session.profile.pace], [10, 51, 4_000_000, 1000 / 60, PACE_BYTES_PER_MS_MAX]);
  // The byte budget is never below the default, and is the default when main names none.
  const low = browser(); await low.core.handle(startMessage('sharp', { profile: { bytesPerMs: 1 } })); await tick();
  const none = browser(); await none.core.handle(startMessage('sharp')); await tick();
  assert.deepEqual([low.core.sessions.get('s1').profile.pace, none.core.sessions.get('s1').profile.pace], [PACE_BYTES_PER_MS, PACE_BYTES_PER_MS]);
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
  const ws = sockets(), starts = [], stops = []; let hooks, capture;
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2, rotation: 0, label: 'Display' };
  const electron = { screen: Object.assign(new EventEmitter(), { getAllDisplays: () => [display] }), powerMonitor: new EventEmitter(),
    systemPreferences: { getMediaAccessStatus: () => 'granted', isTrustedAccessibilityClient: () => true }, shell: {} };
  const addon = { screenSession: () => ({ available: true, onConsole: true, locked: false, unique: '00000000-0000-0000-0000-000000000001' }), screenDisplayUuid: () => 'display',
    screenMouse() {}, screenReleaseAll: () => 0, screenMonitorStop() {}, screenMonitorPoll: () => ({ alive: false, foreign: 0, interrupted: 0 }) };
  const service = new ScreenService({ electron, addon, stateDir, platform: 'darwin', WebSocketClass: ws.FakeSocket,
    hostControl: { ticket: async () => ({ ticket: 'T'.repeat(43), instancePort: 1234, ...(capabilities ? { capabilities } : {}) }) },
    captureHost: callbacks => (hooks = callbacks, capture = { start: async s => { starts.push(s); }, stop: id => stops.push(id), reset() { return true; }, pause() { return true; }, credit() {}, keyframe() {}, close() {} }) });
  t.after(() => service.dispose());
  await service.start(); await tick();
  const [control] = ws.find('/screen/v1/target');
  control.open(); await tick();
  const hello = control.sent[0];
  control.receive({ type: 'registered', epoch: 'desktop_epoch', serverTime: Date.now() });
  let n = 0;
  const open = (quality, extra = {}) => {
    const session = { id: `screen_${++n}`, desktopId: service.desktopId, deviceId: 'viewer', deviceName: 'Viewer', generation: `generation_${n}`,
      display: service.status().desktop.displays[0], controlAllowed: true, state: 'connecting', createdAt: Date.now() };
    control.receive({ type: 'start', session, mediaTicket: 'M'.repeat(43), streamGeneration: 1, codecs: ['h264'], ...(quality !== undefined ? { quality } : {}), ...extra });
    const media = ws.find('/screen/v1/target-media').at(-1);
    return { session, media };
  };
  const attach = async ({ session, media }) => { media.open(); media.receive({ type: 'attached', sessionId: session.id }); await tick(); };
  return { service, control, hello, open, attach, starts, stops, ws, hooks: () => hooks, capture: () => capture };
}
const legacyHello = screenServiceHelloSchema.omit({ features: true }).strict();

test('service: a Host without the rate capability keeps every profile at the legacy 15 frames a second', async t => {
  const f = await target(t, { capabilities: ['screen-quality-v1'] });
  for (const quality of [undefined, 'smooth', 'balanced', 'sharp']) {
    const opened = f.open(quality); await f.attach(opened);
    assert.equal(f.starts.at(-1).fps, 15, String(quality));
    f.service.stop(opened.session.id);
  }
});

test('service: the viewer capacity on start and the delay on each receipt reach the capture; neither is invented when absent', async t => {
  const f = await target(t, { capabilities: ['screen-quality-v1', 'screen-rate-v1'] });
  const credits = []; f.capture().credit = (...args) => credits.push(args);
  const wide = f.open('balanced', { flight: 12 }); await f.attach(wide);
  assert.equal(f.starts.at(-1).flight, 12);
  const frame = sequence => f.hooks().onMessage({ type: 'frame', sessionId: wide.session.id, sequence, streamGeneration: 1, captureMs: Date.now(), geometryRevision: wide.session.display.revision, key: sequence === 1, bytes: new Uint8Array(40) });
  frame(1); f.control.receive({ type: 'ack', sessionId: wide.session.id, frameSequence: 1, streamGeneration: 1, heldMs: 14 });
  frame(2); f.control.receive({ type: 'ack', sessionId: wide.session.id, frameSequence: 2, streamGeneration: 1 });
  assert.deepEqual(credits, [[wide.session.id, 1, 1, 14], [wide.session.id, 2, 1, undefined]]);
  f.service.stop(wide.session.id);
  const plain = f.open('balanced'); await f.attach(plain);
  assert.equal('flight' in f.starts.at(-1), false);
});

test('service: a byte budget named by the Host paces the capture 15% below it; none named leaves the start as it was', async t => {
  const f = await target(t, { capabilities: ['screen-quality-v1', 'screen-rate-v1'] });
  const direct = f.open('balanced', { mediaBytesPerMs: 5000 }); await f.attach(direct);
  assert.equal(f.starts.at(-1).profile.bytesPerMs, 4250);
  f.service.stop(direct.session.id);
  const relayed = f.open('balanced'); await f.attach(relayed);
  assert.equal('bytesPerMs' in f.starts.at(-1).profile, false);
});

test('core pacer: with a local-network budget the same busy picture keeps its rate and its quantizer, still inside that budget', async () => {
  const b = browser({ chunkBytes: 200_000 }); await b.core.handle(startMessage('balanced', { fps: 15, profile: { qpBase: 28, qpMax: 40, bitrate: 2_500_000, h264Only: false, bytesPerMs: 4250 } })); await tick();
  const session = b.core.sessions.get('s1');
  let encodes = 0;
  for (let i = 0; i < 150; i++) { // 10 s at 15 fps of 200 kB frames = 24 Mbps offered, 34 Mbps allowed
    b.advance(67); b.push(b.frame(1818, 1136)); await tick(); b.run();
    const encoder = b.encoders.at(-1);
    while (encoder.encodes.length > encodes) { encodes++; encoder.emit(encodes === 1 ? 'key' : 'delta'); await b.core.handle({ type: 'credit', sessionId: 's1', frameSequence: encodes, streamGeneration: 1 }); }
    if (i % 15 === 14) b.adapt();
  }
  const frames = b.sent.filter(m => m.type === 'frame'), bytes = frames.reduce((n, m) => n + m.bytes.byteLength, 0);
  assert.equal(frames.length, 150, 'every captured frame was encoded and sent');
  assert.equal(session.qp, 28, 'the quantizer stayed at rest');
  assert.ok(bytes / (150 * 67) < 5000, 'average below the Hub local-network refill (5000 B/ms)');
});

test('service: the hello carries features only when the Host advertised quality; an old Host gets the exact legacy hello', async t => {
  const old = await target(t);
  assert.deepEqual(Object.keys(old.hello), ['type', 'ticket', 'desktop']);
  assert.doesNotThrow(() => legacyHello.parse(old.hello), 'an older Hub (strict hello) still accepts it');
  const unrelated = await target(t, { capabilities: ['target-stop', 'screen-service-ticket'] });
  assert.equal('features' in unrelated.hello, false);
  const quality = await target(t, { capabilities: ['target-stop', 'screen-service-ticket', 'screen-quality-v1'] });
  assert.deepEqual(quality.hello.features, ['screen.quality.v1'], 'a Host that only negotiates quality gets the hello it always got');
  const current = await target(t, { capabilities: ['target-stop', 'screen-service-ticket', 'screen-quality-v1', 'screen-qhd-v1', 'screen-rate-v1'] });
  assert.deepEqual(current.hello.features, ['screen.quality.v1', 'screen.qhd.v1', 'screen.pace.v1', 'screen.flight.v1']);
  assert.throws(() => legacyHello.parse(current.hello), 'proves why it must be gated');
  assert.doesNotThrow(() => screenServiceHelloSchema.parse(current.hello));
});

test('QHD encodes at 2560×1440 or 1440×2560 on large 16:9 displays', () => {
  const qhd = SCREEN_QUALITY_PROFILES.qhd;
  assert.deepEqual(encodeSize({ width: 3840, height: 2160, scale: 1 }, qhd), { width: 2560, height: 1440 });
  assert.deepEqual(encodeSize({ width: 2160, height: 3840, scale: 1 }, qhd), { width: 1440, height: 2560 });
  assert.deepEqual(encodeSize({ width: 1920, height: 1080, scale: 1 }, qhd), { width: 1920, height: 1080 });
});

test('service: the start quality selects the real capture profile; omitted = legacy balanced', async t => {
  const f = await target(t, { capabilities: ['screen-quality-v1', 'screen-rate-v1'] });
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
  const f = await target(t, { capabilities: ['screen-quality-v1', 'screen-rate-v1'] });
  const before = f.ws.find('/screen/v1/target-media').length;
  f.control.receive({ type: 'start', session: { id: 'screen_x', desktopId: f.service.desktopId, deviceId: 'viewer', deviceName: 'Viewer', generation: 'generation_x',
    display: f.service.status().desktop.displays[0], controlAllowed: true, state: 'connecting', createdAt: Date.now() }, mediaTicket: 'M'.repeat(43), streamGeneration: 1, codecs: ['h264'], quality: 'ultra' });
  await tick();
  assert.equal(f.ws.find('/screen/v1/target-media').length, before);
  assert.equal(f.starts.length, 0);
  assert.equal(screenServiceCommandSchema.safeParse({ type: 'start', quality: 'ultra' }).success, false);
});

test('service: a late `attached` after a quality session was stopped never starts capture', async t => {
  const f = await target(t, { capabilities: ['screen-quality-v1', 'screen-rate-v1'] });
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
  const f = await target(t, { capabilities: ['screen-quality-v1', 'screen-rate-v1'] });
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
