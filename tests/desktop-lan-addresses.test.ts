import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import os, { networkInterfaces } from "node:os";
import path from "node:path";
import { desktopLanAddresses } from "../src/hub/desktop-tls.js";
import { desktopHost } from "../src/hub/desktop.js";
import { freeDesktopPort, verifyNetworkRoute } from "../src/hub/desktop-network.js";
import { hubServiceCommand, inspectHubService } from "../src/hub/service.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { pairingLink, parsePairingLink } from "../client/src/pairing-link.js";

vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), networkInterfaces: vi.fn() }));
vi.mock("../src/hub/service.js", async original => ({ ...await original<typeof import("../src/hub/service.js")>(), hubServiceCommand: vi.fn(), inspectHubService: vi.fn() }));
// Synthetic interfaces are not assigned to the test machine. Certificate and
// invite encoding are real; socket admission has separate desktop-host tests.
vi.mock("../src/hub/desktop-network.js", () => ({ freeDesktopPort: vi.fn(), verifyNetworkRoute: vi.fn() }));
const address = (address: string, family: "IPv4" | "IPv6" = "IPv4", internal = false) => ({ address, family, internal, netmask: "", mac: "", cidr: null });
const wifi = "192.168.10.20";
const multipleInterfaces = {
  bridge0: [address("192.168.50.2")],
  bridge1: [address("172.16.10.1"), address("172.16.11.1")],
  vpn0: [address("10.10.10.2")],
  en0: [address(wifi)],
};
const candidates = Object.values(multipleInterfaces).flat().map(value => value.address);
let directory: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

it("does not hide Wi-Fi behind four bridge or VPN addresses", () => {
  vi.mocked(networkInterfaces).mockReturnValue(multipleInterfaces);
  expect(desktopLanAddresses()).toEqual(candidates);
});

it("keeps both ordinary LAN interfaces, deduplicates, and retains private IPv4 admission", () => {
  vi.mocked(networkInterfaces).mockReturnValue({
    bridge0: [address("192.168.50.2"), address("192.168.50.2")],
    en0: [address(wifi), address(wifi, "IPv4", true), address("203.0.113.10"), address("169.254.1.2"), address("100.101.102.103"), address("fd00::1", "IPv6")],
    lo0: [address("127.0.0.1", "IPv4", true)],
  });
  expect(desktopLanAddresses()).toEqual(["192.168.50.2", wifi]);
});

it("returns no LAN candidates when all interfaces are absent", () => {
  vi.mocked(networkInterfaces).mockReturnValue({ en0: undefined });
  expect(desktopLanAddresses()).toEqual([]);
});

it("prepares a later Wi-Fi candidate for desktop and explicit CLI selection with the same port and CA", async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "tb-lan-discovery-"));
  const key = `MCowBQYDK2VwAyEA${"h".repeat(44)}`;
  vi.mocked(inspectHubService).mockResolvedValue({ running: false });
  await initializeHost(directory, "LAN fixture");
  await writeFile(path.join(directory, "config.json"), JSON.stringify({ host: "127.0.0.1", port: 8788, instancePort: 8789 }));
  vi.mocked(inspectHubService).mockResolvedValue({ running: true, publicKey: key } as Awaited<ReturnType<typeof inspectHubService>>);
  vi.mocked(hubServiceCommand).mockResolvedValue(undefined);
  vi.mocked(freeDesktopPort).mockResolvedValue(23456);
  vi.mocked(verifyNetworkRoute).mockResolvedValue(undefined);
  vi.mocked(networkInterfaces).mockReturnValue(multipleInterfaces);

  const desktop = await desktopHost("network", directory, "unused");
  if (!("routes" in desktop)) throw Error("missing LAN routes");
  expect(desktop.routes.map(route => new URL(route.url).hostname)).toEqual(candidates);
  const selected = desktop.routes.find(route => new URL(route.url).hostname === wifi)!;
  const certificate = new X509Certificate(await readFile(path.join(directory, "desktop-tls/server.pem")));
  for (const candidate of candidates) expect(certificate.checkIP(candidate)).toBe(candidate);
  expect(freeDesktopPort).toHaveBeenCalledWith(candidates);
  for (const route of desktop.routes) expect(verifyNetworkRoute).toHaveBeenCalledWith(route.url, route.certificateAuthority, key);
  const config = JSON.parse(await readFile(path.join(directory, "config.json"), "utf8"));
  expect(config.tlsListeners.map((listener: { host: string; exposure: string }) => [listener.host, listener.exposure])).toEqual(candidates.map(host => [host, "public"]));

  const cli = await desktopHost("network", directory, "unused", undefined, { selectAddress: () => wifi });
  expect(cli).toMatchObject({ routes: [selected] });
  expect(vi.mocked(hubServiceCommand).mock.calls.map(call => call[0])).toEqual(["restart", "start"]);
  const decoded = parsePairingLink(pairingLink({ v: 1, kind: "connect", hubPublicKey: key, deployment: "computer", routes: [selected] }));
  expect(decoded).toMatchObject({ kind: "connect", routes: [selected] });
});
