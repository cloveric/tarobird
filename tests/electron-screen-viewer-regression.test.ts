import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeScreenFrame } from "../src/client-protocol/screen-wire.js";
import type { ScreenJoin } from "../src/client-protocol/remote-screen.js";

// Exercise the production viewer bridge with transport/MessagePort doubles.
// This protects its copy/bounds/lifetime contract; it is not an Electron
// event-loop or operating-system acceptance test.
const transport = vi.hoisted(() => ({ connections: [] as Array<{
  role: string;
  receive: (value: unknown) => void;
  signal: AbortSignal;
  sent: string[];
}> }));
vi.mock("../client/electron/screen-network.mjs", async importOriginal => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    screenPin: async () => "f".repeat(64),
    openScreenSocket: (_route: unknown, _pin: unknown, role: string, _ticket: string,
      options: { receive: (value: unknown) => void; signal: AbortSignal }) => {
      const connection = { role, ...options, sent: [] as string[] };
      transport.connections.push(connection);
      return { readyState: 1, bufferedAmount: 0, send: (text: string) => connection.sent.push(text) };
    },
  };
});
// @ts-ignore JavaScript Electron boundary
import { ScreenViewers } from "../client/electron/screen-viewer.mjs";

class Port extends EventEmitter {
  messages: unknown[][] = [];
  closed = false;
  start() {}
  postMessage(...args: unknown[]) {
    this.messages.push(args);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}
const cleanup: Array<() => void> = [];
beforeEach(() => { transport.connections.length = 0; });
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

async function fixture(quality?: "smooth"|"balanced"|"sharp") {
  const mainPort = new Port(), rendererPort = new Port();
  const handedOff: unknown[][] = [];
  const window = {
    isDestroyed: () => false, isFocused: () => true, isVisible: () => true, isMinimized: () => false,
    webContents: { postMessage: (...args: unknown[]) => handedOff.push(args) },
  };
  const viewers = new ScreenViewers(window, {
    MessageChannelMain: class { port1 = mainPort; port2 = rendererPort; },
  });
  cleanup.push(() => viewers.retire());
  const join: ScreenJoin = { ...(quality?{quality}:{}),
    session: { id: "screen_viewer_test", desktopId: "desktop_test", deviceId: "device_test", deviceName: "Test viewer",
      generation: "generation_test", controlAllowed: true, state: "connecting", createdAt: 1000,
      display: { id: "display_test", nativeId: "1", name: "Display 1", revision: 1,
        x: 0, y: 0, width: 1920, height: 1080, scale: 1, rotation: 0 } },
    controlTicket: "c".repeat(43), mediaTicket: "m".repeat(43), expiresAt: 31000, serverTime: 1000,
  };
  const connectionOffset=transport.connections.length;
  await viewers.open({ channelId: "403229c4-3be2-4a3a-a824-c9555eb65e22", join,
    network: { url: "https://127.0.0.1:8443", publicKey: "a".repeat(59) + "=" } }, () => true);
  const media = transport.connections.slice(connectionOffset).find(connection => connection.role === "media")!;
  return { viewers, mainPort, rendererPort, handedOff, media, join };
}
function packet(sequence: number) {
  return writeScreenFrame({ key: sequence === 1, codec: "h264", sequence, geometryRevision: 1,
    streamGeneration: 1, captureMs: 1000 + sequence, width: 1920, height: 1080 }, new Uint8Array([0, 0, 0, 1, 0x65, sequence]));
}
const binaryMessages = (port: Port) => port.messages.filter(args => args[0] instanceof ArrayBuffer);

it("copies the exact binary view without an ArrayBuffer transfer list or neighboring bytes", async () => {
  const { mainPort, rendererPort, handedOff, media } = await fixture();
  const frame = packet(1), backing = new Uint8Array(frame.length + 12).fill(0xee);
  backing.set(frame, 5);
  const received = backing.subarray(5, 5 + frame.length);
  media.receive(received);

  const calls = binaryMessages(mainPort);
  expect(calls).toHaveLength(1);
  // Passing an ArrayBuffer transfer list here reintroduces the observed hang.
  expect(calls[0]).toHaveLength(1);
  const copied = calls[0]![0] as ArrayBuffer;
  expect([...new Uint8Array(copied)]).toEqual([...frame]);
  expect(received.byteLength).toBe(frame.length);
  backing.fill(0);
  expect([...new Uint8Array(copied)]).toEqual([...frame]);
  // Transferring the MessagePort handle itself remains necessary and allowed.
  expect(handedOff[0]![2]).toEqual([rendererPort]);
});

it("accepts a fourth frame after a receipt frees one of three IPC credits", async () => {
  const { mainPort, media } = await fixture();
  for (let sequence = 1; sequence <= 3; sequence++) media.receive(packet(sequence));
  mainPort.emit("message", { data: { type: "received", sequence: 1 } });
  media.receive(packet(4));
  expect(binaryMessages(mainPort)).toHaveLength(4);
  expect(mainPort.closed).toBe(false);
  expect(media.signal.aborted).toBe(false);
});

it("terminates the entire viewer when the IPC window fills instead of dropping a delta and continuing", async () => {
  const { viewers, mainPort, media } = await fixture();
  for (let sequence = 1; sequence <= 4; sequence++) media.receive(packet(sequence));
  expect(binaryMessages(mainPort)).toHaveLength(3);
  expect(mainPort.messages.at(-1)?.[0]).toEqual({ type: "closed", reason: "screen_viewer_congested" });
  expect(mainPort.closed).toBe(true);
  expect(viewers.viewers.size).toBe(0);
  expect(transport.connections.every(connection => connection.signal.aborted)).toBe(true);
});

it("retires the port and both connections before a late old-document packet can reach the viewer", async () => {
  const { viewers, mainPort, media } = await fixture();
  media.receive(packet(1));
  viewers.retire();
  const count = mainPort.messages.length;
  media.receive(packet(2));
  expect(mainPort.messages).toHaveLength(count);
  expect(mainPort.closed).toBe(true);
  expect(transport.connections.every(connection => connection.signal.aborted)).toBe(true);
});

it("media stream and binary sizes remain bound to the negotiated quality, not the global schema maximum",async()=>{
 const stream={type:"stream",streamGeneration:1,geometryRevision:1,codec:"h264",codecString:"avc1.640033",width:2880,height:1800,contentRect:{x:0,y:0,width:2880,height:1800}};
 const legacy=await fixture();expect(()=>legacy.media.receive(stream)).toThrow("screen_stream_invalid");
 const sharp=await fixture("sharp");expect(()=>sharp.media.receive(stream)).not.toThrow();
 expect(()=>sharp.media.receive({...stream,codec:"vp8",codecString:"vp8"})).toThrow("screen_stream_invalid");
 const smooth=await fixture("smooth");expect(()=>smooth.media.receive(packet(1))).toThrow("screen_stream_invalid");
});
