import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { expect, it, vi } from "vitest";
import { GatewayTransport } from "../src/gateway/transport.js";
import { HubServer } from "../src/hub/server.js";
import { hashSecret } from "../src/hub/auth.js";

it("the real Hub commits a reply only once after heartbeat recovery loses its acknowledgement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-real-ack-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
  const conversation = await hub.store.createConversation("owner", ["alpha"], "Fixture", "create");
  let release!: () => void, committed = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const publish = hub.store.publishBotMessage.bind(hub.store);
  const intercepted = vi.spyOn(hub.store, "publishBotMessage").mockImplementationOnce(async (...args) => { const result = await publish(...args); committed = true; await held; return result; });
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const transport = new GatewayTransport({ stateDir: path.join(root, "bot"), botId: "alpha", secret, url: hub.instanceUrl.replace("http", "ws") + "/instance" });
  const boot = vi.fn(async () => {}); transport.onBoot = boot;
  try {
    await transport.connect(); await vi.waitFor(() => expect(boot).toHaveBeenCalledTimes(1));
    const first = (hub as any).bots.get("alpha").ws as WebSocket;
    const pong = vi.spyOn(first, "pong").mockImplementation(() => {});
    const reply = transport.request("publish", { id: "final_reply", conversationId: conversation.id, status: "complete", version: 1, blocks: [{ type: "text", text: "Complete once" }] });
    await vi.waitFor(() => expect(committed).toBe(true));
    vi.advanceTimersByTime(30_000); await vi.waitFor(() => expect(pong).toHaveBeenCalledTimes(1));
    vi.advanceTimersByTime(30_000); await reply;
    expect((hub as any).bots.get("alpha").ws).not.toBe(first);
    expect((await hub.store.snapshot("owner", conversation.id)).messages.filter(message => message.id === "final_reply")).toHaveLength(1);
    expect(intercepted).toHaveBeenCalledTimes(2); expect(boot).toHaveBeenCalledTimes(1);
  } finally { release(); await transport.disconnect(); vi.useRealTimers(); vi.restoreAllMocks(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

it("starts recovery on the replacement socket when old replay is still waiting for disk IO", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-replay-generation-"));
  await writeFile(path.join(root, "gateway-outbox.json"), JSON.stringify({ requests: [
    { v: 1, type: "instance.request", id: "scope", method: "run.scope.write", params: {} },
    { v: 1, type: "instance.request", id: "reply", method: "publish", params: { text: "saved" } },
  ] }));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
  let connections = 0;
  server.on("connection", ws => {
    connections++;
    ws.on("message", raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "instance.hello") ws.send(JSON.stringify({ v: 1, type: "instance.ready", capabilities: [] }));
      else if (frame.type === "instance.request") ws.send(JSON.stringify({ v: 1, type: "instance.result", id: frame.id, result: null }));
    });
  });
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), writing = new Promise<void>(resolve => { started = resolve; });
  const transport = new GatewayTransport({ stateDir: root, botId: "bot", secret: "fixture", url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/instance` });
  const state = (transport as any).state, write = state.write.bind(state);
  vi.spyOn(state, "write").mockImplementationOnce(async value => { started(); await held; await write(value); });
  const boot = vi.fn(async () => {}); transport.onBoot = boot;
  try {
    await transport.connect(); await writing;
    for (const ws of server.clients) ws.terminate();
    await vi.waitFor(() => expect(connections).toBe(2));
    await vi.waitFor(() => expect(boot).toHaveBeenCalledTimes(1));
    release(); await vi.waitFor(() => expect(transport.isBusy()).toBe(false));
    expect(boot).toHaveBeenCalledTimes(1);
  } finally { release(); await transport.disconnect(); vi.restoreAllMocks(); for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

it.each(["reconnect", "closed", "stop"])("does not admit stale input after a boot barrier crosses %s", async phase => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-stale-input-"));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
  let connections = 0;
  const input = { v: 1, type: "instance.message", message: { id: "prompt", conversationId: "chat", authorId: "owner", authorType: "user", blocks: [{ type: "text", text: "Do this once" }], status: "complete", version: 1, createdAt: 1 }, conversation: { id: "chat", type: "direct", title: "Fixture", ownerId: "owner", botIds: ["bot"], archived: false, createdAt: 1 } };
  server.on("connection", ws => {
    connections++;
    ws.on("message", raw => {
      if (JSON.parse(raw.toString()).type === "instance.hello") {
        ws.send(JSON.stringify({ v: 1, type: "instance.ready", capabilities: [] }));
        ws.send(JSON.stringify(input));
      }
    });
  });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const transport = new GatewayTransport({ stateDir: root, botId: "bot", secret: "fixture", url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/instance` });
  const boot = vi.fn(() => held), invoke = vi.fn(async () => {}); transport.onBoot = boot; transport.onMessage = invoke;
  try {
    await transport.connect(); await vi.waitFor(() => expect((transport as any).receiving).toBe(1));
    if (phase === "reconnect") {
      for (const ws of server.clients) ws.terminate();
      await vi.waitFor(() => expect(connections).toBe(2));
      await vi.waitFor(() => expect((transport as any).receiving).toBe(2));
      release(); await vi.waitFor(() => expect((transport as any).receiving).toBe(0));
      expect(invoke).toHaveBeenCalledTimes(1);
    } else if (phase === "closed") {
      const closed = once((transport as any).ws, "close");
      for (const ws of server.clients) ws.terminate();
      await closed; release();
      await vi.waitFor(() => expect((transport as any).receiving).toBe(0));
      expect(invoke).not.toHaveBeenCalled();
    } else {
      const stopped = transport.disconnect(); release(); await stopped;
      await vi.waitFor(() => expect((transport as any).receiving).toBe(0));
      expect(invoke).not.toHaveBeenCalled();
    }
    expect(boot).toHaveBeenCalledTimes(1);
  } finally { release(); await transport.disconnect(); for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

it.each(["upgrade", "ready"])("reconnects when the Hub stalls during %s", async phase => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-handshake-"));
  const http = createServer(), server = new WebSocketServer({ noServer: true });
  const sockets = new Set<import("node:net").Socket>();
  let connections = 0;
  http.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  http.on("upgrade", (request, socket, head) => {
    connections++;
    if (phase === "upgrade" && connections === 1) return;
    server.handleUpgrade(request, socket, head, ws => {
      ws.on("message", raw => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === "instance.hello" && !(phase === "ready" && connections === 1)) ws.send(JSON.stringify({ v: 1, type: "instance.ready", capabilities: [] }));
      });
    });
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  // Keep real sockets/IO. The HTTP upgrade exercises Node's actual deadline;
  // only shorten the application-ready deadline for the second scenario.
  const timeout = globalThis.setTimeout;
  const clock = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: any[]) => void, ms?: number, ...args: any[]) => timeout(fn, ms === 15_000 ? 80 : ms, ...args)) as typeof setTimeout);
  const transport = new GatewayTransport({ stateDir: root, botId: "bot", secret: "fixture", url: `ws://127.0.0.1:${(http.address() as { port: number }).port}/instance` });
  const boot = vi.fn(async () => {}); transport.onBoot = boot;
  try {
    await transport.connect();
    await vi.waitFor(() => expect(boot).toHaveBeenCalledTimes(1), { timeout: phase === "upgrade" ? 12_000 : 2_000 });
    expect(connections).toBe(2);
  } finally {
    clock.mockRestore(); await transport.disconnect();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

it("recovers a silent connection by replaying the same durable publication id", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-heartbeat-"));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, autoPong: false }); await once(server, "listening");
  let connections = 0, pings = 0;
  const received: string[] = [], committed = new Set<string>();
  server.on("connection", ws => {
    const index = ++connections;
    ws.on("ping", data => { pings++; if (index > 1) ws.pong(data); });
    ws.on("message", raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "instance.hello") ws.send(JSON.stringify({ v: 1, type: "instance.ready", capabilities: [] }));
      else if (frame.type === "instance.request") {
        received.push(frame.id); committed.add(frame.id);
        // The first response is lost after the Hub commits it.
        if (index > 1) ws.send(JSON.stringify({ v: 1, type: "instance.result", id: frame.id, result: "saved" }));
      }
    });
  });
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const warning = vi.fn(), boot = vi.fn(async () => {});
  const transport = new GatewayTransport({ stateDir: root, botId: "bot", secret: "fixture", onWarning: warning, url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/instance` });
  transport.onBoot = boot;
  try {
    await transport.connect(); await vi.waitFor(() => expect(boot).toHaveBeenCalledTimes(1));
    const publication = transport.request("publish", { text: "final answer" });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    vi.advanceTimersByTime(30_000); await vi.waitFor(() => expect(pings).toBe(1));
    expect(connections).toBe(1);
    vi.advanceTimersByTime(30_000);
    await expect(publication).resolves.toBe("saved");
    expect(warning).toHaveBeenCalledWith("gateway_heartbeat_timeout");
    expect(connections).toBe(2); expect(boot).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(2); expect(received[0]).toBe(received[1]); expect(committed.size).toBe(1);
    expect(JSON.parse(await readFile(path.join(root, "gateway-outbox.json"), "utf8")).requests).toEqual([]);
  } finally { await transport.disconnect(); vi.useRealTimers(); for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

it("keeps a responsive connection while boot work and metadata IO are still pending", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-heartbeat-busy-"));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
  let connections = 0, pings = 0;
  server.on("connection", ws => {
    connections++;
    ws.on("ping", () => pings++);
    ws.on("message", raw => { if (JSON.parse(raw.toString()).type === "instance.hello") ws.send(JSON.stringify({ v: 1, type: "instance.ready", capabilities: [] })); });
  });
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const transport = new GatewayTransport({ stateDir: root, botId: "bot", secret: "fixture", url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/instance` });
  const boot = vi.fn(() => held); transport.onBoot = boot;
  try {
    await transport.connect(); await vi.waitFor(() => expect(boot).toHaveBeenCalledTimes(1));
    vi.spyOn(transport as any, "readStatus").mockImplementation(() => held);
    const socket = (transport as any).ws as WebSocket;
    for (let i = 1; i <= 4; i++) {
      const pong = once(socket, "pong"); vi.advanceTimersByTime(30_000); await pong;
      expect(pings).toBe(i); expect(connections).toBe(1);
    }
    expect(transport.isBusy()).toBe(true); expect(boot).toHaveBeenCalledTimes(1);
  } finally { release(); await transport.disconnect(); vi.restoreAllMocks(); vi.useRealTimers(); for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

it("does not retain a phantom boot blocker when reusing a stopped transport", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-reuse-idle-"));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
  server.on("connection", ws => ws.on("message", raw => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "instance.hello") ws.send(JSON.stringify({ v: 1, type: "instance.ready", capabilities: [] }));
    else if (frame.type === "instance.request") ws.send(JSON.stringify({ v: 1, type: "instance.result", id: frame.id, result: null }));
  }));
  const transport = new GatewayTransport({ stateDir: root, botId: "bot", secret: "fixture", url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/instance` });
  const boot = vi.fn(async () => {}); transport.onBoot = boot;
  try {
    for (let i = 0; i < 2; i++) {
      await transport.connect(); await transport.request("conversation", { conversationId: "fixture" });
      await vi.waitFor(() => expect(transport.isBusy()).toBe(false)); await transport.disconnect();
    }
    expect(boot).toHaveBeenCalledTimes(1);
  } finally { await transport.disconnect(); for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
