import { deploymentMatchesRoutes, localRoutesSchema, MAX_DIRECT_ROUTES, MAX_VPS_ROUTES, type Deployment, type Route } from "../../src/client-protocol/routes.js";
import { networkCanonical } from "../../src/client-protocol/private-network.js";

export type HostRouteMergeInput = {
  /** Stored identity routes; the caller passes this exact array as `expected`. */
  ours: readonly Route[];
  /** Last host-published set already applied. Absent: add-only, never delete. */
  base?: readonly Route[];
  /** Origins predating discovery or edited by the user. Never withdraw them. */
  manual?: readonly string[];
  /** Fresh host-published set, from an authenticated, key-bound source. */
  theirs: readonly Route[];
  /** The connected route is never removed or rewritten underneath its socket. */
  active?: string;
  deployment?: Deployment;
};
export type HostRouteMerge = { routes: Route[]; base: Route[]; manual: string[]; deployment?: Deployment; changed: boolean; limited: boolean; deferred: string[] };

const same = (a: Route | undefined, b: Route | undefined) => !!a && !!b && networkCanonical(a) === networkCanonical(b);
const direct = (route: Route) => route.name !== "VPS";

/** Per-origin three-way merge. Host additions are adopted unless the user
 * already has that origin; host withdrawals and changes apply only to routes
 * the user left exactly as published; anything only the user has is manual.
 * A user-deleted published route stays deleted. A missing CA is filled for the
 * same origin, but a different user CA is never replaced. */
export function mergeHostRoutes({ ours, base, manual, theirs, active, deployment }: HostRouteMergeInput): HostRouteMerge {
  const previous = new Map((base ?? []).map(route => [route.url, route])), published = new Map(theirs.map(route => [route.url, route]));
  const manualOrigins = new Set(manual ?? []);
  // Remember coincident manual routes separately from the published base.
  // Keeping the base also remembers deletions, so a later sync cannot re-add
  // a route the user removed while the host is still publishing it.
  for (const route of ours) if (published.has(route.url) && !same(route, previous.get(route.url))) manualOrigins.add(route.url);
  const routes: Route[] = [], deferred: string[] = [], skipped = new Set<string>();
  for (const route of ours) {
    const was = previous.get(route.url), now = published.get(route.url);
    if (route.url === active) {
      routes.push(route);
      // Retry the withdrawal/change once this route is no longer carrying the session.
      if (was && !manualOrigins.has(route.url) && !same(was, now) && same(route, was)) deferred.push(route.url);
    } else if (now) routes.push(!manualOrigins.has(route.url) && same(route, was) ? structuredClone(now) : !route.certificateAuthority && now.certificateAuthority ? { ...route, certificateAuthority: now.certificateAuthority } : route);
    else if (manualOrigins.has(route.url) || !same(route, was)) routes.push(route);
  }
  for (const route of theirs) {
    if (routes.some(item => item.url === route.url) || previous.has(route.url)) continue;
    const kind = direct(route), count = routes.filter(item => direct(item) === kind).length;
    if (count >= (kind ? MAX_DIRECT_ROUTES : MAX_VPS_ROUTES)) { skipped.add(route.url); continue; }
    // Configured order is only a tie-break: keep new direct paths after existing ones.
    let after = routes.length;
    if (kind) { after = 0; routes.forEach((item, index) => { if (direct(item)) after = index + 1; }); }
    routes.splice(after, 0, structuredClone(route));
  }
  const nextBase = theirs.filter(route => !skipped.has(route.url)).map(route => structuredClone(route));
  for (const url of deferred) {
    const index = nextBase.findIndex(route => route.url === url), old = structuredClone(previous.get(url)!);
    if (index >= 0) nextBase[index] = old; else nextBase.push(old);
  }
  const unchanged = { routes: [...ours], base: base ? [...base] : [], manual: [...(manual ?? [])], deployment, changed: false, limited: skipped.size > 0, deferred };
  // Never apply a set the connection would reject; keep the old base so the
  // same host change is evaluated again rather than silently absorbed.
  if (!routes.length || !localRoutesSchema.safeParse(routes).success) return { ...unchanged, limited: true };
  const nextDeployment = deploymentMatchesRoutes(deployment, routes) ? deployment : undefined;
  return { routes, base: nextBase, manual: [...manualOrigins].filter(url => routes.some(route => route.url === url) || published.has(url)).sort(), deployment: nextDeployment,
    changed: networkCanonical(routes) !== networkCanonical(ours) || nextDeployment !== deployment, limited: skipped.size > 0, deferred };
}
