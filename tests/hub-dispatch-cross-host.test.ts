import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { BotManager } from "../src/hub/bot-manager.js";
import { messageHostId } from "../src/hub/bot-messages.js";
import { desktopTls } from "../src/hub/desktop-tls.js";
import { buildBatchSummaryText, parseSplitTaskSpec, planSplitBatches } from "../src/hub/dispatch-planner.js";
import { handleRemoteDispatchRequest, readLocalHostLoad, updateCrossHostDispatchGrants, type RemoteDispatchContext } from "../src/hub/dispatch-remote.js";
import { HubPromptQueue } from "../src/hub/prompt-queue.js";
import { networkId } from "../src/hub/private-network.js";
import { HubServer } from "../src/hub/server.js";
import { startHubControl } from "../src/hub/service.js";
import { loadHubTls } from "../src/hub/tls.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { updateInstanceConfig } from "../src/state/instance-config.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { runTicketsCommand } from "../src/host-cli/tickets.js";
import { BOT_PASSPORT_TTL_MS, type BotPassport } from "../src/client-protocol/bot-messages.js";
import { networkCanonical, type NetworkManifest } from "../src/client-protocol/private-network.js";
import {
  REMOTE_DISPATCH_TARGET_BOT, crossHostDispatchGrantCommandSchema, defaultDispatcherSettings, dispatchNodesResponseSchema,
  remoteDispatchRunRequestSchema,
  type DispatchEngine, type DispatchNodeTarget, type DispatchTicket,
} from "../src/client-protocol/dispatch.js";

const owner = { kind: "owner" as const, userId: "owner" };
const ENGINES: readonly DispatchEngine[] = ["codex", "claude", "kimi", "deepseek", "antigravity"];

function makeNode(hostId: string, hostName: string, overrides: Partial<DispatchNodeTarget> = {}): DispatchNodeTarget {
  return {
    hostId,
    hostName,
    local: hostName === "macmini",
    enabled: true,
    online: true,
    authorized: true,
    preference: "normal",
    maxConcurrent: 2,
    activeOnNode: 0,
    load: {
      hostId,
      hostName,
      online: true,
      authorized: true,
      cpuCount: 8,
      cpuLoadRatio: 0.25,
      freeMemoryRatio: 0.65,
      activeTurns: 0,
      activeTickets: 0,
      engines: ENGINES.map(engine => ({
        engine,
        installed: engine !== "antigravity",
        available: engine !== "antigravity",
        quotaState: "ok",
        models: [{ id: "", efforts: [""] }],
        defaultModel: "",
        defaultEffort: "",
      })),
      observedAt: Date.now(),
    },
    eligible: true,
    score: 100,
    ...overrides,
  };
}

let root: string, aDir: string, bDir: string, a: HubServer, b: HubServer;
let macId: string, studioId: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dispatch-cross-host-"));
  aDir = path.join(root, "a");
  bDir = path.join(root, "b");
  await initializeHost(bDir, "studio-b");
  const address = Object.values(networkInterfaces()).flat().find(item => item?.family === "IPv4" && !item.internal)!.address;
  const cert = await desktopTls(root, [address]);
  const tls = await loadHubTls({ cert: cert.cert, key: cert.key });

  a = await HubServer.start({ stateDir: aDir });
  b = await HubServer.start({ stateDir: bDir, host: address, tls, exposure: "public" });
  await a.profile.update({ name: "macmini", revision: 0 });
  await b.profile.update({ name: "studio-b", revision: 0 });

  macId = messageHostId(a.auth.publicKey);
  studioId = messageHostId(b.auth.publicKey);

  // Pair A and B into a shared signed private network manifest over real TLS.
  const hosts = [
    { publicKey: a.auth.publicKey, name: "macmini", routes: [], protocol: 2 as const, state: "active" as const, revoked: false },
    { publicKey: b.auth.publicKey, name: "studio-b", routes: [{ name: "Direct" as const, url: b.url, certificateAuthority: cert.certificateAuthority }], protocol: 2 as const, state: "active" as const, revoked: false },
  ];
  const nonce = randomBytes(32).toString("base64url");
  const manifest: NetworkManifest = {
    v: 2,
    id: networkId(a.auth.publicKey, nonce),
    authorityKey: a.auth.publicKey,
    genesisNonce: nonce,
    name: "CrossHostTest",
    revision: 1,
    hosts,
    devices: [],
    revokedMembers: [],
    blockedBindings: [],
  };
  const membership = { manifest, signature: a.auth.signNetworkManifest(manifest) };
  for (const hub of [a, b]) {
    await hub.store.db.run(
      "INSERT INTO meta(key,value) VALUES('private-network:v1',?)",
      [JSON.stringify({
        v: 1,
        routes: hub === b ? hosts[1]!.routes : [],
        membership,
        imported: {},
        revokedMembers: [],
        revokedHosts: [],
        retiredNetworks: [],
        admissions: [],
        peers: [],
        proofs: [],
        intents: {},
        lastSyncedAt: Date.now(),
        waiting: false,
      })],
    );
  }

  // Dispatcher + local workers on Hub A ("macmini").
  await a.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,role) VALUES('d','Chancellor',?,'claude','','','dispatcher')", [hashSecret("disp-secret")]);
  await a.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,role) VALUES('w_local_codex','Chancellor · codex','fixture','codex','','','worker')");
  await a.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,role) VALUES('w_local_claude','Chancellor · claude','fixture','claude','','','worker')");
  await a.store.createConversation("owner", ["d"], "Chancellor", "home");
  await a.dispatch.updateSettings("owner", "d", {
    settings: {
      ...defaultDispatcherSettings(),
      mode: "auto",
      maxConcurrent: 4,
      nodes: [
        { hostId: macId, enabled: true, maxConcurrent: 2, preference: "normal" },
        { hostId: studioId, enabled: true, maxConcurrent: 2, preference: "normal" },
      ],
    },
    expectedRevision: (await a.dispatch.settings("owner", "d")).revision,
  });

  // Remote workers on Hub B ("studio-b").
  await b.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,role) VALUES('w_remote_codex','Remote · codex','fixture','codex','','','worker')");
  await b.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,role) VALUES('w_remote_claude','Remote · claude','fixture','claude','','','worker')");

  const catalogFor = () => ({ engines: ENGINES.map(id => ({ id, available: id !== "antigravity", models: [{ id: "", efforts: [""] }], defaultModel: "", defaultEffort: "" })) });
  a.dispatch.workers = {
    catalog: async () => catalogFor(),
    dispatchWorker: async (_dispatcher: string, engine: DispatchEngine) => (engine === "claude" ? "w_local_claude" : "w_local_codex"),
    ticketWorkspace: async (_dispatcher: string, ticketId: string) => path.join(aDir, "tickets", ticketId),
  };
  (b.dispatch as { workers: unknown }).workers = {
    catalog: async () => catalogFor(),
    dispatchWorker: async (_dispatcher: string, engine: DispatchEngine) => (engine === "claude" ? "w_remote_claude" : "w_remote_codex"),
    ticketWorkspace: async (_dispatcher: string, ticketId: string) => path.join(bDir, "tickets", ticketId),
    remoteDispatchWorker: async (_sourceHostId: string, engine: DispatchEngine) => (engine === "claude" ? "w_remote_claude" : "w_remote_codex"),
    remoteTicketWorkspace: async (_sourceHostId: string, remoteTicketId: string) => ({ path: path.join(bDir, "remote-tickets", remoteTicketId) }),
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await a?.close().catch(() => undefined);
  await b?.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

async function authorizeStudioFromMac(): Promise<void> {
  const closeCtrl = await startHubControl(
    bDir,
    { running: true, pid: process.pid, url: b.url, instanceUrl: b.instanceUrl, publicKey: b.auth.publicKey },
    () => {},
    { enrollController: value => b.enrollLocalController(value) },
  );
  const client = await LocalHostClient.connect(bDir, { enroll: true });
  try {
    const command = crossHostDispatchGrantCommandSchema.parse({
      operation: "cross-host-dispatch-grant",
      sourceHost: macId,
      sourceBot: "d",
      allowed: true,
    });
    const proof = await client.deviceAction({
      operation: "bot-message-grant",
      target: createHash("sha256").update(networkCanonical(command)).digest("hex"),
    });
    await client.request("/api/dispatch/cross-host-grants", "POST", { command, proof });
  } finally {
    client.close();
    await closeCtrl();
  }
}

it("splits N-item tasks cleanly and honors #88 preferences, quota health, and manual_only skips", () => {
  const spec = parseSplitTaskSpec("写 50 个自动化脚本，每台机器最多 10 个");
  expect(spec.totalItems).toBe(50);
  expect(spec.perNode).toBe(10);

  const mac = makeNode(`hub_${"a".repeat(64)}`, "macmini", { preference: "prefer", maxConcurrent: 2 });
  const studio = makeNode(`hub_${"b".repeat(64)}`, "studio-b", { preference: "normal", maxConcurrent: 2 });
  const manual = makeNode(`hub_${"c".repeat(64)}`, "manual-box", { preference: "manual_only" });
  const offline = makeNode(`hub_${"d".repeat(64)}`, "offline-box", { online: false, eligible: false });
  const blockedQuota = makeNode(`hub_${"e".repeat(64)}`, "blocked-box", {
    load: {
      ...makeNode(`hub_${"e".repeat(64)}`, "blocked-box").load,
      engines: ENGINES.map(engine => ({
        engine,
        installed: true,
        available: true,
        quotaState: engine === "codex" ? "blocked" : "ok",
        models: [{ id: "", efforts: [""] }],
        defaultModel: "",
        defaultEffort: "",
      })),
    },
  });

  const plan = planSplitBatches(
    { requestId: "req1", request: "写 50 个自动化脚本，每台机器最多 10 个", engine: "codex", totalItems: 50, perNode: 10, create: false, dispatch: false },
    [manual, offline, blockedQuota, studio, mac],
    { ...defaultDispatcherSettings(), mode: "auto", maxConcurrent: 4 },
    "batch_test",
  );

  expect(plan.batches).toHaveLength(5);
  expect(plan.batches.every(batch => batch.hostId === mac.hostId || batch.hostId === studio.hostId)).toBe(true);
  // First batch prefers the higher-scoring #88 "prefer" node (macmini).
  expect(plan.batches[0]!.hostId).toBe(mac.hostId);
  expect(plan.skippedNodes.map(s => s.hostId)).toEqual(expect.arrayContaining([manual.hostId, offline.hostId, blockedQuota.hostId]));

  const summary = buildBatchSummaryText(
    "batch_test",
    [
      { id: "tk1", dispatcherBotId: "d", conversationId: "home", title: "Batch 1", request: "x", status: "needs_review", paused: false, attempts: [{ id: "ta1", botId: "w", engine: "codex", model: "", effort: "", conversationId: "c1", inputMessageId: "m1", startedAt: 1, endedAt: 2, outcome: "completed", hostId: mac.hostId, hostName: "macmini" }], hostId: mac.hostId, hostName: "macmini", batchId: "batch_test", batchIndex: 0, batchTotal: 2, result: "Scripts 1-25 generated", createdAt: 1, updatedAt: 2 },
      { id: "tk2", dispatcherBotId: "d", conversationId: "home", title: "Batch 2", request: "y", status: "needs_review", paused: false, attempts: [{ id: "ta2", botId: "w", engine: "codex", model: "", effort: "", conversationId: "c2", inputMessageId: "m2", startedAt: 1, endedAt: 2, outcome: "completed", hostId: studio.hostId, hostName: "studio-b" }], hostId: studio.hostId, hostName: "studio-b", batchId: "batch_test", batchIndex: 1, batchTotal: 2, result: "Scripts 26-50 generated", artifacts: [{ id: "att1", name: "scripts.tar.gz", size: 120, mime: "application/gzip", localAttachmentId: "att1" }], createdAt: 1, updatedAt: 2 },
    ],
    "macmini",
  );
  expect(summary).toContain("macmini");
  expect(summary).toContain("studio-b");
  expect(summary).toContain("scripts.tar.gz");
});

it.each([
  { label: "total one without per-node", fields: { totalItems: 1 }, counts: [1], total: 1 },
  { label: "total one with per-node one", fields: { totalItems: 1, perNode: 1 }, counts: [1], total: 1 },
  { label: "total one below per-node capacity", fields: { totalItems: 1, perNode: 3 }, counts: [1], total: 1 },
  { label: "per-node without a total", fields: { perNode: 2 }, counts: [2, 2], total: 4 },
  { label: "explicit items", fields: { totalItems: 1, perNode: 2, items: ["Alpha", "Beta", "Gamma"] }, counts: [2, 1], total: 3 },
  { label: "larger total", fields: { totalItems: 5, perNode: 2 }, counts: [2, 2, 1], total: 5 },
])("agrees on preview and persisted tickets for $label", async ({ fields, counts, total }) => {
  await authorizeStudioFromMac();
  const { settings, revision } = await a.dispatch.settings("owner", "d");
  await a.dispatch.updateSettings("owner", "d", { settings: { ...settings, mode: "ask" }, expectedRevision: revision });
  const nodes = await a.dispatch.nodes(owner, "d");
  expect(nodes.nodes.filter(node => node.eligible).map(node => node.hostId)).toEqual([macId, studioId]);

  const input = { requestId: "count-plan", request: "Prepare example output", engine: "codex", ...fields };
  const preview = await a.dispatch.plan(owner, "d", input);
  expect(preview.tickets).toBeUndefined();
  expect(await a.store.db.get("SELECT 1 FROM dispatch_tickets WHERE batch_id=?", [preview.batchId])).toBeUndefined();
  expect(await a.store.db.get("SELECT 1 FROM dispatch_requests WHERE request_id=?", [`plan_${preview.batchId}`])).toBeUndefined();

  const created = await a.dispatch.plan(owner, "d", { ...input, create: true });
  const persisted = await a.store.db.all<{ id: string; host_id: string }>(
    "SELECT id,host_id FROM dispatch_tickets WHERE batch_id=? ORDER BY batch_index", [preview.batchId],
  );
  for (const plan of [preview, created]) {
    expect.soft(plan.totalItems).toBe(total);
    expect.soft(plan.batches.map(batch => batch.itemCount)).toEqual(counts);
    expect.soft(plan.batches.map(batch => batch.itemStart)).toEqual(counts.map((_, i) => 1 + counts.slice(0, i).reduce((sum, count) => sum + count, 0)));
    expect.soft(plan.batches.at(-1)?.itemEnd).toBe(total);
  }
  expect.soft(created.tickets).toHaveLength(counts.length);
  expect.soft(persisted).toHaveLength(counts.length);
  expect(persisted).toEqual(created.tickets?.map(ticket => ({ id: ticket.id, host_id: ticket.hostId })));
  expect(created.tickets?.every(ticket => ticket.status === "queued" && ticket.attempts.length === 0)).toBe(true);
  if (fields.items) {
    expect(created.tickets?.[0]?.request).toContain("1. Alpha\n2. Beta");
    expect(created.tickets?.[1]?.request).toContain("3. Gamma");
  }
});

it("enforces remote authorization, dispatches across 2 real TLS Hubs in parallel, collects artifacts, and publishes one consolidated summary", async () => {
  // 1. Before authorization: studio-b is online but unauthorized.
  const preNodes = dispatchNodesResponseSchema.parse(await a.dispatch.nodes(owner, "d"));
  const preStudio = preNodes.nodes.find(n => n.hostId === studioId)!;
  expect(preStudio).toMatchObject({ online: true, authorized: false, eligible: false });

  const unauthTicket = await a.dispatch.create(owner, "d", { requestId: "unauth-c", title: "Unauthorized test", request: "Run on studio-b" });
  await expect(a.dispatch.dispatch(owner, "d", { requestId: "unauth-d", ticketId: unauthTicket.id, engine: "codex", hostId: studioId })).rejects.toThrow("bot_message_not_authorized");

  // 2. Owner explicitly authorizes macmini's dispatcher ("d") on studio-b via signed deviceAction proof.
  await authorizeStudioFromMac();

  const postNodes = dispatchNodesResponseSchema.parse(await a.dispatch.nodes(owner, "d"));
  const postStudio = postNodes.nodes.find(n => n.hostId === studioId)!;
  expect(postStudio).toMatchObject({ online: true, authorized: true, eligible: true });

  // 3. Plan & dispatch 4 items (2 per node -> 2 parallel tickets: 1 on macmini, 1 on studio-b).
  const defaultChat = (await a.store.conversations("owner")).find(c => c.botIds.includes("d"))!;
  await a.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort) VALUES('other','Other','fixture','codex','','')");
  const origin = await a.store.createConversation("owner", ["d", "other"], "Batch group", "batch_group", { type: "group" });
  const homeTicket = await a.dispatch.create(owner, "d", { requestId: "home-ticket", conversationId: defaultChat.id, title: "Independent", request: "Keep this ticket separate" });
  const turn = await a.store.sendMessage("owner", { conversationId: origin.id, clientMsgId: "batch-turn", text: "Plan a batch", attachments: [], mentions: ["d"] });
  await a.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id='d'", [turn.message.id]);
  const actor = { kind: "bot" as const, botId: "d", contextMessage: turn.message.id };
  const plan = await a.dispatch.plan(actor, "d", {
    requestId: "parallel-4",
    title: "Generate batch",
    request: "写 4 个脚本，每台机器 2 个",
    engine: "codex",
    totalItems: 4,
    perNode: 2,
    create: true,
    dispatch: true,
  });

  expect(plan.batches).toHaveLength(2);
  expect(plan.tickets).toHaveLength(2);
  expect(plan.tickets!.map(ticket => ticket.conversationId)).toEqual([origin.id, origin.id]);
  const closeSourceControl = await startHubControl(aDir,
    { running: true, pid: process.pid, url: a.url, instanceUrl: a.instanceUrl, publicKey: a.auth.publicKey },
    () => {}, { enrollController: value => a.enrollLocalController(value) });
  const ownerClient = await LocalHostClient.connect(aDir, { enroll: true });
  try {
    const scoped = await ownerClient.request<{ tickets: DispatchTicket[]; otherCount: number }>(
      `/api/bots/d/tickets?summary=1&crossHostDispatch=1&conversationId=${origin.id}`,
    );
    expect(scoped.tickets.map(ticket => ticket.id).sort()).toEqual(plan.tickets!.map(ticket => ticket.id).sort());
    expect(scoped.otherCount).toBe(2); // The earlier unauthorized dispatch and the independent home ticket.
    await ownerClient.request("/api/bots/d/tickets/bulk-action", "POST", { requestId: "pause-home", action: "pause", conversationId: defaultChat.id });
    expect((await a.dispatch.show(owner, homeTicket.id)).paused).toBe(true);
    for (const ticket of plan.tickets!) expect((await a.dispatch.show(owner, ticket.id)).paused).toBe(false);
  } finally { ownerClient.close(); await closeSourceControl(); }
  await expect(a.dispatch.dispatch(actor, "d", { requestId: "wrong-conversation", ticketId: homeTicket.id, engine: "codex", hostId: studioId })).rejects.toThrow("dispatch_conversation_mismatch");
  const byHost = new Map(plan.tickets!.map(t => [t.hostId!, t]));
  const localTicket = byHost.get(macId)!;
  const remoteTicket = byHost.get(studioId)!;
  expect(localTicket.status).toBe("working");
  expect(remoteTicket.status).toBe("working");
  expect(remoteTicket.attempts[0]!.remoteTicketId).toBeTruthy();

  // 4. Complete the local worker on macmini AND the remote worker on studio-b (with a generated attachment!).
  const localAttempt = localTicket.attempts.at(-1)!;
  await a.store.publishBotMessage(localAttempt.botId, {
    conversationId: localAttempt.conversationId,
    blocks: [{ type: "text", text: "Completed local items 1-2 cleanly." }],
    replyTo: localAttempt.inputMessageId,
    status: "complete",
  });
  await a.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [localAttempt.inputMessageId, localAttempt.botId]);

  const remoteAttempt = remoteTicket.attempts.at(-1)!;
  const payload = Buffer.from("console.log('batch-part-2');\n");
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const savedAttachment = await b.attachments.create("owner", {
    conversationId: remoteAttempt.conversationId,
    name: "remote_script.js",
    mime: "text/javascript",
    size: payload.length,
    sha256,
  });
  await b.attachments.putChunk("owner", savedAttachment.id, 0, payload);
  await b.attachments.complete("owner", savedAttachment.id);
  await b.store.publishBotMessage(remoteAttempt.botId, {
    conversationId: remoteAttempt.conversationId,
    blocks: [
      { type: "text", text: "Completed remote items 3-4 on studio-b." },
      { type: "file", attachmentId: savedAttachment.id, name: "remote_script.js", mime: "text/javascript", size: payload.length },
    ],
    replyTo: remoteAttempt.inputMessageId,
    status: "complete",
  });
  await b.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [remoteAttempt.inputMessageId, remoteAttempt.botId]);

  // Both tickets settle while the originating group is archived. Delivery resumes there after unarchiving.
  await a.store.updateConversation("owner", origin.id, { archived: true });
  await a.dispatch.sweep();
  const updatedLocal = await a.dispatch.show(owner, localTicket.id);
  const updatedRemote = await a.dispatch.show(owner, remoteTicket.id);
  expect(updatedLocal.status).toBe("needs_review");
  expect(updatedRemote.status).toBe("needs_review");
  expect(updatedRemote.result).toContain("Completed remote items 3-4 on studio-b.");
  expect(updatedRemote.artifacts).toHaveLength(1);
  expect(updatedRemote.artifacts![0]!.localAttachmentId).toBeTruthy();

  // Verify downloaded attachment bytes exist in Hub A's attachment store.
  const downloadedMeta = await a.attachments.download({ userId: "owner" }, updatedRemote.artifacts![0]!.localAttachmentId!);
  expect(downloadedMeta.row).toMatchObject({ name: "remote_script.js", size: payload.length, sha256 });

  expect(await a.store.db.get("SELECT 1 FROM dispatch_batch_summaries WHERE batch_id=?", [plan.batchId])).toBeUndefined();
  expect(await a.store.db.get("SELECT 1 FROM messages WHERE conversation_id=? AND blocks_json LIKE '%Completed remote items 3-4 on studio-b.%'", [origin.id])).toBeUndefined();
  await a.store.updateConversation("owner", origin.id, { archived: false });
  await a.dispatch.sweep();

  // The remote notice and the one summary belong to the originating group.
  const msgs1 = await a.store.db.all<{ id: string; blocks_json: string }>("SELECT id,blocks_json FROM messages WHERE conversation_id=? ORDER BY created_at,rowid", [origin.id]);
  const localMessage = msgs1.find(message => message.blocks_json.includes("Completed local items 1-2 cleanly."))!;
  expect((await a.store.messageForUser("owner", localMessage.id)).botSource).toEqual({
    hostId: macId, hostName: "macmini", botId: "w_local_codex", botName: "Chancellor · codex", requestId: localTicket.id, hops: 1,
  });
  expect(msgs1.some(message => message.blocks_json.includes("Completed remote items 3-4 on studio-b."))).toBe(true);
  expect(await a.store.db.get("SELECT 1 FROM messages WHERE conversation_id=? AND blocks_json LIKE '%Completed remote items 3-4 on studio-b.%'", [defaultChat.id])).toBeUndefined();
  const summaryMsgs = msgs1.filter(m => m.blocks_json.includes("跨主机任务汇总"));
  expect(summaryMsgs).toHaveLength(1);
  expect(await a.store.messageForUser("owner", summaryMsgs[0]!.id)).toMatchObject({ authorType: "bot", authorId: "d" });
  expect((await a.store.messageForUser("owner", summaryMsgs[0]!.id)).botSource).toBeUndefined();
  expect(summaryMsgs[0]!.blocks_json).toContain("macmini");
  expect(summaryMsgs[0]!.blocks_json).toContain("studio-b");
  expect(summaryMsgs[0]!.blocks_json).toContain(updatedRemote.artifacts![0]!.localAttachmentId!);

  // Re-sweeping never duplicates the summary.
  await a.dispatch.sweep();
  const msgs2 = await a.store.db.all<{ id: string }>("SELECT id FROM messages WHERE conversation_id=? AND blocks_json LIKE '%跨主机任务汇总%'", [origin.id]);
  expect(msgs2).toHaveLength(1);
});

it.each([
  { delivery: "immediate", outcome: "completed" },
  { delivery: "immediate", outcome: "failed" },
  { delivery: "after restart", outcome: "completed" },
  { delivery: "after restart", outcome: "failed" },
  { delivery: "legacy pending with matching attempt", outcome: "failed" },
  { delivery: "legacy pending without matching attempt", outcome: "completed" },
] as const)("attributes a $outcome remote result delivered $delivery", async ({ delivery, outcome }) => {
  await a.dispatch.stop();
  await authorizeStudioFromMac();
  const ticket = await a.dispatch.create(owner, "d", { requestId: "source-create", title: "Example task", request: "Prepare example output" });
  const working = await a.dispatch.dispatch(owner, "d", { requestId: "source-run", ticketId: ticket.id, engine: "codex", hostId: studioId });
  const attempt = working.attempts.at(-1)!;
  expect(attempt).toMatchObject({ hostId: studioId, hostName: "studio-b", botId: "w_remote_codex", remoteBotName: "Remote · codex" });
  // The status reply supplies result text. The sender is the identity recorded at dispatch.
  await b.store.db.run("UPDATE bots SET name='Renamed worker' WHERE id=?", [attempt.botId]);
  const text = `Example result: ${outcome}`;
  await b.store.publishBotMessage(attempt.botId, {
    conversationId: attempt.conversationId, replyTo: attempt.inputMessageId,
    blocks: [{ type: "text", text }], status: outcome === "completed" ? "complete" : "error",
  });
  await b.store.db.run("UPDATE deliveries SET status=? WHERE message_id=? AND bot_id=?",
    [outcome === "completed" ? "accepted" : "failed", attempt.inputMessageId, attempt.botId]);

  const deferred = delivery !== "immediate";
  const key = `remote_settle_${attempt.id}`;
  const pendingKey = `dispatch:pending-notice:${key}`;
  const clientMsgId = `tn_${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
  const resultRows = () => a.store.db.all<{ id: string }>(
    "SELECT id FROM messages WHERE conversation_id=? AND client_msg_id=?", [ticket.conversationId, clientMsgId],
  );
  if (deferred) await a.store.updateConversation("owner", ticket.conversationId, { archived: true });
  await a.dispatch.sweep();
  expect(await a.dispatch.show(owner, ticket.id)).toMatchObject({
    status: outcome === "completed" ? "needs_review" : "blocked",
    result: text,
    attempts: [{ outcome }],
  });

  if (deferred) {
    expect(await resultRows()).toEqual([]);
    const pending = await a.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [pendingKey]);
    expect(pending).toBeDefined();
    if (delivery.startsWith("legacy pending")) {
      const legacy = { ...JSON.parse(pending!.value), from: { botId: attempt.botId, botName: attempt.remoteBotName } };
      await a.store.db.run("UPDATE meta SET value=? WHERE key=?", [JSON.stringify(legacy), pendingKey]);
    }
    if (delivery === "legacy pending without matching attempt") {
      await a.store.db.run("UPDATE dispatch_tickets SET attempts_json='[]' WHERE id=?", [ticket.id]);
    }
    // Flush from the persisted database with the execution Hub offline.
    await b.close();
    await a.close();
    a = await HubServer.start({ stateDir: aDir });
    await a.dispatch.stop();
    await a.store.updateConversation("owner", ticket.conversationId, { archived: false });
    await a.dispatch.sweep();
  }

  const expectedSource = delivery === "legacy pending without matching attempt"
    ? { hostId: macId, hostName: "macmini", botId: "d", botName: "Chancellor" }
    : { hostId: studioId, hostName: "studio-b", botId: "w_remote_codex", botName: "Remote · codex" };
  const rows = await resultRows();
  expect(rows).toHaveLength(1);
  const message = await a.store.messageForUser("owner", rows[0]!.id);
  expect(message.blocks).toEqual([expect.objectContaining({ type: "text", text: expect.stringContaining(text) })]);
  expect(message.botSource).toEqual({ ...expectedSource, requestId: ticket.id, hops: 1 });
  expect(await a.store.db.get("SELECT 1 FROM meta WHERE key=?", [pendingKey])).toBeUndefined();
  await a.dispatch.sweep();
  expect(await resultRows()).toEqual(rows);
});

it("negotiates strict legacy ticket and settings payloads and preserves node settings on legacy writes", async () => {
  const preview = await a.dispatch.plan(owner, "d", {
    requestId: "legacy-plan", request: "Review one item", engine: "codex", create: true, hostIds: [macId],
  });
  const ticket = await a.dispatch.dispatch(owner, "d", {
    requestId: "legacy-run", ticketId: preview.tickets![0]!.id, engine: "codex", hostId: macId,
  });
  const close = await startHubControl(aDir,
    { running: true, pid: process.pid, url: a.url, instanceUrl: a.instanceUrl, publicKey: a.auth.publicKey },
    () => {}, { enrollController: value => a.enrollLocalController(value) });
  const client = await LocalHostClient.connect(aDir, { enroll: true });
  try {
    const legacy = await client.request<DispatchTicket>(`/api/tickets/${ticket.id}`);
    expect(legacy).not.toHaveProperty("batchId");
    expect(legacy).not.toHaveProperty("hostId");
    expect(legacy.attempts[0]).not.toHaveProperty("hostId");
    const modern = await client.request<DispatchTicket>(`/api/tickets/${ticket.id}?crossHostDispatch=1`);
    expect(modern).toMatchObject({ batchId: ticket.batchId, hostId: macId, attempts: [{ hostId: macId }] });
    for (const query of ["?open=1&summary=1", "?summary=1&capabilities=1"]) {
      const overview = await client.request<{ tickets: DispatchTicket[] }>(`/api/bots/d/tickets${query}`);
      expect(overview.tickets[0]?.attempts[0]).not.toHaveProperty("hostId");
    }
    const settings = await client.request<{ settings: ReturnType<typeof defaultDispatcherSettings>; revision: string }>("/api/bots/d/dispatcher");
    expect(settings.settings).not.toHaveProperty("nodes");
    const saved = await client.request<typeof settings>("/api/bots/d/dispatcher", "PUT", {
      settings: { ...settings.settings, maxConcurrent: 3 }, expectedRevision: settings.revision,
    });
    expect(saved.settings).toEqual({ mode: "auto", maxConcurrent: 3 });
    const current = await a.dispatch.settings("owner", "d");
    expect(current.settings.nodes).toHaveLength(2);
  } finally {
    client.close();
    await close();
  }
});

it("preserves completed remote batches and reassigns unfinished batches when a remote Host goes offline", async () => {
  await authorizeStudioFromMac();

  // Batch 1 & Batch 2 both run concurrently on studio-b (maxConcurrent=2); Batch 1 finishes, then studio-b goes offline midway.
  const failoverPlan = await a.dispatch.plan(owner, "d", {
    requestId: "plan-failover",
    title: "Failover batch",
    request: "Split into 2 parts",
    engine: "codex",
    items: ["Part 1 work", "Part 2 work"],
    hostIds: [studioId],
    create: true,
    dispatch: true,
  });
  const [t1, t2] = failoverPlan.tickets!;
  expect(t1!.status).toBe("working");
  expect(t2!.status).toBe("working");
  const a1 = t1!.attempts.at(-1)!;
  await b.store.publishBotMessage(a1.botId, { conversationId: a1.conversationId, blocks: [{ type: "text", text: "Part 1 already done on studio-b" }], replyTo: a1.inputMessageId, status: "complete" });
  await b.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [a1.inputMessageId, a1.botId]);
  await a.dispatch.sweep();
  expect((await a.dispatch.show(owner, t1!.id)).status).toBe("needs_review");

  // Shut down Hub B (studio-b goes offline while Part 2 is still running).
  await b.close();
  a.dispatch.remoteOfflineThreshold = 0;

  await a.dispatch.sweep();

  // Finished batch 1 stays untouched at needs_review!
  const after1 = await a.dispatch.show(owner, t1!.id);
  expect(after1.status).toBe("needs_review");
  expect(after1.hostId).toBe(studioId);

  // Unfinished batch 2 transitioned offline -> automatically reassigned onto healthy macmini!
  const after2 = await a.dispatch.show(owner, t2!.id);
  expect(after2.attempts).toHaveLength(2);
  expect(after2.attempts[0]!.failure?.category).toBe("host-offline");
  expect(after2.status).toBe("working");
  expect(after2.hostId).toBe(macId);
  expect(after2.hostName).toBe("macmini");
  const offlineNotice = await a.store.db.get<{ id: string }>(
    "SELECT id FROM messages WHERE conversation_id=? AND blocks_json LIKE ?",
    [after2.conversationId, `%【需要改派】%${after2.id}%`],
  );
  expect((await a.store.messageForUser("owner", offlineNotice!.id)).botSource).toEqual({
    hostId: macId, hostName: "macmini", botId: "d", botName: "Chancellor", requestId: after2.id, hops: 1,
  });

  // Bulk pause -> resume -> cancel across all open batch tickets.
  await a.dispatch.bulkAction("owner", "d", { requestId: "bulk-pause", action: "pause" });
  expect((await a.dispatch.show(owner, t2!.id)).paused).toBe(true);
  await a.dispatch.bulkAction("owner", "d", { requestId: "bulk-resume", action: "resume" });
  expect((await a.dispatch.show(owner, t2!.id)).paused).toBe(false);
  await a.dispatch.bulkAction("owner", "d", { requestId: "bulk-cancel", action: "cancel" });
  expect(["cancelled", "working"]).toContain((await a.dispatch.show(owner, t2!.id)).status);
});

it("guards ask-mode split plans, supports remote stop over TLS, and exposes CLI nodes/plan subcommands", async () => {
  await authorizeStudioFromMac();

  // Switch dispatcher to ask mode -> bot actor cannot pass dispatch: true directly without owner confirmation.
  const currentSettings = await a.dispatch.settings("owner", "d");
  await a.dispatch.updateSettings("owner", "d", {
    settings: { ...currentSettings.settings, mode: "ask" },
    expectedRevision: currentSettings.revision,
  });

  // Start an active turn on the dispatcher so bot actor authorization passes context checks.
  const home = (await a.store.conversations("owner")).find(c => c.botIds.includes("d"))!;
  const msg = await a.store.sendMessage("owner", { conversationId: home.id, clientMsgId: "turn-ask", text: "请拆分并跨机写 4 个脚本", attachments: [] });
  await a.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id='d'", [msg.message.id]);

  await expect(a.dispatch.plan(
    { kind: "bot", botId: "d", contextMessage: msg.message.id },
    "d",
    { requestId: "ask-guard", request: "写 4 个脚本，每台机器 2 个", engine: "codex", create: true, dispatch: true },
  )).rejects.toThrow("dispatch_confirmation_required");

  // Previewing split plan in ask mode returns requiresConfirmation: true and 2 balanced batches without creating tickets yet.
  const preview = await a.dispatch.plan(
    { kind: "bot", botId: "d", contextMessage: msg.message.id },
    "d",
    { requestId: "ask-preview", request: "写 4 个脚本，每台机器 2 个", engine: "codex", totalItems: 4, perNode: 2 },
  );
  expect(preview.requiresConfirmation).toBe(true);
  expect(preview.batches).toHaveLength(2);
  expect(preview.tickets).toBeUndefined();

  // Remote pause/cancel propagates to Hub B over signed TLS.
  const created = await a.dispatch.create(owner, "d", { requestId: "remote-stop-c", title: "Remote stop", request: "Long remote task" });
  const running = await a.dispatch.dispatch(owner, "d", { requestId: "remote-stop-d", ticketId: created.id, engine: "codex", hostId: studioId });
  const remoteId = running.attempts.at(-1)!.remoteTicketId!;
  await a.dispatch.action("owner", created.id, { requestId: "remote-stop-pause", action: "pause" });
  await a.dispatch.sweep();
  const stoppedLocal = await a.dispatch.show(owner, created.id);
  expect(stoppedLocal).toMatchObject({ paused: true, status: "queued" });
  const remoteRow = await b.store.db.get<{ status: string }>("SELECT status FROM remote_dispatch_tickets WHERE id=?", [remoteId]);
  expect(remoteRow?.status).toBe("cancelled");

  // Owner CLI `tickets nodes` and `tickets plan` work against the local controller socket.
  const closeA = await startHubControl(
    aDir,
    { running: true, pid: process.pid, url: a.url, instanceUrl: a.instanceUrl, publicKey: a.auth.publicKey },
    () => {},
    { enrollController: value => a.enrollLocalController(value) },
  );
  try {
    (await LocalHostClient.connect(aDir, { enroll: true })).close();
    const cliNodes = await runTicketsCommand(aDir, "nodes", undefined, {}, () => {}) as { nodes: { hostName: string; authorized: boolean }[] };
    expect(cliNodes.nodes.map(n => [n.hostName, n.authorized])).toEqual(expect.arrayContaining([["macmini", true], ["studio-b", true]]));
    const cliPlan = await runTicketsCommand(aDir, "plan", undefined, { text: "Write 6 scripts, 3 per machine", engine: "codex", force: true, host: `${macId},${studioId}` }, () => {}) as { batches: unknown[]; mode: string };
    expect(cliPlan.mode).toBe("ask");
    expect(cliPlan.batches).toHaveLength(2);

    // Per-node settings via CLI `tickets settings --host`.
    const updatedNodeSettings = await runTicketsCommand(aDir, "settings", undefined, { host: studioId, allow: "claude", allowed: "off", "max-concurrent": "1" }, () => {}) as { settings: { nodes?: Array<{ hostId: string; enabled: boolean; allowedEngines?: string[]; maxConcurrent: number }> } };
    expect(updatedNodeSettings.settings.nodes?.find(n => n.hostId === studioId)).toMatchObject({ enabled: false, allowedEngines: ["claude"], maxConcurrent: 1 });
  } finally {
    await closeA();
  }
});

it("creates only the accepted remote workspace when equivalent requests arrive concurrently", async () => {
  await authorizeStudioFromMac();
  const directory = path.join(bDir, "remote-ticket-fixture");
  await mkdir(path.join(directory, "retained"), { recursive: true });
  await writeFile(path.join(directory, "retained", "existing.txt"), "Existing work");
  let workersEntered = 0;
  let releaseWorkers!: () => void;
  const bothPastLookup = new Promise<void>(resolve => { releaseWorkers = resolve; });
  const workspace = vi.fn(async (_sourceHostId: string, ticketId: string) => {
    const selected = path.join(directory, ticketId);
    await mkdir(selected);
    return { path: selected };
  });
  const conversationCreated = vi.fn();
  const context: RemoteDispatchContext = {
    store: b.store, auth: b.auth, network: b.network, attachments: b.attachments, conversationCreated,
    stop: async () => undefined,
    workers: {
      catalog: b.dispatch.workers!.catalog,
      remoteDispatchWorker: async () => {
        if (++workersEntered === 2) releaseWorkers();
        await bothPastLookup;
        return "w_remote_codex";
      },
      remoteTicketWorkspace: workspace,
    },
  };
  const source = { hostId: macId, hostName: "Source", botId: "d", botName: "Dispatcher", requestId: "remote_call", hops: 1 };
  const payload = { remoteRequestId: "same_remote_request", title: "Fixture work", request: "Complete the fixture task", engine: "codex", model: "", effort: "" };
  const run = (input = payload) => handleRemoteDispatchRequest(
    context, a.auth.publicKey, source, REMOTE_DISPATCH_TARGET_BOT, "/api/bot-messages/dispatch/run", input,
  );

  const [first, second] = await Promise.all([run(), run()]);
  expect(second).toEqual(first);
  const accepted = first as { remoteTicketId: string; conversationId: string; messageId: string };
  expect(workersEntered).toBe(2);
  expect(workspace).toHaveBeenCalledExactlyOnceWith(macId, accepted.remoteTicketId);
  expect(await readdir(directory)).toEqual(expect.arrayContaining(["retained", accepted.remoteTicketId]));
  expect(await readdir(directory)).toHaveLength(2);
  expect(conversationCreated).toHaveBeenCalledTimes(1);
  expect(await b.store.db.all("SELECT id, conversation_id, input_message_id FROM remote_dispatch_tickets")).toEqual([
    { id: accepted.remoteTicketId, conversation_id: accepted.conversationId, input_message_id: accepted.messageId },
  ]);

  await expect(run({ ...payload, request: "A different task" })).rejects.toThrow("idempotency_conflict");
  context.workerCapable = () => false;
  await expect(run({ ...payload, remoteRequestId: "unsupported_worker" })).rejects.toThrow("bot_message_worker_update_required");
  expect(workspace).toHaveBeenCalledTimes(1);
});

it("cleans up an exclusively created remote workspace if its ticket transaction rolls back", async () => {
  await authorizeStudioFromMac();
  const manager = new BotManager(b.store, bDir, { entrypoint: path.resolve("tests/fixtures/managed-bot-worker.mjs") }, () => b.instanceUrl, async () => {});
  const workspace = vi.spyOn(manager, "remoteTicketWorkspace");
  const directory = path.join(bDir, "remote-dispatch", macId, "tickets");
  await mkdir(path.join(directory, "retained"), { recursive: true });
  await writeFile(path.join(directory, "retained", "existing.txt"), "Existing work");
  const originalExec = b.store.db.exec.bind(b.store.db);
  let failCommit = true;
  const exec = vi.spyOn(b.store.db, "exec").mockImplementation(async sql => {
    if (sql === "COMMIT" && failCommit && workspace.mock.calls.length > 0) {
      failCommit = false;
      throw new Error("Synthetic transaction failure");
    }
    return originalExec(sql);
  });
  const created = vi.fn();
  const run = () => handleRemoteDispatchRequest(
    {
      store: b.store, auth: b.auth, network: b.network, attachments: b.attachments, conversationCreated: created,
      stop: async () => undefined,
      workers: {
        catalog: b.dispatch.workers!.catalog,
        remoteDispatchWorker: async () => "w_remote_codex",
        remoteTicketWorkspace: manager.remoteTicketWorkspace.bind(manager),
      },
    },
    a.auth.publicKey, { hostId: macId, hostName: "Source", botId: "d", botName: "Dispatcher", requestId: "rollback_call", hops: 1 },
    REMOTE_DISPATCH_TARGET_BOT, "/api/bot-messages/dispatch/run",
    { remoteRequestId: "rollback_retry", title: "Fixture work", request: "Complete the fixture task", engine: "codex", model: "", effort: "" },
  );
  try {
    await expect(run()).rejects.toThrow("Synthetic transaction failure");
    expect(workspace).toHaveBeenCalledTimes(1);
    expect(await b.store.db.all("SELECT id FROM remote_dispatch_tickets")).toEqual([]);
    expect(await readdir(directory)).toEqual(["retained"]);
    expect(created).not.toHaveBeenCalled();

    const accepted = await run() as { remoteTicketId: string };
    expect(await b.store.db.all("SELECT id FROM remote_dispatch_tickets")).toEqual([{ id: accepted.remoteTicketId }]);
    expect(await readdir(directory)).toEqual(["retained", accepted.remoteTicketId].sort());
    expect(created).toHaveBeenCalledTimes(1);
  } finally {
    exec.mockRestore();
    workspace.mockRestore();
    await manager.close();
  }
});

it("blocks ordinary Bot chat grants from escalating to remote dispatch, enforces isBotControl, model regex, effort checks, and rate limits", async () => {
  await b.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,role) VALUES('ordinary_b','Ordinary B','fixture','claude','','','')");
  await b.botMessages.grant({ sourceHost: macId, sourceBot: "d", targetBot: "ordinary_b" }, async () => undefined);

  const peers = (await a.network.view()).membership!.manifest.hosts.filter(h => h.publicKey !== a.auth.publicKey);
  const peerB = peers[0]!;
  const sendSigned = async (targetBot: string, routePath: string, data: Record<string, unknown>) => {
    const body = Buffer.from(JSON.stringify(data));
    const passport: BotPassport = {
      v: 1,
      sourceKey: a.auth.publicKey,
      targetKey: peerB.publicKey,
      source: { hostId: macId, hostName: "macmini", botId: "d", botName: "Chancellor", requestId: `sec_${randomUUID().slice(0, 12)}`, hops: 1 },
      targetBot,
      method: "POST",
      path: routePath,
      digest: createHash("sha256").update(body).digest("hex"),
      expiresAt: Date.now() + BOT_PASSPORT_TTL_MS,
      nonce: randomUUID(),
    };
    return a.botMessages.exchange(peerB, { passport, signature: a.auth.signBotPassport(passport) }, body);
  };

  // Ordinary chat grant cannot invoke dispatch probe or run on ordinary_b.
  await expect(sendSigned("ordinary_b", "/api/bot-messages/dispatch/probe", {})).rejects.toThrow("bot_message_operation_forbidden");
  await expect(sendSigned("ordinary_b", "/api/bot-messages/dispatch/run", {
    remoteRequestId: "esc_1", title: "Escalate", request: "/model gpt-5", engine: "codex",
  })).rejects.toThrow("bot_message_operation_forbidden");
  expect((await b.store.conversations("owner")).some(c => c.botIds.includes("ordinary_b"))).toBe(false);

  // Even after explicit dispatch grant, slash-command control inputs and option-like models / invalid efforts are rejected.
  await authorizeStudioFromMac();
  expect(() => remoteDispatchRunRequestSchema.parse({
    remoteRequestId: "bad_model", title: "Bad", request: "Work", engine: "codex", model: "--dangerously-skip-permissions --foo=bar", effort: "",
  })).toThrow();
  await expect(sendSigned(REMOTE_DISPATCH_TARGET_BOT, "/api/bot-messages/dispatch/run", {
    remoteRequestId: "bad_model_wire", title: "Bad", request: "Work", engine: "codex", model: "--dangerously-skip-permissions", effort: "",
  })).rejects.toThrow();
  await expect(sendSigned(REMOTE_DISPATCH_TARGET_BOT, "/api/bot-messages/dispatch/run", {
    remoteRequestId: "bad_effort_wire", title: "Bad Effort", request: "Work", engine: "codex", model: "gpt-5", effort: "max",
  })).rejects.toThrow("dispatch_effort_incompatible");
  await expect(sendSigned(REMOTE_DISPATCH_TARGET_BOT, "/api/bot-messages/dispatch/run", {
    remoteRequestId: "bad_ctrl", title: "Slash", request: "/model gpt-5", engine: "codex", model: "", effort: "",
  })).rejects.toThrow("bot_message_control_forbidden");

  // Rate limit blocks runaway dispatch bursts (20/min).
  for (let i = 0; i < 20; i++) {
    await sendSigned(REMOTE_DISPATCH_TARGET_BOT, "/api/bot-messages/dispatch/run", {
      remoteRequestId: `rate_${i}`, title: `Rate ${i}`, request: `Task ${i}`, engine: "codex", model: "", effort: "",
    });
  }
  await expect(sendSigned(REMOTE_DISPATCH_TARGET_BOT, "/api/bot-messages/dispatch/run", {
    remoteRequestId: "rate_20", title: "Rate 20", request: "Task 20", engine: "codex", model: "", effort: "",
  })).rejects.toThrow("bot_message_rate_limit");
}, 30_000);

it("copies local worker attachments into home conversation and downloads >1 MiB remote attachments cleanly for batch summary", async () => {
  await authorizeStudioFromMac();
  const plan = await a.dispatch.plan(owner, "d", {
    requestId: "big-attachments",
    title: "Artifacts batch",
    request: "Write 4 items, 2 per machine",
    engine: "codex",
    totalItems: 4,
    perNode: 2,
    dispatch: true, // Also verifies dispatch: true implies create: true.
  });
  expect(plan.tickets).toHaveLength(2);
  const byHost = new Map(plan.tickets!.map(t => [t.hostId!, t]));
  const localTicket = byHost.get(macId)!;
  const remoteTicket = byHost.get(studioId)!;

  // Local worker attaches a file inside its hidden worker conversation.
  const localAttempt = localTicket.attempts.at(-1)!;
  const localBytes = Buffer.from("local-output");
  const localSha = createHash("sha256").update(localBytes).digest("hex");
  const localAtt = await a.attachments.create("owner", {
    conversationId: localAttempt.conversationId, name: "local.txt", mime: "text/plain", size: localBytes.length, sha256: localSha,
  });
  await a.attachments.putChunk("owner", localAtt.id, 0, localBytes);
  await a.attachments.complete("owner", localAtt.id);
  await a.store.publishBotMessage(localAttempt.botId, {
    conversationId: localAttempt.conversationId,
    blocks: [{ type: "text", text: "Local done" }, { type: "file", attachmentId: localAtt.id, name: "local.txt", mime: "text/plain", size: localBytes.length }],
    replyTo: localAttempt.inputMessageId, status: "complete",
  });
  await a.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [localAttempt.inputMessageId, localAttempt.botId]);

  // Remote worker attaches a 1.5 MiB file (> 1 MiB slice size, requires reassembly into CHUNK_BYTES).
  const remoteAttempt = remoteTicket.attempts.at(-1)!;
  const remoteBytes = randomBytes(1_536_000);
  const remoteSha = createHash("sha256").update(remoteBytes).digest("hex");
  const remoteAtt = await b.attachments.create("owner", {
    conversationId: remoteAttempt.conversationId, name: "large.bin", mime: "application/octet-stream", size: remoteBytes.length, sha256: remoteSha,
  });
  await b.attachments.putChunk("owner", remoteAtt.id, 0, remoteBytes);
  await b.attachments.complete("owner", remoteAtt.id);
  await b.store.publishBotMessage(remoteAttempt.botId, {
    conversationId: remoteAttempt.conversationId,
    blocks: [{ type: "text", text: "Remote 1.5 MiB done" }, { type: "file", attachmentId: remoteAtt.id, name: "large.bin", mime: "application/octet-stream", size: remoteBytes.length }],
    replyTo: remoteAttempt.inputMessageId, status: "complete",
  });
  await b.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [remoteAttempt.inputMessageId, remoteAttempt.botId]);

  await a.dispatch.sweep();

  const settledLocal = await a.dispatch.show(owner, localTicket.id);
  const settledRemote = await a.dispatch.show(owner, remoteTicket.id);
  expect(settledLocal.artifacts?.[0]?.localAttachmentId).toBeTruthy();
  expect(settledLocal.artifacts![0]!.localAttachmentId).not.toBe(localAtt.id);
  expect(settledRemote.artifacts?.[0]?.localAttachmentId).toBeTruthy();

  const dlRemote = await a.attachments.download({ userId: "owner" }, settledRemote.artifacts![0]!.localAttachmentId!);
  expect(dlRemote.row).toMatchObject({ name: "large.bin", size: 1_536_000, sha256: remoteSha });

  // Consolidated batch summary published with BOTH local and remote home-conversation attachments!
  const summaryRow = await a.store.db.get<{ message_id: string }>("SELECT message_id FROM dispatch_batch_summaries WHERE batch_id=?", [plan.batchId]);
  expect(summaryRow).toBeTruthy();
  const summaryMsg = await a.store.messageForUser("owner", summaryRow!.message_id);
  const attachedIds = summaryMsg.blocks.filter(bl => bl.type === "file").map(bl => bl.attachmentId);
  expect(attachedIds).toEqual(expect.arrayContaining([settledLocal.artifacts![0]!.localAttachmentId!, settledRemote.artifacts![0]!.localAttachmentId!]));

  // Duplicate importAttachment short-circuits cleanly without 409 upload_complete, and missing sha256 rejects before create().
  const home = (await a.store.conversations("owner")).find(c => c.botIds.includes("d"))!;
  const dupId = await a.dispatch.remote!.importAttachment(home.id, "owner", { id: "dup", name: "large.bin", size: remoteBytes.length, mime: "application/octet-stream", sha256: remoteSha }, async () => { throw new Error("should_not_read"); });
  expect(dupId).toBe(settledRemote.artifacts![0]!.localAttachmentId);
  const attCountBefore = (await a.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM attachments"))!.n;
  await expect(a.dispatch.remote!.importAttachment(home.id, "owner", { id: "nosha", name: "x.txt", size: 5, mime: "text/plain" }, async () => Buffer.from("hello"))).rejects.toThrow("remote_attachment_sha256_required");
  expect((await a.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM attachments"))!.n).toBe(attCountBefore);
});

it("preserves engine, model, effort, and force during offline failover and enforces node enabled / concurrency / orphan cleanup", async () => {
  await authorizeStudioFromMac();

  // Disabled node is rejected on both remote and local dispatch.
  const cur = await a.dispatch.settings("owner", "d");
  await a.dispatch.updateSettings("owner", "d", {
    settings: { ...cur.settings, nodes: [{ hostId: macId, enabled: false, maxConcurrent: 2, preference: "normal" }, { hostId: studioId, enabled: false, maxConcurrent: 1, preference: "normal" }] },
    expectedRevision: cur.revision,
  });
  const tDisabled = await a.dispatch.create(owner, "d", { requestId: "dis-1", title: "Disabled node", request: "Work" });
  await expect(a.dispatch.dispatch(owner, "d", { requestId: "dis-r", ticketId: tDisabled.id, engine: "claude", hostId: studioId })).rejects.toThrow("dispatch_node_disabled");
  await expect(a.dispatch.dispatch(owner, "d", { requestId: "dis-l", ticketId: tDisabled.id, engine: "claude" })).rejects.toThrow("dispatch_node_disabled");

  // Re-enable both with studio maxConcurrent=1 to test concurrent dispatch limit & orphan stop cleanup.
  const cur2 = await a.dispatch.settings("owner", "d");
  await a.dispatch.updateSettings("owner", "d", {
    settings: { ...cur2.settings, nodes: [{ hostId: macId, enabled: true, maxConcurrent: 2, preference: "normal" }, { hostId: studioId, enabled: true, maxConcurrent: 1, preference: "normal" }] },
    expectedRevision: cur2.revision,
  });
  const c1 = await a.dispatch.create(owner, "d", { requestId: "conc-1", title: "Conc 1", request: "Work 1" });
  const c2 = await a.dispatch.create(owner, "d", { requestId: "conc-2", title: "Conc 2", request: "Work 2" });
  const [r1, r2] = await Promise.allSettled([
    a.dispatch.dispatch(owner, "d", { requestId: "conc-d1", ticketId: c1.id, engine: "claude", hostId: studioId }),
    a.dispatch.dispatch(owner, "d", { requestId: "conc-d2", ticketId: c2.id, engine: "claude", hostId: studioId }),
  ]);
  expect([r1.status, r2.status].sort()).toEqual(["fulfilled", "rejected"]);

  // Re-dispatching a previously remote ticket locally without --host clears stale studio-b hostId/hostName.
  const winner = r1.status === "fulfilled" ? r1.value : (r2 as PromiseFulfilledResult<DispatchTicket>).value;
  const winRemoteAttempt = winner.attempts.at(-1)!;
  await b.store.publishBotMessage(winRemoteAttempt.botId, { conversationId: winRemoteAttempt.conversationId, blocks: [{ type: "text", text: "Done on studio" }], replyTo: winRemoteAttempt.inputMessageId, status: "complete" });
  await b.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [winRemoteAttempt.inputMessageId, winRemoteAttempt.botId]);
  await a.dispatch.sweep();
  const localFollowup = await a.dispatch.dispatch(owner, "d", { requestId: "local-followup", ticketId: winner.id, engine: "claude", text: "Continue locally" });
  expect(localFollowup.hostId).toBe(macId);
  expect(localFollowup.hostName).toBe("macmini");
  expect(localFollowup.attempts.at(-1)?.hostId).toBe(macId);

  // Post-RPC commit failure (e.g., ticket paused concurrently) sends compensating /stop so no orphan remote run remains.
  const tOrphan = await a.dispatch.create(owner, "d", { requestId: "orphan-c", title: "Orphan check", request: "Pause mid-RPC" });
  const origCallPeer = a.dispatch.remote!.callPeer;
  let pausedDuringRpc = false;
  const orphanSpy = vi.spyOn(a.dispatch.remote!, "callPeer").mockImplementation(async (host, sourceBot, routePath, data, requestId) => {
    const res = await origCallPeer(host, sourceBot, routePath, data, requestId);
    if (routePath === "/api/bot-messages/dispatch/run" && !pausedDuringRpc) {
      pausedDuringRpc = true;
      await a.dispatch.action("owner", tOrphan.id, { requestId: "orphan-pause", action: "pause" });
    }
    return res;
  });
  await expect(a.dispatch.dispatch(owner, "d", { requestId: "orphan-d", ticketId: tOrphan.id, engine: "claude", hostId: studioId })).rejects.toThrow("ticket_paused");
  orphanSpy.mockRestore();
  const orphanRow = await b.store.db.get<{ status: string }>("SELECT status FROM remote_dispatch_tickets WHERE title='Orphan check'");
  expect(orphanRow?.status).toBe("cancelled");

  // Offline auto-failover preserves engine="claude", model="claude-sonnet-4-6", effort="high", force=true.
  const failoverPlan = await a.dispatch.plan(owner, "d", {
    requestId: "failover-claude",
    title: "Claude failover",
    request: "Single remote task",
    engine: "claude",
    model: "claude-sonnet-4-6",
    effort: "high",
    force: true,
    hostIds: [studioId],
    create: true,
    dispatch: true,
  });
  const fTicket = failoverPlan.tickets![0]!;
  expect(fTicket.hostId).toBe(studioId);
  await b.close();
  a.dispatch.remoteOfflineThreshold = 0;
  await a.dispatch.sweep();
  const failedOver = await a.dispatch.show(owner, fTicket.id);
  expect(failedOver.status).toBe("working");
  expect(failedOver.hostId).toBe(macId);
  expect(failedOver.attempts.at(-1)).toMatchObject({ engine: "claude", model: "claude-sonnet-4-6", effort: "high" });
});

it("handles remote stop races, prompt-queue stop replay withholding, waitingFor clear, scopedRun errors, >200 replies, and blocked batches", async () => {
  await authorizeStudioFromMac();

  // 1. Remote pause racing with completion preserves result and artifacts!
  const tRace = await a.dispatch.create(owner, "d", { requestId: "race-c", title: "Race complete", request: "Finish fast" });
  const runningRace = await a.dispatch.dispatch(owner, "d", { requestId: "race-d", ticketId: tRace.id, engine: "codex", hostId: studioId });
  const raceAtt = runningRace.attempts.at(-1)!;
  const raceBytes = Buffer.from("important-artifact");
  const raceSha = createHash("sha256").update(raceBytes).digest("hex");
  const raceFile = await b.attachments.create("owner", { conversationId: raceAtt.conversationId, name: "result.txt", mime: "text/plain", size: raceBytes.length, sha256: raceSha });
  await b.attachments.putChunk("owner", raceFile.id, 0, raceBytes);
  await b.attachments.complete("owner", raceFile.id);
  await b.store.publishBotMessage(raceAtt.botId, {
    conversationId: raceAtt.conversationId,
    blocks: [{ type: "text", text: "IMPORTANT COMPLETED RESULT" }, { type: "file", attachmentId: raceFile.id, name: "result.txt", mime: "text/plain", size: raceBytes.length }],
    replyTo: raceAtt.inputMessageId, status: "complete",
  });
  await b.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [raceAtt.inputMessageId, raceAtt.botId]);
  await a.dispatch.action("owner", tRace.id, { requestId: "race-pause", action: "pause" });
  await a.dispatch.sweep();
  const afterRace = await a.dispatch.show(owner, tRace.id);
  expect(afterRace).toMatchObject({ status: "needs_review", paused: true });
  expect(afterRace.result).toContain("IMPORTANT COMPLETED RESULT");
  expect(afterRace.attempts.at(-1)?.outcome).toBe("completed");
  expect(afterRace.artifacts?.[0]?.localAttachmentId).toBeTruthy();

  // 2. Remote cancel on a running (dispatched=1, pending) turn does NOT prematurely mark cancelled,
  //    transient transport failures keep retrying instead of abandoning, and prompt-queue suppresses replay!
  const tRun = await a.dispatch.create(owner, "d", { requestId: "runstop-c", title: "Running stop", request: "Still running" });
  const runningStop = await a.dispatch.dispatch(owner, "d", { requestId: "runstop-d", ticketId: tRun.id, engine: "codex", hostId: studioId });
  const stopAtt = runningStop.attempts.at(-1)!;
  await b.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id=?", [stopAtt.inputMessageId, stopAtt.botId]);
  const origPeerCall = a.dispatch.remote!.callPeer;
  const transientSpy = vi.spyOn(a.dispatch.remote!, "callPeer").mockImplementationOnce(async () => { throw new Error("ECONNRESET"); });
  await a.dispatch.action("owner", tRun.id, { requestId: "runstop-cancel", action: "cancel" });
  expect((await a.dispatch.show(owner, tRun.id)).status).toBe("working");
  transientSpy.mockRestore();
  void origPeerCall;
  await a.dispatch.sweep();
  const remoteRowWhileRunning = await b.store.db.get<{ status: string; stop_requested: string | null }>("SELECT status,stop_requested FROM remote_dispatch_tickets WHERE id=?", [stopAtt.remoteTicketId!]);
  expect(remoteRowWhileRunning).toEqual({ status: "working", stop_requested: "cancel" });
  expect((await a.dispatch.show(owner, tRun.id)).status).toBe("working");
  const queueB = new HubPromptQueue(b.store);
  const replayed = await queueB.claim(stopAtt.botId, true, true);
  expect(replayed.some(m => m.id === stopAtt.inputMessageId)).toBe(false);
  // Once the remote delivery terminates, sweep settles it to cancelled!
  await b.store.db.run("UPDATE deliveries SET status='cancelled' WHERE message_id=? AND bot_id=?", [stopAtt.inputMessageId, stopAtt.botId]);
  await a.dispatch.sweep();
  expect((await a.dispatch.show(owner, tRun.id)).status).toBe("cancelled");

  // 2b. Receiving Host notifies live dispatch.v1 clients via conversationCreated for hidden remote worker chats.
  const { handleRemoteDispatchRequest } = await import("../src/hub/dispatch-remote.js");
  const createdConvs: Array<{ userId: string; hidden?: boolean }> = [];
  await handleRemoteDispatchRequest(
    {
      store: b.store,
      auth: b.auth,
      network: b.network,
      attachments: b.attachments,
      workers: b.dispatch.workers as unknown as Parameters<typeof handleRemoteDispatchRequest>[0]["workers"],
      conversationCreated: (userId, conv) => { createdConvs.push({ userId, hidden: conv.hidden }); },
      stop: async () => undefined,
    },
    a.auth.publicKey,
    { hostId: macId, hostName: "macmini", botId: "d", botName: "Chancellor", requestId: "conv_notify_1", hops: 1 },
    REMOTE_DISPATCH_TARGET_BOT,
    "/api/bot-messages/dispatch/run",
    { remoteRequestId: "conv_notify_1", title: "Hidden notify", request: "Check live notify", engine: "codex", model: "", effort: "" },
  );
  expect(createdConvs).toEqual([{ userId: "owner", hidden: true }]);

  // 3. waitingFor clears when remote resumes from needs_answer to working; handled scopedRun error + >200 replies succeed!
  const tScope = await a.dispatch.create(owner, "d", { requestId: "scope-c", title: "Scoped + waiting", request: "Long turn" });
  const runScope = await a.dispatch.dispatch(owner, "d", { requestId: "scope-d", ticketId: tScope.id, engine: "codex", hostId: studioId });
  const scAtt = runScope.attempts.at(-1)!;
  await b.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id=?", [scAtt.inputMessageId, scAtt.botId]);
  const waitMsg = await b.store.publishBotMessage(scAtt.botId, {
    conversationId: scAtt.conversationId, replyTo: scAtt.inputMessageId, status: "complete",
    blocks: [{ type: "card", elements: [{ type: "markdown", text: "Need answer" }], extra: { nativeRun: { runId: "r1", engine: "codex", phase: "waiting_answer", revision: 1, startedAt: 1, updatedAt: 2 } } }],
  });
  await a.dispatch.sweep();
  expect((await a.dispatch.show(owner, tScope.id)).attempts.at(-1)?.waitingFor).toEqual({ kind: "answer", messageId: waitMsg.id });
  // Owner answers -> phase returns to running -> waitingFor must clear!
  await b.store.publishBotMessage(scAtt.botId, {
    id: waitMsg.id, conversationId: scAtt.conversationId, replyTo: scAtt.inputMessageId, status: "complete", version: 2,
    blocks: [{ type: "card", elements: [{ type: "markdown", text: "Running again" }], extra: { nativeRun: { runId: "r1", engine: "codex", phase: "running", revision: 2, startedAt: 1, updatedAt: 3 } } }],
  });
  await a.dispatch.sweep();
  expect((await a.dispatch.show(owner, tScope.id)).attempts.at(-1)?.waitingFor).toBeUndefined();
  // Add a handled scopedRun error + 205 replies + final done nativeRun!
  await b.store.publishBotMessage(scAtt.botId, {
    conversationId: scAtt.conversationId, replyTo: scAtt.inputMessageId, status: "complete",
    blocks: [{ type: "card", elements: [{ type: "markdown", text: "Subagent handled error" }], extra: { scopedRun: { runId: "sub1", engine: "codex", phase: "error", revision: 1, startedAt: 1, updatedAt: 4 } } }],
  });
  for (let i = 0; i < 205; i++) {
    await b.store.publishBotMessage(scAtt.botId, {
      conversationId: scAtt.conversationId, replyTo: scAtt.inputMessageId, status: "complete",
      blocks: [{ type: "text", text: `chunk-${i}` }],
    });
  }
  await b.store.publishBotMessage(scAtt.botId, {
    id: waitMsg.id, conversationId: scAtt.conversationId, replyTo: scAtt.inputMessageId, status: "complete", version: 3,
    blocks: [{ type: "card", elements: [{ type: "markdown", text: "Done" }], extra: { nativeRun: { runId: "r1", engine: "codex", phase: "done", revision: 3, startedAt: 1, updatedAt: 5, endedAt: 5 } } }],
  });
  await b.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [scAtt.inputMessageId, scAtt.botId]);
  await a.dispatch.sweep();
  const afterScope = await a.dispatch.show(owner, tScope.id);
  expect(afterScope.status).toBe("needs_review");
  expect(afterScope.result).toContain("chunk-204");

  // 4. maybePublishBatchSummary does NOT freeze while a batch ticket is blocked, and publishes once retried and completed.
  const bPlan = await a.dispatch.plan(owner, "d", {
    requestId: "blocked-batch", title: "Blocked test", request: "2 parts", engine: "codex", items: ["A", "B"], create: true, dispatch: false,
  });
  const [bt1, bt2] = bPlan.tickets!;
  await a.dispatch.update(owner, "d", { ticketId: bt1!.id, status: "needs_review" });
  await a.dispatch.update(owner, "d", { ticketId: bt2!.id, status: "blocked" });
  expect(await a.store.db.get("SELECT 1 FROM dispatch_batch_summaries WHERE batch_id=?", [bPlan.batchId])).toBeUndefined();
  await a.dispatch.update(owner, "d", { ticketId: bt2!.id, status: "needs_review" });
  await expect.poll(async () => a.store.db.get("SELECT 1 FROM dispatch_batch_summaries WHERE batch_id=?", [bPlan.batchId])).toBeTruthy();
}, 30_000);

it("fixes planner edge cases, plan idempotency, idle ask-mode probe suppression, Windows loadavg, deleted remote workers, and departed-host revocation", async () => {
  // Planner: per-node-only prompts do NOT collapse into 1 batch.
  expect(parseSplitTaskSpec("每台机器写 10 个脚本")).toEqual({ perNode: 10 });
  expect(parseSplitTaskSpec("Write 10 scripts per machine")).toEqual({ perNode: 10 });

  const mac = makeNode(macId, "macmini", { preference: "normal", maxConcurrent: 2 });
  const less = makeNode(studioId, "studio-b", { preference: "less_often", maxConcurrent: 2 });
  const manual = makeNode(`hub_${"f".repeat(64)}`, "manual-box", { preference: "manual_only" });
  const perNodePlan = planSplitBatches({ requestId: "pn1", request: "每台机器写 10 个脚本", engine: "codex", create: false, dispatch: false }, [mac, less], defaultDispatcherSettings(), "batch_pn");
  expect(perNodePlan.batches).toHaveLength(2);
  expect(perNodePlan.batches.map(b => b.itemCount)).toEqual([10, 10]);

  // Planner: explicit manual_only hostIds without engine picks an available engine.
  const manualPlan = planSplitBatches({ requestId: "man1", request: "Write 4 scripts", hostIds: [manual.hostId], create: false, dispatch: false }, [mac, manual], defaultDispatcherSettings(), "batch_man");
  expect(manualPlan.batches.length).toBeGreaterThan(0);
  expect(manualPlan.batches.every(b => b.hostId === manual.hostId)).toBe(true);

  // Planner: less_often gets fewer items than normal (not clamped to 1).
  const weighted = planSplitBatches({ requestId: "w1", request: "Write 10 scripts", engine: "codex", totalItems: 10, create: false, dispatch: false }, [mac, less], defaultDispatcherSettings(), "batch_w");
  const macItems = weighted.batches.filter(b => b.hostId === mac.hostId).reduce((s, b) => s + (b.itemCount ?? 0), 0);
  const lessItems = weighted.batches.filter(b => b.hostId === less.hostId).reduce((s, b) => s + (b.itemCount ?? 0), 0);
  expect(macItems).toBeGreaterThan(lessItems);

  // Plan idempotency conflict, long requestId/note handling, and ask-mode zero-probe idle sweep.
  await authorizeStudioFromMac();
  const s = await a.dispatch.settings("owner", "d");
  await a.dispatch.updateSettings("owner", "d", { settings: { ...s.settings, mode: "ask" }, expectedRevision: s.revision });
  const longReqId = `plan_${"x".repeat(120)}`;
  const createdPlan = await a.dispatch.plan(owner, "d", { requestId: longReqId, request: "Write 4 scripts, 2 per machine", engine: "codex", create: true, dispatch: false });
  expect(createdPlan.tickets).toHaveLength(2);
  await a.dispatch.update(owner, "d", { ticketId: createdPlan.tickets![0]!.id, note: "n".repeat(400) });
  await expect(a.dispatch.plan(owner, "d", { requestId: longReqId, request: "DIFFERENT request", engine: "codex", create: true, dispatch: false })).rejects.toThrow("idempotency_conflict");

  // Unapproved ask-mode queued batch must NOT probe peer Hosts on sweep!
  const callPeerSpy = vi.spyOn(a.dispatch.remote!, "callPeer");
  await a.dispatch.sweep();
  expect(callPeerSpy).not.toHaveBeenCalled();
  callPeerSpy.mockRestore();

  // Replaying same requestId with dispatch: true dispatches the queued tickets and truncates long reason safely.
  const dispatchedPlan = await a.dispatch.plan(owner, "d", { requestId: longReqId, request: "Write 4 scripts, 2 per machine", engine: "codex", create: true, dispatch: true });
  expect(dispatchedPlan.batches.every(bt => bt.reason.length <= 128)).toBe(true);
  expect(dispatchedPlan.tickets!.every(tk => tk.status === "working")).toBe(true);

  // readLocalHostLoad omits cpuLoadRatio on win32.
  const origPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    const winLoad = await readLocalHostLoad({ store: a.store, auth: a.auth, network: a.network, attachments: a.attachments, conversationCreated: () => {}, stop: async () => undefined }, []);
    expect(winLoad.cpuLoadRatio).toBeUndefined();
  } finally {
    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
  }

  // remoteDispatchWorker derives a new botId after deletion instead of failing with 410 bot_deleted.
  const mgr = new BotManager(b.store, bDir, { entrypoint: path.resolve("tests/fixtures/managed-bot-worker.mjs"), env: { ...process.env, CODEX_EXECUTABLE: process.execPath } }, () => b.instanceUrl, async () => undefined);
  try {
    const w1 = await mgr.remoteDispatchWorker(macId, "codex");
    await mgr.delete("owner", w1, "Remote · Codex");
    const w2 = await mgr.remoteDispatchWorker(macId, "codex");
    expect(w2).not.toBe(w1);
  } finally {
    await mgr.close();
  }

  // Departed-host dispatch grant revocation works and invalid requests do not consume the one-use proof.
  let admitted = 0;
  const admit = async () => { admitted++; };
  await expect(updateCrossHostDispatchGrants(
    { store: b.store, auth: b.auth, network: b.network, attachments: b.attachments, conversationCreated: () => {}, stop: async () => undefined },
    "owner", "dev",
    { operation: "cross-host-dispatch-grant", sourceHost: `hub_${"0".repeat(64)}`, sourceBot: "d", allowed: false },
    async () => undefined, admit,
  )).rejects.toThrow("bot_message_host_not_found");
  expect(admitted).toBe(0);
  // Remove macmini from Host B's manifest and verify residual grant can still be revoked!
  await b.store.db.run("DELETE FROM meta WHERE key='private-network:v1'");
  const afterRevoke = await updateCrossHostDispatchGrants(
    { store: b.store, auth: b.auth, network: b.network, attachments: b.attachments, conversationCreated: () => {}, stop: async () => undefined },
    "owner", "dev",
    { operation: "cross-host-dispatch-grant", sourceHost: macId, sourceBot: "d", allowed: false },
    async () => undefined, admit,
  );
  expect(admitted).toBe(1);
  expect(afterRevoke.grants).toEqual([]);

  // Database schema version is bumped to 28.
  expect(await a.store.db.get("SELECT value FROM meta WHERE key='schema_version'")).toEqual({ value: "28" });
});

it.each([
  { phase: "waiting_approval", kind: "approval", actionId: "approve", values: {} },
  { phase: "waiting_answer", kind: "answer", actionId: "answer", values: { response: "Fixture answer" } },
] as const)("routes $kind through the receiving owner's actual interaction socket only", async ({ phase, kind, actionId, values }) => {
  await authorizeStudioFromMac();
  const sockets: WebSocket[] = [];
  async function open(url: string) {
    const ws = new WebSocket(url.replace(/^http/, "ws"), { rejectUnauthorized: false });
    sockets.push(ws);
    const frames: Array<Record<string, unknown>> = [];
    ws.on("message", raw => frames.push(JSON.parse(String(raw))));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    return {
      send: (frame: object) => ws.send(JSON.stringify({ v: 1, ...frame })),
      async next(type: string, predicate: (frame: Record<string, unknown>) => boolean = () => true) {
        const find = () => frames.findIndex(frame => frame.type === type && predicate(frame));
        await expect.poll(find, { timeout: 3000 }).toBeGreaterThanOrEqual(0);
        return frames.splice(find(), 1)[0]!;
      },
    };
  }
  async function clientPeer(hub: HubServer, deviceId: string, userId = "owner") {
    const keys = generateKeyPairSync("ed25519");
    const nonce = randomBytes(32).toString("base64url");
    const pair = await hub.auth.pair({
      deviceId, name: deviceId, platform: "web",
      publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    }, deviceId);
    await hub.auth.approve(pair.code, "local-owner", userId);
    const peer = await open(hub.url + "/ws");
    peer.send({ type: "hello", deviceId, nonce, protocolVersions: [1], capabilities: ["cards.v1", "dispatch.v1"], cursors: {} });
    const challenge = await peer.next("challenge");
    peer.send({ type: "auth", signature: sign(null, deviceProof(deviceId, String(challenge.nonce), nonce), keys.privateKey).toString("base64") });
    return { ...peer, ready: await peer.next("ready") };
  }

  try {
    const ticket = await a.dispatch.create(owner, "d", { requestId: "interactive-ticket", title: "Receiving owner interaction", request: "Fixture request" });
    const running = await a.dispatch.dispatch(owner, "d", { requestId: "interactive-dispatch", ticketId: ticket.id, hostId: studioId, engine: "codex" });
    const attempt = running.attempts.at(-1)!;
    const receiver = await clientPeer(b, "receiving-owner");
    const source = await clientPeer(a, "source-owner");
    await b.store.db.run("INSERT INTO users VALUES('member','Member','member')");
    const member = await clientPeer(b, "receiving-member", "member");
    expect(member.ready.conversations).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: attempt.conversationId })]));
    expect(receiver.ready.conversations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: attempt.conversationId, hidden: true, title: ticket.title }),
    ]));
    expect(source.ready.conversations).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: attempt.conversationId })]));

    const secret = randomBytes(32).toString("base64url");
    await b.store.db.run("UPDATE bots SET secret_hash=? WHERE id=?", [hashSecret(secret), attempt.botId]);
    const worker = await open(b.instanceUrl + "/instance");
    worker.send({ type: "instance.hello", botId: attempt.botId, secret, engine: "codex", model: "", effort: "", capabilities: ["bot-messages.v1"] });
    await worker.next("instance.ready");
    expect(await worker.next("instance.message")).toMatchObject({ message: { id: attempt.inputMessageId }, conversation: { id: attempt.conversationId } });
    const message = await b.store.publishBotMessage(attempt.botId, {
      conversationId: attempt.conversationId, replyTo: attempt.inputMessageId, status: "complete",
      blocks: [{ type: "card", elements: [{ type: "button", actionId, text: "Resolve" }],
        extra: { nativeRun: { runId: "interactive-run", engine: "codex", phase, revision: 1, startedAt: 1, updatedAt: 2 } } }],
    });
    await a.dispatch.sweep();
    expect((await a.dispatch.show(owner, ticket.id)).attempts.at(-1)?.waitingFor).toEqual({ kind, messageId: message.id });

    const submit = { type: "interaction.submit", conversationId: attempt.conversationId, messageId: message.id, actionId, values };
    source.send({ ...submit, clientActionId: "source-attempt" });
    expect(await source.next("error")).toMatchObject({ code: expect.stringMatching(/^(message_not_found|conversation_forbidden)$/) });
    member.send({ ...submit, clientActionId: "member-attempt" });
    expect(await member.next("error")).toMatchObject({ code: "conversation_forbidden" });
    expect(await b.store.pendingActions(attempt.botId)).toEqual([]);
    receiver.send({ ...submit, clientActionId: "receiver-action" });
    expect(await receiver.next("interaction.ack")).toMatchObject({ clientActionId: "receiver-action" });
    const call = await worker.next("instance.call", frame => frame.method === "interaction");
    expect(call.params).toMatchObject({ userId: "owner", conversationId: attempt.conversationId, messageId: message.id, actionId, values });
    worker.send({ type: "instance.result", id: call.id, result: { ok: true } });
    await expect.poll(() => b.store.pendingActions(attempt.botId)).toEqual([]);
    worker.send({ type: "instance.request", id: "publish-running", method: "publish", params: {
      id: message.id, conversationId: attempt.conversationId, replyTo: attempt.inputMessageId, status: "complete", version: 2,
      blocks: [{ type: "card", elements: [{ type: "markdown", text: "Running again" }],
        extra: { nativeRun: { runId: "interactive-run", engine: "codex", phase: "running", revision: 2, startedAt: 1, updatedAt: 3 } } }],
    } });
    await worker.next("instance.result", frame => frame.id === "publish-running");
    await a.dispatch.sweep();
    expect((await a.dispatch.show(owner, ticket.id)).attempts.at(-1)?.waitingFor).toBeUndefined();
  } finally {
    for (const ws of sockets) ws.terminate();
  }
});

it("preserves the unsafe remote worker 409 across signed Host transport and keeps recovery details local", async () => {
  await authorizeStudioFromMac();
  const warning = vi.fn();
  const manager = new BotManager(b.store, bDir, {
    entrypoint: path.resolve("tests/fixtures/managed-bot-worker.mjs"),
    env: { ...process.env, CODEX_EXECUTABLE: process.execPath },
  }, () => b.instanceUrl, async () => {}, warning);
  try {
    const worker = await manager.remoteDispatchWorker(macId, "codex");
    await updateInstanceConfig(path.join(bDir, "bots", worker), cfg => { cfg.approvalMode = "bypass"; });
    const receiverWorkers = b.dispatch.workers!;
    const workers = { ...receiverWorkers, remoteDispatchWorker: manager.remoteDispatchWorker.bind(manager) };
    b.dispatch.workers = workers;
    const ticket = await a.dispatch.create(owner, "d", { requestId: "unsafe-create", title: "Legacy worker rejection", request: "Fixture request" });
    await expect(a.dispatch.dispatch(owner, "d", {
      requestId: "unsafe-dispatch", ticketId: ticket.id, hostId: studioId, engine: "codex",
    })).rejects.toMatchObject({ status: 409, code: "dispatch_worker_permissions_unsafe", message: "dispatch_worker_permissions_unsafe" });
    const closeControl = await startHubControl(aDir, { running: true, pid: process.pid, url: a.url, instanceUrl: a.instanceUrl, publicKey: a.auth.publicKey },
      () => {}, { enrollController: value => a.enrollLocalController(value) });
    const cli = await LocalHostClient.connect(aDir, { enroll: true });
    try {
      await expect(runTicketsCommand(aDir, "dispatch", ticket.id, {
        engine: "codex", bot: "d", host: studioId, "request-id": "unsafe-cli-dispatch",
      }, () => {})).rejects.toMatchObject({
        status: 409, code: "dispatch_worker_permissions_unsafe", message: expect.stringContaining("tarobot logs"),
      });
    } finally {
      cli.close();
      await closeControl();
    }
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(`tarobot bots delete ${worker} --expected-name='Remote · Codex' --yes`));
    expect((await a.dispatch.show(owner, ticket.id)).attempts).toEqual([]);
    expect(await b.store.db.get("SELECT 1 FROM remote_dispatch_tickets WHERE bot_id=?", [worker])).toBeUndefined();
  } finally {
    await manager.close();
  }
});
