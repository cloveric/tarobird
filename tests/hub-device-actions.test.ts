import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { HubError } from "../src/hub/store.js";
import { deviceProof, hashSecret, type AuthSession } from "../src/hub/auth.js";
import type { DeviceActionProof } from "../src/client-protocol/device-actions.js";
import { signedDeviceAction } from "./helpers/device-actions.js";

let root: string, hub: HubServer;
beforeEach(async () => { vi.useFakeTimers({ toFake: ["Date"] }); root = await mkdtemp(path.join(os.tmpdir(), "hub-device-actions-")); hub = await HubServer.start({ stateDir: root }); });
afterEach(async () => { vi.restoreAllMocks(); await hub.close(); await rm(root, { recursive: true, force: true }); vi.useRealTimers(); });
async function enroll(id: string, approved = true, userId = "owner") {
  const keys = generateKeyPairSync("ed25519");
  const pair = await hub.auth.pair({ deviceId: id, name: id, platform: "web", publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64") }, id);
  if (!approved) return { keys, pair, token: "" };
  await hub.auth.approve(pair.code, "local-owner", userId);
  const clientNonce = randomBytes(32).toString("base64url"), challenge = await hub.auth.challenge(id, id, clientNonce, id);
  const session = await hub.auth.authenticate(id, sign(null, deviceProof(id, challenge.nonce, clientNonce), keys.privateKey).toString("base64"));
  return { keys, pair, token: session.token };
}
it("does not let a copied bearer token approve another device", async () => {
  const owner = await enroll("owner_device"), attacker = await enroll("attacker_device", false);
  const response = await fetch(hub.url + "/api/devices/approve", { method: "POST", headers: { Authorization: `Bearer ${owner.token}` }, body: JSON.stringify({ code: attacker.pair.code }) });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "device_action_proof_required" });
  expect(await hub.store.device("attacker_device")).toBeUndefined();
});
it("does not let a copied bearer token revoke an existing device", async () => {
  const owner = await enroll("owner_device"); await enroll("other_device");
  const response = await fetch(hub.url + "/api/devices/revoke", { method: "POST", headers: { Authorization: `Bearer ${owner.token}` }, body: JSON.stringify({ deviceId: "other_device" }) });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "device_action_proof_required" });
  expect((await hub.store.device("other_device"))?.revoked).toBe(0);
});
const post = (operation: string, token: string, body: unknown) => fetch(hub.url + `/api/devices/${operation}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

it("approves with a fresh device proof, identifies the approving device in the audit, and rejects replay", async () => {
  const owner = await enroll("owner_device"), target = await enroll("new_device", false);
  const { body, proof } = await signedDeviceAction(hub.url, owner.token, owner.keys.privateKey, { operation: "approve", target: target.pair.code });
  expect((await post("approve", owner.token, body)).status).toBe(200);
  expect((await hub.store.device("new_device"))?.user_id).toBe("owner");
  const replay = await post("approve", owner.token, body);
  expect(replay.status).toBe(403); expect(await replay.json()).toEqual({ error: "device_action_expired" });
  expect(await hub.store.db.get("SELECT id FROM audit_log WHERE kind='pairing.approved' AND actor='owner_device'")).toBeDefined();
  const audit = JSON.stringify(await hub.store.db.all("SELECT * FROM audit_log"));
  for (const secret of [owner.token, target.pair.code, proof.signature, proof.nonce]) expect(audit).not.toContain(secret);
});

it("accepts self-revocation with proof and immediately rejects the old token", async () => {
  const owner = await enroll("owner_device");
  const { body } = await signedDeviceAction(hub.url, owner.token, owner.keys.privateKey, { operation: "revoke", target: "owner_device" });
  const response = await post("revoke", owner.token, body);
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
  expect((await hub.store.device("owner_device"))?.revoked).toBe(1);
  expect((await post("revoke", owner.token, body)).status).toBe(401);
});

it.each(["target", "operation", "session", "signature", "authentication-signature"])("rejects a substituted %s and consumes the proof once", async (substitution) => {
  const owner = await enroll("owner_device"), another = await enroll("another_owner"), target = await enroll("new_device", false);
  const { statement, body } = await signedDeviceAction(hub.url, owner.token, owner.keys.privateKey, { operation: "approve", target: target.pair.code });
  let operation = "approve", token = owner.token, changed: unknown = body;
  if (substitution === "target") changed = { ...body, code: target.pair.code === "12345678" ? "87654321" : "12345678" };
  if (substitution === "operation") { operation = "revoke"; changed = { deviceId: "another_owner", proof: body.proof }; }
  if (substitution === "session") token = another.token;
  if (substitution === "signature") changed = { ...body, proof: { ...body.proof, signature: Buffer.alloc(64).toString("base64") } };
  if (substitution === "authentication-signature") changed = { ...body, proof: { ...body.proof, signature: sign(null, deviceProof("owner_device", statement.nonce, statement.sessionHash), owner.keys.privateKey).toString("base64") } };
  const response = await post(operation, token, changed);
  expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "device_action_invalid" });
  expect(await hub.store.device("new_device")).toBeUndefined(); expect((await hub.store.device("another_owner"))?.revoked).toBe(0);
  expect((await post("approve", owner.token, body)).status).toBe(403);
});

it("binds the proof to a specific token even when both tokens use the same device key", async () => {
  const owner = await enroll("owner_device"), target = await enroll("new_device", false);
  const { body } = await signedDeviceAction(hub.url, owner.token, owner.keys.privateKey, { operation: "approve", target: target.pair.code });
  const nonce = randomBytes(32).toString("base64url"), challenge = await hub.auth.challenge("renewed", "owner_device", nonce, "local");
  const renewed = await hub.auth.authenticate("renewed", sign(null, deviceProof("owner_device", challenge.nonce, nonce), owner.keys.privateKey).toString("base64"));
  expect((await post("approve", renewed.token, body)).status).toBe(403);
  expect(await hub.store.device("new_device")).toBeUndefined();
});

it.each(["expiry", "revocation", "owner-role", "target-key"])("rechecks %s after issuing a challenge and before mutating trust", async (condition) => {
  const owner = await enroll("owner_device"), target = await enroll("new_device", false);
  const { statement, body } = await signedDeviceAction(hub.url, owner.token, owner.keys.privateKey, { operation: "approve", target: target.pair.code });
  if (condition === "expiry") vi.setSystemTime(statement.expiresAt + 1);
  if (condition === "revocation") await hub.auth.revoke("owner_device", "local-owner");
  if (condition === "owner-role") await hub.store.db.serial(() => hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'"));
  if (condition === "target-key") await hub.store.db.serial(() => hub.store.db.run("UPDATE pairing_requests SET public_key='changed' WHERE device_id='new_device'"));
  const response = await post("approve", owner.token, body);
  expect(response.status).toBe(condition === "revocation" ? 401 : condition === "target-key" ? 409 : 403);
  expect(await hub.store.device("new_device")).toBeUndefined();
});

it("bounds outstanding challenges per device without blocking a different trusted device", async () => {
  const first = await enroll("owner_device"), second = await enroll("second_device");
  const action = { operation: "revoke", target: "second_device" };
  for (let i = 0; i < 8; i++) expect((await post("challenge", first.token, action)).status).toBe(200);
  expect((await post("challenge", first.token, action)).status).toBe(429);
  expect((await post("challenge", second.token, action)).status).toBe(200);
  vi.setSystemTime(Date.now() + 30_001);
  expect((await post("challenge", first.token, action)).status).toBe(200);
});

it("does not let unsigned approval attempts exhaust the signed owner's approval quota", async () => {
  const owner = await enroll("owner_device"), target = await enroll("new_device", false);
  for (let i = 0; i < 12; i++) expect((await post("approve", owner.token, { code: target.pair.code })).status).toBe(403);
  const { body } = await signedDeviceAction(hub.url, owner.token, owner.keys.privateKey, { operation: "approve", target: target.pair.code });
  expect((await post("approve", owner.token, body)).status).toBe(200);
});

it("retains a validated approval proof when admission is rate limited", async () => {
  const owner = await enroll("owner_device"), target = await enroll("new_device", false);
  const { body } = await signedDeviceAction(hub.url, owner.token, owner.keys.privateKey, { operation: "approve", target: target.pair.code });
  const rate = vi.spyOn(hub.auth as any, "rate").mockImplementationOnce(() => { throw new HubError("rate_limited", 429); });
  expect((await post("approve", owner.token, body)).status).toBe(429);
  rate.mockRestore();
  expect((await post("approve", owner.token, body)).status).toBe(200);
  expect((await post("approve", owner.token, body)).status).toBe(403);
});

it("allows only one concurrent commit for the same proof", async () => {
  const owner = await enroll("owner_device"), target = await enroll("new_device", false);
  const { body } = await signedDeviceAction(hub.url, owner.token, owner.keys.privateKey, { operation: "approve", target: target.pair.code });
  const results = await Promise.all([post("approve", owner.token, body), post("approve", owner.token, body)]);
  expect(results.map(r => r.status).sort()).toEqual([200, 403]);
  expect(await hub.store.db.all("SELECT id FROM audit_log WHERE kind='pairing.approved' AND actor='owner_device'")).toHaveLength(1);
});

it("refuses a revoke proof if the target's trust record changed after confirmation", async () => {
  const owner = await enroll("owner_device"); await enroll("other_device");
  const { body } = await signedDeviceAction(hub.url, owner.token, owner.keys.privateKey, { operation: "revoke", target: "other_device" });
  await hub.auth.revoke("other_device", "local-owner");
  const response = await post("revoke", owner.token, body);
  expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "device_action_target_changed" });
  expect(await hub.store.db.all("SELECT id FROM audit_log WHERE kind='device.revoked' AND actor='owner_device'")).toHaveLength(0);
});

it("never grants the local CLI bypass to a remotely authenticated user named local-owner", async () => {
  await hub.store.db.serial(() => hub.store.db.run("INSERT INTO users(id,name,role) VALUES('local-owner','Fixture','member')"));
  const member = await enroll("member_device", true, "local-owner"), target = await enroll("new_device", false);
  expect((await post("challenge", member.token, { operation: "approve", target: target.pair.code })).status).toBe(403);
  expect((await post("approve", member.token, { code: target.pair.code })).status).toBe(403);
  expect((await post("revoke", member.token, { deviceId: "member_device" })).status).toBe(403);
  expect(await hub.store.device("new_device")).toBeUndefined();
  expect((await hub.store.device("member_device"))?.revoked).toBe(0);
});

// A stand-in transaction models the caller's network membership write. The
// authorization check must run inside this same transaction, after queueing.
const networkTarget = hashSecret(JSON.stringify(["network-fixture", "join", "host_two"]));
const commitNetworkAction = (session: AuthSession, target: string, proof?: DeviceActionProof) => hub.store.db.transaction(async () => {
  await hub.auth.consumeNetworkAction(session, target, proof);
  await hub.store.db.run("INSERT INTO meta(key,value) VALUES('network-proof-fixture',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [target]);
});
const networkWritten = () => hub.store.db.get("SELECT value FROM meta WHERE key='network-proof-fixture'");

it("rejects a network mutation from a stolen session without its device key", async () => {
  const owner = await enroll("owner_device"), attacker = await enroll("attacker_device");
  const session = await hub.auth.authorize(owner.token);
  await expect(commitNetworkAction(session, networkTarget)).rejects.toThrow("device_action_proof_required");
  const { proof } = await signedDeviceAction(hub.url, owner.token, attacker.keys.privateKey, { operation: "network", target: networkTarget });
  await expect(commitNetworkAction(session, networkTarget, proof)).rejects.toThrow("device_action_invalid");
  expect(await networkWritten()).toBeUndefined();
});

it("commits one network mutation for a fresh proof and never accepts replay", async () => {
  const owner = await enroll("owner_device"), session = await hub.auth.authorize(owner.token);
  const { statement, proof } = await signedDeviceAction(hub.url, owner.token, owner.keys.privateKey, { operation: "network", target: networkTarget });
  expect(statement.targetDigest).toBe(networkTarget);
  const results = await Promise.allSettled([commitNetworkAction(session, networkTarget, proof), commitNetworkAction(session, networkTarget, proof)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { message: "device_action_expired" } });
  expect(await networkWritten()).toEqual({ value: networkTarget });
});

it.each(["body-hash", "session", "same-device-new-session", "operation"])("rejects network proof substitution of %s and consumes the attempt", async (substitution) => {
  const owner = await enroll("owner_device"), session = await hub.auth.authorize(owner.token);
  const { proof } = await signedDeviceAction(hub.url, owner.token, owner.keys.privateKey, { operation: "network", target: networkTarget });
  if (substitution === "operation") {
    await expect(hub.auth.revoke("owner_device", session.userId, session, proof)).rejects.toThrow("device_action_invalid");
  } else {
    let actualSession = session;
    if (substitution === "session") actualSession = await hub.auth.authorize((await enroll("another_owner")).token);
    if (substitution === "same-device-new-session") {
      const nonce = randomBytes(32).toString("base64url"), challenge = await hub.auth.challenge("renewed-network", "owner_device", nonce, "local");
      const renewed = await hub.auth.authenticate("renewed-network", sign(null, deviceProof("owner_device", challenge.nonce, nonce), owner.keys.privateKey).toString("base64"));
      actualSession = await hub.auth.authorize(renewed.token);
    }
    await expect(commitNetworkAction(actualSession, substitution === "body-hash" ? hashSecret("different-network-body") : networkTarget, proof)).rejects.toThrow("device_action_invalid");
  }
  expect(await networkWritten()).toBeUndefined();
  await expect(commitNetworkAction(session, networkTarget, proof)).rejects.toThrow("device_action_expired");
});

it.each(["expiry", "revocation", "owner-role"])("rechecks network %s before changing membership", async (condition) => {
  const owner = await enroll("owner_device"), session = await hub.auth.authorize(owner.token);
  const { statement, proof } = await signedDeviceAction(hub.url, owner.token, owner.keys.privateKey, { operation: "network", target: networkTarget });
  if (condition === "expiry") vi.setSystemTime(statement.expiresAt + 1);
  if (condition === "revocation") await hub.auth.revoke("owner_device", "local-owner");
  if (condition === "owner-role") await hub.store.db.serial(() => hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'"));
  await expect(commitNetworkAction(session, networkTarget, proof)).rejects.toThrow();
  expect(await networkWritten()).toBeUndefined();
});

it("rechecks a queued network request after a device is revoked in flight", async () => {
  const owner = await enroll("owner_device"), session = await hub.auth.authorize(owner.token);
  const { proof } = await signedDeviceAction(hub.url, owner.token, owner.keys.privateKey, { operation: "network", target: networkTarget });
  let release!: () => void;
  const held = hub.store.db.serial(() => new Promise<void>(resolve => { release = resolve; }));
  // Enter the queue before scheduling revocation and the in-flight mutation.
  await vi.waitFor(() => expect(release).toBeDefined());
  const revoking = hub.auth.revoke("owner_device", "local-owner");
  const writing = commitNetworkAction(session, networkTarget, proof);
  const rejected = expect(writing).rejects.toThrow("device_revoked");
  release(); await held; await revoking; await rejected;
  expect(await networkWritten()).toBeUndefined();
});
