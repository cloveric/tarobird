import { beforeEach, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../src/storage.js", () => ({ cache: {}, ClientCache: class {}, defaultPreferences: {} }));
vi.mock("../src/transport.js", () => ({ hubFetch: io.fetch }));
import { HubConnection } from "../src/connection.js";

const hubPublicKey = Buffer.from("302a300506032b6570032100" + "01".repeat(32), "hex").toString("base64");
const view = (lastSyncedAt: number) => ({ host: { publicKey: hubPublicKey, name: "example-host", routes: [], state: "active", revoked: false }, sync: "standalone", lastSyncedAt });
let connection: HubConnection, served = view(0);

beforeEach(() => {
  vi.resetAllMocks(); served = view(0);
  const cache = { saveNetworkMembership: vi.fn(async () => {}) };
  connection = new HubConnection({ deviceId: "fixture", name: "device", publicKey: "fixture", hubPublicKey, routes: [] }, cache as never);
  Reflect.set(connection, "token", "fixture-only-session");
  connection.state = { ...connection.state, status: "online", networkAvailable: true, user: { id: "owner", name: "Owner", role: "owner" }, route: { name: "Direct", url: "https://hub.example" } };
  io.fetch.mockImplementation(async (_url: string, route: string) => route === "/api/network" ? Response.json(served) : Response.json({ name: "example-host", revision: 1 }));
});

it("publishes a network view once and skips identical periodic refreshes", async () => {
  const changes = vi.fn(); connection.subscribe(changes);
  await connection.refreshNetwork();
  expect(connection.state.network?.sync).toBe("standalone");
  const published = connection.state.network, afterFirst = changes.mock.calls.length;
  expect(afterFirst).toBeGreaterThan(0);
  // Discovery polls every few seconds; an unchanged view must not re-render subscribers.
  for (let i = 0; i < 3; i++) await connection.refreshNetwork();
  expect(connection.state.network).toBe(published);
  const profileUpdates = changes.mock.calls.length - afterFirst;
  // Only the (unchanged-revision) host profile read may notify; never the network view.
  expect(profileUpdates).toBe(0);
  // A real change (here the sync timestamp) is still published.
  served = view(42);
  await connection.refreshNetwork();
  expect(connection.state.network?.lastSyncedAt).toBe(42);
  expect(changes.mock.calls.length).toBeGreaterThan(afterFirst);
});

it("a confirmed network departure clears that network's diagnosis without hiding the host result", async () => {
  connection.pinNetwork("previous-network", "previous-authority");
  connection.recordRouteSyncResult("host", { ...connection.identity }, true);
  connection.recordRouteSyncResult("network", { ...connection.identity }, true);
  await connection.confirmNetworkChange(view(0) as Parameters<HubConnection["confirmNetworkChange"]>[0]);
  expect(connection.state.routeSync?.host?.limited).toBe(true);
  expect(connection.state.routeSync?.network).toBeUndefined();
});
