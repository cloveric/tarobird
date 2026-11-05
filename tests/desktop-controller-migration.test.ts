import path from "node:path";
import os from "node:os";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { desktopHost } from "../src/hub/desktop.js";
import { inspectHubService, startHubControl } from "../src/hub/service.js";
import { HubAuth, hashSecret } from "../src/hub/auth.js";
import { desktopControllerChallengeSchema, desktopControllerProofText, type DesktopControllerChallenge } from "../src/hub/local-controller.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { HostNetwork } from "../src/host-cli/network-cli.js";

const hosts: { directory: string; hub: HubServer; close: () => Promise<void> }[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) { await host.close(); await host.hub.close(); await rm(host.directory, { recursive: true, force: true }); } });
async function host() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taro-native-"));
  const hub = await HubServer.start({ stateDir: directory });
  const close = await startHubControl(directory, { running: true, pid: process.pid, url: hub.url, publicKey: hub.auth.publicKey }, () => {}, {
    enrollController: value => hub.enrollLocalController(value), desktopControllerChallenge: value => hub.prepareLocalDesktopController(value),
    enrollDesktopController: value => hub.enrollLocalDesktopController(value),
  });
  const result = { directory, hub, close }; hosts.push(result); return result;
}
function identity(id = "legacy_desktop", platform: "macos" | "windows" = "macos") {
  const keys = generateKeyPairSync("ed25519");
  return { keys, device: { deviceId: id, publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), name: "Desktop", platform } };
}
async function legacy(h: Awaited<ReturnType<typeof host>>, d: ReturnType<typeof identity>) {
  await h.hub.store.db.run("INSERT INTO devices(id,user_id,name,platform,public_key,created_at,last_seen) VALUES(?,'owner',?,?,?,?,?)", [d.device.deviceId, d.device.name, d.device.platform, d.device.publicKey, 1, 1]);
}
async function proof(h: Awaited<ReturnType<typeof host>>, d: ReturnType<typeof identity>) {
  const response = await desktopHost("pair-challenge", h.directory, "unused", d.device);
  const challenge = desktopControllerChallengeSchema.parse((response as { desktopControllerChallenge: unknown }).desktopControllerChallenge);
  return { challenge, signature: sign(null, Buffer.from(desktopControllerProofText(challenge)), d.keys.privateKey).toString("base64") };
}

it("migrates only the native-held legacy desktop key through the local control path, then stays idempotent", async () => {
  const h = await host(), d = identity(); await legacy(h, d);
  await expect(h.hub.enrollLocalController(d.device)).rejects.toThrow("desktop_controller_identity_invalid");
  await expect(desktopHost("pair", h.directory, "unused", d.device)).rejects.toThrow("desktop_controller_proof_required");
  await desktopHost("pair", h.directory, "unused", { ...d.device, nativeProof: await proof(h, d) });
  await desktopHost("pair", h.directory, "unused", { ...d.device, nativeProof: await proof(h, d) });
  expect((await h.hub.auth.localDesktopControllersInTransaction()).get(d.device.deviceId)).toBe(d.device.publicKey);
  expect(await h.hub.store.db.get("SELECT created_at,public_key FROM devices WHERE id=?", [d.device.deviceId])).toEqual({ created_at: 1, public_key: d.device.publicKey });
  expect(await h.hub.store.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE kind='controller.migrated'")).toEqual({ n: 1 });
});

it("requires a fresh exact proof for a new native desktop enrollment and consumes successful proofs", async () => {
  const h = await host(), d = identity("new_desktop"), nativeProof = await proof(h, d);
  await desktopHost("pair", h.directory, "unused", { ...d.device, nativeProof });
  await expect(desktopHost("pair", h.directory, "unused", { ...d.device, nativeProof })).rejects.toThrow("desktop_controller_proof_expired");
  expect((await h.hub.auth.localDesktopControllersInTransaction()).get(d.device.deviceId)).toBe(d.device.publicKey);
});

it.each(["expired", "approved"])("ignores an %s foreign pairing reservation during native controller enrollment", async state => {
  const h = await host(), d = identity("native_after_old_request"), other = identity(d.device.deviceId);
  await h.hub.auth.pair(other.device, "fixture");
  if (state === "expired") await h.hub.store.db.run("UPDATE pairing_requests SET expires_at=? WHERE device_id=?", [Date.now() - 1, d.device.deviceId]);
  else await h.hub.store.db.run("UPDATE pairing_requests SET status='approved' WHERE device_id=?", [d.device.deviceId]);
  await desktopHost("pair", h.directory, "unused", { ...d.device, nativeProof: await proof(h, d) });
  expect((await h.hub.store.device(d.device.deviceId))?.public_key).toBe(d.device.publicKey);
  expect((await h.hub.auth.localDesktopControllersInTransaction()).get(d.device.deviceId)).toBe(d.device.publicKey);
});

it("keeps an active different-key pairing reservation fenced during native controller enrollment", async () => {
  const h = await host(), d = identity("pending_native"), other = identity(d.device.deviceId);
  await h.hub.auth.pair(other.device, "fixture");
  await expect(desktopHost("pair", h.directory, "unused", { ...d.device, nativeProof: await proof(h, d) })).rejects.toThrow("desktop_controller_identity_invalid");
  expect(await h.hub.store.device(d.device.deviceId)).toBeUndefined();
});

it.each(["macos", "windows"] as const)("%s: native devices follow the host name across migration and CLI renames, without renaming phones or CLI", async platform => {
  const h = await host(), d = identity("native_computer");
  const controller = { ...d, device: { ...d.device, name: "这台电脑", platform } };
  // An already trusted desktop from an older release has no name binding yet.
  await h.hub.enrollLocalController(controller.device);
  const local = await LocalHostClient.connect(h.directory, { enroll: true });
  const phone = identity("phone");
  const pending = await h.hub.auth.pair({ ...phone.device, name: "我的手机", platform: "android" }, "fixture");
  await h.hub.auth.approve(pending.code, "local-owner");
  try {
    const profile = await h.hub.profile.read();
    await h.hub.profile.update({ name: "example-mac", revision: profile.revision });
    const nativeProof = await proof(h, controller);
    await desktopHost("pair", h.directory, "unused", { ...controller.device, nativeProof });
    const devices = () => local.request<{ id: string; name: string; nameSource?: string }[]>("/api/devices");
    expect((await devices()).find(device => device.id === controller.device.deviceId)).toMatchObject({ name: "example-mac", nameSource: "host" });
    expect((await devices()).find(device => device.id === local.deviceId)).toMatchObject({ name: "TaroBird CLI" });
    expect((await devices()).find(device => device.id === "phone")).toMatchObject({ name: "我的手机" });
    await expect(local.request("/api/devices/rename", "PATCH", { deviceId: controller.device.deviceId, name: "第二个名称" })).rejects.toThrow("host_device_name_managed");
    await local.request("/api/host-profile", "PATCH", { name: "工作电脑", revision: profile.revision + 1 });
    await desktopHost("pair", h.directory, "unused", { ...controller.device, nativeProof: await proof(h, controller) });
    expect((await devices()).find(device => device.id === controller.device.deviceId)).toMatchObject({ name: "工作电脑", nameSource: "host" });
    expect((await devices()).find(device => device.id === local.deviceId)).toMatchObject({ name: "TaroBird CLI" });
    expect((await devices()).find(device => device.id === "phone")).toMatchObject({ name: "我的手机" });
    expect((await h.hub.store.device(controller.device.deviceId))?.name).toBe("工作电脑");
  } finally { local.close(); }
});

it("keeps native name migration atomic and ignores revoked, wrong-key or unbound desktop records", async () => {
  const h = await host(), d = identity(), remote = identity("remote_mac"); await legacy(h, d); await legacy(h, remote);
  await h.hub.profile.update({ name: "example-mac", revision: (await h.hub.profile.read()).revision });
  await h.hub.store.db.run("CREATE TRIGGER reject_native_name BEFORE UPDATE OF name ON devices WHEN NEW.id='legacy_desktop' BEGIN SELECT RAISE(ABORT,'fixture_name_failure'); END");
  await expect(desktopHost("pair", h.directory, "unused", { ...d.device, nativeProof: await proof(h, d) })).rejects.toThrow("fixture_name_failure");
  expect((await h.hub.auth.localDesktopControllersInTransaction()).has(d.device.deviceId)).toBe(false);
  expect((await h.hub.store.device(d.device.deviceId))?.name).toBe("Desktop");
  await h.hub.store.db.run("DROP TRIGGER reject_native_name");
  await desktopHost("pair", h.directory, "unused", { ...d.device, nativeProof: await proof(h, d) });
  // A failed host rename also rolls back the profile revision, not just the row.
  await h.hub.store.db.run("CREATE TRIGGER reject_native_name BEFORE UPDATE OF name ON devices WHEN NEW.id='legacy_desktop' BEGIN SELECT RAISE(ABORT,'fixture_name_failure'); END");
  await expect(h.hub.profile.update({ name: "Must roll back", revision: 1 })).rejects.toThrow("fixture_name_failure");
  expect(await h.hub.profile.read()).toEqual({ name: "example-mac", revision: 1 });
  await h.hub.store.db.run("DROP TRIGGER reject_native_name");
  await h.hub.auth.revoke(d.device.deviceId, "local-owner");
  await h.hub.store.db.run("INSERT INTO meta(key,value) VALUES(?,?)", [`desktop-controller:v1:${hashSecret(remote.device.deviceId)}`, JSON.stringify({ id: remote.device.deviceId, publicKey: d.device.publicKey, nameSource: "host" })]);
  await h.hub.profile.update({ name: "New name", revision: 1 });
  expect((await h.hub.store.device(d.device.deviceId))?.name).toBe("example-mac");
  expect((await h.hub.store.device(remote.device.deviceId))?.name).toBe("Desktop");
  expect((await h.hub.store.devices("owner")).every(device => device.nameSource === undefined)).toBe(true);
});

it("rejects wrong signatures, altered Hub binding and replay after a failed signature without elevating", async () => {
  const h = await host(), d = identity(), other = identity("other"); await legacy(h, d);
  const wrong = await proof(h, d), correct = structuredClone(wrong);
  wrong.signature = sign(null, Buffer.from(desktopControllerProofText(wrong.challenge)), other.keys.privateKey).toString("base64");
  await expect(desktopHost("pair", h.directory, "unused", { ...d.device, nativeProof: wrong })).rejects.toThrow("desktop_controller_proof_invalid");
  await expect(desktopHost("pair", h.directory, "unused", { ...d.device, nativeProof: correct })).rejects.toThrow("desktop_controller_proof_expired");
  const altered = await proof(h, d); altered.challenge.hubPublicKey = other.device.publicKey;
  altered.signature = sign(null, Buffer.from(desktopControllerProofText(altered.challenge)), d.keys.privateKey).toString("base64");
  await expect(desktopHost("pair", h.directory, "unused", { ...d.device, nativeProof: altered })).rejects.toThrow("desktop_controller_proof_invalid");
  expect((await h.hub.auth.localDesktopControllersInTransaction()).has(d.device.deviceId)).toBe(false);
});

it("does not promote a phone classified by a local network marker even with its valid key proof", async () => {
  const h = await host(), d = identity("phone");
  const pending = await h.hub.auth.pair({ ...d.device, platform: "android" }, "local-fixture"); await h.hub.auth.approve(pending.code, "local-owner");
  await expect(desktopHost("pair", h.directory, "unused", { ...d.device, nativeProof: await proof(h, d) })).rejects.toThrow("desktop_controller_scope_conflict");
  expect((await h.hub.auth.localDesktopControllersInTransaction()).has(d.device.deviceId)).toBe(false);
});

it("does not promote an explicitly network-scoped member when its local marker is absent", async () => {
  const h = await host(), cli = await LocalHostClient.connect(h.directory, { enroll: true }), d = identity("network_phone");
  try {
    const pending = await h.hub.auth.pair({ ...d.device, platform: "android" }, "local-fixture"); await h.hub.auth.approve(pending.code, "local-owner");
    await new HostNetwork(cli).command({ operation: "create", name: "Legacy network" });
    await h.hub.store.db.run("DELETE FROM meta WHERE key=?", [`network-device:v1:${hashSecret(d.device.deviceId)}`]);
    await expect(desktopHost("pair", h.directory, "unused", { ...d.device, nativeProof: await proof(h, d) })).rejects.toThrow("desktop_controller_scope_conflict");
    expect((await h.hub.auth.localDesktopControllersInTransaction()).has(d.device.deviceId)).toBe(false);
  } finally { cli.close(); }
});

it("migrates an unclassified legacy member without changing phones or the signed network identity", async () => {
  const h = await host(), cli = await LocalHostClient.connect(h.directory, { enroll: true }), d = identity(); await legacy(h, d);
  try {
    const network = new HostNetwork(cli), created = await network.command({ operation: "create", name: "Legacy network" });
    expect(created.view.membership!.manifest.devices.find(device => device.id === d.device.deviceId)?.scope).toBeUndefined();
    await desktopHost("pair", h.directory, "unused", { ...d.device, nativeProof: await proof(h, d) });
    await h.hub.network.tick();
    const view = await h.hub.network.view();
    expect(view.membership!.manifest.id).toBe(created.view.membership!.manifest.id);
    expect(view.membership!.manifest.devices.find(device => device.id === d.device.deviceId)?.scope).toBe("host");
  } finally { cli.close(); }
});

it("rejects revoked or different-key legacy identities and atomically rolls back a failed marker write", async () => {
  const h = await host(), d = identity(); await legacy(h, d);
  const wrong = identity(d.device.deviceId);
  await expect(desktopHost("pair", h.directory, "unused", { ...wrong.device, nativeProof: await proof(h, wrong) })).rejects.toThrow("desktop_controller_identity_invalid");
  await h.hub.store.db.run("CREATE TRIGGER reject_controller BEFORE INSERT ON meta WHEN NEW.key LIKE 'desktop-controller:v1:%' BEGIN SELECT RAISE(ABORT,'fixture_marker_failure'); END");
  await expect(desktopHost("pair", h.directory, "unused", { ...d.device, nativeProof: await proof(h, d) })).rejects.toThrow("fixture_marker_failure");
  expect((await h.hub.auth.localDesktopControllersInTransaction()).has(d.device.deviceId)).toBe(false);
  expect(await h.hub.store.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE kind='controller.migrated'")).toEqual({ n: 0 });
  await h.hub.store.db.run("DROP TRIGGER reject_controller"); await h.hub.auth.revoke(d.device.deviceId, "local-owner");
  await expect(desktopHost("pair", h.directory, "unused", { ...d.device, nativeProof: await proof(h, d) })).rejects.toThrow("desktop_controller_identity_invalid");
});

it("pins native challenge requests to the current Hub before issuing any challenge", async () => {
  const h = await host(), d = identity();
  await expect(inspectHubService(h.directory, "desktop-controller-challenge", { controller: d.device, expectedPublicKey: d.device.publicKey })).rejects.toThrow("hub_control_closed");
});

it("expires unused native challenges and bounds outstanding challenges", async () => {
  const h = await host(), d = identity(); let now = Date.now();
  const auth = await HubAuth.open(h.hub.store, h.directory, () => now);
  const challenge = auth.prepareDesktopController(d.device);
  const proof = { challenge, signature: sign(null, Buffer.from(desktopControllerProofText(challenge)), d.keys.privateKey).toString("base64") };
  now += 30_000;
  expect(() => auth.consumeDesktopController(proof, d.device)).toThrow("desktop_controller_proof_expired");
  for (let i = 0; i < 32; i++) auth.prepareDesktopController(d.device);
  expect(() => auth.prepareDesktopController(d.device)).toThrow("rate_limited");
  now += 30_000;
  expect(auth.prepareDesktopController(d.device).expiresAt).toBe(now + 30_000);
});

it("matches the native Rust signing vector byte-for-byte", () => {
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 7)]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");
  const challenge: DesktopControllerChallenge = { v: 1, hubPublicKey: publicKey, deviceId: "device_local", publicKey, nonce: "A".repeat(43), expiresAt: 100030000 };
  const signature = sign(null, Buffer.from(desktopControllerProofText(challenge)), privateKey).toString("base64");
  expect(signature).toBe("k0hEa2spFDSsQXsvx5GTQcV0PV3B812l7OjV85newbDIO+I9z/3YVWWdyvGVfWV8RGQL5ZamstRMFGnjk+fNBg==");
  expect(verify(null, Buffer.from(desktopControllerProofText(challenge)), createPublicKey(privateKey), Buffer.from(signature, "base64"))).toBe(true);
});
