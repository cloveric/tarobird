import { createRoot } from "react-dom/client";
import { RoutesEditor } from "../../src/RoutesEditor.js";
import type { ConnectionState, HubConnection, RouteSyncSource } from "../../src/connection.js";
import { NetworkSync } from "../../src/network-sync.js";
import type { HostConnections } from "../../src/host-connections.js";
import type { HostRegistry, RuntimeHost } from "../../src/host-registry.js";
import { localRoutesSchema, type Route } from "../../../src/client-protocol/routes.js";
import { setLocale } from "../../src/i18n.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/device-settings.css";
import "../../src/connection-panel.css";

const initial: Route[] = [{ name: "Direct", url: "https://192.168.1.20:8788", certificateAuthority: "A".repeat(120) }, { name: "VPS", url: "https://relay.example.test", label: "云端中转", certificateAuthority: "B".repeat(120) }];
const listeners = new Set<() => void>();
const data = { fail: false, saves: 0 };
const connection = {
  identity: { deviceId: "fixture", publicKey: "fixture-device", name: "Phone", hubPublicKey: `MCowBQYDK2VwAyEA${"h".repeat(44)}`, routes: JSON.parse(localStorage.getItem("fixture-routes") ?? JSON.stringify(initial)) as Route[], deployment: "computer" },
  state: { cacheRevision: 0, bots: [], avatars: [], outbox: 0, status: "online", route: initial[0], latency: 24, routeHealth: initial.map(route => ({ url: route.url, status: "reachable", latency: 24 })) } as ConnectionState,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  async updateRoutes(routes: Route[], options?: { deployment?: string }) {
    if (data.fail) throw new Error("测试：保存失败");
    const saved = localRoutesSchema.parse(routes); localStorage.setItem("fixture-routes", JSON.stringify(saved));
    connection.identity.routes = saved; connection.identity.deployment = options?.deployment ?? "computer";
    connection.state = { ...connection.state, routeSync: undefined }; data.saves++; listeners.forEach(listener => listener());
  },
  recordRouteSyncResult(source: RouteSyncSource, _expected: unknown, limited: boolean) {
    connection.state = { ...connection.state, routeSync: { ...connection.state.routeSync, [source]: { limited } } };
    listeners.forEach(listener => listener());
  },
};
createRoot(document.getElementById("root")!).render(<main style={{ maxWidth: 800, margin: "24px auto", padding: 16 }}><h1>连接</h1><RoutesEditor connection={connection as unknown as HubConnection}/></main>);
Object.assign(window, { multipathFixture: { data, connection, setLocale, externalUpdate() { connection.identity.routes = [...connection.identity.routes, { name: "Tailscale", url: "https://100.80.1.21:8788" }]; connection.state = { ...connection.state }; listeners.forEach(listener => listener()); } } });

// Real IndexedDB regression: auto route sync must patch only routes, with a
// durable identity/configuration fence across tabs and pairing/reset changes.
Object.assign(window, { verifyRouteStorage: async () => {
  const { ClientCache } = await import("../../src/storage.js");
  const name = `route-cas-${crypto.randomUUID()}`, cache = new ClientCache(name);
  const original = { deviceId: "owner", name: "Owner", publicKey: "device", hubPublicKey: "host", routes: initial };
  try {
    await cache.saveIdentity(original);
    await cache.savePendingPairing(original, { code: "123456", expiresAt: Date.now() + 60000 });
    const next: Route[] = [...initial, { name: "Tailscale", url: "https://100.80.1.20:8788" }];
    await cache.saveIdentityRoutes(original, next);
    const retained = (await cache.identity())!.pendingPairing?.code === "123456";
    const rejection = (p: Promise<unknown>) => p.then(() => "unexpected success", (error: Error) => error.message);
    const stale = await rejection(cache.saveIdentityRoutes(original, [initial[0]!]));
    const current = (await cache.identity())!;
    await cache.markIdentityRevoked(current);
    const revoked = await rejection(cache.saveIdentityRoutes(current, [initial[0]!]));
    await cache.saveIdentity({ ...current, deviceId: "new-owner", publicKey: "new-key" });
    const replaced = await rejection(cache.saveIdentityRoutes(current, [initial[0]!]));
    return { retained, stale, revoked, replaced, owner: (await cache.identity())!.deviceId };
  } finally { cache.close(); indexedDB.deleteDatabase(name); }
} });

Object.assign(window, { showHostRouteStatus: async (full = false, deleted = false) => {
  if (full) connection.identity.routes = [1, 2, 3, 4].map(n => ({ name: "Direct", url: `https://192.168.1.${n}:8788` }));
  const route: Route = { name: "Tailscale", url: "https://100.80.1.20:8788" };
  Object.assign(connection, { http: async () => ({ v: 1, hostPublicKey: connection.identity.hubPublicKey, routes: full ? [{source: "managed", route}] : [], local: { lan: { enabled: true, listening: true }, tailscale: { enabled: true, listening: false } }, notices: ["tailscale_not_listening"], observedAt: Date.now() }) });
  connection.state = { ...connection.state, hostRoutesAvailable: true, user: { id: "owner", name: "Owner", role: "owner" } };
  listeners.forEach(listener => listener());
  const host: RuntimeHost = { id: "status-fixture", registrationId: "status-registration", name: "Mac", publicKey: connection.identity.hubPublicKey, deviceId: "fixture", databaseName: "status-fixture", createdAt: 1, state: "ready", ...(deleted ? { hostRoutes: { base: [route], at: 1 } } : {}) };
  const pool = { state: { hosts: [{ host, connection }] }, localHostKey: "" } as unknown as HostConnections;
  const registry = { list: async () => [host], saveHostRoutes: async (_id: string, _registration: string, base: Route[], at: number, manual: string[]) => { host.hostRoutes = { base, at, manual }; return true; } } as unknown as HostRegistry;
  const sync = new NetworkSync(pool, registry);
  try { await sync.refresh(); } finally { sync.close(); }
} });
