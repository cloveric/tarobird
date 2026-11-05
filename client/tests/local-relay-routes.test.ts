import { describe, expect, it } from "vitest";
import { localRelayRoutes, sameRelayConfiguration } from "../src/local-relay-routes.js";
import type { NetworkView } from "../../src/client-protocol/private-network.js";
import type { Route } from "../../src/client-protocol/routes.js";

const direct: Route = { name: "Tailscale", url: "https://100.100.1.2:8788", certificateAuthority: "retained-by-merge" };
const relay: Route = { name: "VPS", url: "https://relay.example.com", label: "Primary" };
const view = (routes: Route[], key = "host") => ({ host: { publicKey: key, routes }, sync: "standalone", lastSyncedAt: 0 }) as NetworkView;
describe("local host relay configuration", () => {
  // Real PEM validation is covered by route-schema tests; use an ordinary
  // direct route here so this suite exercises edit/merge ownership.
  const lan: Route = { name: "Tailscale", url: direct.url, label: "Home" };
  it("preserves direct route metadata and normalizes a relay", () => {
    expect(localRelayRoutes([lan], [{ ...relay, url: " https://relay.example.com/ ", label: " Primary " }])).toEqual([lan, relay]);
  });
  it("removes all relays while retaining direct access", () => { expect(localRelayRoutes([lan, relay], [])).toEqual([lan]); expect(localRelayRoutes([relay], [])).toEqual([]); });
  for (const url of ["", "http://relay.example.com", "https://127.0.0.1", "https://localhost", "https://0.0.0.0", "https://[::1]"]) it(`rejects non-shareable input ${url}`, () => { expect(() => localRelayRoutes([], [{ name: "VPS", url }])).toThrow(); });
  it("rejects duplicates and more than eight relays", () => {
    expect(() => localRelayRoutes([lan], [relay, relay])).toThrow();
    expect(() => localRelayRoutes([lan], [{ name: "VPS", url: lan.url }])).toThrow();
    expect(() => localRelayRoutes([], Array.from({ length: 9 }, (_, i) => ({ name: "VPS", url: `https://relay${i}.example.com` })))).toThrow();
  });
  it("allows a fresh direct route but detects edited relay configuration and host changes", () => {
    expect(sameRelayConfiguration(view([relay]), view([lan, relay]))).toBe(true);
    expect(sameRelayConfiguration(view([relay]), view([{ ...relay, label: "Changed" }]))).toBe(false);
    expect(sameRelayConfiguration(view([relay]), view([relay], "other"))).toBe(false);
    const network = { ...view([relay]), membership: { manifest: { id: "joined", authorityKey: "authority" } } } as NetworkView;
    expect(sameRelayConfiguration(view([relay]), network)).toBe(false);
  });
});
