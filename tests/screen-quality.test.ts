// Remote-screen quality negotiation: Hub authority unit cases plus the real
// Hub + control-socket ticket + target ScreenService over real WebSockets.
// Capture is a fake that records the profile; no screen or input is touched.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID, sign } from "node:crypto";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { HubRemoteScreen } from "../src/hub/remote-screen.js";
import { isLocalNetworkAddress } from "../src/hub/network.js";
import { inspectHubService, startHubControl } from "../src/hub/service.js";
import { hashSecret } from "../src/hub/auth.js";
import { deviceActionProofText } from "../src/client-protocol/device-actions.js";
import { CAPABILITIES, SERVER_CAPABILITIES } from "../src/client-protocol/index.js";
import {
  REMOTE_SCREEN_FLIGHT_CAPABILITY, REMOTE_SCREEN_QHD_CAPABILITY, REMOTE_SCREEN_QUALITY_CAPABILITY, SCREEN_CONTROL_QHD_CAPABILITY, SCREEN_CONTROL_QUALITY_CAPABILITY, SCREEN_SERVICE_FLIGHT_FEATURE, SCREEN_CONTROL_RATE_CAPABILITY, SCREEN_MEDIA_BYTES_PER_MS, SCREEN_MEDIA_DIRECT_BYTES_PER_MS, SCREEN_SERVICE_PACE_FEATURE, SCREEN_SERVICE_QHD_FEATURE, SCREEN_SERVICE_QUALITY_FEATURE,
  screenConfigureText, screenJoinSchema, screenOpenSchema, screenServiceCommandSchema, screenServiceHelloSchema, screenViewerCommandSchema,
  type ScreenConfigure, type ScreenDesktop, type ScreenJoin,
} from "../src/client-protocol/remote-screen.js";
import { writeScreenFrame } from "../src/client-protocol/screen-wire.js";
import { deviceFields, enrollTrusted, loginFor, testDevice } from "./helpers/pairing-invite.js";
// @ts-expect-error untyped Electron main module
import { ScreenService } from "../client/electron/screen-service.mjs";
// @ts-expect-error untyped Electron main module
import { screenServiceTicket } from "../client/electron/screen-host-control.mjs";
type Any = any;

// Shapes an older peer parses strictly: what the new side emits by default
// must still be accepted by them.
const legacyJoin = screenJoinSchema.omit({ quality: true }).strict();
const legacyStart = (screenServiceCommandSchema.options.find(o => o.shape.type.value === "start") as Any).omit({ quality: true, mediaBytesPerMs: true, flight: true }).strict();
const legacyOpen = screenOpenSchema.omit({ quality: true, flight: true }).strict();

describe("Hub authority", () => {
  let root: string, hub: HubServer, screen: HubRemoteScreen, clock: number;
  const owner = testDevice("q_local"), viewer = testDevice("q_viewer");
  let local: Awaited<ReturnType<typeof loginFor>>, remote: Awaited<ReturnType<typeof loginFor>>;
  const desktop: ScreenDesktop = { desktopId: "desktop_1", instanceId: "instance_1", loginSession: "login_1", platform: "macos", capture: "granted", accessibility: true, locked: false,
    displays: [{ id: "1", nativeId: "1", name: "Screen", revision: 1, x: 0, y: 0, width: 1920, height: 1080, scale: 1, rotation: 0 }] };
  const channel = () => { const messages: Any[] = [], closed: string[] = []; return { messages, closed, configure: (v: unknown) => { messages.push(v); return true; }, send: (v: unknown) => { messages.push(v); return true; }, close: (v: string) => { closed.push(v); } }; };
  beforeEach(async () => {
    clock = Date.now(); root = await mkdtemp(path.join(os.tmpdir(), "screen-quality-")); hub = await HubServer.start({ stateDir: root });
    await hub.enrollLocalController(deviceFields(owner)); local = await loginFor(hub.auth, owner);
    await enrollTrusted(hub.auth, viewer); remote = await loginFor(hub.auth, viewer);
    screen = new HubRemoteScreen(hub.store, hub.auth, () => clock, () => clock);
    const status = await screen.status(local.session);
    const command: ScreenConfigure = { operation: "screen.configure", expectedRevision: status.policy!.revision, enabled: true, grants: [{ deviceId: viewer.deviceId, publicKey: viewer.publicKey, permission: "control" }], requestId: randomUUID() };
    const statement = await hub.auth.prepareDeviceAction({ operation: "screen-grant", target: hashSecret(screenConfigureText(command)) }, local.token, local.session);
    await screen.configure(local.session, command, { nonce: statement.nonce, signature: sign(null, Buffer.from(deviceActionProofText(statement)), owner.privateKey).toString("base64") });
  });
  afterEach(async () => { screen.dispose(); await hub.close(); await rm(root, { recursive: true, force: true }); });
  const register = (features?: string[]) => { const sink = channel(), { ticket } = screen.serviceTicket(desktop.desktopId); return { sink, ...screen.registerService(ticket, desktop, sink, features) }; };
  const open = (extra: Record<string, unknown> = {}, requestId = randomUUID()) => screen.open(remote.session, { desktopId: desktop.desktopId, displayId: "1", displayRevision: 1, requestId, codecs: ["h264"], ...extra });
  const attach = async (join: ScreenJoin) => { const control = channel(), media = channel(); await screen.attachViewer(join.controlTicket, "control", control); await screen.attachViewer(join.mediaTicket, "media", media); return { control, media }; };

  it("advertises the capability; legacy opens stay byte-compatible with old viewers and old targets", async () => {
    expect(CAPABILITIES).toContain(REMOTE_SCREEN_QUALITY_CAPABILITY);
    const { sink } = register();
    const join = await open();
    expect("quality" in join).toBe(false);
    expect(() => legacyJoin.parse(join)).not.toThrow();
    await attach(join);
    const start = sink.messages.find(m => m.type === "start");
    expect("quality" in start).toBe(false);
    expect(() => legacyStart.parse(start)).not.toThrow();
    expect(() => legacyOpen.parse({ desktopId: "d", displayId: "1", displayRevision: 1, requestId: "r", codecs: ["h264"] })).not.toThrow();
  });

  it("refuses an explicit quality the registered target never advertised; creates no session or tickets", async () => {
    const { sink } = register(["something.else"]);
    await expect(open({ quality: "sharp" })).rejects.toMatchObject({ code: "screen_quality_unsupported", status: 409 });
    expect((await screen.status(local.session)).sessions).toEqual([]);
    expect(sink.messages).toEqual([]);
    expect((screen as Any).tickets.size).toBe(0);
    // The same request id without the quality is a different, valid request (balanced, honestly unlabelled).
    const join = await open();
    expect(join.quality).toBeUndefined();
  });

  it("negotiates QHD separately from the original quality choices", async () => {
    expect(SERVER_CAPABILITIES).toContain(REMOTE_SCREEN_QHD_CAPABILITY);
    expect(CAPABILITIES).not.toContain(REMOTE_SCREEN_QHD_CAPABILITY);
    const { sink } = register([SCREEN_SERVICE_QUALITY_FEATURE]);
    await expect(open({ quality: "qhd" })).rejects.toMatchObject({ code: "screen_quality_qhd_unsupported", status: 409 });
    expect((await screen.status(local.session)).sessions).toEqual([]);
    expect(sink.messages).toEqual([]);
    expect((screen as Any).tickets.size).toBe(0);
    expect((await open({ quality: "sharp" })).quality).toBe("sharp");
  });

  it("an advertised target gets the quality on start, and join.quality confirms it", async () => {
    const { sink } = register([SCREEN_SERVICE_QUALITY_FEATURE, SCREEN_SERVICE_QHD_FEATURE, "future.feature"]);
    for (const quality of ["smooth", "balanced", "qhd", "sharp"] as const) {
      const join = await open({ quality });
      expect(screenJoinSchema.parse(join).quality).toBe(quality);
      const viewer = await attach(join);
      expect(sink.messages.findLast(m => m.type === "start")).toMatchObject({ session: { id: join.session.id }, quality });
      screen.viewerCommand(join.session.id, { type: "disconnect", sessionId: join.session.id, generation: join.session.generation });
      expect(viewer.control.closed).toEqual(["screen_disconnected"]);
      expect(sink.messages.at(-1)).toMatchObject({ type: "stop", sessionId: join.session.id });
    }
    expect((await screen.status(local.session)).sessions).toEqual([]);
  });

  it("a viewer straight from the local network gets the larger byte budget; any other viewer keeps the default and the old start", async () => {
    const { sink } = register([SCREEN_SERVICE_QUALITY_FEATURE, SCREEN_SERVICE_PACE_FEATURE]);
    const view = async (origin?: { direct?: boolean }) => {
      const join = await open();
      await screen.attachViewer(join.controlTicket, "control", channel(), { direct: true }); // only the media socket's origin counts
      await screen.attachViewer(join.mediaTicket, "media", channel(), origin);
      const result = { start: sink.messages.findLast(m => m.type === "start"), rate: screen.mediaBytesPerMs(join.session.id) };
      screen.viewerCommand(join.session.id, { type: "disconnect", sessionId: join.session.id, generation: join.session.generation });
      return result;
    };
    for (const other of [await view({ direct: false }), await view(), await view({})]) {
      expect("mediaBytesPerMs" in other.start).toBe(false);
      expect(() => legacyStart.parse(other.start)).not.toThrow();
      expect(other.rate).toBe(SCREEN_MEDIA_BYTES_PER_MS);
    }
    const direct = await view({ direct: true });
    expect([direct.start.mediaBytesPerMs, direct.rate]).toEqual([SCREEN_MEDIA_DIRECT_BYTES_PER_MS, SCREEN_MEDIA_DIRECT_BYTES_PER_MS]);
    expect(() => screenServiceCommandSchema.parse(direct.start)).not.toThrow();
    expect(screen.mediaBytesPerMs("no-such-session")).toBe(SCREEN_MEDIA_BYTES_PER_MS);
  });

  it("a viewer's capacity and its reported delay reach only a target that understands them", async () => {
    // A Host-only feature: advertised by the Hub, never in a client hello (older Hubs cap that list at 64).
    expect(SERVER_CAPABILITIES).toContain(REMOTE_SCREEN_FLIGHT_CAPABILITY); expect(CAPABILITIES).not.toContain(REMOTE_SCREEN_FLIGHT_CAPABILITY);
    const stream = { type: "stream", streamGeneration: 1, geometryRevision: 1, codec: "h264", codecString: "avc1.640028", width: 1920, height: 1080, contentRect: { x: 0, y: 0, width: 1920, height: 1080 } };
    const header = (sequence: number) => ({ key: sequence === 1, codec: "h264" as const, sequence, geometryRevision: 1, streamGeneration: 1, captureMs: clock, width: 1920, height: 1080 });
    const round = async (features: string[], extra: Record<string, unknown>, heldMs?: number) => {
      const { sink, epoch } = register(features), join = await open(extra);
      await attach(join);
      const { id, generation } = join.session;
      expect(screen.stream(epoch, id, generation, stream)).toBe(true);
      expect(screen.frame(epoch, id, generation, header(1), new Uint8Array([1]))).toBe(true);
      screen.viewerCommand(id, { type: "ack", sessionId: id, generation, frameSequence: 1, ...(heldMs !== undefined ? { heldMs } : {}) });
      const result = { start: sink.messages.find(m => m.type === "start"), ack: sink.messages.find(m => m.type === "ack") };
      screen.viewerCommand(id, { type: "disconnect", sessionId: id, generation });
      screen.serviceLost(epoch, "screen_service_stopped"); // the next round registers another target
      return result;
    };
    const both = await round([SCREEN_SERVICE_QUALITY_FEATURE, SCREEN_SERVICE_FLIGHT_FEATURE], { flight: 12 }, 14);
    expect([both.start.flight, both.ack.heldMs]).toEqual([12, 14]);
    expect(() => screenServiceCommandSchema.parse(both.start)).not.toThrow(); expect(() => screenServiceCommandSchema.parse(both.ack)).not.toThrow();
    expect((await round([SCREEN_SERVICE_QUALITY_FEATURE, SCREEN_SERVICE_FLIGHT_FEATURE], { flight: 3 }, 0)).ack.heldMs).toBe(0);
    // An older target: the same viewer, the start and the receipt it always got.
    const oldTarget = await round([SCREEN_SERVICE_QUALITY_FEATURE], { flight: 12 }, 14);
    expect("flight" in oldTarget.start || "heldMs" in oldTarget.ack).toBe(false);
    expect(() => legacyStart.parse(oldTarget.start)).not.toThrow();
    // A viewer that named no capacity: its delay is not passed on either.
    const plain = await round([SCREEN_SERVICE_QUALITY_FEATURE, SCREEN_SERVICE_FLIGHT_FEATURE], {}, 14);
    expect("flight" in plain.start || "heldMs" in plain.ack).toBe(false);
    register([SCREEN_SERVICE_QUALITY_FEATURE, SCREEN_SERVICE_FLIGHT_FEATURE]);
    for (const flight of [2, 17, 3.5]) await expect(open({ flight })).rejects.toThrow();
    const receipt = (heldMs: unknown) => screenViewerCommandSchema.safeParse({ type: "ack", sessionId: "s", generation: "g", frameSequence: 1, heldMs }).success;
    expect([receipt(0), receipt(2000), receipt(2001), receipt(-1), receipt(1.5)]).toEqual([true, true, false, false, false]);
  });

  it("a target that never advertised the pace feature is never sent a budget, wherever the viewer is", async () => {
    const { sink } = register([SCREEN_SERVICE_QUALITY_FEATURE]);
    const join = await open({ quality: "smooth" });
    await screen.attachViewer(join.controlTicket, "control", channel()); await screen.attachViewer(join.mediaTicket, "media", channel(), { direct: true });
    const start = sink.messages.find(m => m.type === "start");
    expect("mediaBytesPerMs" in start).toBe(false);
    expect(start.quality).toBe("smooth");
    expect(screen.mediaBytesPerMs(join.session.id)).toBe(SCREEN_MEDIA_BYTES_PER_MS);
  });

  it("request-id idempotency covers quality; invalid qualities are schema errors", async () => {
    register([SCREEN_SERVICE_QUALITY_FEATURE]);
    const requestId = randomUUID();
    const first = await open({ quality: "smooth" }, requestId);
    expect(await open({ quality: "smooth" }, requestId)).toEqual(first);
    await expect(open({ quality: "sharp" }, requestId)).rejects.toMatchObject({ code: "screen_request_conflict" });
    await expect(open({}, requestId)).rejects.toMatchObject({ code: "screen_request_conflict" });
    await expect(open({ quality: "ultra" })).rejects.toThrow();
    await expect(open({ quality: "" })).rejects.toThrow();
  });

  it("a quality session is retired with its target; a legacy re-registration cannot inherit it", async () => {
    const first = register([SCREEN_SERVICE_QUALITY_FEATURE]);
    const join = await open({ quality: "sharp" });
    const viewer = await attach(join);
    screen.serviceLost(first.epoch, "screen_service_offline");
    expect(viewer.control.closed).toEqual(["screen_service_offline"]);
    register();
    await expect(open({ quality: "sharp" })).rejects.toMatchObject({ code: "screen_quality_unsupported" });
  });

  it("QHD and sharp need an H.264 viewer; each session's stream is bounded by its own quality caps", async () => {
    const { epoch } = register([SCREEN_SERVICE_QUALITY_FEATURE, SCREEN_SERVICE_QHD_FEATURE]);
    await expect(open({ quality: "qhd", codecs: ["vp8"] })).rejects.toMatchObject({ code: "screen_quality_unsupported" });
    await expect(open({ quality: "sharp", codecs: ["vp8"] })).rejects.toMatchObject({ code: "screen_quality_unsupported" });
    const stream = (width: number, height: number, codec = "h264") => ({ type: "stream", streamGeneration: 1, geometryRevision: 1, codec, codecString: codec === "vp8" ? "vp8" : width * height > 8192 * 256 ? "avc1.640033" : "avc1.640028", width, height, contentRect: { x: 0, y: 0, width, height } });
    const cases: [Record<string, unknown>, ReturnType<typeof stream>, boolean][] = [
      [{}, stream(1920, 1080), true], [{}, stream(2560, 1440), false],                       // legacy: pre-quality contract, nothing larger
      [{ quality: "balanced" }, stream(1920, 1080), true], [{ quality: "balanced" }, stream(3072, 1728), false],
      [{ quality: "smooth" }, stream(1280, 720), true], [{ quality: "smooth" }, stream(1920, 1080), false], // a target cannot exceed what was asked
      [{ quality: "qhd" }, stream(2560, 1440), true], [{ quality: "qhd" }, stream(3072, 1728), false],
      [{ quality: "qhd" }, stream(2560, 1472), false], [{ quality: "qhd" }, stream(1920, 1080, "vp8"), false],
      [{ quality: "sharp" }, stream(3072, 1728), true], [{ quality: "sharp" }, stream(1920, 1080, "vp8"), false],
      [{ quality: "sharp", codecs: ["h264", "vp8"] }, stream(1280, 720, "vp8"), false],     // never VP8 for sharp
    ];
    for (const [extra, value, accepted] of cases) {
      const join = await open({ codecs: ["h264", "vp8"], ...extra });
      const viewer = await attach(join);
      expect(screen.stream(epoch, join.session.id, join.session.generation, value)).toBe(accepted);
      if (accepted) { expect(viewer.media.messages.at(-1)).toEqual(value); screen.viewerCommand(join.session.id, { type: "disconnect", sessionId: join.session.id, generation: join.session.generation }); }
      else expect(viewer.control.closed).toEqual(["screen_stream_invalid"]);
      expect((await screen.status(local.session)).sessions).toEqual([]);
    }
  });

  it("an awaited stop is the release signal: slot freed and target stop queued before the next start; repeat stop is a no-op", async () => {
    const { sink } = register([SCREEN_SERVICE_QUALITY_FEATURE]);
    const first = await open({ quality: "sharp" }), second = await open({ quality: "smooth" });
    await attach(first); await attach(second);
    await expect(open({ quality: "balanced" })).rejects.toMatchObject({ code: "screen_viewers_full" });
    await screen.stop(remote.session, first.session.id);
    // Resolved: the Hub no longer counts the old session, and its target stop is already on the ordered socket.
    expect((await screen.status(local.session)).sessions.map(s => s.id)).toEqual([second.session.id]);
    const next = await open({ quality: "balanced" });
    await attach(next);
    const order = sink.messages.map(m => `${m.type}:${m.session?.id ?? m.sessionId}`);
    expect(order.indexOf(`stop:${first.session.id}`)).toBeGreaterThan(-1);
    expect(order.indexOf(`stop:${first.session.id}`)).toBeLessThan(order.indexOf(`start:${next.session.id}`));
    // Old tickets/sessions are gone; stopping again (or an unknown id) still succeeds and touches nothing else.
    await expect(screen.attachViewer(first.controlTicket, "control", channel())).rejects.toThrow();
    await expect(screen.stop(remote.session, first.session.id)).resolves.toBeUndefined();
    await expect(screen.stop(remote.session, "screen_unknown")).resolves.toBeUndefined();
    expect((await screen.status(local.session)).sessions.map(s => s.id).sort()).toEqual([second.session.id, next.session.id].sort());
  });

  it("a quality session changes nothing about control: reset, confirmed post-reset keyframe, fixed lease", async () => {
    const { sink, epoch } = register([SCREEN_SERVICE_QUALITY_FEATURE]);
    const join = await open({ quality: "smooth" });
    const { control } = await attach(join);
    const id = join.session.id, generation = join.session.generation;
    const stream = (g: number) => ({ type: "stream", streamGeneration: g, geometryRevision: 1, codec: "h264", codecString: "avc1.640028", width: 1280, height: 720, contentRect: { x: 0, y: 0, width: 1280, height: 720 } });
    const frame = (n: number, g: number, key = true) => screen.frame(epoch, id, generation, { key, codec: "h264", sequence: n, geometryRevision: 1, streamGeneration: g, captureMs: clock, width: 1280, height: 720 }, new Uint8Array([1]));
    expect(screen.stream(epoch, id, generation, stream(1))).toBe(true); expect(frame(1, 1)).toBe(true);
    screen.viewerCommand(id, { type: "ack", sessionId: id, generation, frameSequence: 1 });
    screen.serviceFrameConfirmed(epoch, id, 1, clock, 1);
    screen.viewerCommand(id, { type: "control", sessionId: id, generation, frameSequence: 1 });
    expect(sink.messages.at(-1)).toEqual({ type: "reset", sessionId: id, streamGeneration: 2 });
    // An old-generation frame/ACK cannot produce the lease.
    screen.serviceFrameConfirmed(epoch, id, 1, clock, 1);
    expect(sink.messages.some(m => m.type === "lease")).toBe(false);
    expect(screen.stream(epoch, id, generation, stream(2))).toBe(true);
    expect(frame(2, 2, false)).toBe(false); // a generation must start with a key
    expect(control.closed).toEqual(["screen_frame_invalid_or_stale"]);
  });
});

// ---------------- real Hub + control socket + target service ----------------
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0; });
const wait = async (check: () => unknown, ms = 3000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw new Error("test_wait_timeout"); await new Promise(r => setTimeout(r, 5)); } };

async function fixture({ oldHost = false, direct = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "screen-quality-svc-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const hub = await HubServer.start({ stateDir: dir }); cleanups.push(() => hub.close());
  // Test sockets always arrive from loopback; `direct` stands in for a viewer whose media socket came from a local-network address.
  if (direct) { const attach = hub.remoteScreen.attachViewer.bind(hub.remoteScreen); hub.remoteScreen.attachViewer = (ticket, kind, sink) => attach(ticket, kind, sink, { direct: true }); }
  const owner = testDevice("local"), viewer = testDevice("viewer");
  await hub.enrollLocalController(deviceFields(owner)); await enrollTrusted(hub.auth, viewer);
  const local = await loginFor(hub.auth, owner), remote = await loginFor(hub.auth, viewer);
  const command = { operation: "screen.configure" as const, expectedRevision: 0, enabled: true, requestId: randomUUID(), grants: [{ deviceId: viewer.deviceId, publicKey: viewer.publicKey, permission: "view" as const }] };
  const statement = await hub.auth.prepareDeviceAction({ operation: "screen-grant", target: hashSecret(screenConfigureText(command)) }, local.token, local.session);
  await hub.remoteScreen.configure(local.session, command, { nonce: statement.nonce, signature: sign(null, Buffer.from(deviceActionProofText(statement)), owner.privateKey).toString("base64") });
  const stopControl = await startHubControl(dir, () => ({ running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }), () => {},
    { screenServiceTicket: (id: string) => hub.remoteScreen.serviceTicket(id) }); cleanups.push(stopControl);
  const addon = { screenSession: () => ({ available: true, onConsole: true, locked: false, unique: "00000000-0000-0000-0000-000000000001", audit: 1 }), screenDisplayUuid: () => "display",
    screenCursor: () => ({ x: 0, y: 0 }), screenMouse() {}, screenReleaseAll: () => 0, screenReleaseStale() {}, screenMonitorStop() {}, screenMonitorPoll: () => ({ alive: false, foreign: 0, interrupted: 0 }) };
  const electron = { screen: Object.assign(new EventEmitter(), { getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2, rotation: 0, label: "Display" }] }),
    powerMonitor: new EventEmitter(), systemPreferences: { getMediaAccessStatus: () => "granted", isTrustedAccessibilityClient: () => true }, shell: { openExternal: async () => {} } };
  const capture: Any = { starts: [] as Any[], stops: [] as Any[] };
  const service = new ScreenService({ electron, addon, stateDir: path.join(dir, "app"), platform: "darwin",
    // An older Host's control reply has neither the quality nor the rate capability.
    hostControl: { ticket: async (id: string) => { const ticket = await screenServiceTicket(dir, id); if (oldHost) ticket.capabilities = ticket.capabilities.filter((c: string) => c !== SCREEN_CONTROL_QUALITY_CAPABILITY && c !== SCREEN_CONTROL_QHD_CAPABILITY && c !== SCREEN_CONTROL_RATE_CAPABILITY); return ticket; } },
    captureHost: (hooks: Any) => Object.assign(capture, { hooks,
      start: async (s: Any) => { capture.starts.push(s); hooks.onMessage({ type: "started", sessionId: s.sessionId, cursor: "always" }); },
      reset: () => true, pause: () => true, keyframe() {}, credit() {}, stop: (id: string) => capture.stops.push(id), close() {} }) });
  cleanups.push(async () => service.dispose());
  await service.start(); await wait(() => service.status().registered);
  const connect = (url: string) => { const ws = new WebSocket(url), values: Any[] = []; ws.on("message", (d, binary) => values.push(binary ? new Uint8Array(d as Buffer) : JSON.parse(d.toString()))); ws.on("error", () => {});
    cleanups.push(async () => ws.terminate()); return { ws, values, ready: new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); }), send: (v: unknown) => ws.send(JSON.stringify(v)) }; };
  const view = async (quality?: string) => {
    const join = await hub.remoteScreen.open(remote.session, { desktopId: service.desktopId, displayId: "display", displayRevision: 1, requestId: randomUUID(), codecs: ["h264"], ...(quality ? { quality } : {}) });
    const base = hub.instanceUrl.replace("http:", "ws:"), control = connect(base + "/screen/v1/control"), media = connect(base + "/screen/v1/media");
    await Promise.all([control.ready, media.ready]);
    const before = capture.starts.length;
    control.send({ type: "hello", ticket: join.controlTicket }); media.send({ type: "hello", ticket: join.mediaTicket });
    await wait(() => capture.starts.length === before + 1);
    return { join, control, media };
  };
  return { dir, hub, service, capture, view, local };
}

it("control socket advertises the quality capability next to the ticket", async () => {
  const f = await fixture();
  const status = await inspectHubService(f.dir, "status") as Any;
  expect(status.controlCapabilities).toContain(SCREEN_CONTROL_QUALITY_CAPABILITY);
  expect(status.controlCapabilities).toContain(SCREEN_CONTROL_RATE_CAPABILITY);
  expect(status.controlCapabilities).toContain(SCREEN_CONTROL_QHD_CAPABILITY);
});

it("end to end: the requested quality reaches the real capture profile and is confirmed; switching leaves nothing behind", async () => {
  const f = await fixture();
  const sharp = await f.view("sharp");
  expect(sharp.join.quality).toBe("sharp");
  expect(f.capture.starts[0]).toMatchObject({ sessionId: sharp.join.session.id, encode: { width: 2880, height: 1800 }, fps: 60, profile: { qpBase: 28, qpMax: 40, h264Only: true } });
  // Switching = disconnect, then a new open: new session, generation and stream.
  sharp.control.send({ type: "disconnect", sessionId: sharp.join.session.id, generation: sharp.join.session.generation });
  await wait(() => f.capture.stops.includes(sharp.join.session.id) && f.service.status().sessions.length === 0);
  const qhd = await f.view("qhd");
  expect(qhd.join.quality).toBe("qhd");
  expect(f.capture.starts[1]).toMatchObject({ sessionId: qhd.join.session.id, encode: { width: 2428, height: 1516 }, fps: 60, profile: { bitrate: 3_000_000, h264Only: true } });
  qhd.control.send({ type: "disconnect", sessionId: qhd.join.session.id, generation: qhd.join.session.generation });
  await wait(() => f.capture.stops.includes(qhd.join.session.id) && f.service.status().sessions.length === 0);
  const smooth = await f.view("smooth");
  expect(smooth.join.session.id).not.toBe(sharp.join.session.id);
  expect(smooth.join.session.generation).not.toBe(sharp.join.session.generation);
  expect(f.capture.starts[2]).toMatchObject({ sessionId: smooth.join.session.id, encode: { width: 1280, height: 800 }, profile: { qpBase: 32, qpMax: 42 } });
  expect((await f.hub.remoteScreen.status(f.local.session)).sessions.map(s => s.id)).toEqual([smooth.join.session.id]);
  expect(f.service.status().sessions.map((s: Any) => s.id)).toEqual([smooth.join.session.id]);
  // A target frame for the retired session reaches nothing.
  f.capture.hooks.onMessage({ type: "frame", sessionId: sharp.join.session.id, sequence: 1, streamGeneration: 1, captureMs: Date.now(), geometryRevision: 1, key: true,
    bytes: writeScreenFrame({ key: true, codec: "h264", sequence: 1, geometryRevision: 1, streamGeneration: 1, captureMs: Date.now(), width: 2880, height: 1800 }, new Uint8Array([0, 0, 0, 1, 0x65])) });
  await new Promise(r => setTimeout(r, 30));
  expect(smooth.media.values.filter(v => v instanceof Uint8Array)).toEqual([]);
});

it("end to end: the Hub holds a target to its session's byte budget, and a local-network viewer's larger one reaches the capture pace", async () => {
  // 300 KB every 80 ms is 3.75 MB/s: seven times the default budget, inside the local-network one.
  const run = async (direct: boolean) => {
    const f = await fixture({ direct }), v = await f.view("balanced"), id = v.join.session.id;
    const rate = f.hub.remoteScreen.mediaBytesPerMs(id), pace = f.capture.starts[0].profile.bytesPerMs;
    await wait(() => f.service.status().sessions.length === 1);
    let closed = ""; v.control.ws.once("close", (_code, reason) => { closed = reason.toString(); });
    f.capture.hooks.onMessage({ type: "stream", sessionId: id, stream: { type: "stream", streamGeneration: 1, geometryRevision: 1, codec: "h264", codecString: "avc1.640028", width: 1280, height: 800, contentRect: { x: 0, y: 0, width: 1280, height: 800 } } });
    const payload = new Uint8Array(300_000); payload.set([0, 0, 0, 1, 0x65]);
    for (let sequence = 1; sequence <= 12 && f.service.status().sessions.length; sequence++) {
      const captureMs = Date.now();
      f.capture.hooks.onMessage({ type: "frame", sessionId: id, sequence, streamGeneration: 1, captureMs, geometryRevision: 1, key: sequence === 1,
        bytes: writeScreenFrame({ key: sequence === 1, codec: "h264", sequence, geometryRevision: 1, streamGeneration: 1, captureMs, width: 1280, height: 800 }, payload) });
      await new Promise(r => setTimeout(r, 80));
    }
    await new Promise(r => setTimeout(r, 100));
    return { rate, pace, closed, frames: v.media.values.filter((x: Any) => x instanceof Uint8Array).length };
  };
  const relayed = await run(false);
  expect([relayed.rate, relayed.pace, relayed.closed]).toEqual([SCREEN_MEDIA_BYTES_PER_MS, undefined, "screen_bandwidth_exceeded"]);
  expect(relayed.frames).toBeGreaterThan(2); expect(relayed.frames).toBeLessThan(8); // the 1 MiB burst, then 500 B/ms
  expect(await run(true)).toEqual({ rate: SCREEN_MEDIA_DIRECT_BYTES_PER_MS, pace: 4250, closed: "", frames: 12 });
}, 15_000);

it("end to end: a target registered against an older Host refuses quality explicitly and keeps legacy viewing", async () => {
  const f = await fixture({ oldHost: true });
  await expect(f.view("sharp")).rejects.toMatchObject({ code: "screen_quality_unsupported" });
  expect(f.capture.starts).toEqual([]);
  const legacy = await f.view();
  expect("quality" in legacy.join).toBe(false);
  expect(f.capture.starts[0]).toMatchObject({ encode: { width: 1818, height: 1136 }, fps: 15, profile: { qpBase: 28, qpMax: 40, bitrate: 2_500_000, h264Only: false } });
});

it("only private-use addresses count as the local network; loopback (a relay) and overlay ranges do not", () => {
  for (const address of ["192.168.1.20", "10.0.0.7", "172.16.5.1", "172.31.255.254", "169.254.10.1", "::ffff:192.168.1.20", "::FFFF:10.1.2.3", "fd12:3456::1", "fc00::1", "fe80::1c2:3ff:fe04:5%en0"]) expect(isLocalNetworkAddress(address), address).toBe(true);
  // Just outside each private block (built from parts: these are ordinary public addresses), and documentation ranges.
  const outside = [[172, 15, 0, 1], [172, 32, 0, 1], [192, 169, 1, 1], [11, 0, 0, 1], [169, 253, 0, 1]].map(parts => parts.join("."));
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "100.64.0.1", ...outside, "203.0.113.9", "198.51.100.7", "2001:db8::1", "fe70::1", "", "localhost"]) expect(isLocalNetworkAddress(address), address).toBe(false);
});

it("hello features are bounded and unknown names are ignored", () => {
  const desktop = { desktopId: "d", instanceId: "i", loginSession: "l", platform: "macos", capture: "granted", accessibility: true, locked: false, displays: [] };
  const hello = (features: unknown) => screenServiceHelloSchema.safeParse({ type: "hello", ticket: "T".repeat(43), desktop, features }).success;
  expect(hello(["screen.quality.v1", "x.y"])).toBe(true);
  expect(hello(Array.from({ length: 17 }, (_, i) => `f${i}`))).toBe(false);
  expect(hello(["UPPER"])).toBe(false);
  expect(hello(["a".repeat(33)])).toBe(false);
});
