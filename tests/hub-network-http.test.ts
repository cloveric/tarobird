import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { CAPABILITIES } from "../src/client-protocol/index.js";
import { networkCanonical, type NetworkCommand } from "../src/client-protocol/private-network.js";
import { MAX_NETWORK_BYTES } from "../src/hub/network-peer.js";
import { signedDeviceAction } from "./helpers/device-actions.js";
import { desktopControllerMarkerKey } from "../src/hub/local-controller.js";

let directory: string, hub: HubServer;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "network-http-")); hub = await HubServer.start({ stateDir: directory }); });
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await hub.close(); await rm(directory, { recursive: true, force: true }); });
async function enroll(id = "owner_device", userId = "owner") {
  const keys = generateKeyPairSync("ed25519");
  const paired = await hub.auth.pair({ deviceId: id, name: id, platform: "web", publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64") }, "fixture");
  await hub.auth.approve(paired.code, "local-owner", userId);
  const nonce = randomBytes(32).toString("base64url"), challenge = await hub.auth.challenge(id, id, nonce, "fixture");
  const session = await hub.auth.authenticate(id, sign(null, deviceProof(id, challenge.nonce, nonce), keys.privateKey).toString("base64"));
  return { keys, token: session.token, headers: { Authorization: `Bearer ${session.token}` } };
}
async function commandBody(owner: Awaited<ReturnType<typeof enroll>>, command: NetworkCommand) {
  const { proof } = await signedDeviceAction(hub.url, owner.token, owner.keys.privateKey, { operation: "network", target: hashSecret(networkCanonical(command)) });
  return { command, proof };
}

it("advertises network support and keeps host profiles authenticated with owner-only revision-checked edits", async () => {
  expect(CAPABILITIES).toContain("private-network.v2");
  expect((await fetch(hub.url + "/api/host-profile")).status).toBe(401);
  const owner = await enroll();
  const initial = await (await fetch(hub.url + "/api/host-profile", { headers: owner.headers })).json() as { name: string; revision: number };
  const rename = (revision: number, name: string) => fetch(hub.url + "/api/host-profile", { method: "PATCH", headers: owner.headers, body: JSON.stringify({ revision, name }) });
  const changed = await rename(initial.revision, "工作 Mac");
  expect(changed.status).toBe(200); expect(await changed.json()).toEqual({ name: "工作 Mac", revision: initial.revision + 1 });
  expect((await rename(initial.revision, "Stale client")).status).toBe(409);
  await hub.store.db.serial(() => hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'"));
  expect((await rename(initial.revision + 1, "Forbidden")).status).toBe(403);
  expect((await fetch(hub.url + "/api/host-profile", { headers: owner.headers })).status).toBe(200);
  expect((await fetch(hub.url + "/api/network", { headers: owner.headers })).status).toBe(403);
  expect((await hub.profile.read()).name).toBe("工作 Mac");
});

it("does not disclose a host-device name binding through another user's rename request", async () => {
  const owner = await enroll(), device = (await hub.store.device("owner_device"))!;
  await hub.store.db.run("INSERT INTO meta(key,value) VALUES(?,?)", [desktopControllerMarkerKey(device.id), JSON.stringify({ id: device.id, publicKey: device.public_key, nameSource: "host" })]);
  await hub.store.db.run("INSERT INTO users VALUES('member','Member','member')");
  const member = await enroll("member_device", "member");
  const rename = (headers: Record<string, string>) => fetch(hub.url + "/api/devices/rename", { method: "PATCH", headers, body: JSON.stringify({ deviceId: device.id, name: "second name" }) });
  const denied = await rename(member.headers);
  expect(denied.status).toBe(404); expect(await denied.json()).toEqual({ error: "device_not_found" });
  const linked = await rename(owner.headers);
  expect(linked.status).toBe(409); expect(await linked.json()).toEqual({ error: "host_device_name_managed" });
  expect((await hub.store.device(device.id))?.name).toBe(device.name);
});

it("stores an explicit device alias atomically, even for the same name, without granting other users access", async () => {
  const owner = await enroll();
  const rename = (headers: Record<string, string>, name: string) => fetch(hub.url + "/api/devices/rename", { method: "PATCH", headers, body: JSON.stringify({ deviceId: "owner_device", name }) });
  expect((await rename(owner.headers, "owner_device")).status).toBe(200);
  const marker = await hub.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key LIKE 'network-device-name:v1:%'");
  expect(JSON.parse(marker!.value)).toMatchObject({ kind: "alias", id: "owner_device", publicKey: (await hub.store.device("owner_device"))!.public_key });
  await hub.store.db.run("INSERT INTO users VALUES('other','Other','member')");
  const member = await enroll("other_device", "other");
  expect((await rename(member.headers, "Forbidden")).status).toBe(404);
  expect((await hub.store.device("owner_device"))?.name).toBe("owner_device");
  await hub.store.db.run("CREATE TRIGGER fail_alias BEFORE UPDATE ON meta WHEN NEW.key LIKE 'network-device-name:v1:%' BEGIN SELECT RAISE(ABORT,'fixture alias failure'); END");
  expect((await rename(owner.headers, "Rollback")).status).toBe(500);
  expect((await hub.store.device("owner_device"))?.name).toBe("owner_device");
});

it("rejects device renames that cannot be published in the signed network directory", async () => {
  const owner = await enroll();
  for (const name of ["family 👨‍👩‍👧", "bad\u0000name"]) {
    const response = await fetch(hub.url + "/api/devices/rename", { method: "PATCH", headers: owner.headers, body: JSON.stringify({ deviceId: "owner_device", name }) });
    expect(response.status).toBe(400);
    expect((await hub.store.device("owner_device"))?.name).toBe("owner_device");
  }
});

it("requires a fresh key proof for network creation and binds it to the complete command", async () => {
  const owner = await enroll(), command = { operation: "create", name: "家庭网络" } as const;
  expect((await fetch(hub.url + "/api/network")).status).toBe(401);
  const post = (body: unknown) => fetch(hub.url + "/api/network/manage", { method: "POST", headers: owner.headers, body: JSON.stringify(body) });
  expect((await post({ command })).status).toBe(403);
  const changed = await commandBody(owner, command);
  const substituted = await post({ ...changed, command: { ...command, name: "Different network" } });
  expect(substituted.status).toBe(403); expect(await substituted.json()).toEqual({ error: "device_action_invalid" });
  const valid = await commandBody(owner, command), created = await post(valid);
  expect(created.status).toBe(200);
  const result = await created.json();
  expect(result).toMatchObject({ view: { membership: { manifest: { name: "家庭网络", authorityKey: hub.auth.publicKey } } } });
  expect((await post(valid)).status).toBe(403);
  const view = await (await fetch(hub.url + "/api/network", { headers: owner.headers })).json();
  expect(view).toMatchObject({ membership: { manifest: { name: "家庭网络" } } });
});

it("keeps pre-auth peer/enroll endpoints signed, bounded, rate-limited and behind the existing Origin policy", async () => {
  for (const endpoint of ["peer", "enroll"]) {
    const endpointUrl = hub.url + "/api/network/" + endpoint;
    const forbidden = await fetch(endpointUrl, { method: "POST", headers: { Origin: "https://untrusted.example" }, body: "{}" });
    expect(forbidden.status).toBe(403); expect(await forbidden.json()).toEqual({ error: "origin_forbidden" });
    const invalid = await fetch(endpointUrl, { method: "POST", body: "{}" });
    expect(invalid.status).toBe(400); expect(JSON.stringify(await invalid.json())).not.toContain(directory);
    const oversized = await fetch(endpointUrl, { method: "POST", body: "x".repeat(MAX_NETWORK_BYTES + 1) });
    expect(oversized.status).toBe(413);
  }
  for (let i = 0; i < 58; i++) await fetch(hub.url + "/api/network/enroll", { method: "POST", body: "{}" });
  const limited = await fetch(hub.url + "/api/network/enroll", { method: "POST", body: "{}", headers: { "X-Forwarded-For": "pretend-new-source" } });
  expect(limited.status).toBe(429);
  expect(await limited.json()).toEqual({ error: "rate_limited" });
  expect((await fetch(hub.url + "/health")).status).toBe(200);
});

it("rechecks a delayed network read before returning private membership", async () => {
  const owner = await enroll(); let release!: () => void;
  const view = await hub.network.view();
  vi.spyOn(hub.network, "view").mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return view; });
  const pending = fetch(hub.url + "/api/network", { headers: owner.headers });
  await vi.waitFor(() => expect(release).toBeDefined());
  await hub.auth.revoke("owner_device", "local-owner"); release();
  const response = await pending;
  expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "device_revoked" });
});

it("bounds unauthenticated peer bursts before parsing and ignores a forged forwarding source", async () => {
  let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  const peer = vi.spyOn(hub.network, "peer");
  const post = (body = "{}") => fetch(hub.url + "/api/network/peer", { method: "POST", body, headers: { "X-Forwarded-For": randomBytes(4).toString("hex") } });
  for (let i = 0; i < 64; i++) expect((await post()).status).toBe(400);
  const blocked = await post("not even JSON"); expect(blocked.status).toBe(429);
  expect(await blocked.json()).toEqual({ error: "rate_limited" }); expect(peer).toHaveBeenCalledTimes(64);
  now += 125;
  expect((await post()).status).toBe(400); expect((await post()).status).toBe(429);
  expect(peer).toHaveBeenCalledTimes(65);
  expect((await fetch(hub.url + "/health")).status).toBe(200);
});

it("allows 32 hosts behind one source to poll every five seconds with headroom for a join", async () => {
  let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  const post = () => fetch(hub.url + "/api/network/peer", { method: "POST", body: "{}" });
  for (let round = 0; round < 13; round++) {
    for (let host = 0; host < 32; host++) expect((await post()).status).toBe(400);
    // Invalid schema is expected here; a 429 would mean normal simultaneous
    // polling is blocked before the peer's authenticated request can be read.
    expect((await post()).status).toBe(400);
    now += 5_000;
  }
});

it("rejects a device revoked while its profile mutation body is still arriving", async () => {
  const owner = await enroll(), initial = await hub.profile.read();
  const authorize = vi.spyOn(hub.auth, "authorize"), body = JSON.stringify({ name: "Should not persist", revision: initial.revision });
  let req!: ReturnType<typeof request>;
  const response = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    req = request(hub.url + "/api/host-profile", { method: "PATCH", headers: owner.headers }, res => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) })); res.on("error", reject);
    }); req.on("error", reject); req.write(body.slice(0, 1));
  });
  await vi.waitFor(() => expect(authorize).toHaveBeenCalled());
  await hub.auth.revoke("owner_device", "local-owner"); req.end(body.slice(1));
  expect(await response).toEqual({ status: 401, body: { error: "device_revoked" } });
  expect(await hub.profile.read()).toEqual(initial);
});

it("waits for an in-flight network tick before closing SQLite and does not overlap ticks", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  await hub.close(); hub = await HubServer.start({ stateDir: path.join(directory, "lifecycle") });
  // Drain the startup tick before replacing it with a controlled pending pull.
  await hub.network.view();
  let release!: () => void, active = 0;
  const tick = vi.spyOn(hub.network, "tick").mockImplementation(async () => {
    active++; expect(active).toBe(1);
    await new Promise<void>(resolve => { release = resolve; });
    expect(await hub.store.db.get("SELECT 1 AS alive")).toEqual({ alive: 1 }); active--;
  });
  await vi.advanceTimersByTimeAsync(5_000);
  await vi.waitFor(() => expect(release).toBeDefined());
  await vi.advanceTimersByTimeAsync(15_000); expect(tick).toHaveBeenCalledTimes(1);
  let closed = false; const closing = hub.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false);
  release(); await closing; expect(closed).toBe(true);
});
