import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotCatalog } from "../src/client-protocol/bots.js";
import { ENGINE_QUOTA_CAPABILITY, type QuotaDirectory, type QuotaScope } from "../src/client-protocol/engine-quota.js";
import {
  evaluateHostEngineCandidate,
  isQuotaScopeExhausted,
  isQuotaScopeLoginRequired,
  resolveCatalogBotDefaults,
  selectBalancedHost,
  type HostBalanceCandidate,
} from "../src/client-protocol/host-balancer.js";
import {
  HOST_BALANCE_RESOURCES_CAPABILITY,
  HOST_BALANCE_RESOURCES_PATH,
  hostBalanceResourcesSchema,
} from "../src/client-protocol/host-balance-resources.js";
import {
  HOST_RESOURCES_CAPABILITY,
  HOST_RESOURCES_PATH,
} from "../src/client-protocol/host-resources.js";
import { SERVER_CAPABILITIES } from "../src/client-protocol/index.js";
import { deviceProof } from "../src/hub/auth.js";
import {
  readAvailableMemoryBytes,
  readHostBalanceResources,
  type CpuSamplerState,
} from "../src/hub/host-balance-resources.js";
import { HubServer } from "../src/hub/server.js";
import { startHubControl } from "../src/hub/service.js";
import { runHostCli } from "../src/host-cli/cli.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { runConversationsCommand } from "../src/host-cli/conversations.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { removeTempRoot } from "./helpers/temp-files.js";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await removeTempRoot(dir).catch(() => rm(dir, { recursive: true, force: true }));
});

function candidate(overrides: Partial<HostBalanceCandidate> & { hostId: string; hostName: string }): HostBalanceCandidate {
  return {
    online: true,
    preference: "normal",
    engineAvailable: true,
    quotaExhausted: false,
    latencyMs: 12,
    matchingBotId: `bot-${overrides.hostId}`,
    resources: {
      cpuPercent: 20,
      cpuCores: 8,
      loadAvg1m: 1.2,
      memoryUsedPercent: 40,
      memoryFreeBytes: 8 * 1024 ** 3,
      memoryTotalBytes: 16 * 1024 ** 3,
      activeTurns: 0,
      activeTickets: 0,
      capturedAt: Date.now(),
    },
    ...overrides,
  };
}

function makeQuotaScope(overrides: Partial<QuotaScope> & { id: string; engine: QuotaScope["engine"] }): QuotaScope {
  const now = new Date("2026-11-27T00:00:00.000Z").toISOString();
  return {
    revision: "rev_1",
    label: overrides.id,
    botIds: [overrides.id],
    sharing: "unverified",
    authMode: "subscription",
    capability: { mode: "active" },
    state: "ready",
    availability: "allowed",
    observedAt: now,
    pools: [],
    constraints: [],
    ...overrides,
  };
}

async function authenticateOwner(hub: HubServer) {
  const keys = generateKeyPairSync("ed25519");
  const pair = await hub.auth.pair({
    deviceId: "dev-res", name: "Owner", platform: "web",
    publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  }, "127.0.0.1");
  await hub.auth.approve(pair.code, "local-owner");
  const clientNonce = "res-client-nonce-1234567890";
  const ch = await hub.auth.challenge("conn_res", "dev-res", clientNonce, "127.0.0.1");
  return hub.auth.authenticate("conn_res", sign(null, deviceProof("dev-res", ch.nonce, clientNonce), keys.privateKey).toString("base64"));
}

describe("Auto-select Host load balancing (#88)", () => {
  it("advertises host.balance-resources.v1 separately from host.resources.v1", () => {
    expect(SERVER_CAPABILITIES).toContain(HOST_BALANCE_RESOURCES_CAPABILITY);
    expect(SERVER_CAPABILITIES).toContain(HOST_RESOURCES_CAPABILITY);
    expect(HOST_BALANCE_RESOURCES_CAPABILITY).toBe("host.balance-resources.v1");
    expect(HOST_RESOURCES_CAPABILITY).toBe("host.resources.v1");
    expect(HOST_BALANCE_RESOURCES_CAPABILITY).not.toBe(HOST_RESOURCES_CAPABILITY);
    expect(HOST_BALANCE_RESOURCES_PATH).toBe("/api/host-balance-resources");
    expect(HOST_RESOURCES_PATH).toBe("/api/host-resources");
    expect(HOST_BALANCE_RESOURCES_PATH).not.toBe(HOST_RESOURCES_PATH);
  });

  it("excludes offline, manual-only, engine-unavailable, login-required, quota-exhausted, missing-resources, and overloaded hosts", () => {
    const result = selectBalancedHost([
      candidate({ hostId: "h-offline", hostName: "offline-box", online: false }),
      candidate({ hostId: "h-manual", hostName: "manual-box", preference: "manual_only" }),
      candidate({ hostId: "h-no-engine", hostName: "no-cli-box", engineAvailable: false }),
      candidate({ hostId: "h-login", hostName: "login-box", loginRequired: true }),
      candidate({ hostId: "h-no-quota", hostName: "empty-quota-box", quotaExhausted: true }),
      candidate({ hostId: "h-no-res", hostName: "old-box", resources: undefined }),
      candidate({ hostId: "h-full", hostName: "full-box", resources: { ...candidate({ hostId: "x", hostName: "x" }).resources!, cpuPercent: 97 } }),
      candidate({ hostId: "h-ok", hostName: "macmini" }),
    ], { requireResources: true });

    expect(result.selected?.hostId).toBe("h-ok");
    expect(result.excluded.map((e) => [e.hostId, e.reason])).toEqual([
      ["h-offline", "offline"],
      ["h-manual", "manual_only"],
      ["h-no-engine", "engine_unavailable"],
      ["h-login", "login_required"],
      ["h-no-quota", "quota_exhausted"],
      ["h-no-res", "resources_unavailable"],
      ["h-full", "overloaded"],
    ]);
  });

  it("picks by load, latency, and preference across 3 hosts (one busy, one less_often, one idle)", () => {
    const busy = candidate({
      hostId: "h-busy",
      hostName: "busy-box",
      resources: { ...candidate({ hostId: "x", hostName: "x" }).resources!, cpuPercent: 78, memoryUsedPercent: 80, activeTurns: 3, activeTickets: 2 },
    });
    const lessOften = candidate({
      hostId: "h-less",
      hostName: "less-box",
      preference: "less_often",
      resources: { ...candidate({ hostId: "x", hostName: "x" }).resources!, cpuPercent: 18, memoryUsedPercent: 35, activeTurns: 0 },
    });
    const normalIdle = candidate({
      hostId: "h-idle",
      hostName: "macmini",
      preference: "normal",
      resources: { ...candidate({ hostId: "x", hostName: "x" }).resources!, cpuPercent: 22, memoryUsedPercent: 40, activeTurns: 0 },
    });

    const pick1 = selectBalancedHost([busy, lessOften, normalIdle], { requireResources: true });
    expect(pick1.selected?.hostId).toBe("h-idle");

    // Once h-idle gets busy (2 active turns), lessOften wins over heavily busy host
    const idleNowBusy = { ...normalIdle, resources: { ...normalIdle.resources!, cpuPercent: 65, activeTurns: 2 } };
    const pick2 = selectBalancedHost([busy, lessOften, idleNowBusy], { requireResources: true });
    expect(pick2.selected?.hostId).toBe("h-less");

    // A "prefer" host with spare resources beats an equal "normal" host
    const preferred = candidate({ hostId: "h-pref", hostName: "studio", preference: "prefer" });
    const pick3 = selectBalancedHost([normalIdle, preferred], { requireResources: true });
    expect(pick3.selected?.hostId).toBe("h-pref");
  });

  it("does not let hosts without telemetry outrank monitored hosts when requireResources is enabled", () => {
    const monitoredBusy = candidate({
      hostId: "h-monitored",
      hostName: "macmini",
      resources: { ...candidate({ hostId: "x", hostName: "x" }).resources!, cpuPercent: 55, memoryUsedPercent: 60, activeTurns: 1 },
    });
    const unmonitored = candidate({ hostId: "h-unmonitored", hostName: "old-host", resources: undefined });

    const pick = selectBalancedHost([unmonitored, monitoredBusy], { requireResources: true });
    expect(pick.selected?.hostId).toBe("h-monitored");
    expect(pick.excluded).toEqual([{ hostId: "h-unmonitored", hostName: "old-host", reason: "resources_unavailable" }]);

    const none = selectBalancedHost([unmonitored], { requireResources: true });
    expect(none.selected).toBeNull();
    expect(none.reason).toBe("no_eligible_host");
    expect(none.excluded).toEqual([{ hostId: "h-unmonitored", hostName: "old-host", reason: "resources_unavailable" }]);
  });

  it("spreads consecutive creations across equally idle hosts via recentAssignments", () => {
    const a = candidate({ hostId: "h-a", hostName: "macmini" });
    const b = candidate({ hostId: "h-b", hostName: "studio" });
    expect(selectBalancedHost([a, b], { recentAssignments: [], requireResources: true }).selected?.hostId).toBe("h-a");
    expect(selectBalancedHost([a, b], { recentAssignments: ["h-a"], requireResources: true }).selected?.hostId).toBe("h-b");
  });

  it("evaluates quota exhaustion and login_required accurately (respecting reset times and overage_disabled)", () => {
    const now = Date.parse("2026-11-27T01:00:00.000Z");
    const future = "2026-11-27T05:00:00.000Z";
    const past = "2026-11-27T00:30:00.000Z";

    const loginScope = makeQuotaScope({ id: "b1", engine: "claude", state: "login_required", reason: "login_required", availability: "unknown" });
    expect(isQuotaScopeLoginRequired(loginScope)).toBe(true);
    expect(isQuotaScopeExhausted(loginScope, { now })).toBe(false);

    const blockedConstraint = makeQuotaScope({
      id: "b2", engine: "claude", availability: "blocked",
      constraints: [{ code: "ordinary_usage_blocked", availability: "blocked", resetsAt: future }],
    });
    expect(isQuotaScopeExhausted(blockedConstraint, { now })).toBe(true);

    // Past reset time should no longer block
    const resetConstraint = makeQuotaScope({
      id: "b2", engine: "claude", availability: "blocked",
      constraints: [{ code: "ordinary_usage_blocked", availability: "blocked", resetsAt: past }],
    });
    expect(isQuotaScopeExhausted(resetConstraint, { now })).toBe(false);

    // Disabled overage is not ordinary usage exhaustion
    const overageOnly = makeQuotaScope({
      id: "b3", engine: "claude", availability: "allowed",
      constraints: [{ code: "overage_disabled", availability: "blocked" }],
    });
    expect(isQuotaScopeExhausted(overageOnly, { now })).toBe(false);

    // 100% depleted shared window blocks, expired window does not
    const depletedWindow = makeQuotaScope({
      id: "b4", engine: "codex", availability: "blocked",
      pools: [{
        id: "shared", label: "Shared", sharing: "shared", availability: "blocked",
        windows: [{ id: "5h", label: "5h", metric: "percent", usedPercent: 100, availability: "blocked", observedAt: past, expiresAt: future, resetsAt: future }],
        balances: [], constraints: [],
      }],
    });
    expect(isQuotaScopeExhausted(depletedWindow, { now })).toBe(true);
    expect(isQuotaScopeExhausted(depletedWindow, { now: Date.parse(future) + 1 })).toBe(false);

    // Host with two bots of same engine picks the non-exhausted one
    const quotas: QuotaDirectory = {
      generatedAt: new Date(now).toISOString(),
      scopes: [
        blockedConstraint,
        makeQuotaScope({ id: "b-healthy", engine: "claude", availability: "allowed" }),
      ],
    };
    const evaluated = evaluateHostEngineCandidate({
      engine: "claude",
      bots: [
        { id: "b2", name: "Exhausted Claude", engine: "claude", online: 1 },
        { id: "b-healthy", name: "Healthy Claude", engine: "claude", online: 1 },
      ],
      canCreateBot: true,
      quotas,
      now,
    });
    expect(evaluated.engineAvailable).toBe(true);
    expect(evaluated.quotaExhausted).toBe(false);
    expect(evaluated.matchingBot?.id).toBe("b-healthy");
  });

  it("evaluates catalog defaults, DeepSeek unavailable/default-missing states, Pi models, dispatcher exclusion, and existing external Bots", () => {
    const catalog: BotCatalog = {
      engines: [
        {
          id: "deepseek",
          available: true,
          catalogStatus: "ready",
          defaultModel: "",
          defaultEffort: "high",
          permissions: { defaultChoice: "bypass", choices: [] },
          models: [
            { id: "", efforts: [""] }, // DSH default missing provider/modelId -> deepSeekDefaultUnavailable
            { id: "ds/reasoner", provider: "ds", modelId: "reasoner", efforts: ["off", "high"] },
          ],
        },
        {
          id: "pi",
          available: true,
          catalogStatus: "ready",
          defaultModel: "",
          defaultEffort: "",
          permissions: { defaultChoice: "bypass", choices: [] },
          models: [{ id: `provider/${"m".repeat(160)}`, efforts: ["", "high"] }],
        },
        {
          id: "claude",
          available: false,
          defaultModel: "",
          defaultEffort: "",
          models: [{ id: "", efforts: [""] }],
        },
      ],
    };

    // DeepSeek default unavailable blocks empty model, accepts valid concrete model
    expect(resolveCatalogBotDefaults("deepseek", catalog.engines[0], "")).toEqual({ ok: false, reason: "engine_unavailable" });
    expect(resolveCatalogBotDefaults("deepseek", catalog.engines[0], "ds/reasoner")).toEqual({
      ok: true,
      defaults: { model: "ds/reasoner", effort: "high", permission: "bypass" },
    });
    expect(resolveCatalogBotDefaults("deepseek", { ...catalog.engines[0]!, catalogStatus: "unavailable" }, "ds/reasoner")).toEqual({
      ok: false, reason: "engine_unavailable",
    });

    // Pi supports >128-char model IDs
    const longPiModel = `provider/${"m".repeat(160)}`;
    expect(resolveCatalogBotDefaults("pi", catalog.engines[1], longPiModel)).toEqual({
      ok: true,
      defaults: { model: longPiModel, effort: "", permission: "bypass" },
    });

    // Existing usable external Bot stays eligible even when catalog says available=false
    const external = evaluateHostEngineCandidate({
      engine: "claude",
      bots: [
        { id: "disp", name: "Chief", engine: "claude", role: "dispatcher", online: 1 },
        { id: "ext", name: "External Claude", engine: "claude", model: "", online: 1 },
      ],
      canCreateBot: true,
      catalog,
    });
    expect(external.engineAvailable).toBe(true);
    expect(external.matchingBot?.id).toBe("ext");

    // Dispatcher alone is never selected as a reusable Bot
    const dispatcherOnly = evaluateHostEngineCandidate({
      engine: "claude",
      bots: [{ id: "disp", name: "Chief", engine: "claude", role: "dispatcher", online: 1 }],
      canCreateBot: true,
      catalog,
    });
    expect(dispatcherOnly.matchingBot).toBeUndefined();
    expect(dispatcherOnly.engineAvailable).toBe(false);

    // Explicit requestedModel does not silently reuse a Bot configured with a different model
    const mismatchModel = evaluateHostEngineCandidate({
      engine: "pi",
      requestedModel: longPiModel,
      bots: [{ id: "pi-default", name: "Pi Default", engine: "pi", model: "", online: 1 }],
      canCreateBot: true,
      catalog,
    });
    expect(mismatchModel.matchingBot).toBeUndefined();
    expect(mismatchModel.engineAvailable).toBe(true);
    expect(mismatchModel.createDefaults?.model).toBe(longPiModel);
  });

  it("prefers process.availableMemory() over os.freemem() and computes live CPU deltas when loadavg is 0 (Windows)", async () => {
    const total = 16 * 1024 ** 3;
    expect(readAvailableMemoryBytes(total, () => 6 * 1024 ** 3, () => 1 * 1024 ** 3)).toBe(6 * 1024 ** 3);
    expect(readAvailableMemoryBytes(total, () => undefined, () => 2 * 1024 ** 3)).toBe(2 * 1024 ** 3);
    expect(readAvailableMemoryBytes(total, () => total * 2, () => 0)).toBe(total);

    const stateDir = await mkdtemp(path.join(os.tmpdir(), "host-res-delta-"));
    tempDirs.push(stateDir);
    const hub = await HubServer.start({ stateDir });
    try {
      const samplerState: CpuSamplerState = {};
      const snapshots = [
        // Huge idle lifetime since boot, then 100% busy over 100ms delta, then 50% busy on subsequent read
        [{ model: "cpu", speed: 3000, times: { user: 10_000, nice: 0, sys: 0, idle: 1_000_000, irq: 0 } }],
        [{ model: "cpu", speed: 3000, times: { user: 10_400, nice: 0, sys: 0, idle: 1_000_000, irq: 0 } }],
        [{ model: "cpu", speed: 3000, times: { user: 10_600, nice: 0, sys: 0, idle: 1_000_200, irq: 0 } }],
      ];
      let idx = 0;
      const delay = vi.fn(async () => undefined);
      const first = await readHostBalanceResources(hub.store, {
        cpus: () => snapshots[Math.min(idx++, snapshots.length - 1)]!,
        loadavg: () => [0, 0, 0],
        totalmem: () => total,
        availableMemory: () => 6 * 1024 ** 3,
        freemem: () => 1 * 1024 ** 3,
        delay,
        sampleWindowMs: 1,
        state: samplerState,
      });
      expect(first.cpuPercent).toBe(100);
      expect(first.memoryUsedPercent).toBe(63);
      expect(delay).toHaveBeenCalledTimes(1);

      const second = await readHostBalanceResources(hub.store, {
        cpus: () => snapshots[Math.min(idx++, snapshots.length - 1)]!,
        loadavg: () => [0, 0, 0],
        totalmem: () => total,
        availableMemory: () => 6 * 1024 ** 3,
        freemem: () => 1 * 1024 ** 3,
        delay,
        sampleWindowMs: 1,
        state: samplerState,
      });
      expect(second.cpuPercent).toBe(50);
      expect(delay).toHaveBeenCalledTimes(1); // Reuses previous snapshot without sleeping
    } finally {
      await hub.close();
    }
  });

  it("serves /api/host-balance-resources to authorized devices and counts only active working tickets and pending/streaming turns", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "host-res-"));
    tempDirs.push(stateDir);
    const hub = await HubServer.start({ stateDir });
    try {
      const unauth = await fetch(`${hub.url}${HOST_BALANCE_RESOURCES_PATH}`);
      expect(unauth.status).toBe(401);

      const session = await authenticateOwner(hub);
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,role) VALUES('disp_1','Chief','x','claude','dispatcher')");
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,role) VALUES('worker_1','Worker','x','claude','worker')");
      await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,archived,hidden) VALUES('conv_hidden_done','direct','Done Ticket','owner',1,0,1)");
      await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,archived,hidden) VALUES('conv_hidden_work','direct','Work Ticket','owner',2,0,1)");
      await hub.store.db.run(
        "INSERT INTO dispatch_tickets(id,dispatcher_bot_id,conversation_id,request_id,title,request,status,paused,attempts_json,created_at,updated_at) VALUES('t_done','disp_1','conv_hidden_done','req_done','Done','req','done',0,'[]',1,1)",
      );
      await hub.store.db.run(
        "INSERT INTO dispatch_tickets(id,dispatcher_bot_id,conversation_id,request_id,title,request,status,paused,attempts_json,created_at,updated_at) VALUES('t_paused','disp_1','conv_hidden_done','req_paused','Paused','req','working',1,'[]',1,1)",
      );
      await hub.store.db.run(
        "INSERT INTO dispatch_tickets(id,dispatcher_bot_id,conversation_id,request_id,title,request,status,paused,attempts_json,created_at,updated_at) VALUES('t_work','disp_1','conv_hidden_work','req_work','Work','req','working',0,'[]',2,2)",
      );
      await hub.store.db.run("INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at) VALUES('m1','conv_hidden_work','worker_1','bot','[]','streaming',1,1)");
      await hub.store.db.run("INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at) VALUES('m2','conv_hidden_work','worker_1','bot','[]','pending',1,2)");
      await hub.store.db.run("INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at) VALUES('m3','conv_hidden_work','worker_1','bot','[]','complete',1,3)");

      const res1 = await fetch(`${hub.url}${HOST_BALANCE_RESOURCES_PATH}`, {
        headers: { Authorization: `Bearer ${session.token}` },
      });
      expect(res1.status).toBe(200);
      const body1 = hostBalanceResourcesSchema.parse(await res1.json());
      expect(body1.cpuCores).toBeGreaterThan(0);
      expect(body1.memoryTotalBytes).toBeGreaterThan(0);
      expect(body1.activeTurns).toBe(2);
      expect(body1.activeTickets).toBe(1);

      // Moving working ticket to done drops activeTickets to 0 even though hidden conversation stays unarchived
      await hub.store.db.run("UPDATE dispatch_tickets SET status='done' WHERE id='t_work'");
      const res2 = await fetch(`${hub.url}${HOST_BALANCE_RESOURCES_PATH}`, {
        headers: { Authorization: `Bearer ${session.token}` },
      });
      const body2 = hostBalanceResourcesSchema.parse(await res2.json());
      expect(body2.activeTickets).toBe(0);
    } finally {
      await hub.close();
    }
  });

  it("runs `runHostCli(['conversations', 'create', ...])` end-to-end against a real HubServer and validates CLI flags", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "host-balance-cli-"));
    tempDirs.push(root);
    await initializeHost(root, "macmini");
    const hub = await HubServer.start({ stateDir: root });
    let control: (() => Promise<void>) | undefined;
    let client: LocalHostClient | undefined;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const loadAvgSpy = vi.spyOn(os, "loadavg").mockReturnValue([1.2, 1.0, 0.8]);
    try {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,online,role) VALUES('bot_disp','Chief','x','claude','','',1,'dispatcher')");
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,online,role) VALUES('bot_claude','Claude Bot','x','claude','','',1,'')");
      control = await startHubControl(
        root,
        { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey },
        () => {},
        { enrollController: value => hub.enrollLocalController(value) },
      );
      client = await LocalHostClient.connect(root, { enroll: true });

      // Invalid flags rejected before touching the Hub
      await expect(runHostCli(["conversations", "create", "extra-arg", "--engine", "claude", "--state-dir", root])).rejects.toThrow();
      await expect(runHostCli(["conversations", "create", "--engine", "claude", "--ids", "a", "--state-dir", root])).rejects.toThrow();
      await expect(runHostCli(["conversations", "create", "--engine", "claude", "--thinking", "high", "--state-dir", root])).rejects.toThrow();
      await expect(runHostCli(["conversations", "local", "--engine", "claude", "--state-dir", root])).rejects.toThrow();
      await expect(runHostCli(["conversations", "local", "--title", "Bad", "--state-dir", root])).rejects.toThrow();
      await expect(runHostCli(["conversations", "create", "--bot", "bot_missing", "--state-dir", root])).rejects.toThrow("找不到可用的 Bot");
      await expect(runHostCli(["conversations", "create", "--bot", "bot_disp", "--state-dir", root])).rejects.toThrow("幕僚长");

      // Real end-to-end auto-select create skips dispatcher and sends valid v:1 conversation.create frame
      await runHostCli([
        "conversations", "create",
        "--host", "auto",
        "--engine", "claude",
        "--title", "Real CLI Auto Chat",
        "--request-id", "cli_auto_real_1",
        "--state-dir", root,
        "--json",
      ]);
      const created = JSON.parse(log.mock.calls.at(-1)![0] as string);
      expect(created).toMatchObject({
        host: "macmini",
        hostSelection: "auto",
        botId: "bot_claude",
        createdBot: false,
        conversation: { type: "direct", title: "Real CLI Auto Chat", botIds: ["bot_claude"] },
      });
      const stored = await hub.store.conversations("owner");
      expect(stored.some((conv) => conv.id === created.conversation.id && conv.title === "Real CLI Auto Chat")).toBe(true);

      // Overloaded host is rejected cleanly by --host auto
      loadAvgSpy.mockReturnValue([999, 999, 999]);
      await expect(runHostCli([
        "conversations", "create",
        "--host", "auto",
        "--engine", "claude",
        "--state-dir", root,
        "--json",
      ])).rejects.toThrow("overloaded");
    } finally {
      loadAvgSpy.mockRestore();
      log.mockRestore();
      err.mockRestore();
      client?.close();
      await control?.();
      await hub.close();
    }
  });

  it("handles Pi catalog (?includePi=1), relative --workspace resolution, quota exclusion, and missing resources in CLI", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "cli-ws-"));
    tempDirs.push(workDir);
    const relWorkspace = path.relative(process.cwd(), workDir);
    await mkdir(workDir, { recursive: true });

    const requests: Array<{ path: string; method?: string; body?: unknown }> = [];
    const piClient = {
      ready: {
        serverCapabilities: [HOST_BALANCE_RESOURCES_CAPABILITY, ENGINE_QUOTA_CAPABILITY],
        bots: [{ id: "disp_pi", name: "Chief", engine: "pi", model: "", online: 1, role: "dispatcher" }],
      },
      request: async (reqPath: string, method?: string, body?: unknown) => {
        requests.push({ path: reqPath, method, body });
        if (reqPath === "/api/host-profile") return { name: "macmini", revision: 0 };
        if (reqPath === HOST_BALANCE_RESOURCES_PATH) {
          return { cpuPercent: 18, cpuCores: 8, loadAvg1m: 1.1, memoryUsedPercent: 36, memoryFreeBytes: 8e9, memoryTotalBytes: 16e9, activeTurns: 0, activeTickets: 0, capturedAt: Date.now() };
        }
        if (reqPath === "/api/engine-quotas") return { generatedAt: new Date().toISOString(), scopes: [] };
        if (reqPath.startsWith("/api/bots/catalog?includePi=1")) {
          return {
            engines: [{
              id: "pi",
              available: true,
              catalogStatus: "ready",
              defaultModel: "openai/gpt-5",
              defaultEffort: "high",
              permissions: { defaultChoice: "bypass", choices: [] },
              models: [{ id: "openai/gpt-5", efforts: ["", "high"] }],
            }],
          };
        }
        if (reqPath === "/api/bots" && method === "POST") {
          return { id: "bot_pi_new", name: "pi" };
        }
        if (reqPath === "/api/conversations" && method === "POST") {
          expect(body).toMatchObject({ v: 1, type: "conversation.create", conversationType: "direct", botIds: ["bot_pi_new"] });
          return { id: "conv_pi_1", type: "direct", title: "Pi Auto", ownerId: "owner", botIds: ["bot_pi_new"], archived: false, createdAt: Date.now() };
        }
        throw new Error(`Unexpected request: ${reqPath}`);
      },
    };

    const piRes = await runConversationsCommand(piClient as never, "create", {
      host: "auto",
      engine: "pi",
      title: "Pi Auto",
      workspace: relWorkspace,
    });
    expect(piRes).toMatchObject({ botId: "bot_pi_new", createdBot: true });
    expect(requests.some((r) => r.path.startsWith("/api/bots/catalog?includePi=1"))).toBe(true);
    const botCreateReq = requests.find((r) => r.path === "/api/bots" && r.method === "POST");
    expect(botCreateReq?.body).toMatchObject({
      engine: "pi",
      model: "openai/gpt-5",
      effort: "high",
      permission: "bypass",
      workspace: path.resolve(relWorkspace),
    });

    // Quota exhaustion excludes Host on --host auto
    const exhaustedClient = {
      ready: {
        serverCapabilities: [HOST_BALANCE_RESOURCES_CAPABILITY, ENGINE_QUOTA_CAPABILITY],
        bots: [{ id: "bot_c", name: "Claude", engine: "claude", model: "", online: 1 }],
      },
      request: async (reqPath: string) => {
        if (reqPath === "/api/host-profile") return { name: "macmini", revision: 0 };
        if (reqPath === HOST_BALANCE_RESOURCES_PATH) {
          return { cpuPercent: 10, cpuCores: 8, loadAvg1m: 0.5, memoryUsedPercent: 30, memoryFreeBytes: 10e9, memoryTotalBytes: 16e9, activeTurns: 0, activeTickets: 0, capturedAt: Date.now() };
        }
        if (reqPath === "/api/engine-quotas") {
          return {
            generatedAt: new Date().toISOString(),
            scopes: [makeQuotaScope({ id: "bot_c", engine: "claude", availability: "blocked", constraints: [{ code: "ordinary_usage_blocked", availability: "blocked" }] })],
          };
        }
        throw new Error(`Unexpected request: ${reqPath}`);
      },
    };
    await expect(runConversationsCommand(exhaustedClient as never, "create", { host: "auto", engine: "claude" }))
      .rejects.toThrow("quota_exhausted");

    // Missing host.balance-resources.v1 capability fails --host auto with resources_unavailable
    const noTelemetryClient = {
      ready: {
        serverCapabilities: [],
        bots: [{ id: "bot_c", name: "Claude", engine: "claude", model: "", online: 1 }],
      },
      request: async (reqPath: string) => {
        if (reqPath === "/api/host-profile") return { name: "macmini", revision: 0 };
        throw new Error(`Unexpected request: ${reqPath}`);
      },
    };
    await expect(runConversationsCommand(noTelemetryClient as never, "create", { host: "auto", engine: "claude" }))
      .rejects.toThrow("resources_unavailable");
  });
});
