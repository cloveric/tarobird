// Capture/encode logic of the isolated capture renderer. Browser APIs are
// injected so the generation, credit and race rules are testable without a
// real screen. The page entry (screen-capture-page.mjs) passes real globals.
import { SCREEN_FLIGHT_MAX, SCREEN_FLIGHT_MIN, screenH264Codec, screenH264EncoderCodec, screenRateLadder } from '../../src/client-protocol/screen-quality.ts';
import { SCREEN_RTC_SEQUENCE_START } from '../../src/client-protocol/screen-rtc.ts';
import { ScreenRtcSender } from './screen-rtc-sender.mjs';
/** Frames kept unacknowledged at once (the flight window). Three for any
 * viewer. A viewer that says it can hold more (`flight`) and reports how long
 * it held each frame lets the window follow the path: the frames really in
 * transit, which is the network round trip (the shortest seen this session)
 * divided by the pace receipts actually come back at while frames are still
 * owed (a quarter of a frame is allowed for noise in the two measurements),
 * plus two for the viewer's own decode and repaint. That pace is never taken
 * as faster than the session's interval. So a viewer, a link or a phone
 * bridge that returns frames slowly keeps a window near three however long
 * the path: more frames in flight would only queue in front of it. A path that
 * is long and returns receipts at the frame rate widens it, up to what the
 * viewer holds, and only once that pace has been seen over a few receipts:
 * until then, as at the start of every session, it is three. Beyond three
 * frames the unacknowledged bytes are bounded too. */
export const CAPTURE_CREDITS = SCREEN_FLIGHT_MIN;
/** Receipts whose spacing must have been seen before the window may widen. */
const PACE_SAMPLES = 8;
/** Unacknowledged bytes allowed beyond three frames: half of what the Hub lets
 * wait unsent for a viewer (1 MiB) before it ends the session as congested. */
export const FLIGHT_BYTES = 512 * 1024;
const flightWindow = session => Number.isFinite(session.rtt) && session.paced >= PACE_SAMPLES
  ? Math.min(session.flight, Math.max(CAPTURE_CREDITS, 2 + Math.floor(session.rtt / Math.max(session.interval, session.cadence) + 0.25))) : CAPTURE_CREDITS;
/** A raw frame that waited this long for a credit is dropped, never encoded:
 * the Host refuses frames older than 2 s, and a stale delta cannot be skipped. */
export const CAPTURE_HELD_MAX_MS = 1500;
/** Encoded-byte pacing below the Hub's per-source media budget (by default
 * 500 B/ms with a 1 MiB burst, ten times that rate for a viewer on the local
 * network; exceeding it ends the session as `screen_bandwidth_exceeded`).
 * Two gates share one bucket. Before encode, the newest raw frame waits
 * (latest wins, as for credits) while the bucket cannot cover what is already
 * committed plus the expected frame, and the quantizer rises. After encode,
 * every packet waits in FIFO order until the bucket covers its ACTUAL size:
 * several encodes may be in flight and their outputs can arrive together.
 * With a smaller cap and slower refill than the Hub's, the Hub bucket stays at
 * least 256 KiB above this one when send and arrival coincide, so a packet
 * this gate sends always fits there. A legal packet above this cap (≤1 MiB)
 * waits for a full bucket with nothing unacknowledged in flight. Nothing
 * encoded is dropped or reordered: a packet that cannot leave before it would
 * be too old for the Host ends the session (`screen_congested`). */
export const PACE_BYTES_PER_MS = 425, PACE_BYTES_PER_MS_MAX = 4250, PACE_BURST_BYTES = 768 * 1024;
/** Latest send age for a packet: the Host refuses frames older than 2 s on arrival. */
export const OUTPUT_MAX_AGE_MS = 1800;
/** Legacy (balanced) encoder settings, used when main sends no profile. */
const QP_BASE = 28, QP_MAX = 40, BITRATE = 2_500_000;
/** The most this renderer will capture and encode per second, and the rate
 * used when main names none (the pre-quality behaviour). */
export const FPS_MAX = 120, FPS_LEGACY = 15;
/** A frame may be encoded this fraction of an interval before its slot: the
 * source's own jitter around the same nominal rate must not hold every frame
 * for a timer. The slots still advance by exactly one interval each. */
const EARLY_FRACTION = 0.25;
const bounded = (value, min, max, fallback) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
/** Main's quality profile, clamped to what this renderer will ever encode. */
function encoderProfile(fps, profile) {
  const qpBase = Math.round(bounded(profile?.qpBase, 10, 51, QP_BASE));
  return { fps: bounded(fps, 1, FPS_MAX, FPS_LEGACY), qpBase, qpMax: Math.round(bounded(profile?.qpMax, qpBase, 51, Math.max(qpBase, QP_MAX))),
    bitrate: Math.round(bounded(profile?.bitrate, 250_000, 4_000_000, BITRATE)), h264Only: profile?.h264Only === true,
    // Bytes per millisecond this session may send: main names it when the Host granted more than the default budget.
    pace: bounded(profile?.bytesPerMs, PACE_BYTES_PER_MS, PACE_BYTES_PER_MS_MAX, PACE_BYTES_PER_MS) };
}

export function createCaptureCore(env) {
  const { send, getDisplayMedia, VideoEncoder, VideoFrame, OffscreenCanvas, MediaStreamTrackProcessor, writeScreenFrame,
    now = Date.now, perf = () => performance.now(), timers = globalThis, rtcEnv } = env;
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
        if (message.paused) { session.rtc?.close(); session.rtc = undefined; session.rtcOnly = false; retire(session); session.paused = true; return; }
        session.paused = false; await restart(session, message.streamGeneration, session.geometryRevision); return;
      case 'rtc-offer': {
        if (!session || session.paused || !rtcEnv) { send({ type: 'rtc-failed', sessionId: message.sessionId, nonce: message.nonce }); return; }
        session.rtc?.close();
        const rtc = new ScreenRtcSender({ command: message, send, nextSequence: () => session.nextRtcSequence++,
          encode: session.encode, profile: session.profile, VideoFrame, OffscreenCanvas, now, perf, rtcEnv });
        session.rtc = rtc;
        // Gathering must not delay pause, reset or local takeover.
        void rtc.open().catch(() => rtc.fail());
        return;
      }
      case 'rtc-activate':
        if (session?.rtc?.command.nonce === message.nonce && !session.rtc.abort.signal.aborted) { session.rtcOnly = true; retire(session); }
        return;
      case 'rtc-close':
        if (session?.rtc?.command.nonce === message.nonce) { session.rtc.close(); session.rtc = undefined; session.rtcOnly = false; }
        return;
      case 'credit': if (session) credit(session, message); return;
      case 'keyframe': if (session) session.needKey = true; return;
      default: throw new Error('screen_capture_command');
    }
  }
  const live = (session, epoch) => sessions.get(session.sessionId) === session && session.epoch === epoch;

  async function start({ sessionId, streamGeneration, geometryRevision, codecs, encode, fps, profile, flight }) {
    if (cancelled.delete(sessionId)) return;
    if (sessions.has(sessionId)) throw new Error('screen_capture_duplicate');
    const settings = encoderProfile(fps, profile);
    const session = { sessionId, codecs, encode, profile: settings, interval: 1000 / settings.fps, sequence: 0, nextRtcSequence: SCREEN_RTC_SEQUENCE_START, outstanding: new Map(), pendingOutput: [],
      geometryRevision, streamGeneration: 0, paused: false, needKey: true, qp: settings.qpBase, crowded: 0, encoded: 0, calm: 0, held: undefined, dueAt: -Infinity, epoch: 0,
      // The viewer's capacity, the shortest network round trip its receipts have shown and the pace they come back at
      // (session-wide: the path and the viewer do not change with a generation).
      flight: Math.round(bounded(flight, CAPTURE_CREDITS, SCREEN_FLIGHT_MAX, CAPTURE_CREDITS)), rtt: Infinity, cadence: undefined, paced: 0, creditAt: undefined, owed: false,
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
    const { width, height } = session.encode, { bitrate } = session.profile;
    // The profile's rate first; an encoder that cannot take it at this size
    // gets the next lower standard rate instead of no picture at all. Codec
    // preference stays outermost: H.264 at a lower rate before VP8 at any.
    const rates = screenRateLadder(session.profile.fps), declared = screenH264Codec(width, height);
    const candidates = [];
    for (const fps of rates) {
      // The encoder is told the level its size and rate need. The stream still
      // declares the size's own level, the string viewers have always opened
      // their decoder with; decoders follow the level in the bitstream.
      const level = screenH264EncoderCodec(width, height, fps);
      if (session.codecs.includes('h264') && declared && level) candidates.push({ codec: 'h264', codecString: declared, fps, config: { codec: level, avc: { format: 'annexb' }, hardwareAcceleration: 'prefer-hardware' } });
    }
    // A size only H.264 can carry is never silently re-encoded as something else.
    if (session.codecs.includes('vp8') && !session.profile.h264Only) for (const fps of rates) candidates.push({ codec: 'vp8', codecString: 'vp8', fps, config: { codec: 'vp8' } });
    for (const candidate of candidates) {
      // Quantizer mode: VideoToolbox's bitrate modes held output for seconds at
      // low targets in the prototype; per-frame QP adapts without reconfiguring.
      for (const bitrateMode of ['quantizer', 'variable']) {
        const full = { ...candidate.config, width, height, framerate: candidate.fps, latencyMode: 'realtime', bitrateMode, ...(bitrateMode === 'variable' ? { bitrate } : {}) };
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
    session.outstanding.clear(); session.pendingOutput = []; session.outbox = []; session.owed = false;
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
    if (session.rtcOnly) return;
    const chosen = session.chosen ?? await config(session);
    // A stop, pause or newer reset that ran while we awaited wins.
    if (!live(session, epoch) || session.paused) return;
    session.chosen = chosen;
    // The rate the encoder accepted is the rate of the whole session.
    if (chosen.fps !== session.profile.fps) { session.profile = { ...session.profile, fps: chosen.fps }; session.interval = 1000 / chosen.fps; }
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
      if (sessions.get(session.sessionId) !== session || session.paused || !session.encoder && !session.rtc) { frame.close(); if (sessions.get(session.sessionId) !== session) return; continue; }
      send({ type: 'captured', sessionId: session.sessionId, captureMs });
      try { session.rtc?.sample(frame, captureMs, session.streamGeneration); } catch { session.rtc?.fail(); }
      if (!session.encoder) { frame.close(); continue; }
      // Latest wins: a frame that never got its turn is dropped before encode.
      // Only one the viewer or the encoder held up counts as crowding, not one
      // the schedule or the byte budget skipped.
      if (session.held) { session.held.frame.close(); if (session.held.blocked) session.crowded++; }
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
    if (session.outstanding.size >= flightWindow(session) || encoder.encodeQueueSize > 0) { session.held.blocked = true; return; }
    // Bytes: packets waiting to leave, encodes still in flight and the next
    // frame are each expected to cost what the last one of their kind did.
    refill(session);
    const expect = key => key ? session.lastKeyBytes : session.lastDeltaBytes;
    const committed = session.outbox.reduce((n, entry) => n + entry.bytes.byteLength, 0) + session.pendingOutput.reduce((n, entry) => n + expect(entry.key), 0);
    // Beyond three frames everything not yet acknowledged counts: what has left, what waits to leave and the next frame.
    if (session.outstanding.size >= CAPTURE_CREDITS) {
      let unacknowledged = committed + expect(session.needKey);
      for (const entry of session.outstanding.values()) unacknowledged += entry.bytes ?? 0;
      if (unacknowledged > FLIGHT_BYTES) { session.held.blocked = true; return; }
    }
    const need = Math.min(PACE_BURST_BYTES, committed + Math.min(PACE_BURST_BYTES / 2, expect(session.needKey)));
    // Cadence follows a schedule of slots one interval apart, not the time of
    // the previous encode: a late timer or a late frame delays that one frame
    // only, instead of pushing every later frame back by the same amount.
    const at = perf(), early = session.dueAt - at;
    const wait = Math.max(early > session.interval * EARLY_FRACTION ? early : 0, session.bucket < need ? (need - session.bucket) / session.profile.pace : 0);
    if (session.bucket < need) session.starved++;
    if (wait > 1) { timers.clearTimeout(session.pacing); session.pacing = timers.setTimeout(() => pump(session), wait); return; }
    const { frame, captureMs } = session.held; session.held = undefined;
    const sequence = ++session.sequence, key = session.needKey;
    // More than one interval behind (idle, slow viewer, byte wait): the schedule
    // restarts here, so lost time is never made up with a burst.
    session.needKey = false; session.dueAt = (at - session.dueAt > session.interval ? at : session.dueAt) + session.interval; session.encoded++;
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
    // neither the metadata nor the flight window can drift or leak.
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
    // Bounded by the flight window; sent strictly in encode order.
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
        const refillMs = Math.max(0, (Math.min(size, PACE_BURST_BYTES) - session.bucket) / session.profile.pace);
        session.outputTimer = timers.setTimeout(() => drain(session), Math.max(1, Math.min(refillMs || OUTPUT_MAX_AGE_MS, OUTPUT_MAX_AGE_MS - age + 1)));
        return;
      }
      session.outbox.shift(); session.bucket -= size;
      const credit = session.outstanding.get(head.meta.sequence); if (credit) { credit.sent = true; credit.sentAt = perf(); credit.bytes = size; }
      // Copied, never transferred: Electron 45.1.0 main hangs on ArrayBuffer transfer.
      send({ type: 'frame', sessionId: session.sessionId, bytes: head.bytes, sequence: head.meta.sequence, streamGeneration: head.generation, captureMs: head.meta.captureMs,
        geometryRevision: head.meta.geometryRevision, key: head.key });
    }
  }
  function drain(session) {
    try { flush(session); } catch (error) { if (sessions.get(session.sessionId) === session) fail(session, 'screen_capture_failed', error); }
  }

  function credit(session, { frameSequence, streamGeneration, heldMs }) {
    const entry = session.outstanding.get(frameSequence);
    if (streamGeneration !== session.streamGeneration || !entry) return;
    const at = perf();
    // The network's share of this frame's round trip: the time since it left, less what the viewer says it held it.
    // A figure that would make it negative is the viewer's mistake and is left out, not kept as a round trip of zero.
    if (Number.isFinite(heldMs) && heldMs >= 0) { const sample = at - entry.sentAt - heldMs; if (sample >= 0) session.rtt = Math.min(session.rtt, sample); }
    // In-order TCP: an ACK for N also covers every earlier frame of this generation.
    let released = 0;
    for (const sequence of [...session.outstanding.keys()]) if (sequence <= frameSequence) { session.outstanding.delete(sequence); released++; }
    // The pace receipts come back at, per frame, smoothed over the last few. Counted only when
    // frames were still owed after the previous receipt: an idle screen is not a slow viewer.
    if (session.owed && session.creditAt !== undefined) { const gap = (at - session.creditAt) / released; session.cadence = session.cadence === undefined ? gap : session.cadence + (gap - session.cadence) / 8; session.paced++; }
    session.creditAt = at; session.owed = session.outstanding.size > 0;
    drain(session);
    if (sessions.get(session.sessionId) === session) pump(session);
  }
  function refill(session) {
    const at = perf();
    session.bucket = Math.min(PACE_BURST_BYTES, session.bucket + Math.max(0, at - session.bucketAt) * session.profile.pace); session.bucketAt = at;
  }
  /** Once a second: credit starvation (slow viewer) or byte starvation (busy
   * picture) coarsens the quantizer up to the profile ceiling; three calm
   * seconds with a comfortable byte budget refine it back towards the base.
   * `crowded` counts frames replaced while the viewer still owed receipts for
   * a full window. At the legacy rate more than two of them in a second
   * coarsen, as they always did. Above it the share decides, not the count:
   * only when fewer than a quarter of the frames that wanted to go got through
   * (a viewer below about 15 of 60). A viewer that follows at 20 or 40 keeps
   * its picture quality, and so does a short burst of motion over a long
   * round trip, which fills the window for a moment without anyone being slow. */
  function adapt(session) {
    const { qpBase, qpMax, fps } = session.profile;
    refill(session);
    const crowded = session.crowded > 2 && (fps <= FPS_LEGACY || session.crowded > 3 * session.encoded);
    if (crowded || session.starved > 0) { session.qp = Math.min(qpMax, session.qp + 3); session.calm = 0; }
    else if (session.bucket < PACE_BURST_BYTES / 4) session.calm = 0;
    else if (++session.calm >= 3) session.qp = Math.max(qpBase, session.qp - 1);
    session.crowded = 0; session.starved = 0; session.encoded = 0;
  }
  function close(session) {
    session.rtc?.close();
    sessions.delete(session.sessionId);
    timers.clearInterval(session.adapt);
    retire(session);
    try { session.reader?.cancel(); } catch { /* closed */ }
    session.track?.stop();
  }
  return { handle, sessions };
}
