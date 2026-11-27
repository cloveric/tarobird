import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import {
  classifyNetworkInterface,
  isDemotedAdapterKind,
  isLinkLocalAddress,
  isProxyFakeIpAddress,
  isTailscaleIpAddress,
  isVirtualBridgeAdapterKind,
  rankNetworkInterfaces,
  type NetworkAdapterKind,
  type NetworkCandidateMeta,
} from "../client-protocol/network-candidates.js";
import type { Route } from "../client-protocol/routes.js";
import { getWindowsDefaultRouteInterfaceNames, type PowerShellRunner } from "./windows-network-check.js";

const PROBE_TIMEOUT_MS = 1_500;

export type ExecFileRunner = (file: string, args: string[], timeoutMs: number) => Promise<string>;

export type NetworkDiscoveryEnvironment = {
  platform?: NodeJS.Platform;
  interfaces?: ReturnType<typeof networkInterfaces>;
  exec?: ExecFileRunner;
  runPowerShell?: PowerShellRunner;
};

function defaultExec(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 512 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export function parseMacHardwarePorts(stdout: string): Map<string, string> {
  const result = new Map<string, string>();
  let currentPort: string | undefined;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    const portMatch = /^Hardware Port:\s*(.+)$/i.exec(line);
    if (portMatch) {
      currentPort = portMatch[1]!.trim();
      continue;
    }
    const deviceMatch = /^Device:\s*(\S+)$/i.exec(line);
    if (deviceMatch && currentPort) {
      result.set(deviceMatch[1]!, currentPort);
      currentPort = undefined;
    }
  }
  return result;
}

export async function getMacHardwarePorts(
  env: NetworkDiscoveryEnvironment = {},
): Promise<Map<string, string>> {
  if ((env.platform ?? process.platform) !== "darwin") return new Map();
  try {
    const stdout = await (env.exec ?? defaultExec)("networksetup", ["-listallhardwareports"], PROBE_TIMEOUT_MS);
    return parseMacHardwarePorts(stdout);
  } catch {
    return new Map();
  }
}

export async function getDefaultRouteInterfaceNames(
  env: NetworkDiscoveryEnvironment = {},
): Promise<ReadonlySet<string>> {
  const platform = env.platform ?? process.platform;
  if (platform === "win32") {
    const names = await getWindowsDefaultRouteInterfaceNames({
      platform,
      ...(env.runPowerShell ? { runPowerShell: env.runPowerShell } : {}),
    });
    return names ?? new Set();
  }
  if (platform === "darwin") {
    try {
      const stdout = await (env.exec ?? defaultExec)("route", ["-n", "get", "default"], PROBE_TIMEOUT_MS);
      const match = /^\s*interface:\s*(\S+)\s*$/im.exec(stdout);
      return match ? new Set([match[1]!]) : new Set();
    } catch {
      return new Set();
    }
  }
  if (platform === "linux") {
    try {
      const stdout = await (env.exec ?? defaultExec)("ip", ["route", "show", "default"], PROBE_TIMEOUT_MS);
      const names = new Set<string>();
      for (const match of stdout.matchAll(/\bdev\s+(\S+)/g)) names.add(match[1]!);
      return names;
    } catch {
      return new Set();
    }
  }
  return new Set();
}

export interface DiscoveredInterfaceEntry {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
  hardwarePort?: string;
  hasDefaultRoute?: boolean;
}

export async function discoverInterfacesSnapshot(
  env: NetworkDiscoveryEnvironment = {},
): Promise<Map<string, DiscoveredInterfaceEntry>> {
  const interfaces = env.interfaces ?? networkInterfaces();
  const [defaultRoutes, macPorts] = await Promise.all([
    getDefaultRouteInterfaceNames(env),
    getMacHardwarePorts(env),
  ]);
  const normalizedDefaults = new Set([...defaultRoutes].map(name => name.toLowerCase()));
  const byAddress = new Map<string, DiscoveredInterfaceEntry>();
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs ?? []) {
      if (!addr || addr.internal) continue;
      if (addr.family !== "IPv4" && addr.family !== "IPv6") continue;
      if (isProxyFakeIpAddress(addr.address) || isLinkLocalAddress(addr.address)) continue;
      if (byAddress.has(addr.address)) continue;
      const hardwarePort = macPorts.get(name);
      byAddress.set(addr.address, {
        name,
        address: addr.address,
        family: addr.family,
        ...(hardwarePort ? { hardwarePort } : {}),
        ...(normalizedDefaults.has(name.toLowerCase()) ? { hasDefaultRoute: true } : {}),
      });
    }
  }
  return byAddress;
}

/** Annotate and rank verified routes according to their OS network interface.
 * Preserves the exact Route object properties while returning ranked routes and
 * separate adapter metadata for UI labeling & auto-selection. */
export async function annotateAndRankRoutes(
  routes: readonly Route[],
  env: NetworkDiscoveryEnvironment = {},
): Promise<{ routes: Route[]; candidates: NetworkCandidateMeta[] }> {
  if (!routes.length) return { routes: [], candidates: [] };
  const snapshot = await discoverInterfacesSnapshot(env);
  const items = routes.map(route => {
    const address = new URL(route.url).hostname.replace(/^\[|\]$/g, "");
    const observed = snapshot.get(address);
    if (!observed) {
      const adapterKind: NetworkAdapterKind = route.name === "Tailscale" || isTailscaleIpAddress(address) ? "tailscale" : "lan";
      return {
        route,
        url: route.url,
        address,
        name: route.name === "Tailscale" ? "tailscale" : "",
        adapterKind,
        virtualBridge: false,
        demoted: false,
        observed: false,
      };
    }
    const adapterKind: NetworkAdapterKind = route.name === "Tailscale" ? "tailscale" : classifyNetworkInterface({
      name: observed.name,
      address: observed.address,
      hardwarePort: observed.hardwarePort,
      hasDefaultRoute: observed.hasDefaultRoute,
    });
    return {
      route,
      url: route.url,
      address: observed.address,
      name: observed.name,
      hardwarePort: observed.hardwarePort,
      hasDefaultRoute: observed.hasDefaultRoute,
      adapterKind,
      virtualBridge: isVirtualBridgeAdapterKind(adapterKind),
      demoted: isDemotedAdapterKind(adapterKind),
      observed: true,
    };
  });

  // Only reorder when at least one route matched OS interface metadata; otherwise
  // keep the caller's order (e.g. unit tests spying on desktopLanAddresses).
  const hasObserved = items.some(item => item.observed);
  const ranked = hasObserved ? rankNetworkInterfaces(items) : items;

  return {
    routes: ranked.map(item => item.route),
    candidates: ranked.map(item => ({
      url: item.url,
      address: item.address,
      interfaceName: item.name,
      adapterKind: item.adapterKind,
      ...(item.hardwarePort ? { hardwarePort: item.hardwarePort } : {}),
      ...(item.hasDefaultRoute ? { hasDefaultRoute: true } : {}),
      ...(item.virtualBridge ? { virtualBridge: true } : {}),
      ...(item.demoted ? { demoted: true } : {}),
    })),
  };
}
