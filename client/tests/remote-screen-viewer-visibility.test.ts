import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ScreenJoin } from "../../src/client-protocol/remote-screen.js";
import { writeScreenFrame } from "../../src/client-protocol/screen-wire.js";
const bridge = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string, _args?: unknown) => undefined) }));
vi.mock("../src/desktop-bridge.js", () => ({ invoke: bridge.invoke }));
import { RemoteScreenViewer } from "../src/remote-screen-viewer.js";

// Synthetic decoder/MessagePort only: no capture, permission, native input or
// decoder-performance claims. Verify the production renderer's stream lifetime.
const cleanups: Array<() => void> = [];
beforeEach(() => { vi.useFakeTimers(); bridge.invoke.mockClear(); });
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const join: ScreenJoin = {
  session: { id: "screen_visibility", generation: "generation_visibility", desktopId: "desktop", deviceId: "device", deviceName: "Synthetic viewer", createdAt: 1000, state: "viewing", controlAllowed: true,
    display: { id: "display", nativeId: "1", name: "Synthetic display", revision: 1, x: 0, y: 0, width: 640, height: 360, scale: 1, rotation: 0 } },
  controlTicket: "c".repeat(43), mediaTicket: "m".repeat(43), expiresAt: 31000, serverTime: 1000,
};
async function fixture() {
  const window = new EventTarget(), origin = "https://screen-fixture.invalid";
  const bounds = vi.fn(() => ({ left: 10, top: 20, width: 640, height: 360 }));
  const drawImage = vi.fn(), canvas = { width: 640, height: 360, getBoundingClientRect: bounds, getContext: () => ({ drawImage }), focus() {} };
  vi.stubGlobal("window", window); vi.stubGlobal("location", { origin });
  vi.stubGlobal("document", { hasFocus: () => true, activeElement: canvas, visibilityState: "visible" });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("EncodedVideoChunk", class { timestamp: number; constructor(value: { timestamp: number }) { this.timestamp = value.timestamp; } });
  vi.stubGlobal("VideoDecoder", class {
    state = "unconfigured";
    constructor(private callbacks: { output: (frame: unknown) => void }) {}
    configure() { this.state = "configured"; }
    close() { this.state = "closed"; }
    decode(chunk: { timestamp: number }) { this.callbacks.output({ timestamp: chunk.timestamp, close() {} }); }
  });
  const port = { onmessage: undefined as ((event: { data: unknown }) => void) | undefined, postMessage: vi.fn(), start() {}, close() {} };
  const viewer = new RemoteScreenViewer(join, canvas as unknown as HTMLCanvasElement, () => {});
  cleanups.push(() => viewer.dispose()); await viewer.open({});
  const args = bridge.invoke.mock.calls.find(call => call[0] === "screen_viewer_open")![1] as { channelId: string };
  const attach = () => {
    const event = new Event("message");
    Object.defineProperties(event, { source: { value: window }, origin: { value: origin }, data: { value: { type: "tarobot:screen-port:v1", channelId: args.channelId, sessionId: join.session.id } }, ports: { value: [port] } });
    window.dispatchEvent(event);
  };
  const message = async (data: unknown) => { port.onmessage!({ data }); await Promise.resolve(); };
  const stream = (generation: number) => message({ type: "stream", streamGeneration: generation, geometryRevision: 1, codec: "vp8", codecString: "vp8", width: 640, height: 360, contentRect: { x: 0, y: 0, width: 640, height: 360 } });
  const frame = (sequence: number, generation: number) => message(writeScreenFrame({ key: true, codec: "vp8", sequence, geometryRevision: 1, streamGeneration: generation, captureMs: 1000, width: 640, height: 360 }, new Uint8Array([1, 2, 3])).buffer);
  const commands = () => port.postMessage.mock.calls.map(([value]) => value as Record<string, unknown>);
  return { viewer, attach, message, stream, frame, commands, drawImage, bounds };
}
it("keeps the Host's first generation decodable after hide/show before port delivery", async () => {
  const f = await fixture(); f.viewer.visibility(false); f.viewer.visibility(true); f.attach();
  await f.stream(1); for (let i = 1; i <= 3; i++) await f.frame(i, 1);
  expect(f.commands().filter(value => value.type === "visibility")).toEqual([]);
  expect(f.drawImage).toHaveBeenCalledTimes(3);
  expect(f.commands().filter(value => value.type === "ack").map(value => value.frameSequence)).toEqual([1, 2, 3]);
});
it("delivers one pending hide on port arrival and rejects its retired generation after showing", async () => {
  const f = await fixture(); f.viewer.visibility(false); f.viewer.visibility(false); f.attach();
  expect(f.commands().filter(value => value.type === "visibility")).toHaveLength(1);
  f.viewer.visibility(true); await f.stream(1); await f.frame(1, 1); expect(f.drawImage).not.toHaveBeenCalled();
  await f.stream(2); await f.frame(2, 2); expect(f.drawImage).toHaveBeenCalledOnce();
  expect(f.commands().filter(value => value.type === "ack").map(value => value.frameSequence)).toEqual([2]);
});
it("hide/show after attachment retires stale frames and cannot restore an old control lease", async () => {
  const f = await fixture(); f.attach(); await f.stream(1); await f.frame(1, 1);
  await f.message({ type: "frame-ready", sessionId: join.session.id, generation: join.session.generation, streamGeneration: 1, frameSequence: 1, expiresAt: 3000 });
  f.viewer.control(); await f.stream(2);
  const state = { type: "state", session: { ...join.session, state: "controlling" }, streamGeneration: 2, serverTime: 1000, lease: { id: "l".repeat(43), challenge: "c".repeat(43), expiresAt: 7000, challengeExpiresAt: 4000 } };
  await f.message(state); expect(f.viewer.state.controlling).toBe(true);
  f.viewer.visibility(false); f.viewer.visibility(true); await f.stream(2); await f.frame(2, 2);
  expect(f.drawImage).toHaveBeenCalledOnce();
  await f.stream(3); await f.frame(3, 3); await f.message({ ...state, streamGeneration: 3 });
  expect(f.drawImage).toHaveBeenCalledTimes(2); expect(f.viewer.state.controlling).toBe(false);
  expect(f.commands().filter(value => value.type === "control")).toHaveLength(1);
});

async function controllingFixture() {
  const f = await fixture(); f.attach(); await f.stream(1); await f.frame(1, 1);
  await f.message({ type: "frame-ready", sessionId: join.session.id, generation: join.session.generation, streamGeneration: 1, frameSequence: 1, expiresAt: 3000 });
  f.viewer.control(); await f.stream(2); await f.frame(2, 2);
  await f.message({ type: "state", session: { ...join.session, state: "controlling" }, streamGeneration: 2, serverTime: 1000,
    lease: { id: "l".repeat(43), challenge: "c".repeat(43), expiresAt: 7000, challengeExpiresAt: 4000 } });
  await f.message({ type: "frame-ready", sessionId: join.session.id, generation: join.session.generation, streamGeneration: 2, frameSequence: 2, expiresAt: 3000 });
  expect(f.viewer.state.controlling).toBe(true);
  return { ...f, inputs: () => f.commands().filter(v => v.type === "input") };
}
it("bounds high-rate pointer movement and retains the final coordinate", async () => {
  const f = await controllingFixture();
  for (let i = 0; i < 1000; i++) {
    f.viewer.input({ kind: "move", x: i / 1000, y: .5 });
    await vi.advanceTimersByTimeAsync(1);
  }
  await vi.advanceTimersByTimeAsync(40);
  expect(f.inputs().length).toBe(33);
  expect(f.inputs().at(-1)?.event).toEqual({ kind: "move", x: .999, y: .5 });
});
it("drops pending movement when local focus releases control", async () => {
  const f = await controllingFixture();
  f.viewer.input({ kind: "move", x: .1, y: .5 });
  f.viewer.input({ kind: "move", x: .9, y: .5 }); f.viewer.release();
  await vi.advanceTimersByTimeAsync(40);
  expect(f.inputs().map(v => v.event)).toEqual([{ kind: "move", x: .1, y: .5 }]);
});
it("flushes movement before drag edges and keys without coalescing either edge", async () => {
  const f = await controllingFixture();
  const events = [
    { kind: "move", x: .1, y: .2 }, { kind: "button", x: .1, y: .2, button: 0, down: true, clicks: 1 },
    { kind: "move", x: .2, y: .3 }, { kind: "move", x: .3, y: .4 },
    { kind: "button", x: .3, y: .4, button: 0, down: false, clicks: 1 },
    { kind: "move", x: .4, y: .5 }, { kind: "key", code: "ShiftLeft", down: true }, { kind: "key", code: "ShiftLeft", down: false },
  ] as const;
  for (const event of events) expect(f.viewer.input(event)).toBe(true);
  await vi.advanceTimersByTimeAsync(40);
  expect(f.inputs().map(v => v.event)).toEqual(events.filter((_, i) => i !== 2));
  expect(f.inputs().map(v => v.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
});
it.each(["hide", "dispose", "focus", "stale", "lease", "stream", "generation"])("does not send queued movement after %s retires its authority", async cause => {
  const f = await controllingFixture();
  f.viewer.input({ kind: "move", x: .1, y: .5 });
  f.viewer.input({ kind: "move", x: .9, y: .5 });
  if (cause === "hide") f.viewer.visibility(false);
  if (cause === "dispose") f.viewer.dispose();
  if (cause === "focus") vi.stubGlobal("document", { hasFocus: () => false, visibilityState: "visible" });
  if (cause === "stale") f.viewer.state.fresh = false;
  if (cause === "stream") await f.stream(3);
  if (cause === "lease" || cause === "generation") {
    await f.message({ type: "state", session: { ...join.session, state: "controlling" }, streamGeneration: cause === "generation" ? 3 : 2, serverTime: 1000,
      lease: { id: cause === "lease" ? "n".repeat(43) : "l".repeat(43), challenge: "c".repeat(43), expiresAt: 7000, challengeExpiresAt: 4000 } });
    if (cause === "generation") { await f.stream(3); await f.frame(3, 3); }
    await f.message({ type: "frame-ready", sessionId: join.session.id, generation: join.session.generation, streamGeneration: cause === "generation" ? 3 : 2, frameSequence: 3, expiresAt: 3000 });
  }
  await vi.advanceTimersByTimeAsync(40);
  expect(f.inputs().map(v => v.event)).toEqual([{ kind: "move", x: .1, y: .5 }]);
});
it("uses the latest confirmed picture when sending and never moves again after a flush", async () => {
  const f = await controllingFixture(); const event = { kind: "move" as const, x: .5, y: .4 };
  f.viewer.input({ kind: "move", x: .1, y: .5 });
  f.viewer.input(event); event.x = .8;
  await f.message({ type: "frame-ready", sessionId: join.session.id, generation: join.session.generation, streamGeneration: 2, frameSequence: 3, expiresAt: 4000 });
  await vi.advanceTimersByTimeAsync(40);
  expect(f.inputs().slice(1)).toMatchObject([{ frameSequence: 3, expiresAt: 4000, event: { kind: "move", x: .5, y: .4 } }]);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.inputs()).toHaveLength(2);
});
it("leaves control-channel budget for picture ACKs while moving and scrolling together", async () => {
  const f = await controllingFixture();
  for (let i = 0; i < 1000; i++) {
    f.viewer.input({ kind: "move", x: i / 1000, y: .5 });
    if (i % 34 === 0) f.viewer.wheel({ kind: "wheel", x: i / 1000, y: .5, dx: 0, dy: 1 });
    await vi.advanceTimersByTimeAsync(1);
  }
  await vi.advanceTimersByTimeAsync(40);
  expect(f.inputs().length + 15 + 1).toBeLessThan(120); // 15 fps ACKs plus renewal
  expect(f.inputs().filter(v => (v.event as {kind: string}).kind === "wheel").length).toBeGreaterThan(0);
});

it("measures picture bounds only for sent pointer positions, including the trailing one", async () => {
  const f = await controllingFixture();
  for (let i = 0; i < 1000; i++) f.viewer.pointerMove({ clientX: 10 + i / 1000 * 640, clientY: 200 });
  expect(f.bounds).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(32);
  expect(f.bounds).toHaveBeenCalledTimes(2);
  expect(f.inputs().map(v => v.event)).toEqual([{ kind: "move", x: 0, y: .5 }, { kind: "move", x: .999, y: .5 }]);
});
it("flushes a pending position before button-down", async () => {
  const f = await controllingFixture();
  f.viewer.input({ kind: "move", x: .1, y: .5 });
  f.viewer.input({ kind: "move", x: .8, y: .5 });
  f.viewer.input({ kind: "button", x: .8, y: .5, button: 0, down: true, clicks: 1 });
  expect(f.inputs().map(v => v.event)).toEqual([
    { kind: "move", x: .1, y: .5 }, { kind: "move", x: .8, y: .5 },
    { kind: "button", x: .8, y: .5, button: 0, down: true, clicks: 1 },
  ]);
  await vi.advanceTimersByTimeAsync(40);
  expect(f.inputs()).toHaveLength(3);
});
it("a new movement after a delayed timer supersedes it without a duplicate send", async () => {
  const f = await controllingFixture();
  const clock = vi.spyOn(performance, "now"); clock.mockReturnValue(100);
  try {
    f.viewer.input({ kind: "move", x: .1, y: .5 });
    f.viewer.input({ kind: "move", x: .3, y: .5 });
    clock.mockReturnValue(200); // renderer was busy; the scheduled callback has not run
    f.viewer.input({ kind: "move", x: .8, y: .5 });
    await vi.advanceTimersByTimeAsync(40);
    expect(f.inputs().map(v => v.event)).toEqual([{ kind: "move", x: .1, y: .5 }, { kind: "move", x: .8, y: .5 }]);
  } finally { clock.mockRestore(); }
});
