import { generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type Json } from "../src/client-protocol/index.js";
import { nodeFrameReader } from "../src/client-protocol/fragments-node.js";
import { SWARM_TASKS_CAPABILITY } from "../src/client-protocol/engine-tasks.js";
import { AntigravityAcpAdapter } from "../src/codex/antigravity-acp-adapter.js";
import { gatewayEngineTasks } from "../src/gateway/engine-tasks.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
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

// Freeze the pre-fix Swarm v1 reader independently of the current wire schema.
const oldV1MemberState = z.enum(["working", "waiting", "killed", "done", "paused", "unknown"]);
const oldV1Task = legacyEngineTaskSchema.extend({
  role: z.string().min(1).max(64).optional(),
  swarmState: oldV1MemberState.optional(),
  model: z.string().min(1).max(160).optional(),
  helper: z.boolean().optional(),
});
const oldV1Member = z.object({
  name: z.string().min(1).max(128),
  role: z.string().min(1).max(64).optional(),
  helper: z.boolean().optional(),
  state: oldV1MemberState,
  model: z.string().min(1).max(160).optional(),
  latestActivity: z.string().max(2000).optional(),
  updatedAt: z.number().nonnegative().optional(),
}).strict();
const oldV1Post = z.object({
  id: z.string().min(1).max(128),
  author: z.string().min(1).max(128),
  mentions: z.array(z.string().min(1).max(128)).max(32).optional(),
  title: z.string().max(300).optional(),
  content: z.string().max(16_000),
  kind: z.string().max(64).optional(),
  createdAt: z.number().nonnegative(),
}).strict();
const oldV1Snapshot = legacyEngineTaskSnapshotSchema.extend({
  tasks: z.array(oldV1Task).max(128),
  swarm: z.object({
    active: z.boolean(),
    title: z.string().max(300).optional(),
    statusText: z.string().max(500).optional(),
    source: z.enum(["acp", "files", "merged"]),
    formatUnknown: z.boolean().optional(),
    members: z.array(oldV1Member).max(64),
    posts: z.array(oldV1Post).max(200),
    updatedAt: z.number().nonnegative(),
  }).strict().optional(),
});

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

describe("Hub and Gateway /tasks Swarm compatibility", () => {
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

  async function connectClient(capabilities = ["cards.v1"]) {
    await bootstrapTrusted(hub.auth, { deviceId: "device", name: "Test browser", platform: "web", publicKey });
    const peer = await Peer.connect(hub.url.replace("http", "ws") + "/ws");
    sockets.push(peer.ws);
    const clientNonce = randomBytes(32).toString("base64url");
    peer.send({ type: "hello", deviceId: "device", nonce: clientNonce, protocolVersions: [1], capabilities, cursors: {} });
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
  it("keeps a known failure readable by old Swarm v1 clients and pre-Swarm Hosts", async () => {
    const sessionId = "board-session";
    const brainDir = path.join(directory, "brain");
    const boardDir = path.join(brainDir, sessionId, ".system_generated", "swarm");
    await mkdir(boardDir, { recursive: true });
    await writeFile(path.join(boardDir, "members.json"), JSON.stringify({
      title: "Sample board",
      members: {
        reader: { role: "worker", phase: "FAILED", error: "Synthetic native diagnostic" },
        verifier: { role: "worker", phase: "COMPLETED" },
      },
    }));
    await writeFile(path.join(boardDir, "board.jsonl"), JSON.stringify({ agent: "verifier", text: "Sample board post" }));

    const adapter = new AntigravityAcpAdapter("agy", { brainDir, workspacePath: directory });
    try {
      const bridge = { handleAuthorizedMessage: async () => {}, listTasks: () => adapter.listTasks(sessionId) };
      const callGateway = (capabilities: string[], conversationId: string) => gatewayEngineTasks(bridge, {
        canSteerConversation: async () => true,
        transport: { capabilities },
      } as GatewayChannel, directory)("tasks.list", { conversationId });

      const secret = randomBytes(32).toString("base64url");
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", ["agy", "agy", hashSecret(secret)]);
      const chat = await hub.store.createConversation("owner", ["agy"], "Old v1 reader", "old_v1_reader");
      const bot = await Peer.connect(hub.instanceUrl.replace("http", "ws") + "/instance");
      sockets.push(bot.ws);
      bot.send({ type: "instance.hello", botId: "agy", secret, engine: "antigravity", model: "", effort: "", capabilities: ["conversations.tasks.v1"] });
      const ready = await bot.next("instance.ready");
      const { token } = await connectClient(["cards.v1", "conversations.tasks.swarm.v1"]);

      const payload = await callGateway(ready.capabilities as string[], chat.id);
      const req = fetch(`${hub.url}/api/conversations/${chat.id}/tasks?botId=agy&swarmTasks=1`, { headers: { Authorization: `Bearer ${token}` } });
      const call = await bot.next("instance.call");
      bot.send({ type: "instance.result", id: call.id, result: payload });
      const response = await req;
      expect(response.status).toBe(200);
      const snapshot = oldV1Snapshot.parse(await response.json());
      expect(snapshot.tasks).toMatchObject([{ label: "reader", status: "error" }, { label: "verifier", status: "done", swarmState: "done" }]);
      expect(snapshot.tasks[0]).not.toHaveProperty("swarmState");
      expect(snapshot.swarm).toMatchObject({
        active: false,
        members: [{ name: "reader", state: "unknown" }, { name: "verifier", state: "done" }],
        posts: [{ author: "verifier", content: "Sample board post" }],
      });
      expect(JSON.stringify(snapshot)).not.toContain("Synthetic native diagnostic");

      for (const capabilities of [["conversations.tasks.swarm.v1"], ["runs.v1"]]) {
        const oldHostResult = await callGateway(capabilities, chat.id);
        const reader = capabilities.includes("conversations.tasks.swarm.v1") ? oldV1Snapshot : legacyEngineTaskSnapshotSchema;
        expect(reader.parse(oldHostResult).tasks).toMatchObject([{ label: "reader", status: "error" }, { label: "verifier", status: "done" }]);
      }
    } finally {
      await adapter.destroy();
    }
  });
});
