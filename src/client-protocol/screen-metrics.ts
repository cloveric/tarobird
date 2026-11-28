import { z } from "zod";

export const SCREEN_TCP_ROUTES = ["tcp_lan_direct", "tcp_tailscale", "tcp_vps_relay", "tcp_default"] as const;
export type ScreenTcpRouteKind = (typeof SCREEN_TCP_ROUTES)[number];
export const SCREEN_ROUTES = [
  "udp_lan_direct",
  "udp_tailscale_direct",
  "udp_p2p",
  "udp_vps_relay",
  "udp_direct",
  "udp_connected",
  ...SCREEN_TCP_ROUTES,
] as const;
export type ScreenRouteKind = (typeof SCREEN_ROUTES)[number];

export const SCREEN_UDP_REASON_CODES = [
  "disabled",
  "udp_relay_port_closed",
  "udp_transport_unavailable",
  "peer_unsupported",
] as const;
export type ScreenUdpReasonCode = (typeof SCREEN_UDP_REASON_CODES)[number];

export const screenUdpStatusSchema = z.object({
  enabled: z.boolean(),
  state: z.enum(["disabled", "connected", "fallback_tcp"]),
  route: z.enum(SCREEN_ROUTES),
  tcpRoute: z.enum(SCREEN_TCP_ROUTES).optional(),
  reasonCode: z.enum(SCREEN_UDP_REASON_CODES).optional(),
  detail: z.string().max(240).optional(),
}).strict();
export type ScreenUdpStatus = z.infer<typeof screenUdpStatusSchema>;

/** Map a client connection route name to its corresponding TCP screen route label. */
export function tcpRouteFromConnectionRoute(routeName?: "Direct" | "Tailscale" | "VPS"): ScreenTcpRouteKind {
  switch (routeName) {
    case "Direct": return "tcp_lan_direct";
    case "Tailscale": return "tcp_tailscale";
    case "VPS": return "tcp_vps_relay";
    default: return "tcp_default";
  }
}

/**
 * Estimate server-minus-client clock offset using the NTP round-trip midpoint
 * (`serverTime - (requestStart + requestEnd) / 2`) so symmetric one-way network
 * transit delay is preserved in capture-to-display latency measurements.
 * Falls back to `monotonicRttMs` if wall clock stepped backward during the request.
 */
export function estimateServerTimeOffset(
  serverTimeMs: number,
  requestStartMs: number,
  requestEndMs: number,
  monotonicRttMs?: number,
): number {
  const wallRttMs = requestEndMs >= requestStartMs ? requestEndMs - requestStartMs : undefined;
  const rttMs = wallRttMs !== undefined
    ? wallRttMs
    : monotonicRttMs !== undefined && Number.isFinite(monotonicRttMs) && monotonicRttMs >= 0
      ? monotonicRttMs
      : 0;
  return serverTimeMs - (requestEndMs - rttMs / 2);
}

export interface ScreenPerformanceSnapshot {
  fps: number;
  latencyMs: number | null;
  p95LatencyMs: number | null;
  bitrateKbps: number;
  width: number;
  height: number;
  codec: "h264" | "vp8" | "";
  droppedFrames: number;
  skippedFrames: number;
  route: ScreenRouteKind;
  udpRequested: boolean;
  udpConnected: boolean;
  sampleCount: number;
  updatedAt: number;
}

interface FrameSample {
  at: number;
  bytes: number;
}

interface LatencySample {
  at: number;
  latencyMs: number;
}

const WINDOW_MS = 1000;
const LATENCY_WINDOW_MS = 2000;
const MAX_LATENCY_SAMPLES = 60;

/**
 * Pure sliding-window performance tracker for the Remote Screen viewer.
 * Measures FPS, capture-to-display latency (latest & p95), bitrate, resolution,
 * sequence-gap dropped frames, skipped frames, and active transport route.
 */
export class ScreenMetricsTracker {
  private readonly receivedSamples: FrameSample[] = [];
  private readonly renderedSamples: FrameSample[] = [];
  private readonly latencySamples: LatencySample[] = [];
  private lastSequence = 0;
  private lastGeneration = 0;
  private width = 0;
  private height = 0;
  private codec: "h264" | "vp8" | "" = "";
  private droppedFrames = 0;
  private skippedFrames = 0;
  private route: ScreenRouteKind = "tcp_default";
  private udpRequested = false;
  private udpConnected = false;

  setRoute(route: ScreenRouteKind, options: { udpRequested?: boolean; udpConnected?: boolean } = {}): void {
    this.route = route;
    if (options.udpRequested !== undefined) this.udpRequested = options.udpRequested;
    if (options.udpConnected !== undefined) this.udpConnected = options.udpConnected;
  }

  resetStream(generation: number): void {
    this.lastGeneration = generation;
    this.lastSequence = 0;
    this.receivedSamples.length = 0;
    this.renderedSamples.length = 0;
    this.latencySamples.length = 0;
  }

  recordFrameReceived(input: {
    sequence: number;
    streamGeneration: number;
    bytes: number;
    width: number;
    height: number;
    codec: "h264" | "vp8";
    nowMs: number;
  }): void {
    if (input.streamGeneration !== this.lastGeneration) {
      this.lastGeneration = input.streamGeneration;
      this.lastSequence = 0;
    }
    if (this.lastSequence > 0 && input.sequence > this.lastSequence + 1) {
      this.droppedFrames += input.sequence - this.lastSequence - 1;
    }
    if (input.sequence > this.lastSequence) {
      this.lastSequence = input.sequence;
    }
    this.width = input.width;
    this.height = input.height;
    this.codec = input.codec;
    this.receivedSamples.push({ at: input.nowMs, bytes: input.bytes });
    this.prune(input.nowMs);
  }

  /** Stats from the selected WebRTC inbound video, using byte deltas so TCP
   * frames never contribute to the active UDP window. */
  recordRtcStats(input: { nowMs: number; bytes: number; dropped: number; width: number; height: number; codec: "h264" | "vp8" | "" }): void {
    this.width = input.width;
    this.height = input.height;
    this.codec = input.codec;
    this.droppedFrames += input.dropped;
    this.receivedSamples.push({ at: input.nowMs, bytes: input.bytes });
    this.prune(input.nowMs);
  }

  recordFrameSkipped(count = 1): void {
    if (count > 0) this.skippedFrames += count;
  }

  recordFrameRendered(input: {
    nowMs: number;
    latencyMs?: number;
  }): void {
    const latency = input.latencyMs !== undefined && Number.isFinite(input.latencyMs) && input.latencyMs >= 0
      ? Math.round(input.latencyMs)
      : undefined;
    this.renderedSamples.push({ at: input.nowMs, bytes: 0 });
    if (latency !== undefined) this.recordFrameLatency(input.nowMs, latency);
    this.prune(input.nowMs);
  }

  recordFrameLatency(nowMs: number, latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 30_000) return;
    this.latencySamples.push({ at: nowMs, latencyMs: Math.round(latencyMs) });
    if (this.latencySamples.length > MAX_LATENCY_SAMPLES) this.latencySamples.shift();
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - WINDOW_MS;
    while (this.receivedSamples.length > 0 && this.receivedSamples[0]!.at < cutoff) {
      this.receivedSamples.shift();
    }
    while (this.renderedSamples.length > 0 && this.renderedSamples[0]!.at < cutoff) {
      this.renderedSamples.shift();
    }
    const latencyCutoff = nowMs - LATENCY_WINDOW_MS;
    while (this.latencySamples.length > 0 && this.latencySamples[0]!.at < latencyCutoff) {
      this.latencySamples.shift();
    }
  }

  snapshot(nowMs: number): ScreenPerformanceSnapshot {
    this.prune(nowMs);
    const totalBytes = this.receivedSamples.reduce((sum, s) => sum + s.bytes, 0);
    const bitrateKbps = Math.round((totalBytes * 8) / 1000);
    const fps = this.renderedSamples.length;
    const latestLatency = this.latencySamples.length > 0 ? this.latencySamples[this.latencySamples.length - 1]!.latencyMs : null;
    let p95LatencyMs: number | null = null;
    if (this.latencySamples.length > 0) {
      const sorted = this.latencySamples.map(s => s.latencyMs).sort((a, b) => a - b);
      const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
      p95LatencyMs = sorted[idx]!;
    }
    return {
      fps,
      latencyMs: latestLatency,
      p95LatencyMs,
      bitrateKbps,
      width: this.width,
      height: this.height,
      codec: this.codec,
      droppedFrames: this.droppedFrames,
      skippedFrames: this.skippedFrames,
      route: this.route,
      udpRequested: this.udpRequested,
      udpConnected: this.udpConnected,
      sampleCount: this.latencySamples.length,
      updatedAt: nowMs,
    };
  }
}

export interface FakeNetworkProfile {
  name: string;
  route: ScreenRouteKind;
  transport: "tcp" | "udp";
  baseRttMs: number;
  jitterMs: number;
  packetLossRate: number;
  bandwidthKbps: number;
}

export interface FakeNetworkSimulationResult {
  profile: FakeNetworkProfile;
  framesSent: number;
  framesRendered: number;
  avgFps: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  droppedFrames: number;
  skippedFrames: number;
  effectiveBitrateKbps: number;
}

/**
 * Deterministic fake-network simulator for verifying Phase 1 telemetry & flow control
 * under configurable RTT, jitter, packet loss, and bandwidth ceilings.
 * Models TCP head-of-line retransmission stalls vs. UDP loss-tolerant delivery.
 */
export function simulateScreenNetwork(
  profile: FakeNetworkProfile,
  options: { targetFps?: number; durationSec?: number; frameBytes?: number; width?: number; height?: number } = {},
): FakeNetworkSimulationResult {
  const targetFps = options.targetFps ?? 60;
  const durationSec = options.durationSec ?? 2;
  if (!Number.isFinite(targetFps) || targetFps <= 0) throw new RangeError("targetFps must be positive");
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new RangeError("durationSec must be positive");
  const frameBytes = options.frameBytes ?? 14_000;
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  const totalFrames = Math.floor(targetFps * durationSec);
  const intervalMs = 1000 / targetFps;
  const tracker = new ScreenMetricsTracker();
  tracker.setRoute(profile.route, {
    udpRequested: profile.transport === "udp",
    udpConnected: profile.transport === "udp",
  });

  // Deterministic pseudo-random generator (LCG) so tests are 100% reproducible.
  let seed = 1337;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  let bytesInSecond = 0;
  let secondStart = 0;
  let holStallUntilMs = 0;
  let wireSequence = 0;
  let rendered = 0;
  let latencySum = 0;
  let totalBytesSent = 0;
  const allLatencies: number[] = [];
  const maxBytesPerSec = (profile.bandwidthKbps * 1000) / 8;

  for (let i = 1; i <= totalFrames; i++) {
    const captureMs = Math.round((i - 1) * intervalMs);
    if (captureMs - secondStart >= 1000) {
      secondStart = captureMs;
      bytesInSecond = 0;
    }

    // Bandwidth gate: skip frame before transmission when pacing budget is exhausted.
    if (bytesInSecond + frameBytes > maxBytesPerSec) {
      tracker.recordFrameSkipped(1);
      continue;
    }
    wireSequence++;
    bytesInSecond += frameBytes;
    totalBytesSent += frameBytes;

    const lost = nextRand() < profile.packetLossRate;
    const jitter = Math.round(nextRand() * profile.jitterMs);
    const oneWay = Math.round(profile.baseRttMs / 2) + jitter;
    const wireSerializeMs = Math.round((frameBytes * 8) / Math.max(1, profile.bandwidthKbps));
    const decodeMs = 4;

    if (profile.transport === "udp" && lost) {
      // UDP drops the single lost frame without stalling subsequent frames.
      continue;
    }

    let arriveMs = captureMs + oneWay + wireSerializeMs;
    if (profile.transport === "tcp") {
      if (lost) {
        // TCP retransmits after ~1.5x RTT, causing head-of-line blocking for queued frames.
        const retransmitFinish = arriveMs + Math.round(profile.baseRttMs * 1.5);
        holStallUntilMs = Math.max(holStallUntilMs, retransmitFinish);
      }
      if (arriveMs < holStallUntilMs) {
        arriveMs = holStallUntilMs;
      }
    }

    const displayMs = arriveMs + decodeMs;
    const e2eLatency = displayMs - captureMs;
    tracker.recordFrameReceived({
      sequence: wireSequence,
      streamGeneration: 1,
      bytes: frameBytes,
      width,
      height,
      codec: "h264",
      nowMs: displayMs,
    });
    tracker.recordFrameRendered({ nowMs: displayMs, latencyMs: e2eLatency });
    rendered++;
    latencySum += e2eLatency;
    allLatencies.push(e2eLatency);
  }

  let p95LatencyMs = 0;
  if (allLatencies.length > 0) {
    const sorted = [...allLatencies].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
    p95LatencyMs = sorted[idx]!;
  }
  const snap = tracker.snapshot(Math.round(totalFrames * intervalMs) + profile.baseRttMs + 20);
  return {
    profile,
    framesSent: wireSequence,
    framesRendered: rendered,
    avgFps: Math.round((rendered / durationSec) * 10) / 10,
    avgLatencyMs: rendered > 0 ? Math.round(latencySum / rendered) : 0,
    p95LatencyMs,
    droppedFrames: snap.droppedFrames,
    skippedFrames: snap.skippedFrames,
    effectiveBitrateKbps: Math.round((totalBytesSent * 8) / (durationSec * 1000)),
  };
}
