import type { ScreenJoin } from "../../src/client-protocol/remote-screen.js";
import { screenRtcAnswerText, screenRtcDirection, screenRtcHasRoute, screenRtcModeSchema, screenRtcPrepareSchema, screenRtcAnswerSchema,
  type ScreenRtcMode, type ScreenRtcFrame } from "../../src/client-protocol/screen-rtc.js";
import { screenRtcCodecs, screenRtcConfiguration, screenRtcGather, screenRtcSelectedRoute } from "../../src/client-protocol/screen-rtc-browser.js";
import { screenQualityProfile } from "../../src/client-protocol/screen-quality.js";
import { anySignal, timeoutSignal } from "./abort-signals.js";

export type ScreenRtcScope = Pick<ScreenJoin["session"], "id" | "generation" | "desktopId" | "deviceId">;
export type ScreenRtcSignaling = {
  request: (request: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  signOffer: (scope: ScreenRtcScope, nonce: string, mode: ScreenRtcMode, sdp: string) => Promise<string>;
  verifyAnswer: (text: string, signature: string) => boolean;
};
type RtcRoute = NonNullable<ReturnType<typeof screenRtcSelectedRoute>>;
export type RtcDraw = { picture: CanvasImageSource; width: number; height: number; route: RtcRoute; stamp?: ScreenRtcFrame };
export type RtcStats = { bytes: number; dropped: number; codec: "h264" | "vp8" | "" };

type Attempt = {
  mode: ScreenRtcMode; nonce: string; pc: RTCPeerConnection; video: HTMLVideoElement; scratch?: HTMLCanvasElement;
  lastPicture?: { timestamp: number; width: number; height: number }; callback?: number;
  painted: boolean; route?: RtcRoute; lastPaintAt: number; stamps: Map<number, ScreenRtcFrame>;
};
export const canReceiveScreenRtc = () => typeof RTCPeerConnection === "function"
  && typeof HTMLVideoElement.prototype.requestVideoFrameCallback === "function"
  && typeof RTCRtpReceiver === "function" && screenRtcCodecs(RTCRtpReceiver.getCapabilities?.("video")?.codecs).length > 0;

/** One-shot timed attempts. The existing authenticated TCP picture remains
 * usable until a stamped WebRTC frame has actually been painted. */
export class ScreenRtcReceiver {
  private readonly life = new AbortController();
  private attempt?: Attempt;
  private statsTimer?: ReturnType<typeof setInterval>;
  private started = false;

  constructor(private readonly join: ScreenJoin, private readonly signaler: ScreenRtcSignaling,
    private readonly onDraw: (value: RtcDraw) => void, private readonly onReceipt: (stamp: ScreenRtcFrame) => void,
    private readonly onStats: (value: RtcStats) => void, private readonly onFallback: () => void) {}

  start(): void {
    if (this.started || this.life.signal.aborted) return;
    this.started = true;
    void this.run();
  }

  receive(stamp: ScreenRtcFrame): void {
    const a = this.attempt;
    if (!a || a.nonce !== stamp.nonce) return;
    if (a.lastPicture?.timestamp === stamp.rtpTimestamp && a.route) {
      if (a.painted) this.onReceipt(stamp);
      else if (a.scratch) this.draw(a, a.scratch, a.lastPicture.width, a.lastPicture.height, stamp);
      return;
    }
    a.stamps.set(stamp.rtpTimestamp, stamp);
    if (a.stamps.size > 120) a.stamps.delete(a.stamps.keys().next().value!);
  }

  stop(): void {
    this.life.abort();
    if (this.attempt) void this.retire(this.attempt);
  }

  private async run() {
    const { id: sessionId, generation } = this.join.session;
    for (const mode of screenRtcModeSchema.options) {
      if (this.life.signal.aborted) break;
      let nonce: string | undefined;
      let a: Attempt | undefined;
      try {
        const attemptSignal = anySignal([this.life.signal, timeoutSignal(13_000)]);
        const prepared = screenRtcPrepareSchema.parse(await this.signaler.request({ type: "prepare", sessionId, generation, mode }, attemptSignal));
        nonce = prepared.nonce;
        if (attemptSignal.aborted) throw attemptSignal.reason;
        if (prepared.mode !== mode) throw new Error("screen_rtc_attempt_changed");
        const pc = new RTCPeerConnection(screenRtcConfiguration(mode, prepared.ice)), video = document.createElement("video");
        a = this.attempt = { mode, nonce, pc, video, painted: false, lastPaintAt: 0, stamps: new Map() };
        this.watch(a);
        pc.addTransceiver("video", { direction: "recvonly" }).setCodecPreferences(screenRtcCodecs(RTCRtpReceiver.getCapabilities("video")?.codecs));
        const sdp = await screenRtcGather(pc, await pc.createOffer(), mode, attemptSignal);
        const proof = await this.signaler.signOffer(this.join.session, nonce, mode, sdp);
        const answer = screenRtcAnswerSchema.parse(await this.signaler.request({ type: "offer", sessionId, generation, nonce, sdp, signature: proof }, attemptSignal));
        if (attemptSignal.aborted) throw attemptSignal.reason;
        const signed = screenRtcAnswerText({ sessionId, generation, desktopId: this.join.session.desktopId, deviceId: this.join.session.deviceId,
          nonce, mode, offer: sdp, sdp: answer.sdp });
        if (!screenRtcDirection(answer.sdp, "sendonly") || !screenRtcHasRoute(answer.sdp, mode, prepared.ice) || !this.signaler.verifyAnswer(signed, answer.signature)) throw new Error("screen_rtc_proof_invalid");
        await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
        await this.waitForPicture(a, mode === "relay" ? 4200 : 1800, attemptSignal);
        return;
      } catch {
        if (a) await this.retire(a);
        else if (nonce) await this.release(nonce);
      }
    }
  }

  private waitForPicture(a: Attempt, ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (a.painted && this.attempt === a) { clearInterval(timer); resolve(); }
        else if (signal.aborted || this.attempt !== a || performance.now() >= until || a.pc.connectionState === "failed") {
          clearInterval(timer); reject(new Error("screen_rtc_no_picture"));
        }
      }, 50);
      const until = performance.now() + ms;
    });
  }

  private watch(a: Attempt) {
    const { pc, video } = a;
    video.muted = true; video.playsInline = true; video.autoplay = true;
    // Keep the receiver eligible for composition in WebKit; the shared canvas
    // provides the visible image and the existing interaction geometry.
    Object.assign(video.style, { position: "fixed", top: "0", left: "0", width: "1px", height: "1px", opacity: "0", pointerEvents: "none" });
    video.setAttribute("aria-hidden", "true");
    document.body.append(video);
    pc.ontrack = event => {
      if (this.attempt !== a || event.track.kind !== "video") return;
      video.srcObject = new MediaStream([event.track]);
      void video.play().catch(() => undefined);
    };
    const next: VideoFrameRequestCallback = (_now, meta) => {
      if (this.attempt !== a) return;
      a.callback = video.requestVideoFrameCallback(next);
      if (!a.route || !Number.isInteger(meta.rtpTimestamp) || !this.sizeValid(meta.width, meta.height)) return;
      const timestamp = meta.rtpTimestamp!;
      a.lastPicture = { timestamp, width: meta.width, height: meta.height };
      const stamp = a.stamps.get(timestamp);
      a.stamps.delete(timestamp);
      if (stamp || a.painted) this.draw(a, video, meta.width, meta.height, stamp);
      else {
        const scratch = a.scratch ??= document.createElement("canvas");
        if (scratch.width !== meta.width) scratch.width = meta.width;
        if (scratch.height !== meta.height) scratch.height = meta.height;
        scratch.getContext("2d", { alpha: false })?.drawImage(video, 0, 0, meta.width, meta.height);
      }
    };
    a.callback = video.requestVideoFrameCallback(next);
    let busy = false;
    this.statsTimer = setInterval(() => {
      if (this.attempt !== a || busy) return;
      if (a.painted && (performance.now() - a.lastPaintAt > 2000 || pc.connectionState === "failed")) { void this.retire(a); return; }
      busy = true;
      void pc.getStats().then(report => {
        if (this.attempt !== a) return;
        const live = [...report.values()].find(value => value.type === "inbound-rtp" && value.kind === "video");
        const transport = live && report.get(live.transportId);
        const selected = transport && report.get(transport.selectedCandidatePairId);
        const local = selected && report.get(selected.localCandidateId), remote = selected && report.get(selected.remoteCandidateId);
        const route = screenRtcSelectedRoute(transport?.dtlsState, local, remote);
        a.route = (a.mode === "relay") === (route === "udp_vps_relay") ? route : undefined;
        if (a.painted && !a.route) { void this.retire(a); return; }
        if (a.painted && live) {
          const codec = report.get(live.codecId)?.mimeType?.toLowerCase();
          this.onStats({ bytes: live.bytesReceived ?? 0, dropped: live.framesDropped ?? 0, codec: codec === "video/h264" ? "h264" : codec === "video/vp8" ? "vp8" : "" });
        }
      }).catch(() => undefined).finally(() => { busy = false; });
    }, 250);
  }

  private sizeValid(width: number, height: number) {
    const display = this.join.session.display, quality = screenQualityProfile(this.join.quality);
    return width > 0 && height > 0 && Math.max(width, height) <= quality.longEdge && width * height <= quality.area
      && Math.abs(width / height - display.width / display.height) <= .03;
  }

  private draw(a: Attempt, picture: CanvasImageSource, width: number, height: number, stamp?: ScreenRtcFrame) {
    if (this.attempt !== a || !a.route) return;
    a.painted = true; a.lastPaintAt = performance.now(); a.scratch = undefined;
    this.onDraw({ picture, width, height, route: a.route, stamp });
  }

  private async retire(a: Attempt) {
    if (this.attempt !== a) return;
    this.attempt = undefined;
    clearInterval(this.statsTimer);
    if (a.callback !== undefined) a.video.cancelVideoFrameCallback(a.callback);
    a.video.srcObject = null; a.video.remove();
    a.pc.close();
    if (a.painted) this.onFallback();
    await this.release(a.nonce);
  }

  private async release(nonce: string) {
    const { id: sessionId, generation } = this.join.session;
    try {
      await this.signaler.request({ type: "close", sessionId, generation, nonce }, timeoutSignal(2000));
    } catch { /* The Hub also expires attempts if signaling is gone. */ }
  }
}
