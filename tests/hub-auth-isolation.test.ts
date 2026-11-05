import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HubStore } from "../src/hub/store.js";
import { HubAuth, deviceProof, rateSource } from "../src/hub/auth.js";

let root: string, store: HubStore, auth: HubAuth, now: number;
const keys = generateKeyPairSync("ed25519"), nonce = () => randomBytes(32).toString("base64url");
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hub-auth-isolation-")); now = Date.now();
  store = await HubStore.open(root); auth = await HubAuth.open(store, root, () => now);
  for (const deviceId of ["device_one", "device_two"]) {
    const pair = await auth.pair({ deviceId, name: deviceId, platform: "web", publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64") }, "local");
    await auth.approve(pair.code, "local-owner");
  }
});
afterEach(async () => { await store.db.close(); await rm(root, { recursive: true, force: true }); });
async function login(id: string, source = "shared") {
  const clientNonce = nonce(), challenge = await auth.challenge(id, id, clientNonce, source);
  return auth.authenticate(id, sign(null, deviceProof(id, challenge.nonce, clientNonce), keys.privateKey).toString("base64"));
}
it("keeps unknown-device challenges separate from enrolled devices behind the same address", async () => {
  for (let i = 0; i < 60; i++) await expect(auth.challenge(`unknown_${i}`, `missing_${i}`, nonce(), "shared")).rejects.toThrow("untrusted_device");
  await expect(auth.challenge("last", "missing_last", nonce(), "shared")).rejects.toThrow("rate_limited");
  expect((await login("device_one")).token).toBeTruthy();
});
it("never rejects a valid device proof because someone else sent invalid signatures", async () => {
  for (let i = 0; i < 6; i++) {
    await auth.challenge("bad", "device_one", nonce(), "shared");
    await expect(auth.authenticate("bad", Buffer.alloc(64).toString("base64"))).rejects.toThrow(i < 5 ? "signature_invalid" : "rate_limited");
  }
  expect((await login("device_one")).token).toBeTruthy();
  expect((await login("device_two")).token).toBeTruthy();
});
it("limits one enrolled device without consuming another device's challenge quota", async () => {
  for (let i = 0; i < 60; i++) { await auth.challenge("one", "device_one", nonce(), "shared"); auth.forgetConnection("one"); }
  await expect(auth.challenge("one", "device_one", nonce(), "shared")).rejects.toThrow("rate_limited");
  expect((await login("device_two")).token).toBeTruthy();
});

it("bounds source buckets, reserves known/local capacity, and recovers after expiry", async () => {
  const certificate = Buffer.from("fixture TLS leaf");
  auth.tlsIdentity(nonce(), certificate, "existing");
  for (let i = 0; i < 5000; i++) { try { auth.tlsIdentity(nonce(), certificate, `source_${i}`); } catch (error) { expect((error as Error).message).toBe("rate_limited"); } }
  expect(auth.tlsIdentity(nonce(), certificate, "existing")).toBeDefined();
  expect(() => auth.tlsIdentity(nonce(), certificate, "new_source")).toThrow("rate_limited");
  expect(Reflect.get(auth, "limits").size).toBe(4096);
  expect((await login("device_one")).token).toBeTruthy();
  expect(auth.tlsIdentity(nonce(), certificate, "127.0.0.1")).toBeDefined();
  now += 5 * 60_000 + 1;
  expect(auth.tlsIdentity(nonce(), certificate, "new_source")).toBeDefined();
  expect(Reflect.get(auth, "limits").size).toBe(1);
});
it("counts one IPv6 /64 as one source when remote callers cite an enrolled device", async () => {
  for (let i = 0; i < 4200; i++) {
    try { await auth.challenge(`flood_${i}`, "device_one", nonce(), `2001:db8:0:1::${i.toString(16)}`); } catch (error) { expect((error as Error).message).toBe("rate_limited"); }
    auth.forgetConnection(`flood_${i}`);
  }
  // The same device from a new network is not locked out by that one /64.
  expect((await login("device_one", "198.51.100.7")).token).toBeTruthy();
});
it("keeps owner approvals and local callers out of reach of remote device-citing floods", async () => {
  // Distinct /64s are the documented distributed-flood boundary for remote
  // callers; they must still never consume owner approval or loopback quota.
  for (let i = 0; i < 4200; i++) {
    try { await auth.challenge(`flood_${i}`, "device_one", nonce(), `2001:db8:${i.toString(16)}::1`); } catch (error) { expect((error as Error).message).toBe("rate_limited"); }
    auth.forgetConnection(`flood_${i}`);
  }
  expect(auth.tlsIdentity(nonce(), Buffer.from("fixture TLS leaf"), "127.0.0.1")).toBeDefined();
  const pending = await auth.pair({ deviceId: "device_three", name: "device_three", platform: "web", publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64") }, "local");
  await expect(auth.approve(pending.code, "local-owner")).resolves.toBeDefined();
});
it("canonicalizes rate sources: IPv4-mapped forms are IPv4 and an IPv6 /64 is one source", () => {
  expect(rateSource("192.0.2.1")).toBe("192.0.2.1");
  expect(rateSource("::ffff:192.0.2.1")).toBe("192.0.2.1");
  expect(rateSource("::ffff:c000:201")).toBe("192.0.2.1");
  expect(rateSource("::FFFF:C000:0202")).toBe("192.0.2.2");
  expect(rateSource("2001:db8:0:1::abcd")).toBe("2001:db8:0:1::/64");
  expect(rateSource("2001:0db8:0000:0001:0000:0000:0000:0001")).toBe("2001:db8:0:1::/64");
  expect(rateSource("2001:db8:0:0:1:0:0:1")).toBe("2001:db8:0:0::/64");
  expect(rateSource("relay:primary:2001:db8:5:6::9")).toBe("relay:primary:2001:db8:5:6::/64");
  expect(rateSource("relay:primary:::ffff:c000:201")).toBe("relay:primary:192.0.2.1");
  expect(rateSource("relay:primary:legacy")).toBe("relay:primary:legacy");
  for (const label of ["local", "shared", "fe80::1%en0"]) expect(rateSource(label)).toBe(label);
});

