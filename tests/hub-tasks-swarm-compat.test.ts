import { generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type Json } from "../src/client-protocol/index.js";
import { nodeFrameReader } from "../src/client-protocol/fragments-node.js";
import { SWARM_TASKS_CAPABILITY } from "../src/client-protocol/engine-tasks.js";
import { deviceProof, hashSecret, parsePublicKey, serverProof } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { bootstrapTrusted } from "./helpers/pairing-invite.js";

// Exact copy of 1.6.0 strict schemas to guarantee backwards compatibility with 1.6.0 Apps and CLI.
const legacyId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const legacyEngineTaskSchema = z.object({
  id: legacyId,
  label: z.string().min(1).max(500),
  kind: z.enum(["subagent", "shell", "unknown"]),
  mode: z.enum(["foreground", "background"]),
  status: z.enum(["running", "done", "error", "stopped", "unknown"]),
  canStop: z.boolean(),
  startedAt: z.number().nonnegative().optional(),
  updatedAt: z.number().nonnegative(),
  progress: z.string().max(2000).optional(),
  parentId: legacyId.optional(),
  owner: z.enum(["bound", "unattributed"]).optional(),
}).strict();
const legacyEngineTaskSnapshotSchema = z.object({
  supported: z.boolean(),
  tasks: z.array(legacyEngineTaskSchema).max(128),
  foregroundStopScope: z.enum(["foreground", "subagents", "all"]).optional(),
  recovery: z.object({ token: legacyId, reason: z.literal("stop_unconfirmed") }).strict().optional(),
}).strict();

type Frame = Record<string, Json>;

class Peer {
  frames: Frame[] = [];
  private reader = nodeFrameReader();

  constructor(readonly ws: WebSocket) {
    ws.on("message", (raw) => {
      const frame = this.reader.read(raw.toString()) as Frame | undefined;
      if (!frame) return;
      this.frames.push(frame);
      if (frame.type === "snapshot.message") {
        this.send({ type: "snapshot.ack", id: frame.id, count: Number(frame.index) + 1 });
      }
    });
  }

  static async connect(url: string) {
    const peer = new Peer(new WebSocket(url));
    await new Promise<void>((resolve, reject) => {
      peer.ws.once("open", resolve);
      peer.ws.once("error", reject);
    });
    return peer;
  }

  send(frame: object) {
    this.ws.send(JSON.stringify({ v: 1, ...frame }));
  }

  async next(type: string, predicate: (f: Frame) => boolean = () => true): Promise<Frame> {
    const until = Date.now() + 5_000;
    for (;;) {
      const index = this.frames.findIndex((f) => f.type === type && predicate(f));
      if (index >= 0) return this.frames.splice(index, 1)[0]!;
      if (Date.now() > until) throw new Error(`Missing ${type}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

describe("Hub /tasks 1.6.0 Swarm compatibility", () => {
  let directory: string;
  let hub: HubServer;
  const sockets: WebSocket[] = [];
  const keypair = generateKeyPairSync("ed25519");
  const publicKey = keypair.publicKey.export({ type: "spki", format: "der" }).toString("base64");

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "hub-swarm-tasks-"));
    hub = await HubServer.start({ stateDir: directory });
  });

  afterEach(async () => {
    sockets.splice(0).forEach((s) => s.terminate());
    await hub.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function connectClient() {
    await bootstrapTrusted(hub.auth, { deviceId: "device", name: "Test browser", platform: "web", publicKey });
    const peer = await Peer.connect(hub.url.replace("http", "ws") + "/ws");
    sockets.push(peer.ws);
    const clientNonce = randomBytes(32).toString("base64url");
    peer.send({ type: "hello", deviceId: "device", nonce: clientNonce, protocolVersions: [1], capabilities: ["cards.v1"], cursors: {} });
    const challenge = await peer.next("challenge");
    expect(verify(null, serverProof("device", challenge.nonce as string, clientNonce), parsePublicKey(hub.auth.publicKey), Buffer.from(challenge.signature as string, "base64"))).toBe(true);
    peer.send({ type: "auth", signature: sign(null, deviceProof("device", challenge.nonce as string, clientNonce), keypair.privateKey).toString("base64") });
    const ready = await peer.next("ready");
    await peer.next("sync.complete");
    return { token: ready.sessionToken as string, serverCapabilities: ready.serverCapabilities as string[] };
  }

  it("strips post-1.6.0 Swarm fields on /tasks unless caller opts in with swarmTasks=1", async () => {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", ["agy", "agy", hashSecret(secret)]);
    const chat = await hub.store.createConversation("owner", ["agy"], "Swarm Compat", "swarm_compat");
    const bot = await Peer.connect(hub.instanceUrl.replace("http", "ws") + "/instance");
    sockets.push(bot.ws);
    bot.send({ type: "instance.hello", botId: "agy", secret, engine: "antigravity", model: "", effort: "", capabilities: ["conversations.tasks.v1"] });
    const ready = await bot.next("instance.ready");
    expect(ready.capabilities).toContain(SWARM_TASKS_CAPABILITY);

    const { token, serverCapabilities } = await connectClient();
    expect(serverCapabilities).toContain(SWARM_TASKS_CAPABILITY);
    const headers = { Authorization: `Bearer ${token}` };

    const swarmPayload = {
      supported: true,
      foregroundStopScope: "all",
      tasks: [
        {
          id: "sw_abcdef0123456789", label: "auth-fix", kind: "subagent", mode: "background", status: "done",
          canStop: false, startedAt: 1700000000000, updatedAt: 1700000005000, progress: "Finished checks",
          owner: "bound", role: "worker", swarmState: "done", model: "gemini-4-neon",
        },
        {
          id: "sw_9999999999999999", label: "monitor", kind: "subagent", mode: "background", status: "done",
          canStop: false, updatedAt: 1700000005000, owner: "bound", role: "monitor", swarmState: "done", helper: true,
        },
      ],
      swarm: {
        active: false,
        title: "Past swarm on disk",
        source: "files",
        members: [{ name: "auth-fix", role: "worker", state: "done", model: "gemini-4-neon", updatedAt: 1700000005000 }],
        posts: [{ id: "p1", author: "auth-fix", content: "All tests green", createdAt: 1700000005000 }],
        updatedAt: 1700000005000,
      },
    };
    // Confirm the full payload WOULD fail strict 1.6.0 validation if not stripped.
    expect(legacyEngineTaskSnapshotSchema.safeParse(swarmPayload).success).toBe(false);

    const url = `${hub.url}/api/conversations/${chat.id}/tasks`;

    // 1.6.0 client (no swarmTasks=1): Hub MUST strip swarm, role, swarmState, model, helper.
    const legacyReq = fetch(`${url}?botId=agy`, { headers });
    const legacyCall = await bot.next("instance.call");
    bot.send({ type: "instance.result", id: legacyCall.id, result: swarmPayload });
    const legacyBody = await (await legacyReq).json();
    expect(legacyEngineTaskSnapshotSchema.parse(legacyBody)).toEqual({
      supported: true,
      foregroundStopScope: "all",
      tasks: [
        { id: "sw_abcdef0123456789", label: "auth-fix", kind: "subagent", mode: "background", status: "done", canStop: false, startedAt: 1700000000000, updatedAt: 1700000005000, progress: "Finished checks", owner: "bound" },
        { id: "sw_9999999999999999", label: "monitor", kind: "subagent", mode: "background", status: "done", canStop: false, updatedAt: 1700000005000, owner: "bound" },
      ],
    });

    // New client (swarmTasks=1): Hub returns full Swarm payload.
    const optInReq = fetch(`${url}?botId=agy&swarmTasks=1`, { headers });
    const optInCall = await bot.next("instance.call");
    bot.send({ type: "instance.result", id: optInCall.id, result: swarmPayload });
    expect(await (await optInReq).json()).toEqual(swarmPayload);
  });
});
