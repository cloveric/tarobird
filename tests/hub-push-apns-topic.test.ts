import { EventEmitter } from "node:events";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Simulated APNs: a token belongs to exactly one App topic. No network access.
const apns = vi.hoisted(() => ({ tokenTopics: new Map<string, string>(), requests: [] as { topic: string; token: string }[], bodies: [] as { aps: { alert: { title: string } }; title: string }[], reason: "DeviceTokenNotForTopic" }));
vi.mock("node:http2", async (original) => ({
  ...await original<typeof import("node:http2")>(),
  connect: () => {
    const session = Object.assign(new EventEmitter(), { setTimeout() {}, destroy() {} });
    return Object.assign(session, { request(headers: Record<string, string>) {
      const stream = new EventEmitter();
      return Object.assign(stream, { end(body: string) {
        apns.bodies.push(JSON.parse(body));
        const token = headers[":path"]!.split("/").pop()!, topic = headers["apns-topic"]!;
        apns.requests.push({ topic, token });
        const ok = apns.tokenTopics.get(token) === topic;
        setImmediate(() => {
          stream.emit("response", { ":status": ok ? 200 : 400 });
          if (!ok) stream.emit("data", Buffer.from(JSON.stringify({ reason: apns.tokenTopics.has(token) ? apns.reason : "BadDeviceToken" })));
          stream.emit("end");
        });
      } });
    } });
  },
}));

const { createPushSender } = await import("../src/hub/push/providers.js");
const { PushWorker } = await import("../src/hub/push/worker.js");
const { HubServer } = await import("../src/hub/server.js");
const { HubStore } = await import("../src/hub/store.js");
const { deviceProof } = await import("../src/hub/auth.js");

const LEGACY = "com.tarocub.client", CURRENT = "com.tarobot.client";
const legacyToken = "a".repeat(64), currentToken = "b".repeat(64);
const payload = { id: "msg_topic000001", title: "TaroCub" as const, body: "x", conversationId: "conv_topic00001", messageId: "msg_topic000001", kind: "answer" as const, at: Date.now() };
let root: string, keyFile: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "apns-topic-"));
  keyFile = path.join(root, "AuthKey.p8");
  await writeFile(keyFile, generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }));
  apns.tokenTopics = new Map([[legacyToken, LEGACY], [currentToken, CURRENT]]); apns.requests = []; apns.bodies = []; apns.reason = "DeviceTokenNotForTopic";
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const apnsConfig = (extra: Record<string, unknown> = {}) => ({ apns: { teamId: "ABCDE12345", keyId: "KEY1234567", keyFile, topic: LEGACY, sandbox: false, ...extra } });

test("legacy topic-less subscriptions keep the configured topic; allowed client topics route per subscription", async () => {
  const send = createPushSender(apnsConfig({ topics: [CURRENT] }) as never);
  expect(await send({ provider: "apns", token: legacyToken }, payload)).toBe("sent");
  expect(await send({ provider: "apns", token: currentToken, topic: CURRENT } as never, payload)).toBe("sent");
  expect(apns.requests).toEqual([{ topic: LEGACY, token: legacyToken }, { topic: CURRENT, token: currentToken }]);
});

test("a topic removed from the Host allowlist is not sent under another topic and is not treated as gone", async () => {
  const send = createPushSender(apnsConfig() as never);
  expect(await send({ provider: "apns", token: currentToken, topic: CURRENT } as never, payload)).toBe("unconfigured");
  expect(apns.requests).toEqual([]);
});

test("DeviceTokenNotForTopic is a routing mismatch, never a dead token; BadDeviceToken remains gone", async () => {
  const send = createPushSender(apnsConfig() as never);
  // Registered before topic routing: the new App's token under the old default topic.
  expect(await send({ provider: "apns", token: currentToken }, payload)).toBe("rejected");
  expect(await send({ provider: "apns", token: "c".repeat(64) }, payload)).toBe("gone");
});

test("the worker retains a valid subscription after a topic mismatch", async () => {
  // A bare store: the Hub's own background worker must not race this tick.
  const store = await HubStore.open(path.join(root, "store"));
  try {
    const now = Date.now() + 2000;
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    const conversation = await store.createConversation("owner", ["bot"], "Chat", "chat");
    const push = JSON.stringify({ provider: "apns", token: currentToken });
    await store.db.run("INSERT INTO devices VALUES('phone','owner','Phone','ios','unused-public-key',0,?,?,?)", [now, now, push]);
    await store.db.run("INSERT INTO device_preferences VALUES('phone',?)", [JSON.stringify({ enabled: true, quietStart: "", quietEnd: "", timeZone: "UTC" })]);
    await store.db.run("INSERT INTO push_bindings VALUES('phone','apns','revision-1')");
    await store.publishBotMessage("bot", { conversationId: conversation.id, blocks: [{ type: "text", text: "reminder" }] });
    const worker = new PushWorker(store, createPushSender(apnsConfig() as never), () => false, () => now);
    await worker.tick(); await worker.stop();
    expect(apns.requests).toEqual([{ topic: LEGACY, token: currentToken }]);
    expect((await store.db.get<{ push_json: string | null }>("SELECT push_json FROM devices WHERE id='phone'"))?.push_json).toBe(push);
    expect((await store.db.all<{ status: string }>("SELECT status FROM push_outbox")).map(row => row.status)).toEqual(["failed"]);
  } finally { await store.db.close(); }
});

async function pairedHub(push: Record<string, unknown>) {
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), push: push as never });
  const keys = generateKeyPairSync("ed25519"), nonce = randomBytes(32).toString("base64url");
  const pair = await hub.auth.pair({ deviceId: "phone", name: "Phone", platform: "ios", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, "local");
  await hub.auth.approve(pair.code, "local-owner"); const challenge = await hub.auth.challenge("phone", "phone", nonce, "local");
  const auth = (await hub.auth.authenticate("phone", sign(null, deviceProof("phone", challenge.nonce, nonce), keys.privateKey).toString("base64"))).token;
  const api = (route: string, method = "GET", body?: unknown) => fetch(hub.url + route, { method, headers: { Authorization: `Bearer ${auth}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const saved = async () => JSON.parse((await hub.store.db.get<{ push_json: string | null }>("SELECT push_json FROM devices WHERE id='phone'"))?.push_json ?? "null");
  return { hub, api, saved };
}

test("the Hub advertises its APNs topic allowlist and enforces it at registration and rotation", async () => {
  const { hub, api, saved } = await pairedHub(apnsConfig({ topics: [CURRENT, LEGACY] }));
  try {
    expect((await (await api("/api/notifications")).json()).apnsTopics).toEqual([LEGACY, CURRENT]);
    expect((await api("/api/push", "PUT", { provider: "apns", token: currentToken, topic: "com.example.other" })).status).toBe(400);
    expect(await saved()).toBeNull();
    expect((await api("/api/push", "PUT", { provider: "apns", token: currentToken, topic: CURRENT })).status).toBe(200);
    expect(await saved()).toEqual({ provider: "apns", token: currentToken, topic: CURRENT });
    expect((await api("/api/notifications", "PUT", { enabled: true, quietStart: "", quietEnd: "", timeZone: "UTC" })).status).toBe(200);
    const binding = await (await api("/api/push")).json() as { revision: string; subscribed: boolean };
    expect(binding.subscribed).toBe(true);
    const rotated = "d".repeat(64);
    expect((await api("/api/push", "PATCH", { provider: "apns", token: rotated, topic: "com.example.other", expectedRevision: binding.revision })).status).toBe(400);
    expect(await saved()).toEqual({ provider: "apns", token: currentToken, topic: CURRENT });
    expect((await api("/api/push", "PATCH", { provider: "apns", token: rotated, topic: CURRENT, expectedRevision: binding.revision })).status).toBe(200);
    expect(await saved()).toEqual({ provider: "apns", token: rotated, topic: CURRENT });
    // Older clients never send a topic; their subscription keeps the default route.
    expect((await api("/api/push", "PUT", { provider: "apns", token: legacyToken })).status).toBe(200);
    expect(await saved()).toEqual({ provider: "apns", token: legacyToken });
  } finally { await hub.close(); }
});

test("a Hub without APNs advertises no topics and rejects an explicit APNs topic", async () => {
  const { hub, api, saved } = await pairedHub({});
  try {
    expect((await (await api("/api/notifications")).json()).apnsTopics).toBeUndefined();
    expect((await api("/api/push", "PUT", { provider: "apns", token: currentToken, topic: CURRENT })).status).toBe(400);
    expect(await saved()).toBeNull();
  } finally { await hub.close(); }
});

test("TaroBird is the visible APNs title while legacy payload and device topics stay compatible", async () => {
  const send = createPushSender(apnsConfig({ topics: [CURRENT] }) as never);
  expect(await send({ provider: "apns", token: currentToken, topic: CURRENT } as never, payload)).toBe("sent");
  expect(apns.bodies[0]!.aps.alert.title).toBe("TaroBird");
  expect(apns.bodies[0]!.title).toBe("TaroCub");
  expect(apns.requests).toEqual([{ topic: CURRENT, token: currentToken }]);
});
