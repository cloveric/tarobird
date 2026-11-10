import { SCREEN_QUALITY_PROFILES, screenQualityProfile, type ScreenQuality } from "../../src/client-protocol/screen-quality.js";
import { screenStreamSchema, screenViewerEventSchema, type ScreenInputEvent, type ScreenJoin, type ScreenStream } from "../../src/client-protocol/remote-screen.js";
import { readScreenFrame, SCREEN_HEADER_BYTES } from "../../src/client-protocol/screen-wire.js";
import { invoke } from "./desktop-bridge.js";

export type ViewerState = { state: string; reason?: string; controlAllowed?: boolean; controlling: boolean; pending: boolean; fresh: boolean; width?: number; height?: number };
/** One controller object per explicit viewing session; never reconnects/replays. */
export class RemoteScreenViewer {
  state: ViewerState = { state: "connecting", controlling: false, pending: false, fresh: false };
  private port?: MessagePort; private decoder?: VideoDecoder; private stream?: ScreenStream;
  private frames = new Map<number, { generation: number; at: number }>();
  private picture?: { sequence: number; expiresAt: number; at: number };
  private lease?: { id: string; challenge: string }; private usedChallenge = ""; private sequence = 0;
  private disposed = false; private visible = true; private requestedVisible = true; private nativeVisible = true; private timer: ReturnType<typeof setInterval>;
  private wheelTimer?: ReturnType<typeof setTimeout>; private pendingWheel?: { event: Extract<ScreenInputEvent, { kind: "wheel" }>; leaseId: string };
  private lastMoveAt = -Infinity;
  private moveTimer?: ReturnType<typeof setTimeout>; private pendingMove?: { event: Extract<ScreenInputEvent, { kind: "move" }> | { clientX: number; clientY: number }; leaseId: string; epoch: number };
  private inputFocused = false;
  private controlRequested = false; private controlGeneration = 0; private receivePort?: (event: MessageEvent) => void;
  private minimumGeneration = 1; private streamEpoch = 0; private openTimer?: ReturnType<typeof setTimeout>;
  constructor(readonly join: ScreenJoin, private canvas: HTMLCanvasElement, private change: (state: ViewerState) => void) {
    this.state.controlAllowed = join.session.controlAllowed;
    this.timer = setInterval(() => {
      const fresh = !!this.picture && performance.now() - this.picture.at < 1500;
      if (!fresh && this.state.fresh) { this.release(); this.update({ fresh: false }); }
      if (fresh && this.lease && this.visible && this.focused() && this.usedChallenge !== this.lease.challenge) {
        this.usedChallenge = this.lease.challenge;
        this.send({ type: "renew", leaseId: this.lease.id, challenge: this.lease.challenge, frameSequence: this.picture!.sequence });
      }
    }, 1000);
  }
  private update(next: Partial<ViewerState>) {
    const changed = (Object.keys(next) as (keyof ViewerState)[]).some(key => this.state[key] !== next[key]);
    if (changed) this.state = { ...this.state, ...next };
    const focused = this.state.controlling && this.focused();
    if (focused !== this.inputFocused) { this.inputFocused = focused; this.send({ type: "input-focus", enabled: focused }); }
    if (changed) this.change(this.state);
  }
  private focused() { return document.hasFocus() && document.activeElement === this.canvas && document.visibilityState === "visible"; }
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
    const channelId = crypto.randomUUID();
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== location.origin || event.data?.type !== "tarobot:screen-port:v1" || event.data.channelId !== channelId || event.data.sessionId !== this.join.session.id || event.ports.length !== 1) return;
      window.removeEventListener("message", receive); clearTimeout(this.openTimer);
      if (this.disposed) { event.ports[0]!.close(); return; }
      this.port = event.ports[0]; this.port.onmessage = e => { void this.message(e.data).catch(error => this.fail(error instanceof Error ? error.message : "screen_decode_failed")); }; this.port.start();
      if (!this.visible) this.sendVisibility();
    };
    this.receivePort = receive; window.addEventListener("message", receive);
    this.openTimer = setTimeout(() => { window.removeEventListener("message", receive); this.fail("screen_connect_timeout"); }, 10_000);
    try { await invoke("screen_viewer_open", { channelId, join: this.join, network }); }
    catch (error) { window.removeEventListener("message", receive); clearTimeout(this.openTimer); this.fail(error instanceof Error ? error.message : "screen_open_failed"); throw error; }
  }
  private checkQuality(value: {width:number;height:number;codec:string}) {
    const limit=screenQualityProfile(this.join.quality);
    if(Math.max(value.width,value.height)>limit.longEdge||value.width*value.height>limit.area||limit.h264Only&&value.codec!=="h264")throw new Error("screen_stream_invalid");
  }
  private async message(value: unknown) {
    if (this.disposed) return;
    if (value instanceof ArrayBuffer) {
      const bytes = new Uint8Array(value), header = readScreenFrame(bytes);
      this.checkQuality(header);
      this.port?.postMessage({ type: "received", sequence: header.sequence });
      if (!this.visible || !this.stream || header.streamGeneration !== this.stream.streamGeneration) return;
      if (this.decoder?.state !== "configured" || this.frames.size >= 3) throw new Error("screen_decoder_congested");
      this.frames.set(header.sequence, { generation: header.streamGeneration, at: performance.now() });
      this.decoder.decode(new EncodedVideoChunk({ type: header.key ? "key" : "delta", timestamp: header.sequence, data: bytes.subarray(SCREEN_HEADER_BYTES) })); return;
    }
    if (typeof value !== "object" || value === null) throw new Error("screen_protocol_invalid");
    if ((value as { type: string }).type === "native-visibility") {
      if (typeof (value as { visible: unknown }).visible !== "boolean") throw new Error("screen_protocol_invalid");
      this.nativeVisible = (value as { visible: boolean }).visible; this.applyVisibility(); return;
    }
    if ((value as { type: string }).type === "closed") { this.fail(String((value as { reason: string }).reason)); return; }
    if ((value as { type: string }).type === "stream") {
      const stream = screenStreamSchema.parse(value); this.checkQuality(stream); if (stream.streamGeneration < this.minimumGeneration) return; this.minimumGeneration = stream.streamGeneration; const epoch = ++this.streamEpoch;
      this.clearMove(); this.picture = undefined; this.frames.clear(); this.closeDecoder(); this.stream = stream;
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
            if (this.visible && !this.disposed && epoch === this.streamEpoch) { this.frames.delete(sequence); this.send({ type: "ack", frameSequence: sequence }); }
          });
        } catch (error) { this.fail(error instanceof Error ? error.message : "screen_decode_failed"); } finally { frame.close(); }
      } });
      decoder.configure(config); this.decoder = decoder; return;
    }
    const event = screenViewerEventSchema.parse(value);
    if (event.type === "frame-ready") {
      if (!this.visible || event.streamGeneration !== this.stream?.streamGeneration || this.picture && event.frameSequence < this.picture.sequence) return;
      this.picture = { sequence: event.frameSequence, expiresAt: event.expiresAt, at: performance.now() };
      this.update({ fresh: true });
    } else if (event.type === "state") {
      if (event.session.generation !== this.join.session.generation || event.session.id !== this.join.session.id) throw new Error("screen_session_changed");
      if (event.streamGeneration && this.stream && event.streamGeneration > this.stream.streamGeneration) { this.clearMove(); this.picture = undefined; this.frames.clear(); this.closeDecoder(); this.stream = undefined; ++this.streamEpoch; }
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
    this.canvas.focus(); this.controlRequested = true; this.controlGeneration = (this.stream?.streamGeneration ?? 0) + 1; this.lease = undefined;
    this.update({ controlling: false, pending: true, reason: undefined }); this.send({ type: "control", frameSequence: this.picture.sequence });
  }
  release() { this.clearMove(); this.clearWheel(); this.controlRequested = false; this.send({ type: "release" }); this.lease = undefined; this.usedChallenge = ""; this.update({ controlling: false, pending: false }); }
  visibility(visible: boolean) { this.requestedVisible = visible; this.applyVisibility(); }
  private applyVisibility() {
    const visible = this.requestedVisible && this.nativeVisible;
    if (this.visible === visible) return;
    this.visible = visible; this.release(); this.stream = undefined; this.closeDecoder(); ++this.streamEpoch; this.picture = undefined; this.frames.clear();
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
    if (this.disposed) return; this.send({ type: "disconnect" }); this.disposed = true;
    if (this.receivePort) window.removeEventListener("message", this.receivePort); this.receivePort = undefined;
    this.clearMove(); this.clearWheel(); clearInterval(this.timer); clearTimeout(this.openTimer); this.closeDecoder(); this.frames.clear(); this.port?.close();
    void invoke("screen_viewer_close", { sessionId: this.join.session.id }).catch(() => undefined);
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
