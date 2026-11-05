import { routesSchema, type Route } from '../../src/client-protocol/routes.js';
/** An invite must preserve configured VPS fallback. A LAN QR does not replace
 * an already shared Tailscale direct route that also works away from home. */
export function mergeNetworkInviteRoute(existing: Route[], selected: Route, replaceDirect = false): Route[] {
  if (selected.name === 'VPS') return routesSchema.parse([...existing.filter(route => route.url !== selected.url), selected]);
  const direct = selected.name === 'Direct' && !replaceDirect ? existing.find(route => route.name === 'Tailscale') ?? selected : selected;
  const merged = [direct, ...existing.filter(route => route.name === 'VPS' && route.url !== direct.url)];
  return routesSchema.parse(merged);
}
