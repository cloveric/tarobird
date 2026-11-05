import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { delegateToInstance } from "../src/bus/bus-client.js";
import { registerInstance } from "../src/bus/bus-registry.js";

async function fixture(talk: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bus-deadline-"));
  const stateDir = path.join(root, "caller"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ bus: { peers: ["peer"], secret: "test-only" } }));
  let requests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/api/health") { res.end(JSON.stringify({ kind: "cc-telegram-bridge", instance: "peer", status: "ok" })); return; }
    requests++; req.resume(); talk(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  await registerInstance(root, "peer", (server.address() as import("node:net").AddressInfo).port, "test-only");
  return {
    input: { fromInstance: "caller", targetInstance: "peer", prompt: "work", stateDir, depth: 0, timeoutMs: 500 },
    requests: () => requests,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); },
  };
}

it("waits for delayed response headers within the configured turn deadline", async () => {
  const f = await fixture((_req, res) => {
    const timer = setTimeout(() => res.end(JSON.stringify({ success: true, text: "complete", fromInstance: "peer" })), 120);
    res.once("close", () => clearTimeout(timer));
  });
  try { await expect(delegateToInstance(f.input)).resolves.toMatchObject({ success: true, text: "complete" }); expect(f.requests()).toBe(1); }
  finally { await f.close(); }
});

it.each([false, true])("classifies the absolute deadline correctly afterHeaders=%s and never resends", async (afterHeaders) => {
  const f = await fixture((_req, res) => { if (afterHeaders) { res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"success":'); } });
  try { await expect(delegateToInstance({ ...f.input, timeoutMs: 40 })).rejects.toMatchObject({ code: "timeout", retryable: false }); expect(f.requests()).toBe(1); }
  finally { await f.close(); }
});

it("preserves user cancellation while reading a partially received response", async () => {
  const abort = new AbortController();
  const f = await fixture((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"success":');
    const timer = setTimeout(() => abort.abort(), 35); res.once("close", () => clearTimeout(timer));
  });
  try { await expect(delegateToInstance({ ...f.input, abortSignal: abort.signal })).rejects.toMatchObject({ code: "cancelled", retryable: false }); expect(f.requests()).toBe(1); }
  finally { await f.close(); }
});

it("preserves cancellation while the health lookup fails, without sending a task", async () => {
  const abort = new AbortController();
  const f = await fixture((_req, res) => res.end("must not execute"));
  const health = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => { abort.abort(); throw new TypeError("health check failed"); });
  try { await expect(delegateToInstance({ ...f.input, abortSignal: abort.signal })).rejects.toMatchObject({ code: "cancelled", retryable: false }); expect(f.requests()).toBe(0); }
  finally { health.mockRestore(); await f.close(); }
});

it("does not report an accepted but reset turn as an unreachable service or retry it", async () => {
  const f = await fixture((_req, res) => res.destroy());
  try { await expect(delegateToInstance(f.input)).rejects.toMatchObject({ code: "connection_lost", retryable: false }); expect(f.requests()).toBe(1); }
  finally { await f.close(); }
});

it("does not label a malformed completed response as safe to retry", async () => {
  const f = await fixture((_req, res) => res.end("not-json"));
  try { await expect(delegateToInstance(f.input)).rejects.toMatchObject({ code: "invalid_response", retryable: false }); expect(f.requests()).toBe(1); }
  finally { await f.close(); }
});

it("bounds an oversized declared response before buffering it", async () => {
  const f = await fixture((_req, res) => { res.writeHead(200, { "Content-Type": "application/json", "Content-Length": 32 * 1024 * 1024 }); res.flushHeaders(); });
  try { await expect(delegateToInstance(f.input)).rejects.toMatchObject({ code: "response_too_large", retryable: false }); expect(f.requests()).toBe(1); }
  finally { await f.close(); }
});

it("caps chunked responses too, without relying on Content-Length", async () => {
  const f = await fixture((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(Buffer.alloc(16 * 1024 * 1024 + 1)); });
  try { await expect(delegateToInstance({ ...f.input, timeoutMs: 3000 })).rejects.toMatchObject({ code: "response_too_large", retryable: false }); expect(f.requests()).toBe(1); }
  finally { await f.close(); }
});

it.each([404, 408, 500])("rejects HTTP %i without treating a success-shaped body as success", async status => {
  const f = await fixture((_req, res) => { res.writeHead(status); res.end(JSON.stringify({ success: true, text: "not a successful request", fromInstance: "peer" })); });
  try { await expect(delegateToInstance(f.input)).rejects.toMatchObject({ code: "invalid_response", retryable: false }); expect(f.requests()).toBe(1); }
  finally { await f.close(); }
});

it("decodes a multi-byte response split across HTTP chunks without corruption", async () => {
  const body = Buffer.from(JSON.stringify({ success: true, text: "中文🙂", fromInstance: "peer" }));
  const split = body.indexOf(Buffer.from("文")) + 1;
  const f = await fixture((_req, res) => { res.write(body.subarray(0, split)); res.end(body.subarray(split)); });
  try { await expect(delegateToInstance(f.input)).resolves.toMatchObject({ text: "中文🙂" }); }
  finally { await f.close(); }
});

// Opt-in wall-clock regression for Node's former 300s fetch timeout. Fast tests
// above cover deadline/abort/error edges; this proves real long turns survive.
it.skipIf(process.env.TAROBOT_BUS_LONG_HTTP_TEST !== "1").concurrent.each([false, true])("waits beyond five minutes afterHeaders=%s", async afterHeaders => {
  const body = JSON.stringify({ success: true, text: "long turn complete", fromInstance: "peer" });
  const f = await fixture((_req, res) => {
    if (afterHeaders) res.write(body.slice(0, 5));
    const timer = setTimeout(() => res.end(afterHeaders ? body.slice(5) : body), 305_000);
    res.once("close", () => clearTimeout(timer));
  });
  try { await expect(delegateToInstance({ ...f.input, timeoutMs: 320_000 })).resolves.toMatchObject({ text: "long turn complete" }); expect(f.requests()).toBe(1); }
  finally { await f.close(); }
}, 330_000);
