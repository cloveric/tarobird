import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { HubStore } from "../src/hub/store.js";
import { RouteMonitor, routeMonitorSchema, type RouteAlert } from "../src/hub/route-monitor.js";
import { desktopTls } from "../src/hub/desktop-tls.js";
it("alerts after five minutes, retries the Feishu path independently, survives restart and resets after recovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "route-monitor-")); const store = await HubStore.open(root);
  try {
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','unused')"); const conversation = await store.createConversation("owner", ["alpha"], "Route alerts", "routes");
    const config = routeMonitorSchema.parse({ routes: [{ name: "Tailscale", url: "https://mac.test" }, { name: "VPS", url: "https://relay.test" }], botId: "alpha", conversationId: conversation.id });
    let now = 1000; let online = false; const probe = vi.fn(async (url: string) => url.includes("relay") || online); const notify = vi.fn(async () => { throw new Error("bot_offline"); });
    let monitor = new RouteMonitor(store, config, "fixture", notify, probe, () => now);
    await monitor.tick(); now += 299_999; await monitor.tick(); expect(notify).not.toHaveBeenCalled(); expect((await store.snapshot("owner", conversation.id)).messages).toHaveLength(0);
    now++; await monitor.tick(); expect(notify).toHaveBeenCalledTimes(1); expect((await store.snapshot("owner", conversation.id)).messages).toHaveLength(1);
    await monitor.stop(); const receipt = vi.fn(async (_botId: string, _alert: RouteAlert) => undefined); monitor = new RouteMonitor(store, config, "fixture", receipt, probe, () => now);
    await monitor.tick(); await monitor.tick(); expect(receipt).toHaveBeenCalledTimes(1); expect((await store.snapshot("owner", conversation.id)).messages).toHaveLength(1);
    online = true; await monitor.tick(); online = false; now += 20_000; await monitor.tick(); now += 300_000; await monitor.tick(); expect(receipt).toHaveBeenCalledTimes(2); expect((await store.snapshot("owner", conversation.id)).messages).toHaveLength(2);
    expect(receipt.mock.calls[0]?.[1]).toMatchObject({ route: "Tailscale", since: 1000 }); await monitor.stop();
  } finally { await store.db.close(); await rm(root, { recursive: true, force: true }); }
});
it("rejects ambiguous, credential-bearing and public plaintext monitor routes", () => {
  for (const url of ["http://remote.test", "https://user:secret@host.test", "https://host.test/path", "https://host.test?token=secret"]) expect(routeMonitorSchema.safeParse({ routes: [{ name: "VPS", url }], botId: "alpha", conversationId: "conversation" }).success).toBe(false);
});

it("tracks simultaneous VPS outages separately and retains their names in alerts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "multi-route-alert-")), store = await HubStore.open(root);
  try {
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','unused')"); const group = await store.createConversation("owner", ["alpha"], "Routes", "multi");
    const config = routeMonitorSchema.parse({ routes: [{ name: "VPS", label: "主站", url: "https://primary.test" }, { name: "VPS", label: "备站", url: "https://backup.test" }], botId: "alpha", conversationId: group.id });
    let now = 1000; const receipt = vi.fn(async (_id: string, _alert: RouteAlert) => undefined), monitor = new RouteMonitor(store, config, "key", receipt, async () => false, () => now);
    await monitor.tick(); now += 300000; await monitor.tick(); await monitor.tick(); await monitor.stop();
    expect(receipt.mock.calls.map((call) => call[1].label)).toEqual(["主站", "备站"]); expect(new Set(receipt.mock.calls.map((call) => call[1].id)).size).toBe(2);
    expect((await store.snapshot("owner", group.id)).messages).toHaveLength(2);
  } finally { await store.db.close(); await rm(root, { recursive: true, force: true }); }
});

it("trusts a route CA while rejecting wrong certificates, names, Hub keys and invalid health responses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "route-monitor-tls-")), store = await HubStore.open(path.join(root, "hub"));
  const tls = await desktopTls(path.join(root, "good"), ["127.0.0.1"]);
  const wrong = await desktopTls(path.join(root, "other"), ["127.0.0.2"]);
  let mode = "healthy", hits = 0;
  const server = createServer({ key: await readFile(tls.key), cert: await readFile(tls.cert) }, (req, res) => {
    hits++;
    if (req.url !== "/health") { res.writeHead(404); res.end(); return; }
    if (mode === "redirect") { res.writeHead(302, { location: "/other" }); res.end(); }
    else if (mode === "oversize") res.end(JSON.stringify({ ok: true, publicKey: "hub-key", padding: "x".repeat(65 * 1024) }));
    else if (mode === "invalid-json") res.end("not json");
    else res.end(JSON.stringify({ ok: true, publicKey: mode === "wrong-key" ? "other-hub" : "hub-key" }));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','unused')");
    const conversation = await store.createConversation("owner", ["alpha"], "TLS alerts", "tls");
    for (const scenario of ["healthy", "missing-ca", "wrong-ca", "invalid-ca", "wrong-name", "wrong-key", "redirect", "oversize", "invalid-json"]) {
      mode = scenario;
      server.setSecureContext({ key: await readFile(scenario === "wrong-name" ? wrong.key : tls.key), cert: await readFile(scenario === "wrong-name" ? wrong.cert : tls.cert) });
      const ca = scenario === "missing-ca" ? undefined : scenario === "wrong-ca" || scenario === "wrong-name" ? wrong.certificateAuthority : scenario === "invalid-ca" ? "A".repeat(100) : tls.certificateAuthority;
      const config = routeMonitorSchema.parse({ routes: [{ name: "Direct", url, ...(ca ? { certificateAuthority: ca } : {}) }], botId: "alpha", conversationId: conversation.id });
      await store.db.run("DELETE FROM meta WHERE key='route_monitor'");
      let now = 1000;
      const notify = vi.fn(async (_id: string, _alert: RouteAlert) => undefined);
      const monitor = new RouteMonitor(store, config, "hub-key", notify, undefined, () => now);
      const before = hits;
      await monitor.tick(); now += 300000; await monitor.tick(); await monitor.stop();
      expect(notify.mock.calls.length, scenario).toBe(scenario === "healthy" ? 0 : 1);
      if (scenario === "redirect") expect(hits - before).toBe(2);
    }
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await store.db.close(); await rm(root, { recursive: true, force: true });
  }
});


it("preserves loopback HTTP routes with an unused CA field from manual configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "route-monitor-http-")), store = await HubStore.open(root);
  const server = createHttpServer((_req, res) => res.end(JSON.stringify({ ok: true, publicKey: "hub-key" })));
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','unused')");
    const conversation = await store.createConversation("owner", ["alpha"], "HTTP alerts", "http");
    const config = routeMonitorSchema.parse({ routes: [{ name: "Direct", url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, certificateAuthority: "A".repeat(100) }], botId: "alpha", conversationId: conversation.id });
    let now = 1000;
    const notify = vi.fn(async (_id: string, _alert: RouteAlert) => undefined), monitor = new RouteMonitor(store, config, "hub-key", notify, undefined, () => now);
    await monitor.tick(); now += 300000; await monitor.tick(); await monitor.stop();
    expect(notify).not.toHaveBeenCalled();
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await store.db.close(); await rm(root, { recursive: true, force: true });
  }
});
