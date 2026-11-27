import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CAPABILITIES, SERVER_CAPABILITIES } from "../src/client-protocol/index.js";
import {
  REMOTE_SCREEN_UDP_BOOST_CAPABILITY,
  screenConfigureSchema,
  screenConfigureText,
  screenDisplaySchema,
  screenPolicySchema,
  screenStatusSchema,
  type ScreenJoin,
} from "../src/client-protocol/remote-screen.js";
import {
  ScreenMetricsTracker,
  estimateServerTimeOffset,
  simulateScreenNetwork,
  tcpRouteFromConnectionRoute,
  type FakeNetworkProfile,
} from "../src/client-protocol/screen-metrics.js";
import { deviceActionProofText } from "../src/client-protocol/device-actions.js";
import { writeScreenFrame } from "../src/client-protocol/screen-wire.js";
import { HubServer } from "../src/hub/server.js";
import { hashSecret } from "../src/hub/auth.js";
import { deviceFields, enrollTrusted, loginFor, testDevice } from "./helpers/pairing-invite.js";
import { RemoteScreenViewer, type ViewerState } from "../client/src/remote-screen-viewer.js";
import type { ScreenViewerPort, ScreenViewerTransport } from "../client/src/screen-viewer-transport.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const close of cleanups.reverse()) await close();
  cleanups.length = 0;
});

/** Pre-PR#135 strict schemas (v1.6.0): neither udpStatus nor policy.udpBoost exists. */
const legacyPolicySchema = z.object({
  revision: z.number().int().nonnegative(),
  enabled: z.boolean(),
  grants: z.array(z.object({ deviceId: z.string(), publicKey: z.string(), permission: z.enum(["view", "control"]) }).strict()),
}).strict();
const legacyStatusSchema = z.object({
  supported: z.literal(true),
  enabled: z.boolean(),
  canManage: z.boolean(),
  permission: z.enum(["none", "view", "control"]),
  policy: legacyPolicySchema.optional(),
  devices: z.unknown().optional(),
  desktop: z.object({
    desktopId: z.string(), instanceId: z.string(), loginSession: z.string(), platform: z.literal("macos"),
    capture: z.enum(["granted", "denied", "not-determined", "unavailable"]), accessibility: z.boolean(), locked: z.boolean(),
    displays: z.array(screenDisplaySchema).max(16),
  }).strict().nullable(),
  sessions: z.array(z.unknown()).max(2),
  serverTime: z.number(),
}).strict();

describe("Issue #80 Phase 1: Remote screen observability & opt-in UDP boost", () => {
  it("advertises desktop.screen.udp-boost.v1 only in SERVER_CAPABILITIES", () => {
    expect(SERVER_CAPABILITIES).toContain(REMOTE_SCREEN_UDP_BOOST_CAPABILITY);
    expect(CAPABILITIES).not.toContain(REMOTE_SCREEN_UDP_BOOST_CAPABILITY);
  });

  it("tracks FPS, capture-to-display latency (latest & p95), bitrate, resolution, and dropped/skipped frames, and expires stale latency", () => {
    const tracker = new ScreenMetricsTracker();
    tracker.setRoute("tcp_lan_direct", { udpRequested: false, udpConnected: false });

    // Deliver 10 frames in 500ms, skipping sequence #4 to simulate 1 dropped frame and recording 2 skipped frames.
    const sequences = [1, 2, 3, 5, 6, 7, 8, 9, 10, 11];
    sequences.forEach((seq, idx) => {
      const now = 1000 + idx * 50;
      tracker.recordFrameReceived({
        sequence: seq,
        streamGeneration: 1,
        bytes: 12_500, // 100 kbits per frame -> 10 frames = 1000 kbps
        width: 1920,
        height: 1080,
        codec: "h264",
        nowMs: now,
      });
      tracker.recordFrameRendered({ nowMs: now, latencyMs: 18 + idx * 2 });
    });
    tracker.recordFrameSkipped(2);

    const snap = tracker.snapshot(1500);
    expect(snap.fps).toBe(10);
    expect(snap.bitrateKbps).toBe(1000);
    expect(snap.width).toBe(1920);
    expect(snap.height).toBe(1080);
    expect(snap.codec).toBe("h264");
    expect(snap.droppedFrames).toBe(1);
    expect(snap.skippedFrames).toBe(2);
    expect(snap.latencyMs).toBe(36);
    expect(snap.p95LatencyMs).toBeGreaterThanOrEqual(34);
    expect(snap.route).toBe("tcp_lan_direct");
    expect(snap.udpRequested).toBe(false);
    expect(snap.udpConnected).toBe(false);

    // After a stall (> 2s without new frames), FPS, bitrate, and stale latency clear.
    const stalled = tracker.snapshot(3600);
    expect(stalled.fps).toBe(0);
    expect(stalled.bitrateKbps).toBe(0);
    expect(stalled.latencyMs).toBeNull();
    expect(stalled.p95LatencyMs).toBeNull();
    expect(stalled.sampleCount).toBe(0);

    // Stream reset immediately clears sliding-window samples while preserving cumulative counters and route.
    tracker.recordFrameRendered({ nowMs: 4000, latencyMs: 42 });
    expect(tracker.snapshot(4100).latencyMs).toBe(42);
    tracker.resetStream(2);
    const afterReset = tracker.snapshot(4100);
    expect(afterReset.fps).toBe(0);
    expect(afterReset.latencyMs).toBeNull();
    expect(afterReset.p95LatencyMs).toBeNull();
    expect(afterReset.droppedFrames).toBe(1);
    expect(afterReset.skippedFrames).toBe(2);
    expect(afterReset.route).toBe("tcp_lan_direct");
  });

  it("simulates TCP vs UDP accurately without double-counting skipped frames as dropped, and computes simulation-wide p95", () => {
    const cappedTcp: FakeNetworkProfile = {
      name: "Capped TCP 0% loss",
      route: "tcp_vps_relay",
      transport: "tcp",
      baseRttMs: 40,
      jitterMs: 0,
      packetLossRate: 0,
      bandwidthKbps: 4_000,
    };
    const capped = simulateScreenNetwork(cappedTcp, { targetFps: 60, durationSec: 2, frameBytes: 12_000 });
    expect(capped.framesSent).toBe(82);
    expect(capped.framesRendered).toBe(82);
    expect(capped.skippedFrames).toBe(38);
    expect(capped.droppedFrames).toBe(0);

    expect(() => simulateScreenNetwork(cappedTcp, { durationSec: 0 })).toThrow(RangeError);
    expect(() => simulateScreenNetwork(cappedTcp, { targetFps: -1 })).toThrow(RangeError);

    const pairs: Array<[FakeNetworkProfile, FakeNetworkProfile]> = [
      [
        { name: "LAN TCP", route: "tcp_lan_direct", transport: "tcp", baseRttMs: 4, jitterMs: 2, packetLossRate: 0, bandwidthKbps: 40_000 },
        { name: "LAN UDP", route: "udp_lan_direct", transport: "udp", baseRttMs: 4, jitterMs: 2, packetLossRate: 0, bandwidthKbps: 40_000 },
      ],
      [
        { name: "VPS Relay TCP", route: "tcp_vps_relay", transport: "tcp", baseRttMs: 45, jitterMs: 12, packetLossRate: 0.03, bandwidthKbps: 4_000 },
        { name: "VPS Relay UDP", route: "udp_vps_relay", transport: "udp", baseRttMs: 45, jitterMs: 12, packetLossRate: 0.03, bandwidthKbps: 8_000 },
      ],
      [
        { name: "Tailscale TCP", route: "tcp_tailscale", transport: "tcp", baseRttMs: 32, jitterMs: 8, packetLossRate: 0.02, bandwidthKbps: 4_000 },
        { name: "Tailscale UDP", route: "udp_tailscale_direct", transport: "udp", baseRttMs: 28, jitterMs: 6, packetLossRate: 0.02, bandwidthKbps: 10_000 },
      ],
      [
        { name: "Phone 4G/5G TCP", route: "tcp_vps_relay", transport: "tcp", baseRttMs: 75, jitterMs: 25, packetLossRate: 0.05, bandwidthKbps: 3_500 },
        { name: "Phone 4G/5G UDP", route: "udp_vps_relay", transport: "udp", baseRttMs: 70, jitterMs: 20, packetLossRate: 0.05, bandwidthKbps: 6_000 },
      ],
    ];

    for (const [tcpProfile, udpProfile] of pairs) {
      const tcpRes = simulateScreenNetwork(tcpProfile, { targetFps: 60, durationSec: 2, frameBytes: 12_000 });
      const udpRes = simulateScreenNetwork(udpProfile, { targetFps: 60, durationSec: 2, frameBytes: 12_000 });
      expect(tcpRes.framesRendered).toBeGreaterThan(0);
      expect(udpRes.framesRendered).toBeGreaterThan(0);
      expect(tcpRes.framesSent).toBeLessThanOrEqual(120);
      if (tcpProfile.packetLossRate > 0) {
        // Under packet loss, TCP head-of-line blocking inflates p95 latency relative to UDP.
        expect(udpRes.p95LatencyMs).toBeLessThan(tcpRes.p95LatencyMs);
      }
    }
  });

  it("maps connection routes and estimates server clock offset with NTP midpoint without cancelling network delay", () => {
    expect(tcpRouteFromConnectionRoute("Direct")).toBe("tcp_lan_direct");
    expect(tcpRouteFromConnectionRoute("Tailscale")).toBe("tcp_tailscale");
    expect(tcpRouteFromConnectionRoute("VPS")).toBe("tcp_vps_relay");
    expect(tcpRouteFromConnectionRoute(undefined)).toBe("tcp_default");

    // Symmetric 100ms RTT (D=50ms each way) with +5000ms server clock skew.
    const skew = 5000;
    const t0 = 10_000;
    const serverTimeAtHalf = t0 + skew + 50;
    const t1 = 10_100;
    expect(estimateServerTimeOffset(serverTimeAtHalf, t0, t1)).toBe(skew);

    // Wall clock step backward falls back to monotonic RTT.
    expect(estimateServerTimeOffset(serverTimeAtHalf, 10_500, 10_100, 100)).toBe(serverTimeAtHalf - 10_050);
  });

  it("preserves symmetric network RTT in RemoteScreenViewer E2E latency and suppresses metrics before port attach or while hidden", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const outputs: ((frame: { timestamp: number; close(): void }) => void)[] = [];
    class Decoder {
      state = "unconfigured";
      constructor(init: { output: (frame: { timestamp: number; close(): void }) => void }) { outputs.push(init.output); }
      configure() { this.state = "configured"; }
      decode() {}
      close() { this.state = "closed"; }
    }
    vi.stubGlobal("VideoDecoder", Decoder);
    vi.stubGlobal("EncodedVideoChunk", class { constructor(readonly init: unknown) {} });
    const repaints: (() => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (run: () => void) => { repaints.push(run); return repaints.length; });

    // Simulate high worker uptime (>= 5s) + +5000ms server clock skew + 100ms symmetric RTT (50ms one-way).
    let wallNow = 20_000;
    let monoNow = 10_000;
    const skew = 5000;
    vi.spyOn(Date, "now").mockImplementation(() => wallNow);
    vi.spyOn(performance, "now").mockImplementation(() => monoNow);

    const openStart = wallNow;
    const serverTime = openStart + skew + 50; // arrived at server after 50ms uplink
    wallNow += 100; monoNow += 100; // response returned after 50ms downlink
    const serverTimeOffsetMs = estimateServerTimeOffset(serverTime, openStart, wallNow);

    const display = { id: "d1", nativeId: "1", name: "Display", revision: 1, x: 0, y: 0, width: 1280, height: 720, scale: 1, rotation: 0 as const };
    const session = { id: "screen_lat", desktopId: "desktop_lat", deviceId: "viewer_lat", deviceName: "Viewer", generation: "gen_lat", display, controlAllowed: true, state: "viewing" as const, createdAt: 1 };
    const join: ScreenJoin = { session, controlTicket: "c".repeat(43), mediaTicket: "m".repeat(43), expiresAt: wallNow + 30_000, serverTime };

    let deliver: ((msg: unknown) => void) | undefined;
    let attachPort: (() => void) | undefined;
    const port: ScreenViewerPort = { postMessage: () => {}, start: fn => { deliver = fn; }, close: () => {} };
    const transport: ScreenViewerTransport = () => ({
      open: async (_net, handlers) => { attachPort = () => handlers.attach(port); },
      close: () => {},
    });
    const canvas = { width: 0, height: 0, focus() {}, getContext: () => ({ drawImage() {} }) } as unknown as HTMLCanvasElement;
    const states: ViewerState[] = [];
    const viewer = new RemoteScreenViewer(join, canvas, s => states.push(s), {
      transport,
      inputActive: () => true,
      routeHint: "tcp_vps_relay",
      serverTimeOffsetMs,
    });
    await viewer.open({});

    // Before port attach, 500ms timer must NOT emit spurious metrics state updates.
    monoNow += 3000; wallNow += 3000;
    vi.advanceTimersByTime(3000);
    expect(states).toEqual([]);

    attachPort!();
    deliver!({ type: "state", session, serverTime: wallNow + skew });
    deliver!({ type: "stream", streamGeneration: 1, geometryRevision: 1, codec: "h264", codecString: "avc1.640028", width: 1280, height: 720, contentRect: { x: 0, y: 0, width: 1280, height: 720 } });

    // Frame captured on server at T_cap; encode=5ms, downlink=50ms -> arrives at client at T_cap - skew + 55ms.
    const captureMs = wallNow + skew;
    wallNow += 55; monoNow += 55;
    const pkt = writeScreenFrame({ key: true, codec: "h264", sequence: 1, geometryRevision: 1, streamGeneration: 1, captureMs, width: 1280, height: 720 }, new Uint8Array([0, 0, 0, 1, 0x65]));
    deliver!(pkt.buffer);
    // Decode + paint takes 10ms -> true E2E = 5 + 50 + 10 = 65ms.
    wallNow += 10; monoNow += 10;
    outputs.at(-1)!({ timestamp: 1, close() {} });
    repaints.splice(0).forEach(fn => fn());

    // Advance 500ms so metrics snapshot publishes.
    monoNow += 500; wallNow += 500;
    vi.advanceTimersByTime(500);
    expect(viewer.state.metrics).toMatchObject({
      fps: 1,
      latencyMs: 65,
      p95LatencyMs: 65,
      route: "tcp_vps_relay",
    });

    // Live route failover updates metrics immediately.
    viewer.setRoute("tcp_tailscale", { udpRequested: true, udpConnected: false });
    expect(viewer.state.metrics?.route).toBe("tcp_tailscale");
    expect(viewer.state.metrics?.udpRequested).toBe(true);

    // While hidden, stream metrics reset and 500ms timer must not emit periodic re-renders.
    viewer.visibility(false);
    const countAfterHide = states.length;
    monoNow += 2000; wallNow += 2000;
    vi.advanceTimersByTime(2000);
    expect(states.length).toBe(countAfterHide);

    viewer.dispose();
  });

  it("gates udpStatus and policy.udpBoost behind includeUdpStatus=1, omits false udpBoost in SQLite, and classifies routes on Hub", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "screen-phase1-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const hub = await HubServer.start({ stateDir: dir });
    cleanups.push(() => hub.close());

    const owner = testDevice("local_p1");
    const viewer = testDevice("viewer_p1");
    await hub.enrollLocalController(deviceFields(owner));
    await enrollTrusted(hub.auth, viewer);
    const local = await loginFor(hub.auth, owner);
    const remote = await loginFor(hub.auth, viewer);

    const api = (route: string, token: string, body?: unknown) =>
      fetch(hub.url + route, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    const signConfigure = async (command: Parameters<typeof screenConfigureText>[0]) => {
      const statement = await hub.auth.prepareDeviceAction(
        { operation: "screen-grant", target: hashSecret(screenConfigureText(command)) },
        local.token,
        local.session,
      );
      return {
        command,
        proof: {
          nonce: statement.nonce,
          signature: sign(null, Buffer.from(deviceActionProofText(statement)), owner.privateKey).toString("base64"),
        },
      };
    };

    // 1. Enable udpBoost via new App (includeUdpStatus=1).
    const enableCmd = {
      operation: "screen.configure" as const,
      expectedRevision: 0,
      enabled: true,
      grants: [{ deviceId: viewer.deviceId, publicKey: viewer.publicKey, permission: "view" as const }],
      udpBoost: true,
      requestId: randomUUID(),
    };
    const enableRes = await api("/api/screens/configure?includeUdpStatus=1", local.token, await signConfigure(enableCmd));
    expect(enableRes.status).toBe(200);
    expect(await enableRes.json()).toMatchObject({ revision: 1, enabled: true, udpBoost: true });

    // 2. Legacy client (no includeUdpStatus=1) receives strict v1.6.0-compatible status (no udpStatus, no policy.udpBoost).
    for (const query of ["", "?includeWindows=1", "?includeUdpStatus=0", "?includeUdpStatus=true"]) {
      const legacy = await (await api(`/api/screens/status${query}`, local.token)).json();
      expect(legacyStatusSchema.safeParse(legacy).success).toBe(true);
      expect(Object.hasOwn(legacy, "udpStatus")).toBe(false);
      expect(Object.hasOwn(legacy.policy, "udpBoost")).toBe(false);
    }

    // 3. Opted-in client (includeUdpStatus=1) receives udpStatus with classified route (loopback -> tcp_lan_direct) and policy.udpBoost.
    const optedIn = screenStatusSchema.parse(await (await api("/api/screens/status?includeWindows=1&includeUdpStatus=1", local.token)).json());
    expect(optedIn.policy?.udpBoost).toBe(true);
    expect(optedIn.udpStatus).toEqual({
      enabled: true,
      state: "fallback_tcp",
      route: "tcp_lan_direct",
      reasonCode: "udp_transport_unavailable",
    });

    // 4. Legacy controller updating enabled/grants (without udpBoost or includeUdpStatus=1) preserves udpBoost in DB and gets strict legacy policy reply.
    const legacyUpdateCmd = {
      operation: "screen.configure" as const,
      expectedRevision: 1,
      enabled: true,
      grants: [{ deviceId: viewer.deviceId, publicKey: viewer.publicKey, permission: "control" as const }],
      requestId: randomUUID(),
    };
    const legacyUpdateRes = await api("/api/screens/configure", local.token, await signConfigure(legacyUpdateCmd));
    expect(legacyUpdateRes.status).toBe(200);
    const legacyPolicyReply = await legacyUpdateRes.json();
    expect(legacyPolicySchema.safeParse(legacyPolicyReply).success).toBe(true);
    expect(Object.hasOwn(legacyPolicyReply, "udpBoost")).toBe(false);
    // Preserved for opted-in clients:
    const stillEnabled = await (await api("/api/screens/status?includeUdpStatus=1", remote.token)).json();
    expect(stillEnabled.udpStatus.enabled).toBe(true);

    // 5. Turning udpBoost off omits udpBoost from SQLite `meta` completely (downgrade safe).
    const disableUdpCmd = {
      operation: "screen.configure" as const,
      expectedRevision: 2,
      enabled: true,
      grants: [{ deviceId: viewer.deviceId, publicKey: viewer.publicKey, permission: "control" as const }],
      udpBoost: false,
      requestId: randomUUID(),
    };
    const disableRes = await api("/api/screens/configure?includeUdpStatus=1", local.token, await signConfigure(disableUdpCmd));
    expect(disableRes.status).toBe(200);
    const storedRow = await hub.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key='remote-screen:policy:v1'");
    const storedJson = JSON.parse(storedRow!.value);
    expect(Object.hasOwn(storedJson, "udpBoost")).toBe(false);
    expect(legacyPolicySchema.safeParse(storedJson).success).toBe(true);

    // 6. Active media socket route classification (Tailscale / VPS relay) flows into HubRemoteScreen.status().
    const { ticket } = hub.remoteScreen.serviceTicket("desktop_route");
    hub.remoteScreen.registerService(ticket, {
      desktopId: "desktop_route",
      instanceId: "inst_1",
      loginSession: "login_1",
      platform: "macos",
      capture: "granted",
      accessibility: true,
      locked: false,
      displays: [{ id: "d1", nativeId: "1", name: "Display", revision: 1, x: 0, y: 0, width: 1280, height: 720, scale: 1, rotation: 0 }],
    }, { send: () => true, close: () => {} });
    const joined = await hub.remoteScreen.open(remote.session, { desktopId: "desktop_route", displayId: "d1", displayRevision: 1, requestId: randomUUID() });
    await hub.remoteScreen.attachViewer(joined.controlTicket, "control", { send: () => true, close: () => {} });
    await hub.remoteScreen.attachViewer(joined.mediaTicket, "media", { send: () => true, configure: () => true, close: () => {} }, { route: "tcp_tailscale" });
    const tailscaleStatus = await hub.remoteScreen.status(remote.session, { udpStatus: true, route: "tcp_lan_direct" });
    expect(tailscaleStatus.udpStatus?.route).toBe("tcp_tailscale");
  });

  it("accepts opt-in udpBoost in screen policy/configure while preserving legacy signed command text when omitted", () => {
    const legacy = { operation: "screen.configure" as const, expectedRevision: 0, enabled: true, grants: [], requestId: "req_legacy_1" };
    expect(screenConfigureSchema.parse(legacy).udpBoost).toBeUndefined();
    const legacyText = screenConfigureText(legacy);
    expect(JSON.parse(legacyText)).toEqual(["tarobot/screen-configure/v1", 0, true, [], "req_legacy_1"]);

    const withUdp = { ...legacy, requestId: "req_udp_1", udpBoost: true };
    expect(screenConfigureSchema.parse(withUdp).udpBoost).toBe(true);
    expect(JSON.parse(screenConfigureText(withUdp))).toEqual(["tarobot/screen-configure/v1", 0, true, [], "req_udp_1", true]);

    const parsedPolicy = screenPolicySchema.parse({ revision: 1, enabled: true, grants: [], udpBoost: true });
    expect(parsedPolicy.udpBoost).toBe(true);

    const parsedStatus = screenStatusSchema.parse({
      supported: true,
      enabled: true,
      canManage: true,
      permission: "control",
      policy: parsedPolicy,
      desktop: null,
      sessions: [],
      serverTime: Date.now(),
      udpStatus: { enabled: true, state: "fallback_tcp", route: "tcp_default", reasonCode: "udp_transport_unavailable" },
    });
    expect(parsedStatus.udpStatus?.state).toBe("fallback_tcp");
  });
});
