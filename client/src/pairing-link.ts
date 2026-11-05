import { routesSchema, deploymentSchema, deploymentMatchesRoutes, type Deployment } from "../../src/client-protocol/routes.js";
import { z } from "zod";
import { t } from "./i18n.js";
import { validateRoute } from "./identity.js";
import type { Route } from "./storage.js";

// Pairing data is shared by UI and transport tests; it must not load dialogs or CSS.
const payloadSchema = z.discriminatedUnion("kind", [
  z.object({ v: z.literal(1), kind: z.literal("connect"), hubPublicKey: z.string().min(40).max(100), routes: routesSchema, deployment: deploymentSchema.optional() }).strict().refine((value) => deploymentMatchesRoutes(value.deployment, value.routes), "Deployment does not match routes"),
  z.object({ v: z.literal(1), kind: z.literal("approve"), hubPublicKey: z.string().min(40).max(100), code: z.string().regex(/^\d{8}$/) }).strict(),
]);
type LegacyPairingPayload = z.infer<typeof payloadSchema>;
export type PairingPayload = Extract<LegacyPairingPayload, { kind: "approve" }>
  | (Extract<LegacyPairingPayload, { kind: "connect" }> & { invite?: string });
const inviteSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const MAX_PAIRING_LINK_LENGTH = 8192;
/** QR v1 keeps its single-direct contract. Extra local routes arrive over the
 * authenticated host-routes capability after pairing, never in an invalid QR. */
export function connectionPairingPayload(hubPublicKey: string, local: readonly Route[], deployment?: Deployment, activeUrl?: string): Extract<PairingPayload, { kind: "connect" }> {
  const direct = local.find(route => route.name !== "VPS" && route.url === activeUrl) ?? local.find(route => route.name === "Tailscale") ?? local.find(route => route.name === "Direct");
  const routes = routesSchema.parse([...(direct ? [direct] : []), ...local.filter(route => route.name === "VPS")]);
  return { v: 1, kind: "connect", hubPublicKey, routes, ...(deployment && deploymentMatchesRoutes(deployment, routes) ? { deployment } : {}) };
}

export function pairingLink(payload: PairingPayload): string {
  // Keep v1 data intact: previously paired older clients can still read routes.
  // Their first-time registration cannot bypass the Host's invitation gate.
  const { invite, ...data } = payload as PairingPayload & { invite?: string };
  if (invite !== undefined && payload.kind !== "connect") throw new Error(t("配对二维码无效"));
  return `tarocub://pair?data=${encodeURIComponent(JSON.stringify(data))}${invite === undefined ? "" : `&invite=${inviteSchema.parse(invite)}`}`;
}
export function parsePairingLink(value: string): PairingPayload {
  if (value.length > MAX_PAIRING_LINK_LENGTH) throw new Error(t("配对二维码无效"));
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error(t("这不是 TaroBird 配对码")); }
  if (url.protocol !== "tarocub:" || url.hostname !== "pair" || url.pathname || url.hash || url.username || url.password || url.port) throw new Error(t("这不是 TaroBird 配对码"));
  try {
    if ([...url.searchParams.keys()].some(key => key !== "data" && key !== "invite") || url.searchParams.getAll("data").length !== 1 || url.searchParams.getAll("invite").length > 1) throw new Error("invalid_pairing_query");
    const payload = payloadSchema.parse(JSON.parse(url.searchParams.get("data") ?? "{}"));
    if (payload.kind === "connect") payload.routes = payload.routes.map((r): Route => ({ ...r, url: validateRoute(r.url) }));
    const invite = url.searchParams.get("invite");
    if (invite !== null && payload.kind !== "connect") throw new Error("invalid_pairing_invite");
    return invite === null || payload.kind !== "connect" ? payload : { ...payload, invite: inviteSchema.parse(invite) };
  } catch { throw new Error(t("配对信息不完整或已损坏，请重新复制或扫描二维码。")); }
}
