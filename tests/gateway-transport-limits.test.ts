import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { expect, it, vi } from "vitest";
import { GatewayTransport } from "../src/gateway/transport.js";
import { MAX_FRAME_BYTES } from "../src/client-protocol/index.js";

it("rejects new oversized requests before journaling when the Hub cannot receive fragments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-old-hub-"));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const requests: string[] = [];
  server.on("connection", ws => ws.on("message", raw => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "instance.hello") ws.send(JSON.stringify({ v: 1, type: "instance.ready", capabilities: [] }));
    else if (frame.type === "instance.request") { requests.push(frame.method); ws.send(JSON.stringify({ v: 1, type: "instance.result", id: frame.id, result: null })); }
  }));
  const warning = vi.fn();
  const transport = new GatewayTransport({ stateDir: root, botId: "bot", secret: "fixture", onWarning: warning, url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/instance` });
  let ready = false;
  transport.onBoot = async () => { ready = true; };
  try {
    await transport.connect();
    await vi.waitFor(() => expect(ready).toBe(true));
    expect(transport.capabilities).toEqual([]);
    for (let i = 0; i < 4; i++) await expect(transport.request("publish", { text: "x".repeat(MAX_FRAME_BYTES) })).rejects.toThrow("hub_update_required");
    await transport.request("conversation", { conversationId: "fixture" });
    expect(requests).toEqual(["conversation"]);
    expect(warning).toHaveBeenCalledTimes(4);
    expect(warning).toHaveBeenCalledWith("hub_update_required");
    expect(JSON.parse(await readFile(path.join(root, "gateway-outbox.json"), "utf8")).requests.length).toBe(0);
    await vi.waitFor(() => expect(transport.isBusy()).toBe(false));
  } finally { await transport.disconnect(); for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

it("preserves an already durable large request when reconnecting to an older Hub", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-old-hub-replay-"));
  const request = { v: 1, type: "instance.request", id: "saved", method: "publish", params: { text: "saved answer".repeat(MAX_FRAME_BYTES / 10) } };
  await writeFile(path.join(root, "gateway-outbox.json"), JSON.stringify({ requests: [request] }));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
  server.on("connection", ws => ws.on("message", raw => { if (JSON.parse(raw.toString()).type === "instance.hello") ws.send(JSON.stringify({ v: 1, type: "instance.ready", capabilities: [] })); }));
  const warning = vi.fn();
  const transport = new GatewayTransport({ stateDir: root, botId: "bot", secret: "fixture", onWarning: warning, url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/instance` });
  try {
    await transport.connect(); await vi.waitFor(() => expect(warning).toHaveBeenCalledWith("hub_update_required"));
    const saved = JSON.parse(await readFile(path.join(root, "gateway-outbox.json"), "utf8")).requests;
    expect(saved).toHaveLength(1); expect(saved[0].id).toBe(request.id);
    expect(saved[0].params.text === request.params.text).toBe(true);
    expect(transport.isBusy()).toBe(true); // Honest unresolved delivery, not a fabricated acknowledgement.
  } finally { await transport.disconnect(); for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

it("writes a request once when ready/replay overlaps its persistence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-persist-ready-"));
  const transport = new GatewayTransport({ stateDir: root, botId: "fixture", secret: "fixture", url: "ws://127.0.0.1:9/instance" });
  const internal = transport as any, frames: any[] = [];
  let release!: () => void, started!: () => void;
  const persisted = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  internal.state = { write: async () => { started(); await gate; } };
  internal.ws = { readyState: 1, send: (raw: string, done: () => void) => { frames.push(JSON.parse(raw)); done(); }, terminate: () => {} };
  try {
    const pending = transport.request("reaction", { conversationId: "fixture" });
    await persisted; await internal.receive({ v: 1, type: "instance.ready", capabilities: [] }); release();
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    await internal.receive({ v: 1, type: "instance.result", id: frames[0].id, result: null });
    await pending; expect(frames).toHaveLength(1);
  } finally { release(); await transport.disconnect(); await rm(root, { recursive: true, force: true }); }
});

it("waits for a replacement replay before sending a request released from the old replay", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-replay-order-"));
  const transport = new GatewayTransport({ stateDir: root, botId: "fixture", secret: "fixture", url: "ws://127.0.0.1:9/instance" });
  const internal = transport as any, frames: any[] = [];
  let releaseOld!: () => void, releaseNew!: () => void;
  internal.replay = new Promise<void>(resolve => { releaseOld = resolve; });
  internal.state = { write: async () => {} };
  const ws = { readyState: 1, send: (raw: string, done: () => void) => { frames.push(JSON.parse(raw)); done(); }, terminate: () => {} };
  internal.ws = ws; internal.ready = true; internal.replayed.set(ws, new Set());
  try {
    const pending = transport.request("publish", { text: "new" });
    await new Promise<void>(resolve => setImmediate(resolve));
    internal.replay = new Promise<void>(resolve => { releaseNew = resolve; });
    releaseOld(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(frames).toEqual([]);
    const request = internal.journal[0];
    frames.push({ id: "older" }, request); internal.replayed.get(ws).add(request.id);
    releaseNew(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(frames.map(frame => frame.id)).toEqual(["older", request.id]);
    await internal.receive({ v: 1, type: "instance.result", id: request.id, result: null }); await pending;
  } finally { releaseOld(); releaseNew?.(); await transport.disconnect(); await rm(root, { recursive: true, force: true }); }
});

it("does not persist or replay a live workbench command after its socket closes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-workbench-live-"));
  const server = new WebSocketServer({host:"127.0.0.1",port:0}); await once(server,"listening");
  const seen:string[]=[]; let connections=0;
  server.on("connection",ws=>{connections++; ws.on("message",raw=>{const frame=JSON.parse(raw.toString());if(frame.type==="instance.hello")ws.send(JSON.stringify({v:1,type:"instance.ready",capabilities:["workbench.v1"]}));if(frame.method==="workbench.command"){seen.push(frame.id);ws.terminate();}});});
  const transport=new GatewayTransport({stateDir:root,botId:"bot",secret:"fixture",url:`ws://127.0.0.1:${(server.address() as {port:number}).port}/instance`});
  let ready=false;transport.onBoot=async()=>{ready=true;};
  try {await transport.connect();await vi.waitFor(()=>expect(ready).toBe(true));await expect(transport.requestLive("workbench.command",{requestId:"live"})).rejects.toThrow("gateway_disconnected");await vi.waitFor(()=>expect(connections).toBeGreaterThan(1));expect(seen).toHaveLength(1);const journal=await readFile(path.join(root,"gateway-outbox.json"),"utf8").catch(()=>'{"requests":[]}');expect(JSON.parse(journal).requests).toEqual([]);}
  finally {await transport.disconnect();for(const ws of server.clients)ws.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
