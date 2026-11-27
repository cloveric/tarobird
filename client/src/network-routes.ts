import { isRelayRoute, routesSchema, type Route } from '../../src/client-protocol/routes.js';
/** An invite must preserve configured relay fallbacks. A LAN QR does not replace
 * an already shared Tailscale direct route that also works away from home. */
export function mergeNetworkInviteRoute(existing: Route[], selected: Route, replaceDirect = false): Route[] {
  if (isRelayRoute(selected)) return routesSchema.parse([...existing.filter(route => route.url !== selected.url), selected]);
  const direct = selected.name === 'Direct' && !replaceDirect ? existing.find(route => route.name === 'Tailscale') ?? selected : selected;
  const merged = [direct, ...existing.filter(route => isRelayRoute(route) && route.url !== direct.url)];
  return routesSchema.parse(merged);
}
