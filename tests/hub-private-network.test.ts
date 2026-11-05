import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HubStore } from "../src/hub/store.js";
import { HubAuth, deviceProof, hashSecret, type AuthSession } from "../src/hub/auth.js";
import { HostProfile } from "../src/hub/host-profile.js";
import { desktopControllerMarkerKey } from "../src/hub/local-controller.js";
import { markDeviceNameAlias } from "../src/hub/network-device-name.js";
import { PrivateNetwork, mergeNetworkManifests, networkId, networkMemberId } from "../src/hub/private-network.js";
import { deviceActionProofText } from "../src/client-protocol/device-actions.js";
import { networkCanonical, networkCommandSchema, type NetworkManifest, type SignedNetworkPeerRequest, type NetworkCommandInput, type NetworkCommandResult, type SignedNetworkManifest } from "../src/client-protocol/private-network.js";

type TestDevice = { id: string; publicKey: string; privateKey: KeyObject; token: string; session: AuthSession };
type TestHost = { directory: string; store: HubStore; auth: HubAuth; profile: HostProfile; network: PrivateNetwork; owner: TestDevice };
let now: number, reachable: boolean;
let interceptExchange: ((request: SignedNetworkPeerRequest, next: () => Promise<SignedNetworkManifest>) => Promise<SignedNetworkManifest>) | undefined;
const hosts: TestHost[] = [];
beforeEach(() => { now = Date.now(); reachable = true; interceptExchange = undefined; });
afterEach(async () => {
  for (const host of hosts) host.network.close();
  for (const host of hosts.splice(0)) { await host.store.db.close(); await rm(host.directory, { recursive: true, force: true }); }
});
async function login(host: Pick<TestHost, "auth">, id: string, privateKey: KeyObject): Promise<{ token: string; session: AuthSession }> {
  const clientNonce = randomBytes(32).toString("base64url"), connection = randomBytes(16).toString("hex");
  const challenge = await host.auth.challenge(connection, id, clientNonce, "127.0.0.1");
  const { token } = await host.auth.authenticate(connection, sign(null, deviceProof(id, challenge.nonce, clientNonce), privateKey).toString("base64"));
  return { token, session: await host.auth.authorize(token) };
}
async function device(host: Pick<TestHost, "auth">, id: string, userId = "owner"): Promise<TestDevice> {
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const pair = await host.auth.pair({ deviceId: id, name: id, publicKey, platform: "web" }, "127.0.0.1");
  await host.auth.approve(pair.code, "local-owner", userId);
  return { id, publicKey, privateKey: keys.privateKey, ...await login(host, id, keys.privateKey) };
}
async function host(name: string, clockOffset = 0): Promise<TestHost> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "private-network-")), store = await HubStore.open(directory);
  const auth = await HubAuth.open(store, directory, () => now + clockOffset), profile = new HostProfile(store.db, name);
  const network = new PrivateNetwork(store, auth, profile, { now: () => now + clockOffset, exchange: async (authority, request) => {
    if (!reachable) throw new Error("authority_offline");
    const target = hosts.find(item => item.auth.publicKey === authority.publicKey);
    if (!target) throw new Error("authority_missing");
    const next = () => target.network.peer(request, "fixture-peer");
    return interceptExchange ? interceptExchange(request, next) : next();
  } });
  const result = { directory, store, auth, profile, network, owner: await device({ auth }, `${name}_owner`) };
  await auth.markLocalDesktopController({ deviceId: result.owner.id, publicKey: result.owner.publicKey, name: name, platform: "web" });
  hosts.push(result); return result;
}
async function mutation(host: TestHost, raw: NetworkCommandInput, actor = host.owner): Promise<NetworkCommandResult> {
  const view = await host.network.view();
  if (raw.operation === "leave") raw = { expectedState: view.membership ? view.host.state : "standalone", ...raw };
  if (raw.operation === "remove") raw = { expectedState: view.membership!.manifest.hosts.find(host => host.publicKey === raw.publicKey)!.state, ...raw };
  const contextual = ["routes", "attest", "remove", "leave"].includes(raw.operation) ? { networkId: (await host.network.view()).membership?.manifest.id ?? "", ...raw } : raw;
  const command = networkCommandSchema.parse(contextual), target = hashSecret(networkCanonical(command));
  const statement = await host.auth.prepareDeviceAction({ operation: "network", target }, actor.token, actor.session);
  return host.network.command(command, actor.session, { nonce: statement.nonce, signature: sign(null, Buffer.from(deviceActionProofText(statement)), actor.privateKey).toString("base64") });
}
async function create(host: TestHost) { return (await mutation(host, { operation: "create", name: "我的网络" })).membership!; }
async function join(root: TestHost, peer: TestHost) {
  const { manifest } = (await root.network.view()).membership!;
  const { proposal } = await mutation(peer, { operation: "propose", networkId: manifest.id, authorityKey: root.auth.publicKey, seenManifestHash: hashSecret(networkCanonical(manifest)) });
  const { membership } = await mutation(root, { operation: "admit", proposal: proposal! });
  return mutation(peer, { operation: "join", membership: membership!, nonce: proposal!.proposal.nonce });
}

async function nativeName(h: TestHost, name: string) {
  await h.store.db.run("UPDATE devices SET platform='macos' WHERE id=?", [h.owner.id]);
  await h.store.db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [desktopControllerMarkerKey(h.owner.id), JSON.stringify({ id: h.owner.id, publicKey: h.owner.publicKey, nameSource: "host" })]);
  await h.profile.update({ name, revision: (await h.profile.read()).revision });
}

it("uses the proven origin device name for a remote desktop and follows subsequent renames", async () => {
  const mac = await host("example-mac"), asus = await host("example-windows"); await nativeName(mac, "example-mac");
  await create(mac); await join(mac, asus);
  const remote = { ...freshEnrollment(asus, "mac_on_asus").device, name: "这台电脑", platform: "macos" as const };
  await asus.network.enroll((await mutation(mac, { operation: "attest", device: remote })).membership);
  expect((await asus.store.device(remote.id))?.name).toBe("example-mac");
  expect((await asus.store.devices("owner")).find(d => d.id === remote.id)?.nameSource).toBeUndefined();
  await nativeName(mac, "工作 Mac"); await mac.network.tick(); await asus.network.tick();
  expect((await asus.store.device(remote.id))?.name).toBe("工作 Mac");
  expect((await asus.store.device(remote.id))?.public_key).toBe(remote.publicKey);
});

it("repairs a legacy relative name but preserves a separately chosen device alias", async () => {
  const mac = await host("example-mac"), asus = await host("example-windows"); await nativeName(mac, "example-mac");
  await create(mac); await join(mac, asus);
  const remote = { ...freshEnrollment(asus, "old_mac").device, name: "这台电脑" };
  await asus.network.enroll((await mutation(mac, { operation: "attest", device: remote })).membership);
  await asus.store.db.run("UPDATE devices SET name='这台电脑' WHERE id=?", [remote.id]);
  // Simulate a record imported by an older host, before naming provenance existed.
  await asus.store.db.run("DELETE FROM meta WHERE key LIKE 'network-device-name:v1:%'");
  await asus.network.tick();
  expect((await asus.store.device(remote.id))?.name).toBe("example-mac");
  await asus.store.db.run("UPDATE devices SET name='我的办公室设备' WHERE id=?", [remote.id]);
  await nativeName(mac, "Mac renamed"); await mac.network.tick(); await asus.network.tick();
  expect((await asus.store.device(remote.id))?.name).toBe("我的办公室设备");
});

it("does not roll a peer device name back when a third host carries an older signed directory", async () => {
  const a = await host("authority"), b = await host("example-mac"), c = await host("example-windows"); await nativeName(b, "aaa old Mac");
  await create(a); await join(a, b); await join(a, c); await b.network.tick();
  const remote = { ...freshEnrollment(c, "mac_on_c").device, name: "这台电脑" };
  await c.network.enroll((await mutation(b, { operation: "attest", device: remote })).membership);
  const old = (await a.network.view()).membership!;
  await nativeName(b, "zzz new Mac"); await b.network.tick(); await c.network.tick();
  await a.network.enroll(old); await c.network.tick();
  expect((await c.store.device(remote.id))?.name).toBe("zzz new Mac");
  expect((await a.network.view()).membership!.manifest.devices.find(d => d.host === b.auth.publicKey && d.id === b.owner.id)?.name).toBe("zzz new Mac");
});

it("preserves an explicit same-value alias and keeps a phone independent of its origin host name", async () => {
  const a = await host("example-mac"), b = await host("example-windows"), phone = await device(a, "phone");
  await a.store.db.run("UPDATE devices SET name='我的 Pixel',platform='android' WHERE id=?", [phone.id]);
  await create(a); await join(a, b);
  const remote = { ...freshEnrollment(b, "phone_on_b").device, name: "这台手机", platform: "android" as const };
  await b.network.enroll((await mutation(a, { operation: "attest", device: remote }, phone)).membership);
  expect((await b.store.device(remote.id))?.name).toBe("我的 Pixel");
  const row = (await b.store.device(remote.id))!;
  await b.store.db.transaction(() => markDeviceNameAlias(b.store.db, row));
  await a.store.db.run("UPDATE devices SET name='Pixel renamed' WHERE id=?", [phone.id]);
  await a.network.tick(); await b.network.tick();
  expect((await b.store.device(remote.id))?.name).toBe("我的 Pixel");
  expect((await b.network.view()).membership!.manifest.devices.find(d => d.id === remote.id && d.host === b.auth.publicKey)?.name).toBe("Pixel renamed");
});

it("follows the origin across a relay, survives a naming-marker reload, and never renames a revoked row", async () => {
  const a = await host("example-mac"), b = await host("relay"), c = await host("example-windows"); await nativeName(a, "example-mac");
  await create(a); await join(a, b); await join(a, c); await b.network.tick();
  const rb = freshEnrollment(b, "mac_b");
  await b.network.enroll((await mutation(a, { operation: "attest", device: { ...rb.device, name: "这台电脑" } })).membership);
  const actor = { id: rb.device.id, publicKey: rb.device.publicKey, privateKey: rb.keys.privateKey, ...await login(b, rb.device.id, rb.keys.privateKey) };
  const rc = freshEnrollment(c, "mac_c");
  await c.network.enroll((await mutation(b, { operation: "attest", device: { ...rc.device, name: "This computer" } }, actor)).membership);
  expect((await c.store.device(rc.device.id))?.name).toBe("example-mac");
  // Recreate the network service from durable state, without any in-memory naming cache.
  c.network.close(); c.network = new PrivateNetwork(c.store, c.auth, c.profile, { now: () => now, exchange: (_host, request) => a.network.peer(request, "fixture") });
  await nativeName(a, "Mac Studio"); await a.network.tick(); await c.network.tick();
  expect((await c.store.device(rc.device.id))?.name).toBe("Mac Studio");
  await c.auth.revoke(rc.device.id, "local-owner");
  await nativeName(a, "Must not revive"); await a.network.tick(); await c.network.tick();
  expect(await c.store.device(rc.device.id)).toMatchObject({ revoked: 1, name: "Mac Studio", public_key: rc.device.publicKey });
});

it("gives a proven native host-name binding priority over imported naming provenance", async () => {
  const a = await host("example-mac"), b = await host("example-windows"); await nativeName(a, "example-mac");
  await create(a); await join(a, b);
  const remote = freshEnrollment(b, "native_import");
  await b.network.enroll((await mutation(a, { operation: "attest", device: remote.device })).membership);
  await b.store.db.run("INSERT INTO meta(key,value) VALUES(?,?)", [desktopControllerMarkerKey(remote.device.id), JSON.stringify({ id: remote.device.id, publicKey: remote.device.publicKey, nameSource: "host" })]);
  // Equal host names must not accidentally let the remote source take over.
  await b.profile.update({ name: "example-mac", revision: (await b.profile.read()).revision });
  await nativeName(a, "Remote changed"); await a.network.tick(); await b.network.tick();
  expect((await b.store.device(remote.device.id))?.name).toBe("example-mac");
});

it("derives names from an old authority directory without overwriting unproven historical aliases", async () => {
  const a = await host("example-mac"), b = await host("example-windows"); await nativeName(a, "example-mac");
  await create(a); await join(a, b);
  const remote = freshEnrollment(b, "legacy_target");
  await b.network.enroll((await mutation(a, { operation: "attest", device: remote.device })).membership);
  const legacy = structuredClone((await a.network.view()).membership!.manifest);
  legacy.revision += 1;
  legacy.devices.find(d => d.host === a.auth.publicKey && d.id === a.owner.id)!.name = "Mac from old authority";
  legacy.devices.find(d => d.host === b.auth.publicKey && d.id === remote.device.id)!.name = "This computer";
  await b.store.db.run("DELETE FROM meta WHERE key LIKE 'network-device-name:v1:%'");
  await b.store.db.run("UPDATE devices SET name='This computer' WHERE id=?", [remote.device.id]);
  await b.network.enroll({ manifest: legacy, signature: a.auth.signNetworkManifest(legacy) });
  expect((await b.store.device(remote.device.id))?.name).toBe("Mac from old authority");
  expect((await b.network.view()).membership!.manifest.devices.find(d => d.id === remote.device.id && d.host === b.auth.publicKey)?.name).toBe("This computer");
  await b.store.db.run("DELETE FROM meta WHERE key LIKE 'network-device-name:v1:%'");
  await b.store.db.run("UPDATE devices SET name='Old MacBook Pro' WHERE id=?", [remote.device.id]);
  legacy.revision += 1; legacy.devices.find(d => d.host === a.auth.publicKey && d.id === a.owner.id)!.name = "New canonical name";
  await b.network.enroll({ manifest: legacy, signature: a.auth.signNetworkManifest(legacy) });
  expect((await b.store.device(remote.device.id))?.name).toBe("Old MacBook Pro");
});

it("joins three independent Hubs, imports per-host phone keys, and keeps direct control while authority is offline", async () => {
  const a = await host("a"), b = await host("b"), c = await host("c"), phone = await device(a, "phone_a");
  await create(a); await create(b); await join(a, b); await join(a, c); await b.network.tick();
  const members = (await b.network.view()).membership!.manifest;
  expect(members.hosts.filter(value => !value.revoked)).toHaveLength(3);
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const attested = await mutation(a, { operation: "attest", device: { id: "phone_b", host: b.auth.publicKey, name: "phone", platform: "android", publicKey } }, phone);
  await b.network.enroll(attested.membership);
  const active = await login(b, "phone_b", keys.privateKey);
  expect((await b.store.device("phone_b"))?.user_id).toBe("owner");
  reachable = false; await b.network.tick();
  expect((await b.network.view()).sync).toBe("waiting");
  expect(await b.auth.authorize(active.token)).toBe(active.session);
  expect((await a.store.device("phone_a"))?.public_key).toBe(phone.publicKey);
  expect((await b.store.device("phone_b"))?.public_key).not.toBe(phone.publicKey);
});

it("requires fresh owner proof and does not install a stranger's signed network before joining", async () => {
  const a = await host("a"), b = await host("b"); const signed = await create(a);
  await expect(b.network.enroll(signed)).rejects.toThrow("network_identity_mismatch");
  await expect(b.network.command({ operation: "create", name: "Unauthorized" }, b.owner.session)).rejects.toThrow("device_action_proof_required");
  await b.store.db.run("INSERT INTO users VALUES('guest','Guest','member')"); const guest = await device(b, "guest", "guest");
  await expect(mutation(b, { operation: "create", name: "Unauthorized" }, guest)).rejects.toThrow("owner_required");
  expect((await b.network.view()).sync).toBe("standalone");
});

it("rejects expired or replaced join proposals without turning a cancelled host into an active member", async () => {
  const a = await host("a"), b = await host("b"), membership = await create(a);
  const destination = { operation: "propose" as const, networkId: membership.manifest.id, authorityKey: a.auth.publicKey, seenManifestHash: hashSecret(networkCanonical(membership.manifest)) };
  const first = (await mutation(b, destination)).proposal!;
  const admitted = (await mutation(a, { operation: "admit", proposal: first })).membership!;
  const second = (await mutation(b, destination)).proposal!;
  await expect(mutation(b, { operation: "join", membership: admitted, nonce: first.proposal.nonce })).rejects.toThrow("network_proposal_mismatch");
  expect((await b.network.view()).membership).toBeUndefined();
  now = second.proposal.expiresAt + 1;
  // Expiry also expires the original short-lived action sessions, so refresh it.
  Object.assign(b.owner, await login(b, b.owner.id, b.owner.privateKey));
  await expect(mutation(b, { operation: "join", membership: admitted, nonce: second.proposal.nonce })).rejects.toThrow("network_request_expired");
});

it("propagates revocation across a member's host-specific keys and closes active authentication", async () => {
  const a = await host("a"), b = await host("b"), phone = await device(a, "phone_a"); await create(a); await join(a, b);
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  await b.network.enroll((await mutation(a, { operation: "attest", device: { id: "phone_b", host: b.auth.publicKey, name: "phone", platform: "android", publicKey } }, phone)).membership);
  const active = await login(b, "phone_b", keys.privateKey), revoked: string[] = [];
  b.auth.onRevoke(id => revoked.push(id));
  await b.auth.revoke("phone_b", "local-owner"); await b.network.tick(); await a.network.tick();
  expect((await a.store.device("phone_a"))?.revoked).toBe(1);
  expect((await b.store.device("phone_b"))?.revoked).toBe(1);
  await expect(b.auth.authorize(active.token)).rejects.toThrow();
  expect(revoked).toContain("phone_b");
  expect((await a.store.device(a.owner.id))?.revoked).toBe(0);
});

it("never replaces a local device row to satisfy enrollment and rolls back the full import", async () => {
  const a = await host("a"), b = await host("b"); await create(a); await join(a, b);
  const local = await device(b, "collision");
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const result = await mutation(a, { operation: "attest", device: { id: local.id, host: b.auth.publicKey, name: "conflict", platform: "web", publicKey } });
  await expect(b.network.enroll(result.membership)).rejects.toThrow("network_device_conflict");
  expect((await b.store.device(local.id))?.public_key).toBe(local.publicKey);
  expect((await b.store.device(local.id))?.revoked).toBe(0);
});

it("leaving retains local Bot and device data, revokes imported access, and rejects late enrollment", async () => {
  const a = await host("a"), b = await host("b"); await create(a); await join(a, b);
  await b.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('retained','My Bot','fixture')");
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const latest = (await mutation(a, { operation: "attest", device: { id: "remote_b", host: b.auth.publicKey, name: "remote", platform: "web", publicKey } })).membership!;
  await b.network.enroll(latest);
  await mutation(b, { operation: "leave" });
  expect((await b.store.device("remote_b"))?.revoked).toBe(1);
  expect((await b.store.device(b.owner.id))?.revoked).toBe(0);
  expect(await b.store.db.get("SELECT name FROM bots WHERE id='retained'")).toEqual({ name: "My Bot" });
  await expect(b.network.enroll(latest)).rejects.toThrow("network_identity_mismatch");
  expect((await b.network.view()).sync).toBe("standalone");
});

function freshEnrollment(target: TestHost, id: string) {
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { keys, device: { id, publicKey, host: target.auth.publicKey, name: id, platform: "web" as const } };
}
async function prepareJoin(root: TestHost, peer: TestHost) {
  const { manifest } = (await root.network.view()).membership!;
  const proposal = (await mutation(peer, { operation: "propose", networkId: manifest.id, authorityKey: root.auth.publicKey, seenManifestHash: hashSecret(networkCanonical(manifest)) })).proposal!;
  const membership = (await mutation(root, { operation: "admit", proposal })).membership!;
  return { proposal, membership };
}
async function peerRequest(peer: TestHost, extra: Partial<SignedNetworkPeerRequest["request"]> = {}): Promise<SignedNetworkPeerRequest> {
  const view = await peer.network.view(), request: SignedNetworkPeerRequest["request"] = {
    v: 1, networkId: (extra.known ?? view.membership)!.manifest.id, publicKey: peer.auth.publicKey,
    nonce: randomBytes(32).toString("base64url"), expiresAt: now + 30_000,
    host: { publicKey: peer.auth.publicKey, name: view.host.name, routes: view.host.routes, protocol: 2 },
    devices: [], revoked: [], ...(view.membership ? { known: view.membership } : {}), ...extra,
  };
  return { request, signature: peer.auth.signNetworkPeer(request) };
}
function rootSign(root: TestHost, manifest: NetworkManifest): SignedNetworkManifest { return { manifest, signature: root.auth.signNetworkManifest(manifest) }; }

it("binds forwarded attestations to device proof while preserving network phones after a forwarding host is removed", async () => {
  const a = await host("a"), b = await host("b"), c = await host("c"), phone = await device(a, "phone_a");
  await create(a); await join(a, b); await join(a, c); await b.network.tick();
  const bPhone = freshEnrollment(b, "phone_b");
  await b.network.enroll((await mutation(a, { operation: "attest", device: bPhone.device }, phone)).membership);
  const actor: TestDevice = { id: bPhone.device.id, publicKey: bPhone.device.publicKey, privateKey: bPhone.keys.privateKey, ...await login(b, bPhone.device.id, bPhone.keys.privateKey) };
  const cPhone = freshEnrollment(c, "phone_c");
  const added = await mutation(b, { operation: "attest", device: cPhone.device }, actor);
  expect(added.membership!.manifest.devices.find(d => d.id === cPhone.device.id)).toMatchObject({ originHost: a.auth.publicKey, attestedBy: b.auth.publicKey, memberId: networkMemberId(a.auth.publicKey, phone.id) });
  await c.network.enroll(added.membership); const active = await login(c, cPhone.device.id, cPhone.keys.privateKey);
  const removed = await mutation(a, { operation: "remove", publicKey: b.auth.publicKey });
  await c.network.enroll(removed.membership); await b.network.enroll(removed.membership);
  expect(await c.auth.authorize(active.token)).toEqual(active.session);
  expect((await a.store.device(phone.id))?.revoked).toBe(0);
  expect((await b.store.device(b.owner.id))?.revoked).toBe(0);
  expect((await b.store.device(bPhone.device.id))?.revoked).toBe(1);
  expect((await b.network.view()).sync).toBe("removed");
});

it("does not turn target-key rotation into global member revocation", async () => {
  const a = await host("a"), b = await host("b"); await create(a); await join(a, b);
  const first = freshEnrollment(b, "first"), second = freshEnrollment(b, "second");
  await b.network.enroll((await mutation(a, { operation: "attest", device: first.device })).membership);
  await b.network.enroll((await mutation(a, { operation: "attest", device: second.device })).membership);
  await b.network.tick(); await a.network.tick();
  expect((await b.store.device("first"))?.revoked).toBe(1);
  expect((await b.store.device("second"))?.revoked).toBe(0);
  expect((await a.store.device(a.owner.id))?.revoked).toBe(0);
});

it("rejects forged forwarded device consent and fresh peer replay of an already consumed proof", async () => {
  const a = await host("a"), b = await host("b"), c = await host("c"); await create(a); await join(a, b); await join(a, c); await b.network.tick();
  const target = freshEnrollment(c, "from_b").device;
  const command = { operation: "attest", networkId: (await b.network.view()).membership!.manifest.id, device: target };
  const statement = await b.auth.prepareDeviceAction({ operation: "network", target: hashSecret(networkCanonical(command)) }, b.owner.token, b.owner.session);
  const proof = { nonce: statement.nonce, signature: sign(null, Buffer.from(deviceActionProofText(statement)), b.owner.privateKey).toString("base64") };
  const attest = { sourceDeviceId: b.owner.id, device: target, statement, proof };
  const wrong = await peerRequest(b, { attest: { ...attest, device: { ...target, id: "substituted" } } });
  await expect(a.network.peer(wrong, "fixture")).rejects.toThrow("network_source_proof_invalid");
  const request = await peerRequest(b, { attest });
  const response = await a.network.peer(request, "fixture");
  expect(await a.network.peer(request, "fixture")).toEqual(response);
  await expect(a.network.peer(await peerRequest(b, { attest }), "fixture")).rejects.toThrow("network_request_replayed");
});

it("keeps device IDs host-scoped, rejects shared keys and rejects peer-supplied membership metadata", async () => {
  const a = await host("a"), b = await host("b"), aSame = await device(a, "same"), bSame = await device(b, "same");
  await create(a); await join(a, b);
  expect((await a.network.view()).membership!.manifest.devices.filter(d => d.id === "same")).toHaveLength(2);
  expect(aSame.publicKey).not.toBe(bSame.publicKey);
  await expect(mutation(a, { operation: "attest", device: { id: "duplicate", publicKey: aSame.publicKey, host: b.auth.publicKey, name: "bad", platform: "web" } })).rejects.toThrow("network_device_key_reused");
  const signed = await peerRequest(b, { devices: [{ id: bSame.id, publicKey: bSame.publicKey, host: b.auth.publicKey, name: "same", platform: "web" }] });
  await expect(a.network.peer({ ...signed, request: { ...signed.request, devices: [{ ...signed.request.devices[0], memberId: networkMemberId(a.auth.publicKey, a.owner.id) }] } }, "fixture")).rejects.toThrow();
  expect((await a.network.view()).membership!.manifest.devices.find(d => d.host === b.auth.publicKey && d.id === "same")?.memberId).toBe(networkMemberId(b.auth.publicKey, "same"));
});

it("requires reviewed directory consent and does not trust pending hosts until they commit", async () => {
  const a = await host("a"), b = await host("b"), initial = await create(a);
  const proposal = (await mutation(b, { operation: "propose", networkId: initial.manifest.id, authorityKey: a.auth.publicKey, seenManifestHash: hashSecret(networkCanonical(initial.manifest)) })).proposal!;
  await device(a, "new_phone"); await a.network.tick();
  await expect(mutation(a, { operation: "admit", proposal })).rejects.toThrow("network_review_changed");
  const prepared = await prepareJoin(a, b);
  const pending = prepared.membership.manifest.hosts.find(h => h.publicKey === b.auth.publicKey)!;
  expect(pending.state).toBe("pending");
  expect(prepared.membership.manifest.devices.some(d => d.host === b.auth.publicKey)).toBe(false);
  await expect(a.network.peer(await peerRequest(b, { known: prepared.membership, networkId: prepared.membership.manifest.id }), "fixture")).rejects.toThrow("network_commit_invalid");
});

it("cancels a saved pending join only at the authority and lets a fresh nonce retry", async () => {
  const a = await host("a"), b = await host("b"); await create(a); const prepared = await prepareJoin(a, b);
  reachable = false;
  await expect(mutation(b, { operation: "join", membership: prepared.membership, nonce: prepared.proposal.proposal.nonce })).rejects.toThrow("authority_offline");
  await expect(mutation(b, { operation: "leave", expectedState: "pending" })).rejects.toThrow("authority_offline");
  expect((await b.network.view()).host.state).toBe("pending");
  reachable = true; await mutation(b, { operation: "leave", expectedState: "pending" });
  expect((await b.network.view()).membership).toBeUndefined();
  const rootPending = (await a.network.view()).membership!.manifest.hosts.find(h => h.publicKey === b.auth.publicKey)!;
  expect(rootPending.revoked).toBe(false); expect(rootPending.expiresAt).toBeLessThanOrEqual(now);
  await join(a, b); expect((await b.network.view()).host.state).toBe("active");
  await expect(mutation(b, { operation: "leave", expectedState: "pending" })).rejects.toThrow("network_host_state_changed");
});

it("recovers a committed join after its response was lost instead of incorrectly clearing local state", async () => {
  const a = await host("a"), b = await host("b"); await create(a); const prepared = await prepareJoin(a, b);
  interceptExchange = async (_request, next) => { await next(); throw new Error("response_lost"); };
  await expect(mutation(b, { operation: "join", membership: prepared.membership, nonce: prepared.proposal.proposal.nonce })).rejects.toThrow("response_lost");
  interceptExchange = undefined;
  expect((await b.network.view()).host.state).toBe("pending");
  await expect(mutation(b, { operation: "leave", expectedState: "pending" })).rejects.toThrow("network_host_state_changed");
  await b.network.tick(); expect((await b.network.view()).host.state).toBe("active");
});

it("commits the approved descriptor after a failed join even if local name and routes change", async () => {
  const a = await host("a"), b = await host("b"); await create(a); const prepared = await prepareJoin(a, b);
  reachable = false;
  await expect(mutation(b, { operation: "join", membership: prepared.membership, nonce: prepared.proposal.proposal.nonce })).rejects.toThrow("authority_offline");
  await mutation(b, { operation: "routes", routes: [{ name: "Direct", url: "https://new-peer.example" }] });
  await b.profile.update({ ...(await b.profile.read()), name: "Renamed peer" });
  reachable = true;
  await b.network.tick();
  expect((await b.network.view()).host.state).toBe("active");
  expect((await a.network.view()).membership!.manifest.hosts.find(h => h.publicKey === b.auth.publicKey)?.name).toBe("b");
  await b.network.tick();
  expect((await a.network.view()).membership!.manifest.hosts.find(h => h.publicKey === b.auth.publicKey)).toMatchObject({ name: "Renamed peer", routes: [{ name: "Direct", url: "https://new-peer.example" }] });
});

it("does not let a background sync overtake the user's join receipt", async () => {
  const a = await host("a"), b = await host("b"); await create(a); const prepared = await prepareJoin(a, b);
  let first = true;
  interceptExchange = async (_request, next) => {
    const receipt = await next();
    if (first) {
      first = false;
      await device(a, "new_during_join"); await a.network.tick();
      await b.network.tick();
    }
    return receipt;
  };
  const result = await mutation(b, { operation: "join", membership: prepared.membership, nonce: prepared.proposal.proposal.nonce });
  expect(result.view.host.state).toBe("active");
  await b.network.tick();
  expect((await b.network.view()).membership!.manifest.devices.some(d => d.id === "new_during_join")).toBe(true);
});

it("returns a phone's successful departure before a background sync revokes its old local grant", async () => {
  const a = await host("a"), b = await host("b"), phone = await device(b, "departing_phone");
  await create(a); await join(a, b);
  const phoneA = freshEnrollment(a, "departing_phone_a");
  await a.network.enroll((await mutation(b, { operation: "attest", device: phoneA.device }, phone)).membership);
  interceptExchange = async (request, next) => {
    const receipt = await next();
    if (request.request.retire) await b.network.tick();
    return receipt;
  };
  const result = await mutation(b, { operation: "leave" }, phone);
  expect(result.view.sync).toBe("standalone");
  await expect(b.auth.authorize(phone.token)).rejects.toThrow();
  expect(await b.auth.authorize(b.owner.token)).toEqual(b.owner.session);
  expect(result.membership!.manifest.devices.find(d => d.id === phoneA.device.id)?.revoked).toBe(false);
});

it("waits for an existing sync before starting a network command and still rechecks its device", async () => {
  const a = await host("a"), b = await host("b"); await create(a); await join(a, b);
  let started!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
  let exchanges = 0;
  interceptExchange = async (_request, next) => { exchanges++; started(); await barrier; return next(); };
  const syncing = b.network.tick(); await began;
  const view = await b.network.view();
  const command = networkCommandSchema.parse({ operation: "leave", networkId: view.membership!.manifest.id, expectedState: "active" });
  const statement = await b.auth.prepareDeviceAction({ operation: "network", target: hashSecret(networkCanonical(command)) }, b.owner.token, b.owner.session);
  const leaving = b.network.command(command, b.owner.session, { nonce: statement.nonce, signature: sign(null, Buffer.from(deviceActionProofText(statement)), b.owner.privateKey).toString("base64") });
  const rejected = expect(leaving).rejects.toThrow("device_revoked");
  // The sync's network I/O and the queued command do not hold the DB lock.
  await b.auth.revoke(b.owner.id, "local-owner");
  release(); await syncing; await rejected;
  expect(exchanges).toBe(1);
  expect((await b.network.view()).host.state).toBe("active");
});

it("refuses an expired commit but permits an expired pending slot to be proposed again", async () => {
  const a = await host("a"), b = await host("b"); await create(a); const prepared = await prepareJoin(a, b);
  now = prepared.proposal.proposal.expiresAt + 1;
  Object.assign(a.owner, await login(a, a.owner.id, a.owner.privateKey)); Object.assign(b.owner, await login(b, b.owner.id, b.owner.privateKey));
  const request = await peerRequest(b, { known: prepared.membership, networkId: prepared.membership.manifest.id, commit: prepared.proposal.proposal.nonce });
  await expect(a.network.peer(request, "fixture")).rejects.toThrow("network_commit_invalid");
  await join(a, b); expect((await b.network.view()).host.state).toBe("active");
});

it("binds network IDs to genesis and rejects signed but normalized names", async () => {
  const a = await host("a"), b = await host("b"); const membership = await create(a); await join(a, b);
  const impostor = { ...membership.manifest, authorityKey: b.auth.publicKey, hosts: [{ ...(await b.network.view()).host, state: "active" as const }], devices: [] };
  const signed = rootSign(b, impostor);
  await expect(b.network.enroll(signed)).rejects.toThrow("network_identity_mismatch");
  expect(networkId(b.auth.publicKey, membership.manifest.genesisNonce)).not.toBe(membership.manifest.id);
  const current = (await a.network.view()).membership!;
  const normalized = { ...current, manifest: { ...current.manifest, name: ` ${current.manifest.name}` } };
  await expect(b.network.enroll(normalized)).rejects.toThrow("network_noncanonical");
  await expect(b.network.enroll({ ...current, manifest: { ...current.manifest, name: "bad\u202e" } })).rejects.toThrow();
});

it("merges signed backup forks without losing additions or revocations, blocking conflicting slots", async () => {
  const a = await host("a"), b = await host("b"), c = await host("c"); await create(a); await join(a, b); await join(a, c);
  const base = (await a.network.view()).membership!.manifest;
  const left = structuredClone(base), right = structuredClone(base), third = structuredClone(base);
  const binding = freshEnrollment(b, "fork_slot").device, other = freshEnrollment(b, "fork_slot").device;
  left.devices.push({ ...binding, memberId: networkMemberId(a.auth.publicKey, a.owner.id), originHost: a.auth.publicKey, attestedBy: a.auth.publicKey, scope: "host", revoked: false });
  right.devices.push({ ...other, memberId: networkMemberId(a.auth.publicKey, a.owner.id), originHost: a.auth.publicKey, attestedBy: a.auth.publicKey, scope: "host", revoked: false });
  const added = freshEnrollment(c, "new_local_c").device;
  third.devices.push({ ...added, memberId: networkMemberId(c.auth.publicKey, added.id), originHost: c.auth.publicKey, attestedBy: c.auth.publicKey, revoked: false });
  const merged = mergeNetworkManifests(left, right);
  expect(merged.blockedBindings).toContainEqual({ host: b.auth.publicKey, id: "fork_slot" });
  expect(mergeNetworkManifests(left, right)).toEqual(mergeNetworkManifests(right, left));
  expect(mergeNetworkManifests(merged, merged)).toEqual(merged);
  expect(mergeNetworkManifests(mergeNetworkManifests(left, right), third)).toEqual(mergeNetworkManifests(left, mergeNetworkManifests(right, third)));
  await b.network.enroll(rootSign(a, left));
  await a.network.enroll(rootSign(a, left));
  await a.network.enroll(rootSign(a, { ...right, revision: (await a.network.view()).membership!.manifest.revision }));
  const recovered = await a.network.view();
  expect(recovered.membership!.manifest.blockedBindings).toContainEqual({ host: b.auth.publicKey, id: "fork_slot" });
  expect(recovered.membership!.manifest.revokedMembers).toContain(networkMemberId(a.auth.publicKey, a.owner.id));
  await b.network.enroll(recovered.membership);
  expect((await b.store.device("fork_slot"))?.public_key).toBe(binding.publicKey);
  expect((await b.store.device("fork_slot"))?.revoked).toBe(1);
});

it("rechecks owner authorization after network awaits without holding a database lock", async () => {
  const a = await host("a"), b = await host("b"), c = await host("c"); await create(a); await join(a, b); await join(a, c); await b.network.tick();
  let notifyStarted!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  interceptExchange = async (_request, next) => { notifyStarted(); await wait; return next(); };
  const pending = mutation(b, { operation: "attest", device: freshEnrollment(c, "late").device });
  await started;
  // This completes while the HTTP exchange is suspended, proving the DB queue is free.
  await b.auth.revoke(b.owner.id, "local-owner"); release();
  await expect(pending).rejects.toThrow("device_revoked");
  expect((await b.store.device(b.owner.id))?.revoked).toBe(1);
});

it("allows removed local owners to create a fresh network without carrying the old network's member tombstones", async () => {
  const a = await host("a"), b = await host("b"); await create(a); await join(a, b);
  const removed = (await mutation(a, { operation: "remove", publicKey: b.auth.publicKey })).membership!;
  await b.network.enroll(removed); await mutation(b, { operation: "leave" });
  await expect(mutation(b, { operation: "propose", networkId: removed.manifest.id, authorityKey: a.auth.publicKey, seenManifestHash: hashSecret(networkCanonical(removed.manifest)) })).rejects.toThrow("network_retired");
  const fresh = await create(b);
  expect(fresh.manifest.id).not.toBe(removed.manifest.id);
  expect(fresh.manifest.devices.find(d => d.id === b.owner.id)).toMatchObject({ revoked: false });
  expect(fresh.manifest.revokedMembers).toHaveLength(0);
});

it("does not resurrect a cancelled nonce when recovering the authority from an older pending snapshot", async () => {
  const a = await host("a"), b = await host("b"); await create(a); const prepared = await prepareJoin(a, b);
  reachable = false; await expect(mutation(b, { operation: "join", membership: prepared.membership, nonce: prepared.proposal.proposal.nonce })).rejects.toThrow();
  reachable = true; await mutation(b, { operation: "leave", expectedState: "pending" });
  const cancelled = (await a.network.view()).membership!.manifest;
  const merged = mergeNetworkManifests(cancelled, prepared.membership.manifest);
  expect(merged.hosts.find(h => h.publicKey === b.auth.publicKey)?.expiresAt).toBeLessThanOrEqual(now);
  expect(mergeNetworkManifests(prepared.membership.manifest, cancelled)).toEqual(merged);
  await expect(a.network.peer(await peerRequest(b, { known: prepared.membership, networkId: prepared.membership.manifest.id, commit: prepared.proposal.proposal.nonce }), "fixture")).rejects.toThrow("network_commit_invalid");
});

it("uses a root-signed higher backup to restore additions while keeping its locally known host removal", async () => {
  const a = await host("a"), b = await host("b"), c = await host("c"); await create(a); await join(a, b); await join(a, c);
  const before = (await a.network.view()).membership!.manifest;
  await mutation(a, { operation: "remove", publicKey: b.auth.publicKey });
  const backup = structuredClone(before), added = freshEnrollment(c, "backup_local").device;
  backup.revision += 20;
  backup.devices.push({ ...added, memberId: networkMemberId(c.auth.publicKey, added.id), originHost: c.auth.publicKey, attestedBy: c.auth.publicKey, revoked: false });
  const restoredHost = backup.hosts.find(host => host.publicKey === c.auth.publicKey)!;
  restoredHost.name = "z-newer-backup"; restoredHost.routes = [{ name: "Direct", url: "https://backup-peer.example.invalid:8443" }];
  await a.network.enroll(rootSign(a, backup));
  const recovered = await a.network.view();
  expect(recovered.membership!.manifest.hosts.find(h => h.publicKey === b.auth.publicKey)?.revoked).toBe(true);
  expect(recovered.membership!.manifest.devices.find(d => d.id === added.id)?.revoked).toBe(false);
  expect(recovered.membership!.manifest.revision).toBeGreaterThan(backup.revision);
  expect(recovered.membership!.manifest.hosts.find(host => host.publicKey === c.auth.publicKey)).toMatchObject({ name: restoredHost.name, routes: restoredHost.routes });
  const proposed = { v: 1 as const, host: { publicKey: b.auth.publicKey, name: "b", routes: [], protocol: 2 as const }, devices: [], networkId: before.id, authorityKey: a.auth.publicKey, seenManifestHash: hashSecret(networkCanonical(recovered.membership!.manifest)), nonce: randomBytes(32).toString("base64url"), expiresAt: now + 60_000 };
  await expect(mutation(a, { operation: "admit", proposal: { proposal: proposed, signature: b.auth.signNetworkProposal(proposed) } })).rejects.toThrow("network_host_removed");
});

it("merges duplicate-key forks associatively even if another branch already revoked one slot", async () => {
  const a = await host("a"), b = await host("b"); await create(a); await join(a, b);
  const base = (await a.network.view()).membership!.manifest, item = freshEnrollment(b, "duplicate_one").device;
  const origin = { memberId: networkMemberId(a.auth.publicKey, a.owner.id), originHost: a.auth.publicKey, attestedBy: a.auth.publicKey, scope: "host", revoked: false };
  const left = structuredClone(base), right = structuredClone(base), third = structuredClone(base);
  left.devices.push({ ...item, ...origin }); right.devices.push({ ...item, id: "duplicate_two", ...origin });
  third.devices.push({ ...item, ...origin, revoked: true });
  const merged = mergeNetworkManifests(mergeNetworkManifests(left, right), third);
  expect(merged).toEqual(mergeNetworkManifests(left, mergeNetworkManifests(right, third)));
  expect(merged.blockedBindings).toEqual(expect.arrayContaining([{ host: b.auth.publicKey, id: item.id }, { host: b.auth.publicKey, id: "duplicate_two" }]));
});

it("retains a discarded conflict key tombstone through every three-fork merge permutation", async () => {
  const a = await host("a"), b = await host("b"), c = await host("c"); await create(a); await join(a, b); await join(a, c);
  const base = (await a.network.view()).membership!.manifest, first = freshEnrollment(b, "occupied").device, second = freshEnrollment(b, "occupied").device;
  const [left, middle, right] = [structuredClone(base), structuredClone(base), structuredClone(base)];
  left.devices.push({ ...first, memberId: networkMemberId(b.auth.publicKey, first.id), originHost: b.auth.publicKey, attestedBy: b.auth.publicKey, revoked: false });
  middle.devices.push({ ...second, memberId: networkMemberId(b.auth.publicKey, second.id), originHost: b.auth.publicKey, attestedBy: b.auth.publicKey, revoked: false });
  right.devices.push({ ...second, host: c.auth.publicKey, id: "elsewhere", memberId: networkMemberId(c.auth.publicKey, "elsewhere"), originHost: c.auth.publicKey, attestedBy: c.auth.publicKey, revoked: false });
  const expected = mergeNetworkManifests(mergeNetworkManifests(left, middle), right);
  for (const [x, y, z] of [[left,middle,right],[left,right,middle],[middle,left,right],[middle,right,left],[right,left,middle],[right,middle,left]]) {
    expect(mergeNetworkManifests(mergeNetworkManifests(x, y), z)).toEqual(expected);
    expect(mergeNetworkManifests(x, mergeNetworkManifests(y, z))).toEqual(expected);
  }
  expect(expected.blockedKeys).toEqual(expect.arrayContaining([hashSecret(first.publicKey), hashSecret(second.publicKey)]));
  expect(expected.devices.find(device => device.id === "elsewhere")?.revoked).toBe(true);
  expect(mergeNetworkManifests(expected, expected)).toEqual(expected);
});

it("keeps cancelled and successor pending nonces through six merge permutations and clock skew", async () => {
  const a = await host("a"), b = await host("b"); await create(a); const prepared = await prepareJoin(a, b);
  const old = structuredClone(prepared.membership.manifest), cancelled = structuredClone(old), successor = structuredClone(old);
  const originalNonce = prepared.proposal.proposal.nonce, nextNonce = randomBytes(32).toString("base64url"), key = b.auth.publicKey;
  cancelled.cancelledProposals = [{ host: key, nonce: originalNonce }];
  cancelled.hosts.find(host => host.publicKey === key)!.expiresAt = 1;
  const nextHost = successor.hosts.find(host => host.publicKey === key)!;
  nextHost.proposalNonce = nextNonce; nextHost.expiresAt! -= 10_000;
  successor.pendingProposals = [{ host: key, nonce: nextNonce, expiresAt: nextHost.expiresAt! }];
  const expected = mergeNetworkManifests(mergeNetworkManifests(old, cancelled), successor);
  for (const [x,y,z] of [[old,cancelled,successor],[old,successor,cancelled],[cancelled,old,successor],[cancelled,successor,old],[successor,old,cancelled],[successor,cancelled,old]]) {
    expect(mergeNetworkManifests(mergeNetworkManifests(x,y),z)).toEqual(expected);
    expect(mergeNetworkManifests(x,mergeNetworkManifests(y,z))).toEqual(expected);
  }
  expect(mergeNetworkManifests(expected, expected)).toEqual(expected);
  expect(expected.hosts.find(host => host.publicKey === key)?.proposalNonce).toBe(nextNonce);
  expect(expected.pendingProposals).toHaveLength(2);
  expect(expected.cancelledProposals).toContainEqual({ host: key, nonce: originalNonce });
});

it("accepts a legacy signed pending snapshot without rewriting it before signature validation", async () => {
  const a = await host("a"), b = await host("b"); await create(a); const prepared = await prepareJoin(a, b);
  const legacy = structuredClone(prepared.membership.manifest);
  delete legacy.pendingProposals; delete legacy.cancelledProposals; delete legacy.blockedKeys;
  const signed = rootSign(a, legacy);
  await mutation(b, { operation: "join", membership: signed, nonce: prepared.proposal.proposal.nonce });
  expect((await b.network.view()).host.state).toBe("active");
  expect((await a.network.view()).membership!.manifest.pendingProposals).toContainEqual({ host: b.auth.publicKey, nonce: prepared.proposal.proposal.nonce, expiresAt: prepared.proposal.proposal.expiresAt });
  expect(signed.manifest.pendingProposals).toBeUndefined();
});

it("recovers lower-revision signed additions and revocations at the root while peers still reject downgrades", async () => {
  const a = await host("a"), b = await host("b"), c = await host("c"); await create(a); await join(a,b); await join(a,c);
  const older = structuredClone((await a.network.view()).membership!.manifest), addition = freshEnrollment(c, "older_fork").device;
  older.devices.push({ ...addition, memberId: networkMemberId(c.auth.publicKey, addition.id), originHost: c.auth.publicKey, attestedBy: c.auth.publicKey, revoked: false });
  older.hosts.find(host => host.publicKey === b.auth.publicKey)!.revoked = true;
  const removedMembers = older.devices.filter(device => device.originHost === b.auth.publicKey).map(device => device.memberId);
  older.revokedMembers.push(...new Set(removedMembers));
  for (const device of older.devices) if ([device.host, device.originHost, device.attestedBy].includes(b.auth.publicKey) || removedMembers.includes(device.memberId)) device.revoked = true;
  for (let i=0;i<3;i++) { const profile = await a.profile.read(); await a.profile.update({ name: `Renamed ${i}`, revision: profile.revision }); await a.network.tick(); }
  expect((await a.network.view()).membership!.manifest.revision).toBeGreaterThan(older.revision);
  await a.network.enroll(rootSign(a, older));
  const recovered = (await a.network.view()).membership!;
  expect(recovered.manifest.devices.some(device => device.id === addition.id)).toBe(true);
  expect(recovered.manifest.hosts.find(host => host.publicKey === b.auth.publicKey)?.revoked).toBe(true);
  await c.network.enroll(recovered);
  await expect(c.network.enroll(rootSign(a, older))).rejects.toThrow("network_manifest_stale");
});

it("requires online retirement before an active peer leaves and cleans introduced keys network-wide", async () => {
  const a = await host("a"), b = await host("b"), c = await host("c"); await create(a); await join(a,b); await join(a,c); await b.network.tick();
  const bOwnerC = freshEnrollment(c, "b_owner_c");
  await c.network.enroll((await mutation(b, { operation: "attest", device: bOwnerC.device })).membership);
  const remote = await login(c, bOwnerC.device.id, bOwnerC.keys.privateKey);
  reachable = false; await expect(mutation(b, { operation: "leave" })).rejects.toThrow("authority_offline");
  expect((await b.network.view()).membership).toBeDefined();
  expect((await a.network.view()).membership!.manifest.hosts.find(h => h.publicKey === b.auth.publicKey)?.revoked).toBe(false);
  reachable = true; await mutation(b, { operation: "leave" }); await c.network.tick();
  expect((await b.network.view()).sync).toBe("standalone");
  expect((await a.network.view()).membership!.manifest.hosts.find(h => h.publicKey === b.auth.publicKey)?.revoked).toBe(true);
  expect((await b.store.device(b.owner.id))?.revoked).toBe(0);
  expect((await c.store.device(bOwnerC.device.id))?.revoked).toBe(1);
  await expect(c.auth.authorize(remote.token)).rejects.toThrow();
});

it("retries active retirement safely after the root committed but its response was lost", async () => {
  const a = await host("a"), b = await host("b"); await create(a); await join(a,b);
  interceptExchange = async (_request, next) => { await next(); throw new Error("retire_response_lost"); };
  await expect(mutation(b, { operation: "leave" })).rejects.toThrow("retire_response_lost");
  expect((await b.network.view()).membership).toBeDefined();
  interceptExchange = undefined; await mutation(b, { operation: "leave" });
  expect((await b.network.view()).sync).toBe("standalone");
});

it("lets a removed host learn its frozen removal and revoke imported keys without revealing later members", async () => {
  const a = await host("a"), b = await host("b"); await create(a); await join(a,b);
  const imported = freshEnrollment(b, "a_on_b"); await b.network.enroll((await mutation(a, { operation: "attest", device: imported.device })).membership);
  const token = await login(b, imported.device.id, imported.keys.privateKey);
  const removed = (await mutation(a, { operation: "remove", publicKey: b.auth.publicKey })).membership!;
  await device(a, "after_removal"); await a.network.tick();
  await b.network.tick();
  expect((await b.network.view()).sync).toBe("removed");
  expect((await b.network.view()).membership).toEqual(removed);
  expect((await b.network.view()).membership!.manifest.devices.some(d => d.id === "after_removal")).toBe(false);
  await expect(b.auth.authorize(token.token)).rejects.toThrow();
  expect((await b.store.device(b.owner.id))?.revoked).toBe(0);
});

it("does not disclose newly joined members through unauthenticated enrollment of an old signed directory", async () => {
  const a = await host("a"), b = await host("b"); await create(a); await join(a, b);
  const old = structuredClone((await b.network.view()).membership!);
  await mutation(a, { operation: "remove", publicKey: b.auth.publicKey });
  await device(a, "private_after_removal"); await a.network.tick();
  const response = await a.network.enroll(old);
  expect(response.membership).toEqual(old);
  expect(JSON.stringify(response)).not.toContain("private_after_removal");
  expect((await a.network.view()).membership!.manifest.devices.some(d => d.id === "private_after_removal")).toBe(true);
});

it("does not restore stale host descriptors when an older signed directory is enrolled", async () => {
  const a = await host("a"), b = await host("b"); await create(a); await join(a, b);
  const old = structuredClone((await a.network.view()).membership!);
  const profile = await b.profile.read(); await b.profile.update({ name: "z-renamed", revision: profile.revision }); await b.network.tick();
  expect((await a.network.view()).membership!.manifest.hosts.find(h => h.publicKey === b.auth.publicKey)?.name).toBe("z-renamed");
  await a.network.enroll(old);
  expect((await a.network.view()).membership!.manifest.hosts.find(h => h.publicKey === b.auth.publicKey)?.name).toBe("z-renamed");
});

it("keeps a peer rename and shared routes stable while a third host polls stale directories", async () => {
  const a = await host("a"), b = await host("b"), c = await host("c"); await create(a); await join(a, b); await join(a, c); await c.network.tick();
  const profile = await b.profile.read(); await b.profile.update({ name: "z-renamed", revision: profile.revision });
  const routes = [{ name: "Direct" as const, url: "https://new-peer.example.invalid:8443" }];
  await mutation(b, { operation: "routes", routes }); await b.network.tick();
  const changed = (await a.network.view()).membership!.manifest;
  for (let i = 0; i < 3; i++) {
    await c.network.tick(); await b.network.tick();
    const current = (await a.network.view()).membership!.manifest;
    expect(current.hosts.find(h => h.publicKey === b.auth.publicKey)).toMatchObject({ name: "z-renamed", routes });
    expect(current.revision).toBe(changed.revision);
  }
});

it("returns the submitted current directory so target replacement can verify enrollment", async () => {
  const a = await host("a"), b = await host("b"); await create(a); await join(a, b);
  const current = (await a.network.view()).membership!;
  for (const target of [a, b]) {
    const response = await target.network.enroll(current);
    expect(response.membership).toEqual(current);
    expect(response.host).toMatchObject({ publicKey: target.auth.publicKey, state: "active", revoked: false });
  }
});

it("does not let an expired unsigned pairing reservation block a signed enrollment", async () => {
  const a = await host("a"), b = await host("b"); await create(a); await join(a, b);
  const enrolled = freshEnrollment(b, "expired_reservation"), other = freshEnrollment(b, "other");
  await b.auth.pair({ deviceId: enrolled.device.id, name: "old request", publicKey: other.device.publicKey, platform: "web" }, "127.0.0.1");
  await b.store.db.run("UPDATE pairing_requests SET expires_at=? WHERE device_id=?", [now - 1, enrolled.device.id]);
  const signed = (await mutation(a, { operation: "attest", device: enrolled.device })).membership!;
  await b.network.enroll(signed);
  expect((await b.store.device(enrolled.device.id))?.public_key).toBe(enrolled.device.publicKey);
});

it("still rejects an unexpired pairing reservation for a different identity", async () => {
  const a = await host("a"), b = await host("b"); await create(a); await join(a, b);
  const enrolled = freshEnrollment(b, "live_reservation"), other = freshEnrollment(b, "other");
  await b.auth.pair({ deviceId: enrolled.device.id, name: "live request", publicKey: other.device.publicKey, platform: "web" }, "127.0.0.1");
  const before = await b.network.view(), signed = (await mutation(a, { operation: "attest", device: enrolled.device })).membership!;
  await expect(b.network.enroll(signed)).rejects.toThrow("network_device_conflict");
  expect(await b.network.view()).toEqual(before);
  expect(await b.store.device(enrolled.device.id)).toBeUndefined();
});

it("does not resurrect a retired imported identity through a new network grant", async () => {
  const a = await host("a"), b = await host("b"); await create(a); await join(a, b);
  const enrolled = freshEnrollment(b, "returning_identity");
  await b.network.enroll((await mutation(a, { operation: "attest", device: enrolled.device })).membership!);
  await mutation(b, { operation: "leave" }); await mutation(a, { operation: "leave" });
  await create(a); await join(a, b);
  const grant = (await mutation(a, { operation: "attest", device: enrolled.device })).membership!;
  // A previous network's revoked key is not a fresh grant. The current API
  // requires a new identity; silently skipping this row would make the next
  // localRevocations pass revoke the new network's source member as well.
  await expect(b.network.enroll(grant)).rejects.toThrow("network_device_conflict");
  expect((await b.store.device(enrolled.device.id))?.revoked).toBe(1);
  expect((await b.network.view()).membership!.manifest.devices.some(device => device.id === enrolled.device.id)).toBe(false);
  expect((await a.store.device(a.owner.id))?.revoked).toBe(0);
});

it("redacts unseen members in a removal response when a restored root lost the historical snapshot", async () => {
  const a = await host("a"), b = await host("b"); await create(a); await join(a,b);
  const old = structuredClone((await b.network.view()).membership!.manifest);
  await mutation(a, { operation: "remove", publicKey: b.auth.publicKey });
  await a.store.db.run("DELETE FROM meta WHERE key LIKE 'private-network:removed:%'");
  await device(a, "unseen_after_removal"); await a.network.tick();
  // The disconnected peer can also have a higher numbered restored branch.
  old.revision += 50;
  const response = await a.network.peer(await peerRequest(b, { known: rootSign(a, old) }), "fixture");
  expect(response.manifest.hosts.find(h => h.publicKey === b.auth.publicKey)?.revoked).toBe(true);
  expect(response.manifest.revision).toBeGreaterThan(old.revision);
  expect(response.manifest.devices.some(d => d.id === "unseen_after_removal")).toBe(false);
  await b.network.enroll(response); expect((await b.network.view()).sync).toBe("removed");
  expect((await a.network.view()).membership!.manifest.devices.some(d => d.id === "unseen_after_removal")).toBe(true);
});

it("allows bounded clock skew on forwarded proofs without accepting expired or unbounded statements", async () => {
  const a = await host("a"), b = await host("b"), c = await host("c"); await create(a); await join(a,b); await join(a,c); await b.network.tick();
  const make = async (expiresAt: number, id: string) => {
    const target = freshEnrollment(c, id).device, command = { operation: "attest", networkId: (await b.network.view()).membership!.manifest.id, device: target };
    const prepared = await b.auth.prepareDeviceAction({ operation: "network", target: hashSecret(networkCanonical(command)) }, b.owner.token, b.owner.session);
    const statement = { ...prepared, expiresAt }, proof = { nonce: statement.nonce, signature: sign(null, Buffer.from(deviceActionProofText(statement)), b.owner.privateKey).toString("base64") };
    return peerRequest(b, { attest: { sourceDeviceId: b.owner.id, device: target, statement, proof } });
  };
  const accepted = await a.network.peer(await make(now+40_000, "clock_skew"), "fixture");
  expect(accepted.manifest.devices.some(d => d.id === "clock_skew")).toBe(true);
  await expect(a.network.peer(await make(now, "expired"), "fixture")).rejects.toThrow("network_source_proof_invalid");
  await expect(a.network.peer(await make(now+90_001, "excessive"), "fixture")).rejects.toThrow("network_source_proof_invalid");
});

it("re-signs an equal-revision subset fork so active peers can resolve the conflict", async () => {
  const a = await host("a"), b = await host("b"); await create(a); await join(a,b);
  const old = (await a.network.view()).membership!.manifest;
  await device(a, "new_device"); await a.network.tick();
  const current = (await a.network.view()).membership!.manifest, subset = { ...old, revision: current.revision };
  await a.network.enroll(rootSign(a, subset));
  const recovered = await a.network.view();
  expect(recovered.membership!.manifest.revision).toBeGreaterThan(current.revision);
  expect(recovered.membership!.manifest.devices.some(d => d.id === "new_device")).toBe(true);
});

it("joins and forwards consent between real HubAuth instances whose clocks differ by 45 seconds", async () => {
  const a = await host("a"), b = await host("b", 45_000), c = await host("c"); await create(a); await join(a,b); await join(a,c); await b.network.tick();
  const target = freshEnrollment(c, "skewed_b_owner");
  const result = await mutation(b, { operation: "attest", device: target.device });
  await c.network.enroll(result.membership);
  expect((await c.store.device(target.device.id))?.revoked).toBe(0);
  expect((await login(c, target.device.id, target.keys.privateKey)).session.deviceId).toBe(target.device.id);
});

it("keeps a phone first paired to departing C in A/B, while its old C grant and C controller bindings are revoked", async () => {
  const a = await host("a"), b = await host("b"), c = await host("c"), phone = await device(c, "phone_c");
  await create(a); await join(a, b); await join(a, c);
  const phoneA = freshEnrollment(a, "phone_a"), phoneB = freshEnrollment(b, "phone_b"), controllerA = freshEnrollment(a, "controller_c_a");
  await a.network.enroll((await mutation(c, { operation: "attest", device: phoneA.device }, phone)).membership);
  await b.network.enroll((await mutation(c, { operation: "attest", device: phoneB.device }, phone)).membership);
  await a.network.enroll((await mutation(c, { operation: "attest", device: controllerA.device })).membership);
  const activeA = await login(a, phoneA.device.id, phoneA.keys.privateKey), activeB = await login(b, phoneB.device.id, phoneB.keys.privateKey);
  const controller = await login(a, controllerA.device.id, controllerA.keys.privateKey);
  const result = await mutation(c, { operation: "leave" }, phone); await b.network.tick();
  expect(result.view.sync).toBe("standalone");
  expect(result.membership!.manifest.hosts.find(h => h.publicKey === c.auth.publicKey)?.revoked).toBe(true);
  expect(result.membership!.manifest.devices.find(d => d.id === phoneA.device.id)).toMatchObject({ scope: "network", revoked: false });
  expect(result.membership!.manifest.devices.find(d => d.id === controllerA.device.id)).toMatchObject({ scope: "host", revoked: true });
  expect(await a.auth.authorize(activeA.token)).toEqual(activeA.session);
  expect(await b.auth.authorize(activeB.token)).toEqual(activeB.session);
  await expect(c.auth.authorize(phone.token)).rejects.toThrow();
  await expect(a.auth.authorize(controller.token)).rejects.toThrow();
  expect(await c.auth.authorize(c.owner.token)).toEqual(c.owner.session);
  await a.auth.revoke(phoneA.device.id, "local-owner"); await a.network.tick(); await b.network.tick();
  await expect(b.auth.authorize(activeB.token)).rejects.toThrow();
});

it("blocks voluntary departure until phones are enrolled elsewhere, but permits owner removal", async () => {
  const a = await host("a"), c = await host("c"); await device(c, "phone_c"); await create(a); await join(a, c);
  await expect(mutation(c, { operation: "leave" })).rejects.toThrow("network_devices_not_ready");
  expect((await c.network.view()).host.revoked).toBe(false);
  await mutation(a, { operation: "remove", publicKey: c.auth.publicKey }); await c.network.tick();
  expect((await c.store.device("phone_c"))?.revoked).toBe(1);
  expect((await c.store.device(c.owner.id))?.revoked).toBe(0);
});

it("does not lose a phone's explicit revocation when its host leaves immediately afterwards", async () => {
  const a = await host("a"), c = await host("c"), phone = await device(c, "phone_c"); await create(a); await join(a, c);
  const remote = freshEnrollment(a, "phone_a"); await a.network.enroll((await mutation(c, { operation: "attest", device: remote.device }, phone)).membership);
  const auth = await login(a, remote.device.id, remote.keys.privateKey);
  await c.auth.revoke(phone.id, "local-owner"); await mutation(c, { operation: "leave" });
  await expect(a.auth.authorize(auth.token)).rejects.toThrow();
  expect((await a.network.view()).membership!.manifest.revokedMembers).toContain(networkMemberId(c.auth.publicKey, phone.id));
});

it("cleans old pending invitations once without revoking fresh pairing after removal", async () => {
  const a = await host("a"), c = await host("c"); await create(a); await join(a, c);
  const old = freshEnrollment(c, "old_pending"), pending = await c.auth.pair({ deviceId: old.device.id, publicKey: old.device.publicKey, name: "phone", platform: "android" }, "127.0.0.1");
  const removal = (await mutation(a, { operation: "remove", publicKey: c.auth.publicKey })).membership!; await c.network.enroll(removal);
  await expect(c.auth.approve(pending.code, "local-owner")).rejects.toThrow("pairing_expired_or_invalid");
  const fresh = await device(c, "fresh_phone"), newer = freshEnrollment(c, "new_pending");
  const newPending = await c.auth.pair({ deviceId: newer.device.id, publicKey: newer.device.publicKey, name: "phone", platform: "android" }, "127.0.0.1");
  await c.network.enroll(removal); await mutation(c, { operation: "leave" });
  expect(await c.auth.authorize(fresh.token)).toEqual(fresh.session);
  await expect(c.auth.approve(newPending.code, "local-owner")).resolves.toBe(newer.device.id);
});

it("cancelling a pending join preserves existing phone access and pending invitations", async () => {
  const a = await host("a"), c = await host("c"), phone = await device(c, "phone_c"); await create(a);
  const { proposal, membership } = await prepareJoin(a, c);
  reachable = false; await expect(mutation(c, { operation: "join", membership, nonce: proposal.proposal.nonce })).rejects.toThrow("authority_offline");
  const pendingDevice = freshEnrollment(c, "pending_phone"), pending = await c.auth.pair({ deviceId: pendingDevice.device.id, publicKey: pendingDevice.device.publicKey, name: "phone", platform: "android" }, "127.0.0.1");
  reachable = true; await mutation(c, { operation: "leave", expectedState: "pending" });
  expect(await c.auth.authorize(phone.token)).toEqual(phone.session);
  await expect(c.auth.approve(pending.code, "local-owner")).resolves.toBe(pendingDevice.device.id);
});

it("classifies native controllers by local marker, never by a phone's claimed macOS platform", async () => {
  const a = await host("a"), fake = freshEnrollment(a, "pretend_mac");
  const pending = await a.auth.pair({ deviceId: fake.device.id, publicKey: fake.device.publicKey, name: "Mac", platform: "macos" }, "127.0.0.1");
  await a.auth.approve(pending.code, "local-owner");
  const created = await create(a);
  expect(created.manifest.devices.find(d => d.id === fake.device.id)?.scope).toBe("network");
  expect(created.manifest.devices.find(d => d.id === a.owner.id)?.scope).toBe("host");
  await mutation(a, { operation: "leave" });
  expect((await a.store.device(fake.device.id))?.revoked).toBe(1);
  expect((await a.store.device(a.owner.id))?.revoked).toBe(0);
});

it("migrates a legacy member scope across all bindings without changing its original signed JSON", async () => {
  const a = await host("a"), c = await host("c"), phone = await device(c, "phone_c"); await create(a); await join(a, c);
  const remote = freshEnrollment(a, "phone_a"); await a.network.enroll((await mutation(c, { operation: "attest", device: remote.device }, phone)).membership);
  const full = (await a.network.view()).membership!, legacy = structuredClone(full.manifest), member = networkMemberId(c.auth.publicKey, phone.id);
  for (const d of legacy.devices) if (d.memberId === member) delete d.scope;
  const signedLegacy = rootSign(a, legacy), bytes = networkCanonical(signedLegacy);
  const merged = mergeNetworkManifests(legacy, full.manifest);
  expect(merged.devices.filter(d => d.memberId === member).length).toBeGreaterThan(0);
  expect(merged.devices.filter(d => d.memberId === member).every(d => d.scope === "network")).toBe(true);
  expect(networkCanonical(signedLegacy)).toBe(bytes);
  const conflicting = structuredClone(full.manifest); for (const d of conflicting.devices) if (d.memberId === member) d.scope = "host";
  const branches = [legacy, full.manifest, conflicting];
  const expected = mergeNetworkManifests(mergeNetworkManifests(branches[0]!, branches[1]!), branches[2]!);
  for (const [x, y, z] of [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]) {
    expect(mergeNetworkManifests(mergeNetworkManifests(branches[x!]!, branches[y!]!), branches[z!]!)).toEqual(expected);
    expect(mergeNetworkManifests(branches[x!]!, mergeNetworkManifests(branches[y!]!, branches[z!]!))).toEqual(expected);
  }
  expect(expected.revokedMembers).toContain(member);
  expect(mergeNetworkManifests(expected, full.manifest).devices.filter(d => d.memberId === member).length).toBeGreaterThan(0);
  expect(mergeNetworkManifests(expected, full.manifest).devices.filter(d => d.memberId === member).every(d => d.revoked)).toBe(true);
});

it("waits for every active host before upgrading a byte-exact v1 directory", async () => {
  const a = await host("a"), b = await host("b"), c = await host("c"); await create(a); await join(a,b); await join(a,c);
  const legacy = structuredClone((await a.network.view()).membership!.manifest); legacy.v = 1;
  for (const h of legacy.hosts) delete h.protocol; for (const d of legacy.devices) delete d.scope;
  const signed = rootSign(a, legacy), originalBytes = networkCanonical(signed);
  for (const h of [a,b,c]) {
    const record = await h.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key='private-network:v1'");
    const state = JSON.parse(record!.value); state.membership = signed; state.upgradedHosts = [];
    await h.store.db.run("UPDATE meta SET value=? WHERE key='private-network:v1'", [JSON.stringify(state)]);
  }
  await b.network.tick();
  const waiting = (await a.network.view()).membership!;
  expect(waiting.manifest.v).toBe(1); expect(waiting.manifest.devices.every(d => !d.scope)).toBe(true);
  expect(waiting.manifest.hosts.every(h => !h.protocol)).toBe(true);
  await expect(mutation(b, { operation: "leave" })).rejects.toThrow("network_upgrade_required");
  await c.network.tick(); await b.network.tick(); await a.network.tick();
  const upgraded = (await a.network.view()).membership!;
  expect(upgraded.manifest.v).toBe(2); expect(upgraded.manifest.hosts.every(h => h.protocol === 2)).toBe(true);
  expect(upgraded.manifest.devices.every(d => d.scope === "host")).toBe(true);
  expect(networkCanonical(signed)).toBe(originalBytes);
  const oldRequest = await peerRequest(b); delete oldRequest.request.host.protocol; oldRequest.signature = b.auth.signNetworkPeer(oldRequest.request);
  await expect(a.network.peer(oldRequest, "old-peer")).rejects.toThrow("network_upgrade_required");
});

it("keeps legacy devices unclassified until native migration or authenticated use", async () => {
  const a = await host("a"), phone = await device(a, "legacy_phone");
  await a.store.db.run("DELETE FROM meta WHERE key LIKE 'network-device:v1:%' OR key LIKE 'desktop-controller:v1:%'");
  const original = await create(a); expect(original.manifest.devices.every(d => d.scope === undefined)).toBe(true);
  await a.network.tick(); expect((await a.network.view()).membership!.manifest.devices.every(d => d.scope === undefined)).toBe(true);
  await a.auth.markLocalDesktopController({ deviceId: a.owner.id, publicKey: a.owner.publicKey, name: "Mac", platform: "macos" });
  await login(a, phone.id, phone.privateKey); await a.network.tick();
  expect((await a.network.view()).membership!.manifest.devices.find(d => d.id === a.owner.id)?.scope).toBe("host");
  expect((await a.network.view()).membership!.manifest.devices.find(d => d.id === phone.id)?.scope).toBe("network");
  await expect(a.auth.markLocalDesktopController({ deviceId: phone.id, publicKey: phone.publicKey, name: "Mac", platform: "macos" })).rejects.toThrow("desktop_controller_scope_conflict");
});

it("allows idempotent native controller migration only for an exact active owner identity", async () => {
  const a = await host("a"), payload = { deviceId: a.owner.id, publicKey: a.owner.publicKey, name: "Desktop", platform: "macos" };
  await expect(a.auth.markLocalDesktopController(payload)).resolves.toBe(true);
  await expect(a.auth.markLocalDesktopController(payload)).resolves.toBe(true);
  const unrelated = freshEnrollment(a, "other");
  await expect(a.auth.markLocalDesktopController({ ...payload, publicKey: unrelated.device.publicKey })).rejects.toThrow("desktop_controller_identity_invalid");
  await a.store.db.run("INSERT INTO users VALUES('member','member','member')"); const nonowner = await device(a, "member_device", "member");
  await expect(a.auth.markLocalDesktopController({ ...payload, deviceId: nonowner.id, publicKey: nonowner.publicKey })).rejects.toThrow("desktop_controller_identity_invalid");
  await a.auth.revoke(a.owner.id, "local-owner");
  await expect(a.auth.markLocalDesktopController(payload)).rejects.toThrow("desktop_controller_identity_invalid");
});

it("requires the trusted local controller to dissolve a singleton network", async () => {
  const a = await host("a"), phone = await device(a, "phone"); await create(a);
  await expect(mutation(a, { operation: "leave" }, phone)).rejects.toThrow("network_local_desktop_required");
  expect(await a.auth.authorize(phone.token)).toEqual(phone.session);
  expect((await a.network.view()).sync).toBe("current");
  expect((await mutation(a, { operation: "leave" })).view.sync).toBe("standalone");
  await expect(a.auth.authorize(phone.token)).rejects.toThrow();
});

it("creates a native controller and its trusted marker in the same pairing approval", async () => {
  const a = await host("a"), native = freshEnrollment(a, "native");
  const pending = await a.auth.pair({ deviceId: native.device.id, publicKey: native.device.publicKey, name: "Desktop", platform: "windows" }, "127.0.0.1");
  await a.auth.approveLocalDesktop(pending.code);
  const trusted = await a.store.db.serial(() => a.auth.localDesktopControllersInTransaction());
  expect(trusted.get(native.device.id)).toBe(native.device.publicKey);
  const signed = await create(a);
  expect(signed.manifest.devices.find(device => device.id === native.device.id)?.scope).toBe("host");
});

it("lets a host replace only its own descriptor routes: authority signs once, peer publishes on tick, removed host is a no-op", async () => {
  const a = await host("a"), b = await host("b");
  const route = (url: string) => ({ name: "Direct" as const, url }), relay = { name: "VPS" as const, url: "https://relay.example" };
  await mutation(a, { operation: "routes", routes: [route("https://192.0.2.10:8443"), relay] });
  await mutation(b, { operation: "routes", routes: [route("https://198.51.100.20:8443")] });
  await create(a); await join(a, b); await b.network.tick();
  const revision = (await a.network.view()).membership!.manifest.revision;
  expect(await a.network.replaceManagedRoutes([route("https://192.0.2.10:8443"), relay], [route("https://192.0.2.11:8443"), relay])).toBe(true);
  const manifest = (await a.network.view()).membership!.manifest;
  expect(manifest.revision).toBe(revision + 1);
  expect(manifest.hosts.find(item => item.publicKey === a.auth.publicKey)!.routes).toEqual([route("https://192.0.2.11:8443"), relay]);
  await a.network.tick(); expect((await a.network.view()).membership!.manifest.revision).toBe(revision + 1);
  // A stale expectation means an owner already chose differently: nothing changes.
  expect(await a.network.replaceManagedRoutes([route("https://192.0.2.10:8443"), relay], [route("https://192.0.2.12:8443"), relay])).toBe(false);
  expect(await b.network.replaceManagedRoutes([route("https://198.51.100.20:8443")], [route("https://198.51.100.21:8443")])).toBe(true);
  expect((await b.network.view()).sync).toBe("waiting");
  await b.network.tick();
  expect((await a.network.view()).membership!.manifest.hosts.find(item => item.publicKey === b.auth.publicKey)!.routes).toEqual([route("https://198.51.100.21:8443")]);
  const removed = await mutation(a, { operation: "remove", publicKey: b.auth.publicKey });
  await b.network.enroll(removed.membership);
  expect(await b.network.replaceManagedRoutes([route("https://198.51.100.21:8443")], [route("https://198.51.100.22:8443")])).toBe(false);
  expect((await b.network.view()).sync).toBe("removed");
});
