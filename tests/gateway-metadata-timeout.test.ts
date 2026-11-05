import { once } from "node:events";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { expect, it, vi } from "vitest";
import { GatewayTransport } from "../src/gateway/transport.js";

vi.mock("node:fs/promises", async original => {
  const native = await original<typeof import("node:fs/promises")>();
  return { ...native, readFile: vi.fn(native.readFile) };
});

it("uses last-known metadata if disk IO stalls and ignores its late result", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-metadata-timeout-"));
  const config = path.join(root, "config.json"); await fs.writeFile(config, JSON.stringify({ engine: "codex", model: "new" }));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
  let hello: any;
  server.on("connection", ws => ws.on("message", raw => { const frame = JSON.parse(raw.toString()); if (frame.type === "instance.hello") { hello = frame; ws.send(JSON.stringify({ v: 1, type: "instance.ready", capabilities: [] })); } }));
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let release!: (value: string) => void, first = true;
  const held = new Promise<string>(resolve => { release = resolve; });
  vi.mocked(fs.readFile).mockImplementation(((file: any, options: any) => {
    if (String(file) === config && first) { first = false; return held; }
    return original.readFile(file, options);
  }) as typeof fs.readFile);
  const warning = vi.fn(), boot = vi.fn(async () => {});
  const transport = new GatewayTransport({ stateDir: root, botId: "fixture", secret: "fixture", engine: "codex", model: "last-known", onWarning: warning, url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/instance` });
  transport.onBoot = boot;
  try {
    await transport.connect(); await vi.waitFor(() => expect(boot).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(warning).toHaveBeenCalledWith("gateway_metadata_read_timeout"); expect(hello.model).toBe("last-known");
    await transport.refreshStatus(); expect((transport as any).status.model).toBe("new");
    release(JSON.stringify({ engine: "codex", model: "stale" })); await new Promise<void>(resolve => setImmediate(resolve));
    expect((transport as any).status.model).toBe("new");
  } finally { release("{}"); await transport.disconnect(); vi.restoreAllMocks(); for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); }
});
