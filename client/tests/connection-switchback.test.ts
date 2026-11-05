import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientCache, Identity } from "../src/storage.js";

const io = vi.hoisted(() => ({ socket: vi.fn(), fetch: vi.fn() }));
vi.mock("../src/storage.js", () => ({ cache: {}, ClientCache: class {}, defaultPreferences: {} }));
vi.mock("../src/identity.js", () => ({ randomNonce: () => "fixture-nonce" }));
vi.mock("../src/transport.js", () => ({ hubSocket: io.socket, hubFetch: io.fetch, usesPinnedTransport: () => true }));
import { HubConnection } from "../src/connection.js";

beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers(); vi.stubGlobal("document", { get hidden() { return false; }, get visibilityState() { return "visible"; }, hasFocus: () => true }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllTimers(); vi.useRealTimers(); });
const direct = { name: "Direct" as const, url: "https://direct.example" };
const relay = { name: "VPS" as const, url: "https://relay.example" };
const socket = () => ({ readyState: 1, send: vi.fn(), close: vi.fn() });
function fixture() {
  const identity: Identity = { deviceId: "fixture", name: "Fixture", publicKey: "fixture", hubPublicKey: "trusted", routes: [direct, relay] };
  const cache = { outbox: vi.fn().mockResolvedValue([]), saveIdentityRoutes: vi.fn().mockResolvedValue(undefined) };
  const connection = new HubConnection(identity, cache as unknown as ClientCache), ws = socket();
  connection.state = { ...connection.state, status: "online", route: relay };
  Reflect.set(connection, "syncing", false); Reflect.set(connection, "ws", ws);
  io.socket.mockImplementation(socket);
  // The optional path is meaningfully faster, independent of route category.
  io.fetch.mockImplementation(async (url: string) => {
    await new Promise(resolve => setTimeout(resolve, url === direct.url ? 20 : 180));
    return Response.json({ ok: true, publicKey: "trusted" });
  });
  const probe = () => (Reflect.get(connection, "probePreferred") as (generation: number) => Promise<void>).call(connection, Reflect.get(connection, "generation"));
  const connect = () => (Reflect.get(connection, "connect") as () => Promise<void>).call(connection);
  const healthyProbe = async () => { await vi.advanceTimersByTimeAsync(30_000); const pending = probe(); await vi.advanceTimersByTimeAsync(180); await pending; };
  return { connection, identity, cache, ws, probe, connect, healthyProbe };
}

it("switches only after three idle observations spanning a minute of better measured quality", async () => {
  const { connection, ws, connect, healthyProbe } = fixture();
  await healthyProbe(); await healthyProbe();
  expect(ws.close).not.toHaveBeenCalled();
  await healthyProbe();
  expect(connection.state.routeHealth).toEqual(expect.arrayContaining([{ url: direct.url, status: "reachable", latency: 20 }]));
  expect(ws.close).toHaveBeenCalledWith(1000, "preferred_route_recovered");
  const pending = connect(); await vi.advanceTimersByTimeAsync(450); await pending;
  expect(io.socket).toHaveBeenCalledWith(direct.url, "trusted");
});

it("does not cut a transfer that starts while the idle outbox check is pending", async () => {
  const { connection, cache, ws, probe, healthyProbe } = fixture();
  await healthyProbe(); await healthyProbe();
  let finish!: (entries: unknown[]) => void;
  cache.outbox.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await vi.advanceTimersByTimeAsync(30_000); const pending = probe(); await vi.advanceTimersByTimeAsync(180);
  const release = connection.beginFileTransfer(); finish([]); await pending;
  expect(ws.close).not.toHaveBeenCalled();
  release(); await vi.advanceTimersByTimeAsync(1501); await healthyProbe();
  expect(ws.close).toHaveBeenCalledWith(1000, "preferred_route_recovered");
});

it.each(["streaming", "syncing", "sending", "queued", "mutation"])("waits for %s work before switching", async busy => {
  const { connection, cache, ws, healthyProbe } = fixture();
  if (busy === "streaming") Reflect.set(connection, "activeMessages", new Set(["reply"]));
  if (busy === "syncing") Reflect.set(connection, "syncing", true);
  if (busy === "sending") Reflect.set(connection, "inflight", "message");
  if (busy === "mutation") Reflect.set(connection, "httpMutations", 1);
  if (busy === "queued") cache.outbox.mockResolvedValue([{ id: "message" }]);
  await healthyProbe(); await healthyProbe(); await healthyProbe();
  expect(ws.close).not.toHaveBeenCalled();
  Reflect.set(connection, "activeMessages", new Set()); Reflect.set(connection, "syncing", false); Reflect.set(connection, "inflight", undefined);
  Reflect.set(connection, "httpMutations", 0);
  cache.outbox.mockResolvedValue([]); await healthyProbe();
  expect(ws.close).toHaveBeenCalledWith(1000, "preferred_route_recovered");
});

it.each(["socket", "routes", "outbox"])("ignores an idle queue result after the %s changes", async change => {
  const { connection, identity, cache, ws, probe, healthyProbe } = fixture();
  await healthyProbe(); await healthyProbe();
  let finish!: (entries: unknown[]) => void;
  cache.outbox.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await vi.advanceTimersByTimeAsync(30_000); const pending = probe(); await vi.advanceTimersByTimeAsync(180);
  const replacement = socket();
  if (change === "socket") { Reflect.set(connection, "generation", 1); Reflect.set(connection, "ws", replacement); }
  if (change === "routes") await connection.updateRoutes([relay]);
  if (change === "outbox") Reflect.set(connection, "outboxVersion", 1);
  finish([]); await pending;
  expect(ws.close).not.toHaveBeenCalled(); expect(replacement.close).not.toHaveBeenCalled();
  expect(identity.routes).toHaveLength(change === "routes" ? 1 : 2);
});

it.each(["edited", "expired", "superseded"])("discards an %s handoff before reconnecting", async change => {
  const { connection, ws, connect, healthyProbe } = fixture();
  await healthyProbe(); await healthyProbe(); await healthyProbe();
  expect(ws.close).toHaveBeenCalledWith(1000, "preferred_route_recovered");
  if (change === "edited") await connection.updateRoutes([relay]);
  if (change === "expired") await vi.advanceTimersByTimeAsync(10_001);
  if (change === "superseded") Reflect.set(connection, "generation", 1);
  io.fetch.mockImplementation(async (url: string) => { if (url === direct.url) throw new Error("unavailable"); return Response.json({ ok: true, publicKey: "trusted" }); });
  const pending = connect(); await vi.advanceTimersByTimeAsync(450); await pending;
  expect(io.socket).toHaveBeenCalledWith(relay.url, "trusted");
});

it("falls back after a failed preferred socket instead of reusing the handoff", async () => {
  const { connection, connect, healthyProbe } = fixture();
  await healthyProbe(); await healthyProbe(); await healthyProbe(); await connect();
  expect(io.socket).toHaveBeenLastCalledWith(direct.url, "trusted");
  // The same failure path used by an unsuccessful authenticated handshake.
  (Reflect.get(connection, "failRoute") as () => void).call(connection);
  const pending = connect(); await vi.advanceTimersByTimeAsync(450); await pending;
  expect(io.socket).toHaveBeenLastCalledWith(relay.url, "trusted");
});

it("never switches to a preferred route that reports a different host key", async () => {
  const { connection, ws, healthyProbe } = fixture();
  io.fetch.mockImplementation(async (url: string) => Response.json({ ok: true, publicKey: url === direct.url ? "untrusted" : "trusted" }));
  await healthyProbe(); await healthyProbe(); await healthyProbe();
  expect(ws.close).not.toHaveBeenCalled();
  expect(connection.state.routeHealth).toContainEqual({ url: direct.url, status: "wrong-hub", failure: "identity-mismatch" });
});

it("still connects promptly to a verified relay during an ordinary cold start", async () => {
  const { connect } = fixture();
  io.fetch.mockImplementation(async (url: string) => { await new Promise(resolve => setTimeout(resolve, url === direct.url ? 6000 : 20)); return Response.json({ ok: true, publicKey: "trusted" }); });
  const pending = connect(); await vi.advanceTimersByTimeAsync(220); await pending;
  expect(io.socket).toHaveBeenCalledWith(relay.url, "trusted");
});


it("backs off unsuccessful preferred-route checks without changing the active socket", async () => {
  const { connection, ws } = fixture();
  io.fetch.mockImplementation(async (url: string) => {
    if (url === direct.url) throw new Error("network unavailable");
    return Response.json({ ok: true, publicKey: "trusted" });
  });
  const poll = () => (Reflect.get(connection, "pollPreferredRoute") as (generation: number) => Promise<void>).call(connection, Reflect.get(connection, "generation"));
  for (let tick = 0; tick < 80; tick++) { await poll(); await vi.advanceTimersByTimeAsync(1500); }
  expect(io.fetch.mock.calls.filter(([url]) => url === direct.url).length).toBeLessThanOrEqual(8);
  expect(ws.close).not.toHaveBeenCalled();
  // An actual foreground/network resume probes promptly instead of waiting for backoff.
  const before = io.fetch.mock.calls.length;
  connection.resume(); await vi.advanceTimersByTimeAsync(0);
  expect(io.fetch.mock.calls.length).toBeGreaterThan(before);
});

it("skips background route scans and keeps best-route refreshes infrequent", async () => {
  const { connection } = fixture(); connection.state.route = direct;
  io.fetch.mockResolvedValue(Response.json({ ok: true, publicKey: "trusted" }));
  const poll = () => (Reflect.get(connection, "pollPreferredRoute") as (generation: number) => Promise<void>).call(connection, Reflect.get(connection, "generation"));
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  await poll(); expect(io.fetch).not.toHaveBeenCalled();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  for (let tick = 0; tick < 40; tick++) { await poll(); await vi.advanceTimersByTimeAsync(1500); }
  expect(io.fetch.mock.calls.filter(([url]) => url === direct.url)).toHaveLength(1);
});

it("does not let a newly recovered or slightly faster path interrupt a healthy connection", async () => {
  const { connection, ws, healthyProbe } = fixture();
  io.fetch.mockImplementation(async (url: string) => { await new Promise(resolve => setTimeout(resolve, url === direct.url ? 160 : 180)); return Response.json({ ok: true, publicKey: "trusted" }); });
  for (let i = 0; i < 4; i++) await healthyProbe();
  expect(ws.close).not.toHaveBeenCalled();
  Reflect.set(connection, "lastRouteChange", Date.now());
  io.fetch.mockImplementation(async (url: string) => { await new Promise(resolve => setTimeout(resolve, url === direct.url ? 20 : 180)); return Response.json({ ok: true, publicKey: "trusted" }); });
  for (let i = 0; i < 4; i++) await healthyProbe();
  expect(ws.close).not.toHaveBeenCalled();
});

it("coalesces foreground signals while keeping the working socket and HTTP epoch", async () => {
  const { connection, ws } = fixture(); connection.state.route = direct;
  io.fetch.mockImplementation(async () => Response.json({ ok: true, publicKey: "trusted" }));
  const httpEpoch = Reflect.get(connection, "httpEpoch");
  for (let i = 0; i < 10; i++) { connection.resume(); await vi.advanceTimersByTimeAsync(0); }
  expect(io.fetch).toHaveBeenCalledTimes(2);
  expect(ws.close).not.toHaveBeenCalled();
  expect(Reflect.get(connection, "httpEpoch")).toBe(httpEpoch);
  expect(ws.send.mock.calls.every(([frame]) => JSON.parse(frame).type === "ping")).toBe(true);
});

it.each(["route", "generation", "closed"])("does not publish or schedule a stale %s probe", async change => {
  const { connection, ws } = fixture();
  const poll = (generation = Reflect.get(connection, "generation")) => (Reflect.get(connection, "pollPreferredRoute") as (generation: number) => Promise<void>).call(connection, generation);
  const pending = poll();
  await vi.advanceTimersByTimeAsync(20);
  if (change === "route") await connection.updateRoutes([relay]);
  if (change === "generation") Reflect.set(connection, "generation", 1);
  if (change === "closed") Reflect.set(connection, "closed", true);
  const scheduled = Reflect.get(connection, "preferredProbeAt"), health = connection.state.routeHealth;
  await vi.advanceTimersByTimeAsync(450); await pending;
  expect(connection.state.routeHealth).toEqual(health);
  expect(Reflect.get(connection, "preferredProbeAt")).toBe(scheduled);
  expect(ws.close).not.toHaveBeenCalled();
  const requests = io.fetch.mock.calls.length;
  if (change !== "route") { await poll(0); expect(io.fetch).toHaveBeenCalledTimes(requests); }
});

it("does not scan while hidden or switch a route until three fresh verified samples", async () => {
  const { connection, ws } = fixture();
  const hidden = vi.spyOn(document, "hidden", "get");
  hidden.mockReturnValue(true);
  connection.resume(); await vi.advanceTimersByTimeAsync(300_000);
  expect(io.fetch).not.toHaveBeenCalled();
  hidden.mockReturnValue(false);
  connection.resume(); await vi.advanceTimersByTimeAsync(450);
  expect(ws.close).not.toHaveBeenCalled();
  const poll = () => (Reflect.get(connection, "pollPreferredRoute") as (generation: number) => Promise<void>).call(connection, Reflect.get(connection, "generation"));
  await vi.advanceTimersByTimeAsync(30_000); let pending = poll(); await vi.advanceTimersByTimeAsync(450); await pending;
  expect(ws.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000); pending = poll(); await vi.advanceTimersByTimeAsync(450); await pending;
  expect(ws.close).toHaveBeenCalledOnce();
});

it("does not switch when the document hides during a pending preferred probe", async () => {
  const { connection, ws, probe, healthyProbe } = fixture();
  await healthyProbe(); await healthyProbe();
  await vi.advanceTimersByTimeAsync(30_000);
  const pending = probe();
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  await vi.advanceTimersByTimeAsync(450); await pending;
  expect(ws.close).not.toHaveBeenCalled();
});

it("discards healthy samples from before a long suspended interval", async () => {
  const { connection, ws } = fixture();
  const poll = () => (Reflect.get(connection, "pollPreferredRoute") as (generation: number) => Promise<void>).call(connection, Reflect.get(connection, "generation"));
  const sample = async () => { const pending = poll(); await vi.advanceTimersByTimeAsync(450); await pending; };
  await sample(); await vi.advanceTimersByTimeAsync(30_000); await sample();
  expect(ws.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(300_000);
  connection.resume(); await vi.advanceTimersByTimeAsync(450);
  expect(ws.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000); await sample();
  expect(ws.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000); await sample();
  expect(ws.close).toHaveBeenCalledOnce();
});

it.each(["focus", "visibilitychange"])("immediately checks routes on browser %s without replacing the live socket", async event => {
  const { connection, ws } = fixture(); connection.state.route = direct;
  io.fetch.mockImplementation(async () => Response.json({ ok: true, publicKey: "trusted" }));
  Reflect.set(connection, "preferredProbeAt", Date.now() + 30_000);
  (Reflect.get(connection, "presence") as (event: Event) => void)(new Event(event));
  await vi.advanceTimersByTimeAsync(0);
  expect(io.fetch).toHaveBeenCalledTimes(2);
  expect(ws.close).not.toHaveBeenCalled();
  expect(ws.send.mock.calls.every(([frame]) => ["presence", "ping"].includes(JSON.parse(frame).type))).toBe(true);
});

it("tries an unfailed fallback before a previously failed WebSocket with healthy HTTP and expired cooldown", async () => {
  const { connection, identity, connect } = fixture();
  const third = { name: "VPS" as const, url: "https://third.example" };
  identity.routes = [direct, relay, third];
  Reflect.set(connection, "failedRoutes", new Map([
    [direct.url, { attempts: 1, until: Date.now() - 1000 }],
    [relay.url, { attempts: 1, until: Date.now() + 5000 }],
  ]));
  io.fetch.mockImplementation(async () => Response.json({ ok: true, publicKey: "trusted" }));
  await connect();
  expect(io.socket).toHaveBeenCalledWith(third.url, "trusted");
});

it("bounds parallel probes per host and gives the last working route the first slot", async () => {
  const { connection, identity } = fixture();
  identity.routes = Array.from({ length: 10 }, (_, i) => ({ name: "VPS" as const, url: `https://relay${i}.example` }));
  Reflect.set(connection, "lastConnectedUrl", identity.routes[8]!.url);
  const pending: (() => void)[] = []; let active = 0, peak = 0;
  io.fetch.mockImplementation(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise<void>(resolve => pending.push(resolve)); active--;
    return Response.json({ ok: true, publicKey: "trusted" });
  });
  const selecting = (Reflect.get(connection, "selectRoute") as () => Promise<unknown>).call(connection);
  expect(io.fetch).toHaveBeenCalledTimes(4);
  expect(io.fetch.mock.calls[0]?.[0]).toBe(identity.routes[8]!.url);
  while (io.fetch.mock.calls.length < 10 || active) { pending.splice(0).forEach(resolve => resolve()); await vi.advanceTimersByTimeAsync(0); }
  await selecting;
  expect(peak).toBe(4); expect(connection.state.routeHealth).toHaveLength(10);
});

it("stops dispatching queued probes after the configured routes are replaced", async () => {
  const { connection, identity } = fixture();
  identity.routes = Array.from({ length: 8 }, (_, i) => ({ name: "VPS" as const, url: `https://relay${i}.example` }));
  const pending: (() => void)[] = [];
  io.fetch.mockImplementation(async () => { await new Promise<void>(resolve => pending.push(resolve)); return Response.json({ ok: true, publicKey: "trusted" }); });
  const selecting = (Reflect.get(connection, "selectRoute") as () => Promise<unknown>).call(connection);
  identity.routes = [relay]; pending.forEach(resolve => resolve()); await selecting;
  expect(io.fetch).toHaveBeenCalledTimes(4); expect(connection.state.routeHealth).toBeUndefined();
});

it("does not hand off a live HTTP mutation, and never replays it to another route", async () => {
  const { connection, ws, healthyProbe } = fixture();
  await healthyProbe(); await healthyProbe();
  Reflect.set(connection, "token", "fixture-token");
  const fetch = io.fetch.getMockImplementation()!; let finish!: () => void;
  io.fetch.mockImplementation(async (...args) => {
    if (args[1] !== "/health") { await new Promise<void>(resolve => { finish = resolve; }); return Response.json({ saved: true }); }
    return fetch(...args);
  });
  const saving = (Reflect.get(connection, "httpRequest") as (path: string, init: RequestInit) => Promise<unknown>).call(connection, "/api/fixture-save", { method: "POST", body: "{}" });
  const epoch = Reflect.get(connection, "httpEpoch");
  await healthyProbe(); expect(ws.close).not.toHaveBeenCalled(); expect(epoch.signal.aborted).toBe(false);
  finish(); expect(await saving).toEqual({ saved: true });
  await healthyProbe(); expect(ws.close).toHaveBeenCalledOnce();
  expect(io.fetch.mock.calls.filter(call => call[1] === "/api/fixture-save")).toHaveLength(1);
});

it("drains a canceled early-connect batch before background probes can exceed the per-host bound", async () => {
  const { connection, identity } = fixture();
  identity.routes = Array.from({ length: 8 }, (_, i) => ({ name: "VPS" as const, url: `https://relay${i}.example` }));
  let active = 0, peak = 0;
  const pending: (() => void)[] = [];
  io.fetch.mockImplementation(async (_url, _path, _key, init) => {
    active++; peak = Math.max(peak, active);
    await new Promise<void>((resolve, reject) => { pending.push(resolve); init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }); }).finally(() => { active--; });
    return Response.json({ ok: true, publicKey: "trusted" });
  });
  const select = (early: boolean) => (Reflect.get(connection, "selectRoute") as (early: boolean) => Promise<unknown>).call(connection, early);
  const first = select(true); pending.shift()!(); await vi.advanceTimersByTimeAsync(200); await first;
  expect(active).toBe(4);
  const next = select(false); await vi.advanceTimersByTimeAsync(0);
  while (active) { pending.splice(0).forEach(resolve => resolve()); await vi.advanceTimersByTimeAsync(0); }
  await next; expect(peak).toBe(4);
});
