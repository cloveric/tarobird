import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { NATIVE_INPUT_CAPABILITY, NATIVE_REVIEW_INPUT_CAPABILITY } from "../src/client-protocol/native-input.js";
import { bootstrapTrusted, postPairing } from "./helpers/pairing-invite.js";

type Frame = Record<string, any>;
class Peer {
  frames: Frame[] = [];
  constructor(readonly ws: WebSocket) { ws.on("message", raw => { const f = JSON.parse(raw.toString()); this.frames.push(f); if (f.type === "snapshot.message") this.send({ type: "snapshot.ack", id: f.id, count: Number(f.index) + 1 }); }); }
  static async connect(url: string) { const p = new Peer(new WebSocket(url)); await new Promise<void>((r, j) => { p.ws.once("open", r); p.ws.once("error", j); }); return p; }
  send(frame: object) { this.ws.send(JSON.stringify({ v: 1, ...frame })); }
  async next(type: string, pred: (f: Frame) => boolean = () => true) { const until = Date.now() + 5000; for (;;) { const i = this.frames.findIndex(f => f.type === type && pred(f)); if (i >= 0) return this.frames.splice(i, 1)[0]!; if (Date.now() > until) throw new Error("Missing " + type); await new Promise(r => setTimeout(r, 5)); } }
}

describe("Hub negotiation of background-review input targets", () => {
  let dir: string, hub: HubServer; const sockets: WebSocket[] = [];
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "review-hub-")); hub = await HubServer.start({ stateDir: dir }); });
  afterEach(async () => { sockets.splice(0).forEach(s => s.terminate()); await hub.close(); await rm(dir, { recursive: true, force: true }); });
  async function user() {
    // No owner exists yet to issue an invite: bootstrap in-process, while the
    // public route keeps refusing a first registration without one.
    const device = { deviceId: "device", name: "t", platform: "web" as const, publicKey };
    expect(await postPairing(hub.url, device)).toEqual({ status: 403, body: { error: "pairing_invite_required" } });
    await bootstrapTrusted(hub.auth, device);
    const peer = await Peer.connect(hub.url.replace("http", "ws") + "/ws"); sockets.push(peer.ws);
    const nonce = randomBytes(32).toString("base64url");
    peer.send({ type: "hello", deviceId: "device", nonce, protocolVersions: [1], capabilities: ["cards.v1"], cursors: {} });
    const challenge = await peer.next("challenge");
    peer.send({ type: "auth", signature: sign(null, deviceProof("device", challenge.nonce, nonce), keys.privateKey).toString("base64") });
    const ready = await peer.next("ready"); await peer.next("sync.complete");
    return { Authorization: `Bearer ${ready.sessionToken}` };
  }
  async function setup(capabilities: string[]) {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','alpha',?)", [hashSecret(secret)]);
    const chat = await hub.store.createConversation("owner", ["alpha"], "Review", "direct");
    const worker = await Peer.connect(hub.instanceUrl.replace("http", "ws") + "/instance"); sockets.push(worker.ws);
    worker.send({ type: "instance.hello", botId: "alpha", secret, engine: "claude", model: "", effort: "", capabilities });
    const ready = await worker.next("instance.ready");
    return { chat, worker, ready, headers: await user() };
  }
  async function status(f: Awaited<ReturnType<typeof setup>>, query: string, result: object) {
    const reading = fetch(`${hub.url}/api/conversations/${f.chat.id}/steer?botId=alpha${query}`, { headers: f.headers });
    const call = await f.worker.next("instance.call", c => c.method === "steer.status");
    f.worker.send({ type: "instance.result", id: call.id, result });
    return { params: call.params, body: await (await reading).json() };
  }
  const review = { supported: true, targetId: "review_1", targetKind: "background-review", sendBehavior: "steer", nativeInput: { sendNow: false, cancel: true, modelReceipt: true } };

  it("asks only a review-capable worker, and only for a caller that opted in", async () => {
    const f = await setup([NATIVE_INPUT_CAPABILITY, NATIVE_REVIEW_INPUT_CAPABILITY]);
    expect(f.ready.capabilities).toContain(NATIVE_REVIEW_INPUT_CAPABILITY);
    const opted = await status(f, "&review=1", review);
    expect(opted.params).toEqual({ conversationId: f.chat.id, backgroundReview: true });
    expect(opted.body).toEqual(review);
    // An older App never asks; the worker then never offers a review target.
    expect((await status(f, "", { supported: true, reason: "idle" })).params).toEqual({ conversationId: f.chat.id });
  });

  it("never sends the opt-in to an older strict Gateway", async () => {
    const f = await setup([NATIVE_INPUT_CAPABILITY]);
    expect((await status(f, "&review=1", { supported: true, reason: "idle" })).params).toEqual({ conversationId: f.chat.id });
  });

  it("gives a review-capable worker the exact steering record and never queues it as a delivery", async () => {
    const f = await setup([NATIVE_INPUT_CAPABILITY, NATIVE_REVIEW_INPUT_CAPABILITY]);
    const sending = fetch(`${hub.url}/api/conversations/${f.chat.id}/steer`, { method: "POST", headers: f.headers, body: JSON.stringify({ botId: "alpha", requestId: "in_1", targetId: "review_1", text: "Also check B", mode: "message" }) });
    const call = await f.worker.next("instance.call", c => c.method === "steer");
    f.worker.send({ type: "instance.result", id: call.id, result: { outcome: "accepted" } });
    const message = await (await sending).json() as { id: string; blocks: Array<Record<string, unknown>> };
    expect(call.params).toEqual({ conversationId: f.chat.id, userId: "owner", requestId: "in_1", targetId: "review_1", text: "Also check B", mode: "message", messageId: message.id });
    expect(message.blocks).toContainEqual(expect.objectContaining({ type: "steering", targetId: "review_1", outcome: "accepted", mode: "message" }));
    expect(await hub.store.pendingForBot("alpha")).toEqual([]);
    // Explicit (legacy) steering keeps its exact previous call shape.
    const legacy = fetch(`${hub.url}/api/conversations/${f.chat.id}/steer`, { method: "POST", headers: f.headers, body: JSON.stringify({ botId: "alpha", requestId: "in_2", targetId: "run_1", text: "Steer" }) });
    const legacyCall = await f.worker.next("instance.call", c => c.method === "steer");
    f.worker.send({ type: "instance.result", id: legacyCall.id, result: { outcome: "accepted" } });
    await legacy;
    expect(legacyCall.params).not.toHaveProperty("messageId");
  });

  it("keeps the previous call shape for a worker without review support", async () => {
    const f = await setup([NATIVE_INPUT_CAPABILITY]);
    const sending = fetch(`${hub.url}/api/conversations/${f.chat.id}/steer`, { method: "POST", headers: f.headers, body: JSON.stringify({ botId: "alpha", requestId: "in_1", targetId: "run_1", text: "A", mode: "message" }) });
    const call = await f.worker.next("instance.call", c => c.method === "steer");
    f.worker.send({ type: "instance.result", id: call.id, result: { outcome: "accepted" } });
    await sending;
    expect(call.params).not.toHaveProperty("messageId");
  });
});
