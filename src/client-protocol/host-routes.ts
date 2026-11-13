import { z } from "zod";
import { isLoopbackOrUnspecified } from "./loopback-address.js";
import { localRoutesSchema, MAX_LOCAL_ROUTES, routeSchema, type Route } from "./routes.js";

/** Advertised in `ready.serverCapabilities` by Hubs that serve the owner-only
 * self-route view below. Older Hubs omit it; clients then keep their routes. */
export const HOST_ROUTES_CAPABILITY = "host-routes.v1";
export const HOST_LAN_SELECTION_CAPABILITY = "host-routes.select-lan.v1";
export const HOST_LAN_SELECTION_PATH = "/api/network/host-routes/select-lan";
export const managedLanSelectionSchema = z.object({ route: routeSchema }).strict();
export const HOST_ROUTES_PATH = "/api/network/host-routes";

/** `shared` routes are the host's signed single-direct descriptor (wire v2).
 * `managed` routes are additional desktop-managed LAN/Tailscale listeners that
 * never enter the signed directory, QR v1 or `private-network:v1` state. The
 * tag exists only in this envelope; stored routes stay plain strict routes. */
export const hostRouteSourceSchema = z.enum(["shared", "managed"]);
export const hostRouteNoticeSchema = z.enum([
  "lan_selection_required", "lan_not_listening", "tailscale_not_listening", "replacement_pending",
]);
export type HostRouteNotice = z.infer<typeof hostRouteNoticeSchema>;
const modeSchema = z.object({ enabled: z.boolean(), listening: z.boolean() }).strict();
export const hostRoutesViewSchema = z.object({
  v: z.literal(1),
  hostPublicKey: z.string().min(1).max(128),
  routes: z.array(z.object({ source: hostRouteSourceSchema, route: routeSchema }).strict()).max(MAX_LOCAL_ROUTES),
  local: z.object({ lan: modeSchema, tailscale: modeSchema }).strict(),
  notices: z.array(hostRouteNoticeSchema).max(8),
  observedAt: z.number().int().nonnegative().safe(),
}).strict().superRefine((view, ctx) => {
  const routes = view.routes.map(entry => entry.route);
  if (routes.length && !localRoutesSchema.safeParse(routes).success) ctx.addIssue({ code: "custom", message: "invalid_host_routes" });
  // A phone must never be told to dial its own loopback or an unspecified bind.
  for (const route of routes) {
    const url = new URL(route.url);
    if (url.protocol !== "https:" || isLoopbackOrUnspecified(url.hostname)) ctx.addIssue({ code: "custom", message: "invalid_host_route_address" });
  }
});
export type HostRoutesView = z.infer<typeof hostRoutesViewSchema>;
export function hostRoutesOf(view: HostRoutesView): Route[] { return view.routes.map(entry => entry.route); }
