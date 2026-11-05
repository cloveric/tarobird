// Capture/encode logic of the isolated capture renderer. Browser APIs are
// injected so the generation, credit and race rules are testable without a
// real screen. The page entry (screen-capture-page.mjs) passes real globals.
import { screenH264Codec } from '../../src/client-protocol/screen-quality.ts';
export const CAPTURE_CREDITS = 3;
/** A raw frame that waited this long for a credit is dropped, never encoded:
 * the Host refuses frames older than 2 s, and a stale delta cannot be skipped. */
export const CAPTURE_HELD_MAX_MS = 1500;
/** Encoded-byte pacing below the Hub's per-source media budget (500 B/ms with
 * a 1 MiB burst; exceeding it ends the session as `screen_bandwidth_exceeded`).
 * Two gates share one bucket. Before encode, the newest raw frame waits
 * (latest wins, as for credits) while the bucket cannot cover what is already
 * committed plus the expected frame, and the quantizer rises. After encode,
 * every packet waits in FIFO order until the bucket covers its ACTUAL size:
 * up to three encodes may be in flight and their outputs can arrive together.
 * With a smaller cap and slower refill than the Hub's, the Hub bucket stays at
 * least 256 KiB above this one when send and arrival coincide, so a packet
 * this gate sends always fits there. A legal packet above this cap (≤1 MiB)
 * waits for a full bucket with nothing unacknowledged in flight. Nothing
 * encoded is dropped or reordered: a packet that cannot leave before it would
 * be too old for the Host ends the session (`screen_congested`). */
export const PACE_BYTES_PER_MS = 425, PACE_BURST_BYTES = 768 * 1024;
/** Latest send age for a packet: the Host refuses frames older than 2 s on arrival. */
export const OUTPUT_MAX_AGE_MS = 1800;
/** Legacy (balanced) encoder settings, used when main sends no profile. */
const QP_BASE = 28, QP_MAX = 40, BITRATE = 2_500_000, FPS_MAX = 15;
const bounded = (value, min, max, fallback) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
/** Main's quality profile, clamped to what this renderer will ever encode. */
function encoderProfile(fps, profile) {
  const qpBase = Math.round(bounded(profile?.qpBase, 10, 51, QP_BASE));
  return { fps: bounded(fps, 1, FPS_MAX, FPS_MAX), qpBase, qpMax: Math.round(bounded(profile?.qpMax, qpBase, 51, Math.max(qpBase, QP_MAX))),
    bitrate: Math.round(bounded(profile?.bitrate, 250_000, 4_000_000, BITRATE)), h264Only: profile?.h264Only === true };
}

export function createCaptureCore(env) {
  const { send, getDisplayMedia, VideoEncoder, VideoFrame, OffscreenCanvas, MediaStreamTrackProcessor, writeScreenFrame,
    now = Date.now, perf = () => performance.now(), timers = globalThis } = env;
  const sessions = new Map(), chains = new Map(), cancelled = new Set();

  function fail(session, reason, error) {
    if (session && sessions.get(session.sessionId) === session) close(session);
    send({ type: 'ended', sessionId: session?.sessionId, reason, detail: String(error?.name ?? error?.message ?? '').slice(0, 64) });
  }
  /** Commands of one session run strictly in order; sessions do not block each
   * other. Stop is applied at once (even before its start has run) and the
   * epoch barrier makes any in-flight start/reset abandon its work. */
  function handle(message) {
    const id = message?.sessionId;
    if (typeof id !== 'string') return Promise.resolve();
    if (message.type === 'stop') {
      const session = sessions.get(id);
      if (session) close(session); else if (chains.has(id)) cancelled.add(id);
      return chains.get(id) ?? Promise.resolve();
    }
    const run = (chains.get(id) ?? Promise.resolve()).then(() => command(message)).catch(error => {
      const session = sessions.get(id);
      if (session) fail(session, 'screen_capture_failed', error);
      else if (message.type === 'start') send({ type: 'ended', sessionId: id, reason: 'screen_capture_failed', detail: String(error?.name ?? '').slice(0, 64) });
    });
    chains.set(id, run);
    void run.then(() => { if (chains.get(id) === run) { chains.delete(id); cancelled.delete(id); } });
    return run;
  }
  async function command(message) {
    const session = sessions.get(message.sessionId);
    switch (message.type) {
      case 'start': return start(message);
      case 'reset': if (session) await restart(session, message.streamGeneration, message.geometryRevision); return;
      case 'pause':
        if (!session) return;
        if (message.paused) { retire(session); session.paused = true; return; }
        session.paused = false; await restart(session, message.streamGeneration, session.geometryRevision); return;
      case 'credit': if (session) credit(session, message); return;
      case 'keyframe': if (session) session.needKey = true; return;
      default: throw new Error('screen_capture_command');
    }
  }
  const live = (session, epoch) => sessions.get(session.sessionId) === session && session.epoch === epoch;

  async function start({ sessionId, streamGeneration, geometryRevision, codecs, encode, fps, profile }) {
    if (cancelled.delete(sessionId)) return;
    if (sessions.has(sessionId)) throw new Error('screen_capture_duplicate');
    const settings = encoderProfile(fps, profile);
    const session = { sessionId, codecs, encode, profile: settings, interval: 1000 / settings.fps, sequence: 0, outstanding: new Map(), pendingOutput: [],
      geometryRevision, streamGeneration: 0, paused: false, needKey: true, qp: settings.qpBase, crowded: 0, calm: 0, held: undefined, lastEncodedAt: -Infinity, epoch: 0,
      // Session-wide, across generations: bytes sent count against the Hub budget whatever their chain.
      bucket: PACE_BURST_BYTES, bucketAt: perf(), lastKeyBytes: 0, lastDeltaBytes: 0, starved: 0, outbox: [], outputTimer: undefined };
    sessions.set(sessionId, session);
    const epoch = session.epoch;
    // The capture itself is constrained to the encoded size and rate: a lower
    // quality never captures full resolution only to discard it.
    const stream = await getDisplayMedia({ audio: false,
      video: { cursor: 'always', frameRate: { max: settings.fps }, width: { max: encode.width }, height: { max: encode.height } } });
    if (!live(session, epoch)) { for (const track of stream.getTracks()) track.stop(); return; }
    const [track] = stream.getVideoTracks();
    session.track = track;
    track.contentHint = 'text';
    track.addEventListener?.('ended', () => fail(session, 'screen_capture_failed', new Error('track_ended')));
    const actual = track.getSettings?.() ?? {};
    session.canvas = new OffscreenCanvas(encode.width, encode.height);
    session.context = session.canvas.getContext('2d', { alpha: false, desynchronized: true });
    await restart(session, streamGeneration, geometryRevision);
    if (sessions.get(sessionId) !== session) return;
    send({ type: 'started', sessionId, cursor: actual.cursor ?? 'unknown', width: actual.width ?? 0, height: actual.height ?? 0 });
    session.adapt = timers.setInterval(() => adapt(session), 1000);
    void read(session, track);
  }

  async function config(session) {
    const { width, height } = session.encode, { fps, bitrate } = session.profile;
    const candidates = [], h264 = screenH264Codec(width, height);
    // The level follows the encoded size: 4.0 (the legacy string) whenever it fits.
    if (session.codecs.includes('h264') && h264) candidates.push({ codec: 'h264', codecString: h264, config: { codec: h264, avc: { format: 'annexb' }, hardwareAcceleration: 'prefer-hardware' } });
    // A size only H.264 can carry is never silently re-encoded as something else.
    if (session.codecs.includes('vp8') && !session.profile.h264Only) candidates.push({ codec: 'vp8', codecString: 'vp8', config: { codec: 'vp8' } });
    for (const candidate of candidates) {
      // Quantizer mode: VideoToolbox's bitrate modes held output for seconds at
      // low targets in the prototype; per-frame QP adapts without reconfiguring.
      for (const bitrateMode of ['quantizer', 'variable']) {
        const full = { ...candidate.config, width, height, framerate: fps, latencyMode: 'realtime', bitrateMode, ...(bitrateMode === 'variable' ? { bitrate } : {}) };
        try { if ((await VideoEncoder.isConfigSupported(full)).supported) return { ...candidate, config: full }; } catch { /* next */ }
      }
    }
    throw new Error('screen_codec_unsupported');
  }

  /** Retires the whole current generation: encoder, queued output metadata,
   * credits, the held raw frame and the pacing timer. Late callbacks of the
   * old encoder are discarded; nothing from it continues into a new chain. */
  function retire(session) {
    session.epoch++;
    const encoder = session.encoder; session.encoder = undefined;
    session.outstanding.clear(); session.pendingOutput = []; session.outbox = [];
    session.held?.frame.close(); session.held = undefined;
    timers.clearTimeout(session.pacing); session.pacing = undefined;
    timers.clearTimeout(session.outputTimer); session.outputTimer = undefined;
    if (encoder && encoder.state !== 'closed') { try { encoder.close(); } catch { /* closed */ } }
  }
  async function restart(session, streamGeneration, geometryRevision) {
    if (!Number.isInteger(streamGeneration) || streamGeneration <= session.streamGeneration) throw new Error('screen_generation_invalid');
    retire(session);
    const epoch = session.epoch;
    session.streamGeneration = streamGeneration; session.geometryRevision = geometryRevision; session.needKey = true; session.chainStarted = false;
    const chosen = session.chosen ?? await config(session);
    // A stop, pause or newer reset that ran while we awaited wins.
    if (!live(session, epoch) || session.paused) return;
    session.chosen = chosen;
    const encoder = new VideoEncoder({
      output: chunk => output(session, epoch, streamGeneration, chunk),
      error: error => { if (session.encoder === encoder) fail(session, 'screen_capture_failed', error); },
    });
    encoder.configure(chosen.config);
    session.encoder = encoder;
    const { width, height } = session.encode;
    send({ type: 'stream', sessionId: session.sessionId, stream: { type: 'stream', streamGeneration, geometryRevision, codec: chosen.codec, codecString: chosen.codecString,
      width, height, contentRect: { x: 0, y: 0, width, height } } });
    pump(session);
  }

  async function read(session, track) {
    // At most one queued frame. captureMs is the target OS Unix time when the
    // frame leaves Chromium's capture queue and is never re-stamped later.
    const reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 }).readable.getReader();
    session.reader = reader;
    for (;;) {
      let result;
      try { result = await reader.read(); } catch (error) { if (sessions.get(session.sessionId) === session) fail(session, 'screen_capture_failed', error); return; }
      if (result.done) { if (sessions.get(session.sessionId) === session) fail(session, 'screen_capture_failed', new Error('capture_done')); return; }
      const frame = result.value, captureMs = now();
      if (sessions.get(session.sessionId) !== session || session.paused || !session.encoder) { frame.close(); if (sessions.get(session.sessionId) !== session) return; continue; }
      send({ type: 'captured', sessionId: session.sessionId, captureMs });
      // Latest wins: a frame that never got a credit is dropped before encode.
      if (session.held) { session.held.frame.close(); session.crowded++; }
      session.held = { frame, captureMs, epoch: session.epoch };
      pump(session);
    }
  }

  /** Never throws: a synchronous draw/encode/send failure ends the whole
   * session (renderer callers are timers, the read loop and credits). */
  function pump(session) {
    try { encodeNext(session); } catch (error) { if (sessions.get(session.sessionId) === session) fail(session, 'screen_capture_failed', error); }
  }
  function encodeNext(session) {
    const encoder = session.encoder;
    if (!session.held || !encoder || session.paused || encoder.state !== 'configured') return;
    if (session.held.epoch !== session.epoch || now() - session.held.captureMs > CAPTURE_HELD_MAX_MS) { session.held.frame.close(); session.held = undefined; return; }
    if (session.outstanding.size >= CAPTURE_CREDITS || encoder.encodeQueueSize > 0) return;
    // Bytes: packets waiting to leave, encodes still in flight and the next
    // frame are each expected to cost what the last one of their kind did.
    refill(session);
    const expect = key => key ? session.lastKeyBytes : session.lastDeltaBytes;
    const committed = session.outbox.reduce((n, entry) => n + entry.bytes.byteLength, 0) + session.pendingOutput.reduce((n, entry) => n + expect(entry.key), 0);
    const need = Math.min(PACE_BURST_BYTES, committed + Math.min(PACE_BURST_BYTES / 2, expect(session.needKey)));
    const wait = Math.max(session.lastEncodedAt + session.interval - perf(), session.bucket < need ? (need - session.bucket) / PACE_BYTES_PER_MS : 0);
    if (session.bucket < need) session.starved++;
    if (wait > 1) { timers.clearTimeout(session.pacing); session.pacing = timers.setTimeout(() => pump(session), wait); return; }
    const { frame, captureMs } = session.held; session.held = undefined;
    const sequence = ++session.sequence, key = session.needKey;
    session.needKey = false; session.lastEncodedAt = perf();
    session.outstanding.set(sequence, { captureMs });
    session.pendingOutput.push({ sequence, captureMs, timestamp: frame.timestamp, key, generation: session.streamGeneration, geometryRevision: session.geometryRevision });
    let source = frame;
    try {
      if (frame.displayWidth !== session.encode.width || frame.displayHeight !== session.encode.height) {
        session.context.drawImage(frame, 0, 0, session.encode.width, session.encode.height);
        source = new VideoFrame(session.canvas, { timestamp: frame.timestamp });
      }
      const options = { keyFrame: key };
      if (session.chosen.config.bitrateMode === 'quantizer') options[session.chosen.codec === 'vp8' ? 'vp8' : 'avc'] = { quantizer: session.qp };
      encoder.encode(source, options);
    } finally { if (source !== frame) source.close(); frame.close(); }
  }

  function output(session, epoch, generation, chunk) {
    try { emit(session, epoch, generation, chunk); } catch (error) { if (sessions.get(session.sessionId) === session) fail(session, 'screen_capture_failed', error); }
  }
  function emit(session, epoch, generation, chunk) {
    if (!live(session, epoch) || generation !== session.streamGeneration) return; // retired generation
    // An output keeps its input's timestamp. A realtime encoder may drop an
    // input and never output it: forget those and return their credits, so
    // neither the metadata nor the three-frame window can drift or leak.
    const index = session.pendingOutput.findIndex(entry => entry.timestamp === chunk.timestamp);
    if (index < 0) return;
    const dropped = session.pendingOutput.splice(0, index), meta = session.pendingOutput.shift();
    for (const lost of dropped) session.outstanding.delete(lost.sequence);
    if (meta.generation !== generation) return;
    // A generation must start with a key frame (the Hub ends the session
    // otherwise). A delta before it references nothing the viewer has: it is
    // never sent, its credit returns and the next encode is a key frame.
    if (!session.chainStarted && chunk.type !== 'key') { session.outstanding.delete(meta.sequence); session.needKey = true; pump(session); return; }
    session.chainStarted = true;
    if (dropped.length) pump(session);
    const payload = new Uint8Array(chunk.byteLength); chunk.copyTo(payload);
    let bytes;
    try {
      bytes = writeScreenFrame({ key: chunk.type === 'key', codec: session.chosen.codec, sequence: meta.sequence, geometryRevision: meta.geometryRevision,
        streamGeneration: generation, captureMs: meta.captureMs, width: session.encode.width, height: session.encode.height }, payload);
    } catch (error) { fail(session, 'screen_congested', error); return; }
    if (chunk.type === 'key') session.lastKeyBytes = bytes.byteLength; else session.lastDeltaBytes = bytes.byteLength;
    // Bounded by the credit window (≤3 entries); sent strictly in encode order.
    session.outbox.push({ bytes, meta, key: chunk.type === 'key', generation, epoch });
    flush(session);
  }
  /** Sends queued packets in order while the bucket covers each one's real size. */
  function flush(session) {
    timers.clearTimeout(session.outputTimer); session.outputTimer = undefined;
    while (session.outbox.length) {
      const head = session.outbox[0];
      if (!live(session, head.epoch) || head.generation !== session.streamGeneration) { session.outbox = []; return; }
      const age = now() - head.meta.captureMs, size = head.bytes.byteLength;
      if (age > OUTPUT_MAX_AGE_MS) { fail(session, 'screen_congested', new Error('screen_output_stale')); return; }
      refill(session);
      const inFlight = [...session.outstanding.values()].some(entry => entry.sent);
      const fits = size <= PACE_BURST_BYTES ? session.bucket >= size : session.bucket >= PACE_BURST_BYTES && !inFlight;
      if (!fits) {
        session.starved++;
        // Re-checked when bytes refill, when an ACK clears the flight, and at
        // the age limit at the latest: never an unbounded wait.
        const refillMs = Math.max(0, (Math.min(size, PACE_BURST_BYTES) - session.bucket) / PACE_BYTES_PER_MS);
        session.outputTimer = timers.setTimeout(() => drain(session), Math.max(1, Math.min(refillMs || OUTPUT_MAX_AGE_MS, OUTPUT_MAX_AGE_MS - age + 1)));
        return;
      }
      session.outbox.shift(); session.bucket -= size;
      const credit = session.outstanding.get(head.meta.sequence); if (credit) credit.sent = true;
      // Copied, never transferred: Electron 45.1.0 main hangs on ArrayBuffer transfer.
      send({ type: 'frame', sessionId: session.sessionId, bytes: head.bytes, sequence: head.meta.sequence, streamGeneration: head.generation, captureMs: head.meta.captureMs,
        geometryRevision: head.meta.geometryRevision, key: head.key });
    }
  }
  function drain(session) {
    try { flush(session); } catch (error) { if (sessions.get(session.sessionId) === session) fail(session, 'screen_capture_failed', error); }
  }

  function credit(session, { frameSequence, streamGeneration }) {
    if (streamGeneration !== session.streamGeneration || !session.outstanding.has(frameSequence)) return;
    // In-order TCP: an ACK for N also covers every earlier frame of this generation.
    for (const sequence of [...session.outstanding.keys()]) if (sequence <= frameSequence) session.outstanding.delete(sequence);
    drain(session);
    if (sessions.get(session.sessionId) === session) pump(session);
  }
  function refill(session) {
    const at = perf();
    session.bucket = Math.min(PACE_BURST_BYTES, session.bucket + Math.max(0, at - session.bucketAt) * PACE_BYTES_PER_MS); session.bucketAt = at;
  }
  /** Once a second: credit starvation (slow viewer) or byte starvation (busy
   * picture) coarsens the quantizer up to the profile ceiling; three calm
   * seconds with a comfortable byte budget refine it back towards the base. */
  function adapt(session) {
    const { qpBase, qpMax } = session.profile;
    refill(session);
    if (session.crowded > 2 || session.starved > 0) { session.qp = Math.min(qpMax, session.qp + 3); session.calm = 0; }
    else if (session.bucket < PACE_BURST_BYTES / 4) session.calm = 0;
    else if (++session.calm >= 3) session.qp = Math.max(qpBase, session.qp - 1);
    session.crowded = 0; session.starved = 0;
  }
  function close(session) {
    sessions.delete(session.sessionId);
    timers.clearInterval(session.adapt);
    retire(session);
    try { session.reader?.cancel(); } catch { /* closed */ }
    session.track?.stop();
  }
  return { handle, sessions };
}
