import { pairingInviteTokenSchema } from "../client-protocol/pairing-invites.js";
import qrcode from "qrcode-terminal";
import { routesSchema, type Route } from "../client-protocol/routes.js";
import { sharedRoutesSchema } from "../client-protocol/private-network.js";

/** A phone's one-time pairing route must not replace a configured network route. */
export function pairingSharedRoutes(existing: Route[], selected: Route): Route[] {
  const current = sharedRoutesSchema.parse(existing), incoming = routesSchema.parse([selected])[0]!;
  const direct = current.find(route => route.name !== "VPS");
  if (direct) {
    if (direct.url !== incoming.url) return current;
    // Renew the certificate for the same endpoint, retaining the user's label.
    return current.map(route => route === direct ? { ...incoming, ...(direct.label ? { label: direct.label } : {}) } : route);
  }
  return sharedRoutesSchema.parse([incoming, ...current.filter(route => route.url !== incoming.url)]);
}

export function hostPairingLink(publicKey: string, routes: Route[], invite: string): string {
  if (!/^[A-Za-z0-9+/]{59}=$/.test(publicKey)) throw new Error("主机身份公钥无效。");
  // A phone cannot connect to the computer's loopback, even if both use localhost.
  const parsed = routesSchema.parse(sharedRoutesSchema.parse(routes));
  const link = `tarocub://pair?data=${encodeURIComponent(JSON.stringify({ v: 1, kind: "connect", hubPublicKey: publicKey, routes: parsed }))}&invite=${pairingInviteTokenSchema.parse(invite)}`;
  if (link.length > 8192) throw new Error("配对信息过长，请减少同时分享的线路。");
  return link;
}
export async function terminalPairingQr(link: string): Promise<string> {
  return new Promise((resolve, reject) => { try { qrcode.generate(link, { small: true }, resolve); } catch (error) { reject(error); } });
}
