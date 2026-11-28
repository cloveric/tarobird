import { SCREEN_FLIGHT_MAX, SCREEN_FLIGHT_MIN, SCREEN_HELD_MAX_MS, SCREEN_QUALITY_PROFILES, screenQualityProfile, type ScreenQuality } from "../../src/client-protocol/screen-quality.js";
import { screenStreamSchema, screenViewerEventSchema, type ScreenInputEvent, type ScreenJoin, type ScreenStream } from "../../src/client-protocol/remote-screen.js";
import { readScreenFrame, SCREEN_HEADER_BYTES } from "../../src/client-protocol/screen-wire.js";
import { ScreenMetricsTracker, type ScreenPerformanceSnapshot, type ScreenRouteKind } from "../../src/client-protocol/screen-metrics.js";
import { electronScreenViewerTransport, type ScreenViewerChannel, type ScreenViewerPort, type ScreenViewerTransport } from "./screen-viewer-transport.js";

import { SCREEN_RTC_SEQUENCE_START, screenRtcRoute, type ScreenRtcFrame } from "../../src/client-protocol/screen-rtc.js";
import { ScreenRtcReceiver, type ScreenRtcSignaling, type RtcDraw, type RtcStats } from "./screen-rtc-receiver.js";

export type ViewerState = { state: string; reason?: string; controlAllowed?: boolean; controlling: boolean; pending: boolean; fresh: boolean; width?: number; height?: number; metrics?: ScreenPerformanceSnapshot };
/** Desktop input validity: this window is focused and visible and the canvas
 * holds focus, so clicking the chat input stops remote control at once. */
export function screenCanvasFocused(canvas: HTMLCanvasElement) { return document.hasFocus() && document.activeElement === canvas && document.visibilityState === "visible"; }
export type RemoteScreenViewerOptions = {
  /** Carries this session's messages; the Electron main process by default. */
  transport?: ScreenViewerTransport;
  /** The capacity this session was opened with (`screenOpen({ flight })`): frames
   * accepted before their receipts, and every receipt then says how long this
   * viewer held the frame. Omitted: three, and receipts as they always were. */
  flight?: number;
  /** Whether local input may drive the target right now. Gates every input,
   * lease renewal and the `input-focus` report; `screenCanvasFocused` by default.
   * A replacement must only add the viewer's own controls, never loosen the rest. */
  inputActive?: (canvas: HTMLCanvasElement) => boolean;
  /** Route label & UDP opt-in state reported by the Host for the performance overlay. */
  routeHint?: ScreenRouteKind;
  udpRequested?: boolean;
  udpConnected?: boolean;
  /** NTP-midpoint estimated server-minus-client clock offset (ms) from screenOpen. */
  serverTimeOffsetMs?: number;
  rtcSignaling?: ScreenRtcSignaling;
};
/** One controller object per explicit viewing session; never reconnects/replays. */
export class RemoteScreenViewer {
  state: ViewerState = { state: "connecting", controlling: false, pending: false, fresh: false };
  private port?: ScreenViewerPort; private decoder?: VideoDecoder; private stream?: ScreenStream;
  private frames = new Map<number, { generation: number; at: number; captureMs: number }>();
  private readonly metricsTracker = new ScreenMetricsTracker();
  private readonly rtcSignaling?: ScreenRtcSignaling;
  private rtc?: ScreenRtcReceiver;
  private rtcActive = false;
  private rtcStartedAt = 0;
  private rtcStats?: RtcStats;
  private tcpRoute: ScreenRouteKind;
  private udpRequested: boolean;
  private readonly serverTimeOffsetMs: number;
  private lastMetricsAt: number;
  private picture?: { sequence: number; expiresAt: number; at: number };
  private lease?: { id: string; challenge: string }; private usedChallenge = ""; private sequence = 0;
  private disposed = false; private visible = true; private requestedVisible = true; private nativeVisible = true; private timer: ReturnType<typeof setInterval>;
  private wheelTimer?: ReturnType<typeof setTimeout>; private pendingWheel?: { event: Extract<ScreenInputEvent, { kind: "wheel" }>; leaseId: string };
  private lastMoveAt = -Infinity;
  private moveTimer?: ReturnType<typeof setTimeout>; private pendingMove?: { event: Extract<ScreenInputEvent, { kind: "move" }> | { clientX: number; clientY: number }; leaseId: string; epoch: number };
  private inputFocused = false;
  private controlRequested = false; private controlGeneration = 0;
  private minimumGeneration = 1; private streamEpoch = 0;
  private readonly channel: ScreenViewerChannel; private readonly inputActive: (canvas: HTMLCanvasElement) => boolean;
  private readonly flight: number; private readonly reportHeld: boolean;
  constructor(readonly join: ScreenJoin, private canvas: HTMLCanvasElement, private change: (state: ViewerState) => void, options: RemoteScreenViewerOptions = {}) {
    this.rtcSignaling = options.rtcSignaling;
    this.tcpRoute = options.routeHint ?? "tcp_default";
    this.udpRequested = options.udpRequested ?? join.rtc === true;
    this.channel = (options.transport ?? electronScreenViewerTransport)(join);
    this.inputActive = options.inputActive ?? screenCanvasFocused;
    this.reportHeld = options.flight !== undefined;
    this.flight = Math.min(SCREEN_FLIGHT_MAX, Math.max(SCREEN_FLIGHT_MIN, Math.floor(options.flight ?? SCREEN_FLIGHT_MIN)));
    this.state.controlAllowed = join.session.controlAllowed;
    this.serverTimeOffsetMs = options.serverTimeOffsetMs !== undefined && Number.isFinite(options.serverTimeOffsetMs)
      ? options.serverTimeOffsetMs
      : join.serverTime - Date.now();
    this.lastMetricsAt = performance.now();
    this.metricsTracker.setRoute(options.routeHint ?? "tcp_default", {
      udpRequested: options.udpRequested ?? false,
      udpConnected: options.udpConnected ?? false,
    });
    this.timer = setInterval(() => {
      const now = performance.now();
      const fresh = !!this.picture && now - this.picture.at < 1500;
      if (!fresh && this.state.fresh) { this.release(); this.update({ fresh: false }); }
      if (this.rtcActive && now - (this.picture?.at ?? this.rtcStartedAt) > 2200) this.rtc?.stop();
      if (fresh && this.lease && this.visible && this.focused() && this.usedChallenge !== this.lease.challenge) {
        this.usedChallenge = this.lease.challenge;
        this.send({ type: "renew", leaseId: this.lease.id, challenge: this.lease.challenge, frameSequence: this.picture!.sequence });
      }
      if (!this.disposed && this.port && this.visible && this.state.state !== "closed" && now - this.lastMetricsAt >= 500) {
        this.lastMetricsAt = now;
        this.update({ metrics: this.metricsTracker.snapshot(now) });
      }
    }, 500);
  }
  setRoute(route: ScreenRouteKind, options: { udpRequested?: boolean; udpConnected?: boolean } = {}) {
    this.tcpRoute = route;
    if (options.udpRequested !== undefined) this.udpRequested = options.udpRequested;
    if (this.rtcActive) return;
    this.metricsTracker.setRoute(route, options);
    if (!this.disposed && this.port && this.visible && this.state.state !== "closed") {
      const now = performance.now();
      this.lastMetricsAt = now;
      this.update({ metrics: this.metricsTracker.snapshot(now) });
    }
  }
  private update(next: Partial<ViewerState>) {
    const changed = (Object.keys(next) as (keyof ViewerState)[]).some(key => this.state[key] !== next[key]);
    if (changed) this.state = { ...this.state, ...next };
    const focused = this.state.controlling && this.focused();
    if (focused !== this.inputFocused) { this.inputFocused = focused; this.send({ type: "input-focus", enabled: focused }); }
    if (changed) this.change(this.state);
  }
  private focused() { return this.inputActive(this.canvas); }
  private send(value: Record<string, unknown>) {
    if (this.disposed || !this.port) return false;
    this.port.postMessage({ ...value, sessionId: this.join.session.id, generation: this.join.session.generation }); return true;
  }
  private sendVisibility() {
    // A hide before port delivery never reached the Host, so it cannot retire
    // a stream generation. Account for a pending hide only when it is sent.
    if (this.send({ type: "visibility", visible: this.visible }) && !this.visible) this.minimumGeneration++;
  }
  async open(network: unknown) {
    try { await this.channel.open(network, { attach: port => this.attach(port), fail: reason => this.fail(reason) }); }
    catch (error) { this.fail(error instanceof Error ? error.message : "screen_open_failed"); throw error; }
  }
  private attach(port: ScreenViewerPort) {
    if (this.disposed) { port.close(); return; }
    this.port = port; this.lastMetricsAt = performance.now(); port.start(data => { void this.message(data).catch(error => this.fail(error instanceof Error ? error.message : "screen_decode_failed")); });
    if (!this.visible) this.sendVisibility();
  }
  private checkQuality(value: {width:number;height:number;codec:string}) {
    const limit=screenQualityProfile(this.join.quality);
    if(Math.max(value.width,value.height)>limit.longEdge||value.width*value.height>limit.area||limit.h264Only&&value.codec!=="h264")throw new Error("screen_stream_invalid");
  }
  private startRtc() {
    if (this.rtc || !this.rtcSignaling || !this.visible || this.disposed) return;
    this.rtc = new ScreenRtcReceiver(this.join, this.rtcSignaling, picture => this.drawRtc(picture),
      stamp => this.ackRtc(stamp), stats => this.updateRtcStats(stats), () => this.fallbackRtc());
    this.rtc.start();
  }
  private drawRtc({ picture, width, height, mode, stamp }: RtcDraw) {
    if (!this.visible || this.disposed) return;
    if (!this.rtcActive) {
      if (!stamp || stamp.streamGeneration !== this.minimumGeneration) return;
      this.rtcActive = true; this.rtcStartedAt = performance.now();
      this.clearMove(); this.picture = undefined; this.frames.clear(); this.closeDecoder(); this.stream = undefined; ++this.streamEpoch;
      this.metricsTracker.resetStream(this.minimumGeneration);
      this.metricsTracker.setRoute(screenRtcRoute(mode), { udpRequested: true, udpConnected: true });
      this.update({ fresh: false });
    }
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const context = this.canvas.getContext("2d", { alpha: false });
    if (!context) { this.rtc?.stop(); return; }
    context.drawImage(picture, 0, 0, width, height);
    this.update({ width, height });
    this.metricsTracker.recordFrameRendered({ nowMs: performance.now() });
    if (stamp) this.ackRtc(stamp);
  }
  private ackRtc(stamp: ScreenRtcFrame) {
    if (!this.rtcActive || !this.visible || stamp.streamGeneration !== this.minimumGeneration) return;
    const latencyMs = Date.now() + this.serverTimeOffsetMs - stamp.captureMs;
    this.metricsTracker.recordFrameLatency(performance.now(), latencyMs);
    this.send({ type: "ack", frameSequence: stamp.frameSequence });
  }
  private updateRtcStats(stats: RtcStats) {
    if (!this.rtcActive || !this.state.width || !this.state.height) return;
    const before = this.rtcStats; this.rtcStats = stats;
    this.metricsTracker.recordRtcStats({ nowMs: performance.now(), width: this.state.width, height: this.state.height, codec: stats.codec,
      bytes: before ? Math.max(0, stats.bytes - before.bytes) : 0, dropped: before ? Math.max(0, stats.dropped - before.dropped) : 0 });
  }
  private fallbackRtc() {
    this.rtcActive = false; this.rtcStats = undefined; this.picture = undefined; this.clearMove(); this.clearWheel();
    this.lease = undefined; this.controlRequested = false;
    this.metricsTracker.resetStream(this.minimumGeneration);
    this.metricsTracker.setRoute(this.tcpRoute, { udpRequested: this.udpRequested, udpConnected: false });
    if (!this.disposed) this.update({ fresh: false, controlling: false, pending: false, metrics: this.metricsTracker.snapshot(performance.now()) });
  }
  private async message(value: unknown) {
    if (this.disposed) return;
    if (value instanceof ArrayBuffer) {
      const bytes = new Uint8Array(value), header = readScreenFrame(bytes);
      this.checkQuality(header);
      this.port?.postMessage({ type: "received", sequence: header.sequence });
      if (this.rtcActive) return;
      if (!this.visible || !this.stream || header.streamGeneration !== this.stream.streamGeneration) { this.metricsTracker.recordFrameSkipped(1); return; }
      if (this.decoder?.state !== "configured" || this.frames.size >= this.flight) throw new Error("screen_decoder_congested");
      const receivedAt = performance.now();
      this.metricsTracker.recordFrameReceived({
        sequence: header.sequence,
        streamGeneration: header.streamGeneration,
        bytes: bytes.byteLength,
        width: header.width,
        height: header.height,
        codec: header.codec,
        nowMs: receivedAt,
      });
      this.frames.set(header.sequence, { generation: header.streamGeneration, at: receivedAt, captureMs: header.captureMs });
      this.decoder.decode(new EncodedVideoChunk({ type: header.key ? "key" : "delta", timestamp: header.sequence, data: bytes.subarray(SCREEN_HEADER_BYTES) })); return;
    }
    if (typeof value !== "object" || value === null) throw new Error("screen_protocol_invalid");
    if ((value as { type: string }).type === "native-visibility") {
      if (typeof (value as { visible: unknown }).visible !== "boolean") throw new Error("screen_protocol_invalid");
      this.nativeVisible = (value as { visible: boolean }).visible; this.applyVisibility(); return;
    }
    if ((value as { type: string }).type === "closed") { this.fail(String((value as { reason: string }).reason)); return; }
    // The App refused this document's control request (its window had no focus) and
    // released instead; no lease will come, so return to "Start control".
    if ((value as { type: string }).type === "control-refused") {
      if (this.state.pending) { this.controlRequested = false; this.lease = undefined; this.update({ controlling: false, pending: false }); }
      return;
    }
    if ((value as { type: string }).type === "stream") {
      const stream = screenStreamSchema.parse(value); this.checkQuality(stream);
      if (stream.streamGeneration < this.minimumGeneration) return;
      if (this.rtcActive) this.rtc?.stop();
      this.minimumGeneration = stream.streamGeneration; const epoch = ++this.streamEpoch;
      this.clearMove(); this.picture = undefined; this.frames.clear(); this.closeDecoder(); this.stream = stream;
      this.metricsTracker.resetStream(stream.streamGeneration);
      this.update({ fresh: false, controlling: false, width: stream.width, height: stream.height });
      const config: VideoDecoderConfig = { codec: stream.codecString, codedWidth: stream.width, codedHeight: stream.height, optimizeForLatency: true, hardwareAcceleration: "no-preference" };
      // isConfigSupported is probed before opening; configure synchronously here
      // so the immediately following ordered binary packet has a ready decoder.
      const decoder = new VideoDecoder({ error: () => this.fail("screen_decode_failed"), output: frame => {
        const record = this.frames.get(frame.timestamp);
        try {
          if (!record || record.generation !== this.stream?.streamGeneration || !this.visible || this.disposed || epoch !== this.streamEpoch) return;
          if (this.canvas.width !== stream.width) this.canvas.width = stream.width;
          if (this.canvas.height !== stream.height) this.canvas.height = stream.height;
          const context = this.canvas.getContext("2d", { alpha: false }); if (!context) throw new Error("screen_canvas_unavailable"); context.drawImage(frame, 0, 0);
          const sequence = frame.timestamp;
          requestAnimationFrame(() => {
            // The receipt says how long the frame was here (decode, draw, this repaint), so the target can tell the network's share of the round trip.
            if (this.visible && !this.disposed && epoch === this.streamEpoch) {
              const paintAt = performance.now();
              const heldMs = Math.min(SCREEN_HELD_MAX_MS, Math.max(0, Math.round(paintAt - record.at)));
              const estServerNow = Date.now() + this.serverTimeOffsetMs;
              const rawLatency = estServerNow - record.captureMs;
              const latencyMs = rawLatency >= 0 && rawLatency <= 30_000 ? Math.max(heldMs, Math.round(rawLatency)) : heldMs;
              this.metricsTracker.recordFrameRendered({ nowMs: paintAt, latencyMs });
              this.frames.delete(sequence);
              this.send({ type: "ack", frameSequence: sequence, ...(this.reportHeld ? { heldMs } : {}) });
              this.startRtc();
            }
          });
        } catch (error) { this.fail(error instanceof Error ? error.message : "screen_decode_failed"); } finally { frame.close(); }
      } });
      decoder.configure(config); this.decoder = decoder; return;
    }
    const event = screenViewerEventSchema.parse(value);
    if (event.type === "rtc-frame") {
      if (event.sessionId === this.join.session.id && event.generation === this.join.session.generation && event.streamGeneration === this.minimumGeneration) this.rtc?.receive(event);
    } else if (event.type === "frame-ready") {
      const rtc = event.frameSequence >= SCREEN_RTC_SEQUENCE_START;
      if (!this.visible || rtc !== this.rtcActive || event.streamGeneration !== (rtc ? this.minimumGeneration : this.stream?.streamGeneration) || this.picture && event.frameSequence < this.picture.sequence) return;
      this.picture = { sequence: event.frameSequence, expiresAt: event.expiresAt, at: performance.now() };
      this.update({ fresh: true });
    } else if (event.type === "state") {
      if (event.session.generation !== this.join.session.generation || event.session.id !== this.join.session.id) throw new Error("screen_session_changed");
      if (event.streamGeneration && this.stream && event.streamGeneration > this.stream.streamGeneration) { this.clearMove(); this.picture = undefined; this.frames.clear(); this.closeDecoder(); this.stream = undefined; ++this.streamEpoch; this.metricsTracker.resetStream(event.streamGeneration); }
      if (this.rtcActive && event.streamGeneration && event.streamGeneration > this.minimumGeneration) {
        this.minimumGeneration = event.streamGeneration; this.rtcStartedAt = performance.now(); this.picture = undefined; this.clearMove(); ++this.streamEpoch;
      }
      if (!event.session.controlAllowed || event.session.reason && !event.lease && !event.controlPending) this.controlRequested = false;
      const permitted = this.controlRequested && this.visible && (event.streamGeneration ?? 0) >= this.controlGeneration;
      const lease = permitted ? event.lease : undefined;
      if (lease?.id !== this.lease?.id) { this.clearMove(); this.sequence = 0; }
      this.lease = lease;
      const controlling = !!lease && event.session.state === "controlling";
      this.update({ state: event.session.state === "controlling" && !controlling ? "viewing" : event.session.state, reason: event.session.reason, controlAllowed: event.session.controlAllowed, controlling,
        pending: this.controlRequested && (!!event.controlPending || !permitted), ...(!this.picture ? { fresh: false } : {}) });
      if (event.session.state === "closed") { this.update({ fresh: false, controlling: false, pending: false }); this.dispose(); }
    }
  }
  control() {
    if (!this.state.controlAllowed || !this.picture || !this.state.fresh || !this.visible || this.state.pending) return;
    this.canvas.focus(); this.controlRequested = true; this.controlGeneration = this.minimumGeneration + 1; this.lease = undefined;
    this.update({ controlling: false, pending: true, reason: undefined }); this.send({ type: "control", frameSequence: this.picture.sequence });
  }
  release() { this.clearMove(); this.clearWheel(); this.controlRequested = false; this.send({ type: "release" }); this.lease = undefined; this.usedChallenge = ""; this.update({ controlling: false, pending: false }); }
  visibility(visible: boolean) { this.requestedVisible = visible; this.applyVisibility(); }
  private applyVisibility() {
    const visible = this.requestedVisible && this.nativeVisible;
    if (this.visible === visible) return;
    this.visible = visible; this.release();
    if (!visible) { this.rtc?.stop(); this.rtc = undefined; }
    this.stream = undefined; this.closeDecoder(); ++this.streamEpoch; this.picture = undefined; this.frames.clear();
    this.metricsTracker.resetStream(this.minimumGeneration);
    this.sendVisibility(); this.update({ fresh: false });
  }
  wheel(event: Extract<ScreenInputEvent, { kind: "wheel" }>) {
    if (!this.lease || !this.state.controlling || !this.state.fresh || !this.visible || !this.focused()) return;
    const previous = this.pendingWheel?.leaseId === this.lease.id ? this.pendingWheel.event : undefined;
    this.pendingWheel = { leaseId: this.lease.id, event: { ...event,
      dx: Math.max(-2000, Math.min(2000, (previous?.dx ?? 0) + event.dx)),
      dy: Math.max(-2000, Math.min(2000, (previous?.dy ?? 0) + event.dy)) } };
    this.wheelTimer ??= setTimeout(() => {
      const pending = this.pendingWheel; this.wheelTimer = undefined; this.pendingWheel = undefined;
      if (pending && pending.leaseId === this.lease?.id) this.input(pending.event);
    }, 34);
  }
  private clearWheel() { clearTimeout(this.wheelTimer); this.wheelTimer = undefined; this.pendingWheel = undefined; }
  private clearMove(resetRate = true) { clearTimeout(this.moveTimer); this.moveTimer = undefined; this.pendingMove = undefined; if (resetRate) this.lastMoveAt = -Infinity; }
  private flushMove() {
    const pending = this.pendingMove; this.clearMove(false);
    if (!pending || pending.leaseId !== this.lease?.id || pending.epoch !== this.streamEpoch || !this.canInput()) return;
    let event: Extract<ScreenInputEvent, { kind: "move" }>;
    if ("kind" in pending.event) event = pending.event;
    else {
      // Measure once per sent move, not once per raw pointer event.
      const bounds = this.canvas.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      event = { kind: "move", x: Math.max(0, Math.min(1, (pending.event.clientX - bounds.left) / bounds.width)),
        y: Math.max(0, Math.min(1, (pending.event.clientY - bounds.top) / bounds.height)) };
    }
    if (this.sendInput(event)) this.lastMoveAt = performance.now();
  }
  private canInput() { return !this.disposed && !!this.lease && !!this.picture && this.visible && this.state.controlling && this.state.fresh && this.focused(); }
  pointerMove(position: { clientX: number; clientY: number }) { return this.queueMove({ clientX: position.clientX, clientY: position.clientY }); }
  private queueMove(event: NonNullable<RemoteScreenViewer["pendingMove"]>["event"]) {
    if (!this.canInput()) return false;
    // Preserve the UI's 32 ms movement budget, including the final position
    // when the pointer stops. The first move and button/key edges stay immediate.
    this.pendingMove = { event: { ...event }, leaseId: this.lease!.id, epoch: this.streamEpoch };
    const wait = 32 - (performance.now() - this.lastMoveAt);
    if (wait <= 0) this.flushMove();
    else this.moveTimer ??= setTimeout(() => this.flushMove(), wait);
    return true;
  }
  input(event: ScreenInputEvent) {
    if (!this.canInput()) return false;
    if (event.kind === "move") return this.queueMove(event);
    this.flushMove();
    return this.sendInput(event);
  }
  private sendInput(event: ScreenInputEvent) {
    if (this.disposed || !this.lease || !this.picture || !this.visible || !this.state.controlling || !this.state.fresh || !this.focused()) return false;
    this.send({ type: "input", desktopId: this.join.session.desktopId, displayId: this.join.session.display.id, displayRevision: this.join.session.display.revision,
      leaseId: this.lease.id, sequence: ++this.sequence, frameSequence: this.picture.sequence, expiresAt: this.picture.expiresAt, event }); return true;
  }
  private closeDecoder() {
    const decoder = this.decoder; this.decoder = undefined;
    if (decoder && decoder.state !== "closed") { try { decoder.close(); } catch { /* The decoder may have failed before cleanup. */ } }
  }
  private fail(reason: string) { if (this.disposed) return; this.update({ state: "closed", reason, controlling: false, pending: false, fresh: false }); this.dispose(); }
  dispose() {
    if (this.disposed) return; this.send({ type: "disconnect" }); this.disposed = true; this.rtc?.stop();
    this.clearMove(); this.clearWheel(); clearInterval(this.timer); this.closeDecoder(); this.frames.clear(); this.port?.close();
    this.channel.close();
  }
}
export async function supportedScreenCodecs(quality: ScreenQuality = "balanced"): Promise<("h264" | "vp8")[]> {
  const reason = quality === "sharp" ? "screen_quality_decoder_unavailable" : "screen_decoder_unavailable";
  if (typeof VideoDecoder === "undefined") throw new Error(reason);
  if (quality === "sharp") {
    const profile = SCREEN_QUALITY_PROFILES.sharp, long = profile.longEdge, short = Math.floor(profile.area / long);
    // Sharp has no VP8/low-resolution fallback. Probe both orientations at the
    // negotiated profile's largest bounds before creating a Host session.
    for (const [codedWidth,codedHeight] of [[long,short],[short,long]]) {
      try { if (!(await VideoDecoder.isConfigSupported({codec:"avc1.640033",codedWidth,codedHeight,optimizeForLatency:true,hardwareAcceleration:"no-preference"})).supported) throw new Error(reason); }
      catch { throw new Error(reason); }
    }
    return ["h264"];
  }
  const codecs: ("h264" | "vp8")[] = [];
  for (const [name, codec] of [["h264", "avc1.640028"], ["vp8", "vp8"]] as const) {
    try { if ((await VideoDecoder.isConfigSupported({ codec, codedWidth: 1920, codedHeight: 1080, optimizeForLatency: true, hardwareAcceleration: "no-preference" })).supported) codecs.push(name); }
    catch { /* A codec probe may reject instead of returning unsupported. */ }
  }
  if (!codecs.length) throw new Error(reason); return codecs;
}
