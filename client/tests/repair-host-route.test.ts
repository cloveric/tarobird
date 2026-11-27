import { describe, expect, it } from "vitest";
import { renewedPairingRoutes, repairRoutes } from "../src/RepairHostRoute.js";
import type { PairingPayload } from "../src/PairingCode.js";
import { connectionPairingPayload, pairingLink, parsePairingLink } from "../src/pairing-link.js";
import type { Deployment, Route } from "../../src/client-protocol/routes.js";

const hubPublicKey = `MCowBQYDK2VwAyEA${"h".repeat(44)}`;
const oldCa = "A".repeat(120), newCa = "B".repeat(120);
const relays: Route[] = [{ name: "VPS", url: "https://relay-a.example.com", label: "Tokyo" }, { name: "VPS", url: "https://relay-b.example.com" }];
const identity = (routes: Route[], deployment?: Deployment) => ({ hubPublicKey, routes, deployment });
const connect = (routes: Route[], deployment?: Deployment, key = hubPublicKey): PairingPayload => ({ v: 1, kind: "connect", hubPublicKey: key, routes, ...(deployment ? { deployment } : {}) });
const connectV2 = (routes: Route[], deployment?: Deployment, key = hubPublicKey): PairingPayload => ({ v: 2, kind: "connect", hubPublicKey: key, routes, ...(deployment ? { deployment } : {}) });

describe("QR route repair", () => {
  it("replaces only the direct route, carries the QR CA and keeps relays in order", () => {
    const repair = repairRoutes(identity([{ name: "Direct", url: "https://192.168.1.20:8788", certificateAuthority: oldCa }, ...relays], "computer"), connect([{ name: "Direct", url: "https://192.168.1.31:8788", certificateAuthority: oldCa }], "computer"));
    expect(repair?.routes).toEqual([{ name: "Direct", url: "https://192.168.1.31:8788", certificateAuthority: oldCa }, ...relays]);
    expect(repair).toMatchObject({ deployment: "computer", relays: 2, certificateChanged: false, replaced: { url: "https://192.168.1.20:8788" } });
  });

  it("adds a direct route to a relay-only device without keeping a contradictory deployment", () => {
    const repair = repairRoutes(identity(relays, "vps-relay"), connect([{ name: "Direct", url: "https://10.0.0.8:8788", certificateAuthority: newCa }], undefined));
    expect(repair?.routes.map((route) => route.url)).toEqual(["https://10.0.0.8:8788", ...relays.map((route) => route.url)]);
    expect(repair?.deployment).toBeUndefined();
    expect(repair?.replaced).toBeUndefined();
  });

  it("does nothing for the same address and trust anchor, but reports a changed CA", () => {
    const saved: Route = { name: "Direct", url: "https://192.168.1.20:8788", label: "Home", certificateAuthority: oldCa };
    expect(repairRoutes(identity([saved, ...relays]), connect([{ name: "Direct", url: saved.url, certificateAuthority: oldCa }]))).toBeUndefined();
    const repair = repairRoutes(identity([saved]), connect([{ name: "Direct", url: saved.url, certificateAuthority: newCa }]));
    expect(repair).toMatchObject({ certificateChanged: true, direct: { label: "Home", certificateAuthority: newCa } });
  });

  it("rejects approval codes, other hosts, relay-only codes and host-local addresses", () => {
    const saved = identity([{ name: "Direct", url: "https://192.168.1.20:8788" }]);
    expect(() => repairRoutes(saved, { v: 1, kind: "approve", hubPublicKey, code: "12345678" })).toThrow();
    expect(() => repairRoutes(saved, connect([{ name: "Direct", url: "https://192.168.1.31:8788" }], "computer", `MCowBQYDK2VwAyEA${"x".repeat(44)}`))).toThrow(/不是当前主机/);
    expect(() => repairRoutes(saved, connect(relays, "vps-relay"))).toThrow(/不含直连地址/);
    expect(() => repairRoutes(saved, connect([{ name: "Direct", url: "https://127.0.0.1:8788" }]))).toThrow(/主机本机/);
    expect(() => repairRoutes({ ...saved, hubPublicKey: undefined }, connect([{ name: "Direct", url: "https://192.168.1.31:8788" }]))).toThrow(/不是当前主机/);
  });

  it("refuses a direct address that duplicates a saved relay", () => {
    expect(() => repairRoutes(identity(relays), connect([{ name: "Direct", url: relays[0]!.url }]))).toThrow(/重复/);
  });

  it("supports repairing saved routes from a v2 multi-candidate QR while checking host identity", () => {
    const scanned: Route[] = [
      { name: "Direct", url: "https://192.168.1.10:23456", certificateAuthority: oldCa },
      { name: "Direct", url: "https://192.168.1.20:23456", certificateAuthority: oldCa },
      { name: "Direct", url: "https://10.0.0.5:23456", certificateAuthority: oldCa },
      relays[0]!,
    ];
    const saved = identity([{ name: "Direct", url: "https://192.168.1.99:23456", certificateAuthority: oldCa }, relays[0]!], "computer");
    const v2Payload = parsePairingLink(pairingLink(connectionPairingPayload(hubPublicKey, scanned, "computer", undefined, { version: 2 })));
    expect(v2Payload.v).toBe(2);
    const repaired = repairRoutes(saved, v2Payload);
    expect(repaired?.routes.map(route => route.url)).toEqual(scanned.map(route => route.url));
    expect(repaired?.directs.map(route => route.url)).toEqual(scanned.slice(0, 3).map(route => route.url));
    expect(repaired?.relays).toBe(1);
    expect(() => repairRoutes({ ...saved, hubPublicKey: `MCowBQYDK2VwAyEA${"z".repeat(44)}` }, v2Payload)).toThrow(/不是当前主机/);
  });

  it("preserves saved Tailscale and custom Direct routes instead of evicting them on a 4-candidate v2 LAN QR", () => {
    const tailscale: Route = { name: "Tailscale", url: "https://100.64.0.1:8788", certificateAuthority: newCa };
    const staleLan: Route = { name: "Direct", url: "https://192.168.1.5:8788", certificateAuthority: oldCa };
    const fourLanPayload = connectV2([
      { name: "Direct", url: "https://192.168.1.10:8788", certificateAuthority: oldCa },
      { name: "Direct", url: "https://192.168.1.20:8788", certificateAuthority: oldCa },
      { name: "Direct", url: "https://192.168.1.30:8788", certificateAuthority: oldCa },
      { name: "Direct", url: "https://10.0.0.40:8788", certificateAuthority: oldCa },
    ], "computer");

    const repaired = repairRoutes(identity([tailscale, staleLan, relays[0]!], "computer"), fourLanPayload);
    expect(repaired?.routes).toContainEqual(tailscale);
    expect(repaired?.routes).toContainEqual(relays[0]!);
    expect(repaired?.routes.some(route => route.url === staleLan.url)).toBe(false);
    expect(repaired?.routes.filter(route => route.name !== "VPS")).toHaveLength(4);
    expect(repaired?.directs.map(route => route.url)).toEqual([
      "https://192.168.1.10:8788",
      "https://192.168.1.20:8788",
      "https://192.168.1.30:8788",
    ]);

    // When all 4 direct slots are already occupied by untouched routes, reject instead of evicting.
    const full = identity([
      tailscale,
      { name: "Direct", url: "https://custom.example.test:8788" },
      { name: "Direct", url: "https://192.168.2.5:8788", certificateAuthority: oldCa },
      { name: "Direct", url: "https://192.168.3.5:8788", certificateAuthority: oldCa },
    ]);
    expect(() => repairRoutes(full, connectV2([
      { name: "Direct", url: "https://192.168.1.10:8788", certificateAuthority: oldCa },
      { name: "Direct", url: "https://192.168.1.20:8788", certificateAuthority: oldCa },
      { name: "Direct", url: "https://192.168.1.30:8788", certificateAuthority: oldCa },
      tailscale,
    ]))).toThrow(/上限/);
  });

  it("validates every direct route in v2 renewal and reports CA changes on routes[1..3]", () => {
    const lan1: Route = { name: "Direct", url: "https://192.168.1.10:8788", certificateAuthority: oldCa };
    const lan2: Route = { name: "Direct", url: "https://192.168.1.20:8788", certificateAuthority: oldCa };
    const tailscale: Route = { name: "Tailscale", url: "https://100.64.0.1:8788", certificateAuthority: newCa };
    const saved = identity([lan1, lan2, tailscale, relays[0]!], "computer");

    // Benign v2 renewal with private LAN routes sharing a known non-VPS CA succeeds.
    const benign = renewedPairingRoutes(
      identity([lan1, tailscale, relays[0]!], "computer"),
      connectV2([
        { name: "Direct", url: "https://192.168.1.11:8788", certificateAuthority: oldCa },
        { name: "Direct", url: "https://192.168.1.21:8788", certificateAuthority: oldCa },
      ], "computer"),
    );
    expect(benign?.routes.map(route => route.url)).toEqual([
      "https://192.168.1.11:8788",
      "https://192.168.1.21:8788",
      tailscale.url,
      relays[0]!.url,
    ]);

    // Public endpoint or untrusted CA hidden in routes[1] must require confirmation.
    expect(() => renewedPairingRoutes(saved, connectV2([
      lan1,
      { name: "Direct", url: "https://evil-public.example:443", certificateAuthority: "C".repeat(120) },
    ]))).toThrow("pairing_route_confirmation_required");

    // New private LAN route with an untrusted or omitted CA in routes[1] must require confirmation.
    expect(() => renewedPairingRoutes(identity([lan1, relays[0]!]), connectV2([
      lan1,
      { name: "Direct", url: "https://192.168.1.30:8788", certificateAuthority: "C".repeat(120) },
    ]))).toThrow("pairing_route_confirmation_required");
    expect(() => renewedPairingRoutes(identity([lan1, relays[0]!]), connectV2([
      lan1,
      { name: "Direct", url: "https://192.168.1.30:8788" },
    ]))).toThrow("pairing_route_confirmation_required");

    // Rotating CA on an already-saved LAN route at routes[1] flags certificateChanged and blocks silent renewal.
    const rotated = connectV2([lan1, { ...lan2, certificateAuthority: newCa }]);
    const repair = repairRoutes(saved, rotated);
    expect(repair?.certificateChanged).toBe(true);
    expect(repair?.certificateChangedDirects.map(route => route.url)).toEqual([lan2.url]);
    expect(() => renewedPairingRoutes(saved, rotated)).toThrow("pairing_route_confirmation_required");
  });
});
