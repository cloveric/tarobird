import { test, expect } from "@playwright/test";
import { generateKeyPairSync } from "node:crypto";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
import type { HostRegistry } from "../src/host-registry.js";
import type { HubConnection } from "../src/connection.js";
import type { NetworkSync } from "../src/network-sync.js";
import type { HostConnections } from "../src/host-connections.js";

const key = () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
const hubKey = key(), deviceKey = key(), CA = "A".repeat(120);
const lan = { name: "Direct" as const, url: "https://192.0.2.10:8443", certificateAuthority: CA };
const tail = { name: "Tailscale" as const, url: "https://100.64.0.7:8443", certificateAuthority: CA };
const relay = { name: "VPS" as const, url: "https://relay.example" };
type Fixture = { HostRegistry: typeof HostRegistry; HubConnection: typeof HubConnection; NetworkSync: typeof NetworkSync };
const html = `<!doctype html><html><body><script type="module">
import {HostRegistry} from '/src/host-registry.ts'; import {HubConnection} from '/src/connection.ts'; import {NetworkSync} from '/src/network-sync.ts';
window.hostRouteSyncFixture={HostRegistry,HubConnection,NetworkSync};
</script></body></html>`;
let server: ViteDevServer, url: string;
test.beforeAll(async () => {
  server = await createServer({ plugins: [{ name: "host-route-sync-fixture", configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => { if (req.url !== "/__host_route_sync") return next(); res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/__host_route_sync", html)); });
  } }], server: { host: "127.0.0.1", port: 0, hmr: false } });
  await server.listen(); url = server.resolvedUrls!.local[0] + "__host_route_sync";
});
test.afterAll(async () => { await server.close(); });
const ready = (page: import("@playwright/test").Page) => page.waitForFunction(() => !!(window as unknown as { hostRouteSyncFixture?: Fixture }).hostRouteSyncFixture);

test("an online owner session gains the host's Tailscale route, keeps LAN and VPS, and both survive reload", async ({ page }) => {
  await page.goto(url); await ready(page);
  const first = await page.evaluate(async ({ hubKey, deviceKey, lan, tail, relay }) => {
    const f = (window as unknown as { hostRouteSyncFixture: Fixture }).hostRouteSyncFixture;
    const registry = new f.HostRegistry("host-route-sync-fixture");
    const host = await registry.add({ deviceId: "phone", publicKey: deviceKey, hubPublicKey: hubKey, name: "Phone", routes: [lan, relay] }, "Mac");
    const handle = await registry.open(host.id), connection = new f.HubConnection(handle.identity, handle.cache), paths: string[] = [];
    connection.state = { ...connection.state, status: "online", hostRoutesAvailable: true, user: { id: "owner", name: "Owner", role: "owner" }, route: relay };
    Reflect.set(connection, "token", "fixture-session");
    // Only the self-route read answers; any probe of the new route stays offline.
    window.fetch = async (input, init) => {
      const target = new URL(input instanceof Request ? input.url : String(input)); paths.push(target.pathname);
      if (target.pathname !== "/api/network/host-routes") throw new TypeError("fixture_offline");
      if (new Headers(init?.headers).get("Authorization") !== "Bearer fixture-session" || target.origin !== relay.url) throw new TypeError("fixture_unauthenticated");
      return Response.json({ v: 1, hostPublicKey: hubKey, routes: [{ source: "shared", route: lan }, { source: "managed", route: tail }],
        local: { lan: { enabled: true, listening: true }, tailscale: { enabled: true, listening: true } }, notices: [], observedAt: 1 });
    };
    const pool = { state: { hosts: [{ host, connection }], loading: false }, localHostKey: "", connection: () => undefined } as unknown as HostConnections;
    const sync = new f.NetworkSync(pool, registry);
    await sync.refresh();
    const result = { id: host.id, routes: connection.identity.routes, hostRoutes: paths.filter(path => path === "/api/network/host-routes").length };
    sync.close(); connection.close(); handle.cache.close(); registry.close();
    return result;
  }, { hubKey, deviceKey, lan, tail, relay });
  expect(first).toMatchObject({ routes: [lan, tail, relay], hostRoutes: 1 });
  await page.reload(); await ready(page);
  const persisted = await page.evaluate(async id => {
    const f = (window as unknown as { hostRouteSyncFixture: Fixture }).hostRouteSyncFixture;
    const registry = new f.HostRegistry("host-route-sync-fixture"), handle = await registry.open(id);
    const result = { routes: handle.identity.routes, base: (await registry.list()).find(host => host.id === id)?.hostRoutes?.base };
    handle.cache.close(); registry.close(); return result;
  }, first.id);
  expect(persisted).toEqual({ routes: [lan, tail, relay], base: [lan, tail] });
});


test("manual route provenance persists even when the published routes stay identical and clears on network departure", async ({ page }) => {
  await page.goto(url); await ready(page);
  const result = await page.evaluate(async ({ hubKey, deviceKey, lan }) => {
    const f = (window as unknown as { hostRouteSyncFixture: Fixture }).hostRouteSyncFixture;
    const registry = new f.HostRegistry("manual-provenance-fixture");
    const host = await registry.add({ deviceId: "phone", publicKey: deviceKey, hubPublicKey: hubKey, name: "Phone", routes: [lan] }, "Mac");
    await registry.networkMetadata(host.id, "network-fixture", "authority-fixture", [lan], []);
    await registry.networkMetadata(host.id, "network-fixture", "authority-fixture", [lan], [lan.url]);
    const saved = (await registry.list())[0]!.networkManualRoutes;
    await registry.clearNetworkMetadata(host.id);
    const cleared = (await registry.list())[0]!.networkManualRoutes;
    registry.close(); return { saved, cleared };
  }, { hubKey, deviceKey, lan });
  expect(result).toEqual({ saved: [lan.url], cleared: undefined });
});

test("real route sync diagnoses capacity, honors deletions and recovers after a successful manual edit", async ({ page }) => {
  await page.goto(url); await ready(page);
  const result = await page.evaluate(async ({ hubKey, deviceKey, tail }) => {
    const f = (window as unknown as { hostRouteSyncFixture: Fixture }).hostRouteSyncFixture;
    const directs = [1, 2, 3, 4].map(n => ({ name: "Direct" as const, url: `https://192.0.2.${n}:8443` }));
    const registry = new f.HostRegistry("route-capacity-fixture");
    const host = await registry.add({ deviceId: "phone", publicKey: deviceKey, hubPublicKey: hubKey, name: "Phone", routes: directs }, "Mac");
    const handle = await registry.open(host.id), connection = new f.HubConnection(handle.identity, handle.cache);
    connection.state = { ...connection.state, status: "online", hostRoutesAvailable: true, user: { id: "owner", name: "Owner", role: "owner" }, route: directs[0] };
    Reflect.set(connection, "token", "fixture-session");
    window.fetch = async input => {
      if (new URL(input instanceof Request ? input.url : String(input)).pathname !== "/api/network/host-routes") throw new TypeError("fixture_offline");
      return Response.json({ v: 1, hostPublicKey: hubKey, routes: [{ source: "managed", route: tail }],
        local: { lan: { enabled: true, listening: true }, tailscale: { enabled: true, listening: true } }, notices: [], observedAt: 1 });
    };
    const pool = { state: { hosts: [{ host, connection }], loading: false }, localHostKey: "" } as unknown as HostConnections;
    let now = Date.now(); const realNow = Date.now; Date.now = () => now;
    const sync = new f.NetworkSync(pool, registry);
    try {
      await sync.refresh(); const full = connection.state.routeSync?.host?.limited;
      await connection.updateRoutes(directs.slice(0, 3), { reason: "user" });
      const afterEdit = connection.state.routeSync;
      now += 30_000; await sync.refresh(); const recovered = connection.state.routeSync?.host?.limited;
      const recoveredRoutes = connection.identity.routes;
      // The newly synchronized route has provenance. Removing it deliberately
      // must remain a deletion even when four other local routes fill the cap.
      await connection.updateRoutes(directs, { reason: "user" });
      now += 30_000; await sync.refresh(); const deleted = connection.state.routeSync?.host?.limited;
      const deletedRoutes = connection.identity.routes;
      connection.close(); const afterClose = connection.state.routeSync;
      return { full, afterEdit, recovered, recoveredRoutes, deleted, deletedRoutes, afterClose };
    } finally { Date.now = realNow; sync.close(); connection.close(); handle.cache.close(); registry.close(); }
  }, { hubKey, deviceKey, tail });
  expect(result.full).toBe(true); expect(result.afterEdit).toBeUndefined();
  expect(result.recovered).toBe(false); expect(result.recoveredRoutes).toContainEqual(tail);
  expect(result.deleted).toBe(false); expect(result.deletedRoutes).toHaveLength(4); expect(result.deletedRoutes).not.toContainEqual(tail);
  expect(result.afterClose).toBeUndefined();
});
