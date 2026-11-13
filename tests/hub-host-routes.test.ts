import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { deviceProof } from "../src/hub/auth.js";
import * as desktopTls from "../src/hub/desktop-tls.js";
import { loadHubTls } from "../src/hub/tls.js";
import { CAPABILITIES } from "../src/client-protocol/index.js";
import { HOST_ROUTES_CAPABILITY, HOST_ROUTES_PATH, HOST_LAN_SELECTION_CAPABILITY, HOST_LAN_SELECTION_PATH, hostRoutesViewSchema } from "../src/client-protocol/host-routes.js";
import { routesSchema, type Route } from "../src/client-protocol/routes.js";
import { networkViewSchema, sharedRoutesSchema } from "../src/client-protocol/private-network.js";
import {
  certificateAuthorityFromChain, lanInterfaceKey, emptyHostRoutesRecord, HOST_ROUTE_COOLDOWN_MS, HOST_ROUTES_KEY, HostRoutes, observeHostRoutes, sharedRouteReplacement,
  type HostRoutesRecord, type ManagedListener,
} from "../src/hub/host-routes.js";

const CA = "A".repeat(120), OTHER_CA = "B".repeat(120);
const both = { lan: true, tailscale: true };
const listener = (host: string, listening = true, authority = CA, port = 8443): ManagedListener => ({ host, port, listening, authority, interfaceKey: host.startsWith("192.168.10.") ? "wifi" : "other-interface" });
const direct = (url: string, extra: Partial<Route> = {}): Route => ({ name: "Direct", url, certificateAuthority: CA, ...extra });
const tailscale = (url: string, extra: Partial<Route> = {}): Route => ({ name: "Tailscale", url, certificateAuthority: CA, ...extra });
const vps: Route = { name: "VPS", url: "https://relay.example" };
const lanOnly = { lan: true, tailscale: false };
function tick(record: HostRoutesRecord, listeners: ManagedListener[], at: number, enabled = lanOnly) { return observeHostRoutes(record, listeners, enabled, at); }

describe("host route observation", () => {
  it("publishes the first unique Tailscale IPv4 at once and never loopback, unspecified or unverified listeners", () => {
    const { record, notices } = tick(emptyHostRoutesRecord(), [listener("fd7a:115c:a1e0::7"), listener("100.64.0.7"), listener("127.0.0.1"), listener("0.0.0.0"), listener("192.0.2.40", true, "")], 1000, both);
    expect(record.modes.tailscale).toEqual({ route: tailscale("https://100.64.0.7:8443"), seen: 1 });
    expect(record.modes.lan).toBeUndefined();
    expect(record.changedAt).toBe(1000); expect(notices).toEqual(["lan_not_listening"]);
    expect(tick(emptyHostRoutesRecord(), [listener("100.64.0.7")], 1000, { lan: false, tailscale: false }).record).toEqual(emptyHostRoutesRecord());
  });

  it("keeps a published route while its interface is absent and asks the owner to choose between LAN candidates", () => {
    const first = tick(emptyHostRoutesRecord(), [listener("192.168.10.10")], 0).record;
    const asleep = tick(first, [listener("192.168.10.10", false)], 30_000);
    expect(asleep.record.modes.lan?.route.url).toBe("https://192.168.10.10:8443"); expect(asleep.notices).toContain("lan_not_listening");
    // A VM/Docker bridge beside the published address changes nothing.
    expect(tick(first, [listener("192.168.10.10"), listener("192.168.11.3")], 60_000).notices).toEqual([]);
    const ambiguous = tick(emptyHostRoutesRecord(), [listener("192.168.10.10"), listener("192.168.11.3")], 0);
    expect(ambiguous.record.modes.lan).toBeUndefined(); expect(ambiguous.notices).toEqual(["lan_selection_required"]);
    const stale = tick(first, [listener("192.168.10.11"), listener("192.168.11.3")], 60_000);
    expect(stale.record.modes.lan?.route.url).toBe("https://192.168.10.10:8443"); expect(stale.notices).toEqual(["replacement_pending"]);
  });

  it("replaces a changed address only after two consecutive observations and the cooldown", () => {
    let record = tick(emptyHostRoutesRecord(), [listener("192.168.10.10")], 0).record;
    const moved = [listener("192.168.10.11")];
    let result = tick(record, moved, 30_000); record = result.record;
    expect(result.notices).toEqual(["replacement_pending"]); expect(record.modes.lan?.route.url).toBe("https://192.168.10.10:8443");
    result = tick(record, moved, 60_000); record = result.record;
    expect(record.modes.lan?.route.url).toBe("https://192.168.10.10:8443"); expect(record.modes.lan?.candidate).toEqual({ url: "https://192.168.10.11:8443", seen: 2 });
    // A flap back to another address restarts the confirmation.
    expect(tick(record, [listener("192.168.10.12")], HOST_ROUTE_COOLDOWN_MS + 1).record.modes.lan?.candidate).toEqual({ url: "https://192.168.10.12:8443", seen: 1 });
    record = tick(record, moved, HOST_ROUTE_COOLDOWN_MS).record;
    expect(record.modes.lan).toEqual({ route: direct("https://192.168.10.11:8443"), seen: 2, interfaceKey: "wifi", replaces: "https://192.168.10.10:8443" }); expect(record.changedAt).toBe(HOST_ROUTE_COOLDOWN_MS);
  });
});

describe("signed descriptor replacement fence", () => {
  const confirmed: HostRoutesRecord = { ...emptyHostRoutesRecord(), modes: { lan: { route: direct("https://192.168.10.11:8443"), seen: 2, interfaceKey: "wifi", replaces: "https://192.168.10.10:8443" }, tailscale: { route: tailscale("https://100.64.0.7:8443"), seen: 1 } } };
  const live = [listener("192.168.10.11"), listener("100.64.0.7")];

  it("replaces only a stale desktop-managed direct route, keeping its label and VPS routes", () => {
    const next = sharedRouteReplacement([direct("https://192.168.10.10:8443", { label: "Home" }), vps], confirmed, live);
    expect(next).toEqual([direct("https://192.168.10.11:8443", { label: "Home" }), vps]);
    // The descriptor stays wire v2: one direct route plus VPS.
    expect(sharedRoutesSchema.safeParse(next).success).toBe(true); expect(routesSchema.safeParse(next).success).toBe(true);
  });

  it("never touches custom, still-served, unconfirmed or absent direct routes and never adds one", () => {
    expect(sharedRouteReplacement([direct("https://192.168.10.10:8443", { certificateAuthority: OTHER_CA })], confirmed, live)).toBeUndefined();
    expect(sharedRouteReplacement([direct("https://192.168.10.10:8443", { certificateAuthority: undefined })], confirmed, live)).toBeUndefined();
    expect(sharedRouteReplacement([direct("https://192.168.10.10:9443")], confirmed, live)).toBeUndefined();
    expect(sharedRouteReplacement([direct("https://vpn.example:8443")], confirmed, live)).toBeUndefined();
    expect(sharedRouteReplacement([direct("https://192.168.10.10:8443")], confirmed, [...live, listener("192.168.10.10")])).toBeUndefined();
    expect(sharedRouteReplacement([direct("https://192.168.10.10:8443")], confirmed, [listener("192.168.10.11", false)])).toBeUndefined();
    expect(sharedRouteReplacement([tailscale("https://100.64.0.6:8443")], confirmed, live)).toBeUndefined();
    expect(sharedRouteReplacement([vps], confirmed, live)).toBeUndefined();
    expect(sharedRouteReplacement([], confirmed, live)).toBeUndefined();
  });
});

async function freePort() {
  const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
let directory: string | undefined, hub: HubServer | undefined;
afterEach(async () => { await hub?.close(); hub = undefined; if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });
async function start(options: Partial<Parameters<typeof HubServer.start>[0]> = {}) {
  directory = await mkdtemp(path.join(os.tmpdir(), "host-routes-"));
  hub = await HubServer.start({ stateDir: directory, ...options });
  return hub;
}
async function enroll(target: HubServer, id = "owner_device", userId = "owner") {
  const keys = generateKeyPairSync("ed25519");
  const paired = await target.auth.pair({ deviceId: id, name: id, platform: "web", publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64") }, "fixture");
  await target.auth.approve(paired.code, "local-owner", userId);
  const nonce = randomBytes(32).toString("base64url"), challenge = await target.auth.challenge(id, id, nonce, "fixture");
  const session = await target.auth.authenticate(id, sign(null, deviceProof(id, challenge.nonce, nonce), keys.privateKey).toString("base64"));
  return { Authorization: `Bearer ${session.token}` };
}

describe("host route coordinator", () => {
  it("adopts a new Tailscale address for owners at once and republishes the stale shared route after confirmation", async () => {
    const target = await start(); let now = 1_000_000, live = [listener("100.64.0.7")];
    await writeFile(path.join(directory!, "desktop-tailscale-enabled.json"), "true\n");
    expect(await target.network.replaceManagedRoutes([], [tailscale("https://100.64.0.6:8443"), vps])).toBe(true);
    const routes = new HostRoutes({ store: target.store, network: target.network, publicKey: target.auth.publicKey, stateDir: directory!, listeners: () => live, now: () => now });
    await routes.refresh();
    let view = await routes.view();
    expect(view.routes).toEqual([{ source: "shared", route: tailscale("https://100.64.0.6:8443") }, { source: "shared", route: vps }, { source: "managed", route: tailscale("https://100.64.0.7:8443") }]);
    expect(view.local).toEqual({ lan: { enabled: false, listening: false }, tailscale: { enabled: true, listening: true } });
    // Legacy readers still parse the unchanged single-direct row and view.
    const row = await target.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key='private-network:v1'");
    expect(sharedRoutesSchema.safeParse(JSON.parse(row!.value).routes).success).toBe(true);
    expect(networkViewSchema.safeParse(await target.network.view()).success).toBe(true);
    now += 30_000; await routes.refresh();
    expect(await target.network.sharedRoutes()).toEqual([tailscale("https://100.64.0.7:8443"), vps]);
    view = await routes.view();
    expect(view.routes.map(entry => entry.source)).toEqual(["shared", "shared"]);
    // The next address change waits for two ticks and the cooldown.
    live = [listener("100.64.0.8")]; now += 30_000; await routes.refresh();
    expect((await routes.view()).notices).toEqual(["replacement_pending"]);
    now += 30_000; await routes.refresh();
    expect(await target.network.sharedRoutes()).toEqual([tailscale("https://100.64.0.7:8443"), vps]);
    now += HOST_ROUTE_COOLDOWN_MS; await routes.refresh();
    expect(await target.network.sharedRoutes()).toEqual([tailscale("https://100.64.0.8:8443"), vps]);
    expect(JSON.parse((await target.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [HOST_ROUTES_KEY]))!.value).modes.tailscale.route.url).toBe("https://100.64.0.8:8443");
    // Sleep/VPN off: nothing is withdrawn.
    live = []; now += HOST_ROUTE_COOLDOWN_MS; await routes.refresh();
    view = await routes.view();
    expect(view.routes[0]).toEqual({ source: "shared", route: tailscale("https://100.64.0.8:8443") }); expect(view.notices).toEqual(["tailscale_not_listening"]);
  });

  it("lets a concurrent owner route choice win the compare-and-swap", async () => {
    const target = await start();
    expect(await target.network.replaceManagedRoutes([], [direct("https://192.168.10.10:8443")])).toBe(true);
    expect(await target.network.replaceManagedRoutes([], [direct("https://192.168.10.11:8443")])).toBe(false);
    expect(await target.network.replaceManagedRoutes([direct("https://192.168.10.10:8443")], [direct("https://192.168.10.10:8443")])).toBe(false);
    expect(await target.network.sharedRoutes()).toEqual([direct("https://192.168.10.10:8443")]);
  });

  it("reports a configured but unbound managed listener without publishing it, using the CA it actually serves", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "host-routes-tls-"));
    try {
      const files = await desktopTls.desktopTls(root, ["192.168.10.123"]), tls = await loadHubTls(files);
      expect(certificateAuthorityFromChain(tls.cert)).toBe(files.certificateAuthority);
      expect(certificateAuthorityFromChain((await readFile(files.cert, "utf8")).split("-----END CERTIFICATE-----")[0] + "-----END CERTIFICATE-----")).toBeUndefined();
      const target = await start({ tlsListeners: [{ host: "192.168.10.123", port: await freePort(), tls, exposure: "public", managed: true }], onWarning: () => undefined });
      await writeFile(path.join(directory!, "desktop-network-enabled.json"), "true\n");
      expect(target.managedListeners()).toEqual([expect.objectContaining({ host: "192.168.10.123", listening: false, authority: files.certificateAuthority })]);
      await target.refreshHostRoutes();
      const view = await target.hostRoutes.view();
      expect(view.routes).toEqual([]); expect(view.local.lan).toEqual({ enabled: true, listening: false }); expect(view.notices).toEqual(["lan_not_listening"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("explicit managed LAN selection", () => {
  it("persists a chosen live LAN across refresh and restart without replacing shared Tailscale", async () => {
    const target = await start();
    const shared = [tailscale("https://100.64.0.7:8443"), vps];
    await target.network.replaceManagedRoutes([], shared);
    const options = { store: target.store, network: target.network, publicKey: target.auth.publicKey, stateDir: directory!, listeners: () => [listener("192.168.10.10"), listener("192.168.64.1"), listener("100.64.0.7")] };
    const routes = new HostRoutes(options);
    await routes.refresh(); expect((await routes.view()).notices).toContain("lan_selection_required");
    await routes.selectLan(direct("https://192.168.10.10:8443"));
    await routes.refresh();
    const restored = new HostRoutes(options); await restored.refresh();
    const view = await restored.view();
    expect(view.notices).not.toContain("lan_selection_required");
    expect(view.routes).toContainEqual({ source: "managed", route: direct("https://192.168.10.10:8443") });
    expect(await target.network.sharedRoutes()).toEqual(shared);
  });
  it("rejects unknown, unbound, wrong-CA and non-LAN routes without changing the record", async () => {
    const target = await start();
    const routes = new HostRoutes({ store: target.store, network: target.network, publicKey: target.auth.publicKey, stateDir: directory!, listeners: () => [listener("192.168.10.10"), listener("192.168.10.11", false), listener("100.64.0.7")] });
    await routes.refresh(); const before = await routes.view();
    for (const route of [direct("https://192.168.10.12:8443"), direct("https://192.168.10.11:8443"), direct("https://192.168.10.10:8443", { certificateAuthority: OTHER_CA }), tailscale("https://100.64.0.7:8443"), direct("https://127.0.0.1:8443"), direct("https://192.168.10.10:8444"), direct("https://public.example.test:8443")]) {
      await expect(routes.selectLan(route)).rejects.toThrow("managed_lan_route_unavailable");
    }
    expect((await routes.view()).routes).toEqual(before.routes);
    await target.network.replaceManagedRoutes([], [direct("https://192.168.10.99:8443")]);
    await expect(routes.selectLan(direct("https://192.168.10.10:8443"))).rejects.toThrow("managed_lan_shared_route_conflict");
  });
  it("checks the signed route after acquiring the write guard", async () => {
    const target = await start();
    await target.network.replaceManagedRoutes([], [tailscale("https://100.64.0.7:8443")]);
    const routes = new HostRoutes({ store: target.store, network: target.network, publicKey: target.auth.publicKey, stateDir: directory!, listeners: () => [listener("192.168.10.10"), listener("192.168.64.1")] });
    await expect(routes.selectLan(direct("https://192.168.10.10:8443"), async () => {
      // An owner route change has landed by the time this mutation is authorized.
      const row = await target.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key='private-network:v1'");
      const state = JSON.parse(row!.value); state.routes = [direct("https://192.168.64.1:8443")];
      await target.store.db.run("UPDATE meta SET value=? WHERE key='private-network:v1'", [JSON.stringify(state)]);
    })).rejects.toThrow("managed_lan_shared_route_conflict");
    expect((await routes.view()).routes).not.toContainEqual({ source: "managed", route: direct("https://192.168.10.10:8443") });
  });
  it("serializes a refresh before a selection and checks authorization at the write", async () => {
    const target = await start();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    const read = target.network.sharedRoutes.bind(target.network);
    vi.spyOn(target.network, "sharedRoutes").mockImplementationOnce(async () => { entered(); await gate; return read(); });
    const routes = new HostRoutes({ store: target.store, network: target.network, publicKey: target.auth.publicKey, stateDir: directory!, listeners: () => [listener("192.168.10.10"), listener("192.168.64.1")] });
    const refresh = routes.refresh(); await ready;
    const selection = routes.selectLan(direct("https://192.168.10.10:8443")); release();
    await Promise.all([refresh, selection]);
    expect((await routes.view()).notices).not.toContain("lan_selection_required");
    await expect(routes.selectLan(direct("https://192.168.64.1:8443"), async () => { throw new Error("revoked"); })).rejects.toThrow("revoked");
    expect((await routes.view()).routes).toContainEqual({ source: "managed", route: direct("https://192.168.10.10:8443") });
  });
});

describe("owner-only host routes endpoint", () => {
  it("only lets active owners select a live managed LAN, without changing shared routes", async () => {
    const target = await start(), route = direct("https://192.168.10.10:8443");
    vi.spyOn(target, "managedListeners").mockReturnValue([listener("192.168.10.10"), listener("192.168.64.1")]);
    expect(CAPABILITIES).toContain(HOST_LAN_SELECTION_CAPABILITY);
    const send = (headers?: Record<string, string>, value: unknown = { route }) => fetch(target.url + HOST_LAN_SELECTION_PATH, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(value) });
    expect((await send()).status).toBe(401);
    const owner = await enroll(target);
    await target.store.db.run("INSERT INTO users VALUES('member','Member','member')");
    expect((await send(await enroll(target, "member_device", "member"))).status).toBe(403);
    expect((await send(owner, { route, unknown: true })).status).toBe(400);
    const response = await send(owner); expect(response.status).toBe(200);
    expect(hostRoutesViewSchema.parse(await response.json()).routes).toContainEqual({ source: "managed", route });
    expect(await target.network.sharedRoutes()).toEqual([]);
    await target.auth.revoke("owner_device", "local-owner");
    expect((await send(owner)).status).toBe(401);
  });

  it("advertises the capability and binds the reply to this host's key for owners only", async () => {
    expect(CAPABILITIES).toContain(HOST_ROUTES_CAPABILITY);
    const target = await start();
    expect((await fetch(target.url + HOST_ROUTES_PATH)).status).toBe(401);
    const owner = await enroll(target);
    const response = await fetch(target.url + HOST_ROUTES_PATH, { headers: owner });
    expect(response.status).toBe(200);
    const view = hostRoutesViewSchema.parse(await response.json());
    expect(view).toMatchObject({ v: 1, hostPublicKey: target.auth.publicKey, routes: [], local: { lan: { enabled: false }, tailscale: { enabled: false } } });
    await target.store.db.run("INSERT INTO users VALUES('member','Member','member')");
    expect((await fetch(target.url + HOST_ROUTES_PATH, { headers: await enroll(target, "member_device", "member") })).status).toBe(403);
    await target.auth.revoke("owner_device", "local-owner");
    expect((await fetch(target.url + HOST_ROUTES_PATH, { headers: owner })).status).toBe(401);
  });
});

describe("host route shutdown", () => {
  it("drains an in-flight refresh on close without failing and starts none afterwards", async () => {
    const target = await start();
    const pending = target.refreshHostRoutes();
    await target.close(); hub = undefined;
    await expect(pending).resolves.toBeUndefined();
    await expect(target.refreshHostRoutes()).resolves.toBeUndefined();
  });
});


describe("LAN interface lineage", () => {
  it("never replaces the owner's Wi-Fi route with a co-resident bridge when Wi-Fi disappears", () => {
    const wifi = listener("192.168.10.10"), bridge = listener("192.168.64.1");
    const shared = [direct("https://192.168.10.10:8443"), vps];
    let record = observeHostRoutes(emptyHostRoutesRecord(), [wifi, bridge], lanOnly, 0, shared).record;
    expect(record.modes.lan?.interfaceKey).toBe("wifi");
    for (const at of [30_000, 60_000, 600_000]) {
      const result = observeHostRoutes(record, [bridge], lanOnly, at, shared); record = result.record;
      expect(result.notices).toContain("lan_selection_required");
      expect(record.modes.lan?.route.url).toBe(shared[0]!.url);
      expect(sharedRouteReplacement(shared, record, [bridge])).toBeUndefined();
    }
    record = observeHostRoutes(record, [wifi, bridge], lanOnly, 630_000, shared).record;
    expect(record.modes.lan?.route.url).toBe(shared[0]!.url);
    // A cold start while Wi-Fi is absent also keeps the explicitly shared origin.
    expect(observeHostRoutes(emptyHostRoutesRecord(), [bridge], lanOnly, 0, shared).record.modes.lan).toBeUndefined();
  });
  it("requires owner review when interface lineage is absent or changes", () => {
    const old = tick(emptyHostRoutesRecord(), [{ ...listener("192.168.10.10"), interfaceKey: undefined }], 0).record;
    for (const next of [listener("192.168.10.11"), { ...listener("192.168.10.10"), interfaceKey: "new-adapter" }]) {
      const result = tick(old, [next], 600_000);
      // Same origin may acquire lineage; a changed origin cannot be inferred from an IP range.
      if (next.host.endsWith(".11")) expect(result.record.modes.lan?.route.url).toBe("https://192.168.10.10:8443");
    }
    const known = tick(emptyHostRoutesRecord(), [listener("192.168.10.10")], 0).record;
    const changed = tick(known, [{ ...listener("192.168.10.10"), interfaceKey: "new-adapter" }], 600_000);
    expect(changed.notices).toContain("lan_selection_required");
  });
  it("uses interface and MAC identity without publishing either value", () => {
    const address = { address: "192.168.10.10", family: "IPv4", internal: false, mac: "02:00:00:00:00:01", netmask: "255.255.255.0", cidr: "192.168.10.10/24" } as const;
    const first = lanInterfaceKey(address.address, { wifi: [address] });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(lanInterfaceKey("192.168.10.11", { wifi: [{ ...address, address: "192.168.10.11" }] })).toBe(first);
    expect(lanInterfaceKey(address.address, { bridge: [address] })).not.toBe(first);
    expect(lanInterfaceKey(address.address, { wifi: [{ ...address, mac: "00:00:00:00:00:00" }] })).toBeUndefined();
  });
});


describe("ambiguous LAN persistence", () => {
  it("does not seed a lone bridge after ambiguity on a Tailscale-shared host, including restart", async () => {
    const target = await start(); let live = [listener("192.168.10.10"), listener("192.168.64.1")], now = 1_000_000;
    const shared = [tailscale("https://100.64.0.7:8443"), vps];
    await target.network.replaceManagedRoutes([], shared);
    const options = { store: target.store, network: target.network, publicKey: target.auth.publicKey, stateDir: directory!, listeners: () => live, now: () => now };
    let coordinator = new HostRoutes(options); await coordinator.refresh();
    expect((await coordinator.view()).notices).toContain("lan_selection_required");
    // Recreate the coordinator to exercise schema parsing and persisted ambiguity.
    coordinator = new HostRoutes(options); live = [listener("192.168.64.1")]; now += 600_000;
    await coordinator.refresh();
    expect((await coordinator.view()).routes).toEqual(shared.map(route => ({ source: "shared", route })));
    live = [listener("192.168.10.10"), listener("192.168.64.1")]; now += 600_000; await coordinator.refresh();
    expect((await coordinator.view()).notices).toContain("lan_selection_required");
    // An explicit owner choice clears ambiguity; subsequent Wi-Fi loss is safe.
    await target.network.replaceManagedRoutes(shared, [direct("https://192.168.10.10:8443"), vps]);
    await coordinator.refresh();
    const stored = JSON.parse((await target.store.db.get<{value:string}>("SELECT value FROM meta WHERE key=?", [HOST_ROUTES_KEY]))!.value);
    expect(stored.lanNeedsSelection).toBeUndefined(); expect(stored.modes.lan.interfaceKey).toBe("wifi");
    live = [listener("192.168.64.1")]; now += 600_000; await coordinator.refresh();
    expect((await coordinator.view()).routes.some(item => item.route.url.includes("192.168.64.1"))).toBe(false);
  });
  it("wires real Hub managed-listener observations through interface lineage", async () => {
    const target = await start();
    const first = { address: "192.168.10.10", family: "IPv4", internal: false, mac: "02:00:00:00:00:01", netmask: "255.255.255.0", cidr: "192.168.10.10/24" } as const;
    // Supply the OS snapshot at the actual imported helper, while exercising
    // HubServer.managedListeners rather than constructing ManagedListener data.
    const module = await import("../src/hub/host-routes.js");
    const original = module.lanInterfaceKey;
    const snapshot = { wifi: [first], bridge: [{ ...first, address: "192.168.64.1", mac: "02:00:00:00:00:02" }] };
    const spy = vi.spyOn(module, "lanInterfaceKey").mockImplementation(host => original(host, snapshot));
    const listeners = [first.address, "192.168.64.1"].map(host => ({ host, port: 8443, server: { listening: true }, managed: true, authority: CA }));
    const before = Reflect.get(target, "listeners");
    try {
      Reflect.set(target, "listeners", listeners);
      const initial = target.managedListeners(); expect(initial[0]!.interfaceKey).toMatch(/^[0-9a-f]{64}$/); expect(initial[0]!.interfaceKey).not.toBe(initial[1]!.interfaceKey);
      snapshot.wifi = [{ ...first, address: "192.168.10.11" } as typeof first]; listeners[0]!.host = "192.168.10.11";
      expect(target.managedListeners()[0]!.interfaceKey).toBe(initial[0]!.interfaceKey);
    } finally { Reflect.set(target, "listeners", before); spy.mockRestore(); }
  });
});
