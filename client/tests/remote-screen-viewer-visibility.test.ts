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
  const drawImage = vi.fn(), canvas = { width: 640, height: 360, getContext: () => ({ drawImage }), focus() {} };
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
  return { viewer, attach, message, stream, frame, commands, drawImage };
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
