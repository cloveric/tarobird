import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { GatewayTransport } from "../src/gateway/transport.js";
import { gatewayEngineQuota } from "../src/gateway/engine-quota.js";
import { unavailableQuota } from "../src/codex/account-quota.js";
import type { EngineQuotaReadOptions, EngineQuotaReadResult } from "../src/codex/adapter-account-quota.js";
import {
  ENGINE_QUOTA_CAPABILITY,
  ENGINE_QUOTA_CURRENCY_CAPABILITY,
  quotaDirectorySchema,
  quotaScopeSchema,
} from "../src/client-protocol/engine-quota.js";
import { bootstrapTrusted } from "./helpers/pairing-invite.js";
import { quotaDirectorySchema as releasedDirectorySchema, quotaScopeSchema as releasedScopeSchema } from "./helpers/quota-schema-1.6.0.js";
import { engineQuotaCommand } from "../src/host-cli/engine-quota.js";

let root: string, hub: HubServer, token: string, transport: GatewayTransport;
let read: ReturnType<typeof vi.fn<(options: EngineQuotaReadOptions) => Promise<EngineQuotaReadResult | undefined>>>;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "quota-api-"));
  hub = await HubServer.start({ stateDir: root });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('quota_bot','Example Bot',?,'codex')", [hashSecret(secret)]);
  const keys = generateKeyPairSync("ed25519"), nonce = randomBytes(32).toString("base64url");
  await bootstrapTrusted(hub.auth, { deviceId: "device", name: "Example device", platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") });
  const challenge = await hub.auth.challenge("device", "device", nonce, "fixture");
  token = (await hub.auth.authenticate("device", sign(null, deviceProof("device", challenge.nonce, nonce), keys.privateKey).toString("base64"))).token;
  read = vi.fn<(options: EngineQuotaReadOptions) => Promise<EngineQuotaReadResult | undefined>>(async () => ({
    revision: "revision_one",
    snapshot: unavailableQuota("codex", "not_loaded"),
    proof: { engine: "codex", scopeStamp: "private_account_proof", accountKey: "private_account_key" },
  }));
  transport = new GatewayTransport({ stateDir: path.join(root, "gateway"), url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "quota_bot", secret, engine: "codex" });
  const handle = gatewayEngineQuota({ botId: "quota_bot", engine: "codex", read });
  transport.onCall = (method, params) => { if (method !== "quota.get") throw new Error("unexpected_method"); return handle(params); };
  let attached!: () => void;
  const ready = new Promise<void>(resolve => { attached = resolve; }); transport.onBoot = async () => attached();
  await transport.connect(); await ready;
});
afterEach(async () => { await transport?.disconnect(); await hub?.close(); await rm(root, { recursive: true, force: true }); });
const request = (route: string) => fetch(hub.url + route, { headers: { Authorization: `Bearer ${token}` } });

it("round trips cache and explicit refresh through actual HTTP and Gateway, without chat or durable outbox", async () => {
  const response = await request("/api/engine-quotas"); expect(response.status).toBe(200);
  const directory = quotaDirectorySchema.parse(await response.json());
  expect(directory.scopes).toHaveLength(1);
  expect(directory.scopes[0]).toMatchObject({ id: "quota_bot", label: "Example Bot", revision: "revision_one", reason: "not_loaded" });
  expect(JSON.stringify(directory)).not.toContain("private_account_proof");
  expect(read.mock.calls.map(args => args[0].refresh)).toEqual([false]);
  const refreshed = await request("/api/engine-quotas/quota_bot?refresh=1&revision=revision_one");
  expect(refreshed.status).toBe(200); expect(quotaScopeSchema.parse(await refreshed.json()).revision).toBe("revision_one");
  expect(read.mock.calls.map(args => args[0].refresh)).toEqual([false, false, true]);
  expect(await hub.store.db.get("SELECT COUNT(*) AS count FROM messages")).toEqual({ count: 0 });
  expect(await readdir(path.join(root, "gateway")).catch(() => [])).not.toContain("gateway-outbox.json");
});

it("requires authentication, owner access, an existing scope and a seen revision", async () => {
  expect((await fetch(hub.url + "/api/engine-quotas")).status).toBe(401);
  expect((await request("/api/engine-quotas?refresh=1")).status).toBe(400);
  expect((await request("/api/engine-quotas/quota_bot?refresh=1")).status).toBe(400);
  expect((await request("/api/engine-quotas/missing")).status).toBe(404);
  await hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
  expect((await request("/api/engine-quotas")).status).toBe(403);
  expect((await request("/api/engine-quotas/quota_bot?refresh=1&revision=revision_one")).status).toBe(403);
  expect(read).not.toHaveBeenCalled();
});

it.each(["revoke", "demote"] as const)("does not disclose a late quota reply after %s", async action => {
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  read.mockImplementation(async () => { entered(); await held; return { revision: "one", snapshot: unavailableQuota("codex", "not_loaded") }; });
  const response = request("/api/engine-quotas");
  try {
    await reading;
    if (action === "revoke") await hub.auth.revoke("device", "local-owner");
    else await hub.store.db.serial(() => hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'"));
  } finally { release(); }
  const result = await response; expect(result.status).toBe(action === "revoke" ? 401 : 403);
  expect(await result.text()).not.toContain("not_loaded");
});

it("uses the same authenticated HTTP quota contract from the headless CLI", async () => {
  const client = { ready: { serverCapabilities: [ENGINE_QUOTA_CAPABILITY] }, request: async (route: string) => {
    const response = await request(route); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json();
  } };
  const initial = quotaDirectorySchema.parse(await engineQuotaCommand(client as any, {}));
  expect(initial.scopes[0].revision).toBe("revision_one");
  const calls = read.mock.calls.length;
  await expect(engineQuotaCommand(client as any, { refresh: true, bot: "quota_bot" })).rejects.toThrow("--revision");
  expect(read.mock.calls).toHaveLength(calls);
  const refreshed = quotaScopeSchema.parse(await engineQuotaCommand(client as any, { bot: "quota_bot", refresh: true, revision: initial.scopes[0].revision }));
  expect(refreshed.id).toBe("quota_bot");
  expect(read.mock.calls.filter(args => args[0].refresh)).toHaveLength(1);
  expect(await hub.store.db.get("SELECT COUNT(*) AS count FROM messages")).toEqual({ count: 0 });
});

it("omits currency balances for legacy v1.6.0 HTTP requests and returns them when ?balances=currency is requested", async () => {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  read.mockImplementation(async () => ({
    revision: "revision_currency",
    snapshot: {
      authMode: "subscription",
      capability: { mode: "active" },
      state: "ready",
      availability: "unknown",
      observedAt: now,
      lastAttemptAt: now,
      constraints: [],
      pools: [{
        id: "kimi",
        label: "Kimi Code",
        sharing: "shared",
        availability: "unknown",
        windows: [{ id: "five_hour", label: "5 hours", metric: "percent", usedPercent: 10, availability: "unknown", observedAt: now, expiresAt }],
        balances: [
          { id: "credits", kind: "credits", amount: "5.00", unit: "credits", observedAt: now, expiresAt },
          { id: "top_up", kind: "currency", amount: "45.50", unit: "CNY", observedAt: now, expiresAt },
        ],
        constraints: [],
      }],
    },
  }));

  const legacyDir = quotaDirectorySchema.parse(await (await request("/api/engine-quotas")).json());
  expect(legacyDir.scopes[0]!.pools[0]!.balances.map(b => b.kind)).toEqual(["credits"]);
  const legacyScope = quotaScopeSchema.parse(await (await request("/api/engine-quotas/quota_bot")).json());
  expect(legacyScope.pools[0]!.balances.map(b => b.kind)).toEqual(["credits"]);

  const currencyDir = quotaDirectorySchema.parse(await (await request("/api/engine-quotas?balances=currency")).json());
  expect(currencyDir.scopes[0]!.pools[0]!.balances.map(b => [b.kind, b.amount, b.unit])).toEqual([
    ["credits", "5.00", "credits"],
    ["currency", "45.50", "CNY"],
  ]);

  const cliClient = {
    ready: { serverCapabilities: [ENGINE_QUOTA_CAPABILITY, ENGINE_QUOTA_CURRENCY_CAPABILITY] },
    request: async (route: string) => {
      const response = await request(route);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    },
  };
  const cliDir = quotaDirectorySchema.parse(await engineQuotaCommand(cliClient as any, {}));
  expect(cliDir.scopes[0]!.pools[0]!.balances.map(b => b.kind)).toEqual(["credits", "currency"]);
});

it("gates currency balances behind engines.quota.currency.v1 so v1.6.0 clients stay schema-compatible", async () => {
  const now = Date.now(), observedAt = new Date(now).toISOString(), expiresAt = new Date(now + 60_000).toISOString();
  const dshSecret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('deepseek_bot','DeepSeek Bot',?,'deepseek')", [hashSecret(dshSecret)]);
  const dshTransport = new GatewayTransport({ stateDir: path.join(root, "gateway-dsh"), url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "deepseek_bot", secret: dshSecret, engine: "deepseek" });
  const dshHandle = gatewayEngineQuota({
    botId: "deepseek_bot",
    engine: "deepseek",
    read: async () => ({
      revision: "dsh_rev",
      snapshot: {
        authMode: "subscription",
        capability: { mode: "active" },
        state: "ready",
        availability: "unknown",
        observedAt,
        lastAttemptAt: observedAt,
        pools: [{
          id: "deepseek_wallet",
          label: "DeepSeek",
          sharing: "shared",
          availability: "unknown",
          windows: [],
          balances: [{ id: "recharge_cny", kind: "currency", amount: "42.00", unit: "CNY", observedAt, expiresAt }],
          constraints: [],
        }],
        constraints: [],
        help: "deepseek_balance",
      },
    }),
  });
  dshTransport.onCall = (method, params) => { if (method !== "quota.get") throw new Error("unexpected_method"); return dshHandle(params); };
  let attached!: () => void;
  const ready = new Promise<void>(resolve => { attached = resolve; });
  dshTransport.onBoot = async () => attached();
  await dshTransport.connect();
  await ready;

  try {
    // v1.6.0 client: does not ask for currency balances and expects zero kind:"currency" balances.
    const v1Dir = quotaDirectorySchema.parse(await (await request("/api/engine-quotas")).json());
    const v1DeepSeek = v1Dir.scopes.find(scope => scope.id === "deepseek_bot");
    expect(v1DeepSeek).toMatchObject({ id: "deepseek_bot", state: "unknown", pools: [], help: "deepseek_balance" });
    expect(v1DeepSeek?.observedAt).toBeUndefined();
    for (const scope of v1Dir.scopes) {
      for (const pool of scope.pools) {
        for (const balance of pool.balances) {
          expect(balance.kind).toBe("credits");
          expect(balance.unit).toBe("credits");
        }
      }
    }
    const v1Scope = quotaScopeSchema.parse(await (await request("/api/engine-quotas/deepseek_bot")).json());
    expect(v1Scope).toMatchObject({ id: "deepseek_bot", state: "unknown", pools: [] });

    // Updated client: asks with ?balances=currency (the Hub advertises engines.quota.currency.v1) and receives full currency balances.
    const v2Dir = quotaDirectorySchema.parse(await (await request("/api/engine-quotas?balances=currency")).json());
    const v2DeepSeek = v2Dir.scopes.find(scope => scope.id === "deepseek_bot");
    expect(v2DeepSeek?.state).toBe("ready");
    expect(v2DeepSeek?.pools[0]?.balances[0]).toMatchObject({ id: "recharge_cny", kind: "currency", amount: "42.00", unit: "CNY" });

    const v2Scope = quotaScopeSchema.parse(await (await request("/api/engine-quotas/deepseek_bot?balances=currency")).json());
    expect(v2Scope.pools[0]?.balances[0]).toMatchObject({ id: "recharge_cny", kind: "currency", amount: "42.00", unit: "CNY" });
  } finally {
    await dshTransport.disconnect();
  }
});

// #111 (Kimi top-up) and #112 (DeepSeek wallet) share one negotiation, one schema and one projection.
it("one Hub reply carries the Kimi and the DeepSeek balance for ?balances=currency, and a 1.6.0 client can parse what it gets without it", async () => {
  const now = Date.now(), observedAt = new Date(now).toISOString(), expiresAt = new Date(now + 60_000).toISOString();
  // The fixture Bot answers with a Kimi-shaped pool: a plan window, a credits balance and the top-up pack.
  read.mockImplementation(async () => ({
    revision: "revision_kimi",
    snapshot: {
      authMode: "subscription", capability: { mode: "active" }, state: "ready", availability: "unknown", observedAt, lastAttemptAt: observedAt, constraints: [], help: "kimi_usage",
      pools: [{ id: "kimi", label: "Kimi Code", sharing: "shared", availability: "unknown", constraints: [],
        windows: [{ id: "five_hour", label: "5 hours", metric: "percent", usedPercent: 10, availability: "unknown", observedAt, expiresAt }],
        balances: [
          { id: "credits", kind: "credits", amount: "5.00", unit: "credits", observedAt, expiresAt },
          { id: "top_up", kind: "currency", amount: "45.50", unit: "CNY", observedAt, expiresAt },
        ] }],
    },
  }));
  // A second Bot answers with DeepSeek's wallet: currency balances and nothing else.
  const dshSecret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('deepseek_bot','DeepSeek Bot',?,'deepseek')", [hashSecret(dshSecret)]);
  const dshTransport = new GatewayTransport({ stateDir: path.join(root, "gateway-dsh"), url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "deepseek_bot", secret: dshSecret, engine: "deepseek" });
  const dshHandle = gatewayEngineQuota({ botId: "deepseek_bot", engine: "deepseek", read: async () => ({
    revision: "dsh_rev",
    snapshot: {
      authMode: "subscription", capability: { mode: "active" }, state: "ready", availability: "unknown", observedAt, lastAttemptAt: observedAt, constraints: [], help: "deepseek_balance",
      pools: [{ id: "deepseek_wallet", label: "DeepSeek", sharing: "shared", availability: "unknown", windows: [], constraints: [],
        balances: [
          { id: "recharge_cny", kind: "currency", amount: "42.00", unit: "CNY", observedAt, expiresAt },
          { id: "bonus_cny", kind: "currency", amount: "5.25", unit: "CNY", observedAt, expiresAt },
        ] }],
    },
  }) });
  dshTransport.onCall = (method, params) => { if (method !== "quota.get") throw new Error("unexpected_method"); return dshHandle(params); };
  let attached!: () => void;
  const ready = new Promise<void>(resolve => { attached = resolve; });
  dshTransport.onBoot = async () => attached();
  await dshTransport.connect();
  await ready;
  const json = async (route: string) => { const response = await request(route); expect(response.status).toBe(200); return response.json() as Promise<unknown>; };
  try {
    // An updated App or CLI: both balances, in one schema.
    const full = quotaDirectorySchema.parse(await json("/api/engine-quotas?balances=currency"));
    const balances = (id: string) => full.scopes.find(scope => scope.id === id)!.pools.flatMap(pool => pool.balances.map(balance => [balance.id, balance.kind, balance.amount, balance.unit]));
    expect(balances("quota_bot")).toEqual([["credits", "credits", "5.00", "credits"], ["top_up", "currency", "45.50", "CNY"]]);
    expect(balances("deepseek_bot")).toEqual([["recharge_cny", "currency", "42.00", "CNY"], ["bonus_cny", "currency", "5.25", "CNY"]]);
    expect(quotaScopeSchema.parse(await json("/api/engine-quotas/quota_bot?balances=currency")).pools[0]!.balances.map(balance => balance.id)).toEqual(["credits", "top_up"]);
    expect(quotaScopeSchema.parse(await json("/api/engine-quotas/deepseek_bot?refresh=1&revision=dsh_rev&balances=currency")).pools[0]!.balances.map(balance => balance.id)).toEqual(["recharge_cny", "bonus_cny"]);
    // That reply is not one a 1.6.0 client could read: the gate is what keeps it working.
    expect(releasedDirectorySchema.safeParse(await json("/api/engine-quotas?balances=currency")).success).toBe(false);

    // A 1.6.0 App or CLI asks without the parameter. Its closed schema accepts the directory, a single scope
    // and an explicit refresh; the Kimi windows stay, and the wallet-only reading is "no data", not an empty "read".
    const released = releasedDirectorySchema.parse(await json("/api/engine-quotas"));
    const kimi = released.scopes.find(scope => scope.id === "quota_bot")!, deepseek = released.scopes.find(scope => scope.id === "deepseek_bot")!;
    expect(kimi).toMatchObject({ state: "ready", observedAt, pools: [{ id: "kimi", windows: [{ id: "five_hour" }], balances: [{ id: "credits", kind: "credits", unit: "credits" }] }] });
    expect(deepseek).toMatchObject({ state: "unknown", pools: [], help: "deepseek_balance" });
    expect(deepseek.observedAt).toBeUndefined();
    expect(releasedScopeSchema.parse(await json("/api/engine-quotas/quota_bot")).pools[0]!.balances.map(balance => balance.id)).toEqual(["credits"]);
    expect(releasedScopeSchema.parse(await json("/api/engine-quotas/deepseek_bot")).pools).toEqual([]);
    expect(releasedScopeSchema.parse(await json("/api/engine-quotas/quota_bot?refresh=1&revision=revision_kimi")).pools[0]!.balances.map(balance => balance.id)).toEqual(["credits"]);
    expect(releasedScopeSchema.parse(await json("/api/engine-quotas/deepseek_bot?refresh=1&revision=dsh_rev"))).toMatchObject({ state: "unknown", pools: [] });
    // No request header takes part: the App's native transports allow only a fixed short list.
    const preflight = await fetch(hub.url + "/api/engine-quotas", { method: "OPTIONS" });
    expect(preflight.headers.get("access-control-allow-headers")).toBe("Authorization, Content-Type, Range, If-Range");
  } finally {
    await dshTransport.disconnect();
  }
});

it("excludes omp Bots from /api/engine-quotas unless includeOmp=1 is requested (1.6.0 client compatibility)", async () => {
  const ompSecret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('omp_bot','OMP Bot',?,'omp')", [hashSecret(ompSecret)]);

  // 1.6.0 client requests /api/engine-quotas without includeOmp=1 and parses with a closed 6-engine enum.
  const legacyDirRes = await request("/api/engine-quotas");
  expect(legacyDirRes.status).toBe(200);
  const legacyDir = quotaDirectorySchema.parse(await legacyDirRes.json());
  expect(legacyDir.scopes.map(s => s.id)).toEqual(["quota_bot"]);
  expect(legacyDir.scopes.every(s => s.engine !== "omp")).toBe(true);
  expect((await request("/api/engine-quotas/omp_bot")).status).toBe(404);

  // New client & Host CLI pass includeOmp=1 and see omp Bots cleanly.
  const modernDirRes = await request("/api/engine-quotas?includeOmp=1");
  expect(modernDirRes.status).toBe(200);
  const modernDir = quotaDirectorySchema.parse(await modernDirRes.json());
  expect(modernDir.scopes.map(s => [s.id, s.engine]).sort()).toEqual([["omp_bot", "omp"], ["quota_bot", "codex"]]);

  const modernScopeRes = await request("/api/engine-quotas/omp_bot?includeOmp=1");
  expect(modernScopeRes.status).toBe(200);
  expect(quotaScopeSchema.parse(await modernScopeRes.json())).toMatchObject({ id: "omp_bot", engine: "omp", state: "offline" });

  // Headless Host CLI passes includeOmp=1 automatically.
  const cliClient = { ready: { serverCapabilities: [ENGINE_QUOTA_CAPABILITY] }, request: async (route: string) => {
    const response = await request(route); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json();
  } };
  const cliDir = quotaDirectorySchema.parse(await engineQuotaCommand(cliClient as any, {}));
  expect(cliDir.scopes.map(s => s.id).sort()).toEqual(["omp_bot", "quota_bot"]);
});
