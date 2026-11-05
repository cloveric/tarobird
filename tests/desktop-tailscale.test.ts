import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import os from "node:os";
import path from "node:path";
import * as tlsModule from "../src/hub/desktop-tls.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { desktopHost } from "../src/hub/desktop.js";
import { freeDesktopPort, verifyNetworkRoute } from "../src/hub/desktop-network.js";
import { hubServiceCommand, inspectHubService } from "../src/hub/service.js";
import { connectionRoutes } from "../client/src/connection-routes.js";
import { repairRoutes } from "../client/src/RepairHostRoute.js";
import { parsePairingLink, pairingLink } from "../client/src/pairing-link.js";

vi.mock("../src/hub/service.js", async original => ({ ...await original<typeof import("../src/hub/service.js")>(), hubServiceCommand: vi.fn(), inspectHubService: vi.fn() }));
// These route/certificate fixtures use unassigned Tailscale addresses. Actual
// socket allocation and HTTPS reachability are covered by desktop-host.test.ts.
vi.mock("../src/hub/desktop-network.js", () => ({ freeDesktopPort: vi.fn(), verifyNetworkRoute: vi.fn() }));
let directory: string;
const lan = "192.168.10.20", tail = "100.101.102.103", ipv6 = "fd7a:115c:a1e0::1234";
const key = `MCowBQYDK2VwAyEA${"h".repeat(44)}`;
const config = async () => JSON.parse(await readFile(path.join(directory, "config.json"), "utf8"));
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "tb-tailscale-"));
  vi.mocked(inspectHubService).mockResolvedValue({ running: false });
  await initializeHost(directory, "Tailscale fixture");
  await writeFile(path.join(directory, "config.json"), JSON.stringify({ host: "127.0.0.1", port: 8788, instancePort: 8789 }));
  vi.mocked(inspectHubService).mockResolvedValue({ running: true, publicKey: key } as Awaited<ReturnType<typeof inspectHubService>>);
  vi.mocked(hubServiceCommand).mockResolvedValue(undefined);
  vi.mocked(freeDesktopPort).mockResolvedValue(49123);
  vi.mocked(verifyNetworkRoute).mockResolvedValue(undefined);
});
afterEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); await rm(directory, { recursive: true, force: true }); });

it("discovers only assigned Tailscale-range addresses, deduplicated and IPv4 first", () => {
  const address = (address: string, family: "IPv4" | "IPv6" = "IPv4", internal = false) => ({ address, family, internal, netmask: "", mac: "", cidr: null });
  const interfaces = { utun: [address(ipv6, "IPv6"), address(tail), address(tail), address("100.63.255.255"), address("100.128.0.1"), address("100.64.0.1", "IPv4", true)], en0: [address(lan), address("203.0.113.1"), address("fd00::1", "IPv6")], otherVpn: [address("100.70.0.1")] };
  expect(tlsModule.desktopTailscaleAddresses(interfaces)).toEqual([tail, ipv6]);
  expect(tlsModule.desktopTailscaleAddresses({ tailscale0: [address(tail)] })).toEqual([tail]);
});

it("creates a private Tailscale HTTPS invite and carries its trust through scan and LAN repair", async () => {
  vi.spyOn(tlsModule, "desktopTailscaleAddresses").mockReturnValue([tail, ipv6]);
  vi.spyOn(tlsModule, "desktopLanAddresses").mockReturnValue([lan]);
  const result = await desktopHost("tailscale", directory, "unused");
  if (!("routes" in result)) throw Error("missing routes");
  expect(result.routes.map(r => r.url)).toEqual([`https://${tail}:${new URL(result.routes[0]!.url).port}`, `https://[${ipv6}]:${new URL(result.routes[0]!.url).port}`]);
  expect((await config()).tlsListeners.map((l: { host: string; exposure: string }) => [l.host, l.exposure])).toEqual([[tail, "private"], [ipv6, "private"]]);
  const cert = new X509Certificate(await readFile(path.join(directory, "desktop-tls/server.pem")));
  expect(cert.checkIP(tail)).toBe(tail); expect(cert.checkIP(ipv6)).toBe(ipv6);
  const payload = parsePairingLink(pairingLink({ v: 1, kind: "connect", hubPublicKey: key, deployment: "computer", routes: [result.routes[0]!] }));
  if (payload.kind !== "connect") throw Error("invalid QR");
  expect(connectionRoutes(payload.deployment, payload.routes[0]!.url, [], payload.routes[0])).toEqual(payload.routes);
  const relay = { name: "VPS" as const, url: "https://relay.example.com" };
  expect(repairRoutes({ hubPublicKey: key, routes: [{ name: "Direct", url: `https://${lan}:8788` }, relay] }, payload)?.routes).toEqual([...payload.routes, { name: "Direct", url: `https://${lan}:8788` }, relay]);
  expect((await config()).tlsListeners.some((l: { host: string }) => l.host === lan)).toBe(false);
  expect(freeDesktopPort).toHaveBeenCalledWith([tail, ipv6]);
  for (const route of result.routes) expect(verifyNetworkRoute).toHaveBeenCalledWith(route.url, route.certificateAuthority, key);
});

it("rejects an unavailable Tailscale endpoint instead of returning an invite", async () => {
  vi.spyOn(tlsModule, "desktopTailscaleAddresses").mockReturnValue([tail]);
  vi.spyOn(tlsModule, "desktopLanAddresses").mockReturnValue([]);
  vi.mocked(verifyNetworkRoute).mockRejectedValueOnce(new Error("ECONNREFUSED"));
  await expect(desktopHost("tailscale", directory, "unused")).rejects.toThrow("desktop_host_tailscale_not_listening");
  expect(JSON.parse(await readFile(path.join(directory, "desktop-network-port.json"), "utf8"))).toBe(49123);
});

it("keeps LAN and Tailscale listeners, port and CA when switching invites, without redundant restarts", async () => {
  vi.spyOn(tlsModule, "desktopTailscaleAddresses").mockReturnValue([tail]);
  vi.spyOn(tlsModule, "desktopLanAddresses").mockReturnValue([lan]);
  const unrelated = { host: "127.0.0.2", exposure: "private", port: 9898, tls: { cert: path.join(directory, "manual.pem"), key: path.join(directory, "manual-key.pem") } };
  await writeFile(path.join(directory, "config.json"), JSON.stringify({ ...await config(), tlsListeners: [unrelated] }));
  const first = await desktopHost("network", directory, "unused");
  const next = await desktopHost("tailscale", directory, "unused");
  const again = await desktopHost("network", directory, "unused");
  if (!("routes" in first) || !("routes" in next) || !("routes" in again)) throw Error("missing routes");
  expect(again).toEqual(first);
  expect(next.routes[0]!.certificateAuthority).toBe(first.routes[0]!.certificateAuthority);
  expect(new URL(next.routes[0]!.url).port).toBe(new URL(first.routes[0]!.url).port);
  expect((await config()).tlsListeners[0]).toEqual(unrelated);
  expect((await config()).tlsListeners.map((l: { host: string }) => l.host)).toEqual([unrelated.host, lan, tail]);
  expect(vi.mocked(hubServiceCommand).mock.calls.map(call => call[0])).toEqual(["restart", "restart", "start"]);
  const cert = new X509Certificate(await readFile(path.join(directory, "desktop-tls/server.pem")));
  expect(cert.checkIP(lan)).toBe(lan); expect(cert.checkIP(tail)).toBe(tail);
});

it("starts locally while Tailscale is disconnected and restores only the opted-in network with the same endpoint", async () => {
  const addresses = vi.spyOn(tlsModule, "desktopTailscaleAddresses").mockReturnValue([tail]);
  vi.spyOn(tlsModule, "desktopLanAddresses").mockReturnValue([lan]);
  const first = await desktopHost("tailscale", directory, "unused");
  const configuredListeners = (await config()).tlsListeners;
  addresses.mockReturnValue([]);
  vi.mocked(inspectHubService).mockResolvedValueOnce({ running: false } as Awaited<ReturnType<typeof inspectHubService>>);
  await desktopHost("start", directory, "unused");
  // Offline listeners remain configured so the live Hub can bind them when
  // the interface returns, without requiring another desktop start.
  expect((await config()).tlsListeners).toEqual(configuredListeners);
  addresses.mockReturnValue([tail]);
  vi.mocked(inspectHubService).mockResolvedValueOnce({ running: false } as Awaited<ReturnType<typeof inspectHubService>>);
  await desktopHost("start", directory, "unused");
  expect((await config()).tlsListeners.map((l: { host: string }) => l.host)).toEqual([tail]);
  expect(await desktopHost("tailscale", directory, "unused")).toEqual(first);
});

it("does not change config when no Tailscale address exists and rolls back failed network restarts", async () => {
  const addresses = vi.spyOn(tlsModule, "desktopTailscaleAddresses").mockReturnValue([]);
  vi.spyOn(tlsModule, "desktopLanAddresses").mockReturnValue([lan]);
  const original = await config();
  await expect(desktopHost("tailscale", directory, "unused")).rejects.toThrow("desktop_host_no_tailscale");
  expect(await config()).toEqual(original); expect(hubServiceCommand).not.toHaveBeenCalled();
  await desktopHost("network", directory, "unused");
  const previous = await config(), cert = await readFile(path.join(directory, "desktop-tls/server.pem"), "utf8");
  addresses.mockReturnValue([tail]);
  vi.mocked(hubServiceCommand).mockRejectedValueOnce(new Error("bind_failed"));
  await expect(desktopHost("tailscale", directory, "unused")).rejects.toThrow("bind_failed");
  expect(await config()).toEqual(previous);
  expect(await readFile(path.join(directory, "desktop-tls/server.pem"), "utf8")).toBe(cert);
  await expect(readFile(path.join(directory, "desktop-tailscale-enabled.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
