import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tlsModule from "../src/hub/desktop-tls.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { desktopHost } from "../src/hub/desktop.js";
import { freeDesktopPort, verifyNetworkRoute } from "../src/hub/desktop-network.js";
import { hubServiceCommand, inspectHubService } from "../src/hub/service.js";

vi.mock("../src/hub/service.js", async original => ({ ...await original<typeof import("../src/hub/service.js")>(), hubServiceCommand: vi.fn(), inspectHubService: vi.fn() }));
// Candidate addresses are synthetic, so health checks are scripted per address.
// Port allocation is scripted too, except where a case restores the real probe.
// Real sockets, the real Host and real HTTPS identity are in desktop-host.test.ts.
vi.mock("../src/hub/desktop-network.js", async original => ({ ...await original<typeof import("../src/hub/desktop-network.js")>(), freeDesktopPort: vi.fn(), verifyNetworkRoute: vi.fn() }));

const wifi = "192.168.10.20", broken = "10.99.0.2";
// The unverifiable candidate is fifth: before all candidates were retained it
// was never prepared, so it could not affect the other four.
const candidates = ["192.168.50.2", wifi, "172.16.10.1", "10.10.10.2", broken];
const tail = "100.64.0.1", tailIpv6 = "fd7a:115c:a1e0::1234";
const key = `MCowBQYDK2VwAyEA${"h".repeat(44)}`;
const port = 23456;
let directory: string;
const config = async () => JSON.parse(await readFile(path.join(directory, "config.json"), "utf8"));
const host = (url: string) => new URL(url).hostname.replace(/^\[|\]$/g, "");
const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
const failing = (...hosts: string[]) => vi.mocked(verifyNetworkRoute).mockImplementation(async url => { if (hosts.includes(host(url))) throw refused(); });
const verified = () => vi.mocked(verifyNetworkRoute).mock.calls.map(call => host(call[0]));
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "tb-lan-resilience-"));
  vi.mocked(inspectHubService).mockResolvedValue({ running: false });
  await initializeHost(directory, "LAN resilience fixture");
  await writeFile(path.join(directory, "config.json"), JSON.stringify({ host: "127.0.0.1", port: 8788, instancePort: 8789 }));
  vi.mocked(inspectHubService).mockResolvedValue({ running: true, publicKey: key } as Awaited<ReturnType<typeof inspectHubService>>);
  vi.mocked(hubServiceCommand).mockResolvedValue(undefined);
  vi.mocked(freeDesktopPort).mockResolvedValue(port);
  vi.mocked(verifyNetworkRoute).mockResolvedValue(undefined);
  vi.spyOn(tlsModule, "desktopLanAddresses").mockReturnValue(candidates);
  vi.spyOn(tlsModule, "desktopTailscaleAddresses").mockReturnValue([]);
});
afterEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); await rm(directory, { recursive: true, force: true }); });

describe("desktop candidate health", () => {
  it("prepares the verified LAN candidates and discloses how many were omitted", async () => {
    failing(broken);
    const result = await desktopHost("network", directory, "unused");
    if (!("routes" in result)) throw Error("missing LAN routes");
    const healthy = candidates.filter(candidate => candidate !== broken);
    expect(result.routes.map(route => host(route.url))).toEqual(healthy);
    expect(result).toMatchObject({ available: true, running: true, publicKey: key, unavailableRouteCount: 1 });
    // Each candidate, including the omitted one, was checked against the same
    // private CA and Host identity; nothing unchecked is returned.
    const authority = result.routes[0]!.certificateAuthority;
    expect(vi.mocked(verifyNetworkRoute).mock.calls).toEqual(candidates.map(candidate => [`https://${candidate}:${port}`, authority, key]));
    for (const route of result.routes) expect(route).toEqual({ name: "Direct", url: `https://${host(route.url)}:${port}`, certificateAuthority: authority });
    // The absent endpoint stays an optional listener that may recover later.
    expect((await config()).tlsListeners.map((listener: { host: string; port: number; exposure: string }) => [listener.host, listener.port, listener.exposure])).toEqual(candidates.map(candidate => [candidate, port, "public"]));
    expect(JSON.parse(await readFile(path.join(directory, "desktop-network-port.json"), "utf8"))).toBe(port);
  });

  it("adds no disclosure field when every candidate is verified", async () => {
    const result = await desktopHost("network", directory, "unused");
    if (!("routes" in result)) throw Error("missing LAN routes");
    expect(result.routes.map(route => host(route.url))).toEqual(candidates);
    expect(result).not.toHaveProperty("unavailableRouteCount");
  });

  it("still fails when no candidate can be verified", async () => {
    failing(...candidates);
    const error = await desktopHost("network", directory, "unused").then(() => undefined, (cause: Error) => cause);
    expect(error?.message).toBe("desktop_host_lan_not_listening");
    expect(error?.cause).toMatchObject({ code: "ECONNREFUSED" });
    expect(verified()).toEqual(candidates);
  });

  it("applies the same rule to Tailscale candidates", async () => {
    vi.spyOn(tlsModule, "desktopLanAddresses").mockReturnValue([]);
    vi.spyOn(tlsModule, "desktopTailscaleAddresses").mockReturnValue([tail, tailIpv6]);
    failing(tailIpv6);
    const result = await desktopHost("tailscale", directory, "unused");
    if (!("routes" in result)) throw Error("missing Tailscale routes");
    expect(result.routes.map(route => [route.name, route.url])).toEqual([["Tailscale", `https://${tail}:${port}`]]);
    expect(result).toMatchObject({ unavailableRouteCount: 1 });
    expect((await config()).tlsListeners.map((listener: { host: string; exposure: string }) => [listener.host, listener.exposure])).toEqual([[tail, "private"], [tailIpv6, "private"]]);
    failing(tail, tailIpv6);
    await expect(desktopHost("tailscale", directory, "unused")).rejects.toThrow("desktop_host_tailscale_not_listening");
  });
});

describe("explicit CLI address selection", () => {
  it("requires exactly the selected address and never falls back to a healthy one", async () => {
    failing(broken);
    await expect(desktopHost("network", directory, "unused", undefined, { selectAddress: () => broken })).rejects.toThrow("desktop_host_lan_not_listening");
    expect(verified()).toEqual([broken]);
  });

  it("verifies only the selected address and reports no omitted candidates", async () => {
    failing(broken);
    const result = await desktopHost("network", directory, "unused", undefined, { selectAddress: () => wifi });
    if (!("routes" in result)) throw Error("missing LAN route");
    expect(result.routes.map(route => host(route.url))).toEqual([wifi]);
    expect(result).not.toHaveProperty("unavailableRouteCount");
    expect(verified()).toEqual([wifi]);
  });
});

describe("first port allocation after an interface disappears", () => {
  const vanished = "192.0.2.123", reachable = "127.0.0.1";
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("../src/hub/desktop-network.js")>("../src/hub/desktop-network.js");
    vi.mocked(freeDesktopPort).mockImplementation(actual.freeDesktopPort);
    vi.spyOn(tlsModule, "desktopLanAddresses").mockReturnValue([vanished, reachable]);
    failing(vanished);
  });

  it("prepares the remaining candidate with a port actually probed on it", async () => {
    const result = await desktopHost("network", directory, "unused");
    if (!("routes" in result)) throw Error("missing LAN routes");
    const allocated = Number(new URL(result.routes[0]!.url).port);
    expect(allocated).toBeGreaterThanOrEqual(20_000); expect(allocated).toBeLessThan(32_768);
    expect(result.routes.map(route => route.url)).toEqual([`https://${reachable}:${allocated}`]);
    expect(result).toMatchObject({ unavailableRouteCount: 1 });
    expect(JSON.parse(await readFile(path.join(directory, "desktop-network-port.json"), "utf8"))).toBe(allocated);
    expect((await config()).tlsListeners.map((listener: { host: string; port: number }) => [listener.host, listener.port])).toEqual([[vanished, allocated], [reachable, allocated]]);
  });

  it("lets the CLI select the remaining address, and rejects the vanished one without a fallback", async () => {
    const result = await desktopHost("network", directory, "unused", undefined, { selectAddress: () => reachable });
    if (!("routes" in result)) throw Error("missing LAN route");
    expect(result.routes.map(route => host(route.url))).toEqual([reachable]);
    expect(result).not.toHaveProperty("unavailableRouteCount");
    vi.mocked(verifyNetworkRoute).mockClear();
    await expect(desktopHost("network", directory, "unused", undefined, { selectAddress: () => vanished })).rejects.toThrow("desktop_host_lan_not_listening");
    expect(verified()).toEqual([vanished]);
  });

  it("still fails without saving a port or restarting when every interface disappeared", async () => {
    vi.spyOn(tlsModule, "desktopLanAddresses").mockReturnValue([vanished, "192.0.2.124"]);
    await expect(desktopHost("network", directory, "unused")).rejects.toMatchObject({ code: "EADDRNOTAVAIL" });
    await expect(readFile(path.join(directory, "desktop-network-port.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await config()).tlsListeners ?? []).toEqual([]);
    expect(hubServiceCommand).not.toHaveBeenCalled();
    expect(verifyNetworkRoute).not.toHaveBeenCalled();
  });
});
