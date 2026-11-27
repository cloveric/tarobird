import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { CANVAS_AGENT_HOST_CAPABILITY } from "../src/client-protocol/infinite-canvas.js";
import { createAppPlatformTools } from "../src/gateway/app-tools.js";
import { GatewayChannel } from "../src/gateway/channel.js";
import { GatewayReceipts } from "../src/gateway/receipts.js";
import { GatewayTransport } from "../src/gateway/transport.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// A fake Hub that answers instance.hello with the given capabilities and records every frame.
async function connect(capabilities: string[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-canvas-capability-"));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
  const frames: { type: string; method?: string }[] = [];
  server.on("connection", ws => ws.on("message", raw => {
    const frame = JSON.parse(raw.toString()); frames.push(frame);
    if (frame.type === "instance.hello") ws.send(JSON.stringify({ v: 1, type: "instance.ready", capabilities }));
  }));
  const transport = new GatewayTransport({ stateDir: root, botId: "fixture", secret: "fixture", engine: "codex", url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/instance` });
  const channel = new GatewayChannel(transport);
  cleanups.push(async () => {
    await transport.disconnect();
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await transport.connect();
  await vi.waitFor(() => expect((transport as unknown as { ready: boolean }).ready).toBe(true), { timeout: 4000 });
  const tools = createAppPlatformTools({ channel, stateDir: root, conversationId: "chat_fixture", receipts: new GatewayReceipts(root), signal: new AbortController().signal });
  return { transport, channel, frames, names: tools.definitions.map(tool => tool.name) };
}

it("offers no canvas agent tool and sends no canvas.agent.* request to a Host that does not announce it", async () => {
  const { transport, channel, frames, names } = await connect([]);
  expect(channel.supportsCanvasAgent()).toBe(false);
  expect(names).not.toContain("app_canvas_agent");
  await expect(transport.requestLive("canvas.agent.call", { conversationId: "chat_fixture", contextMessageId: "m", name: "canvas_get_state", arguments: {} })).rejects.toThrow("canvas_agent_unsupported");
  await expect(transport.requestLive("canvas.agent.tools", { conversationId: "chat_fixture", contextMessageId: "m" })).rejects.toThrow("canvas_agent_unsupported");
  await expect(transport.request("canvas.agent.status", { conversationId: "chat_fixture" })).rejects.toThrow("canvas_agent_requires_live_request");
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(frames.filter(frame => frame.type === "instance.request" && frame.method?.startsWith("canvas.agent."))).toEqual([]);
});

it("offers the canvas agent tool when the Host announces it", async () => {
  const { channel, names } = await connect([CANVAS_AGENT_HOST_CAPABILITY]);
  expect(channel.supportsCanvasAgent()).toBe(true);
  expect(names).toContain("app_canvas_agent");
});
