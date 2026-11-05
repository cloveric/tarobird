import http from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { watchScreenSocket, SCREEN_PING_INTERVAL_MS } from "../src/core/screen-heartbeat.js";
import { RemoteScreenSockets } from "../src/hub/remote-screen-sockets.js";
import type { HubRemoteScreen } from "../src/hub/remote-screen.js";
// @ts-expect-error Electron JavaScript module
import { openScreenSocket, screenRoute } from "../client/electron/screen-network.mjs";

// Real loopback WebSockets; advance only heartbeat intervals, leaving network IO real.
const cleanups: (() => void | Promise<void>)[] = [];
const settle = () => new Promise(resolve => setTimeout(resolve, 15));
const tick = async () => { vi.advanceTimersByTime(SCREEN_PING_INTERVAL_MS); await settle(); };
beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }));
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.useRealTimers(); });
async function pair(autoPong: boolean) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1", autoPong });
  await once(server, "listening");
  cleanups.push(() => new Promise<void>(resolve => { for (const ws of server.clients) ws.terminate(); server.close(() => resolve()); }));
  const connected = once(server, "connection");
  const client = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}`);
  cleanups.push(() => client.terminate());
  const [peer] = await connected as [WebSocket]; await once(client, "open");
  return { client, peer };
}
it("keeps quiet paused channels alive on matched pongs and removes timers/listeners on close", async () => {
  const { client } = await pair(true), timeout = vi.fn();
  watchScreenSocket(client, timeout);
  for (let i = 0; i < 7; i++) await tick();
  expect(timeout).not.toHaveBeenCalled();
  const closed = once(client, "close"); client.terminate(); await closed;
  expect(vi.getTimerCount()).toBe(0); expect(client.listenerCount("pong")).toBe(0);
});
it("unrelated pongs and ordinary traffic cannot keep a nonresponding channel alive", async () => {
  const { client, peer } = await pair(false), timeout = vi.fn(() => client.terminate());
  peer.on("ping", () => { peer.pong("wrong"); peer.send("still sending"); });
  watchScreenSocket(client, timeout);
  await tick(); await tick(); expect(timeout).not.toHaveBeenCalled(); await tick();
  expect(timeout).toHaveBeenCalledTimes(1); expect(client.readyState).toBe(WebSocket.CLOSED);
  expect(vi.getTimerCount()).toBe(0);
});
it("Electron transport reports a bounded network timeout when a Host stops responding", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1", autoPong: false });
  await once(server, "listening"); cleanups.push(() => new Promise<void>(resolve => { for (const ws of server.clients) ws.terminate(); server.close(() => resolve()); }));
  server.on("connection", ws => ws.once("message", () => ws.send(JSON.stringify({ type: "attached", sessionId: "session" }))));
  const close = vi.fn(), client = openScreenSocket(screenRoute({ url: `http://127.0.0.1:${(server.address() as any).port}`, publicKey: "a".repeat(59) + "=" }), undefined, "control", "c".repeat(43), { close });
  cleanups.push(() => client.terminate()); await once(client, "open"); await settle();
  await tick(); await tick(); await tick();
  expect(close).toHaveBeenCalledWith("screen_network_timeout", 1006); expect(vi.getTimerCount()).toBe(0);
});
it("Host retires the session and both channels if one paused viewer channel loses pong responses", async () => {
  const closeSession = vi.fn(), sockets = new RemoteScreenSockets({ attachViewer: async () => "session", closeSession } as unknown as HubRemoteScreen);
  const server = http.createServer(); server.on("upgrade", (req, client, head) => sockets.upgrade(req, client, head, false));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => { sockets.dispose(); server.close(() => resolve()); }));
  const clients = await Promise.all(["control", "media"].map(async role => {
    const client = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/screen/v1/${role}`, { autoPong: role === "media" });
    cleanups.push(() => client.terminate()); await once(client, "open");
    const attached = once(client, "message"); client.send(JSON.stringify({ type: "hello", ticket: "a".repeat(43) })); await attached; return client;
  }));
  await tick(); await tick(); expect(closeSession).not.toHaveBeenCalled(); await tick();
  expect(closeSession).toHaveBeenCalledWith("session", "screen_network_timeout");
  expect(clients.every(ws => ws.readyState === WebSocket.CLOSED)).toBe(true); expect(vi.getTimerCount()).toBe(0);
});

it("a responding Host without an attached receipt cannot leave the viewer connecting forever", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening"); cleanups.push(() => new Promise<void>(resolve => { for (const ws of server.clients) ws.terminate(); server.close(() => resolve()); }));
  const close = vi.fn(), client = openScreenSocket(screenRoute({ url: `http://127.0.0.1:${(server.address() as any).port}`, publicKey: "a".repeat(59) + "=" }), undefined, "media", "m".repeat(43), { close });
  cleanups.push(() => client.terminate()); await once(client, "open");
  await tick(); // The Host responds to WS ping but never completes the App handshake.
  await once(client, "close");
  expect(close).toHaveBeenCalledWith("screen_connect_timeout", 1006); expect(vi.getTimerCount()).toBe(0);
}, 8000);
