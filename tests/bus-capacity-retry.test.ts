import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { delegateToInstance } from "../src/bus/bus-client.js";
import { registerInstance } from "../src/bus/bus-registry.js";
import { createBusServer, startBusServer, stopBusServer, MAX_CONCURRENT_BUS_TALKS } from "../src/bus/bus-server.js";

const setup = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bus-capacity-")), stateDir = path.join(root, "source"), targetDir = path.join(root, "target");
  await mkdir(stateDir); await mkdir(targetDir);
  const config = (peers: string[]) => writeFile(path.join(stateDir, "config.json"), JSON.stringify({ bus: { peers } }));
  await config(["target"]); await writeFile(path.join(targetDir, "config.json"), JSON.stringify({ bus: { peers: "*", secret: "fixture" } }));
  return { root, stateDir, targetDir, config, args: { fromInstance: "source", targetInstance: "target", stateDir, prompt: "task", depth: 0, timeoutMs: 5000 } };
};
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));

it("waits for real Bus capacity, then executes the overflow task exactly once", async () => {
  const f = await setup(); let release!: () => void, rejected = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const handler = vi.fn(async () => { await held; return { success: true, text: "ok", fromInstance: "target" }; });
  const server = createBusServer("target", f.targetDir, handler);
  const port = await startBusServer(server, 0);
  server.on("request", (_req, response) => response.on("finish", () => { if (response.statusCode === 503) { rejected++; release(); } }));
  const send = () => fetch(`http://127.0.0.1:${port}/api/talk`, { method: "POST", headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" }, body: JSON.stringify({ fromInstance: "source", prompt: "held", depth: 0 }) }).then(response => response.json());
  const active = Array.from({ length: MAX_CONCURRENT_BUS_TALKS }, send);
  try {
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(MAX_CONCURRENT_BUS_TALKS));
    await registerInstance(f.root, "target", port, "fixture");
    expect(await delegateToInstance(f.args)).toMatchObject({ success: true, text: "ok" });
    expect(rejected).toBe(1); expect(handler).toHaveBeenCalledTimes(MAX_CONCURRENT_BUS_TALKS + 1);
  } finally { release(); await Promise.allSettled(active); await stopBusServer(server); await rm(f.root, { recursive: true, force: true }); }
});

for (const scenario of ["busy", "cancel", "timeout", "revoke", "disabled", "already-executed", "unretryable", "unknown-error", "wrong-peer"] as const) it(`bounds capacity retries and preserves ${scenario} semantics`, async () => {
  const f = await setup(), controller = new AbortController(); let requests = 0;
  const server = createServer(async (request, response) => {
    if (request.url === "/api/health") { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ kind: "cc-telegram-bridge", instance: "target", pid: process.pid, status: "ok" })); return; }
    requests++;
    if (scenario === "revoke") await f.config(["another-peer"]);
    if (scenario === "disabled") await writeFile(path.join(f.stateDir, "config.json"), "{}");
    response.writeHead(scenario === "already-executed" ? 200 : 503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: false, fromInstance: scenario === "wrong-peer" ? "other" : "target", error: "busy", errorCode: scenario === "unknown-error" ? "internal_error" : "server_busy", retryable: scenario !== "unretryable", protocolVersion: 1 }));
    if (scenario === "cancel") controller.abort();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await registerInstance(f.root, "target", port, "");
    const code = ({ cancel: "cancelled", timeout: "timeout", revoke: "peer_not_allowed", disabled: "bus_disabled", "unknown-error": "internal_error" } as Record<string, string>)[scenario] ?? "server_busy";
    await expect(delegateToInstance({ ...f.args, abortSignal: controller.signal, timeoutMs: scenario === "timeout" ? 100 : 5000 })).rejects.toMatchObject({ code });
    expect(requests).toBe(scenario === "busy" ? 4 : 1);
  } finally { await close(server); await rm(f.root, { recursive: true, force: true }); }
});
