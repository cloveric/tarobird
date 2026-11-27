import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { HubServer } from "../src/hub/server.js";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { attachGateway } from "../src/gateway/service.js";
import { gatewaySideSessions } from "../src/gateway/side.js";
import { withChannelProfile } from "../src/gateway/platform-profile.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { buildCoreConversationKey, stableCoreNumericId } from "../src/core/message-normalizer.js";
import { handleCoreMessage } from "../src/core/message-handler.js";
import { handleCoreCardAction } from "../src/core/card-actions.js";
import { buildCoreCronExecutor } from "../src/core/cron.js";
import { redeliverRecoveredCoreObligations } from "../src/core/delivery-recovery.js";
import { handleLocalEngineCoreCommand } from "../src/core/shared/engine-commands.js";
import { HubWorkspaceDiff, type WorkspaceGitCommand } from "../src/hub/workspace-diff.js";
import { workspaceDisplayName } from "../src/client-protocol/saved-workspaces.js";
import { sideReplySchema } from "../src/client-protocol/side.js";
import { resolveDeliveryObligationsPath } from "../src/state/delivery-obligation-store.js";
import { SessionStore } from "../src/state/session-store.js";
import type { CoreBridgeLike } from "../src/core/types.js";
import type { EngineSideSession } from "../src/codex/adapter.js";
import type { GatewayChannel } from "../src/gateway/channel.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setupHub() {
  const root = await mkdtemp(path.join(os.tmpdir(), "saved-ws-"));
  roots.push(root);
  const hubDir = path.join(root, "hub");
  const botDir = path.join(root, "bot-state");
  const folderA = path.join(root, "project-alpha");
  const folderB = path.join(root, "project-beta");
  const folderC = path.join(root, "project-gamma");
  const nestedDir = path.join(folderA, "packages");
  await Promise.all([
    mkdir(hubDir, { recursive: true }),
    mkdir(botDir, { recursive: true }),
    mkdir(nestedDir, { recursive: true }),
    mkdir(folderB, { recursive: true }),
    mkdir(folderC, { recursive: true }),
  ]);
  await writeFile(path.join(botDir, "config.json"), JSON.stringify({ engine: "codex", workspacePath: folderA }, null, 2));
  const hub = await HubServer.start({ stateDir: hubDir, host: "127.0.0.1", port: 0 });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run(
    "INSERT INTO bots(id,name,secret_hash,engine,model,effort,online) VALUES(?,?,?,?,?,?,0)",
    ["bot1", "Codex Bot", hashSecret(secret), "codex", "gpt-5", "medium"],
  );
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const deviceId = "dev_owner_" + randomBytes(4).toString("hex");
  const pairing = await hub.auth.pair({ deviceId, name: "Owner Mac", platform: "macos", publicKey: pub }, "test");
  await hub.auth.approve(pairing.code, "local-owner");
  const nonce = randomBytes(32).toString("base64url");
  const challenge = await hub.auth.challenge(deviceId, deviceId, nonce, "test");
  const session = await hub.auth.authenticate(deviceId, sign(null, deviceProof(deviceId, challenge.nonce, nonce), privateKey).toString("base64"));
  const token = session.token;
  const api = async <T = unknown>(route: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${hub.url}${route}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* plain text */ }
    return { status: res.status, body: body as T };
  };
  return { root, hub, hubDir, botDir, folderA, folderB, folderC, nestedDir, secret, deviceId, privateKey, token, api };
}

describe("saved workspaces (#91)", () => {
  it("formats workspace display names cleanly for POSIX and Windows paths", () => {
    expect(workspaceDisplayName("/srv/projects/alpha")).toBe("alpha");
    expect(workspaceDisplayName("/srv/projects/alpha/")).toBe("alpha");
    expect(workspaceDisplayName("D:\\work\\beta\\")).toBe("beta");
    expect(workspaceDisplayName("/")).toBe("/");
    expect(workspaceDisplayName("")).toBe("");
  });

  it("supports saved workspaces CRUD and Host directory browsing", async () => {
    const ctx = await setupHub();
    try {
      const browse = await ctx.api<{ path: string; parent: string | null; entries: Array<{ name: string; path: string }> }>(
        `/api/workspaces/browse?path=${encodeURIComponent(ctx.root)}`,
      );
      expect(browse.status).toBe(200);
      expect(browse.body.path).toBe(path.resolve(ctx.root));
      expect(browse.body.entries.map(e => e.name)).toEqual(expect.arrayContaining(["project-alpha", "project-beta", "project-gamma"]));

      const badAdd = await ctx.api("/api/workspaces", { method: "POST", body: JSON.stringify({ path: path.join(ctx.root, "does-not-exist") }) });
      expect(badAdd.status).toBe(400);

      const addedA = await ctx.api<{ workspace: { id: string; name: string; path: string }; items: Array<{ id: string; name: string; path: string }> }>(
        "/api/workspaces",
        { method: "POST", body: JSON.stringify({ path: ctx.folderA }) },
      );
      expect(addedA.status).toBe(201);
      expect(addedA.body.workspace).toMatchObject({ name: "project-alpha", path: path.resolve(ctx.folderA) });

      const addedB = await ctx.api<{ workspace: { id: string; name: string; path: string }; items: Array<{ id: string; name: string; path: string }> }>(
        "/api/workspaces",
        { method: "POST", body: JSON.stringify({ path: ctx.folderB, name: "Beta App" }) },
      );
      expect(addedB.status).toBe(201);
      expect(addedB.body.workspace).toMatchObject({ name: "Beta App", path: path.resolve(ctx.folderB) });
      expect(addedB.body.items[0]!.path).toBe(path.resolve(ctx.folderB));

      const removed = await ctx.api<{ items: Array<{ id: string }> }>(
        `/api/workspaces/${encodeURIComponent(addedA.body.workspace.id)}`,
        { method: "DELETE" },
      );
      expect(removed.status).toBe(200);
      expect(removed.body.items.map(i => i.id)).toEqual([addedB.body.workspace.id]);
    } finally {
      await ctx.hub.close();
    }
  });

  it("switches a Bot default workspace, keeps earlier conversations pinned, and runs two conversations in different folders concurrently", async () => {
    const ctx = await setupHub();
    const seenByConversation = new Map<string, string[]>();
    const activeByConversation = new Map<string, { workspace?: string; resolve: () => void }>();
    let releaseBoth!: () => void;
    const bothArrived = new Promise<void>(resolve => { releaseBoth = resolve; });
    let holdConcurrent = false;
    const listedCwds: Array<string | undefined> = [];

    const bridge: CoreBridgeLike = {
      checkAccess: async () => ({ kind: "allow" }),
      handleAuthorizedMessage: async (input) => {
        const key = input.conversationKey ?? "";
        seenByConversation.set(key, [...(seenByConversation.get(key) ?? []), input.workspaceOverride ?? ""]);
        if (holdConcurrent) {
          await new Promise<void>(resolve => {
            activeByConversation.set(key, { workspace: input.workspaceOverride, resolve });
            if (activeByConversation.size === 2) releaseBoth();
          });
        }
        return { text: `ran in ${path.basename(input.workspaceOverride ?? "")}` };
      },
      listExternalSessions: async (input) => {
        listedCwds.push(input?.cwd);
        return [];
      },
    };
    const runtime = createCoreServiceRuntime();
    const channel = await attachGateway({
      url: `${(ctx.hub.instanceUrl || ctx.hub.url).replace(/^http/, "ws")}/instance`,
      botId: "bot1",
      secret: ctx.secret,
      stateDir: ctx.botDir,
      engine: "codex",
      bridge,
      runtime,
      recoverDeliveries: false,
    });
    // Wait for Bot instance handshake to complete before issuing API calls.
    await vi.waitFor(async () => {
      const bots = await ctx.hub.store.bots("owner");
      expect(bots.find(b => b.id === "bot1")?.online).toBe(1);
    }, { timeout: 5000 });

    try {
      // 1. Create Conversation 1 under Bot's initial default (folderA)
      const c1Res = await ctx.api<{ id: string; workspacePath?: string }>("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ v: 1, type: "conversation.create", clientActionId: "c1", botIds: ["bot1"], title: "Chat Alpha", conversationType: "direct" }),
      });
      expect(c1Res.status).toBe(201);
      expect(c1Res.body.workspacePath).toBe(path.resolve(ctx.folderA));

      // 2. Switch Bot's default workspace to folderB via HTTP API (no commands)
      const wsGet = await ctx.api<{ revision: string; workspacePath: string }>("/api/bots/bot1/workspace");
      expect(wsGet.status).toBe(200);
      expect(wsGet.body.workspacePath).toBe(path.resolve(ctx.folderA));

      const wsPut = await ctx.api<{ revision: string; workspacePath: string }>("/api/bots/bot1/workspace", {
        method: "PUT",
        body: JSON.stringify({ revision: wsGet.body.revision, workspacePath: ctx.folderB }),
      });
      expect(wsPut.status).toBe(200);
      expect(wsPut.body.workspacePath).toBe(path.resolve(ctx.folderB));

      // 3. New Conversation 2 uses the Bot's new default (folderB)
      const c2Res = await ctx.api<{ id: string; workspacePath?: string }>("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ v: 1, type: "conversation.create", clientActionId: "c2", botIds: ["bot1"], title: "Chat Beta", conversationType: "direct" }),
      });
      expect(c2Res.status).toBe(201);
      expect(c2Res.body.workspacePath).toBe(path.resolve(ctx.folderB));

      // 4. New Conversation 3 picks folderC explicitly for just this conversation
      const c3Res = await ctx.api<{ id: string; workspacePath?: string }>("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ v: 1, type: "conversation.create", clientActionId: "c3", botIds: ["bot1"], title: "Chat Gamma", conversationType: "direct", workspacePath: ctx.folderC }),
      });
      expect(c3Res.status).toBe(201);
      expect(c3Res.body.workspacePath).toBe(path.resolve(ctx.folderC));

      // 5. Run Conversation 1 (original folderA) and Conversation 3 (folderC) CONCURRENTLY on the same Bot!
      holdConcurrent = true;
      await ctx.hub.store.sendMessage("owner", { conversationId: c1Res.body.id, clientMsgId: "m1", text: "hello alpha", attachments: [] });
      await ctx.hub.store.sendMessage("owner", { conversationId: c3Res.body.id, clientMsgId: "m3", text: "hello gamma", attachments: [] });
      await Promise.race([
        bothArrived,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for concurrent turns")), 5000)),
      ]);
      const activeWorkspaces = [...activeByConversation.values()].map(v => v.workspace).sort();
      expect(activeWorkspaces).toEqual([path.resolve(ctx.folderA), path.resolve(ctx.folderC)].sort());
      for (const entry of activeByConversation.values()) entry.resolve();

      // Wait briefly for turns to settle, then verify c2 runs in folderB
      holdConcurrent = false;
      await ctx.hub.store.sendMessage("owner", { conversationId: c2Res.body.id, clientMsgId: "m2", text: "hello beta", attachments: [] });
      await vi.waitFor(() => {
        expect(seenByConversation.get(buildCoreConversationKey(c2Res.body.id)) ?? []).toContain(path.resolve(ctx.folderB));
      }, { timeout: 5000 });

      // Earlier Conversation 1 STILL ran in folderA even after default switched to folderB
      expect(seenByConversation.get(buildCoreConversationKey(c1Res.body.id))).toEqual([path.resolve(ctx.folderA)]);
      expect(seenByConversation.get(buildCoreConversationKey(c3Res.body.id))).toEqual([path.resolve(ctx.folderC)]);
    } finally {
      await channel.disconnect();
      await ctx.hub.close();
    }
  });

  it("pins HubWorkspaceDiff to the conversation's folder rather than the Bot's switched default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "diff-conv-ws-"));
    roots.push(root);
    const state = path.join(root, "bot");
    const repoDefault = path.join(root, "repo-default");
    const repoPinned = path.join(root, "repo-pinned");
    await Promise.all([
      mkdir(state, { recursive: true }),
      mkdir(path.join(repoDefault, ".git", "objects", "info"), { recursive: true }),
      mkdir(path.join(repoPinned, ".git", "objects", "info"), { recursive: true }),
    ]);
    await writeFile(path.join(state, "config.json"), JSON.stringify({ workspacePath: repoDefault }));
    await writeFile(path.join(repoPinned, "pinned.txt"), "hello\n");

    const seenCwds: string[] = [];
    const ok = (stdout = "") => ({ stdout: Buffer.from(stdout), code: 0, stderr: "", limited: false });
    const runGit: WorkspaceGitCommand = async (cwd, args) => {
      seenCwds.push(cwd);
      if (args[0] === "config") return ok("core.repositoryformatversion\n0\0");
      if (args[0] === "rev-parse") {
        if (args.includes("--show-toplevel")) return ok(`${repoPinned}\n`);
        if (args.includes("--absolute-git-dir")) return ok(`${path.join(repoPinned, ".git")}\n`);
        if (args.includes("--git-common-dir")) return ok(`${path.join(repoPinned, ".git")}\n`);
        if (args.includes("--is-bare-repository")) return ok("false\n");
        if (args.includes("--show-prefix")) return ok("\n");
        return ok(`${"a".repeat(40)}\n`);
      }
      if (args[0] === "status") return ok("? pinned.txt\0");
      throw new Error(`unexpected git ${args.join(" ")}`);
    };

    const diff = new HubWorkspaceDiff(async () => state, {
      runGit,
      conversationWorkspace: async (conversationId) => conversationId === "conv-pinned" ? repoPinned : undefined,
    });
    const list = await diff.list({ conversationId: "conv-pinned", botId: "bot1" }, new AbortController().signal, async () => {});
    expect(list.state).toBe("ready");
    expect(list.items.map(i => i.path)).toEqual(["pinned.txt"]);
    expect(seenCwds.every(c => c.includes("repo-pinned"))).toBe(true);
  });

  it("never sends unsolicited workspace.get on instance.hello and syncs workspacePath via hello/ping", async () => {
    const ctx = await setupHub();
    const ws = new WebSocket(`${ctx.hub.instanceUrl.replace(/^http/, "ws")}/instance`);
    const frames: Array<Record<string, unknown>> = [];
    ws.on("message", raw => { frames.push(JSON.parse(raw.toString())); });
    try {
      await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
      ws.send(JSON.stringify({
        v: 1,
        type: "instance.hello",
        botId: "bot1",
        secret: ctx.secret,
        engine: "codex",
        model: "gpt-5",
        effort: "medium",
        workspacePath: ctx.folderA,
      }));
      await vi.waitFor(() => expect(frames.some(f => f.type === "instance.ready")).toBe(true));
      expect((await ctx.hub.store.bots("owner")).find(b => b.id === "bot1")).toMatchObject({
        online: 1,
        workspacePath: ctx.folderA,
      });
      // Give the Hub a beat to ensure no background unsolicited workspace.get RPC is sent.
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(frames.some(f => f.type === "instance.call")).toBe(false);

      ws.send(JSON.stringify({
        v: 1,
        type: "ping",
        status: { engine: "codex", model: "gpt-5", effort: "medium", workspacePath: ctx.folderB },
      }));
      await vi.waitFor(() => expect(frames.some(f => f.type === "pong")).toBe(true));
      expect((await ctx.hub.store.bots("owner")).find(b => b.id === "bot1")?.workspacePath).toBe(ctx.folderB);
    } finally {
      ws.terminate();
      await ctx.hub.close();
    }
  });

  it("hides host workspacePath from non-owner member users across bots, conversations, snapshots, and broadcasts while keeping it for owners and Bots", async () => {
    const ctx = await setupHub();
    await ctx.hub.store.botStatus("bot1", { workspacePath: ctx.folderA });
    await ctx.hub.store.db.run("INSERT INTO users(id,name,role) VALUES('member1','Member','member')");
    await ctx.hub.store.db.run("INSERT INTO bot_grants(user_id,bot_id) VALUES('member1','bot1')");
    const { publicKey: memberPubKey, privateKey: memberPrivKey } = generateKeyPairSync("ed25519");
    const memberPub = memberPubKey.export({ type: "spki", format: "der" }).toString("base64");
    const memberDev = "dev_member_" + randomBytes(4).toString("hex");
    await ctx.hub.store.db.run(
      "INSERT INTO devices(id,user_id,name,platform,public_key,revoked,created_at,last_seen) VALUES(?,?,?,?,?,0,?,?)",
      [memberDev, "member1", "Member Phone", "ios", memberPub, Date.now(), Date.now()],
    );
    const mNonce = randomBytes(32).toString("base64url");
    const mChallenge = await ctx.hub.auth.challenge(memberDev, memberDev, mNonce, "test");
    const mSession = await ctx.hub.auth.authenticate(memberDev, sign(null, deviceProof(memberDev, mChallenge.nonce, mNonce), memberPrivKey).toString("base64"));

    const memberApi = async <T = unknown>(route: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
      const res = await fetch(`${ctx.hub.url}${route}`, {
        ...init,
        headers: { authorization: `Bearer ${mSession.token}`, "content-type": "application/json", ...(init.headers ?? {}) },
      });
      return { status: res.status, body: await res.json() as T };
    };

    const connectClient = async (deviceId: string, privKey: ReturnType<typeof generateKeyPairSync>["privateKey"]) => {
      const socket = new WebSocket(`${ctx.hub.url.replace(/^http/, "ws")}/ws`);
      const received: Array<Record<string, unknown>> = [];
      socket.on("message", raw => { received.push(JSON.parse(raw.toString())); });
      await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
      const nonce = randomBytes(32).toString("base64url");
      socket.send(JSON.stringify({ v: 1, type: "hello", deviceId, nonce, protocolVersions: [1], capabilities: ["snapshot.v1"], cursors: {} }));
      await vi.waitFor(() => expect(received.some(f => f.type === "challenge")).toBe(true));
      const challenge = received.find(f => f.type === "challenge") as { nonce: string };
      socket.send(JSON.stringify({ v: 1, type: "auth", signature: sign(null, deviceProof(deviceId, challenge.nonce, nonce), privKey).toString("base64") }));
      await vi.waitFor(() => expect(received.some(f => f.type === "ready")).toBe(true));
      return { socket, received };
    };

    const ownerWs = await connectClient(ctx.deviceId, ctx.privateKey);
    const memberWs = await connectClient(memberDev, memberPrivKey);
    try {
      const memberReady = memberWs.received.find(f => f.type === "ready") as { bots: Array<{ id: string; workspacePath?: string }> };
      const ownerReady = ownerWs.received.find(f => f.type === "ready") as { bots: Array<{ id: string; workspacePath?: string }> };
      expect(ownerReady.bots[0]?.workspacePath).toBe(ctx.folderA);
      expect(memberReady.bots[0]?.workspacePath).toBeUndefined();

      // Member creates a direct conversation: SQLite snapshots bot1's folder for Bot execution,
      // but the HTTP response and WS broadcast omit workspacePath for member1.
      const created = await memberApi<{ id: string; workspacePath?: string }>("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ v: 1, type: "conversation.create", clientActionId: "m_direct", botIds: ["bot1"], title: "Member Chat", conversationType: "direct" }),
      });
      expect(created.status).toBe(201);
      expect(created.body.workspacePath).toBeUndefined();
      // Bot still sees the pinned workspacePath!
      expect((await ctx.hub.store.conversationForBot("bot1", created.body.id)).workspacePath).toBe(ctx.folderA);

      // Shared group pinned to folderC: owner sees workspacePath; member never does.
      const group = await ctx.api<{ id: string; workspacePath?: string }>("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ v: 1, type: "conversation.create", clientActionId: "shared_grp", botIds: ["bot1"], title: "Shared Group", conversationType: "group", workspacePath: ctx.folderC }),
      });
      expect(group.body.workspacePath).toBe(path.resolve(ctx.folderC));
      await ctx.hub.store.db.run("INSERT INTO conversation_members VALUES(?,'user','member1',0)", [group.body.id]);

      expect((await ctx.hub.store.conversations("member1")).every(c => c.workspacePath === undefined)).toBe(true);
      expect((await ctx.hub.store.snapshot("member1", group.body.id)).conversation.workspacePath).toBeUndefined();
      expect((await ctx.hub.store.groupSettings("member1", group.body.id)).group.workspacePath).toBeUndefined();
      expect((await ctx.hub.store.groupSettings("owner", group.body.id)).group.workspacePath).toBe(path.resolve(ctx.folderC));

      const memberConvs = await memberApi<Array<{ id: string; workspacePath?: string }>>("/api/conversations");
      expect(memberConvs.body.every(c => c.workspacePath === undefined)).toBe(true);

      // Snapshot frames omit workspacePath for member1 and include it for owner
      const memberSnapFrames = [];
      for await (const frame of ctx.hub.store.snapshotFrames("member1", group.body.id, 0)) memberSnapFrames.push(frame);
      const memberBegin = memberSnapFrames.find(f => f.type === "snapshot.begin");
      expect(memberBegin && "conversation" in memberBegin ? memberBegin.conversation.workspacePath : "missing").toBeUndefined();

      const ownerSnapFrames = [];
      for await (const frame of ctx.hub.store.snapshotFrames("owner", group.body.id, 0)) ownerSnapFrames.push(frame);
      const ownerBegin = ownerSnapFrames.find(f => f.type === "snapshot.begin");
      expect(ownerBegin && "conversation" in ownerBegin ? ownerBegin.conversation.workspacePath : undefined).toBe(path.resolve(ctx.folderC));

      // WS conversation.updated broadcast on topic creation hides workspacePath from member1
      const topic = await memberApi<{ id: string; workspacePath?: string }>("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ v: 1, type: "topic.create", clientActionId: "m_topic", groupId: group.body.id, title: "Member Topic" }),
      });
      expect(topic.status).toBe(201);
      expect(topic.body.workspacePath).toBeUndefined();
      expect((await ctx.hub.store.conversationForBot("bot1", topic.body.id)).workspacePath).toBe(path.resolve(ctx.folderC));
      await vi.waitFor(() => expect(memberWs.received.some(f => f.type === "conversation.updated" && (f.conversation as { id?: string })?.id === topic.body.id)).toBe(true));
      const memberUpdate = memberWs.received.find(f => f.type === "conversation.updated" && (f.conversation as { id?: string })?.id === topic.body.id) as { conversation: { workspacePath?: string } };
      expect(memberUpdate.conversation.workspacePath).toBeUndefined();
    } finally {
      ownerWs.socket.terminate();
      memberWs.socket.terminate();
      await ctx.hub.close();
    }
  });

  it("refreshes GatewayChannel.conversationWorkspace() when cached legacy unassigned chat is later pinned on default switch", async () => {
    const ctx = await setupHub();
    const bridge: CoreBridgeLike = {
      checkAccess: async () => ({ kind: "allow" }),
      handleAuthorizedMessage: async () => ({ text: "ok" }),
    };
    const channel = await attachGateway({
      url: `${ctx.hub.instanceUrl.replace(/^http/, "ws")}/instance`,
      botId: "bot1",
      secret: ctx.secret,
      stateDir: ctx.botDir,
      engine: "codex",
      bridge,
      runtime: createCoreServiceRuntime(),
      recoverDeliveries: false,
    });
    await vi.waitFor(async () => expect((await ctx.hub.store.bots("owner")).find(b => b.id === "bot1")?.online).toBe(1));

    try {
      // Legacy unassigned direct conversation (workspace_path = NULL)
      const legacy = await ctx.hub.store.createConversation("owner", ["bot1"], "Legacy Chat", "legacy_unpinned", { type: "direct" });
      expect(legacy.workspacePath).toBeUndefined();

      // Send a message so GatewayChannel caches `legacy` with workspacePath: undefined
      await ctx.hub.store.sendMessage("owner", { conversationId: legacy.id, clientMsgId: "m_leg_1", text: "first", attachments: [] });
      await vi.waitFor(async () => expect((await ctx.hub.store.snapshot("owner", legacy.id)).messages.length).toBeGreaterThanOrEqual(2));

      // Now switch Bot's default workspace from folderA to folderB; Hub pins `legacy` to folderA in SQLite
      const wsGet = await ctx.api<{ revision: string; workspacePath: string }>("/api/bots/bot1/workspace");
      const wsPut = await ctx.api<{ revision: string; workspacePath: string }>("/api/bots/bot1/workspace", {
        method: "PUT",
        body: JSON.stringify({ revision: wsGet.body.revision, workspacePath: ctx.folderB }),
      });
      expect(wsPut.status).toBe(200);

      // GatewayChannel.conversationWorkspace MUST fetch fresh from Hub instead of returning stale cached undefined!
      expect(await channel.conversationWorkspace(legacy.id)).toBe(path.resolve(ctx.folderA));
    } finally {
      await channel.disconnect();
      await ctx.hub.close();
    }
  });

  it("snapshots 1-bot groups on creation and pins legacy unassigned 1-bot groups before writing workspace.set", async () => {
    const ctx = await setupHub();
    // Create a legacy unassigned 1-bot group and a 2-bot group
    await ctx.hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot2','Bot 2',?,'codex')", [hashSecret("x".repeat(32))]);
    const legacySingleGroup = await ctx.hub.store.createConversation("owner", ["bot1"], "Legacy 1-Bot Group", "leg_1g", { type: "group" });
    const legacyTopic = await ctx.hub.store.createConversation("owner", [], "Legacy Topic", "leg_1t", { parentId: legacySingleGroup.id });
    const legacyMultiGroup = await ctx.hub.store.createConversation("owner", ["bot1", "bot2"], "Legacy 2-Bot Group", "leg_2g", { type: "group" });

    let pinnedBeforeWrite: string | undefined;
    const ws = new WebSocket(`${ctx.hub.instanceUrl.replace(/^http/, "ws")}/instance`);
    ws.on("message", async raw => {
      const frame = JSON.parse(raw.toString()) as { type: string; id?: string; method?: string; params?: unknown };
      if (frame.type !== "instance.call") return;
      if (frame.method === "workspace.get") {
        ws.send(JSON.stringify({
          v: 1, type: "instance.result", id: frame.id,
          result: { ok: true, settings: { scope: "bot", revision: "rev-1", workspacePath: path.resolve(ctx.folderA), defaultWorkspacePath: path.resolve(ctx.folderA), activeTurns: 0 } },
        }));
      } else if (frame.method === "workspace.set") {
        // Verify legacy unassigned conversations are ALREADY pinned in SQLite BEFORE workspace.set commits!
        pinnedBeforeWrite = await ctx.hub.store.conversationWorkspacePath(legacySingleGroup.id);
        ws.send(JSON.stringify({
          v: 1, type: "instance.result", id: frame.id,
          result: { ok: true, settings: { scope: "bot", revision: "rev-2", workspacePath: path.resolve(ctx.folderB), defaultWorkspacePath: path.resolve(ctx.folderA), activeTurns: 0 } },
        }));
      }
    });

    try {
      await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
      ws.send(JSON.stringify({ v: 1, type: "instance.hello", botId: "bot1", secret: ctx.secret, engine: "codex", model: "gpt-5", effort: "medium", workspacePath: path.resolve(ctx.folderA) }));
      await vi.waitFor(async () => expect((await ctx.hub.store.bots("owner")).find(b => b.id === "bot1")?.online).toBe(1));

      // Creating a new 1-bot group snapshots bot1's default workspace (folderA)
      const newSingleGroup = await ctx.api<{ id: string; workspacePath?: string }>("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ v: 1, type: "conversation.create", clientActionId: "new_1g", botIds: ["bot1"], title: "New 1-Bot Group", conversationType: "group" }),
      });
      expect(newSingleGroup.status).toBe(201);
      expect(newSingleGroup.body.workspacePath).toBe(path.resolve(ctx.folderA));

      // Switch bot1 default workspace to folderB
      const switched = await ctx.api("/api/bots/bot1/workspace", {
        method: "PUT",
        body: JSON.stringify({ revision: "rev-1", workspacePath: ctx.folderB }),
      });
      expect(switched.status).toBe(200);
      expect(pinnedBeforeWrite).toBe(path.resolve(ctx.folderA));
      expect(await ctx.hub.store.conversationWorkspacePath(legacySingleGroup.id)).toBe(path.resolve(ctx.folderA));
      expect(await ctx.hub.store.conversationWorkspacePath(legacyTopic.id)).toBe(path.resolve(ctx.folderA));
      // Multi-bot group remains unpinned
      expect(await ctx.hub.store.conversationWorkspacePath(legacyMultiGroup.id)).toBeUndefined();

      // Revoked session is rejected inside /api/bots/:id/workspace
      await ctx.hub.auth.revoke(ctx.deviceId, "local-owner");
      const revoked = await ctx.api("/api/bots/bot1/workspace");
      expect(revoked.status).toBe(401);
    } finally {
      ws.terminate();
      await ctx.hub.close();
    }
  });

  it("passes conversation pinned workspace to /resume, resume card actions, /compact, /ultrareview, /context, card choice, cron, and delivery recovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "saved-ws-core-"));
    roots.push(root);
    const stateDir = path.join(root, "state");
    const folderA = path.join(root, "default-a");
    const folderC = path.join(root, "pinned-c");
    await Promise.all([mkdir(stateDir, { recursive: true }), mkdir(folderA, { recursive: true }), mkdir(folderC, { recursive: true })]);
    const canonicalC = await realpath(folderC);

    // 1. /resume & /resume session & resume_scan & resume card on Pi in pinned folderC
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "pi", workspacePath: folderA, locale: "en" }));
    const validateCodexThread = vi.fn(async (sessionId: string) => ({ sessionId, cwd: canonicalC, title: "Pinned Pi Session" }));
    const listExternalSessions = vi.fn(async () => [{ sessionId: "pi-pinned-1", cwd: canonicalC, title: "Pinned Pi Session", updatedAt: "2026-11-26T00:00:00.000Z" }]);
    const handleAuthorizedMessage = vi.fn(async () => ({ text: "ok" }));
    const send = vi.fn(async () => ({ messageId: "m_out" }));
    const channel = {
      profile: "gateway" as const,
      send,
      stream: vi.fn(async () => ({ messageId: "m_stream" })),
      downloadResource: vi.fn(async () => Buffer.alloc(0)),
      conversationWorkspace: vi.fn(async () => canonicalC),
      inConversation: <T>(_id: string, op: () => T) => withChannelProfile("gateway", op),
    };
    const bridge: CoreBridgeLike = {
      checkAccess: async () => ({ kind: "allow" }),
      validateCodexThread,
      listExternalSessions,
      handleAuthorizedMessage,
    };
    const runtime = createCoreServiceRuntime();

    await withChannelProfile("gateway", async () => {
      await handleCoreMessage({
        channel, bridge, runtime, stateDir,
        message: {
          messageId: "m_res_1", chatId: "gw_chat1", chatType: "p2p", senderId: "gwuser_owner",
          content: "/resume session pi-pinned-1", rawContentType: "text", resources: [], mentions: [], mentionedBot: true, mentionAll: false,
          workspaceOverride: canonicalC,
        },
      });
      expect(validateCodexThread).toHaveBeenCalledWith("pi-pinned-1", { workspaceOverride: canonicalC });

      // Clear session resume so card actions test pinned conversation workspace (not resume workspace)
      await new SessionStore(path.join(stateDir, "session.json")).removeByConversationKey("lark:gw_chat1");

      // Resume card refresh passes pinned cwd
      await handleCoreCardAction({
        channel, bridge, runtime, stateDir,
        event: {
          chatId: "gw_chat1", messageId: "m_card_refresh", operator: { openId: "gwuser_owner" },
          action: { value: { cctb_lark: "resume_scan", conversationKey: "lark:gw_chat1", bridgeChatType: "private" } },
        },
      });
      expect(listExternalSessions).toHaveBeenCalledWith({ cwd: canonicalC, limit: 20 });

      // Resume card click passes pinned conversationWorkspace and ignores forged value.workspacePath
      validateCodexThread.mockClear();
      await handleCoreCardAction({
        channel, bridge, runtime, stateDir,
        event: {
          chatId: "gw_chat1", messageId: "m_card_pick", operator: { openId: "gwuser_owner" },
          action: { value: { cctb_lark: "resume", engine: "pi", conversationKey: "lark:gw_chat1", bridgeChatType: "private", sessionId: "pi-pinned-1", workspacePath: "/forged/path" } },
        },
      });
      expect(validateCodexThread).toHaveBeenCalledWith("pi-pinned-1", { workspaceOverride: canonicalC });
    });

    // 2. /compact, /ultrareview, /context in engine-commands.ts pass cfg.workspacePath when cfg.resume is absent
    const engRun = vi.fn(async () => ({ text: "ok" }));
    const engCtx = vi.fn(async () => ({ pressureTokens: 100, contextWindow: 1000 }));
    for (const [engine, cmd, antigravityRuntime] of [
      ["claude", "/compact", undefined],
      ["claude", "/ultrareview", undefined],
      ["claude", "/context", undefined],
      ["deepseek", "/context", undefined],
      ["antigravity", "/context", "acp"],
    ] as const) {
      engRun.mockClear();
      engCtx.mockClear();
      await handleLocalEngineCoreCommand({
        stateDir, startedAt: Date.now(), locale: "en",
        cfg: { engine, workspacePath: canonicalC, ...(antigravityRuntime ? { antigravityRuntime } : {}) },
        normalized: { chatId: 1, userId: 2, chatType: "private", text: cmd, attachments: [] },
        context: { api: { sendMessage: vi.fn(async () => ({ message_id: 1 })) } as never },
        bridge: { handleAuthorizedMessage: engRun, getContextUsage: engCtx },
        sessionStore: { removeByChatId: vi.fn(), clearAll: vi.fn() },
        updateInstanceConfig: vi.fn(),
      });
      if (cmd === "/context" && engine !== "claude") {
        expect(engCtx).toHaveBeenCalledWith(expect.objectContaining({ workspaceOverride: canonicalC }));
      } else {
        expect(engRun).toHaveBeenCalledWith(expect.objectContaining({ text: cmd, workspaceOverride: canonicalC }));
      }
    }

    // 3. Interactive card choice follow-up (runCoreCardChoice) uses channel.conversationWorkspace(chatId)
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", workspacePath: folderA, locale: "en" }));
    await new SessionStore(path.join(stateDir, "session.json")).removeByConversationKey("lark:gw_choice");
    handleAuthorizedMessage.mockClear();
    runtime.pendingApprovals.set("req_choice_ws", {
      requestId: "req_choice_ws",
      chatId: "gw_choice",
      conversationKey: "lark:gw_choice",
      bridgeChatType: "private",
      requesterUserId: stableCoreNumericId("user:gwuser_owner"),
      toolName: "AskUserQuestion",
      askUserQuestionInput: {
        questions: [{
          question: "Continue?",
          header: "Confirm",
          options: [{ label: "Yes", description: "Proceed" }],
          multiSelect: false,
        }],
      },
      asyncQuestion: { nativeRequestId: "native_q_1" },
      resolve: () => {},
      timer: setTimeout(() => {}, 60_000).unref(),
    });
    await withChannelProfile("gateway", async () => {
      await handleCoreCardAction({
        channel, bridge, runtime, stateDir,
        event: {
          chatId: "gw_choice", messageId: "m_choice_submit", operator: { openId: "gwuser_owner" },
          action: {
            value: { cctb_lark: "ask_user_question", requestId: "req_choice_ws" },
            form_value: { q0: "Yes" },
          },
        },
      });
      await vi.waitFor(() => expect(handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({ workspaceOverride: canonicalC })), { timeout: 5000 });
    });

    // 4. Cron execution uses channel.conversationWorkspace(job.larkChatId) rather than Bot default folderA
    await new SessionStore(path.join(stateDir, "session.json")).removeByConversationKey("lark:gw_cron");
    handleAuthorizedMessage.mockClear();
    const executeCron = buildCoreCronExecutor({ channel, bridge, runtime, stateDir });
    await withChannelProfile("gateway", () => executeCron({
      id: "job_1",
      name: "Daily check",
      channel: "lark",
      chatId: 1,
      userId: 2,
      chatType: "private",
      larkChatId: "gw_cron",
      conversationKey: "lark:gw_cron",
      prompt: "check repo",
      schedule: { kind: "every", everyMs: 60_000 },
      deliveryMode: "agent_turn",
      sessionMode: "shared",
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never));
    expect(handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({ workspaceOverride: canonicalC }));

    // 4. Delivery recovery validates/delivers files against the obligation's conversation pinned folderC
    const reportPath = path.join(canonicalC, "report.txt");
    await writeFile(reportPath, "pinned folder artifact");
    await writeFile(resolveDeliveryObligationsPath(stateDir), JSON.stringify({
      obligations: [{
        id: "ob_pinned",
        channel: "lark",
        chatId: "gw_recover",
        conversationKey: "lark:gw_recover",
        content: `[file:${reportPath}]`,
        state: "failed",
        attempts: 1,
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 60_000,
        ownerPid: 999_999_99,
      }],
    }));
    const recResult = await redeliverRecoveredCoreObligations({
      channel,
      stateDir,
      workspaceOverride: folderA,
      locale: "en",
      runtime,
    });
    expect(recResult).toEqual({ recovered: 1, failed: 0, abandoned: 0 });
  });

  it("keeps active Side Sessions in pinned conversations alive when Bot default workspace switches and queries capability with conversation workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "side-pinned-ws-"));
    roots.push(root);
    const folderA = path.join(root, "alpha");
    const folderB = path.join(root, "beta");
    await Promise.all([mkdir(folderA), mkdir(folderB)]);
    await writeFile(path.join(root, "config.json"), JSON.stringify({ engine: "codex", workspacePath: folderA }));

    const capabilityWorkspaces: Array<string | undefined> = [];
    const disposed = vi.fn(async () => {});
    const engine: EngineSideSession = {
      nativeId: "side-native",
      dispose: disposed,
      send: async () => ({ text: "side answer" }),
    };
    const openSideSession = vi.fn(async () => engine);
    const bridge = {
      openSideSession,
      sideCapability: (input?: { workspaceOverride?: string }) => {
        capabilityWorkspaces.push(input?.workspaceOverride);
        return { context: "native", readOnly: "enforced", toolAccess: "inherited", residue: "none", concurrent: true, seesInProgressTurn: false, delivery: true };
      },
    } as unknown as CoreBridgeLike;

    const side = gatewaySideSessions(
      bridge,
      root,
      "bot1",
      async () => true,
      undefined,
      undefined,
      {
        uploadSideArtifact: vi.fn<GatewayChannel["uploadSideArtifact"]>(async () => "att_1"),
        conversationWorkspace: async (conversationId) => conversationId === "conv_pinned" ? folderA : undefined,
      },
    );
    const pinnedScope = { conversationId: "conv_pinned", userId: "owner", deviceId: "dev1" };
    const unpinnedScope = { conversationId: "conv_unpinned", userId: "owner", deviceId: "dev1" };
    try {
      const openedPinned = sideReplySchema.parse(await side.call("side.open", { ...pinnedScope, requestId: "open_p" }));
      expect(openedPinned.ok).toBe(true);
      await vi.waitFor(async () => {
        const r = sideReplySchema.parse(await side.call("side.read", { ...pinnedScope, sideId: openedPinned.view!.id }));
        expect(r.ok && r.view?.phase).toBe("idle");
      });

      const openedUnpinned = sideReplySchema.parse(await side.call("side.open", { ...unpinnedScope, requestId: "open_u" }));
      expect(openedUnpinned.ok).toBe(true);
      await vi.waitFor(async () => {
        const r = sideReplySchema.parse(await side.call("side.read", { ...unpinnedScope, sideId: openedUnpinned.view!.id }));
        expect(r.ok && r.view?.phase).toBe("idle");
      });

      // Switch Bot default workspace from folderA to folderB
      await writeFile(path.join(root, "config.json"), JSON.stringify({ engine: "codex", workspacePath: folderB }));

      // Status for pinned conversation queries capability with folderA (not switched folderB)
      capabilityWorkspaces.length = 0;
      await side.call("side.status", { ...pinnedScope });
      expect(capabilityWorkspaces).toEqual([folderA]);

      // Pinned conversation's side session stays alive and answers follow-up questions!
      const askPinned = sideReplySchema.parse(await side.call("side.ask", { ...pinnedScope, sideId: openedPinned.view!.id, requestId: "ask_p", text: "still alive?" }));
      expect(askPinned.ok).toBe(true);
      await vi.waitFor(async () => {
        const r = sideReplySchema.parse(await side.call("side.read", { ...pinnedScope, sideId: openedPinned.view!.id }));
        expect(r.ok && r.view?.exchanges[0]?.status).toBe("complete");
      });

      // Unpinned conversation whose effective workspace changed expires cleanly
      const readUnpinned = sideReplySchema.parse(await side.call("side.read", { ...unpinnedScope, sideId: openedUnpinned.view!.id }));
      expect(readUnpinned).toEqual({ ok: false, error: "expired" });
    } finally {
      await side.close();
    }
  });
});
