import { EventEmitter } from "node:events";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { WebSocketServer } from "ws";
// @ts-expect-error Electron main JavaScript module
import { ScreenViewers } from "../client/electron/screen-viewer.mjs";

// Real loopback WS handshake with a deliberately delayed attached receipt.
// Ports and window state are doubles; no desktop capture or native input.
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const wait = async (check: () => boolean) => {
  const end = Date.now() + 2000;
  while (!check()) { if (Date.now() > end) throw new Error("wait_timeout"); await new Promise(r => setTimeout(r, 5)); }
};
class Port extends EventEmitter {
  messages: unknown[] = [];
  start() {}
  postMessage(value: unknown) { this.messages.push(value); }
  close() {}
}
async function fixture(visible: boolean) {
  const received: any[] = [], server = http.createServer(), sockets = new WebSocketServer({ server });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { for (const socket of sockets.clients) socket.terminate(); sockets.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  let attach: (() => void) | undefined, reply: ((value: unknown) => void) | undefined;
  const menuShortcuts: boolean[] = [];
  const id = "screen_window", generation = "window_generation", port = new Port();
  sockets.on("connection", (socket, request) => {
    let hello = false;
    socket.on("message", bytes => {
      const value = JSON.parse(bytes.toString());
      if (!hello) {
        hello = true;
        expect(value.type).toBe("hello");
        if (request.url?.endsWith("control")) { reply = value => socket.send(JSON.stringify(value)); attach = () => reply!({ type: "attached", sessionId: id }); }
        else socket.send(JSON.stringify({ type: "attached", sessionId: id }));
      } else received.push(value);
    });
  });
  const viewers = new ScreenViewers({ isDestroyed: () => false, isFocused: () => visible, isVisible: () => visible,
    isMinimized: () => false, webContents: { postMessage() {}, setIgnoreMenuShortcuts(value: boolean) { menuShortcuts.push(value); } } }, {
    MessageChannelMain: class { port1 = port; port2 = new Port(); },
  });
  cleanups.push(() => viewers.retire());
  const session = { id, generation, desktopId: "desktop", deviceId: "device", deviceName: "Test", createdAt: Date.now(), state: "connecting", controlAllowed: true,
      display: { id: "display", nativeId: "1", name: "Test", revision: 1, x: 0, y: 0, width: 640, height: 360, scale: 1, rotation: 0 } };
  await viewers.open({ channelId: randomUUID(), network: { url: `http://127.0.0.1:${(server.address() as any).port}`, publicKey: "a".repeat(59) + "=" },
    join: { session,
      controlTicket: "c".repeat(43), mediaTicket: "m".repeat(43), expiresAt: Date.now() + 30000, serverTime: Date.now() } }, () => true);
  await wait(() => !!attach);
  return { viewers, port, received, attach: () => attach!(), reply: (value: unknown) => reply!(value), session, menuShortcuts, id, generation };
}
it("waits for authenticated attachment before forwarding an early pane hide", async () => {
  const f = await fixture(true);
  f.port.emit("message", { data: { type: "visibility", sessionId: f.id, generation: f.generation, visible: false } });
  await new Promise(r => setTimeout(r, 30));
  expect(f.received).toEqual([]);
  expect(f.viewers.viewers.size).toBe(1);
  f.attach(); await wait(() => f.received.length === 1);
  expect(f.received[0]).toMatchObject({ type: "visibility", visible: false });
});
it("a viewer opened in an already hidden window tells the renderer and Host to pause", async () => {
  const f = await fixture(false);
  expect(f.port.messages).toContainEqual({ type: "native-visibility", visible: false });
  f.attach(); await wait(() => f.received.length === 1);
  expect(f.received[0]).toMatchObject({ type: "visibility", visible: false });
});
it("retiring while authentication is pending discards the bounded command queue", async () => {
  const f = await fixture(true);
  f.port.emit("message", { data: { type: "release", sessionId: f.id, generation: f.generation } });
  f.viewers.retire();
  expect(f.viewers.viewers.size).toBe(0);
  expect(f.received).toEqual([]);
});

it("ignores App menu shortcuts only for a controlling focused viewer and restores them on release or retirement", async () => {
  const f = await fixture(true);
  f.attach();
  const focus = () => f.port.emit("message", { data: { type: "input-focus", sessionId: f.id, generation: f.generation, enabled: true } });
  focus(); expect(f.menuShortcuts.at(-1)).toBe(false);
  f.reply({ type: "state", session: { ...f.session, state: "controlling" }, streamGeneration: 2, serverTime: Date.now(),
    lease: { id: "l".repeat(43), expiresAt: Date.now() + 6000, challenge: "c".repeat(43), challengeExpiresAt: Date.now() + 3000 } });
  await wait(() => f.port.messages.some((v: any) => v.type === "state"));
  focus(); expect(f.menuShortcuts.at(-1)).toBe(true);
  f.viewers.releaseAll(); expect(f.menuShortcuts.at(-1)).toBe(false);
  focus(); expect(f.menuShortcuts.at(-1)).toBe(false);
  f.reply({ type: "state", session: { ...f.session, state: "controlling" }, streamGeneration: 3, serverTime: Date.now(),
    lease: { id: "n".repeat(43), expiresAt: Date.now() + 6000, challenge: "d".repeat(43), challengeExpiresAt: Date.now() + 3000 } });
  await wait(() => f.port.messages.filter((v: any) => v.type === "state").length === 2);
  focus(); expect(f.menuShortcuts.at(-1)).toBe(true);
  f.viewers.retire(); expect(f.menuShortcuts.at(-1)).toBe(false);
});
