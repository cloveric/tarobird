import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { PI_SESSION_CAPABILITY } from "../src/client-protocol/pi-session.js";
import { bootstrapTrusted } from "./helpers/pairing-invite.js";
import { GatewayTransport } from "../src/gateway/transport.js";
import { gatewayPiSession } from "../src/gateway/pi-session.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { Bridge, type AccessStoreLike } from "../src/runtime/bridge.js";
import type { PiNativeState } from "../src/codex/pi-native-types.js";

type Frame = Record<string, any>;
class Peer {
  frames: Frame[] = [];
  constructor(readonly ws: WebSocket) { ws.on("message", raw => { const frame = JSON.parse(raw.toString()); this.frames.push(frame); if (frame.type === "snapshot.message") this.send({ type: "snapshot.ack", id: frame.id, count: Number(frame.index) + 1 }); }); }
  static async connect(url: string) { const peer = new Peer(new WebSocket(url)); await new Promise<void>((resolve, reject) => { peer.ws.once("open", resolve); peer.ws.once("error", reject); }); return peer; }
  send(frame: object) { this.ws.send(JSON.stringify({ v: 1, ...frame })); }
  async next(type: string) { const until = Date.now() + 5000; for (;;) { const index = this.frames.findIndex(frame => frame.type === type); if (index >= 0) return this.frames.splice(index, 1)[0]!; if (Date.now() > until) throw new Error(`Missing ${type}`); await new Promise(resolve => setTimeout(resolve, 5)); } }
}

describe("Pi session HTTP authorization and capability boundary", () => {
  let dir: string, hub: HubServer, headers: Record<string, string>, chatId: string, secret: string;
  const sockets: WebSocket[] = [];
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "hub-pi-session-")); hub = await HubServer.start({ stateDir: dir });
    secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('pi_bot','Pi',?,'pi')", [hashSecret(secret)]);
    chatId = (await hub.store.createConversation("owner", ["pi_bot"], "Pi", "direct")).id;
    const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    await bootstrapTrusted(hub.auth, { deviceId: "device", name: "Test device", platform: "web", publicKey });
    const peer = await Peer.connect(hub.url.replace("http", "ws") + "/ws"); sockets.push(peer.ws);
    const nonce = randomBytes(32).toString("base64url"); peer.send({ type: "hello", deviceId: "device", nonce, protocolVersions: [1], capabilities: [], cursors: {} });
    const challenge = await peer.next("challenge"); peer.send({ type: "auth", signature: sign(null, deviceProof("device", challenge.nonce, nonce), keys.privateKey).toString("base64") });
    const ready = await peer.next("ready"); await peer.next("sync.complete"); headers = { Authorization: `Bearer ${ready.sessionToken}` };
  });
  afterEach(async () => { sockets.splice(0).forEach(socket => socket.terminate()); await hub.close(); await rm(dir, { recursive: true, force: true }); });
  const url = () => `${hub.url}/api/conversations/${chatId}/pi-session?botId=pi_bot`;
  async function bot(capabilities: string[] = [PI_SESSION_CAPABILITY]) {
    const peer = await Peer.connect(hub.instanceUrl.replace("http", "ws") + "/instance"); sockets.push(peer.ws);
    peer.send({ type: "instance.hello", botId: "pi_bot", secret, engine: "pi", model: "", effort: "", capabilities }); await peer.next("instance.ready"); return peer;
  }
  it("round-trips HTTP controls through real GatewayTransport and owner authorization before Bridge", async () => {
    const stateDir = path.join(dir, "gateway");
    const transport = new GatewayTransport({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "pi_bot", secret, engine: "pi" });
    let state: PiNativeState = { sessionId: "native", model: { provider: "provider", modelId: "one", name: "One", reasoning: true, input: ["text"], contextWindow: 1000 }, modelSource: "session", thinkingLevel: "high", availableThinkingLevels: ["off", "high"], isStreaming: true, isCompacting: false, steeringMode: "all", followUpMode: "all", autoCompactionEnabled: true, pending: { steering: [], followUp: [] }, bridge: "connected", ui: { status: {}, widgets: {} } };
    const live = { token: "exact_worker", isCurrent: () => true, getState: async () => state, listModels: async () => [{ provider: "provider", id: "one", name: "One", reasoning: true }], setModel: vi.fn(async (model: { provider: string; modelId: string } | null, options: { isCurrent: () => Promise<boolean> }) => { expect(await options.isCurrent()).toBe(true); state = { ...state, model: { ...state.model!, ...model } }; return state; }), setThinkingLevel: vi.fn(async () => state) };
    const controls = { getState: vi.fn(), getLiveSession: () => live };
    const bridge = new Bridge({ load: vi.fn(), issuePairingCode: vi.fn() } as AccessStoreLike, { getOrCreateSession: vi.fn(), bindSession: vi.fn(), getExistingSession: vi.fn(async () => ({ sessionId: "native" })) }, { createSession: vi.fn(), sendUserMessage: vi.fn(), piNative: controls } as any);
    const channel = { transport, canSteerConversation: async (id: string) => id === chatId } as unknown as GatewayChannel;
    transport.onCall = gatewayPiSession(bridge, channel, stateDir, "pi_bot");
    let attached!: () => void; const ready = new Promise<void>(resolve => { attached = resolve; }); transport.onBoot = async () => attached();
    try {
      await transport.connect(); await ready;
      const snapshot = await (await fetch(url(), { headers })).json();
      expect(snapshot.session?.model).toBe("provider/one");
      const change = { botId: "pi_bot", requestId: "change", expectedSession: snapshot.session.token, action: "model", value: "provider/two" };
      expect(await (await fetch(url(), { method: "POST", headers, body: JSON.stringify(change) })).json()).toEqual({ outcome: "accepted" });
      expect(live.setModel).toHaveBeenCalledTimes(1);
      expect(controls.getState).not.toHaveBeenCalled();
      expect((await (await fetch(url(), { headers })).json()).session?.model).toBe("provider/two");
      expect(await transport.requestLive("pi.session.authorize", { conversationId: chatId, userId: "owner" })).toEqual({ allowed: true });
      await hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
      await expect(transport.requestLive("pi.session.authorize", { conversationId: chatId, userId: "owner" })).rejects.toThrow("owner_required");
      expect(await readdir(stateDir)).not.toContain("gateway-outbox.json");
    } finally { await transport.disconnect(); }
  });
  it("returns unsupported for an old worker and a group, without starting a session", async () => {
    const worker = await bot([]);
    expect(await (await fetch(url(), { headers })).json()).toEqual({ supported: false });
    await hub.store.db.run("UPDATE conversations SET type='group' WHERE id=?", [chatId]);
    expect(await (await fetch(url(), { headers })).json()).toEqual({ supported: false });
    expect(worker.frames.some(frame => frame.type === "instance.call")).toBe(false);
  });
  it("requires owner, membership, Bot membership and managed Bot ownership", async () => {
    await bot();
    await hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
    expect((await fetch(url(), { headers })).status).toBe(403);
    await hub.store.db.run("UPDATE users SET role='owner' WHERE id='owner'");
    await hub.store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='user' AND member_id='owner'", [chatId]);
    expect((await fetch(url(), { headers })).status).toBe(403);
    await hub.store.db.run("INSERT INTO conversation_members(conversation_id,member_type,member_id) VALUES(?,'user','owner')", [chatId]);
    await hub.store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='bot' AND member_id='pi_bot'", [chatId]);
    expect((await fetch(url(), { headers })).status).toBe(403);
    await hub.store.db.run("INSERT INTO conversation_members(conversation_id,member_type,member_id) VALUES(?,'bot','pi_bot')", [chatId]);
    await hub.store.db.run("INSERT INTO users(id,name,role) VALUES('other','Other','owner')");
    await hub.store.db.run("INSERT INTO managed_bots(bot_id,owner_id,request_id,specification_json) VALUES('pi_bot','other','create','{}')");
    expect((await fetch(url(), { headers })).status).toBe(403);
  });
  it("routes snapshots with explicit identity and discards details after access changes", async () => {
    const worker = await bot(); const pending = fetch(url(), { headers });
    const call = await worker.next("instance.call"); expect(call.method).toBe("pi.session.get"); expect(call.params).toEqual({ botId: "pi_bot", conversationId: chatId, userId: "owner" });
    await hub.store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='user' AND member_id='owner'", [chatId]);
    worker.send({ type: "instance.result", id: call.id, result: { supported: true } });
    expect((await pending).status).toBe(403);
  });
  it("returns unknown when a mutation loses its worker reply, without replaying it", async () => {
    const worker = await bot();
    const pending = fetch(url(), { method: "POST", headers, body: JSON.stringify({ botId: "pi_bot", requestId: "change", expectedSession: "opaque", action: "model", value: "provider/model" }) });
    const call = await worker.next("instance.call"); expect(call.method).toBe("pi.session.set"); worker.ws.terminate();
    expect(await (await pending).json()).toEqual({ outcome: "unknown", reason: "uncertain" });
  });
  it("refuses hidden worker and Superagent conversations", async () => {
    const worker = await bot();
    for (const role of ["worker", "dispatcher"]) {
      await hub.store.db.run("UPDATE bots SET role=? WHERE id='pi_bot'", [role]);
      expect(await (await fetch(url(), { headers })).json()).toEqual({ supported: false });
    }
    expect(worker.frames.some(frame => frame.type === "instance.call")).toBe(false);
  });
});
