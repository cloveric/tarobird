import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubAuth, hashSecret, type AuthSession } from "../src/hub/auth.js";
import { HubStore } from "../src/hub/store.js";
import { HubAgentBuses } from "../src/hub/agent-bus.js";
import { HubServer } from "../src/hub/server.js";
import { BusProtocolError } from "../src/bus/bus-protocol.js";
import { GatewayAgentBusRuns, observeAgentBusRun } from "../src/gateway/agent-bus.js";
import { startGatewayBus } from "../src/gateway/bus.js";
import { attachGateway } from "../src/gateway/service.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import type { WebSocket } from "ws";
import { createCoreServiceRuntime } from "../src/core/runtime.js";

const config = { name: "Original workspace", mode: "ask", coordinator: { botId: "alpha" }, members: [{ botId: "beta" }] };

describe("Agent Bus receipt and authority audit boundaries", () => {
  let root: string, store: HubStore;
  const buses = () => new HubAgentBuses(store, { workerCapable: () => true, stop: async () => null, conversationsCreated: () => {} });
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "agent-bus-audit-"));
    store = await HubStore.open(path.join(root, "hub"));
    for (const id of ["alpha", "beta"]) {
      await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id, "fixture"]);
      await store.db.run("INSERT INTO managed_bots VALUES(?,?,?,?)", [id, "owner", id, "{}"]);
    }
  });
  afterEach(async () => { await store.db.close(); await rm(root, { recursive: true, force: true }); });

  it("keeps an archived dedicated chat archived and reuses it after explicit restoration", async () => {
    const api = buses(), workspace = await api.create("owner", { requestId: "create", config });
    const chat = workspace.members[0]!.conversationId;
    await store.updateConversation("owner", chat, { archived: true });
    // An explicitly retained binding never silently restores archived history.
    await expect(api.update("owner", workspace.id, { revision: workspace.revision, config: { ...config, coordinator: workspace.coordinator, members: workspace.members } })).rejects.toThrow("agent_bus_conversation_archived");
    await expect(api.start("owner", workspace.id, { requestId: "run", revision: workspace.revision, text: "task" })).rejects.toThrow("agent_bus_conversation_archived");
    expect(await store.db.get("SELECT archived FROM conversations WHERE id=?", [chat])).toEqual({ archived: 1 });
    expect(await store.db.get("SELECT COUNT(*) AS count FROM deliveries")).toEqual({ count: 0 });
    await store.updateConversation("owner", chat, { archived: false });
    const restored = await api.update("owner", workspace.id, { revision: workspace.revision, config });
    expect(restored.members[0]!.conversationId).toBe(chat);
    expect(await store.db.get("SELECT COUNT(*) AS count FROM conversations")).toEqual({ count: 2 });
    expect(await api.start("owner", workspace.id, { requestId: "run", revision: restored.revision, text: "task" })).toMatchObject({ status: "queued" });
  });

  it.each(["interrupted", "failed"] as const)("does not ask to resend a stopped Bus after worker %s settlement", async reason => {
    const api = buses(), workspace = await api.create("owner", { requestId: "create", config });
    const run = await api.start("owner", workspace.id, { requestId: "run", revision: workspace.revision, text: "task" });
    await store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [run.messageId]);
    await api.stop("owner", workspace.id, run.id, { requestId: "stop" });
    await store.failDelivery("alpha", run.messageId, reason);
    await store.failDelivery("alpha", run.messageId, reason);
    await api.reconcile();
    expect((await api.detail("owner", workspace.id)).runs[0]!.status).toBe("cancelled");
    const rows = await store.db.all<{ id: string }>("SELECT id FROM messages WHERE reply_to=?", [run.messageId]);
    expect(rows).toHaveLength(1);
    const recovery = await store.messageForBot("alpha", rows[0]!.id);
    expect(recovery.blocks).toContainEqual({ type: "text", text: "协作已按停止请求结束，收到的结果已保留，不会自动重试。" });
    expect(JSON.stringify(recovery.blocks)).not.toContain("重新发送");
  });

  it("revalidates a revoked device after database admission, including cached request replay", async () => {
    const auth = await HubAuth.open(store, path.join(root, "auth"));
    await store.db.run("INSERT INTO devices(id,user_id,name,platform,public_key,revoked,created_at,last_seen) VALUES('fixture_device','owner','Fixture','web','fixture',0,0,0)");
    const session: AuthSession = { deviceId: "fixture_device", userId: "owner", expiresAt: Date.now() + 60_000 };
    const validate = async () => { await auth.validateSessionInTransaction(session); await store.requireOwner(session.userId); };
    const api = buses(), existing = await api.create("owner", { requestId: "existing", config }, validate);
    await auth.validateSession(session); // The request passed its initial HTTP-equivalent check.
    let entered!: () => void, release!: () => void;
    const admitted = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const blocker = store.db.transaction(async () => { entered(); await held; });
    await admitted;
    const revoke = auth.revoke(session.deviceId, "local-owner");
    const queued = api.create("owner", { requestId: "queued-after-revoke", config }, validate);
    const rejected = expect(queued).rejects.toThrow("device_revoked");
    release(); await blocker; await revoke; await rejected;
    await expect(api.create("owner", { requestId: "existing", config }, validate)).rejects.toThrow("device_revoked");
    expect((await api.list("owner")).map(item => item.id)).toEqual([existing.id]);
    expect(await store.db.get("SELECT COUNT(*) AS count FROM agent_bus_requests")).toEqual({ count: 1 });
    expect(await store.db.get("SELECT COUNT(*) AS count FROM deliveries")).toEqual({ count: 0 });
  });

  it("retains replay fences after history pruning and preserves prior snapshots after editing", async () => {
    const api = buses(), workspace = await api.create("owner", { requestId: "create", config });
    const first = { requestId: "run-0", revision: workspace.revision, text: "original task 0" };
    for (let index = 0; index < 53; index++) {
      const run = await api.start("owner", workspace.id, { ...first, requestId: `run-${index}`, text: `original task ${index}` });
      await api.stop("owner", workspace.id, run.id, { requestId: `stop-${index}` });
    }
    const before = await store.db.get("SELECT COUNT(*) AS count FROM deliveries");
    expect(before).toEqual({ count: 53 });
    expect(await store.db.get("SELECT COUNT(*) AS count FROM agent_bus_runs")).toEqual({ count: 51 });
    // The result may expire; the original request number must never enqueue it again.
    await expect(api.start("owner", workspace.id, first)).rejects.toThrow("agent_bus_run_not_found");
    await expect(api.start("owner", workspace.id, { ...first, text: "changed task" })).rejects.toThrow("idempotency_conflict");
    expect(await store.db.get("SELECT COUNT(*) AS count FROM deliveries")).toEqual(before);
    await api.update("owner", workspace.id, { revision: workspace.revision, config: { ...config, name: "Changed workspace", mode: "verify" } });
    const detail = await api.detail("owner", workspace.id);
    expect(detail.runs).toHaveLength(20);
    expect(detail.runs.every(run => run.snapshot.name === "Original workspace" && run.snapshot.mode === "ask")).toBe(true);
    expect(detail.workspace).toMatchObject({ name: "Changed workspace", mode: "verify" });
    expect(await store.db.get("SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?", [workspace.coordinator.conversationId])).toEqual({ count: 53 });
  });

  it("keeps the stop flag through a store restart and does not overwrite already completed stages", async () => {
    let api = buses();
    const workspace = await api.create("owner", { requestId: "create", config });
    const run = await api.start("owner", workspace.id, { requestId: "run", revision: workspace.revision, text: "task" });
    await store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [run.messageId]);
    const base = { runId: run.id, messageId: run.messageId, botId: "beta" };
    await api.event("alpha", { type: "stage.started", ...base, stageId: "s1", prompt: "first" });
    await api.event("alpha", { type: "stage.finished", ...base, stageId: "s1", status: "completed", text: "confirmed output" });
    await api.event("alpha", { type: "stage.started", ...base, stageId: "s2", prompt: "second" });
    expect(await api.stop("owner", workspace.id, run.id, { requestId: "stop" })).toMatchObject({ status: "stopping" });
    await store.db.close(); store = await HubStore.open(path.join(root, "hub")); api = buses();
    await api.reconcile();
    expect(await api.dispatch("alpha", run.messageId)).toMatchObject({ runId: run.id, stopRequested: true });
    expect(await api.stop("owner", workspace.id, run.id, { requestId: "stop" })).toMatchObject({ status: "stopping" });
    await store.failDelivery("alpha", run.messageId, "interrupted"); await api.reconcile();
    const restored = (await api.detail("owner", workspace.id)).runs[0]!;
    expect(restored.status).toBe("cancelled");
    expect(restored.stages.map(stage => [stage.id, stage.status])).toEqual([["s1", "completed"], ["s2", "cancelled"]]);
    expect((await store.messageForBot("beta", restored.stages[0]!.messageId!)).blocks).toContainEqual({ type: "text", text: "confirmed output" });
  });

  it("delivers an offline stop to the same live controller on reconnect before receipt deduplication", async () => {
    const hub = await HubServer.start({ stateDir: path.join(root, "reconnect-hub") });
    const stateDir = path.join(root, "reconnect-worker"), secret = randomBytes(32).toString("base64url");
    let channel: GatewayChannel | undefined, releaseModel = () => {};
    const until = async (check: () => Promise<boolean>) => { const end = Date.now() + 5_000; while (!await check()) { if (Date.now() > end) throw new Error("reconnect_condition_timeout"); await new Promise(resolve => setTimeout(resolve, 10)); } };
    try {
      for (const id of ["alpha", "beta"]) {
        await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id, hashSecret(secret)]);
        await hub.store.db.run("INSERT INTO managed_bots VALUES(?,?,?,?)", [id, "owner", id, "{}"]);
      }
      await mkdir(stateDir);
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en", bus: { peers: ["beta"], secret: randomBytes(32).toString("hex") } }));
      let aborted = false;
      const delegate = vi.fn(async (input: { abortSignal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
        releaseModel = () => reject(new BusProtocolError({ message: "stopped", code: "cancelled", retryable: false }));
        input.abortSignal!.addEventListener("abort", () => { aborted = true; releaseModel(); }, { once: true });
      }));
      const runtime = Object.assign(createCoreServiceRuntime(), { busRuntime: { delegateToInstance: delegate } });
      channel = await attachGateway({ stateDir, botId: "alpha", secret, engine: "codex", url: hub.instanceUrl.replace("http", "ws") + "/instance", runtime, bridge: { handleAuthorizedMessage: vi.fn() } });
      await until(async () => (await hub.store.bots("owner")).find(bot => bot.id === "alpha")?.online === 1);
      const workspace = await hub.agentBuses.create("owner", { requestId: "create", config });
      const run = await hub.agentBuses.start("owner", workspace.id, { requestId: "run", revision: workspace.revision, text: "long task" });
      await until(async () => delegate.mock.calls.length === 1);
      const stopped = vi.spyOn(channel, "onAgentBusStopRequested"), inputs = vi.spyOn(channel.transport, "onMessage");
      const socket = channel.transport as unknown as { ws: WebSocket; open(): void };
      const pauseReconnect = vi.spyOn(socket, "open").mockImplementation(() => {});
      socket.ws.terminate();
      await until(async () => (await hub.store.bots("owner")).find(bot => bot.id === "alpha")?.online === 0);
      expect(await hub.agentBuses.stop("owner", workspace.id, run.id, { requestId: "stop" })).toMatchObject({ status: "stopping" });
      expect(await hub.agentBuses.stop("owner", workspace.id, run.id, { requestId: "stop" })).toMatchObject({ status: "stopping" });
      expect(aborted).toBe(false); expect(stopped).not.toHaveBeenCalled();
      await expect(hub.agentBuses.start("owner", workspace.id, { requestId: "unsafe-new-run", revision: workspace.revision, text: "second" })).rejects.toThrow("agent_bus_busy");
      expect(await hub.store.db.get("SELECT status,dispatched FROM deliveries WHERE message_id=?", [run.messageId])).toEqual({ status: "pending", dispatched: 1 });
      // Let the scheduled retry finish without opening a socket, then resume
      // that same transport/process with its still-running receipt and model.
      await until(async () => pauseReconnect.mock.calls.length === 1);
      pauseReconnect.mockRestore(); socket.open();
      await until(async () => (await hub.agentBuses.detail("owner", workspace.id)).runs[0]!.status === "cancelled" && (await hub.store.pendingForBot("alpha")).length === 0);
      expect(inputs.mock.calls.some(([message, _conversation, dispatch]) => message.id === run.messageId && dispatch?.stopRequested)).toBe(true);
      expect(stopped).toHaveBeenCalledWith(run.id);
      expect(aborted).toBe(true); expect(delegate).toHaveBeenCalledTimes(1);
    } finally { releaseModel(); await channel?.disconnect(); await hub.close(); }
  });

  it.each(["alpha", "beta"] as const)("checks %s's revoked permission on the next step without cancelling an admitted step", async revoked => {
    const dir = (id: string) => path.join(root, "bots", id);
    const secrets = { alpha: randomBytes(32).toString("hex"), beta: randomBytes(32).toString("hex") };
    const save = (id: "alpha" | "beta", peers: string[]) => writeFile(path.join(dir(id), "config.json"), JSON.stringify({ engine: "codex", locale: "en", approvalMode: "bypass", bus: { peers, secret: secrets[id] } }));
    for (const id of ["alpha", "beta"] as const) { await mkdir(dir(id), { recursive: true }); await save(id, [id === "alpha" ? "beta" : "alpha"]); }
    let admitted!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { admitted = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const engine = vi.fn(async (input: { abortSignal?: AbortSignal }) => { admitted(); await held; expect(input.abortSignal?.aborted).not.toBe(true); return { text: "confirmed output" }; });
    const listener = await startGatewayBus(dir("beta"), "beta", { handleAuthorizedMessage: engine });
    expect(listener).toBeDefined();
    try {
      const observed = observeAgentBusRun({ transport: { enqueue: () => ({ persisted: Promise.resolve(), response: Promise.resolve(null) }) }, runs: new GatewayAgentBusRuns(), botId: "alpha", messageId: "msg_run",
        dispatch: { runId: "abr_run", workspaceId: "ab_ws", mode: "chain", members: ["beta"], maxResearchQuestions: 5, maxRevisionRounds: 1 }, runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: vi.fn() } });
      const delegate = observed.runtime.busRuntime!.delegateToInstance!;
      const input = { fromInstance: "alpha", targetInstance: "beta", prompt: "first step", depth: 0, stateDir: dir("alpha") };
      const first = delegate(input); await entered;
      await save(revoked, ["unselected_peer"]); release();
      expect(await first).toMatchObject({ success: true, text: "confirmed output" });
      await expect(delegate({ ...input, prompt: "next step" })).rejects.toMatchObject({ code: "peer_not_allowed", retryable: false });
      expect(engine).toHaveBeenCalledTimes(1);
      await observed.finish();
    } finally { release(); await listener?.stop(); }
  });
});
