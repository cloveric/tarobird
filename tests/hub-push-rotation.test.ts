import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { deviceProof } from "../src/hub/auth.js";
import { PushWorker } from "../src/hub/push/worker.js";

let root: string, hub: HubServer, auth: string;
const oldToken = "old_token_" + "a".repeat(40), newToken = "new_token_" + "b".repeat(40);
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "push-rotation-"));
  hub = await HubServer.start({ stateDir: root, push: { unifiedpush: { origins: ["https://ntfy.example.test"] } } });
  const keys = generateKeyPairSync("ed25519"), nonce = randomBytes(32).toString("base64url");
  const pair = await hub.auth.pair({ deviceId: "phone", name: "Phone", platform: "android", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, "local");
  await hub.auth.approve(pair.code, "local-owner"); const challenge = await hub.auth.challenge("phone", "phone", nonce, "local");
  auth = (await hub.auth.authenticate("phone", sign(null, deviceProof("phone", challenge.nonce, nonce), keys.privateKey).toString("base64"))).token;
});
afterEach(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
const api = (route: string, method = "GET", body?: unknown) => fetch(hub.url + route, { method, headers: { Authorization: `Bearer ${auth}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const binding = async () => { const response = await api("/api/push"); expect(response.status).toBe(200); return response.json() as Promise<{ provider: string | null; revision: string | null; enabled: boolean }>; };
const register = async () => { expect((await api("/api/push", "PUT", { provider: "fcm", token: oldToken })).status).toBe(200); expect((await api("/api/notifications", "PUT", { enabled: true })).status).toBe(200); return binding(); };
const rotate = (revision: string | null, token = newToken) => api("/api/push", "PATCH", { provider: "fcm", token, expectedRevision: revision });
const saved = async () => JSON.parse((await hub.store.db.get<{ push_json: string }>("SELECT push_json FROM devices WHERE id='phone'"))!.push_json);

test("rotation uses a token-free binding receipt and does not change notification preferences", async () => {
  expect(await binding()).toEqual({ provider: null, revision: null, enabled: false, subscribed: false });
  const first = await register(); expect(JSON.stringify(first)).not.toContain(oldToken);
  const response = await rotate(first.revision); expect(response.status).toBe(200);
  const next = await binding(); expect(next.revision).not.toBe(first.revision); expect(next).toMatchObject({ provider: "fcm", enabled: true });
  expect(await saved()).toEqual({ provider: "fcm", token: newToken });
  const unchanged = await rotate(next.revision); expect(unchanged.status).toBe(200); expect(await binding()).toEqual(next);
  expect(JSON.stringify(await hub.store.db.all("SELECT * FROM audit_log"))).not.toContain(newToken);
});
test.each(["delete", "replace", "disable", "same-put", "disable-enable"])("a pending token refresh cannot undo %s", async (change) => {
  const first = await register();
  if (change === "delete") await api("/api/push", "DELETE");
  if (change === "replace") await api("/api/push", "PUT", { provider: "unifiedpush", endpoint: "https://ntfy.example.test/abcdefghijklmnop" });
  if (change === "disable" || change === "disable-enable") await api("/api/notifications", "PUT", { enabled: false });
  if (change === "disable-enable") await api("/api/notifications", "PUT", { enabled: true });
  if (change === "same-put") await api("/api/push", "PUT", { provider: "fcm", token: oldToken });
  const before = await saved(); expect((await rotate(first.revision)).status).toBe(409); expect(await saved()).toEqual(before);
});
test("only one of two rotations using the same revision can win", async () => {
  const first = await register();
  const results = await Promise.all([rotate(first.revision, newToken), rotate(first.revision, "other_token_" + "c".repeat(40))]);
  expect(results.map(r => r.status).sort()).toEqual([200,409]);
});
test("a provider's gone response retains consent to refresh but DELETE removes it", async () => {
  const first = await register();
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
  const conversation = await hub.store.createConversation("owner", ["bot"], "Chat", "chat");
  await hub.store.publishBotMessage("bot", { conversationId: conversation.id, blocks: [{ type: "text", text: "reminder" }] });
  const worker = new PushWorker(hub.store, async () => "gone", () => false, () => Date.now() + 2000);
  await worker.tick(); await worker.stop(); expect(await saved()).toBeNull();
  expect(await binding()).toEqual({ ...first, subscribed: false }); expect((await rotate(first.revision)).status).toBe(200);
  expect(await saved()).toEqual({ provider: "fcm", token: newToken });
  await api("/api/push", "DELETE"); expect(await binding()).toEqual({ provider: null, revision: null, enabled: true, subscribed: false });
});
test("revoked devices cannot inspect or rotate bindings", async () => {
  const first = await register(); await hub.auth.revoke("phone", "local-owner");
  expect((await api("/api/push")).status).toBe(401); expect((await rotate(first.revision)).status).toBe(401); expect(await saved()).toBeNull();
});

test("late provider rejection cannot clear an explicit re-registration of the same token", async () => {
  await register();
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
  const conversation = await hub.store.createConversation("owner", ["bot"], "Chat", "chat");
  await hub.store.publishBotMessage("bot", { conversationId: conversation.id, blocks: [{ type: "text", text: "reminder" }] });
  let sent!: () => void, release!: (value: "gone") => void;
  const started = new Promise<void>(resolve => { sent = resolve; });
  const worker = new PushWorker(hub.store, () => { sent(); return new Promise(resolve => { release = resolve; }); }, () => false, () => Date.now() + 2000);
  const tick = worker.tick(); await started;
  expect((await api("/api/push", "PUT", { provider: "fcm", token: oldToken })).status).toBe(200);
  release("gone"); await tick; await worker.stop(); expect(await saved()).toEqual({ provider: "fcm", token: oldToken });
});
test("schema 11 migration retains existing consent and schema 12 reopen preserves its revision", async () => {
  await register();
  await hub.store.db.exec("DELETE FROM push_bindings; UPDATE meta SET value='11' WHERE key='schema_version'");
  await hub.close(); hub = await HubServer.start({ stateDir: root });
  const row = await hub.store.db.get("SELECT * FROM push_bindings WHERE device_id='phone'");
  expect(row).toMatchObject({ device_id: "phone", provider: "fcm", revision: expect.any(String) });
  expect(await saved()).toEqual({ provider: "fcm", token: oldToken });
  await hub.close(); hub = await HubServer.start({ stateDir: root });
  expect(await hub.store.db.get("SELECT * FROM push_bindings WHERE device_id='phone'")).toEqual(row);
});

test.each([null, "not-json", JSON.stringify({provider:"apns",token:"a".repeat(64)}), JSON.stringify({provider:"fcm",token:"short"})])("binding readiness rejects missing, invalid and mismatched stored subscriptions: %s", async (raw) => {
  await register(); await hub.store.db.run("UPDATE devices SET push_json=? WHERE id='phone'", [raw]);
  expect(await binding()).toMatchObject({ provider: "fcm", enabled: true, subscribed: false });
});
