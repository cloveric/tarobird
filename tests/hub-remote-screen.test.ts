import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, sign } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { HubRemoteScreen, type ScreenControlSink } from "../src/hub/remote-screen.js";
import { hashSecret } from "../src/hub/auth.js";
import { deviceActionProofText } from "../src/client-protocol/device-actions.js";
import { screenConfigureText, screenInputSchema, type ScreenConfigure, type ScreenDesktop, type ScreenJoin } from "../src/client-protocol/remote-screen.js";
import { deviceFields, enrollTrusted, loginFor, testDevice } from "./helpers/pairing-invite.js";

let root: string, hub: HubServer, screen: HubRemoteScreen, clock: number;
const owner = testDevice("screen_local"), viewer = testDevice("screen_viewer"), other = testDevice("screen_other");
let local: Awaited<ReturnType<typeof loginFor>>, remote: Awaited<ReturnType<typeof loginFor>>;
const desktop: ScreenDesktop = { desktopId: "desktop_1", instanceId: "instance_1", loginSession: "login_1", platform: "macos", capture: "granted", accessibility: true, locked: false,
  displays: [{ id: "1", nativeId: "1", name: "Screen", revision: 1, x: -1920, y: 0, width: 1920, height: 1080, scale: 2, rotation: 0 }] };
const channel = () => {
  const messages: any[] = [], closed: string[] = [];
  return { messages, closed, configure: (v: unknown) => { messages.push(v); return true; }, send: (v: unknown) => { messages.push(v); return true; }, close: (v: string) => { closed.push(v); } };
};
beforeEach(async () => {
  clock = Date.now(); root = await mkdtemp(path.join(os.tmpdir(), "screen-authority-")); hub = await HubServer.start({ stateDir: root });
  await hub.enrollLocalController(deviceFields(owner)); local = await loginFor(hub.auth, owner);
  await enrollTrusted(hub.auth, viewer); remote = await loginFor(hub.auth, viewer); await enrollTrusted(hub.auth, other);
  screen = new HubRemoteScreen(hub.store, hub.auth, () => clock, () => clock);
});
afterEach(async () => { screen.dispose(); await hub.close(); await rm(root, { recursive: true, force: true }); });
async function configure(permission: "view" | "control" = "control", enabled = true, grants?: ScreenConfigure["grants"]) {
  const status = await screen.status(local.session);
  const command: ScreenConfigure = { operation: "screen.configure", expectedRevision: status.policy!.revision, enabled,
    grants: grants ?? [{ deviceId: viewer.deviceId, publicKey: viewer.publicKey, permission }, { deviceId: other.deviceId, publicKey: other.publicKey, permission }], requestId: randomUUID() };
  const statement = await hub.auth.prepareDeviceAction({ operation: "screen-grant", target: hashSecret(screenConfigureText(command)) }, local.token, local.session);
  const proof = { nonce: statement.nonce, signature: sign(null, Buffer.from(deviceActionProofText(statement)), owner.privateKey).toString("base64") };
  return { command, proof, result: await screen.configure(local.session, command, proof) };
}
function service() { const sink = channel(), { ticket } = screen.serviceTicket(desktop.desktopId); const grant = screen.registerService(ticket, desktop, sink); return { sink, ...grant }; }
async function join() {
  const join = await screen.open(remote.session, { desktopId: desktop.desktopId, displayId: "1", displayRevision: 1, requestId: randomUUID() });
  const control = channel(), media = channel();
  await screen.attachViewer(join.controlTicket, "control", control); await screen.attachViewer(join.mediaTicket, "media", media);
  return { join, control, media };
}
const header = (sequence: number, streamGeneration = 1) => ({ key: true, codec: "vp8" as const, sequence, geometryRevision: 1, streamGeneration, captureMs: clock, width: 1920, height: 1080 });
const stream = (streamGeneration = 1) => ({ type: "stream", streamGeneration, geometryRevision: 1, codec: "vp8", codecString: "vp8", width: 1920, height: 1080, contentRect: { x: 0, y: 0, width: 1920, height: 1080 } });
function liveFrame(epoch: string, join: ScreenJoin, n = 1, gen = 1, config = true) {
  if (config) expect(screen.stream(epoch, join.session.id, join.session.generation, stream(gen))).toBe(true);
  expect(screen.frame(epoch, join.session.id, join.session.generation, header(n, gen), new Uint8Array([1, 2]))).toBe(true);
  screen.viewerCommand(join.session.id, { type: "ack", sessionId: join.session.id, generation: join.session.generation, frameSequence: n });
  screen.serviceFrameConfirmed(epoch, join.session.id, n, clock, gen);
}
function control(epoch: string, join: ScreenJoin, sink: ReturnType<typeof channel>) {
  screen.viewerCommand(join.session.id, { type: "control", sessionId: join.session.id, generation: join.session.generation, frameSequence: 1 });
  expect(sink.messages.at(-1).type).toBe("reset");
  liveFrame(epoch, join, 2, 2);
  const lease = sink.messages.findLast(v => v.type === "lease");
  screen.serviceLeaseReady(epoch, join.session.id, lease.leaseId); return lease;
}
function key(join: ScreenJoin, lease: { leaseId: string }, sequence = 1) {
  return { type: "input", sessionId: join.session.id, desktopId: desktop.desktopId, generation: join.session.generation, displayId: "1", displayRevision: 1,
    leaseId: lease.leaseId, sequence, frameSequence: 2, expiresAt: clock + 2000, event: { kind: "key", code: "MetaLeft", down: true } };
}
it("defaults disabled and paired owners do not inherit screen access", async () => {
  service();
  expect(await screen.status(remote.session)).toMatchObject({ enabled: false, permission: "none", desktop: null, canManage: false });
  await expect(screen.open(remote.session, { desktopId: desktop.desktopId, displayId: "1", displayRevision: 1, requestId: "first" })).rejects.toThrow("screen_not_authorized");
});
it("requires a local controller and a distinct signed configuration intent", async () => {
  const { command, proof } = await configure();
  await expect(screen.configure(remote.session, { ...command, requestId: "new" }, proof)).rejects.toThrow("local_controller_required");
  await expect(screen.configure(local.session, { ...command, requestId: "new", enabled: false }, proof)).rejects.toThrow("device_action_expired");
  expect((await screen.status(local.session)).policy!.enabled).toBe(true);
});
it("replays exact configuration receipt but rejects request-id substitution", async () => {
  const { command, proof, result } = await configure();
  expect(await screen.configure(local.session, command, proof)).toEqual(result);
  await expect(screen.configure(local.session, { ...command, enabled: false }, proof)).rejects.toThrow("screen_request_conflict");
  const restarted = new HubRemoteScreen(hub.store, hub.auth);
  try { expect((await restarted.status(local.session)).policy).toEqual(result); } finally { restarted.dispose(); }
});
it("service and viewer tickets are one-use and role-bound", async () => {
  await configure(); const { epoch } = service(); const { join: j } = await join();
  await expect(screen.attachViewer(j.controlTicket, "control", channel())).rejects.toThrow("screen_ticket_invalid");
  expect(() => screen.serviceMedia(j.mediaTicket)).toThrow("screen_ticket_invalid");
  screen.serviceLost(epoch); expect((await screen.status(remote.session)).sessions).toHaveLength(0);
});
it("view permission cannot send input or obtain a lease", async () => {
  await configure("view"); const { epoch, sink } = service(); const { join: j } = await join(); liveFrame(epoch, j);
  expect(() => control(epoch, j, sink)).toThrow("screen_control_not_authorized");
  expect(sink.messages.some(v => v.type === "lease" || v.type === "input")).toBe(false);
});
it("one control lease per desktop, including different devices", async () => {
  await configure(); const { epoch, sink } = service(); const { join: a } = await join(); liveFrame(epoch, a); control(epoch, a, sink);
  const second = await loginFor(hub.auth, other);
  const b = await screen.open(second.session, { desktopId: desktop.desktopId, displayId: "1", displayRevision: 1, requestId: "second" });
  const out = channel(), media = channel(); await screen.attachViewer(b.controlTicket, "control", out); await screen.attachViewer(b.mediaTicket, "media", media); liveFrame(epoch, b);
  screen.viewerCommand(b.session.id, { type: "control", sessionId: b.session.id, generation: b.session.generation, frameSequence: 1 });
  expect(out.messages.at(-1)).toMatchObject({ type: "state", session: { state: "viewing", reason: "screen_control_busy" } });
  expect(media.closed).toHaveLength(0);
  expect(sink.messages.filter(v => v.type === "lease")).toHaveLength(1);
});
it("releases input on replay or wrong display coordinates", async () => {
  await configure(); const { epoch, sink } = service(); const { join: j } = await join(); liveFrame(epoch, j); const lease = control(epoch, j, sink);
  screen.viewerCommand(j.session.id, key(j, lease));
  expect(() => screen.viewerCommand(j.session.id, key(j, lease))).toThrow("screen_input_stale");
  expect(sink.messages.filter(v => v.type === "input")).toHaveLength(1);
  expect(sink.messages.at(-1)).toMatchObject({ type: "release", reason: "screen_input_stale" });
});
it("stale picture releases held input even if no key-up arrives", async () => {
  await configure(); const { epoch, sink } = service(); const { join: j } = await join(); liveFrame(epoch, j); const lease = control(epoch, j, sink);
  screen.viewerCommand(j.session.id, key(j, lease)); clock += 2100; screen.tick();
  expect(sink.messages.at(-1)).toMatchObject({ type: "release" });
  expect(() => screen.viewerCommand(j.session.id, key(j, lease, 2))).toThrow("screen_frame_stale");
});
it("hide and resume require a fresh picture and explicit new control", async () => {
  await configure(); const { epoch, sink } = service(); const { join: j } = await join(); liveFrame(epoch, j); const lease = control(epoch, j, sink);
  for (const visible of [false, true]) screen.viewerCommand(j.session.id, { type: "visibility", sessionId: j.session.id, generation: j.session.generation, visible });
  expect(() => screen.viewerCommand(j.session.id, key(j, lease))).toThrow("screen_frame_stale");
  expect(sink.messages.filter(v => v.type === "release")).toHaveLength(1);
});
it.each(["lock", "geometry", "permission"])("%s invalidates old media and control", async cause => {
  await configure(); const { epoch, sink } = service(); const { join: j, media } = await join(); liveFrame(epoch, j); control(epoch, j, sink);
  const next = structuredClone(desktop);
  if (cause === "lock") next.locked = true; else if (cause === "geometry") next.displays[0]!.revision++; else next.capture = "denied";
  screen.serviceStatus(epoch, next);
  expect(media.closed).toHaveLength(1); expect((await screen.status(remote.session)).sessions).toHaveLength(0);
  expect(screen.frame(epoch, j.session.id, j.session.generation, header(3, 2), new Uint8Array([3]))).toBe(false);
});
it("revoking a device immediately closes existing channels", async () => {
  await configure(); const { epoch, sink } = service(); const { join: j, media } = await join(); liveFrame(epoch, j); control(epoch, j, sink);
  await hub.auth.revoke(viewer.deviceId, "local-owner");
  expect(media.closed).toEqual(["device_revoked"]); expect(sink.messages.some(v => v.type === "release")).toBe(true);
});
it("the policy downgrade releases control while retaining the view", async () => {
  await configure(); const { epoch, sink } = service(); const { join: j, media } = await join(); liveFrame(epoch, j); control(epoch, j, sink);
  await configure("view"); expect(media.closed).toHaveLength(0);
  expect((await screen.status(remote.session)).sessions[0]).toMatchObject({ state: "viewing", controlAllowed: false });
  await configure("view", false); expect(media.closed).toHaveLength(1);
});
it("does not persist input text or video into messages or audit metadata", async () => {
  await configure(); const { epoch, sink } = service(); const { join: j } = await join(); liveFrame(epoch, j); const lease = control(epoch, j, sink);
  screen.viewerCommand(j.session.id, { ...key(j, lease), event: { kind: "text", text: "private-中文-input" } });
  await hub.store.flushAudit();
  expect(JSON.stringify(await hub.store.db.all("SELECT * FROM audit_log"))).not.toContain("private-中文-input");
  expect(await hub.store.db.all("SELECT id FROM messages")).toEqual([]);
});
it("rejects malformed text, nonfinite coordinates, and unlimited keys", () => {
  const base = { ...key({ session: { id: "s", generation: "g" } } as ScreenJoin, { leaseId: "a".repeat(43) }) };
  for (const event of [{ kind: "text", text: "\ud800" }, { kind: "text", text: "a\0" }, { kind: "move", x: Infinity, y: 0 }, { kind: "key", code: "RunCommand", down: true }]) expect(screenInputSchema.safeParse({ ...base, event }).success).toBe(false);
});

it("retired hidden generation never resumes its decoder; a fresh keyframe is required", async () => {
  await configure(); const { epoch } = service(); const { join: j, media } = await join(); liveFrame(epoch, j);
  screen.viewerCommand(j.session.id, { type: "visibility", sessionId: j.session.id, generation: j.session.generation, visible: false });
  const count = media.messages.length;
  expect(screen.frame(epoch, j.session.id, j.session.generation, header(2), new Uint8Array([1]))).toBe(true);
  expect(media.messages.length).toBe(count);
  screen.viewerCommand(j.session.id, { type: "visibility", sessionId: j.session.id, generation: j.session.generation, visible: true });
  screen.stream(epoch, j.session.id, j.session.generation, stream(2));
  expect(screen.frame(epoch, j.session.id, j.session.generation, { ...header(3, 2), key: false }, new Uint8Array([1]))).toBe(false);
  expect(media.closed).toEqual(["screen_frame_invalid_or_stale"]);
});
it("waits for a hidden connecting viewer to return before starting capture", async () => {
  await configure(); const { epoch, sink } = service();
  const j = await screen.open(remote.session, { desktopId: desktop.desktopId, displayId: "1", displayRevision: 1, requestId: randomUUID() });
  const control = channel(), media = channel(), ids = { sessionId: j.session.id, generation: j.session.generation };
  await screen.attachViewer(j.controlTicket, "control", control);
  screen.viewerCommand(j.session.id, { type: "visibility", ...ids, visible: false });
  await screen.attachViewer(j.mediaTicket, "media", media);
  expect(sink.messages.filter(v => v.type === "start" || v.type === "pause")).toEqual([]);
  // Attached-but-hidden is not an incomplete ticket handshake. Its original
  // authentication expiry remains enforced independently.
  for (let i = 0; i < 8; i++) { clock += 5000; screen.serviceStatus(epoch, desktop); screen.tick(); }
  expect((await screen.status(remote.session)).sessions).toMatchObject([{ id: j.session.id, state: "paused" }]);
  screen.viewerCommand(j.session.id, { type: "visibility", ...ids, visible: true });
  expect(sink.messages.filter(v => v.type === "start")).toMatchObject([{ streamGeneration: 2 }]);
  expect(sink.messages.filter(v => v.type === "pause")).toEqual([]);
  liveFrame(epoch, j, 1, 2);
  expect(media.closed).toEqual([]);
  expect((await screen.status(remote.session)).sessions).toMatchObject([{ state: "viewing" }]);
});
it("an encoded send failure ends the session instead of continuing the broken reference chain", async () => {
  await configure(); const { epoch } = service(); const { join: j, media } = await join(); liveFrame(epoch, j);
  media.send = () => false;
  expect(screen.frame(epoch, j.session.id, j.session.generation, header(2), new Uint8Array([1]))).toBe(false);
  expect(media.closed).toEqual(["screen_congested"]);
  expect((await screen.status(remote.session)).sessions).toHaveLength(0);
});
it("Hub arrival or a forged ACK alone cannot authorize input", async () => {
  await configure(); const { epoch, sink } = service(); const { join: j } = await join();
  screen.stream(epoch, j.session.id, j.session.generation, stream());
  screen.frame(epoch, j.session.id, j.session.generation, header(1), new Uint8Array([1]));
  screen.serviceFrameConfirmed(epoch, j.session.id, 1, clock, 1);
  const request = { type: "control", sessionId: j.session.id, generation: j.session.generation, frameSequence: 1 };
  expect(() => screen.viewerCommand(j.session.id, request)).toThrow("screen_frame_stale");
  screen.viewerCommand(j.session.id, { ...request, type: "ack" });
  screen.serviceFrameConfirmed(epoch, j.session.id, 1, clock + 1, 1);
  expect(() => screen.viewerCommand(j.session.id, request)).toThrow("screen_frame_stale");
  screen.serviceFrameConfirmed(epoch, j.session.id, 1, clock, 1);
  screen.viewerCommand(j.session.id, request);
  expect(sink.messages.at(-1).type).toBe("reset");
  expect(sink.messages.some(v => v.type === "lease")).toBe(false);
});
it("renewal challenge expires at issue time and cannot be replayed", async () => {
  await configure(); const { epoch, sink } = service(); const { join: j, control: out } = await join(); liveFrame(epoch, j); const lease = control(epoch, j, sink);
  const challenge = out.messages.findLast(v => v.type === "state" && v.lease)?.lease.challenge;
  clock += 1000; liveFrame(epoch, j, 3, 2, false);
  const renew = { type: "renew", sessionId: j.session.id, generation: j.session.generation, leaseId: lease.leaseId, frameSequence: 3, challenge };
  screen.viewerCommand(j.session.id, renew);
  expect(sink.messages.findLast(v => v.type === "lease").expiresAt).toBe(lease.expiresAt);
  expect(() => screen.viewerCommand(j.session.id, renew)).toThrow("screen_renew_expired");
  expect(sink.messages.at(-1).type).toBe("release");
});
it("a late renewal does not extend a lease even with fresh video", async () => {
  await configure(); const { epoch, sink } = service(); const { join: j, control: out } = await join(); liveFrame(epoch, j); const lease = control(epoch, j, sink);
  const challenge = out.messages.findLast(v => v.type === "state" && v.lease)?.lease.challenge;
  clock += 3100; liveFrame(epoch, j, 3, 2, false);
  expect(() => screen.viewerCommand(j.session.id, { type: "renew", sessionId: j.session.id, generation: j.session.generation, leaseId: lease.leaseId, frameSequence: 3, challenge })).toThrow("screen_renew_expired");
});

it("only a currently held up may bypass stale frame and geometry checks", async () => {
  await configure(); const { epoch, sink } = service(); const { join: j } = await join(); liveFrame(epoch, j); const lease = control(epoch, j, sink);
  screen.viewerCommand(j.session.id, key(j, lease));
  clock += 2100;
  const up = { ...key(j, lease, 2), displayRevision: 99, expiresAt: 1, event: { kind: "key", code: "MetaLeft", down: false } };
  screen.viewerCommand(j.session.id, up);
  expect(sink.messages.at(-1)).toMatchObject({ type: "input", sequence: 2, event: { down: false } });
  const count = sink.messages.filter(v => v.type === "input").length;
  expect(() => screen.viewerCommand(j.session.id, { ...up, sequence: 3 })).toThrow("screen_frame_stale");
  expect(sink.messages.filter(v => v.type === "input")).toHaveLength(count);
  expect(sink.messages.at(-1).type).toBe("release");
});
it("held up cannot revive an expired lease", async () => {
  await configure(); const { epoch, sink } = service(); const { join: j } = await join(); liveFrame(epoch, j); const lease = control(epoch, j, sink);
  screen.viewerCommand(j.session.id, key(j, lease));
  clock += 6100;
  const up = { ...key(j, lease, 2), expiresAt: 1, event: { kind: "key", code: "MetaLeft", down: false } };
  expect(() => screen.viewerCommand(j.session.id, up)).toThrow("screen_frame_stale");
  expect(sink.messages.filter(v => v.type === "input")).toHaveLength(1);
  expect(sink.messages.at(-1).type).toBe("release");
});
it.each(["screen_input_denied", "screen_takeover_unavailable"] as const)("target lease rejection %s retains viewing and only affects that exact lease", async reason => {
  await configure(); const { epoch, sink } = service(); const { join: j, control: out, media } = await join(); liveFrame(epoch, j); const lease = control(epoch, j, sink);
  screen.serviceLeaseDenied("old_epoch", j.session.id, lease.leaseId, "screen_input_denied");
  screen.serviceLeaseDenied(epoch, j.session.id, "x".repeat(43), "screen_input_denied");
  expect(out.messages.at(-1).session.state).toBe("controlling");
  screen.serviceLeaseDenied(epoch, j.session.id, lease.leaseId, reason);
  expect(out.messages.at(-1)).toMatchObject({ type: "state", session: { state: "viewing", reason } });
  expect(media.closed).toHaveLength(0);
  const count = out.messages.length;
  screen.serviceLeaseDenied(epoch, j.session.id, lease.leaseId, "screen_lease_invalid");
  expect(out.messages).toHaveLength(count);
  screen.viewerCommand(j.session.id, { type: "control", sessionId: j.session.id, generation: j.session.generation, frameSequence: 2 });
  liveFrame(epoch, j, 3, 3);
  const next = sink.messages.findLast(v => v.type === "lease"); screen.serviceLeaseReady(epoch, j.session.id, next.leaseId);
  screen.serviceLeaseDenied(epoch, j.session.id, lease.leaseId, "screen_input_denied");
  expect(out.messages.at(-1).session.state).toBe("controlling");
  expect(out.messages.at(-1).session.reason).toBeUndefined();
});
it("shared key own-properties, triple clicks and pixel wheel bounds form the input allowlist", () => {
  const base = key({ session: { id: "s", generation: "g" } } as ScreenJoin, { leaseId: "a".repeat(43) });
  for (const code of ["Numpad1", "NumpadEnter", "F13", "F19", "IntlBackslash", "Insert", "NumLock"]) expect(screenInputSchema.safeParse({ ...base, event: { kind: "key", code, down: true } }).success).toBe(true);
  for (const code of ["constructor", "__proto__", "toString", "F20", "Numpad999"]) expect(screenInputSchema.safeParse({ ...base, event: { kind: "key", code, down: true } }).success).toBe(false);
  for (const clicks of [1,2,3]) expect(screenInputSchema.safeParse({ ...base, event: { kind: "button", x: 1, y: 1, button: 0, down: true, clicks } }).success).toBe(true);
  expect(screenInputSchema.safeParse({ ...base, event: { kind: "button", x: 1, y: 1, button: 0, down: true, clicks: 4 } }).success).toBe(false);
  expect(screenInputSchema.safeParse({ ...base, event: { kind: "wheel", x: .5, y: .5, dx: -2000, dy: 2000 } }).success).toBe(true);
  expect(screenInputSchema.safeParse({ ...base, event: { kind: "wheel", x: .5, y: .5, dx: 0, dy: 2001 } }).success).toBe(false);
});
it("held up cannot cross desktops or survive permission revocation", async () => {
  await configure(); const { epoch, sink } = service(); const { join: j } = await join(); liveFrame(epoch, j); const lease = control(epoch, j, sink);
  screen.viewerCommand(j.session.id, key(j, lease));
  expect(() => screen.viewerCommand(j.session.id, { ...key(j, lease, 2), desktopId: "different", event: { kind: "key", code: "MetaLeft", down: false } })).toThrow("screen_input_stale");
  await configure("view");
  expect(() => screen.viewerCommand(j.session.id, { ...key(j, lease, 3), event: { kind: "key", code: "MetaLeft", down: false } })).toThrow("screen_control_not_authorized");
  expect(sink.messages.filter(v => v.type === "input")).toHaveLength(1);
});
it("concurrent policy edits use persisted compare-and-swap, so a stale edit cannot overwrite authorization", async () => {
  await configure(); const current = (await screen.status(local.session)).policy!;
  const commands = await Promise.all([true, false].map(async enabled => {
    const command: ScreenConfigure = { operation: "screen.configure", expectedRevision: current.revision, enabled, grants: current.grants, requestId: randomUUID() };
    const statement = await hub.auth.prepareDeviceAction({ operation: "screen-grant", target: hashSecret(screenConfigureText(command)) }, local.token, local.session);
    return { command, proof: { nonce: statement.nonce, signature: sign(null, Buffer.from(deviceActionProofText(statement)), owner.privateKey).toString("base64") } };
  }));
  const results = await Promise.allSettled(commands.map(({command,proof}) => screen.configure(local.session, command, proof)));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  expect((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason.message).toBe("screen_policy_changed");
  expect((await screen.status(local.session)).policy!.revision).toBe(current.revision + 1);
});

it("late decoder ACKs return credits without authorizing control from stale video", async () => {
  await configure(); const { epoch, sink } = service(); const { join: j, control: out } = await join();
  screen.stream(epoch, j.session.id, j.session.generation, stream());
  const captured = clock;
  for (const sequence of [1, 2, 3]) screen.frame(epoch, j.session.id, j.session.generation, header(sequence), new Uint8Array([1]));
  clock += 2100;
  for (const sequence of [1, 2, 3, 3, 99]) {
    screen.viewerCommand(j.session.id, { type: "ack", sessionId: j.session.id, generation: j.session.generation, frameSequence: sequence });
    screen.serviceFrameConfirmed(epoch, j.session.id, sequence, captured, 1);
  }
  expect(sink.messages.filter(v => v.type === "ack").map(v => v.frameSequence)).toEqual([1, 2, 3]);
  expect(out.messages.some(v => v.type === "frame-ready")).toBe(false);
  expect(sink.messages.some(v => v.type === "lease")).toBe(false);
  expect(() => screen.viewerCommand(j.session.id, { type: "control", sessionId: j.session.id, generation: j.session.generation, frameSequence: 3 })).toThrow("screen_frame_stale");
  liveFrame(epoch, j, 4, 1, false);
  expect(out.messages.at(-1)).toMatchObject({ type: "frame-ready", frameSequence: 4 });
  screen.viewerCommand(j.session.id, { type: "visibility", sessionId: j.session.id, generation: j.session.generation, visible: false });
  const acks = sink.messages.filter(v => v.type === "ack").length;
  screen.viewerCommand(j.session.id, { type: "ack", sessionId: j.session.id, generation: j.session.generation, frameSequence: 1 });
  expect(sink.messages.filter(v => v.type === "ack")).toHaveLength(acks);
});

it.each(["revoked", "rekeyed"])("a carried-over %s grant cannot lock policy changes or authorize the new device key", async cause => {
  await configure();
  const stale = (await screen.status(local.session)).policy!.grants;
  if (cause === "revoked") await hub.auth.revoke(viewer.deviceId, "local-owner");
  else await hub.store.db.run("UPDATE devices SET public_key=? WHERE id=?", [testDevice("replacement").publicKey, viewer.deviceId]);
  const altered = stale.map(g => g.deviceId === viewer.deviceId ? { ...g, permission: "view" as const } : g);
  await expect(configure("control", true, altered)).rejects.toThrow("screen_device_changed");
  const { command, proof, result } = await configure("control", false, stale);
  expect(result.enabled).toBe(false); expect(result.grants.map(g => g.deviceId)).toEqual([other.deviceId]);
  expect(await screen.configure(local.session, command, proof)).toEqual(result);
  // Once removed, even an unchanged old-key grant is a new invalid grant.
  await expect(configure("control", true, stale)).rejects.toThrow("screen_device_changed");
  const enabled = await configure("view", true, [{ deviceId: other.deviceId, publicKey: other.publicKey, permission: "view" }]);
  expect(enabled.result).toMatchObject({ enabled: true, grants: [{ deviceId: other.deviceId, permission: "view" }] });
});

it("failed credit delivery ends the stream instead of silently exhausting its encoder window", async () => {
  await configure(); const { epoch, sink } = service(); const { join: j, media } = await join();
  screen.stream(epoch, j.session.id, j.session.generation, stream());
  screen.frame(epoch, j.session.id, j.session.generation, header(1), new Uint8Array([1]));
  sink.send = () => false;
  screen.viewerCommand(j.session.id, { type: "ack", sessionId: j.session.id, generation: j.session.generation, frameSequence: 1 });
  expect(media.closed).toEqual(["screen_service_offline"]);
  expect((await screen.status(local.session)).sessions).toHaveLength(0);
});
