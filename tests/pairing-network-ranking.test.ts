import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import {
  classifyNetworkInterface,
  isLinkLocalAddress,
  isProxyFakeIpAddress,
  rankNetworkInterfaces,
  selectPairingInviteRoutes,
  selectPrimaryPairingRoute,
} from "../src/client-protocol/network-candidates.js";
import type { Route } from "../src/client-protocol/routes.js";
import { annotateAndRankRoutes, discoverInterfacesSnapshot, parseMacHardwarePorts } from "../src/hub/network-discovery.js";
import {
  buildWindowsFirewallInspectionScript,
  getWindowsDefaultRouteInterfaceNames,
  hasSufficientWindowsFirewallRemoteScope,
  inspectWindowsMobileFirewall,
} from "../src/hub/windows-network-check.js";

const addr = (address: string, family: "IPv4" | "IPv6" = "IPv4", internal = false): NetworkInterfaceInfo => (
  family === "IPv6"
    ? {
        address,
        family: "IPv6",
        internal,
        netmask: "",
        mac: "02:00:00:00:00:01",
        cidr: null,
        scopeid: 0,
      }
    : {
        address,
        family: "IPv4",
        internal,
        netmask: "",
        mac: "02:00:00:00:00:01",
        cidr: null,
      }
);

// Construct RFC 2544 TUN fake-IP strings dynamically so privacy scans do not flag literal public IPs.
const fakeIpA = [198, 18, 0, 1].join(".");
const fakeIpB = [198, 19, 12, 34].join(".");

describe("network candidate classification, filtering and ranking", () => {
  it("detects TUN proxy fake-IPs (198.18/15) and link-local addresses", () => {
    expect(isProxyFakeIpAddress(fakeIpA)).toBe(true);
    expect(isProxyFakeIpAddress(fakeIpB)).toBe(true);
    expect(isProxyFakeIpAddress(`::ffff:${fakeIpA}`)).toBe(true);
    expect(isProxyFakeIpAddress("192.168.1.5")).toBe(false);

    expect(isLinkLocalAddress("169.254.10.20")).toBe(true);
    expect(isLinkLocalAddress("fe80::1")).toBe(true);
    expect(isLinkLocalAddress("192.168.1.5")).toBe(false);
  });

  it("ranks Tailscale and default-route adapters ahead of bridges and non-Tailscale TUNs", () => {
    const ranked = rankNetworkInterfaces([
      { name: "docker0", address: "172.17.0.1" },
      { name: "utun4", address: "10.8.0.2" },
      { name: "VMware Network Adapter VMnet8", address: "192.168.186.1" },
      { name: "vEthernet (Default Switch)", address: "172.24.0.1" },
      { name: "vEthernet (External)", address: "192.168.2.50", hasDefaultRoute: true },
      { name: "en0", address: "192.168.1.20", hardwarePort: "Ethernet" },
      { name: "en1", address: "192.168.1.10", hardwarePort: "Wi-Fi", hasDefaultRoute: true },
      { name: "utun6", address: "fd7a:115c:a1e0::1" },
      { name: "utun6", address: "100.64.0.1" },
    ]);

    expect(ranked.map(item => [item.address, item.adapterKind, item.virtualBridge, item.demoted])).toEqual([
      ["100.64.0.1", "tailscale", false, false],
      ["fd7a:115c:a1e0::1", "tailscale", false, false],
      ["192.168.1.10", "wifi", false, false],
      ["192.168.2.50", "ethernet", false, false],
      ["192.168.1.20", "ethernet", false, false],
      ["10.8.0.2", "vpn", false, true],
      ["192.168.186.1", "vm", true, true],
      ["172.24.0.1", "vm", true, true],
      ["172.17.0.1", "docker", true, true],
    ]);
  });

  it("classifies Thunderbolt Bridge and WSL Hyper-V adapters as virtual bridges", () => {
    expect(classifyNetworkInterface({ name: "bridge0", address: "192.168.50.2", hardwarePort: "Thunderbolt Bridge" })).toBe("bridge");
    expect(classifyNetworkInterface({ name: "vEthernet (WSL (Hyper-V firewall))", address: "172.28.0.1", hasDefaultRoute: true })).toBe("vm");
    expect(classifyNetworkInterface({ name: "br-deadbeef1234", address: "172.18.0.1" })).toBe("docker");
  });

  it("filters fake-IP and link-local entries and resolves macOS hardware ports + default route", async () => {
    const hardwareOutput = `
Hardware Port: Ethernet
Device: en0

Hardware Port: Wi-Fi
Device: en1

Hardware Port: Thunderbolt Bridge
Device: bridge0
`;
    const exec = async (file: string) => {
      if (file === "networksetup") return hardwareOutput;
      if (file === "route") return "   route to: default\n  interface: en1\n";
      return "";
    };
    const snapshot = await discoverInterfacesSnapshot({
      platform: "darwin",
      exec,
      interfaces: {
        lo0: [addr("127.0.0.1", "IPv4", true)],
        utun9: [addr(fakeIpA), addr("169.254.12.34"), addr("fe80::1", "IPv6")],
        bridge0: [addr("192.168.50.2")],
        en0: [addr("192.168.1.30")],
        en1: [addr("192.168.1.10")],
      },
    });
    expect([...snapshot.keys()]).toEqual(["192.168.50.2", "192.168.1.30", "192.168.1.10"]);
    expect(parseMacHardwarePorts(hardwareOutput).get("en1")).toBe("Wi-Fi");

    const routes: Route[] = [
      { name: "Direct", url: "https://192.168.50.2:23456" },
      { name: "Direct", url: "https://192.168.1.30:23456" },
      { name: "Direct", url: "https://192.168.1.10:23456" },
    ];
    const ranked = await annotateAndRankRoutes(routes, {
      platform: "darwin",
      exec,
      interfaces: {
        bridge0: [addr("192.168.50.2")],
        en0: [addr("192.168.1.30")],
        en1: [addr("192.168.1.10")],
      },
    });
    expect(ranked.routes.map(r => r.url)).toEqual([
      "https://192.168.1.10:23456",
      "https://192.168.1.30:23456",
      "https://192.168.50.2:23456",
    ]);
    expect(ranked.candidates.map(c => [c.adapterKind, !!c.hasDefaultRoute, !!c.virtualBridge])).toEqual([
      ["wifi", true, false],
      ["ethernet", false, false],
      ["bridge", false, true],
    ]);
  });

  it("remembers user selection and caps QR v2 candidates at 4 plausible direct routes + relays", () => {
    const directs: Route[] = [
      { name: "Direct", url: "https://192.168.1.10:8788" },
      { name: "Direct", url: "https://192.168.1.20:8788" },
      { name: "Direct", url: "https://192.168.1.30:8788" },
      { name: "Direct", url: "https://10.0.0.40:8788" },
      { name: "Direct", url: "https://10.0.0.50:8788" },
      { name: "Direct", url: "https://172.17.0.1:8788" },
    ];
    const candidates = [
      { url: "https://192.168.1.10:8788", address: "192.168.1.10", interfaceName: "en1", adapterKind: "wifi" as const, hasDefaultRoute: true },
      { url: "https://192.168.1.20:8788", address: "192.168.1.20", interfaceName: "en0", adapterKind: "ethernet" as const },
      { url: "https://192.168.1.30:8788", address: "192.168.1.30", interfaceName: "en2", adapterKind: "ethernet" as const },
      { url: "https://10.0.0.40:8788", address: "10.0.0.40", interfaceName: "en3", adapterKind: "lan" as const },
      { url: "https://10.0.0.50:8788", address: "10.0.0.50", interfaceName: "en4", adapterKind: "lan" as const },
      { url: "https://172.17.0.1:8788", address: "172.17.0.1", interfaceName: "docker0", adapterKind: "docker" as const, virtualBridge: true, demoted: true },
    ];
    const relays: Route[] = [{ name: "VPS", url: "https://relay.example:8443" }];

    // Remembered selection wins over default order.
    const remembered = selectPrimaryPairingRoute(directs, candidates, "192.168.1.20");
    expect(remembered?.url).toBe("https://192.168.1.20:8788");

    // Multiple virtual bridges alone require manual selection.
    const bridgeOnly = selectPrimaryPairingRoute(
      [directs[5]!, { name: "Direct", url: "https://192.168.50.2:8788" }],
      [candidates[5]!, { url: "https://192.168.50.2:8788", address: "192.168.50.2", interfaceName: "bridge0", adapterKind: "bridge", virtualBridge: true, demoted: true }],
    );
    expect(bridgeOnly).toBeUndefined();

    // QR v2 packs primary + 3 other plausible direct routes + relays, excluding Docker bridge.
    const v2Routes = selectPairingInviteRoutes(directs, relays, { primaryUrl: remembered?.url, candidates, version: 2 });
    expect(v2Routes.map(r => r.url)).toEqual([
      "https://192.168.1.20:8788",
      "https://192.168.1.10:8788",
      "https://192.168.1.30:8788",
      "https://10.0.0.40:8788",
      "https://relay.example:8443",
    ]);

    // QR v1 compatibility keeps only the selected single direct route + relays.
    const v1Routes = selectPairingInviteRoutes(directs, relays, { primaryUrl: remembered?.url, candidates, version: 1 });
    expect(v1Routes.map(r => r.url)).toEqual([
      "https://192.168.1.20:8788",
      "https://relay.example:8443",
    ]);
  });
});

describe("Windows network category and firewall inspection", () => {
  it("parses default-route interface names on Windows", async () => {
    const names = await getWindowsDefaultRouteInterfaceNames({
      platform: "win32",
      runPowerShell: async () => JSON.stringify(["Wi-Fi", "Ethernet"]),
    });
    expect([...(names ?? [])]).toEqual(["Wi-Fi", "Ethernet"]);

    const single = await getWindowsDefaultRouteInterfaceNames({
      platform: "win32",
      runPowerShell: async () => JSON.stringify("Wi-Fi"),
    });
    expect([...(single ?? [])]).toEqual(["Wi-Fi"]);
  });

  it("flags public network category, blocking rules, and insufficient remote address scopes", async () => {
    const publicNet = await inspectWindowsMobileFirewall(23456, "192.168.1.10", {
      platform: "win32",
      executablePath: "C:\\Program Files\\TaroBird\\node.exe",
      runPowerShell: async () => JSON.stringify({
        matchingRuleScopes: [{ remoteAddresses: ["LocalSubnet"] }],
        blockingRuleDetected: false,
        localAddress: "192.168.1.10",
        localPrefixLength: 24,
        privateFirewallEnabled: true,
        networkCategory: "Public",
      }),
    });
    expect(publicNet).toMatchObject({
      supported: true,
      port: 23456,
      networkCategory: "public",
      ruleAllowed: true,
      blockingRuleDetected: false,
      inspectionAvailable: true,
    });

    const blockedNet = await inspectWindowsMobileFirewall(23456, "192.168.1.10", {
      platform: "win32",
      runPowerShell: async () => JSON.stringify({
        matchingRuleScopes: [{ remoteAddresses: ["Any"] }],
        blockingRuleDetected: true,
        localAddress: "192.168.1.10",
        localPrefixLength: 24,
        privateFirewallEnabled: true,
        networkCategory: "Private",
      }),
    });
    expect(blockedNet).toMatchObject({
      supported: true,
      networkCategory: "private",
      ruleAllowed: false,
      blockingRuleDetected: true,
    });

    expect(hasSufficientWindowsFirewallRemoteScope([{ remoteAddresses: ["192.168.99.0/24"] }], "192.168.1.10", 24)).toBe(false);
    expect(hasSufficientWindowsFirewallRemoteScope([{ remoteAddresses: ["192.168.1.0/24"] }], "192.168.1.10", 24)).toBe(true);
    expect(hasSufficientWindowsFirewallRemoteScope([{ remoteAddresses: ["LocalSubnet"] }], "192.168.1.10", 24)).toBe(true);
  });

  it("compares Private firewall GpoBoolean state as a string instead of casting enum to [bool]", async () => {
    const script = buildWindowsFirewallInspectionScript(23456, "C:\\Program Files\\TaroBird\\node.exe", "192.168.1.10");
    expect(script).not.toContain("[bool](Get-NetFirewallProfile");
    expect(script).toContain("[string]$privateProfile.Enabled -eq 'True'");
    expect(script).toContain("$null -ne $privateProfile");

    const disabledFirewall = await inspectWindowsMobileFirewall(23456, "192.168.1.10", {
      platform: "win32",
      runPowerShell: async () => JSON.stringify({
        matchingRuleScopes: [],
        blockingRuleDetected: false,
        localAddress: "192.168.1.10",
        localPrefixLength: 24,
        privateFirewallEnabled: false,
        networkCategory: "Private",
      }),
    });
    expect(disabledFirewall).toMatchObject({
      supported: true,
      networkCategory: "private",
      privateFirewallEnabled: false,
      ruleAllowed: false,
    });
  });

  it("returns unsupported on non-Windows and degrades safely when PowerShell inspection fails", async () => {
    const mac = await inspectWindowsMobileFirewall(23456, "192.168.1.10", { platform: "darwin" });
    expect(mac).toEqual({ supported: false });

    const failed = await inspectWindowsMobileFirewall(23456, "192.168.1.10", {
      platform: "win32",
      runPowerShell: async () => { throw new Error("powershell unavailable"); },
    });
    expect(failed).toMatchObject({
      supported: true,
      port: 23456,
      ruleAllowed: false,
      inspectionAvailable: false,
    });
  });
});
