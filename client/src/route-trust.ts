import type { Route } from "./storage.js";
// Public CA material and explicit edge-TLS flags only.
// Trust is scoped to a specific origin AND Hub key.
const authorities = new Map<string, string>();
const edgeRoutes = new Set<string>();
export function rememberRouteTrust(routes: readonly Route[], hubKey: string | undefined) {
  if (!hubKey) return;
  for (const route of routes) {
    const key = `${new URL(route.url).origin}\0${hubKey}`;
    if (route.name === "Cloudflare") {
      authorities.delete(key);
      edgeRoutes.add(key);
    } else {
      edgeRoutes.delete(key);
      if (route.certificateAuthority) authorities.set(key, route.certificateAuthority); else authorities.delete(key);
    }
  }
  while (authorities.size > 128) authorities.delete(authorities.keys().next().value!);
  while (edgeRoutes.size > 128) edgeRoutes.delete(edgeRoutes.values().next().value!);
}
export function routeTrust(origin: string, key: string | undefined): { certificateAuthority?: string; edgeTls?: boolean } {
  if (!key) return {};
  const entry = `${new URL(origin).origin}\0${key}`;
  if (edgeRoutes.has(entry)) return { edgeTls: true };
  const ca = authorities.get(entry);
  return ca ? { certificateAuthority: ca } : {};
}
