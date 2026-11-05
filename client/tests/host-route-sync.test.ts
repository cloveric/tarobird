import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Route } from "../../src/client-protocol/routes.js";

vi.mock("../src/storage.js", () => ({ cache: {}, ClientCache: class {}, defaultPreferences: {} }));
vi.mock("../src/identity.js", () => ({ createIdentity: vi.fn() }));
vi.mock("../src/transport.js", () => ({ hubFetch: vi.fn(), hubSocket: vi.fn(), usesPinnedTransport: () => true }));
import { mergeHostRoutes } from "../src/host-route-sync.js";
import { NetworkSync } from "../src/network-sync.js";
import type { ConnectionState, RouteSyncSource } from "../src/connection.js";
import type { HostConnections } from "../src/host-connections.js";
import type { HostRegistry, RuntimeHost } from "../src/host-registry.js";
import { HOST_ROUTES_PATH, type HostRoutesView } from "../../src/client-protocol/host-routes.js";
import type { NetworkHost, SignedNetworkManifest } from "../../src/client-protocol/private-network.js";
import type { HubConnection } from "../src/connection.js";

const CA = "A".repeat(120), OTHER = "B".repeat(120);
const lan: Route = { name: "Direct", url: "https://192.0.2.10:8443", certificateAuthority: CA };
const lan2: Route = { name: "Direct", url: "https://192.0.2.11:8443", certificateAuthority: CA };
const tail: Route = { name: "Tailscale", url: "https://100.64.0.7:8443", certificateAuthority: CA };
const relay: Route = { name: "VPS", url: "https://relay.example" };
const custom: Route = { name: "Direct", url: "https://home.example" };

describe("per-route three-way merge", () => {
  it("adds host routes, removes only unmodified withdrawn ones and keeps manual or edited ones", () => {
    expect(mergeHostRoutes({ ours: [lan, relay], base: [lan], theirs: [lan, tail] })).toEqual({ routes: [lan, tail, relay], base: [lan, tail], manual: [], deployment: undefined, changed: true, limited: false, deferred: [] });
    expect(mergeHostRoutes({ ours: [lan, tail, relay], base: [lan, tail], theirs: [lan2, tail] }).routes).toEqual([tail, lan2, relay]);
    const labelled = { ...lan, label: "Home" };
    expect(mergeHostRoutes({ ours: [labelled, relay], base: [lan], theirs: [lan2] }).routes).toEqual([labelled, lan2, relay]);
    expect(mergeHostRoutes({ ours: [lan, relay], base: [lan], theirs: [lan] })).toMatchObject({ routes: [lan, relay], changed: false });
  });

  it("updates a changed route only while the user left it exactly as published", () => {
    const renewed = { ...tail, label: "Tailnet" };
    expect(mergeHostRoutes({ ours: [tail], base: [tail], theirs: [renewed] }).routes).toEqual([renewed]);
    const mine = { ...tail, label: "Mine" };
    expect(mergeHostRoutes({ ours: [mine], base: [tail], theirs: [renewed] }).routes).toEqual([mine]);
  });

  it("keeps a user-deleted published route deleted and treats a missing base as add-only", () => {
    expect(mergeHostRoutes({ ours: [relay], base: [lan, tail], theirs: [lan, tail] })).toMatchObject({ routes: [relay], changed: false, base: [lan, tail] });
    expect(mergeHostRoutes({ ours: [lan, relay], theirs: [tail] })).toMatchObject({ routes: [lan, tail, relay], base: [tail] });
  });

  it("defers withdrawing the active route and retries once it is idle", () => {
    const first = mergeHostRoutes({ ours: [lan, tail], base: [lan, tail], theirs: [tail], active: lan.url });
    expect(first).toMatchObject({ routes: [lan, tail], changed: false, deferred: [lan.url] });
    expect(first.base).toEqual([tail, lan]);
    expect(mergeHostRoutes({ ours: [lan, tail], base: first.base, theirs: [tail], active: tail.url }).routes).toEqual([tail]);
  });

  it("fills a missing CA for the same origin but never replaces a different one", () => {
    const bare = { ...lan, certificateAuthority: undefined }, foreign = { ...lan, certificateAuthority: OTHER };
    expect(mergeHostRoutes({ ours: [bare], theirs: [lan] }).routes).toEqual([lan]);
    expect(mergeHostRoutes({ ours: [foreign], theirs: [lan] }).routes).toEqual([foreign]);
  });

  it("skips additions over the local cap without dropping manual routes and retries them later", () => {
    const directs: Route[] = [1, 2, 3, 4].map(n => ({ name: "Direct", url: `https://198.51.100.${n}` }));
    const result = mergeHostRoutes({ ours: directs, theirs: [tail] });
    expect(result).toMatchObject({ routes: directs, changed: false, limited: true, base: [] });
    expect(mergeHostRoutes({ ours: directs.slice(1), base: result.base, theirs: [tail] }).routes).toContainEqual(tail);
  });

  it("clears obsolete deployment descriptions when authenticated routes expand", () => {
    expect(mergeHostRoutes({ ours: [relay], base: [], theirs: [tail, relay], deployment: "vps-relay" })).toMatchObject({ routes: [tail, relay], deployment: undefined, changed: true, limited: false, base: [tail, relay] });
    expect(mergeHostRoutes({ ours: [lan], base: [lan], theirs: [relay], deployment: "vps-direct" })).toMatchObject({ routes: [relay], deployment: undefined, changed: true });
  });
});

type Fake = ReturnType<typeof fixture>;
function view(routes: { source: "shared" | "managed"; route: Route }[], hostPublicKey = "HUBKEY"): HostRoutesView {
  return { v: 1, hostPublicKey, routes, local: { lan: { enabled: true, listening: true }, tailscale: { enabled: true, listening: true } }, notices: [], observedAt: 1 };
}
function fixture(options: { localHostKey?: string; role?: "owner" | "member"; available?: boolean } = {}) {
  const order: string[] = [];
  const identity = { deviceId: "phone", name: "Phone", publicKey: "device", hubPublicKey: "HUBKEY", routes: [lan, relay] as Route[] };
  const host: RuntimeHost = { id: "hub_fixture", name: "Mac", publicKey: "HUBKEY", deviceId: "phone", databaseName: "db", registrationId: "registration-1", createdAt: 1, state: "ready" };
  const connection = {
    identity, isClosed: false, isReadOnly: false,
    state: { status: "online", hostRoutesAvailable: options.available ?? true, networkAvailable: false, user: { role: options.role ?? "owner" }, route: relay } as ConnectionState,
    http: vi.fn(async (_path: string, _init?: RequestInit): Promise<unknown> => view([{ source: "shared", route: lan }, { source: "managed", route: tail }])),
    updateRoutes: vi.fn(async (routes: Route[], update: { expected: Route[]; reason: string }) => {
      if (update.expected !== identity.routes) throw new Error("routes_changed");
      identity.routes = routes; order.push("identity");
    }),
    recordRouteSyncResult: vi.fn((source: RouteSyncSource, expected: typeof identity, limited: boolean) => {
      if (expected.hubPublicKey !== identity.hubPublicKey || JSON.stringify(expected.routes) !== JSON.stringify(identity.routes)) return;
      connection.state = { ...connection.state, routeSync: { ...connection.state.routeSync, [source]: { limited } } };
    }),
  };
  const pool = { localHostKey: options.localHostKey ?? "", state: { hosts: [{ host, connection }] } };
  const registry = {
    list: vi.fn(async () => [host]),
    saveHostRoutes: vi.fn(async (_id: string, _registration: string, base: Route[], _at: number, manual: string[]) => { order.push("provenance"); host.hostRoutes = { base, manual, at: 1 }; return true; }),
    networkMetadata: vi.fn(async () => undefined),
  };
  const sync = new NetworkSync(pool as unknown as HostConnections, registry as unknown as HostRegistry);
  return { order, identity, host, connection, pool, registry, sync };
}
let now = 1_000_000;
beforeEach(() => { now = 1_000_000; vi.spyOn(Date, "now").mockImplementation(() => now); });
afterEach(() => { vi.restoreAllMocks(); });

describe("self-route sync", () => {
  it("adopts the connected host's own extra route, writing identity before provenance", async () => {
    const f: Fake = fixture(), original = f.identity.routes;
    await f.sync.refresh();
    expect(f.connection.http).toHaveBeenCalledWith(HOST_ROUTES_PATH, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(f.connection.updateRoutes).toHaveBeenCalledWith([lan, tail, relay], { expected: original, deployment: undefined, reason: "host-sync" });
    expect(f.order).toEqual(["identity", "provenance"]);
    expect(f.registry.saveHostRoutes).toHaveBeenCalledWith("hub_fixture", "registration-1", [lan, tail], now, [lan.url]);
    // Rides the existing loop without refetching on every 4 s tick.
    await f.sync.refresh(); now += 29_000; await f.sync.refresh();
    expect(f.connection.http).toHaveBeenCalledTimes(1);
    now += 10 * 60_000; await f.sync.refresh();
    expect(f.connection.http).toHaveBeenCalledTimes(2); expect(f.connection.updateRoutes).toHaveBeenCalledTimes(1);
  });

  it("rejects a reply bound to another host key and skips the desktop's own loopback host", async () => {
    const wrong = fixture();
    wrong.connection.http.mockResolvedValue(view([{ source: "managed", route: tail }], "OTHERKEY"));
    await wrong.sync.refresh();
    expect(wrong.connection.updateRoutes).not.toHaveBeenCalled(); expect(wrong.registry.saveHostRoutes).not.toHaveBeenCalled();
    expect(wrong.connection.recordRouteSyncResult).not.toHaveBeenCalled();
    const local = fixture({ localHostKey: "HUBKEY" });
    await local.sync.refresh();
    expect(local.connection.http).not.toHaveBeenCalled();
  });

  it("does not ask old Hubs or non-owner sessions and stops when the registration changes mid-request", async () => {
    for (const options of [{ available: false }, { role: "member" as const }]) {
      const f = fixture(options); await f.sync.refresh(); expect(f.connection.http).not.toHaveBeenCalled();
    }
    const f = fixture();
    f.connection.http.mockImplementation(async () => { f.pool.state.hosts = [{ host: { ...f.host, registrationId: "registration-2" }, connection: f.connection }]; return view([{ source: "managed", route: tail }]); });
    await f.sync.refresh();
    expect(f.connection.updateRoutes).not.toHaveBeenCalled(); expect(f.registry.saveHostRoutes).not.toHaveBeenCalled();
    expect(f.connection.recordRouteSyncResult).not.toHaveBeenCalled();
  });

  it("loses a compare-and-swap race to a concurrent edit without recording provenance, then merges again", async () => {
    const f = fixture(), edited = [lan, relay, { name: "VPS" as const, url: "https://relay2.example" }];
    // The editor's save reaches the connection's write queue first.
    f.connection.updateRoutes.mockImplementationOnce(async () => { f.identity.routes = edited; throw new Error("routes_changed"); });
    await f.sync.refresh();
    expect(f.registry.saveHostRoutes).not.toHaveBeenCalled(); expect(f.identity.routes).toBe(edited);
    expect(f.connection.recordRouteSyncResult).not.toHaveBeenCalled();
    now += 30_000; await f.sync.refresh();
    expect(f.identity.routes).toEqual([lan, tail, relay, edited[2]]); expect(f.order).toEqual(["identity", "provenance"]);
  });

  it("does not probe self routes while hidden or persist them after losing owner eligibility", async () => {
    const hidden = fixture(); vi.stubGlobal("document", { visibilityState: "hidden" });
    try { await hidden.sync.refresh(); expect(hidden.connection.http).not.toHaveBeenCalled(); }
    finally { vi.unstubAllGlobals(); }
    const changed = fixture();
    changed.connection.http.mockImplementation(async () => {
      changed.connection.state.user!.role = "member";
      return view([{ source: "managed", route: tail }]);
    });
    await changed.sync.refresh();
    expect(changed.connection.updateRoutes).not.toHaveBeenCalled();
  });

  it("never treats an empty publication as a withdrawal", async () => {
    const f = fixture(); f.host.hostRoutes = { base: [lan], at: 1 };
    f.connection.http.mockResolvedValue(view([]));
    await f.sync.refresh();
    expect(f.connection.updateRoutes).not.toHaveBeenCalled(); expect(f.identity.routes).toEqual([lan, relay]);
  });

  it("reports the actual limited merge and retries after a route edit frees capacity", async () => {
    const f = fixture(), directs: Route[] = [1, 2, 3, 4].map(n => ({ name: "Direct", url: `https://198.51.100.${n}` }));
    f.identity.routes = directs;
    f.connection.http.mockResolvedValue(view([{ source: "managed", route: tail }]));
    await f.sync.refresh();
    expect(f.identity.routes).toEqual(directs);
    expect(f.connection.state.routeSync?.host).toEqual({ limited: true });
    expect(f.host.hostRoutes?.base ?? []).not.toContainEqual(tail);
    // An edited array makes this eligible after the existing minimum interval,
    // rather than waiting for the otherwise ten-minute background refresh.
    f.identity.routes = directs.slice(1);
    now += 29_000; await f.sync.refresh(); expect(f.connection.http).toHaveBeenCalledTimes(1);
    now += 1_000; await f.sync.refresh();
    expect(f.identity.routes).toEqual([...directs.slice(1), tail]);
    expect(f.connection.state.routeSync?.host).toEqual({ limited: false });
    now += 30_000; await f.sync.refresh(); expect(f.connection.http).toHaveBeenCalledTimes(2);
  });

  it("does not mistake an intentionally deleted published route for a capacity failure", async () => {
    const f = fixture(), directs: Route[] = [1, 2, 3, 4].map(n => ({ name: "Direct", url: `https://198.51.100.${n}` }));
    f.identity.routes = directs; f.host.hostRoutes = { base: [tail], at: 1 };
    f.connection.http.mockResolvedValue(view([{ source: "managed", route: tail }]));
    await f.sync.refresh();
    expect(f.identity.routes).toEqual(directs); expect(f.connection.updateRoutes).not.toHaveBeenCalled();
    expect(f.connection.state.routeSync?.host).toEqual({ limited: false });
  });

  it("does not publish a diagnosis after losing the registration during provenance persistence", async () => {
    const f = fixture();
    f.registry.saveHostRoutes.mockImplementationOnce(async () => {
      f.pool.state.hosts = [{ host: { ...f.host, registrationId: "registration-2" }, connection: f.connection }];
      return true;
    });
    await f.sync.refresh();
    expect(f.connection.recordRouteSyncResult).not.toHaveBeenCalled();
  });

  it("does not restore an old network diagnosis after the target confirms a network change", async () => {
    const f = fixture();
    const host = { publicKey: "HUBKEY", state: "active", routes: [tail] } as NetworkHost;
    const membership = { manifest: { id: "network", authorityKey: "authority", hosts: [host] } } as SignedNetworkManifest;
    f.host.networkId = "network"; f.host.networkAuthority = "authority";
    const target = Object.assign(f.connection, { networkKnown: membership as SignedNetworkManifest | undefined });
    const source = { ...f.connection, identity: { ...f.identity, hubPublicKey: "SOURCE" }, networkKnown: membership };
    Object.assign(f.registry, { networkCandidate: vi.fn(async () => undefined) });
    f.pool.state.hosts.push({ host: { ...f.host, id: "source", publicKey: "SOURCE", registrationId: "source-registration" }, connection: source });
    f.registry.networkMetadata.mockImplementationOnce(async () => {
      // Same registration and routes survive, but the user has accepted that
      // this host left the old network while provenance was being persisted.
      target.networkKnown = undefined;
      target.state.routeSync = undefined;
    });
    await (f.sync as unknown as { discover(source: HubConnection, membership: SignedNetworkManifest, host: NetworkHost): Promise<void> })
      .discover(source as unknown as HubConnection, membership, host);
    expect(f.connection.recordRouteSyncResult).not.toHaveBeenCalled();
  });
});
