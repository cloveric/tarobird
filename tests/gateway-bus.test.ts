import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { startGatewayBus } from "../src/gateway/bus.js";
import { gatewayActiveWorkCount, gatewayDrainBlockers } from "../src/gateway/activity.js";
import { attachGateway } from "../src/gateway/service.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { readRegistry } from "../src/bus/bus-registry.js";
import { delegateToInstance } from "../src/bus/bus-client.js";
import { HubServer } from "../src/hub/server.js";
import { hashSecret } from "../src/hub/auth.js";
import { blocksText } from "../src/client-protocol/index.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { CoreBridgeLike } from "../src/core/types.js";
import { permissionResultSchema } from "../src/client-protocol/permissions.js";
const until = async (check: () => Promise<boolean>) => { const end = Date.now() + 8000; while (!await check()) { if (Date.now() > end) throw new Error("bus_timeout"); await new Promise((r) => setTimeout(r, 20)); } };

it("keeps detached concurrent work visible to update drain and permission changes", () => {
  const runtime = createCoreServiceRuntime();
  const run = { abortController: new AbortController(), startedAt: Date.now() };
  runtime.concurrentRuns.set("lark:gw_chat", new Set([run]));
  expect(gatewayActiveWorkCount(runtime)).toBe(1);
  expect(gatewayDrainBlockers(runtime, "alpha")).toEqual([{ botId: "alpha", type: "run", count: 1, conversationKey: "lark:gw_chat" }]);
  runtime.activeRuns.set("lark:gw_chat", run);
  expect(gatewayDrainBlockers(runtime, "alpha")[0]?.count).toBe(1);
});

it("blocks permission changes and reports work while a late-started Bus delegation is executing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-bus-permissions-")), alpha = path.join(root, "bots/alpha"), beta = path.join(root, "bots/beta");
  let bus: Awaited<ReturnType<typeof startGatewayBus>>, gateway: GatewayChannel | undefined, hub: HubServer | undefined;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const abort = new AbortController();
  const runtime = createCoreServiceRuntime();
  let delegated: ReturnType<typeof delegateToInstance> | undefined;
  try {
    for (const [stateDir, peer] of [[alpha, "beta"], [beta, "alpha"]] as const) {
      await mkdir(stateDir, { recursive: true });
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", approvalMode: "bypass", bus: { peers: [peer], secret: randomBytes(32).toString("hex") } }));
    }
    hub = await HubServer.start({ stateDir: path.join(root, "hub") });
    const secret = randomBytes(32).toString("base64url"); await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('beta','Beta',?)", [hashSecret(secret)]);
    const peer = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>().mockImplementation(async () => { await gate; return { text: "done" }; });
    gateway = await attachGateway({ stateDir: beta, botId: "beta", secret, engine: "codex", url: hub.instanceUrl.replace("http", "ws") + "/instance", runtime, bridge: { handleAuthorizedMessage: peer }, getActiveWorkCount: () => gatewayActiveWorkCount(runtime, bus?.activeCount() ?? 0) });
    const before = permissionResultSchema.parse(await gateway.onCall!("permissions.get", {}));
    if (!before.ok) throw new Error(before.error);
    expect(before.settings.activeTurns).toBe(0);
    bus = await startGatewayBus(beta, "beta", { handleAuthorizedMessage: peer });
    delegated = delegateToInstance({ fromInstance: "alpha", targetInstance: "beta", prompt: "held task", depth: 0, stateDir: alpha, abortSignal: abort.signal });
    await until(async () => peer.mock.calls.length === 1);
    expect(runtime.activeRuns.size).toBe(0);
    expect(await gateway.onCall!("permissions.get", {})).toMatchObject({ ok: true, settings: { activeTurns: 1 } });
    expect(await gateway.onCall!("effort.get", {})).toMatchObject({ ok: true, settings: { activeTurns: 1 } });
    const original = await readFile(path.join(beta, "config.json"), "utf8");
    expect(await gateway.onCall!("permissions.set", { revision: before.settings.revision, choice: "normal" })).toEqual({ ok: false, error: "permissions_busy" });
    expect(await readFile(path.join(beta, "config.json"), "utf8")).toBe(original);
    release(); await delegated; delegated = undefined;
    await until(async () => !bus!.isBusy());
    const idle = permissionResultSchema.parse(await gateway.onCall!("permissions.set", { revision: before.settings.revision, choice: "normal" }));
    expect(idle).toMatchObject({ ok: true, settings: { choice: "normal", activeTurns: 0 } });
    if (!idle.ok) throw new Error(idle.error);
    const timer = setTimeout(() => {}, 60_000).unref();
    runtime.pendingApprovals.set("approval", { requestId: "approval", chatId: "chat", resolve: () => {}, reject: () => {}, timer });
    expect(await gateway.onCall!("permissions.get", {})).toMatchObject({ ok: true, settings: { activeTurns: 1 } });
    expect(await gateway.onCall!("effort.get", {})).toMatchObject({ ok: true, settings: { activeTurns: 1 } });
    expect(await gateway.onCall!("permissions.set", { revision: idle.settings.revision, choice: "bypass" })).toEqual({ ok: false, error: "permissions_busy" });
    runtime.activeRuns.set("lark:chat", { abortController: new AbortController(), startedAt: Date.now() });
    expect(await gateway.onCall!("permissions.get", {})).toMatchObject({ ok: true, settings: { activeTurns: 1 } });
  } finally { release(); abort.abort(); for (const pending of runtime.pendingApprovals.values()) clearTimeout(pending.timer); runtime.pendingApprovals.clear(); runtime.activeRuns.clear(); await delegated?.catch(() => undefined); if (bus) await until(async () => !bus!.isBusy()); await gateway?.disconnect(); await bus?.stop(); await hub?.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
});
it("keeps standalone Bus disabled until configured", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-no-bus-"));
  try { await writeFile(path.join(root, "config.json"), "{}"); expect(await startGatewayBus(root, "alpha", { handleAuthorizedMessage: vi.fn() })).toBeUndefined(); }
  finally { await rm(root, { recursive: true, force: true }); }
});
it.each(["caller", "timeout"] as const)("propagates %s cancellation to only the affected delegated engine turn", async (cause) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-bus-cancel-")), alpha = path.join(root, "alpha"), beta = path.join(root, "beta");
  const signals = new Map<string, AbortSignal>(); const releases = new Map<string, () => void>();
  let bus: Awaited<ReturnType<typeof startGatewayBus>>;
  const abort = new AbortController();
  try {
    for (const [dir, peer] of [[alpha, "beta"], [beta, "alpha"]] as const) {
      await mkdir(dir); await writeFile(path.join(dir, "config.json"), JSON.stringify({ bus: { peers: [peer], secret: randomBytes(32).toString("hex") } }));
    }
    const peer = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>().mockImplementation(async (input) => {
      expect(input.abortSignal).toBeDefined(); signals.set(input.text, input.abortSignal!);
      await new Promise<void>((resolve, reject) => {
        releases.set(input.text, resolve);
        const cancel = () => reject(new Error("Engine turn cancelled"));
        if (input.abortSignal!.aborted) cancel(); else input.abortSignal!.addEventListener("abort", cancel, { once: true });
      });
      return { text: input.text, usage: { inputTokens: 2, outputTokens: 3 } };
    });
    bus = await startGatewayBus(beta, "beta", { handleAuthorizedMessage: peer });
    const input = { fromInstance: "alpha", targetInstance: "beta", depth: 0, stateDir: alpha };
    const retained = delegateToInstance({ ...input, prompt: "retained" });
    const stopped = delegateToInstance({ ...input, prompt: "stopped", ...(cause === "caller" ? { abortSignal: abort.signal } : { timeoutMs: 1000 }) }).catch((error: unknown) => error);
    await until(async () => signals.size === 2); expect(bus!.activeCount()).toBe(2); expect(bus!.isBusy()).toBe(true);
    if (cause === "caller") abort.abort();
    expect(await stopped).toMatchObject({ code: cause === "caller" ? "cancelled" : "timeout", retryable: false });
    await until(async () => signals.get("stopped")!.aborted);
    await until(async () => bus!.activeCount() === 1);
    expect(signals.get("retained")!.aborted).toBe(false); expect(bus!.isBusy()).toBe(true);
    releases.get("retained")!(); await expect(retained).resolves.toMatchObject({ success: true, text: "retained" });
    await until(async () => !bus!.isBusy());
    // A normal response close must not cancel an already completed peer call.
    expect(signals.get("retained")!.aborted).toBe(false); expect(peer).toHaveBeenCalledTimes(2);
    const timeline = (await readFile(path.join(beta, "timeline.log.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(timeline.filter((event) => event.type === "turn.completed").map((event) => event.outcome).sort()).toEqual(["interrupted", "success"]);
    expect(JSON.parse(await readFile(path.join(beta, "usage.json"), "utf8")).requestCount).toBe(1);
  } finally { abort.abort(); for (const release of releases.values()) release(); await bus?.stop(); await rm(root, { recursive: true, force: true }); }
}, 10_000);

it("does not connect or start a pre-cancelled delegation", async () => {
  const abort = new AbortController(); abort.abort();
  await expect(delegateToInstance({ fromInstance: "alpha", targetInstance: "beta", prompt: "must not run", depth: 0, stateDir: "absent", abortSignal: abort.signal })).rejects.toMatchObject({ code: "cancelled", retryable: false });
});
it.each([
  "Peer result: 检查语音适配",
  "```text\n" + "完整的一行，保持同一个代码块。😀\n".repeat(400) + "```",
])("delegates a client /ask through the real local Bus with intact replies, audit and shutdown", async (peerReply) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-bus-")), bots = path.join(root, "bots"), alpha = path.join(bots, "alpha"), beta = path.join(bots, "beta");
  let bus: Awaited<ReturnType<typeof startGatewayBus>>, gateway: GatewayChannel | undefined, hub: HubServer | undefined;
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    for (const [stateDir, peer] of [[alpha, "beta"], [beta, "alpha"]] as const) { await mkdir(stateDir, { recursive: true }); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh", bus: { peers: [peer], secret: randomBytes(32).toString("hex") } })); }
    const peer = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>().mockImplementation(async (input) => { await gate; return { text: peerReply, usage: { inputTokens: 2, outputTokens: 3, costUsd: 0.01 } }; });
    bus = await startGatewayBus(beta, "beta", { handleAuthorizedMessage: peer });
    expect(Object.keys((await readRegistry(bots)).instances)).toEqual(["beta"]);
    hub = await HubServer.start({ stateDir: path.join(root, "hub") }); const secret = randomBytes(32).toString("base64url"); await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
    const local = vi.fn(async () => ({ text: "must not run for /ask" }));
    gateway = await attachGateway({ stateDir: alpha, botId: "alpha", secret, engine: "codex", url: hub.instanceUrl.replace("http", "ws") + "/instance", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: local } });
    const c = await hub.store.createConversation("owner", ["alpha"], "Agent Bus", "create");
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "ask", text: "/ask beta 检查语音适配", attachments: [] });
    await until(async () => peer.mock.calls.length === 1); expect(bus?.isBusy()).toBe(true); release();
    await until(async () => (await hub!.store.pendingForBot("alpha")).length === 0);
    expect(bus?.isBusy()).toBe(false); expect(local).not.toHaveBeenCalled();
    expect(peer.mock.calls[0]![0]).toMatchObject({ chatType: "bus", text: "检查语音适配", sessionIdOverride: expect.stringMatching(/^tarobot-bus-/) });
    expect((await hub.store.snapshot("owner", c.id)).messages.some((m) => blocksText(m.blocks).includes(peerReply))).toBe(true);
    expect(await readFile(path.join(beta, "usage.json"), "utf8")).toContain("0.01"); expect(await readFile(path.join(beta, "audit.log.jsonl"), "utf8")).toContain("bus.handle");
    await expect(delegateToInstance({ fromInstance: "alpha", targetInstance: "outside", prompt: "denied", depth: 0, stateDir: alpha })).rejects.toMatchObject({ code: "peer_not_allowed" });
    await bus!.stop(); bus = undefined; expect(Object.keys((await readRegistry(bots)).instances)).toEqual([]);
  } finally { release(); await gateway?.disconnect(); await bus?.stop(); await hub?.close(); await rm(root, { recursive: true, force: true }); }
});
