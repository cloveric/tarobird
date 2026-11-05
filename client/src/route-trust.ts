import type { Route } from "./storage.js";
// Public CA material only. Trust is scoped to a specific origin AND Hub key.
const authorities = new Map<string, string>();
export function rememberRouteTrust(routes: readonly Route[], hubKey: string | undefined) {
  if (!hubKey) return;
  for (const route of routes) {
    const key = `${new URL(route.url).origin}\0${hubKey}`;
    if (route.certificateAuthority) authorities.set(key, route.certificateAuthority); else authorities.delete(key);
  }
  while (authorities.size > 128) authorities.delete(authorities.keys().next().value!);
}
export function routeTrust(origin: string, key: string | undefined): { certificateAuthority?: string } {
  const ca = key && authorities.get(`${new URL(origin).origin}\0${key}`);
  return ca ? { certificateAuthority: ca } : {};
}
