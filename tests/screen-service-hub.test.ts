// Target ScreenService (client/electron) against a real HubServer, real control
// socket ticket and real remote-screen WebSockets. Capture is a fake that emits
// encoded-looking packets; the native addon is a recorder. No OS input is posted.
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID, sign } from "node:crypto";
import { WebSocket } from "ws";
import { afterEach, expect, it } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { startHubControl } from "../src/hub/service.js";
import { deviceFields, enrollTrusted, loginFor, testDevice } from "./helpers/pairing-invite.js";
import { hashSecret } from "../src/hub/auth.js";
import { screenConfigureText } from "../src/client-protocol/remote-screen.js";
import { deviceActionProofText } from "../src/client-protocol/device-actions.js";
import { writeScreenFrame } from "../src/client-protocol/screen-wire.js";
// @ts-expect-error untyped Electron main module
import { ScreenService } from "../client/electron/screen-service.mjs";
// @ts-expect-error untyped Electron main module
import { screenServiceTicket } from "../client/electron/screen-host-control.mjs";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0; });
const wait = async (check: () => unknown, ms = 3000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw new Error("test_wait_timeout"); await new Promise(r => setTimeout(r, 5)); } };
const gone = (file: string) => stat(file).then(() => false, () => true);
type Any = any;

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "screen-svc-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const appState = path.join(dir, "app");
  const hub = await HubServer.start({ stateDir: dir }); cleanups.push(() => hub.close());
  const owner = testDevice("local"), viewer = testDevice("viewer");
  await hub.enrollLocalController(deviceFields(owner)); await enrollTrusted(hub.auth, viewer);
  const local = await loginFor(hub.auth, owner), remote = await loginFor(hub.auth, viewer);
  const command = { operation: "screen.configure" as const, expectedRevision: 0, enabled: true, requestId: randomUUID(), grants: [{ deviceId: viewer.deviceId, publicKey: viewer.publicKey, permission: "control" as const }] };
  const statement = await hub.auth.prepareDeviceAction({ operation: "screen-grant", target: hashSecret(screenConfigureText(command)) }, local.token, local.session);
  await hub.remoteScreen.configure(local.session, command, { nonce: statement.nonce, signature: sign(null, Buffer.from(deviceActionProofText(statement)), owner.privateKey).toString("base64") });
  const stopControl = await startHubControl(dir, () => ({ running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }), () => {},
    { screenServiceTicket: (id: string) => hub.remoteScreen.serviceTicket(id) }); cleanups.push(stopControl);

  const posted: Any[] = []; let cursor = { x: 0, y: 0 };
  // Fake local-input monitor: never a real event tap.
  const monitor = { available: true, neverReady: false, alive: false, foreign: 0, interrupted: 0, starts: 0, stops: 0 };
  const addon = {
    screenSession: () => ({ available: true, onConsole: true, locked: false, unique: "00000000-0000-0000-0000-000000000001", audit: 1 }),
    screenDisplayUuid: () => "display", screenCursor: () => cursor, screenCaptureAccess: () => true,
    screenMouse: (...a: Any[]) => { posted.push(["mouse", ...a]); cursor = { x: a[2], y: a[3] }; }, screenScroll: (...a: Any[]) => posted.push(["scroll", ...a]),
    screenKey: (...a: Any[]) => posted.push(["key", ...a]), screenText: (t: string) => posted.push(["text", t]),
    screenReleaseAll: () => { posted.push(["releaseAll"]); return 0; }, screenReleaseStale: () => posted.push(["releaseStale"]),
    screenMonitorStart: () => { if (!monitor.available) throw new Error("screen_takeover_unavailable"); monitor.starts++; monitor.alive = !monitor.neverReady; },
    screenMonitorPoll: () => { const value = { alive: monitor.alive, failed: false, foreign: monitor.foreign, interrupted: monitor.interrupted }; monitor.foreign = 0; monitor.interrupted = 0; return value; },
    screenMonitorStop: () => { monitor.stops++; monitor.alive = false; },
  };
  const powerMonitor = new EventEmitter(), screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1, rotation: 0, label: "Display" }] });
  const electron = { screen, powerMonitor, systemPreferences: { getMediaAccessStatus: () => "granted", isTrustedAccessibilityClient: () => true }, shell: { openExternal: async () => {} } };
  const capture: Any = { starts: [] as Any[], credits: [] as Any[], resets: [] as Any[], pauses: [] as Any[], stops: [] as Any[] };
  let updating = false;
  const service = new ScreenService({ electron, addon, stateDir: appState, platform: "darwin", isUpdating: () => updating,
    hostControl: { ticket: (id: string) => screenServiceTicket(dir, id) },
    captureHost: (hooks: Any) => Object.assign(capture, { hooks,
      start: async (s: Any) => { capture.starts.push(s); hooks.onMessage({ type: "started", sessionId: s.sessionId, cursor: "always" }); },
      reset: (id: string, generation: number) => { capture.resets.push([id, generation]); return true; },
      pause: (id: string, paused: boolean, generation: number) => { capture.pauses.push([id, paused, generation]); return true; }, keyframe: () => {},
      credit: (id: string, sequence: number, generation: number) => capture.credits.push([id, sequence, generation]),
      stop: (id: string) => capture.stops.push(id), close: () => {} }) });
  cleanups.push(async () => service.dispose());
  /** Emits the `stream` and one frame for the session's current generation. */
  let sequence = 0;
  const emit = (sessionId: string, generation: number, key: boolean, captureMs = Date.now()) => {
    if (key) capture.hooks.onMessage({ type: "stream", sessionId, stream: { type: "stream", streamGeneration: generation, geometryRevision: 1, codec: "h264", codecString: "avc1.640028", width: 1280, height: 720, contentRect: { x: 0, y: 0, width: 1280, height: 720 } } });
    capture.hooks.onMessage({ type: "captured", sessionId, captureMs });
    const seq = ++sequence;
    capture.hooks.onMessage({ type: "frame", sessionId, sequence: seq, streamGeneration: generation, captureMs, geometryRevision: 1, key,
      bytes: writeScreenFrame({ key, codec: "h264", sequence: seq, geometryRevision: 1, streamGeneration: generation, captureMs, width: 1280, height: 720 }, new Uint8Array([0, 0, 0, 1, 0x65])) });
    return seq;
  };
  return { dir, appState, hub, local, remote, service, capture, posted, emit, powerMonitor, monitor, setUpdating: (v: boolean) => { updating = v; } };
}
function connect(url: string) {
  const ws = new WebSocket(url); const values: Any[] = []; let closed = false;
  ws.on("message", (data, binary) => values.push(binary ? new Uint8Array(data as Buffer) : JSON.parse(data.toString())));
  ws.on("error", () => {}); ws.on("close", () => { closed = true; });
  cleanups.push(async () => ws.terminate());
  return { ws, values, get closed() { return closed; }, ready: new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); }), send: (v: unknown) => ws.send(JSON.stringify(v)) };
}
async function viewing(f: Awaited<ReturnType<typeof fixture>>) {
  await f.service.start();
  await wait(() => f.service.status().registered);
  const join = await f.hub.remoteScreen.open(f.remote.session, { desktopId: f.service.desktopId, displayId: "display", displayRevision: 1, requestId: randomUUID(), codecs: ["h264"] });
  const base = f.hub.instanceUrl.replace("http:", "ws:");
  const control = connect(base + "/screen/v1/control"), media = connect(base + "/screen/v1/media");
  await Promise.all([control.ready, media.ready]);
  control.send({ type: "hello", ticket: join.controlTicket }); media.send({ type: "hello", ticket: join.mediaTicket });
  await wait(() => f.capture.starts.length === 1);
  return { join, control, media, session: join.session };
}

it("registers via the control-socket ticket, streams after attach, confirms ACKed frames and grants a lease", async () => {
  const f = await fixture();
  const { control, media, session } = await viewing(f);
  expect(f.capture.starts[0]).toMatchObject({ sessionId: session.id, streamGeneration: 1, codecs: ["h264"], encode: { width: 1280, height: 720 } });
  const first = f.emit(session.id, 1, true);
  await wait(() => media.values.some(v => v instanceof Uint8Array));
  expect(media.values.find(v => v.type === "stream")).toMatchObject({ streamGeneration: 1, codec: "h264" });
  control.send({ type: "ack", sessionId: session.id, generation: session.generation, frameSequence: first });
  await wait(() => control.values.some(v => v.type === "frame-ready" && v.frameSequence === first));
  expect(f.capture.credits).toContainEqual([session.id, first, 1]);

  // Control: the Hub resets the stream; only the NEW generation's confirmed keyframe yields a lease.
  control.send({ type: "control", sessionId: session.id, generation: session.generation, frameSequence: first });
  await wait(() => f.capture.resets.length === 1);
  const generation = f.capture.resets[0][1];
  const key = f.emit(session.id, generation, true);
  await wait(() => media.values.filter(v => v instanceof Uint8Array).length === 2);
  control.send({ type: "ack", sessionId: session.id, generation: session.generation, frameSequence: key });
  await wait(() => control.values.some(v => v.type === "state" && v.lease && v.session.state === "controlling"));
  const state = control.values.findLast(v => v.type === "state" && v.lease), ready = control.values.findLast(v => v.type === "frame-ready");
  // The crash-recovery marker is on disk before control starts.
  await stat(path.join(f.appState, "screen-control.active"));

  let sequence = 0;
  const input = (event: Any) => control.send({ type: "input", sessionId: session.id, desktopId: f.service.desktopId, generation: session.generation, displayId: "display", displayRevision: 1,
    leaseId: state.lease.id, sequence: ++sequence, frameSequence: ready.frameSequence, expiresAt: ready.expiresAt, event });
  input({ kind: "button", x: 0.5, y: 0.5, button: 0, down: true, clicks: 1 });
  input({ kind: "move", x: 0.75, y: 0.25 });
  input({ kind: "button", x: 0.75, y: 0.25, button: 0, down: false, clicks: 1 });
  input({ kind: "key", code: "MetaLeft", down: true }); input({ kind: "key", code: "KeyS", down: true });
  input({ kind: "key", code: "KeyS", down: false }); input({ kind: "key", code: "MetaLeft", down: false });
  await wait(() => f.posted.filter(p => p[0] === "key").length === 4);
  expect(f.posted.filter(p => p[0] === "mouse").map(p => p.slice(1, 5))).toEqual([["down", "left", 640, 360], ["drag", "left", 960, 180], ["up", "left", 960, 180]]);
  expect(f.posted.filter(p => p[0] === "key").map(p => p.slice(1, 4))).toEqual([[0x37, true, 0x100008], [0x01, true, 0x100008], [0x01, false, 0x100008], [0x37, false, 0]]);

  // Viewer releases control: the target lets go and removes the marker.
  control.send({ type: "release", sessionId: session.id, generation: session.generation });
  await wait(() => f.posted.some(p => p[0] === "releaseAll"));
  await wait(() => gone(path.join(f.appState, "screen-control.active")));
});

it("a lock invalidates the live lease with lease-denied; revoking the device closes target media", async () => {
  const f = await fixture();
  const { control, media, session } = await viewing(f);
  const first = f.emit(session.id, 1, true);
  control.send({ type: "ack", sessionId: session.id, generation: session.generation, frameSequence: first });
  await wait(() => control.values.some(v => v.type === "frame-ready"));
  control.send({ type: "control", sessionId: session.id, generation: session.generation, frameSequence: first });
  await wait(() => f.capture.resets.length === 1);
  const key = f.emit(session.id, f.capture.resets[0][1], true);
  control.send({ type: "ack", sessionId: session.id, generation: session.generation, frameSequence: key });
  await wait(() => control.values.some(v => v.type === "state" && v.session.state === "controlling"));
  f.powerMonitor.emit("lock-screen");
  await wait(() => f.posted.some(p => p[0] === "releaseAll"));
  await wait(() => control.values.some(v => v.type === "state" && !v.lease && v.session.state !== "controlling"));
  await f.hub.auth.revoke(f.remote.session.deviceId, "local-owner");
  await wait(() => media.closed && control.closed);
  await wait(() => f.capture.stops.includes(session.id));
  expect(f.service.status().sessions).toHaveLength(0);
});

it("refuses new sessions while an App update is installing", async () => {
  const f = await fixture();
  await f.service.start(); await wait(() => f.service.status().registered);
  f.setUpdating(true);
  const join = await f.hub.remoteScreen.open(f.remote.session, { desktopId: f.service.desktopId, displayId: "display", displayRevision: 1, requestId: randomUUID(), codecs: ["h264"] });
  const base = f.hub.instanceUrl.replace("http:", "ws:");
  const control = connect(base + "/screen/v1/control"), media = connect(base + "/screen/v1/media");
  await Promise.all([control.ready, media.ready]);
  control.send({ type: "hello", ticket: join.controlTicket }); media.send({ type: "hello", ticket: join.mediaTicket });
  await wait(() => control.closed || media.closed);
  expect(f.capture.starts).toHaveLength(0);
});

it("persists one desktop id and cleans up after an unclean exit during control", async () => {
  const f = await fixture();
  await f.service.start(); const id = f.service.desktopId;
  expect(JSON.parse(await readFile(path.join(f.appState, "screen-desktop.json"), "utf8"))).toEqual({ format: 1, desktopId: id });
  f.service.dispose();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(f.appState, "screen-control.active"), "1", { mode: 0o600 });
  const again = new ScreenService({ electron: (f.service as Any).electron, addon: (f.service as Any).addon, stateDir: f.appState, platform: "darwin", hostControl: { ticket: async () => { throw new Error("offline"); } } });
  cleanups.push(async () => again.dispose());
  await again.start();
  expect(again.desktopId).toBe(id);
  expect(f.posted.filter(p => p[0] === "releaseStale")).toHaveLength(1);
  await expect(stat(path.join(f.appState, "screen-control.active"))).rejects.toThrow();
});

async function controlling(f: Awaited<ReturnType<typeof fixture>>) {
  const v = await viewing(f), { control, session } = v;
  const first = f.emit(session.id, 1, true);
  control.send({ type: "ack", sessionId: session.id, generation: session.generation, frameSequence: first });
  await wait(() => control.values.some(x => x.type === "frame-ready"));
  control.send({ type: "control", sessionId: session.id, generation: session.generation, frameSequence: first });
  await wait(() => f.capture.resets.length === 1);
  const key = f.emit(session.id, f.capture.resets[0][1], true);
  control.send({ type: "ack", sessionId: session.id, generation: session.generation, frameSequence: key });
  return v;
}

it.each(["unavailable", "never-ready"])("no lease without a running local-input monitor (%s)", async mode => {
  const f = await fixture(); if (mode === "unavailable") f.monitor.available = false; else f.monitor.neverReady = true;
  const { control } = await controlling(f);
  await wait(() => control.values.some(v => v.type === "state" && v.session.reason), 4000);
  expect(control.values.some(v => v.type === "state" && v.session.state === "controlling")).toBe(false);
  expect(f.posted.filter(p => p[0] === "mouse" || p[0] === "key")).toEqual([]);
});

it("a local key press (untagged event) ends remote control at once and stops the monitor", async () => {
  const f = await fixture();
  const { control, session } = await controlling(f);
  await wait(() => control.values.some(v => v.type === "state" && v.session.state === "controlling"));
  expect(f.monitor.starts).toBe(1);
  f.monitor.foreign = 1; // the person at the Mac typed
  await wait(() => control.closed || control.values.some(v => v.type === "state" && v.session.state === "closed"));
  expect(f.monitor.stops).toBeGreaterThanOrEqual(1);
  expect(f.posted.some(p => p[0] === "releaseAll")).toBe(true);
  expect(f.service.status().sessions.find((s: Any) => s.id === session.id)).toBeUndefined();
});

it("an interrupted monitor revokes the lease instead of trusting a gap", async () => {
  const f = await fixture();
  const { control } = await controlling(f);
  await wait(() => control.values.some(v => v.type === "state" && v.session.state === "controlling"));
  f.monitor.interrupted = 1;
  await wait(() => control.values.some(v => v.type === "state" && !v.lease && v.session.state !== "controlling" && v.session.reason));
  expect(f.posted.some(p => p[0] === "releaseAll")).toBe(true);
});

it("real Hub hide/show uses one retired generation and resumes decodable frames without control", async () => {
  const f = await fixture(), { control, media, session } = await viewing(f);
  f.emit(session.id, 1, true); await wait(() => media.values.some(v => v instanceof Uint8Array));
  const base = { sessionId: session.id, generation: session.generation };
  control.send({ type: "visibility", ...base, visible: false });
  await wait(() => f.capture.pauses.some((v: Any) => v[1] === true));
  expect(f.capture.pauses[0]).toEqual([session.id, true, 2]);
  control.send({ type: "visibility", ...base, visible: true });
  await wait(() => f.capture.pauses.some((v: Any) => v[1] === false));
  expect(f.capture.pauses[1]).toEqual([session.id, false, 2]);
  const frame = f.emit(session.id, 2, true);
  await wait(() => media.values.filter(v => v instanceof Uint8Array).length === 2);
  control.send({ type: "ack", ...base, frameSequence: frame });
  await wait(() => control.values.some(v => v.type === "frame-ready" && v.frameSequence === frame));
  expect(f.service.input.lease).toBeUndefined(); expect(control.closed).toBe(false);
});
