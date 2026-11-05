import type { NetworkView } from "../../src/client-protocol/private-network.js";

// A connection to another host must not propose moving an established network.
// This only controls navigation; the Hub still authorizes every membership change.
// Undefined means still loading: preserve the intent without offering an action.
export function canOfferDesktopJoin(view: NetworkView | undefined, sourceKey: string, targetKey: string, now = Date.now()): boolean | undefined {
  if (!view) return undefined;
  const manifest = view?.membership?.manifest;
  if (!manifest || view?.sync === "removed") return true;
  if (manifest.hosts.some(host => host.publicKey === targetKey && !host.revoked && host.state === "active")) return false;
  return manifest.authorityKey === sourceKey && !manifest.hosts.some(host => host.publicKey !== sourceKey && !host.revoked && (host.state === "active" || (host.expiresAt ?? 0) > now));
}

// Navigation intent only: this never grants permission or submits membership.
// Keys are public identities, so an intent cannot redirect an authenticated host.
export type DesktopJoinIntent = { sourceKey: string; targetKey: string };
const storageKey = "tarobot:desktop-join-intent:v1";
export function readDesktopJoinIntent(): DesktopJoinIntent | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (value && [value.sourceKey, value.targetKey].every(key => typeof key === "string" && /^[A-Za-z0-9+/]{59}=$/.test(key)) && value.sourceKey !== value.targetKey) return { sourceKey: value.sourceKey, targetKey: value.targetKey };
  } catch { /* Storage is optional for navigation, never for authorization. */ }
}
export function writeDesktopJoinIntent(value?: DesktopJoinIntent): void {
  try { if (value) localStorage.setItem(storageKey, JSON.stringify(value)); else localStorage.removeItem(storageKey); } catch { /* The current window still retains the intent. */ }
}
