import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { request, type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { signedDeviceAction } from "./helpers/device-actions.js";

let root: string, hub: HubServer;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hub-revocation-"));
  hub = await HubServer.start({ stateDir: root });
});
afterEach(async () => { vi.restoreAllMocks(); await hub.close(); await rm(root, { recursive: true, force: true }); });
async function device(id: string) {
  const keys = generateKeyPairSync("ed25519"), nonce = randomBytes(32).toString("base64url");
  const pair = await hub.auth.pair({ deviceId: id, name: id, platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, id);
  return { pair, keys, login: async () => {
    await hub.auth.approve(pair.code, "local-owner");
    const challenge = await hub.auth.challenge(id, id, nonce, id);
    return hub.auth.authenticate(id, sign(null, deviceProof(id, challenge.nonce, nonce), keys.privateKey).toString("base64"));
  } };
}
async function revokeDuringBody(route: string, method: string, token: string, body: Buffer) {
  let began!: () => void;
  const admitted = new Promise<void>((resolve) => { began = resolve; });
  const authorize = hub.auth.authorize.bind(hub.auth);
  const spy = vi.spyOn(hub.auth, "authorize").mockImplementation(async (value) => { const session = await authorize(value); began(); return session; });
  let req!: ReturnType<typeof request>;
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    req = request(hub.url + route, { method, headers: { Authorization: `Bearer ${token}`, "Content-Length": body.length, "Content-Type": "application/json" } }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() })); res.on("error", reject);
    });
    req.on("error", reject); req.write(body.subarray(0, 1));
  });
  try {
    await admitted;
    await hub.auth.revoke("source", "local-owner");
    req.end(body.subarray(1));
    return await response;
  } finally { spy.mockRestore(); req.destroy(); }
}

it("rejects an already-authenticated slow pairing approval after its device is revoked", async () => {
  const source = await device("source"), target = await device("target");
  const session = await source.login();
  const signed = await signedDeviceAction(hub.url, session.token, source.keys.privateKey, { operation: "approve", target: target.pair.code });
  const result = await revokeDuringBody("/api/devices/approve", "POST", session.token, Buffer.from(JSON.stringify(signed.body)));
  expect(result.status).toBe(401);
  expect(result.body).toContain("device_revoked");
  expect(await hub.store.device("target")).toBeUndefined();
  expect(await hub.store.db.get("SELECT 1 FROM audit_log WHERE kind='http.rejected' AND actor='source'")).toBeDefined();
});

it("rejects a slow chunk write after revocation without storing a receipt or file", async () => {
  const session = await (await device("source")).login();
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('fixture','Fixture',?)", [hashSecret("fixture")]);
  const conversation = await hub.store.createConversation("owner", ["fixture"], "Fixture", "fixture");
  const bytes = Buffer.from("revoked upload must not be written");
  const upload = await hub.attachments.create("owner", { conversationId: conversation.id, name: "fixture.txt", mime: "text/plain", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  const result = await revokeDuringBody(`/api/uploads/${upload.id}/0`, "PUT", session.token, bytes);
  expect(result.status).toBe(401);
  expect(await hub.attachments.status("owner", upload.id)).toMatchObject({ chunks: [], complete: false });
  expect(await readdir(hub.attachments.directory)).toEqual([]);
});

it("rechecks an upload that waited in the file operation queue after body validation", async () => {
  const session = await (await device("source")).login();
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('fixture','Fixture',?)", [hashSecret("fixture")]);
  const conversation = await hub.store.createConversation("owner", ["fixture"], "Fixture", "fixture"), bytes = Buffer.from("queued file");
  const upload = await hub.attachments.create("owner", { conversationId: conversation.id, name: "fixture.txt", mime: "text/plain", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  let entered!: () => void, resume!: () => void;
  const waiting = new Promise<void>((r) => { entered = r; }), gate = new Promise<void>((r) => { resume = r; });
  // Occupy the real per-upload queue without writing a chunk. The HTTP upload
  // below must pass its body check, then wait behind this cancelled operation.
  const occupying = hub.attachments.putChunk("owner", upload.id, 0, bytes, async () => { await gate; throw new Error("fixture_cancelled"); }).catch((error: unknown) => {
    expect(error).toMatchObject({ message: "fixture_cancelled" });
  });
  const put = hub.attachments.putChunk.bind(hub.attachments);
  vi.spyOn(hub.attachments, "putChunk").mockImplementation((...args) => { const pending = put(...args); entered(); return pending; });
  const result = fetch(hub.url + `/api/uploads/${upload.id}/0`, { method: "PUT", headers: { Authorization: `Bearer ${session.token}` }, body: bytes });
  try { await waiting; await hub.auth.revoke("source", "local-owner"); }
  finally { resume(); }
  await occupying;
  expect((await result).status).toBe(401);
  expect(await hub.attachments.status("owner", upload.id)).toMatchObject({ chunks: [], complete: false });
  expect(await readdir(hub.attachments.directory)).toEqual([]);
});

it("rejects an expired session at the body boundary without masking it as a push validation error", async () => {
  const session = await (await device("source")).login();
  const authorize = hub.auth.authorize.bind(hub.auth);
  vi.spyOn(hub.auth, "authorize").mockImplementation(async (token) => {
    const admitted = await authorize(token); admitted.expiresAt = 0; return admitted;
  });
  const response = await fetch(hub.url + "/api/push", { method: "PUT", headers: { Authorization: `Bearer ${session.token}` }, body: "{}" });
  expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "session_expired" });
  expect(await hub.store.db.get("SELECT 1 FROM audit_log WHERE kind='push.registered'")).toBeUndefined();
});

it("rechecks the owner role before a slow owner-only response is released", async () => {
  const session = await (await device("source")).login();
  const devices = hub.store.devices.bind(hub.store);
  vi.spyOn(hub.store, "devices").mockImplementation(async (...args) => {
    const rows = await devices(...args);
    await hub.store.db.serial(() => hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'"));
    return rows;
  });
  const response = await fetch(hub.url + "/api/devices", { headers: { Authorization: `Bearer ${session.token}` } });
  expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "owner_required" });
});

it("checks trust again in the pairing commit after waiting behind other work", async () => {
  const source = await device("source"), session = await source.login(), target = await device("target");
  const signed = await signedDeviceAction(hub.url, session.token, source.keys.privateKey, { operation: "approve", target: target.pair.code });
  let entered!: () => void, resume!: () => void;
  const waiting = new Promise<void>((r) => { entered = r; }), gate = new Promise<void>((r) => { resume = r; });
  const approve = hub.auth.approve.bind(hub.auth);
  vi.spyOn(hub.auth, "approve").mockImplementation(async (...args) => { entered(); await gate; return approve(...args); });
  const result = fetch(hub.url + "/api/devices/approve", { method: "POST", headers: { Authorization: `Bearer ${session.token}` }, body: JSON.stringify(signed.body) });
  try { await waiting; await hub.auth.revoke("source", "local-owner"); }
  finally { resume(); }
  expect((await result).status).toBe(401);
  expect(await hub.store.device("target")).toBeUndefined();
});

it("does not return private data read before revocation but completed afterward", async () => {
  const session = await (await device("source")).login();
  let entered!: () => void, resume!: () => void;
  const waiting = new Promise<void>((r) => { entered = r; }), gate = new Promise<void>((r) => { resume = r; });
  const devices = hub.store.devices.bind(hub.store);
  vi.spyOn(hub.store, "devices").mockImplementation(async (...args) => { const rows = await devices(...args); entered(); await gate; return rows; });
  const result = fetch(hub.url + "/api/devices", { headers: { Authorization: `Bearer ${session.token}` } });
  try { await waiting; await hub.auth.revoke("source", "local-owner"); }
  finally { resume(); }
  expect((await result).status).toBe(401);
  expect(await (await result).json()).toEqual({ error: "device_revoked" });
});

it("acknowledges successful self-revocation while refusing its next request", async () => {
  const source = await device("source"), session = await source.login();
  const signed = await signedDeviceAction(hub.url, session.token, source.keys.privateKey, { operation: "revoke", target: "source" });
  const response = await fetch(hub.url + "/api/devices/revoke", { method: "POST", headers: { Authorization: `Bearer ${session.token}` }, body: JSON.stringify(signed.body) });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
  expect((await hub.store.device("source"))?.revoked).toBe(1);
  expect((await fetch(hub.url + "/api/devices", { headers: { Authorization: `Bearer ${session.token}` } })).status).toBe(401);
});

it.each(["same-process", "external-cli"])("cuts off an active download on %s revocation while a trusted device can still download", async (mode) => {
  const session = await (await device("source")).login(), trusted = await (await device("trusted")).login();
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('fixture','Fixture',?)", [hashSecret("fixture")]);
  const conversation = await hub.store.createConversation("owner", ["fixture"], "Fixture", "fixture");
  const bytes = Buffer.alloc(16 * 1024 * 1024, 7), hash = createHash("sha256").update(bytes).digest("hex");
  const id = await hub.attachments.importForBot("fixture", { conversationId: conversation.id, name: "fixture.bin", mime: "application/octet-stream", size: bytes.length, sha256: hash }, bytes);
  let req!: ReturnType<typeof request>;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    req = request(hub.url + `/api/attachments/${id}`, { headers: { Authorization: `Bearer ${session.token}` } }, (res) => { res.pause(); resolve(res); });
    req.on("error", reject); req.end();
  });
  let received = 0;
  const closed = new Promise<void>((resolve) => { response.on("data", (chunk) => { received += chunk.length; }); response.on("error", () => undefined); response.on("close", resolve); });
  try {
    expect(response.statusCode).toBe(200);
    if (mode === "same-process") await hub.auth.revoke("source", "local-owner");
    else await hub.store.db.serial(() => hub.store.db.run("UPDATE devices SET revoked=1 WHERE id='source'"));
    // Keep backpressure until the server confirms it has cancelled the stream.
    await vi.waitFor(async () => expect(await hub.store.db.get("SELECT 1 FROM audit_log WHERE actor='source' AND kind='http.rejected' AND detail_json LIKE '%device_revoked%'" )).toBeDefined(), { timeout: 2000, interval: 20 });
    response.resume(); await closed;
    expect(response.complete).toBe(false); expect(received).toBeLessThan(bytes.length);
    const valid = await fetch(hub.url + `/api/attachments/${id}`, { headers: { Authorization: `Bearer ${trusted.token}` } });
    expect(valid.status).toBe(200);
    expect(createHash("sha256").update(Buffer.from(await valid.arrayBuffer())).digest("hex")).toBe(hash);
  } finally { response.destroy(); req.destroy(); }
});
