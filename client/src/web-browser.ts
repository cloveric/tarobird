import { Capacitor } from "@capacitor/core";
import { isDesktop } from "./desktop-bridge.js";
import { MAX_PAIRING_LINK_LENGTH, parsePairingLink, type PairingPayload } from "./pairing-link.js";
import { isLoopbackOrUnspecified } from "../../src/client-protocol/loopback-address.js";
import type { Route } from "../../src/client-protocol/routes.js";

export type ConnectPayload = Extract<PairingPayload, { kind: "connect" }>;

export type BrowserPairingHashResult =
  | { kind: "none" }
  | { kind: "valid"; payload: ConnectPayload }
  | { kind: "origin_mismatch" }
  | { kind: "invalid" };

/** True when running inside a regular desktop or mobile web browser (not Electron, Tauri, iOS, or Android App). */
export function isWebBrowser(): boolean {
  return !isDesktop() && !Capacitor.isNativePlatform();
}

/** True for hosts that public WebPKI CAs cannot issue browser-trusted HTTPS
 * certificates for: loopback, unspecified, RFC 1918 private, link-local,
 * Tailscale RFC 6598 CGNAT, and IPv6 ULA/link-local (including IPv4-mapped). */
function isNonPublicHttpsHost(hostname: string): boolean {
  if (isLoopbackOrUnspecified(hostname)) return true;
  let host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host.includes(":")) {
    try { host = new URL(`http://[${host}]/`).hostname.replace(/^\[|\]$/g, ""); } catch { /* ignore */ }
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mapped) {
      const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
      host = `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
    }
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b, c, d] = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])];
    if (a > 255 || b > 255 || c > 255 || d > 255) return true;
    return a === 0
      || a === 10
      || (a === 100 && b >= 64 && b <= 127)
      || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168);
  }
  if (host.includes(":")) {
    const first = host.startsWith(":") ? 0 : parseInt(host.split(":")[0]!, 16);
    if (Number.isNaN(first)) return true;
    // IPv6 ULA fc00::/7 (includes Tailscale fd7a:115c:a1e0::/48) and link-local fe80::/10.
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

/** Browsers enforce system WebPKI HTTPS trust (or loopback Secure Context).
 * Routes carrying a private self-signed Host CA (`certificateAuthority`), or
 * private/loopback/CGNAT/link-local HTTPS hosts, are not trusted by browsers. */
export function isBrowserTrustedRoute(route: Pick<Route, "url" | "certificateAuthority">): boolean {
  if (route.certificateAuthority) return false;
  try {
    const parsed = new URL(route.url);
    if (parsed.protocol === "https:") return !isNonPublicHttpsHost(parsed.hostname);
    return parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

/** Build a one-time browser pairing URL on `routeUrl`.
 * Uses the URL fragment (`#pair=...`) so the one-time invitation token is never
 * sent in HTTP request paths, server logs, reverse-proxy logs, or Referer headers.
 * Matches `pairingLink()` by returning the full URL so callers (e.g. PairingCode)
 * can surface a translated length alert without crashing during render. */
export function browserPairingLink(routeUrl: string, payload: ConnectPayload): string {
  const origin = new URL(routeUrl).origin;
  const { invite, ...data } = payload;
  if (!invite) throw new Error("invite_required");
  const hash = `#pair=${encodeURIComponent(JSON.stringify(data))}&invite=${encodeURIComponent(invite)}`;
  return `${origin}/${hash}`;
}

/** Inspect a `#pair=...&invite=...` browser pairing hash against `expectedOrigin`.
 * Distinguishes absent fragments from malformed or cross-origin payloads so callers
 * can immediately strip any `#pair=`/`#invite=` fragment and report an error. */
export function inspectBrowserPairingHash(hash: string, expectedOrigin: string): BrowserPairingHashResult {
  if (!hash || !hash.startsWith("#")) return { kind: "none" };
  const params = new URLSearchParams(hash.slice(1));
  if (!params.has("pair") && !params.has("invite")) return { kind: "none" };
  if (hash.length > MAX_PAIRING_LINK_LENGTH) return { kind: "invalid" };
  let origin: string;
  try {
    const parsedOrigin = new URL(expectedOrigin);
    if (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") return { kind: "invalid" };
    origin = parsedOrigin.origin;
  } catch {
    return { kind: "invalid" };
  }
  if ([...params.keys()].some((key) => key !== "pair" && key !== "invite")) return { kind: "invalid" };
  if (params.getAll("pair").length !== 1 || params.getAll("invite").length !== 1) return { kind: "invalid" };
  const data = params.get("pair");
  const invite = params.get("invite");
  if (!data || !invite) return { kind: "invalid" };
  let parsed: PairingPayload;
  try {
    parsed = parsePairingLink(`tarocub://pair?data=${encodeURIComponent(data)}&invite=${encodeURIComponent(invite)}`);
  } catch {
    return { kind: "invalid" };
  }
  if (parsed.kind !== "connect" || !parsed.invite) return { kind: "invalid" };
  const matchesOrigin = parsed.routes.some((route) => {
    try { return new URL(route.url).origin === origin; }
    catch { return false; }
  });
  if (!matchesOrigin) return { kind: "origin_mismatch" };
  return { kind: "valid", payload: parsed };
}

/** Parse a `#pair=...&invite=...` browser pairing hash using the same strict
 * schema validation as `tarocub://pair` links, and require at least one route
 * matching `expectedOrigin`. Returns undefined if absent, invalid, or cross-origin. */
export function parseBrowserPairingHash(hash: string, expectedOrigin: string): ConnectPayload | undefined {
  const result = inspectBrowserPairingHash(hash, expectedOrigin);
  return result.kind === "valid" ? result.payload : undefined;
}

/** Strip any `#pair=` / `#invite=` fragment from the browser address bar and history. */
export function stripBrowserPairingHash(): void {
  try { window.history.replaceState(null, "", window.location.pathname + window.location.search); } catch { /* ignore */ }
}
