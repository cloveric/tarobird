import {
  isDirectRoute,
  isEdgeTlsRoute,
  isRelayRoute,
  routesSchema,
  localRoutesSchema,
  deploymentSchema,
  deploymentMatchesRoutes,
  MAX_DIRECT_ROUTES,
  MAX_VPS_ROUTES,
  type Deployment,
} from "../../src/client-protocol/routes.js";
import { z } from "zod";
import { t } from "./i18n.js";
import { validateRoute } from "./identity.js";
import type { Route } from "./storage.js";

const certificateAuthoritySchema = z.string().min(100).max(4096).regex(/^[A-Za-z0-9+/]+={0,2}$/);
const hubPublicKeySchema = z.string().min(40).max(100);

// Pairing data is shared by UI and transport tests; it must not load dialogs or CSS.
const payloadSchema = z.discriminatedUnion("kind", [
  z.object({
    v: z.literal(1),
    kind: z.literal("connect"),
    hubPublicKey: hubPublicKeySchema,
    routes: routesSchema,
    deployment: deploymentSchema.optional(),
  }).strict().refine((value) => deploymentMatchesRoutes(value.deployment, value.routes), "Deployment does not match routes"),
  z.object({
    v: z.literal(1),
    kind: z.literal("approve"),
    hubPublicKey: hubPublicKeySchema,
    code: z.string().regex(/^\d{8}$/),
  }).strict(),
]);

const connectV2Schema = z.object({
  v: z.literal(2),
  kind: z.literal("connect"),
  hubPublicKey: hubPublicKeySchema,
  routes: localRoutesSchema,
  certificateAuthority: certificateAuthoritySchema.optional(),
  deployment: deploymentSchema.optional(),
}).strict().refine((value) => deploymentMatchesRoutes(value.deployment, value.routes), "Deployment does not match routes");

type LegacyPairingPayload = z.infer<typeof payloadSchema>;
export type ConnectV2Payload = {
  v: 2;
  kind: "connect";
  hubPublicKey: string;
  routes: Route[];
  deployment?: Deployment;
  invite?: string;
};
export type PairingPayload = Extract<LegacyPairingPayload, { kind: "approve" }>
  | (Extract<LegacyPairingPayload, { kind: "connect" }> & { invite?: string })
  | ConnectV2Payload;

const inviteSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const MAX_PAIRING_LINK_LENGTH = 8192;

/** Deduplicate identical route CAs in v2 QR payloads so up to 4 LAN routes fit
 * comfortably within a phone-scannable QR code. */
function compactV2ConnectPayload(payload: Omit<ConnectV2Payload, "invite">): z.input<typeof connectV2Schema> {
  // Never hoist a shared CA if any non-VPS route relies on the system root CA:
  // on decode, top-level certificateAuthority hydrates every non-VPS route that
  // omits its own CA, which would corrupt system-CA routes.
  if (payload.routes.some(route => route.name !== "VPS" && !route.certificateAuthority)) {
    return payload;
  }
  const counts = new Map<string, number>();
  for (const route of payload.routes) {
    if (route.name !== "VPS" && route.certificateAuthority) {
      counts.set(route.certificateAuthority, (counts.get(route.certificateAuthority) ?? 0) + 1);
    }
  }
  let sharedCa: string | undefined;
  let bestCount = 1;
  for (const [ca, count] of counts) {
    if (count > bestCount) { bestCount = count; sharedCa = ca; }
  }
  if (!sharedCa) return payload;
  return {
    ...payload,
    certificateAuthority: sharedCa,
    routes: payload.routes.map((route) => {
      if (route.name === "VPS" || route.certificateAuthority !== sharedCa) return route;
      const { certificateAuthority: _omitted, ...rest } = route;
      return rest;
    }),
  };
}

/** Build a connect QR payload. v1 (one direct route) unless `version: 2` is
 * asked for: Apps up to 1.6.0 accept only v1 and report any other code as
 * damaged. v2 carries several direct candidates for newer Apps to race, and is
 * used only when there is more than one to carry. Cloudflare routes are never
 * written into a v2 code: any Cloudflare route forces v1. */
export function connectionPairingPayload(
  hubPublicKey: string,
  local: readonly Route[],
  deployment?: Deployment,
  activeUrl?: string,
  options?: { version?: 1 | 2 },
): Extract<PairingPayload, { kind: "connect" }> {
  const allDirects = local.filter(isDirectRoute);
  const primary = (activeUrl ? allDirects.find(route => route.url === activeUrl) : undefined)
    ?? allDirects.find(route => route.name === "Tailscale")
    ?? allDirects.find(route => route.name === "Direct");
  const orderedDirects = primary
    ? [primary, ...allDirects.filter(route => route.url !== primary.url)].slice(0, MAX_DIRECT_ROUTES)
    : [];
  // The relay in use (VPS or Cloudflare) goes first.
  const allRelays = local.filter(isRelayRoute);
  const relays = (activeUrl ? [...allRelays.filter(route => route.url === activeUrl), ...allRelays.filter(route => route.url !== activeUrl)] : allRelays).slice(0, MAX_VPS_ROUTES);

  if (options?.version !== 2 || orderedDirects.length <= 1 || relays.some(isEdgeTlsRoute)) {
    const direct = orderedDirects[0];
    const routes = routesSchema.parse([...(direct ? [direct] : []), ...relays]);
    return {
      v: 1,
      kind: "connect",
      hubPublicKey,
      routes,
      ...(deployment && deploymentMatchesRoutes(deployment, routes) ? { deployment } : {}),
    };
  }

  const routes = localRoutesSchema.parse([...orderedDirects, ...relays]);
  return {
    v: 2,
    kind: "connect",
    hubPublicKey,
    routes,
    ...(deployment && deploymentMatchesRoutes(deployment, routes) ? { deployment } : {}),
  };
}

export function pairingLink(payload: PairingPayload): string {
  // Keep v1 data intact: previously paired older clients can still read routes.
  // Their first-time registration cannot bypass the Host's invitation gate.
  const { invite, ...raw } = payload as PairingPayload & { invite?: string };
  if (invite !== undefined && payload.kind !== "connect") throw new Error(t("配对二维码无效"));
  const data = raw.kind === "connect" && raw.v === 2 ? compactV2ConnectPayload(raw) : raw;
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
    const parsedJson: unknown = JSON.parse(url.searchParams.get("data") ?? "{}");
    const isV2 = typeof parsedJson === "object" && parsedJson !== null && (parsedJson as { v?: unknown }).v === 2;
    const invite = url.searchParams.get("invite");
    if (isV2) {
      const v2 = connectV2Schema.parse(parsedJson);
      const routes = v2.routes.map((r): Route => ({
        ...r,
        url: validateRoute(r.url),
        ...(r.certificateAuthority ? { certificateAuthority: r.certificateAuthority } : r.name !== "VPS" && v2.certificateAuthority ? { certificateAuthority: v2.certificateAuthority } : {}),
      }));
      return {
        v: 2,
        kind: "connect",
        hubPublicKey: v2.hubPublicKey,
        routes,
        ...(v2.deployment ? { deployment: v2.deployment } : {}),
        ...(invite !== null ? { invite: inviteSchema.parse(invite) } : {}),
      };
    }
    const payload = payloadSchema.parse(parsedJson);
    if (payload.kind === "connect") payload.routes = payload.routes.map((r): Route => ({ ...r, url: validateRoute(r.url) }));
    if (invite !== null && payload.kind !== "connect") throw new Error("invalid_pairing_invite");
    return invite === null || payload.kind !== "connect" ? payload : { ...payload, invite: inviteSchema.parse(invite) };
  } catch { throw new Error(t("配对信息不完整或已损坏，请重新复制或扫描二维码。")); }
}
