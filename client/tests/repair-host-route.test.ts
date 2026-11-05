import { describe, expect, it } from "vitest";
import { repairRoutes } from "../src/RepairHostRoute.js";
import type { PairingPayload } from "../src/PairingCode.js";
import type { Deployment, Route } from "../../src/client-protocol/routes.js";

const hubPublicKey = `MCowBQYDK2VwAyEA${"h".repeat(44)}`;
const oldCa = "A".repeat(120), newCa = "B".repeat(120);
const relays: Route[] = [{ name: "VPS", url: "https://relay-a.example.com", label: "Tokyo" }, { name: "VPS", url: "https://relay-b.example.com" }];
const identity = (routes: Route[], deployment?: Deployment) => ({ hubPublicKey, routes, deployment });
const connect = (routes: Route[], deployment?: Deployment, key = hubPublicKey): PairingPayload => ({ v: 1, kind: "connect", hubPublicKey: key, routes, ...(deployment ? { deployment } : {}) });

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
});
