import { expect, it } from "vitest";
import { mergeHostRoutes } from "../client/src/host-route-sync.js";
import { sharedRouteReplacement, type HostRoutesRecord } from "../src/hub/host-routes.js";
import type { Route } from "../src/client-protocol/routes.js";

const ca = "A".repeat(120);
const lan: Route = { name: "Direct", url: "https://192.168.1.20:8788", certificateAuthority: ca };
const vpn: Route = { name: "Tailscale", url: "https://100.80.1.20:8788", certificateAuthority: ca };
const relay: Route = { name: "VPS", url: "https://relay.example.test" };

it("a device initially paired through VPS can learn Tailscale without changing host identity", () => {
  const result = mergeHostRoutes({ ours: [relay], theirs: [relay, vpn], deployment: "vps-relay" });
  expect(result.routes).toEqual(expect.arrayContaining([relay, vpn]));
  expect(result.limited).toBe(false);
});
it("a matching manual route remains manual after first discovery and later host withdrawal", () => {
  const first = mergeHostRoutes({ ours: [lan, relay], theirs: [lan, vpn] });
  const second = mergeHostRoutes({ ours: first.routes, base: first.base, manual: first.manual, theirs: [lan, vpn] });
  const withdrawn = mergeHostRoutes({ ours: second.routes, base: second.base, manual: second.manual, theirs: [vpn] });
  expect(withdrawn.routes).toContainEqual(lan);
  expect(withdrawn.routes).toContainEqual(relay);
});
it("managed refresh cannot replace a user-owned public Direct IP sharing the desktop CA and port", () => {
  const custom: Route = { ...lan, url: "https://198.51.100.20:8788" };
  const record: HostRoutesRecord = { v: 1, modes: { lan: { route: lan, seen: 2 } }, changedAt: 0, sharedAt: 0 };
  expect(sharedRouteReplacement([custom, relay], record, [{ host: "192.168.1.20", port: 8788, listening: true, authority: ca }])).toBeUndefined();
});

it("a user deletion after discovery of a coincident manual route is not undone", () => {
  const first = mergeHostRoutes({ ours: [lan, relay], theirs: [lan, vpn] });
  const deleted = mergeHostRoutes({ ours: [relay, vpn], base: first.base, manual: first.manual, theirs: [lan, vpn] });
  expect(deleted.routes.some(route => route.url === lan.url)).toBe(false);
});
