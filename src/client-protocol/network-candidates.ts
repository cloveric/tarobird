import { z } from "zod";
import { MAX_DIRECT_ROUTES, MAX_VPS_ROUTES, type Route } from "./routes.js";

export const networkAdapterKindSchema = z.enum([
  "tailscale",
  "wifi",
  "ethernet",
  "lan",
  "vpn",
  "bridge",
  "docker",
  "vm",
]);
export type NetworkAdapterKind = z.infer<typeof networkAdapterKindSchema>;

export const networkCandidateMetaSchema = z.object({
  url: z.string(),
  address: z.string(),
  interfaceName: z.string().max(128),
  adapterKind: networkAdapterKindSchema,
  hardwarePort: z.string().max(128).optional(),
  hasDefaultRoute: z.boolean().optional(),
  virtualBridge: z.boolean().optional(),
  demoted: z.boolean().optional(),
}).strict();
export type NetworkCandidateMeta = z.infer<typeof networkCandidateMetaSchema>;

export const windowsNetworkCategorySchema = z.enum(["private", "public", "domain", "unknown"]);
export type WindowsNetworkCategory = z.infer<typeof windowsNetworkCategorySchema>;

export const windowsFirewallStatusSchema = z.discriminatedUnion("supported", [
  z.object({ supported: z.literal(false) }).strict(),
  z.object({
    supported: z.literal(true),
    port: z.number().int().min(1).max(65_535),
    networkCategory: windowsNetworkCategorySchema,
    privateFirewallEnabled: z.boolean(),
    ruleAllowed: z.boolean(),
    blockingRuleDetected: z.boolean(),
    inspectionAvailable: z.boolean(),
    recommendedCommand: z.string().max(512).optional(),
  }).strict(),
]);
export type WindowsFirewallStatus = z.infer<typeof windowsFirewallStatusSchema>;

function stripIpv6BracketsAndZone(raw: string): string {
  return raw.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
}

function parseIPv4Octets(address: string): number[] | undefined {
  const normalized = stripIpv6BracketsAndZone(address).replace(/^::ffff:/i, "");
  const parts = normalized.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
  return octets;
}

/** Carrier-grade benchmarking range (RFC 2544: 198.18/15), commonly used as
 * synthetic "Fake-IP" destinations by TUN-mode proxies and never reachable from a phone. */
export function isProxyFakeIpAddress(address: string): boolean {
  const octets = parseIPv4Octets(address);
  return !!octets && octets[0] === 198 && (octets[1] === 18 || octets[1] === 19);
}

/** APIPA (169.254/16) and IPv6 link-local (fe80::/10) addresses are not
 * reliably dialable across devices during pairing. */
export function isLinkLocalAddress(address: string): boolean {
  const octets = parseIPv4Octets(address);
  if (octets) return octets[0] === 169 && octets[1] === 254;
  const normalized = stripIpv6BracketsAndZone(address);
  return /^fe[89ab][0-9a-f]:/i.test(normalized);
}

export function isTailscaleIpAddress(address: string): boolean {
  const octets = parseIPv4Octets(address);
  if (octets) return octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
  const normalized = stripIpv6BracketsAndZone(address);
  return /^fd7a:115c:a1e0:/i.test(normalized);
}

export function isPrivateLanIPv4(address: string): boolean {
  const octets = parseIPv4Octets(address);
  if (!octets) return false;
  return octets[0] === 10 || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) || (octets[0] === 192 && octets[1] === 168);
}

const DOCKER_PATTERN = /^(?:docker\d*|br-[0-9a-f]+|veth(?:[\d_-]|$)|cni\d*|flannel|cali)/i;
const VM_PATTERN = /^(?:vmnet|vboxnet)|vmware network adapter|virtualbox host-only/i;
const HYPER_V_HOST_LOCAL_PATTERN = /^vEthernet \((?:Default Switch|WSL(?: \(Hyper-V firewall\))?)\)$/i;
const HYPER_V_PATTERN = /^vEthernet /i;
const BRIDGE_PATTERN = /^(?:virbr|lxcbr|bridge\d*)/i;
const VPN_TUN_PATTERN = /^(?:utun|tun|tap|wg|ppp|ipsec|clash|mihomo|singbox|surge)/i;
const WIFI_PATTERN = /wi-?fi|wlan|wireless|airport|^wlp\d|^wlx/i;
const ETHERNET_PATTERN = /ethernet|^eth\d|^enp\d|^eno\d|^ens\d|usb.*lan|10\/100\/1000|gigabit/i;

export interface InterfaceClassificationInput {
  name: string;
  address: string;
  hardwarePort?: string;
  hasDefaultRoute?: boolean;
}

export function isVirtualBridgeAdapterKind(kind: NetworkAdapterKind): boolean {
  return kind === "docker" || kind === "vm" || kind === "bridge";
}

export function isDemotedAdapterKind(kind: NetworkAdapterKind): boolean {
  return isVirtualBridgeAdapterKind(kind) || kind === "vpn";
}

export function classifyNetworkInterface({
  name,
  address,
  hardwarePort,
  hasDefaultRoute,
}: InterfaceClassificationInput): NetworkAdapterKind {
  if (isTailscaleIpAddress(address)) return "tailscale";
  if (/tailscale/i.test(name) && !isPrivateLanIPv4(address)) return "tailscale";

  const portOrName = hardwarePort ? `${hardwarePort} ${name}` : name;
  if (DOCKER_PATTERN.test(name)) return "docker";
  if (HYPER_V_HOST_LOCAL_PATTERN.test(name) || VM_PATTERN.test(name)) return "vm";
  if (HYPER_V_PATTERN.test(name)) return hasDefaultRoute === true ? "ethernet" : "vm";
  if (BRIDGE_PATTERN.test(name) || /thunderbolt bridge/i.test(portOrName)) return "bridge";
  if (VPN_TUN_PATTERN.test(name) || /vpn|wireguard|openvpn|tunnel|proxy/i.test(portOrName)) return "vpn";
  if (WIFI_PATTERN.test(portOrName)) return "wifi";
  if (ETHERNET_PATTERN.test(portOrName)) return "ethernet";
  return "lan";
}

export interface RankableInterface extends InterfaceClassificationInput {
  adapterKind?: NetworkAdapterKind;
  virtualBridge?: boolean;
  demoted?: boolean;
}

export function networkInterfaceRankScore(item: RankableInterface): number {
  const kind = item.adapterKind ?? classifyNetworkInterface(item);
  const ipv6Penalty = item.address.includes(":") ? 0.5 : 0;
  if (kind === "tailscale") return item.address.includes(":") ? 0.2 : 0;
  if (kind === "vpn") return 3 + ipv6Penalty;
  if (kind === "bridge") return 4 + ipv6Penalty;
  if (kind === "vm") return 4.1 + ipv6Penalty;
  if (kind === "docker") return 4.2 + ipv6Penalty;

  // Non-bridge LAN adapter: default-route adapter ranks ahead of idle/secondary adapters.
  const routeTier = item.hasDefaultRoute ? 1 : 2;
  const kindTie = kind === "wifi" ? 0 : kind === "ethernet" ? 0.1 : 0.2;
  return routeTier + kindTie + ipv6Penalty;
}

export function rankNetworkInterfaces<T extends RankableInterface>(items: readonly T[]): (T & {
  adapterKind: NetworkAdapterKind;
  virtualBridge: boolean;
  demoted: boolean;
})[] {
  return items
    .map((item, index) => {
      const adapterKind = item.adapterKind ?? classifyNetworkInterface(item);
      const virtualBridge = item.virtualBridge ?? isVirtualBridgeAdapterKind(adapterKind);
      const demoted = item.demoted ?? isDemotedAdapterKind(adapterKind);
      return { item: { ...item, adapterKind, virtualBridge, demoted }, index };
    })
    .sort((a, b) => networkInterfaceRankScore(a.item) - networkInterfaceRankScore(b.item) || a.index - b.index)
    .map(entry => entry.item);
}

/** Pick the primary direct route URL for UI pre-selection:
 * 1. Remembered user selection if still present in the verified candidates.
 * 2. Top-ranked non-demoted (non-bridge, non-VPN) candidate.
 * 3. If only one candidate exists total, select it; if multiple bridges/VPNs
 *    exist with zero plausible adapters, return undefined so the user chooses. */
export function selectPrimaryPairingRoute(
  routes: readonly Route[],
  candidates?: readonly NetworkCandidateMeta[],
  rememberedAddress?: string,
): Route | undefined {
  if (!routes.length) return undefined;
  if (rememberedAddress) {
    const match = routes.find(route => {
      try { return new URL(route.url).hostname.replace(/^\[|\]$/g, "") === rememberedAddress; }
      catch { return false; }
    });
    if (match) return match;
  }
  const byUrl = new Map((candidates ?? []).map(item => [item.url, item]));
  const plausible = routes.filter(route => !byUrl.get(route.url)?.demoted && !byUrl.get(route.url)?.virtualBridge);
  if (plausible.length > 0) return plausible[0];
  return routes.length === 1 ? routes[0] : undefined;
}

/** Build the ordered candidate route list for a pairing QR:
 * primary route first, followed by up to 3 more plausible (non-bridge, non-VPN)
 * direct routes, plus configured VPS relays. */
export function selectPairingInviteRoutes(
  directRoutes: readonly Route[],
  relayRoutes: readonly Route[],
  options: {
    primaryUrl?: string;
    candidates?: readonly NetworkCandidateMeta[];
    version?: 1 | 2;
  } = {},
): Route[] {
  const byUrl = new Map((options.candidates ?? []).map(item => [item.url, item]));
  const primary = (options.primaryUrl && directRoutes.find(route => route.url === options.primaryUrl))
    ?? selectPrimaryPairingRoute(directRoutes, options.candidates)
    ?? directRoutes[0];
  const relays = relayRoutes.filter(route => route.name === "VPS").slice(0, MAX_VPS_ROUTES);
  if (!primary) return relays;

  if (options.version === 1) {
    return [primary, ...relays.filter(route => route.url !== primary.url)];
  }

  const extras = directRoutes.filter(route => {
    if (route.url === primary.url || route.name === "VPS") return false;
    const meta = byUrl.get(route.url);
    return !meta?.demoted && !meta?.virtualBridge;
  });
  const selectedDirects = [primary, ...extras].slice(0, MAX_DIRECT_ROUTES);
  return [
    ...selectedDirects,
    ...relays.filter(relay => !selectedDirects.some(direct => direct.url === relay.url)),
  ];
}
