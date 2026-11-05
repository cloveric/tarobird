import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientCache, Identity } from "../src/storage.js";
vi.mock("../src/storage.js", () => ({ cache: {}, ClientCache: class {}, defaultPreferences: {} }));
vi.mock("../src/transport.js", () => ({ hubFetch: vi.fn(), hubSocket: vi.fn(), usesPinnedTransport: () => false }));
import { HubConnection } from "../src/connection.js";
const lan = { name: "Direct" as const, url: "https://lan.example" };
const vpn = { name: "Tailscale" as const, url: "https://vpn.example" };
const relay = { name: "VPS" as const, url: "https://relay.example" };
beforeEach(() => { vi.stubGlobal("document", { hidden: false }); });
afterEach(() => { vi.unstubAllGlobals(); });
function fixture() {
  const identity: Identity = { deviceId: "fixture", name: "Fixture", publicKey: "fixture", hubPublicKey: "trusted", routes: [lan] };
  const cache = { saveIdentityRoutes: vi.fn().mockResolvedValue(undefined) };
  const connection = new HubConnection(identity, cache as unknown as ClientCache);
  Reflect.set(connection, "closed", true); // Test persistence without network side effects.
  return { identity, cache, connection };
}
it("serializes route writes and rejects a stale competing update inside the queue", async () => {
  const { identity, cache, connection } = fixture(); const expected = identity.routes;
  let release!: () => void;
  cache.saveIdentityRoutes.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const first = connection.updateRoutes([lan, vpn], { expected, reason: "host-sync" });
  const second = connection.updateRoutes([lan, relay], { expected, reason: "user" });
  const failure = expect(second).rejects.toThrow("routes_changed");
  await Promise.resolve(); release(); await first; await failure;
  expect(identity.routes).toEqual([lan, vpn]); expect(cache.saveIdentityRoutes).toHaveBeenCalledTimes(1);
});
it("failed writes retain the previous configuration and can safely retry", async () => {
  const { identity, cache, connection } = fixture(); const expected = identity.routes;
  cache.saveIdentityRoutes.mockRejectedValueOnce(new Error("disk full"));
  await expect(connection.updateRoutes([lan, vpn], { expected })).rejects.toThrow("disk full");
  expect(identity.routes).toBe(expected);
  await connection.updateRoutes([lan, vpn], { expected }); expect(identity.routes).toEqual([lan, vpn]);
});
it("unchanged sync is a no-op and adding a path keeps existing stability and failure state", async () => {
  const { identity, cache, connection } = fixture();
  const preferred = { url: lan.url, count: 2 }; Reflect.set(connection, "preferred", preferred);
  const failures = new Map([[lan.url, { attempts: 1, until: Date.now() + 1000 }]]); Reflect.set(connection, "failedRoutes", failures);
  await connection.updateRoutes([{ ...lan }], { expected: identity.routes, reason: "host-sync" });
  expect(cache.saveIdentityRoutes).not.toHaveBeenCalled(); expect(Reflect.get(connection, "preferred")).toBe(preferred);
  await connection.updateRoutes([lan, vpn], { expected: identity.routes, reason: "host-sync" });
  expect(Reflect.get(connection, "preferred")).toBe(preferred); expect(failures.has(lan.url)).toBe(true);
});

it("keeps actual sync results per source and clears them only after a successful route change", async () => {
  const { identity, cache, connection } = fixture();
  Reflect.set(connection, "closed", false);
  connection.recordRouteSyncResult("host", { ...identity }, true);
  connection.recordRouteSyncResult("network", { ...identity }, false);
  expect(connection.state.routeSync?.host?.limited).toBe(true);
  expect(connection.state.routeSync?.network?.limited).toBe(false);
  const changed = vi.fn(), unsubscribe = connection.subscribe(changed);
  connection.recordRouteSyncResult("host", { ...identity }, true);
  connection.recordRouteSyncResult("network", { ...identity }, false);
  expect(changed).not.toHaveBeenCalled(); unsubscribe();
  Reflect.set(connection, "closed", true);
  cache.saveIdentityRoutes.mockRejectedValueOnce(new Error("disk full"));
  await expect(connection.updateRoutes([lan, vpn], { reason: "user" })).rejects.toThrow("disk full");
  expect(connection.state.routeSync?.host?.limited).toBe(true);
  await connection.updateRoutes([lan, vpn], { reason: "user" });
  expect(connection.state.routeSync).toBeUndefined();
});

it("rejects late sync diagnostics after edits, identity replacement, closure or revocation", () => {
  const { identity, connection } = fixture(); Reflect.set(connection, "closed", false);
  const original = { ...identity };
  for (const expected of [{ ...original, hubPublicKey: "other" }, { ...original, deviceId: "other" }, { ...original, publicKey: "other" }, { ...original, routes: [lan, vpn] }]) connection.recordRouteSyncResult("host", expected, true);
  expect(connection.state.routeSync).toBeUndefined();
  connection.recordRouteSyncResult("host", original, false);
  const saved = connection.state.routeSync;
  Reflect.set(connection, "closed", true); connection.recordRouteSyncResult("host", original, true);
  expect(connection.state.routeSync).toBe(saved);
  Reflect.set(connection, "closed", false); Reflect.set(connection, "deviceRevoked", true); connection.recordRouteSyncResult("host", original, true);
  expect(connection.state.routeSync).toBe(saved);
});
