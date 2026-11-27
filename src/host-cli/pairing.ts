import { pairingInviteTokenSchema } from "../client-protocol/pairing-invites.js";
import qrcode from "qrcode-terminal";
import { isDirectRoute, localRoutesSchema, routesSchema, type Route } from "../client-protocol/routes.js";
import { sharedRoutesSchema } from "../client-protocol/private-network.js";
import { isLoopbackOrUnspecified } from "../client-protocol/loopback-address.js";

/** A phone's one-time pairing route must not replace a configured network route. */
export function pairingSharedRoutes(existing: Route[], selected: Route): Route[] {
  const current = sharedRoutesSchema.parse(existing), incoming = routesSchema.parse([selected])[0]!;
  const direct = current.find(isDirectRoute);
  if (direct) {
    if (direct.url !== incoming.url) return current;
    // Renew the certificate for the same endpoint, retaining the user's label.
    return current.map(route => route === direct ? { ...incoming, ...(direct.label ? { label: direct.label } : {}) } : route);
  }
  return sharedRoutesSchema.parse([incoming, ...current.filter(route => route.url !== incoming.url)]);
}

function compactHostV2Routes(routes: Route[]): { routes: Route[]; certificateAuthority?: string } {
  // Never hoist a shared CA when any non-VPS route intentionally omits a custom
  // CA (system root trust), because v2 decode applies the hoisted CA to all
  // non-VPS routes without their own certificateAuthority.
  if (routes.some(route => route.name !== "VPS" && !route.certificateAuthority)) {
    return { routes };
  }
  const counts = new Map<string, number>();
  for (const route of routes) {
    if (route.name !== "VPS" && route.certificateAuthority) {
      counts.set(route.certificateAuthority, (counts.get(route.certificateAuthority) ?? 0) + 1);
    }
  }
  let sharedCa: string | undefined;
  let bestCount = 1;
  for (const [ca, count] of counts) {
    if (count > bestCount) { bestCount = count; sharedCa = ca; }
  }
  if (!sharedCa) return { routes };
  return {
    certificateAuthority: sharedCa,
    routes: routes.map((route) => {
      if (route.name === "VPS" || route.certificateAuthority !== sharedCa) return route;
      const { certificateAuthority: _omitted, ...rest } = route;
      return rest;
    }),
  };
}

/** v1 (at most one direct route) unless `version: 2` is asked for: Apps up to
 * 1.6.0 accept only v1 and report any other code as damaged. */
export function hostPairingLink(
  publicKey: string,
  routes: Route[],
  invite: string,
  options: { version?: 1 | 2; cloudflare?: boolean } = {},
): string {
  if (!/^[A-Za-z0-9+/]{59}=$/.test(publicKey)) throw new Error("主机身份公钥无效。");
  // A phone cannot connect to the computer's loopback, even if both use localhost.
  if (options.cloudflare) {
    // `pair --cloudflare`: authorized Cloudflare routes only, always a v1 payload
    // (never mixed into a v2 multi-address code).
    const parsed = routesSchema.parse(routes);
    for (const route of parsed) {
      const u = new URL(route.url);
      if (u.protocol !== "https:" || isLoopbackOrUnspecified(u.hostname)) throw new Error("network_route_must_be_remote");
    }
    const link = `tarocub://pair?data=${encodeURIComponent(JSON.stringify({ v: 1, kind: "connect", hubPublicKey: publicKey, routes: parsed }))}&invite=${pairingInviteTokenSchema.parse(invite)}`;
    if (link.length > 8192) throw new Error("配对信息过长，请减少同时分享的线路。");
    return link;
  }
  for (const route of routes) sharedRoutesSchema.parse([route]);
  const directCount = routes.filter(isDirectRoute).length;
  const payload = options.version === 2 && directCount > 1
    ? (() => {
        const parsed = localRoutesSchema.parse(routes);
        const compacted = compactHostV2Routes(parsed);
        return {
          v: 2 as const,
          kind: "connect" as const,
          hubPublicKey: publicKey,
          routes: compacted.routes,
          ...(compacted.certificateAuthority ? { certificateAuthority: compacted.certificateAuthority } : {}),
        };
      })()
    : {
        v: 1 as const,
        kind: "connect" as const,
        hubPublicKey: publicKey,
        routes: routesSchema.parse(sharedRoutesSchema.parse(routes)),
      };
  const link = `tarocub://pair?data=${encodeURIComponent(JSON.stringify(payload))}&invite=${pairingInviteTokenSchema.parse(invite)}`;
  if (link.length > 8192) throw new Error("配对信息过长，请减少同时分享的线路。");
  return link;
}

export async function terminalPairingQr(link: string): Promise<string> {
  return new Promise((resolve, reject) => { try { qrcode.generate(link, { small: true }, resolve); } catch (error) { reject(error); } });
}
