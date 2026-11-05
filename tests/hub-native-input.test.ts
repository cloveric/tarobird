// Reproduced by the independent Opus review; these assertions cover the fixes.
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { NATIVE_INPUT_CAPABILITY } from "../src/client-protocol/native-input.js";
import { bootstrapTrusted, postPairing } from "./helpers/pairing-invite.js";

type Frame = Record<string, any>;
class Peer {
  frames: Frame[] = [];
  constructor(readonly ws: WebSocket) { ws.on("message", raw => { const f = JSON.parse(raw.toString()); this.frames.push(f); if (f.type === "snapshot.message") this.send({ type: "snapshot.ack", id: f.id, count: Number(f.index) + 1 }); }); }
  static async connect(url: string) { const p = new Peer(new WebSocket(url)); await new Promise<void>((r, j) => { p.ws.once("open", r); p.ws.once("error", j); }); return p; }
  send(frame: object) { this.ws.send(JSON.stringify({ v: 1, ...frame })); }
  async next(type: string, pred: (f: Frame) => boolean = () => true) { const until = Date.now() + 5000; for (;;) { const i = this.frames.findIndex(f => f.type === type && pred(f)); if (i >= 0) return this.frames.splice(i, 1)[0]!; if (Date.now() > until) throw new Error("Missing " + type); await new Promise(r => setTimeout(r, 5)); } }
}

describe("Native input HTTP uncertainty and capability downgrade", () => {
  let dir: string, hub: HubServer; const sockets: WebSocket[] = [];
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "r3-")); hub = await HubServer.start({ stateDir: dir }); });
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
  async function bot(secret: string, capabilities: string[]) {
    const peer = await Peer.connect(hub.instanceUrl.replace("http", "ws") + "/instance"); sockets.push(peer.ws);
    peer.send({ type: "instance.hello", botId: "alpha", secret, engine: "claude", model: "", effort: "", capabilities }); await peer.next("instance.ready");
    return peer;
  }

  it("retains uncertainty when a cancel receipt cannot be checked after disconnect or downgrade", async () => {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','alpha',?)", [hashSecret(secret)]);
    const chat = await hub.store.createConversation("owner", ["alpha"], "Native", "direct");
    let worker = await bot(secret, [NATIVE_INPUT_CAPABILITY]);
    const headers = await user();
    const sending = fetch(`${hub.url}/api/conversations/${chat.id}/steer`, { method: "POST", headers, body: JSON.stringify({ botId: "alpha", requestId: "in_1", targetId: "t_1", text: "A", mode: "message" }) });
    const steer = await worker.next("instance.call", f => f.method === "steer");
    worker.send({ type: "instance.result", id: steer.id, result: { outcome: "accepted" } });
    const message = await (await sending).json() as { id: string };

    const route = `${hub.url}/api/conversations/${chat.id}/inputs/${message.id}`, body = JSON.stringify({ requestId: "ctl_1", action: "cancel" });
    const first = fetch(route, { method: "POST", headers, body });
    await worker.next("instance.call", f => f.method === "input.control");
    // The worker may already have run cancel_async_message (cancelled:true) when it dies.
    worker.ws.terminate();
    expect(await (await first).json()).toEqual({ outcome: "unknown", reason: "uncertain" });

    // Same requestId check while the worker is offline:
    expect(await (await fetch(route, { method: "POST", headers, body })).json()).toEqual({ outcome: "unknown", reason: "uncertain" });

    // Same check while an older (downgraded) worker without the capability is connected:
    worker = await bot(secret, []);
    expect(await (await fetch(route, { method: "POST", headers, body })).json()).toEqual({ outcome: "unknown", reason: "uncertain" });
    expect(worker.frames.some(f => f.type === "instance.call" && f.method === "input.control")).toBe(false);
  });

  it("rejects a fresh native send before delivery when capability disappeared, allowing the durable fallback", async () => {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','alpha',?)", [hashSecret(secret)]);
    const chat = await hub.store.createConversation("owner", ["alpha"], "Native", "direct");
    const worker = await bot(secret, []); // downgraded between status and POST
    const headers = await user();
    const reply = await (await fetch(`${hub.url}/api/conversations/${chat.id}/steer`, { method: "POST", headers, body: JSON.stringify({ botId: "alpha", requestId: "in_new", targetId: "t_1", text: "B", mode: "message" }) })).json() as any;
    expect(reply.blocks.find((b: any) => b.type === "steering")).toMatchObject({ outcome: "rejected", reason: "unsupported", mode: "message" });
    expect(worker.frames.some(f => f.type === "instance.call" && f.method === "steer")).toBe(false);
  });

  // NI-2: a worker restart can lose the adapter's final engine_exit report.
  // run.recover carries the worker's stable attach time, never a socket time.
  async function admitted(chatId: string, worker: Peer, headers: Record<string, string>, requestId: string, progress?: { state: string; reason?: string }) {
    const sending = fetch(`${hub.url}/api/conversations/${chatId}/steer`, { method: "POST", headers, body: JSON.stringify({ botId: "alpha", requestId, targetId: "t_1", text: requestId, mode: "message" }) });
    const steer = await worker.next("instance.call", f => f.method === "steer" && f.params.requestId === requestId);
    worker.send({ type: "instance.result", id: steer.id, result: { outcome: "accepted" } });
    const message = await (await sending).json() as { id: string };
    if (progress) await request(worker, "input.progress", { conversationId: chatId, userId: "owner", requestId, targetId: "t_1", progress });
    return message.id;
  }
  async function request(worker: Peer, method: string, params: unknown) {
    const id = `req_${randomBytes(6).toString("hex")}`;
    worker.send({ type: "instance.request", id, method, params });
    const result = await worker.next("instance.result", f => f.id === id);
    if (result.error) throw new Error(result.error);
    return result.result;
  }
  const native = async (chatId: string, id: string) => (await hub.store.snapshot("owner", chatId)).messages.find(m => m.id === id)!.blocks.find(b => b.type === "steering") as any;

  it("keeps queued inputs operable across a socket reconnect of the same worker", async () => {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','alpha',?)", [hashSecret(secret)]);
    const chat = await hub.store.createConversation("owner", ["alpha"], "Native", "direct");
    const attachedAt = Date.now() - 1;
    let worker = await bot(secret, [NATIVE_INPUT_CAPABILITY]);
    const headers = await user();
    const queued = await admitted(chat.id, worker, headers, "same_q", { state: "queued" });
    const plain = await admitted(chat.id, worker, headers, "same_plain");
    worker.ws.terminate();
    worker = await bot(secret, [NATIVE_INPUT_CAPABILITY]);
    // The same process re-attaches and recovers with its original attach time.
    await request(worker, "run.recover", { before: attachedAt });
    expect((await native(chat.id, queued)).nativeInput).toEqual({ state: "queued" });
    expect((await native(chat.id, plain)).nativeInput).toBeUndefined();
    expect((await native(chat.id, queued)).outcome).toBe("accepted");
  });

  it("retires queued, dequeued and unreported inputs of a replaced worker without downgrading receipts", async () => {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','alpha',?)", [hashSecret(secret)]);
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('beta','beta',?)", [hashSecret("unused")]);
    const chat = await hub.store.createConversation("owner", ["alpha"], "Native", "direct");
    let worker = await bot(secret, [NATIVE_INPUT_CAPABILITY]);
    const headers = await user();
    const ids = {
      queued: await admitted(chat.id, worker, headers, "old_q", { state: "queued" }),
      dequeued: await admitted(chat.id, worker, headers, "old_d", { state: "dequeued" }),
      unreported: await admitted(chat.id, worker, headers, "old_none"),
      received: await admitted(chat.id, worker, headers, "old_r", { state: "received" }),
      cancelled: await admitted(chat.id, worker, headers, "old_c", { state: "cancelled", reason: "retracted" }),
      dropped: await admitted(chat.id, worker, headers, "old_x", { state: "dropped", reason: "stopped" }),
      ended: await admitted(chat.id, worker, headers, "old_e", { state: "unknown", reason: "ended_without_model_receipt" }),
    };
    const updates: any[] = [];
    const unsubscribe = hub.store.subscribe(event => { if (event.kind === "message.updated") updates.push(event.payload); });
    worker.ws.terminate();
    await new Promise(r => setTimeout(r, 5));
    // A new worker process attaches after every input above was admitted.
    worker = await bot(secret, [NATIVE_INPUT_CAPABILITY]);
    await request(worker, "run.recover", { before: Date.now() });
    unsubscribe();
    for (const key of ["queued", "dequeued", "unreported"] as const) expect((await native(chat.id, ids[key])).nativeInput, key).toEqual({ state: "unknown", reason: "engine_exit" });
    expect((await native(chat.id, ids.received)).nativeInput).toEqual({ state: "received" });
    expect((await native(chat.id, ids.cancelled)).nativeInput).toEqual({ state: "cancelled", reason: "retracted" });
    expect((await native(chat.id, ids.dropped)).nativeInput).toEqual({ state: "dropped", reason: "stopped" });
    expect((await native(chat.id, ids.ended)).nativeInput).toEqual({ state: "unknown", reason: "ended_without_model_receipt" });
    // Clients receive the retirement through the ordinary message.updated broadcast.
    expect(updates.map(m => m.id).sort()).toEqual([ids.queued, ids.dequeued, ids.unreported].sort());
    expect(updates.every(m => m.blocks.find((b: any) => b.type === "steering").nativeInput.reason === "engine_exit")).toBe(true);
    // Inputs created after this worker attached are not retired by a later recover.
    const fresh = await admitted(chat.id, worker, headers, "new_q", { state: "queued" });
    await request(worker, "run.recover", { before: Date.now() - 60_000 });
    expect((await native(chat.id, fresh)).nativeInput).toEqual({ state: "queued" });
    // An old worker's replayed journal cannot resurrect a retired input, but a
    // late model receipt from that journal still upgrades it.
    await request(worker, "input.progress", { conversationId: chat.id, userId: "owner", requestId: "old_q", targetId: "t_1", progress: { state: "queued" } });
    expect((await native(chat.id, ids.queued)).nativeInput).toEqual({ state: "unknown", reason: "engine_exit" });
    await request(worker, "input.progress", { conversationId: chat.id, userId: "owner", requestId: "old_q", targetId: "t_1", progress: { state: "received" } });
    expect((await native(chat.id, ids.queued)).nativeInput).toEqual({ state: "received" });
  });

  it("does not retire another Bot's inputs, rejected sends or legacy steering", async () => {
    const secret = randomBytes(32).toString("base64url"), other = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','alpha',?)", [hashSecret(secret)]);
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('beta','beta',?)", [hashSecret(other)]);
    const chat = await hub.store.createConversation("owner", ["alpha"], "Native", "direct");
    const worker = await bot(secret, [NATIVE_INPUT_CAPABILITY]);
    const headers = await user();
    const queued = await admitted(chat.id, worker, headers, "alpha_q", { state: "queued" });
    const legacy = await hub.store.beginSteering("owner", { conversationId: chat.id, botId: "alpha", requestId: "legacy", targetId: "t_1", text: "legacy" });
    await hub.store.finishSteering(legacy.id, { outcome: "accepted" });
    const rejected = await hub.store.beginSteering("owner", { conversationId: chat.id, botId: "alpha", requestId: "rej", targetId: "t_1", text: "rej", mode: "message" });
    await hub.store.finishSteering(rejected.id, { outcome: "rejected", reason: "stale" });
    await hub.store.retireNativeInputs("beta", Date.now() + 1);
    expect((await native(chat.id, queued)).nativeInput).toEqual({ state: "queued" });
    await hub.store.retireNativeInputs("alpha", Date.now() + 1);
    expect((await native(chat.id, queued)).nativeInput).toEqual({ state: "unknown", reason: "engine_exit" });
    expect((await native(chat.id, legacy.id)).nativeInput).toBeUndefined();
    expect((await native(chat.id, rejected.id))).toMatchObject({ outcome: "rejected" });
    expect((await native(chat.id, rejected.id)).nativeInput).toBeUndefined();
  });
  // Reproduced independently by Root with a real Hub/HTTP/WebSocket and a
  // delayed close handshake: the old worker's steer was still pending at recover.
  // The replaced socket's answer never settles it; only a later receipt check,
  // answered from the new worker's durable receipt journal, is evidence.
  for (const check of ["rejected", "accepted"] as const) it(`retires a pre-cutoff pending input; a ${check} receipt check settles it on evidence`, async () => {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','alpha',?)", [hashSecret(secret)]);
    const chat = await hub.store.createConversation("owner", ["alpha"], "Native", "direct");
    const old = await bot(secret, [NATIVE_INPUT_CAPABILITY]);
    const headers = await user();
    const body = JSON.stringify({ botId: "alpha", requestId: "old_pending", targetId: "t_1", text: "A", mode: "message" });
    const sending = fetch(`${hub.url}/api/conversations/${chat.id}/steer`, { method: "POST", headers, body });
    await old.next("instance.call", f => f.method === "steer");
    const socket = (old.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;
    socket.pause();
    let replacement: Peer;
    try {
      const attachedAt = Date.now();
      replacement = await bot(secret, [NATIVE_INPUT_CAPABILITY]);
      await request(replacement, "run.recover", { before: attachedAt });
    } finally { socket.resume(); }
    const message = await (await sending).json() as { id: string };
    expect(await native(chat.id, message.id)).toMatchObject({ outcome: "unknown", nativeInput: { state: "unknown", reason: "engine_exit" } });
    // The old worker's replayed journal cannot re-queue it.
    await request(replacement!, "input.progress", { conversationId: chat.id, userId: "owner", requestId: "old_pending", targetId: "t_1", progress: { state: "queued" } });
    expect((await native(chat.id, message.id)).nativeInput).toEqual({ state: "unknown", reason: "engine_exit" });
    const checking = fetch(`${hub.url}/api/conversations/${chat.id}/steer`, { method: "POST", headers, body });
    const recheck = await replacement!.next("instance.call", f => f.method === "steer" && f.params.requestId === "old_pending");
    replacement!.send({ type: "instance.result", id: recheck.id, result: check === "accepted" ? { outcome: "accepted" } : { outcome: "rejected", reason: "stale" } });
    await (await checking).json();
    const settled = await native(chat.id, message.id);
    if (check === "rejected") {
      // A definite rejection means it never entered the CLI: show that, not an exit.
      expect(settled).toMatchObject({ outcome: "rejected", reason: "stale" }); expect(settled.nativeInput).toBeUndefined();
    } else {
      // Admission by the old process grants no controls in the new one; a real model receipt still upgrades it.
      expect(settled).toMatchObject({ outcome: "accepted", nativeInput: { state: "unknown", reason: "engine_exit" } });
      await request(replacement!, "input.progress", { conversationId: chat.id, userId: "owner", requestId: "old_pending", targetId: "t_1", progress: { state: "received" } });
      expect((await native(chat.id, message.id)).nativeInput).toEqual({ state: "received" });
    }
  });
});
