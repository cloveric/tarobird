import { expect, it, vi } from "vitest";
import { z } from "zod";
import { hubEngineQuotas } from "../src/hub/engine-quota.js";
import { HubError } from "../src/hub/errors.js";
import { unavailableQuota } from "../src/codex/account-quota.js";
import {
  engineQuotaCommand,
  engineQuotaGuidance,
  engineQuotaNotes,
  QUOTA_CLAUDE_UNVERIFIABLE_TEXT,
  QUOTA_EXPIRED_TEXT,
  QUOTA_KIMI_API_KEY_TEXT,
  QUOTA_KIMI_NOT_CODING_PLAN_TEXT,
  QUOTA_PI_UNSUPPORTED_TEXT,
  QUOTA_REASON_TEXT,
  QUOTA_STATE_TEXT,
} from "../src/host-cli/engine-quota.js";
import {
  ENGINE_QUOTA_CAPABILITY,
  ENGINE_QUOTA_CURRENCY_CAPABILITY,
  quotaHelpSchema,
  quotaReasonSchema,
  quotaStateSchema,
} from "../src/client-protocol/engine-quota.js";
import { CAPABILITIES, SERVER_CAPABILITIES } from "../src/client-protocol/index.js";

function fixture() {
  let key = {}, visible = true, authorized = true;
  const call = vi.fn(async (_bot: string, _request: unknown) => ({ scopeId: "bot", revision: "rev", value: {
    ...unavailableQuota("codex", "not_loaded"), id: "bot", revision: "rev", engine: "codex", label: "untrusted label", botIds: ["bot"], sharing: "unverified",
  } }));
  const validate = vi.fn(async () => { if (!authorized) throw new HubError("device_revoked", 403); });
  const quotas = hubEngineQuotas({ bots: async () => visible ? [{ id: "bot", name: "My Bot", engine: "codex" }, { id: "worker", name: "Internal", engine: "codex", role: "worker" }] : [],
    connection: () => ({ key, supported: true, ready: true }), call, validate });
  return { call, quotas, replace: () => { key = {}; }, revoke: () => { authorized = false; }, remove: () => { visible = false; } };
}
it("keeps internal workers out, uses the owner directory label and only cached reads", async () => {
  const f = fixture(), result = await f.quotas.directory();
  expect(result.scopes).toHaveLength(1); expect(result.scopes[0]?.label).toBe("My Bot");
  expect(f.call).toHaveBeenCalledExactlyOnceWith("bot", { scopeId: "bot", refresh: false });
});
it("drops a reply when the worker was replaced during the read", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...args) => { const result = await original(...args); f.replace(); return result; });
  expect(await f.quotas.scope("bot", false)).toMatchObject({ state: "offline", pools: [] });
});
it("rechecks earlier directory results after waiting for other workers", async () => {
  let key = {};
  const secondKey = {};
  const quotas = hubEngineQuotas({
    bots: async () => [{ id: "first", name: "First", engine: "codex" }, { id: "second", name: "Second", engine: "codex" }],
    connection: id => ({ key: id === "first" ? key : secondKey, supported: true, ready: true }),
    validate: async () => undefined,
    call: async id => {
      if (id === "second") { await new Promise(resolve => setImmediate(resolve)); key = {}; }
      return { scopeId: id, revision: "rev", value: { ...unavailableQuota("codex", "not_loaded"), id, revision: "rev", engine: "codex", label: id, botIds: [id], sharing: "unverified" } };
    },
  });
  expect((await quotas.directory()).scopes[0]).toMatchObject({ reason: "offline", pools: [] });
});
it("does not return quota data after owner authorization is revoked", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...args) => { const result = await original(...args); f.revoke(); return result; });
  await expect(f.quotas.directory()).rejects.toMatchObject({ status: 403 });
});
it("drops deleted scopes and validates a single scope after the await", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...args) => { const result = await original(...args); f.remove(); return result; });
  await expect(f.quotas.scope("bot", false)).rejects.toMatchObject({ status: 404 });
});
it("rejects mismatched public identities instead of returning another Bot's value", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...args) => { const result = await original(...args); result.value.botIds = ["other"]; return result; });
  expect(await f.quotas.scope("bot", false)).toMatchObject({ reason: "invalid_response", pools: [] });
});
it("isolates old and offline workers without issuing a native request", async () => {
  const call = vi.fn();
  const quotas = hubEngineQuotas({ bots: async () => [{ id: "old", name: "Old", engine: "codex" }, { id: "offline", name: "Offline", engine: "claude" }],
    connection: id => id === "old" ? { key: {}, supported: false, ready: true } : undefined, call, validate: async () => {} });
  const result = await quotas.directory();
  expect(result.scopes.map(scope => scope.reason)).toEqual(["host_upgrade_required", "offline"]); expect(call).not.toHaveBeenCalled();
});
it("CLI refresh uses exactly the same versioned scope and never creates a turn", async () => {
  const f = fixture(), value = await f.quotas.scope("bot", false);
  const client = { ready: { serverCapabilities: [ENGINE_QUOTA_CAPABILITY] }, request: vi.fn(async () => value) };
  await engineQuotaCommand(client as never, { bot: "bot", refresh: true, revision: "rev" });
  expect(client.request).toHaveBeenCalledExactlyOnceWith("/api/engine-quotas/bot?includeOmp=1&refresh=1&revision=rev");
  await expect(engineQuotaCommand(client as never, { refresh: true })).rejects.toThrow();
  expect(client.request).toHaveBeenCalledOnce();

  const upgraded = { ready: { serverCapabilities: [ENGINE_QUOTA_CAPABILITY, ENGINE_QUOTA_CURRENCY_CAPABILITY] }, request: vi.fn(async () => value) };
  await engineQuotaCommand(upgraded as never, { bot: "bot", refresh: true, revision: "rev" });
  expect(upgraded.request).toHaveBeenCalledExactlyOnceWith("/api/engine-quotas/bot?includeOmp=1&refresh=1&revision=rev&balances=currency");
  expect(SERVER_CAPABILITIES).toContain(ENGINE_QUOTA_CURRENCY_CAPABILITY);
  expect(CAPABILITIES).not.toContain(ENGINE_QUOTA_CURRENCY_CAPABILITY);
});

it("strips non-credits currency balances by default for v1.6.0 compatibility and includes them when opted in", async () => {
  const now = new Date("2026-11-24T08:00:00Z").toISOString();
  const expiresAt = new Date("2026-11-24T08:01:00Z").toISOString();
  const key = {};
  const quotas = hubEngineQuotas({
    bots: async () => [
      { id: "codex_bot", name: "Codex", engine: "codex" },
      { id: "kimi_bot", name: "Kimi", engine: "kimi" },
    ],
    connection: () => ({ key, supported: true, ready: true }),
    validate: async () => undefined,
    call: async id => ({
      scopeId: id,
      revision: `${id}_rev`,
      value: {
        id,
        revision: `${id}_rev`,
        engine: id === "kimi_bot" ? "kimi" : "codex",
        label: id,
        botIds: [id],
        sharing: "unverified",
        authMode: "subscription",
        capability: { mode: "active" },
        state: "ready",
        availability: "unknown",
        observedAt: now,
        constraints: [],
        pools: [{
          id: "pool",
          label: id === "kimi_bot" ? "Kimi Code" : "Codex",
          sharing: "shared",
          availability: "unknown",
          windows: [{ id: "five_hour", label: "5 hours", metric: "percent", usedPercent: 10, availability: "unknown", observedAt: now, expiresAt }],
          balances: [id === "kimi_bot"
            ? { id: "top_up", kind: "currency", amount: "45.50", unit: "CNY", observedAt: now, expiresAt }
            : { id: "credits", kind: "credits", amount: "12.00", unit: "credits", observedAt: now, expiresAt }],
          constraints: [],
        }],
      },
    }),
  });

  const v1BalanceSchema = z.object({ kind: z.literal("credits"), unit: z.literal("credits") }).passthrough();
  const v1Dir = await quotas.directory();
  for (const scope of v1Dir.scopes) {
    for (const pool of scope.pools) {
      for (const balance of pool.balances) expect(v1BalanceSchema.safeParse(balance).success).toBe(true);
    }
  }
  expect(v1Dir.scopes.find(s => s.id === "codex_bot")?.pools[0]?.balances).toHaveLength(1);
  expect(v1Dir.scopes.find(s => s.id === "kimi_bot")?.pools[0]?.balances).toEqual([]);
  expect((await quotas.scope("kimi_bot", false)).pools[0]?.balances).toEqual([]);

  const v2Dir = await quotas.directory({ includeCurrencyBalances: true });
  expect(v2Dir.scopes.find(s => s.id === "kimi_bot")?.pools[0]?.balances).toEqual([
    expect.objectContaining({ id: "top_up", kind: "currency", amount: "45.50", unit: "CNY" }),
  ]);
  expect((await quotas.scope("kimi_bot", false, undefined, { includeCurrencyBalances: true })).pools[0]?.balances).toEqual([
    expect.objectContaining({ id: "top_up", kind: "currency", amount: "45.50", unit: "CNY" }),
  ]);
});

it("gates omp Bots behind includeOmp so 1.6.0 clients never receive unknown engine values", async () => {
  const bots = async () => [
    { id: "codex_bot", name: "Codex Bot", engine: "codex" },
    { id: "omp_bot", name: "OMP Bot", engine: "omp" },
  ];
  const make = (includeOmp?: boolean) => hubEngineQuotas({
    bots,
    includeOmp,
    connection: () => undefined,
    call: vi.fn(),
    validate: async () => {},
  });

  const legacy = make();
  expect((await legacy.directory()).scopes.map(s => s.id)).toEqual(["codex_bot"]);
  await expect(legacy.scope("omp_bot", false)).rejects.toMatchObject({ status: 404, code: "quota_scope_missing" });

  const modern = make(true);
  expect((await modern.directory()).scopes.map(s => [s.id, s.engine])).toEqual([["codex_bot", "codex"], ["omp_bot", "omp"]]);
  expect(await modern.scope("omp_bot", false)).toMatchObject({ id: "omp_bot", engine: "omp", reason: "offline" });
});

// #47-C: the verified official viewing guidance reaches CLI users without changing the JSON contract.
it("CLI guidance names verified official views only for Bots without a current reading", () => {
  const scope = (id: string, engine: "codex" | "kimi" | "pi" | "claude", snapshot: ReturnType<typeof unavailableQuota>) =>
    ({ ...snapshot, id, revision: `${id}_rev`, engine, label: `${id} Bot`, botIds: [id], sharing: "unverified" as const });
  const ready = { ...unavailableQuota("codex", "not_loaded", 1000), state: "ready" as const, reason: undefined, observedAt: new Date(1000).toISOString(), constraints: [{ code: "ordinary_usage_blocked" as const, availability: "blocked" as const, resetsAt: new Date(20_000).toISOString() }] };
  const directory = { generatedAt: new Date(1000).toISOString(), scopes: [
    scope("current", "codex", ready), scope("kimi_a", "kimi", unavailableQuota("kimi", "not_adapted")),
    scope("kimi_b", "kimi", unavailableQuota("kimi", "not_adapted")), scope("pi", "pi", unavailableQuota("pi", "not_adapted")),
    scope("writer", "claude", unavailableQuota("claude", "scope_unverifiable")),
  ] };
  const lines = engineQuotaGuidance(directory, 2000);
  expect(lines).toEqual([expect.stringMatching(/^kimi_a Bot, kimi_b Bot: .*\/usage.*ACP/), expect.stringMatching(/^writer Bot: .*claude\.ai\/settings\/usage/)]);
  expect(lines.join("\n")).not.toMatch(/_rev|current/);
  // The same reading becomes guidance-worthy once its constraint reset passes.
  expect(engineQuotaGuidance(directory.scopes[0]!, 20_000)).toEqual([expect.stringContaining("Codex CLI")]);
  for (const help of quotaHelpSchema.options) expect(engineQuotaGuidance({ ...directory.scopes[1]!, help }, 2000)[0]).toMatch(/官方查看.+ \/ Official view/);
});

// Fable Q4: headless users see the same status/reason wording as the App, not only a reason code.
it("CLI status and reason text is the App's own wording in both languages", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../client/src/EngineQuota.tsx", import.meta.url), "utf8");
  const en = JSON.parse(await readFile(new URL("../client/src/locales/en.json", import.meta.url), "utf8")) as Record<string, string>;
  const pairs = [
    ...Object.values(QUOTA_STATE_TEXT),
    ...Object.values(QUOTA_REASON_TEXT),
    QUOTA_CLAUDE_UNVERIFIABLE_TEXT,
    QUOTA_KIMI_API_KEY_TEXT,
    QUOTA_KIMI_NOT_CODING_PLAN_TEXT,
    QUOTA_PI_UNSUPPORTED_TEXT,
  ];
  for (const [zh, english] of pairs) { expect(app).toContain(`t("${zh}")`); expect(en[zh]).toBe(english); }
  // The CLI prints an expiry reason. The App shows expiry once in the card status.
  expect(en[QUOTA_EXPIRED_TEXT[0]]).toBe(QUOTA_EXPIRED_TEXT[1]);
  expect(Object.keys(QUOTA_REASON_TEXT).sort()).toEqual([...quotaReasonSchema.options].sort());
  expect(Object.keys(QUOTA_STATE_TEXT).sort()).toEqual([...quotaStateSchema.options].sort());
});

it("CLI notes explain why each Bot has no current reading, how to refresh it and where to look", () => {
  const scope = (id: string, engine: "codex" | "claude" | "kimi" | "pi", snapshot: ReturnType<typeof unavailableQuota>) =>
    ({ ...snapshot, id, revision: `${id}_rev`, engine, label: `${id} Bot`, botIds: [id], sharing: "unverified" as const });
  const ready = { ...unavailableQuota("codex", "not_loaded", 1000), state: "ready" as const, reason: undefined, capability: { mode: "active" as const }, observedAt: new Date(1000).toISOString() };
  const directory = { generatedAt: new Date(1000).toISOString(), scopes: [
    scope("current", "codex", ready),
    scope("expired", "codex", { ...ready, observedAt: new Date(-100_000).toISOString() }),
    scope("signin", "codex", unavailableQuota("codex", "login_required")),
    scope("apikey", "codex", unavailableQuota("codex", "mode_not_supported", 1000, "api_key")),
    scope("keyring", "codex", { ...unavailableQuota("codex", "scope_unverifiable"), nextRefreshAt: new Date(50_000).toISOString() }),
    scope("keychain", "claude", unavailableQuota("claude", "scope_unverifiable")),
    scope("kimi", "kimi", unavailableQuota("kimi", "not_adapted")),
    scope("kimi_key", "kimi", unavailableQuota("kimi", "mode_not_supported", 1000, "api_key")),
    scope("kimi_404", "kimi", { ...unavailableQuota("kimi", "mode_not_supported", 1000, "other"), capability: { mode: "active" as const, reason: "mode_not_supported" as const } }),
    scope("pi", "pi", unavailableQuota("pi", "mode_not_supported", 1000, "other")),
  ] };
  const notes = engineQuotaNotes(directory, 2000), text = notes.join("\n");
  expect(text).not.toMatch(/current Bot/);
  expect(notes).toContain("expired Bot（Codex）：待更新 — 已过期，需重新读取 / Awaiting update — Expired; refresh required");
  expect(notes).toContain("signin Bot（Codex）：需要登录 — 请先在运行主机上完成引擎登录，再刷新。 / Sign-in required — Sign in to the engine on the Host, then refresh.");
  expect(notes).toContain("apikey Bot（Codex）：暂不支持 — 此授权方式不提供可读取的原生额度。 / Not supported — This authorization mode does not provide readable native quotas.");
  expect(notes).toContain(`pi Bot（Pi）：暂不支持 — ${QUOTA_PI_UNSUPPORTED_TEXT[0]} / Not supported — ${QUOTA_PI_UNSUPPORTED_TEXT[1]}`);
  expect(text).toContain(`keyring Bot（Codex）：尚无数据 — ${QUOTA_REASON_TEXT.scope_unverifiable[0]}`);
  expect(text).toContain(`keychain Bot（Claude Code）：尚无数据 — ${QUOTA_CLAUDE_UNVERIFIABLE_TEXT[0]}`);
  expect(notes).toContain(`kimi_key Bot（Kimi）：暂不支持 — ${QUOTA_KIMI_API_KEY_TEXT[0]} / Not supported — ${QUOTA_KIMI_API_KEY_TEXT[1]}`);
  expect(notes).toContain(`kimi_404 Bot（Kimi）：暂不支持 — ${QUOTA_KIMI_NOT_CODING_PLAN_TEXT[0]} / Not supported — ${QUOTA_KIMI_NOT_CODING_PLAN_TEXT[1]}`);
  // Refresh commands only for active readers that can refresh, with the App's cooldown.
  expect(notes).toContain("  刷新 / Refresh: tarobird engines quota --bot signin --refresh --revision signin_rev");
  expect(notes).toContain("  刷新 / Refresh: tarobird engines quota --bot kimi_404 --refresh --revision kimi_404_rev");
  expect(notes).toContain(`  刷新 / Refresh（${new Date(50_000).toISOString()} 后 / after ${new Date(50_000).toISOString()}）: tarobird engines quota --bot keyring --refresh --revision keyring_rev`);
  expect(text).not.toMatch(/--bot (apikey|keychain|kimi|kimi_key|pi) /);
  expect(notes.filter(line => line.includes("官方查看")).length).toBeGreaterThan(0);
  expect(notes.at(-1)).toMatch(/^kimi Bot, kimi_key Bot, kimi_404 Bot: 官方查看/);
});

it("matches same-account Bots via Hub-private accountProof without leaking proofs or overloading revision", async () => {
  const keyA = {}, keyB = {}, keyC = {};
  const proofA = "1".repeat(64), proofC = "2".repeat(64);
  const proofs = new Map<string, string | undefined>([["bot_a", proofA], ["bot_b", proofA], ["bot_c", proofC]]);
  const proofStore = new Map();
  let botBOnline = true;
  const quotas = hubEngineQuotas({
    bots: async () => [
      { id: "bot_a", name: "Bot A", engine: "codex" },
      { id: "bot_b", name: "Bot B", engine: "codex" },
      { id: "bot_c", name: "Bot C", engine: "codex" },
    ],
    connection: id => id === "bot_a"
      ? { key: keyA, supported: true, ready: true }
      : id === "bot_b"
        ? (botBOnline ? { key: keyB, supported: true, ready: true } : undefined)
        : { key: keyC, supported: true, ready: true },
    validate: async () => undefined,
    call: async id => ({
      scopeId: id,
      revision: `rev_${id}`,
      value: {
        ...unavailableQuota("codex", "not_loaded"),
        state: "ready",
        reason: undefined,
        observedAt: new Date(2000).toISOString(),
        id,
        revision: `rev_${id}`,
        engine: "codex",
        label: id,
        botIds: [id],
        sharing: "unverified",
      },
    }),
    accountProof: async id => proofs.get(id),
    proofStore,
  });

  const directory = await quotas.directory();
  expect(JSON.stringify(directory)).not.toContain(proofA);
  expect(JSON.stringify(directory)).not.toContain(proofC);
  expect(directory.scopes.map(s => ({ id: s.id, revision: s.revision, sharing: s.sharing, botIds: s.botIds }))).toEqual([
    { id: "bot_a", revision: "rev_bot_a", sharing: "verified", botIds: ["bot_a", "bot_b"] },
    { id: "bot_b", revision: "rev_bot_b", sharing: "verified", botIds: ["bot_a", "bot_b"] },
    { id: "bot_c", revision: "rev_bot_c", sharing: "verified", botIds: ["bot_c"] },
  ]);

  // Single-scope refresh preserves verified peer membership while peer stays connected, and drops it if peer disconnects
  const refreshed = await quotas.scope("bot_a", true, "rev_bot_a");
  expect(refreshed).toMatchObject({ id: "bot_a", sharing: "verified", botIds: ["bot_a", "bot_b"] });
  botBOnline = false;
  const afterDisconnect = await quotas.scope("bot_a", true, "rev_bot_a");
  expect(afterDisconnect).toMatchObject({ id: "bot_a", sharing: "verified", botIds: ["bot_a"] });
});

it("keeps verified sharing when a worker returns stale+timeout with an unchanged valid proof, and clears it on auth_changed", async () => {
  const keyA = {}, keyB = {};
  const sharedProof = "3".repeat(64);
  const proofStore = new Map();
  let mode: "ready" | "timeout" | "auth_changed" = "ready";
  const quotas = hubEngineQuotas({
    bots: async () => [
      { id: "bot_a", name: "Bot A", engine: "codex" },
      { id: "bot_b", name: "Bot B", engine: "codex" },
    ],
    connection: id => ({ key: id === "bot_a" ? keyA : keyB, supported: true, ready: true }),
    validate: async () => undefined,
    call: async id => {
      const base = {
        ...unavailableQuota("codex", "not_loaded"),
        state: "ready" as const,
        reason: undefined,
        observedAt: new Date(2000).toISOString(),
        id,
        revision: `rev_${id}`,
        engine: "codex" as const,
        label: id,
        botIds: [id],
        sharing: "unverified" as const,
      };
      if (id === "bot_a" && mode === "timeout") {
        return { scopeId: id, revision: `rev_${id}`, value: { ...base, state: "stale" as const, reason: "timeout" as const } };
      }
      if (id === "bot_a" && mode === "auth_changed") {
        return { scopeId: id, revision: "rev_bot_a_new", value: { ...unavailableQuota("codex", "auth_changed"), id, revision: "rev_bot_a_new", engine: "codex" as const, label: id, botIds: [id], sharing: "unverified" as const } };
      }
      return { scopeId: id, revision: `rev_${id}`, value: base };
    },
    accountProof: async () => sharedProof,
    proofStore,
  });

  await quotas.directory();
  mode = "timeout";
  const timedOut = await quotas.scope("bot_a", true, "rev_bot_a");
  expect(timedOut).toMatchObject({ id: "bot_a", state: "stale", reason: "timeout", sharing: "verified", botIds: ["bot_a", "bot_b"] });

  mode = "auth_changed";
  const changed = await quotas.scope("bot_a", true, "rev_bot_a");
  expect(changed).toMatchObject({ id: "bot_a", reason: "auth_changed", sharing: "unverified", botIds: ["bot_a"] });
});
