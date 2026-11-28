import { screenRtcCodecs, screenRtcConfiguration, screenRtcGather } from '../../src/client-protocol/screen-rtc-browser.ts';

const SEND_META_EVERY_MS = 40;

/** Operates inside the isolated capture renderer, with an already granted
 * display. Each RTP proof is looked up by the exact input VideoFrame
 * timestamp exposed by Chromium's encoded transform. */
export class ScreenRtcSender {
  constructor({ command, send, nextSequence, encode, profile, VideoFrame, OffscreenCanvas, now, perf, rtcEnv }) {
    this.command = command;
    this.send = send;
    this.VideoFrame = VideoFrame;
    this.now = now;
    this.perf = perf;
    this.encode = encode;
    this.profile = profile;
    this.canvas = new OffscreenCanvas(encode.width, encode.height);
    this.context = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.timestamps = new Map();
    this.nextSequence = nextSequence;
    this.lastStamp = -Infinity;
    this.abort = new AbortController();
    this.env = rtcEnv;
  }

  async open() {
    const { RTCPeerConnection, MediaStreamTrackGenerator, MediaStream, TransformStream } = this.env;
    const { mode, ice, sessionId, nonce, sdp } = this.command;
    const peer = this.peer = new RTCPeerConnection({ ...screenRtcConfiguration(mode, ice), encodedInsertableStreams: true });
    this.track = new MediaStreamTrackGenerator({ kind: 'video' });
    this.track.contentHint = 'text';
    this.writer = this.track.writable.getWriter();
    // No sender is attached until the Hub-authenticated offer is accepted.
    await peer.setRemoteDescription({ type: 'offer', sdp });
    this.abort.signal.throwIfAborted();
    const sender = peer.addTrack(this.track, new MediaStream([this.track]));
    const transceiver = peer.getTransceivers().find(value => value.sender === sender);
    const codecs = screenRtcCodecs(this.env.RTCRtpSender.getCapabilities('video')?.codecs);
    if (!codecs?.length || !transceiver) throw new Error('screen_rtc_codec_unavailable');
    transceiver.setCodecPreferences(codecs);
    const streams = sender.createEncodedStreams();
    streams.readable.pipeThrough(new TransformStream({
      transform: (frame, controller) => {
        if (this.abort.signal.aborted) return;
        const meta = frame.getMetadata(), stamp = this.timestamps.get(meta.timestamp);
        if (stamp && Number.isInteger(meta.rtpTimestamp) && this.now() - stamp.captureMs <= 1800 && this.perf() - this.lastStamp >= SEND_META_EVERY_MS) {
          this.lastStamp = this.perf();
          this.send({ type: 'rtc-frame', sessionId, nonce, ...stamp, rtpTimestamp: meta.rtpTimestamp, frameSequence: this.nextSequence() });
        }
        this.timestamps.delete(meta.timestamp);
        controller.enqueue(frame);
      },
    })).pipeTo(streams.writable, { signal: this.abort.signal }).catch(() => this.fail());
    peer.onconnectionstatechange = () => { if (peer.connectionState === 'failed') this.fail(); };
    const answer = await screenRtcGather(peer, await peer.createAnswer(), mode, this.abort.signal);
    const params = sender.getParameters();
    if (params.encodings.length) {
      params.encodings[0].maxBitrate = this.profile.bitrate;
      params.encodings[0].maxFramerate = this.profile.fps;
      params.degradationPreference = 'maintain-framerate';
      await sender.setParameters(params);
    }
    this.abort.signal.throwIfAborted();
    this.send({ type: 'rtc-answer', sessionId, nonce, sdp: answer });
  }

  sample(frame, captureMs, streamGeneration) {
    if (!this.writer || this.abort.signal.aborted || this.writing || this.peer?.connectionState !== 'connected') return;
    // Some WebRTC encoders store presentation time in whole milliseconds.
    // Give each sample a unique timestamp that survives either precision.
    const timestamp = Math.max((this.lastTimestamp ?? 0) + 1000, Math.floor(this.perf()) * 1000);
    this.lastTimestamp = timestamp;
    // A native capture VideoFrame carries Chromium's reference_time side
    // data even when cloned with a different timestamp. Drawing onto the
    // owned canvas strips that side data, so the encoder returns the exact
    // timestamp supplied here.
    this.context.drawImage(frame, 0, 0, this.encode.width, this.encode.height);
    const picture = new this.VideoFrame(this.canvas, { timestamp });
    this.timestamps.set(timestamp, { captureMs, streamGeneration });
    while (this.timestamps.size > 260) this.timestamps.delete(this.timestamps.keys().next().value);
    this.writing = true;
    this.writer.write(picture).catch(() => this.fail()).finally(() => { picture.close(); this.writing = false; });
  }

  fail() {
    if (this.abort.signal.aborted) return;
    const { sessionId, nonce } = this.command;
    this.close();
    this.send({ type: 'rtc-failed', sessionId, nonce });
  }

  close() {
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    this.peer?.close();
    this.track?.stop();
    void this.writer?.abort().catch(() => {});
    this.timestamps.clear();
  }
}
