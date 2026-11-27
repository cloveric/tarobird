import {
  classifyNetworkInterface,
  type NetworkAdapterKind,
  type NetworkCandidateMeta,
} from "../../src/client-protocol/network-candidates.js";
import type { Route } from "../../src/client-protocol/routes.js";
import { t } from "./i18n.js";

const PREFERRED_ADDRESS_STORAGE_PREFIX = "tarobird.pairingPreferredAddress.v1:";

export function adapterKindLabel(kind: NetworkAdapterKind): string {
  switch (kind) {
    case "tailscale": return "Tailscale";
    case "wifi": return "Wi-Fi";
    case "ethernet": return t("有线网络");
    case "docker": return "Docker";
    case "vm": return t("虚拟机");
    case "bridge": return t("桥接网络");
    case "vpn": return "VPN";
    case "lan": return t("局域网");
  }
}

export function routeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return url;
  }
}

export function inferAdapterKind(route: Route, candidate?: NetworkCandidateMeta): NetworkAdapterKind {
  if (candidate) return candidate.adapterKind;
  if (route.name === "Tailscale") return "tailscale";
  return classifyNetworkInterface({
    name: route.label ?? "",
    address: routeHostname(route.url),
  });
}

/** Human-friendly candidate label such as "Wi-Fi · 192.168.1.5" or "Docker · 172.17.0.1". */
export function describeNetworkCandidate(
  route: Route,
  candidate?: NetworkCandidateMeta,
  options: { recommended?: boolean } = {},
): string {
  const address = candidate?.address ?? routeHostname(route.url);
  const kind = inferAdapterKind(route, candidate);
  const base = `${adapterKindLabel(kind)} · ${address}`;
  return options.recommended ? t("{0}（推荐）", base) : base;
}

export function loadPreferredPairingAddress(hubKey: string): string | undefined {
  if (!hubKey || typeof localStorage === "undefined") return undefined;
  try {
    const value = localStorage.getItem(`${PREFERRED_ADDRESS_STORAGE_PREFIX}${hubKey}`);
    return value?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function savePreferredPairingAddress(hubKey: string, urlOrAddress: string): void {
  if (!hubKey || typeof localStorage === "undefined") return;
  try {
    const address = urlOrAddress.includes("://") ? routeHostname(urlOrAddress) : urlOrAddress.trim();
    if (!address) return;
    localStorage.setItem(`${PREFERRED_ADDRESS_STORAGE_PREFIX}${hubKey}`, address);
  } catch {
    // Private browsing or storage quota must not block route selection.
  }
}
