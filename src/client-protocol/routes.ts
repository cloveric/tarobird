import { z } from "zod";

export const MAX_VPS_ROUTES = 8;
export const MAX_DIRECT_ROUTES = 4;
export const MAX_LOCAL_ROUTES = MAX_DIRECT_ROUTES + MAX_VPS_ROUTES;
export const routeUrlSchema = z.string().trim().max(2048).url().refine((value) => {
  try {
    const u = new URL(value);
    return !u.username && !u.password && !u.search && !u.hash && u.pathname === "/" &&
      (u.protocol === "https:" || u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname));
  } catch { return false; }
}, "Route must be an HTTPS origin (loopback HTTP is allowed)").transform((value) => new URL(value).origin);
export const routeLabelSchema = z.string().trim().min(1).max(40).regex(/^[^\u0000-\u001f\u007f]+$/);
export const routeNameSchema = z.enum(["Tailscale", "Direct", "VPS"]);
export const deploymentSchema = z.enum(["computer", "vps-direct", "vps-relay"]);
export type Deployment = z.infer<typeof deploymentSchema>;
export const routeSchema = z.object({ name: routeNameSchema, url: routeUrlSchema, label: routeLabelSchema.optional(), certificateAuthority: z.string().min(100).max(4096).regex(/^[A-Za-z0-9+/]+={0,2}$/).optional() }).strict();
export const routesSchema = z.array(routeSchema).min(1).max(MAX_VPS_ROUTES + 1).superRefine((routes, ctx) => {
  if (routes.filter((r) => r.name !== "VPS").length > 1 || routes.filter((r) => r.name === "VPS").length > MAX_VPS_ROUTES) ctx.addIssue({ code: "custom", message: "At most one direct route and eight VPS routes" });
  if (new Set(routes.map((r) => r.url)).size !== routes.length) ctx.addIssue({ code: "custom", message: "Duplicate route URL" });
});
/** Client-local candidate list. Do not use in signed directories or v1 QR
 * payloads: older peers require the unchanged single-direct wire schema. */
export const localRoutesSchema = z.array(routeSchema).min(1).max(MAX_LOCAL_ROUTES).superRefine((routes, ctx) => {
  if (routes.filter(route => route.name !== "VPS").length > MAX_DIRECT_ROUTES || routes.filter(route => route.name === "VPS").length > MAX_VPS_ROUTES) ctx.addIssue({ code: "custom", message: "At most four LAN/Tailscale routes and eight VPS routes" });
  if (new Set(routes.map(route => route.url)).size !== routes.length) ctx.addIssue({ code: "custom", message: "Duplicate route URL" });
});
export type Route = z.infer<typeof routeSchema>;
/** Display order and tie-break only; route type is not evidence of performance. */
export function orderedRoutes(routes: readonly Route[]): Route[] { return [...routes.filter((r) => r.name !== "VPS"), ...routes.filter((r) => r.name === "VPS")]; }
/** A client description, not an instruction to provision or migrate the Hub. */
export function deploymentMatchesRoutes(deployment: Deployment | undefined, routes: readonly Route[]): boolean {
  return deployment === "vps-direct" ? routes.some((r) => r.name !== "VPS") : deployment === "vps-relay" ? routes.length > 0 && routes.every((r) => r.name === "VPS") : true;
}
export type ConnectionVerificationFailure = "identity-mismatch" | "verification-unavailable" | "invalid-key";
export type RouteHealth = { failure?: ConnectionVerificationFailure; url: string; status: "reachable" | "unreachable" | "wrong-hub" | "cooldown"; latency?: number };
