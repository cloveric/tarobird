import { expect, it } from "vitest";
import { routesSchema, localRoutesSchema } from "../src/client-protocol/routes.js";
import { sharedRoutesSchema } from "../src/client-protocol/private-network.js";
import { repairRoutes, renewedPairingRoutes } from "../client/src/RepairHostRoute.js";
import { multipathConfiguration } from "../client/src/connection-routes.js";

const lan = { name: "Direct" as const, url: "https://192.168.1.20:8788", certificateAuthority: "A".repeat(120) };
const vpn = { name: "Tailscale" as const, url: "https://100.80.1.20:8788", certificateAuthority: "A".repeat(120) };
const relay = { name: "VPS" as const, url: "https://relay.example.test", label: "My relay", certificateAuthority: "B".repeat(120) };
const hubPublicKey = `MCowBQYDK2VwAyEA${"h".repeat(44)}`;

it("stores three paths locally without changing legacy signed-directory wire constraints", () => {
  expect(localRoutesSchema.parse([lan, vpn, relay])).toEqual([lan, vpn, relay]);
  for (const schema of [routesSchema, sharedRoutesSchema]) expect(schema.safeParse([lan, vpn, relay]).success).toBe(false);
});
it("repairing a Tailscale QR never removes the LAN route or changes the paired identity", () => {
  const identity = { hubPublicKey, routes: [lan, relay] };
  const repair = repairRoutes(identity, { v: 1, kind: "connect", hubPublicKey, routes: [vpn] });
  expect(repair?.routes).toEqual(expect.arrayContaining([lan, vpn, relay]));
  expect(identity).toEqual({ hubPublicKey, routes: [lan, relay] });
});
it("repairing a changed LAN address retains Tailscale while removing the stale LAN origin", () => {
  const fresh = { ...lan, url: "https://192.168.1.21:8788" };
  const repair = repairRoutes({ hubPublicKey, routes: [lan, vpn, relay] }, { v: 1, kind: "connect", hubPublicKey, routes: [fresh] });
  expect(repair?.routes).toEqual(expect.arrayContaining([fresh, vpn, relay]));
  expect(repair?.routes.some(route => route.url === lan.url)).toBe(false);
});
it("still rejects duplicate origins, unsafe plaintext and a different host's QR", () => {
  expect(localRoutesSchema.safeParse([lan, { ...vpn, url: lan.url }]).success).toBe(false);
  expect(localRoutesSchema.safeParse([{ ...vpn, url: "http://100.80.1.20:8788" }]).success).toBe(false);
  expect(() => repairRoutes({ hubPublicKey, routes: [lan] }, { v: 1, kind: "connect", hubPublicKey: "other", routes: [vpn] })).toThrow();
});
it("saving all route types preserves scoped CAs but an edited origin never inherits the old row's CA", () => {
  expect(multipathConfiguration([lan, vpn], [relay], [lan, vpn, relay], "computer").routes).toEqual([lan, vpn, relay]);
  const result = multipathConfiguration([{ ...lan, url: "https://192.168.1.21:8788" }, vpn], [{ ...relay, url: "https://new.example.test" }], [lan, vpn, relay]);
  expect(result.routes).toEqual([{ name: "Direct", url: "https://192.168.1.21:8788" }, vpn, { name: "VPS", url: "https://new.example.test", label: "My relay" }]);
});
it("bounds all candidate work, ignores wholly empty optional rows and rejects partly filled rows", () => {
  expect(multipathConfiguration([{ name: "Direct", url: "" }, vpn], [], [vpn]).routes).toEqual([vpn]);
  expect(() => multipathConfiguration([{ name: "Direct", url: "", label: "unfinished" }, vpn], [], [vpn])).toThrow();
  expect(localRoutesSchema.safeParse(Array.from({ length: 5 }, (_, i) => ({ ...lan, url: `https://lan${i}.example.test` }))).success).toBe(false);
  expect(localRoutesSchema.safeParse([lan, vpn, ...Array.from({ length: 8 }, (_, i) => ({ name: "VPS", url: `https://relay${i}.example.test` }))]).success).toBe(true);
});

it("QR repair preserves a custom public Direct route and ambiguous existing LAN routes", () => {
  const custom = { ...lan, url: "https://custom.example.test:8788" };
  const fresh = { ...lan, url: "https://192.168.1.21:8788" };
  expect(repairRoutes({ hubPublicKey, routes: [custom, relay] }, { v: 1, kind: "connect", hubPublicKey, routes: [fresh] })?.routes).toEqual(expect.arrayContaining([custom, fresh, relay]));
  const second = { ...lan, url: "https://192.168.2.20:8788" };
  expect(repairRoutes({ hubPublicKey, routes: [lan, second, relay] }, { v: 1, kind: "connect", hubPublicKey, routes: [fresh] })?.routes).toEqual(expect.arrayContaining([lan, second, fresh, relay]));
});


it("a multi-route identity produces a legacy-decodable QR with scoped trust and without changing its local routes", async () => {
  const { connectionPairingPayload, pairingLink, parsePairingLink } = await import("../client/src/pairing-link.js");
  const local = [
    { name: "Direct" as const, url: "https://192.168.10.5:8788", certificateAuthority: "A".repeat(120) },
    { name: "Tailscale" as const, url: "https://100.80.1.5:8788", certificateAuthority: "B".repeat(120) },
    { name: "VPS" as const, url: "https://relay.example" },
  ];
  const copy = structuredClone(local);
  const payload = connectionPairingPayload("h".repeat(44), local, "computer");
  expect(parsePairingLink(pairingLink(payload))).toEqual({ v: 1, kind: "connect", hubPublicKey: "h".repeat(44), routes: [local[1], local[2]], deployment: "computer" });
  expect(local).toEqual(copy);
  const activeLan = connectionPairingPayload("h".repeat(44), local, "computer", local[0]!.url);
  expect(parsePairingLink(pairingLink(activeLan))).toMatchObject({ routes: [local[0], local[2]] });
  expect(connectionPairingPayload("h".repeat(44), local, undefined, "https://not-saved.example")).toMatchObject({ routes: [local[1], local[2]] });
});


it("renewed private pairing addresses preserve other paths, while public or trust changes require review", () => {
  const identity = { hubPublicKey, routes: [lan, vpn, relay] };
  const payload = (route: typeof lan | typeof vpn) => ({ v: 1 as const, kind: "connect" as const, hubPublicKey, routes: [route] });
  const fresh = { ...lan, url: "https://192.168.1.21:8788" };
  expect(renewedPairingRoutes(identity, payload(fresh))?.routes).toEqual([fresh, vpn, relay]);
  expect(renewedPairingRoutes(identity, payload({ ...vpn, url: "https://100.80.1.21:8788" }))?.routes).toContainEqual(lan);
  for (const route of [{ ...lan, url: "https://public.example.test:8788" }, { ...lan, certificateAuthority: "B".repeat(120) }, { ...lan, url: fresh.url, certificateAuthority: undefined }, { ...lan, url: fresh.url, certificateAuthority: "C".repeat(120) }, { ...vpn, url: "https://public.example.test" }, { ...vpn, url: "https://100.64.untrusted.example" }, { ...lan, url: "https://192.168.untrusted.example" }]) {
    expect(() => renewedPairingRoutes(identity, payload(route as typeof lan))).toThrow("pairing_route_confirmation_required");
  }
  expect(() => renewedPairingRoutes(identity, { ...payload(fresh), hubPublicKey: "other" })).toThrow();
  expect(() => renewedPairingRoutes({ hubPublicKey, routes: [relay] }, payload(fresh))).toThrow("pairing_route_confirmation_required");
  expect(identity.routes).toEqual([lan, vpn, relay]);
});
