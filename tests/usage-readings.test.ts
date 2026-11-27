import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuotaScope, QuotaWindow } from "../src/client-protocol/engine-quota.js";
import type { HubConnection } from "../client/src/connection.js";
import {
  applyHostQuotaScope,
  cachedQuotaDirectory,
  clearStoredQuotaHost,
  ingestQuotaDirectory,
  projectQuotaDirectory,
  readStoredQuota,
  resetQuotaStoreForTests,
  subscribeQuotaStore,
} from "../client/src/quota-store.js";
import {
  contextView,
  forgetSavedQuota,
  formatTimeRemaining,
  loadSavedQuota,
  mayAskEngine,
  nextHeldQuota,
  poolCoversModel,
  QUOTA_BACKGROUND_POLL_MS,
  QUOTA_MAX_STALE_MS,
  QUOTA_RETRY_BACKOFF_MS,
  QUOTA_SHOWN_FOR_MS,
  QUOTA_SIGN_IN_RETRY_MS,
  quotaReadingAgeLabel,
  quotaRetryDelayMs,
  quotaView,
  quotaViewEndsAt,
  quotaViewNextChangeAt,
  savedQuotaAfter,
  saveQuota,
  SAVED_QUOTA_KEY,
  shortTokens,
  usageTone,
} from "../client/src/usage-readings.js";

const now = Date.parse("2026-11-22T10:00:00Z");
const iso = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const window = (id: string, usedPercent: number, extra: Partial<QuotaWindow> = {}): QuotaWindow =>
  ({ id, label: id, metric: "percent", usedPercent, availability: "unknown", observedAt: iso(-1), expiresAt: iso(0), resetsAt: iso(120), ...extra }) as QuotaWindow;
const scope = (engine: QuotaScope["engine"], pools: Array<{ label: string; models?: string[]; windows: QuotaWindow[]; constraints?: QuotaScope["constraints"] }>, extra: Partial<QuotaScope> = {}): QuotaScope => ({
  id: "bot", revision: "r", engine, label: engine, botIds: ["bot"], sharing: "unverified", authMode: "subscription", capability: { mode: "active" }, state: "ready", availability: "unknown",
  observedAt: iso(-1), constraints: [], pools: pools.map((pool, index) => ({ id: `p${index}`, label: pool.label, ...(pool.models ? { models: pool.models } : {}), sharing: pool.models ? "model" : "shared", availability: "unknown", windows: pool.windows, balances: [], constraints: pool.constraints ?? [] })), ...extra });

describe("context left", () => {
  it("is the share of the window not in use, with the engine's compaction point", () => {
    expect(contextView({ supported: true, usedTokens: 76_000, windowTokens: 200_000, autoCompactTokens: 167_000 })).toEqual({ left: 62, usedTokens: 76_000, windowTokens: 200_000, compactAt: 84 });
    expect(contextView({ supported: true, usedTokens: 250_000, windowTokens: 200_000 })).toMatchObject({ left: 0 });
    expect(contextView({ supported: true, usedTokens: 0, windowTokens: 200_000 })).toEqual({ left: 100, usedTokens: 0, windowTokens: 200_000 });
  });
  it("is absent without a sample", () => {
    for (const usage of [undefined, { supported: false }, { supported: true }, { supported: true, usedTokens: 5 }, { supported: true, windowTokens: 5 }]) expect(contextView(usage)).toBeUndefined();
  });
});

describe("quota left for one Bot", () => {
  it("shows the tightest window of a pool that names no models", () => {
    const view = quotaView(scope("codex", [{ label: "Codex", windows: [window("primary", 20, { periodSeconds: 18000 }), window("secondary", 10, { periodSeconds: 604800 })] }]), "gpt-6.1-sol", now)!;
    expect(view.left).toBe(80);
    expect(view.stale).toBe(false);
    expect(view.windows.map(item => [item.pool, item.left, item.periodSeconds])).toEqual([["Codex", 80, 18000], ["Codex", 90, 604800]]);
  });
  const agy = scope("antigravity", [
    { label: "Gemini Models", models: ["Gemini 4 Neon", "Gemini 4 Hydrogen", "Orchestrator (Neon)", "Gemini 3.8 Flash"], windows: [window("gemini-weekly", 37), window("gemini-5h", 6)] },
    { label: "Claude and GPT models", models: ["Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-OSS 120B"], windows: [window("3p-weekly", 55), window("3p-5h", 0)] },
    { label: "Gemini 4 Argon", models: ["Gemini 4 Argon"], windows: [window("gemini-argon-wtu-weekly", 100)] },
  ]);
  it.each([["gemini-4-neon-high", "Gemini Models", 63], ["gemini-3.8-flash-low", "Gemini Models", 63], ["claude-opus-5-5-medium", "Claude and GPT models", 45], ["gpt-oss-120b-medium", "Claude and GPT models", 45], ["gemini-4-argon-medium", "Gemini 4 Argon", 0]])(
    "counts only the group of the Bot's model (%s)", (model, pool, left) => {
      const view = quotaView(agy, model, now)!;
      expect(view.left).toBe(left); expect(new Set(view.windows.map(item => item.pool))).toEqual(new Set([pool]));
    });
  it("shows nothing when the Bot's group cannot be told, instead of another group's alarm", () => {
    for (const model of ["", "gemini-pro-orchestrator-g1-pro", "some-future-model"]) expect(quotaView(agy, model, now)).toBeUndefined();
  });
  it("matches a model name only as a whole", () => {
    expect(poolCoversModel(["Gemini 4 Neon"], "gemini-4-neon")).toBe(true);
    expect(poolCoversModel(["Gemini 4 Neon"], "gemini-4-neon-xhigh")).toBe(true);
    expect(poolCoversModel(["gpt-5.3-codex-spark"], "gpt-5.3-codex-spark")).toBe(true);
    expect(poolCoversModel(["Gemini 4"], "gemini-4-neon-high")).toBe(false);
    expect(poolCoversModel(["Gemini 4 Neon"], "gemini-4-neon-preview-high")).toBe(false);
    expect(poolCoversModel(["()", ""], "gemini-4-neon")).toBe(false);
  });
  it("counts Claude's per-model weekly window only for a Bot on that model, and never extra usage", () => {
    const claude = scope("claude", [{ label: "Claude", windows: [window("five_hour", 12), window("seven_day", 40), window("seven_day_opus", 100), window("seven_day_sonnet", 70), window("overage", 100), window("seven_day_overage_included", 99)] }]);
    expect(quotaView(claude, "sonnet", now)!.windows.map(item => item.label)).toEqual(["five_hour", "seven_day", "seven_day_sonnet"]);
    expect(quotaView(claude, "claude-opus-5-5", now)!.left).toBe(0);
    expect(quotaView(claude, "", now)).toMatchObject({ left: 60, windows: [{ label: "five_hour" }, { label: "seven_day" }] });
  });
  it("excludes Kimi's extra_monthly top-up spend cap from the conversation battery and window list", () => {
    const kimi = scope("kimi", [{ label: "Kimi Code", windows: [
      window("five_hour", 5, { label: "5 hours", periodSeconds: 18_000 }),
      window("seven_day", 20, { label: "7 days", periodSeconds: 604_800 }),
      window("month_total", 10, { label: "Monthly", periodSeconds: 30 * 86_400 }),
      window("month_code", 15, { label: "Coding · 30 days", periodSeconds: 30 * 86_400 }),
      window("extra_monthly", 100, { label: "Top-up monthly limit", periodSeconds: 30 * 86_400 }),
    ] }]);
    const view = quotaView(kimi, "kimi-for-coding", now)!;
    expect(view.left).toBe(80);
    expect(view.windows.map(item => [item.id, item.label])).toEqual([
      ["p0:five_hour", "5 hours"],
      ["p0:seven_day", "7 days"],
      ["p0:month_total", "Monthly"],
      ["p0:month_code", "Coding · 30 days"],
    ]);
  });
  it("counts a Claude model's own weekly pool only for a Bot on that model family", () => {
    const claude = scope("claude", [{ label: "Claude", windows: [window("seven_day", 31)] }, { label: "Fable", models: ["Fable"], windows: [window("seven_day", 64)] }]);
    for (const model of ["claude-fable-5-2", "fable", "Fable[1m]"]) expect(quotaView(claude, model, now)).toMatchObject({ left: 36, windows: [{ pool: "Claude", left: 69 }, { pool: "Fable", left: 36 }] });
    for (const model of ["opus", "claude-sonnet-5-5", ""]) expect(quotaView(claude, model, now)).toMatchObject({ left: 69, windows: [{ pool: "Claude" }] });
    expect(quotaView(scope("antigravity", [{ label: "Fable", models: ["Fable"], windows: [window("weekly", 64)] }]), "claude-fable-5-2", now)).toBeUndefined();
  });
  it("leaves out a window past its reset time and hides the reading once all windows have reset", () => {
    const view = quotaView(scope("codex", [{ label: "Codex", windows: [window("primary", 99, { resetsAt: iso(-1) }), window("secondary", 30), { ...window("other", 0), metric: "unknown" } as QuotaWindow] }]), "", now)!;
    expect(view).toMatchObject({ left: 70, windows: [{ label: "secondary" }] });
    // After a quota window resets, an old reading from before the reset is not shown as current.
    expect(quotaView(scope("codex", [{ label: "Codex", windows: [window("primary", 99, { resetsAt: iso(-1) })] }]), "", now)).toBeUndefined();
  });
  it("keeps showing old readings past 30 minutes (and over an hour) marked as stale until their windows reset", () => {
    const pools = [{ label: "Codex", windows: [window("primary", 20, { resetsAt: iso(600) })] }];
    const fresh = quotaView(scope("codex", pools, { state: "ready", observedAt: iso(-29) }), "", now)!;
    expect(fresh).toMatchObject({ left: 80, stale: false });
    // Gateway's 60-second TTL sets state="stale" after 60s; the conversation battery stays fresh for the full 30 minutes.
    const gatewayTtlStale = quotaView(scope("codex", pools, { state: "stale", observedAt: iso(-2) }), "", now)!;
    expect(gatewayTtlStale).toMatchObject({ left: 80, stale: false });
    // Past 30 minutes and over an hour: stays visible marked stale instead of disappearing!
    const at30m = quotaView(scope("codex", pools, { state: "ready", observedAt: iso(-30) }), "", now)!;
    expect(at30m).toMatchObject({ left: 80, stale: true });
    const at90m = quotaView(scope("codex", pools, { state: "ready", observedAt: iso(-90) }), "", now)!;
    expect(at90m).toMatchObject({ left: 80, stale: true, ageMs: 90 * 60_000 });
    // Saved reading shown from restart cache is immediately marked stale even if < 30 minutes old.
    const cached = quotaView(scope("codex", pools, { state: "ready", observedAt: iso(-5) }), "", now, { fromCache: true })!;
    expect(cached).toMatchObject({ left: 80, stale: true, fromCache: true });
    // Non-ready/non-stale states and missing observedAt remain hidden.
    for (const state of ["unknown", "login_required", "offline", "unavailable", "unsupported"] as const) expect(quotaView(scope("codex", pools, { state }), "", now)).toBeUndefined();
    expect(quotaView(scope("codex", pools, { observedAt: undefined }), "", now)).toBeUndefined();
    expect(quotaView(undefined, "", now)).toBeUndefined();
  });
  it("does not count an Antigravity group that names no models (an older Host), instead of alarming every Bot", () => {
    const old = scope("antigravity", [{ label: "Gemini Models", windows: [window("gemini-weekly", 37)] }, { label: "Gemini 4 Argon", windows: [window("argon-weekly", 100)] }]);
    for (const model of ["gemini-4-neon-high", "gemini-4-argon-medium", ""]) expect(quotaView(old, model, now)).toBeUndefined();
  });
  it("shows nothing left when the engine refuses ordinary use, whatever the windows say", () => {
    const blocked = (code: QuotaScope["constraints"][number]["code"], extra: Partial<QuotaScope["constraints"][number]> = {}) => [{ code, availability: "blocked" as const, ...extra }];
    const codex = (constraints: QuotaScope["constraints"], pool: QuotaScope["constraints"] = []) => scope("codex", [{ label: "Codex", windows: [window("primary", 40)], constraints: pool }], { constraints });
    expect(quotaView(codex(blocked("ordinary_usage_blocked")), "", now)).toMatchObject({ left: 0, blocked: ["ordinary_usage_blocked"], windows: [{ left: 60 }] });
    expect(quotaView(codex([], [...blocked("spend_control"), ...blocked("credits_depleted")]), "", now)).toMatchObject({ left: 0, blocked: ["spend_control", "credits_depleted"] });
    expect(quotaView(codex(blocked("overage_disabled")), "", now)).toMatchObject({ left: 60, blocked: [] });
    expect(quotaView(codex([{ code: "spend_control", availability: "warning" }]), "", now)).toMatchObject({ left: 60, blocked: [] });
    expect(quotaView(codex(blocked("credits_depleted", { resetsAt: iso(-1) })), "", now)).toMatchObject({ left: 60, blocked: [] });
    expect(quotaView(scope("codex", [], { constraints: blocked("ordinary_usage_blocked") }), "", now)).toMatchObject({ left: 0, windows: [], blocked: ["ordinary_usage_blocked"] });
    const other = scope("antigravity", [{ label: "Gemini Models", models: ["Gemini 4 Neon"], windows: [window("weekly", 10)] }, { label: "Gemini 4 Argon", models: ["Gemini 4 Argon"], windows: [], constraints: blocked("other_native_limit") }]);
    expect(quotaView(other, "gemini-4-neon-high", now)).toMatchObject({ left: 90, blocked: [] });
    expect(quotaView(other, "gemini-4-argon-low", now)).toMatchObject({ left: 0, blocked: ["other_native_limit"] });
  });
  it("clamps an overdrawn window to nothing left", () => {
    expect(quotaView(scope("codex", [{ label: "Codex", windows: [window("primary", 140)] }]), "", now)!.left).toBe(0);
  });
  it("transitions fresh to stale at 30 minutes and ends at earliest window reset", () => {
    const soon = quotaView(scope("codex", [{ label: "Codex", windows: [window("primary", 20, { resetsAt: iso(5) })] }]), "", now)!;
    expect(quotaViewEndsAt(soon)).toBe(Date.parse(iso(5)));
    expect(quotaViewNextChangeAt(soon)).toBe(Date.parse(iso(5)));
    const later = quotaView(scope("codex", [{ label: "Codex", windows: [window("primary", 20, { resetsAt: iso(600) })] }]), "", now)!;
    expect(quotaViewEndsAt(later)).toBe(Date.parse(iso(600)));
    expect(quotaViewNextChangeAt(later)).toBe(Date.parse(iso(-1)) + QUOTA_SHOWN_FOR_MS);
    const noReset = quotaView(scope("codex", [{ label: "Codex", windows: [window("primary", 20, { resetsAt: undefined })] }]), "", now)!;
    expect(quotaViewEndsAt(noReset)).toBe(Date.parse(iso(-1)) + QUOTA_MAX_STALE_MS);
  });
});

describe("retry backoff and age formatting (#137)", () => {
  it("uses steady polling when healthy, exponential backoff on failure, and 30m backoff on sign-in required", () => {
    expect(quotaRetryDelayMs(0)).toBe(QUOTA_BACKGROUND_POLL_MS);
    expect(quotaRetryDelayMs(1)).toBe(QUOTA_RETRY_BACKOFF_MS[0]);
    expect(quotaRetryDelayMs(2)).toBe(QUOTA_RETRY_BACKOFF_MS[1]);
    expect(quotaRetryDelayMs(3)).toBe(QUOTA_RETRY_BACKOFF_MS[2]);
    expect(quotaRetryDelayMs(4)).toBe(QUOTA_RETRY_BACKOFF_MS[3]);
    expect(quotaRetryDelayMs(5)).toBe(QUOTA_RETRY_BACKOFF_MS[4]);
    expect(quotaRetryDelayMs(99)).toBe(QUOTA_RETRY_BACKOFF_MS[QUOTA_RETRY_BACKOFF_MS.length - 1]);
    expect(quotaRetryDelayMs(1, true)).toBe(QUOTA_SIGN_IN_RETRY_MS);
  });
  it("formats compact relative ages in Chinese and English", () => {
    expect(quotaReadingAgeLabel(iso(0), now, "zh")).toBe("刚刚");
    expect(quotaReadingAgeLabel(iso(0), now, "en")).toBe("just now");
    expect(quotaReadingAgeLabel(iso(-12), now, "zh")).toBe("12 分钟前");
    expect(quotaReadingAgeLabel(iso(-12), now, "en")).toBe("12 min ago");
    expect(quotaReadingAgeLabel(iso(-125), now, "zh")).toBe("2 小时前");
    expect(quotaReadingAgeLabel(iso(-125), now, "en")).toBe("2 hr ago");
    expect(quotaReadingAgeLabel(iso(-24 * 60), now, "zh")).toBe("1 天前");
    expect(quotaReadingAgeLabel(iso(-24 * 60), now, "en")).toBe("1 day ago");
    expect(quotaReadingAgeLabel(iso(-72 * 60), now, "en")).toBe("3 days ago");
  });
});

it("turns amber at a fifth left and red at a twentieth", () => {
  expect([100, 21, 20, 6, 5, 0].map(usageTone)).toEqual(["ok", "ok", "low", "low", "empty", "empty"]);
});
it("shortens token counts", () => {
  expect([0, 999, 1000, 1240, 9949, 76_000, 199_600, 1_000_000, 1_250_000].map(shortTokens)).toEqual(["0", "999", "1k", "1.2k", "9.9k", "76k", "200k", "1M", "1.3M"]);
});

describe("what the App holds and when it asks the engine", () => {
  const reading = (minutes: number, extra: Partial<QuotaScope> = {}) => scope("codex", [{ label: "Codex", windows: [window("primary", 20)] }], { observedAt: iso(minutes), ...extra });
  const without = (reason: QuotaScope["reason"], extra: Partial<QuotaScope> = {}): QuotaScope => ({ ...scope("codex", [], { observedAt: undefined, state: "unknown" }), reason, ...extra });
  it("keeps the held reading when the Hub answers for a worker that did not", () => {
    const held = reading(-2);
    for (const reason of ["offline", "timeout", "invalid_response", "host_upgrade_required"] as const) expect(nextHeldQuota(held, without(reason, { revision: reason, state: "unavailable" }))).toBe(held);
    expect(nextHeldQuota(held, without("timeout", { state: "unavailable" }))).toBe(held);
    expect(nextHeldQuota(held, without("not_loaded"))).toBe(held);
  });
  it("drops the held reading for another login or a login without quota", () => {
    const held = reading(-2);
    expect(nextHeldQuota(held, without("not_loaded", { revision: "other" }))).toBeUndefined();
    for (const reason of ["auth_changed", "login_required", "mode_not_supported", "not_adapted"] as const) expect(nextHeldQuota(held, without(reason))).toBeUndefined();
    expect(nextHeldQuota(held, without("scope_unverifiable"))).toBeUndefined();
    expect(nextHeldQuota(undefined, without("not_loaded"))).toBeUndefined();
  });
  it("never replaces a reading with the same login's older one", () => {
    const newer = reading(-1), older = reading(-25);
    expect(nextHeldQuota(newer, older)).toBe(newer); expect(nextHeldQuota(older, newer)).toBe(newer); expect(nextHeldQuota(undefined, older)).toBe(older);
    const other = reading(-25, { revision: "other" });
    expect(nextHeldQuota(newer, other)).toBe(other);
  });
  it("asks the engine only when nothing fresh is held and the last attempt is not recent", () => {
    const idle = without("not_loaded"), minute = 60_000, five = 5 * minute;
    expect(mayAskEngine(idle, undefined, undefined, now, five)).toBe(true);
    expect(mayAskEngine(idle, reading(-4), undefined, now, five)).toBe(false);
    expect(mayAskEngine(idle, reading(-6), undefined, now, five)).toBe(true);
    expect(mayAskEngine(idle, reading(-4), undefined, now, minute)).toBe(true);
    expect(mayAskEngine(idle, reading(-1, { revision: "other" }), undefined, now, five)).toBe(true);
    expect(mayAskEngine(idle, undefined, { revision: "r", at: now - 4 * minute, signIn: false }, now, five)).toBe(false);
    expect(mayAskEngine(idle, undefined, { revision: "r", at: now - 6 * minute, signIn: false }, now, five)).toBe(true);
    expect(mayAskEngine(idle, undefined, { revision: "before", at: now - minute, signIn: true }, now, five)).toBe(true);
  });
  it("leaves an engine that asked for a sign-in alone for half an hour, also from the details", () => {
    const idle = without("not_loaded"), attempt = (ago: number) => ({ revision: "r", at: now - ago, signIn: true });
    for (const olderThan of [60_000, 5 * 60_000]) {
      expect(mayAskEngine(idle, undefined, attempt(QUOTA_SIGN_IN_RETRY_MS - 1000), now, olderThan)).toBe(false);
      expect(mayAskEngine(idle, undefined, attempt(QUOTA_SIGN_IN_RETRY_MS + 1000), now, olderThan)).toBe(true);
    }
    expect(mayAskEngine(without("login_required", { state: "login_required" }), undefined, undefined, now, 60_000)).toBe(false);
  });
  it("never asks through a Hub fallback, a passive source or an unsupported one", () => {
    expect(mayAskEngine(without("offline", { revision: "offline", state: "offline" }), undefined, undefined, now, 60_000)).toBe(false);
    expect(mayAskEngine({ ...without("no_passive_event"), capability: { mode: "passive" } }, undefined, undefined, now, 60_000)).toBe(false);
    expect(mayAskEngine({ ...without("mode_not_supported", { state: "unsupported" }), capability: { mode: "unsupported" } }, undefined, undefined, now, 60_000)).toBe(false);
    expect(mayAskEngine({ ...without("mode_not_supported", { state: "unsupported" }), capability: { mode: "active", reason: "mode_not_supported" } }, undefined, undefined, now, 60_000)).toBe(false);
  });
});

describe("readings saved on the device", () => {
  const reading = (id: string, minutes: number, extra: Partial<QuotaScope> = {}, resetsInMinutes = 120) =>
    scope("codex", [{ label: "Codex", windows: [window("primary", 20, { resetsAt: iso(resetsInMinutes) })] }], { id, botIds: [id], observedAt: iso(minutes), ...extra });
  it("round-trips the readings of one Host and keeps other Hosts' readings", () => {
    const first = saveQuota(null, "host-a", new Map([["alpha", reading("alpha", -2)], ["beta", reading("beta", -75)]]), now);
    const both = saveQuota(first, "host-b", new Map([["gamma", reading("gamma", -1)]]), now);
    expect([...loadSavedQuota(both, "host-a", now).keys()]).toEqual(["alpha", "beta"]);
    expect([...loadSavedQuota(both, "host-b", now).keys()]).toEqual(["gamma"]);
    expect(quotaView(loadSavedQuota(both, "host-a", now).get("beta"), "", now, { fromCache: true })).toMatchObject({ left: 80, stale: true, fromCache: true });
    expect([...loadSavedQuota(saveQuota(both, "host-a", new Map([["beta", reading("beta", -3)]]), now), "host-a", now).keys()]).toEqual(["beta"]);
  });
  it("keeps readings past 30 minutes while their windows have not reset, and drops readings whose windows have reset", () => {
    const text = saveQuota(null, "host-a", new Map([
      ["fresh", reading("fresh", -10, {}, 120)],
      ["olderUnreset", reading("olderUnreset", -75, {}, 120)],
      ["alreadyReset", reading("alreadyReset", -5, {}, -1)],
      ["unknown", reading("unknown", -1, { state: "unknown" })],
      ["none", reading("none", -1, { observedAt: undefined })],
    ]), now);
    expect(Object.keys(JSON.parse(text)["host-a"]).sort()).toEqual(["fresh", "olderUnreset"]);
    // Once now moves past the window reset (+121 min), both are dropped!
    expect([...loadSavedQuota(text, "host-a", now + 121 * 60_000).keys()]).toEqual([]);
    expect(JSON.parse(saveQuota(text, "host-b", new Map(), now + 121 * 60_000))).toEqual({});
  });
  it("ignores anything it cannot read back as a reading of that Bot", () => {
    for (const raw of [null, "", "{not json", "[]", "7", JSON.stringify({ "host-a": 7 }), JSON.stringify({ "host-a": { alpha: { id: "alpha" } } }), JSON.stringify({ "host-a": { alpha: reading("beta", -1) } }), JSON.stringify({ "host-a": { alpha: { ...reading("alpha", -1), extra: true } } })])
      expect(loadSavedQuota(raw, "host-a", now).size).toBe(0);
    expect(saveQuota("{not json", "host-a", new Map([["alpha", reading("alpha", -1)]]), now)).toContain("alpha");
  });
  it("forgets one Host's saved readings and keeps the others", () => {
    const text = saveQuota(saveQuota(null, "host-a", new Map([["alpha", reading("alpha", -1)]]), now), "host-b", new Map([["alpha", reading("alpha", -1)]]), now);
    const left = forgetSavedQuota(text, "host-a");
    expect(loadSavedQuota(left, "host-a", now).size).toBe(0); expect(loadSavedQuota(left, "host-b", now).size).toBe(1);
    expect(forgetSavedQuota("{not json", "host-a")).toBe("{}");
  });
  it("holds no account identity, only the reading", () => {
    const text = saveQuota(null, "host-a", new Map([["alpha", reading("alpha", -1)]]), now);
    expect(Object.keys(JSON.parse(text)["host-a"].alpha).sort()).toEqual(["authMode", "availability", "botIds", "capability", "constraints", "engine", "id", "label", "observedAt", "pools", "revision", "sharing", "state"]);
  });
  it("reconciles saved readings once the worker answers", () => {
    const earlier = reading("alpha", -3), plain = (extra: Partial<QuotaScope>): QuotaScope => ({ ...scope("codex", [], { id: "alpha", observedAt: undefined, state: "unknown" }), reason: "not_loaded", ...extra });
    expect(savedQuotaAfter(earlier, plain({}))).toBe("adopt");
    expect(savedQuotaAfter(earlier, reading("alpha", 0))).toBe("adopt");
    expect(savedQuotaAfter(earlier, plain({ revision: "other" }))).toBe("drop");
    expect(savedQuotaAfter(earlier, reading("alpha", 0, { revision: "other" }))).toBe("drop");
    expect(nextHeldQuota(earlier, plain({ reason: "scope_unverifiable" }))).toBeUndefined();
    for (const reason of ["offline", "timeout", "invalid_response", "host_upgrade_required"] as const) expect(savedQuotaAfter(earlier, plain({ reason, revision: reason, state: "unavailable" }))).toBe("wait");
    expect(nextHeldQuota(earlier, plain({}))).toBe(earlier);
    const newer = reading("alpha", 0); expect(nextHeldQuota(earlier, newer)).toBe(newer);
  });
});

describe("accurate reset time countdown", () => {
  it("computes remaining duration from reset timestamp rather than window length", () => {
    const base = Date.parse("2026-11-24T08:00:00Z");
    const in3d17h = new Date(base + (3 * 24 + 17) * 3_600_000).toISOString();
    expect(formatTimeRemaining(in3d17h, base, "en")).toBe("3d 17h");
    expect(formatTimeRemaining(in3d17h, base, "zh")).toBe("3 天 17 小时");

    const in4d = new Date(base + 4 * 24 * 3_600_000).toISOString();
    expect(formatTimeRemaining(in4d, base, "en")).toBe("4d");
    expect(formatTimeRemaining(in4d, base, "zh")).toBe("4 天");

    const in2h15m = new Date(base + (2 * 60 + 15) * 60_000).toISOString();
    expect(formatTimeRemaining(in2h15m, base, "en")).toBe("2h 15m");
    expect(formatTimeRemaining(in2h15m, base, "zh")).toBe("2 小时 15 分钟");

    const in3h = new Date(base + 3 * 3_600_000).toISOString();
    expect(formatTimeRemaining(in3h, base, "en")).toBe("3h");
    expect(formatTimeRemaining(in3h, base, "zh")).toBe("3 小时");

    const in12m = new Date(base + 12 * 60_000).toISOString();
    expect(formatTimeRemaining(in12m, base, "en")).toBe("12m");
    expect(formatTimeRemaining(in12m, base, "zh")).toBe("12 分钟");

    const in15s = new Date(base + 15_000).toISOString();
    expect(formatTimeRemaining(in15s, base, "en")).toBe("1m");
    expect(formatTimeRemaining(in15s, base, "zh")).toBe("1 分钟");

    expect(formatTimeRemaining(new Date(base).toISOString(), base, "en")).toBeNull();
    expect(formatTimeRemaining(new Date(base - 1000).toISOString(), base, "en")).toBeNull();
    expect(formatTimeRemaining(undefined, base, "en")).toBeNull();
    expect(formatTimeRemaining("not-a-timestamp", base, "zh")).toBeNull();
  });
});

describe("shared quota store across restart, conversation battery and Settings page (#137)", () => {
  const mem = new Map<string, string>();
  const fakeConnection = (hostKey: string) => ({ identity: { hubPublicKey: hostKey } }) as unknown as HubConnection;
  const reading = (id: string, minutes: number, usedPercent = 25, resetsInMinutes = 180) =>
    scope("codex", [{ label: "Codex", windows: [window("primary", usedPercent, { resetsAt: iso(resetsInMinutes) })] }], { id, botIds: [id], observedAt: iso(minutes) });

  beforeEach(() => {
    mem.clear();
    resetQuotaStoreForTests();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => mem.get(key) ?? null,
      setItem: (key: string, value: string) => { mem.set(key, value); },
      removeItem: (key: string) => { mem.delete(key); },
    });
  });

  it("immediately shows the saved reading marked old after an App restart, and updates both views on refresh", () => {
    const conn1 = fakeConnection("host-restart-1");
    applyHostQuotaScope(conn1, "bot_a", reading("bot_a", -45, 35, 300), now);
    expect(mem.get(SAVED_QUOTA_KEY)).toContain("bot_a");

    // Simulate App restart: clear in-memory store, create fresh HubConnection with same hubPublicKey
    resetQuotaStoreForTests();
    const conn2 = fakeConnection("host-restart-1");

    // Conversation battery sees saved reading immediately (fromCache: true -> stale: true)
    const immediate = readStoredQuota(conn2, "bot_a", now)!;
    expect(immediate.fromCache).toBe(true);
    const view = quotaView(immediate.scope, "gpt-6.1", now, { fromCache: immediate.fromCache })!;
    expect(view).toMatchObject({ left: 65, stale: true, fromCache: true });

    // Settings → Model quotas also sees the exact same saved reading immediately
    const cachedDir = cachedQuotaDirectory(conn2, now)!;
    expect(cachedDir.scopes).toHaveLength(1);
    expect(cachedDir.scopes[0]).toMatchObject({ id: "bot_a", state: "stale" });

    // If Host returns unknown/not_loaded with same revision, ingestQuotaDirectory preserves the cached reading marked stale
    // and keeps fromCache: true until an actual live reading arrives.
    const emptyLive = {
      generatedAt: iso(0),
      scopes: [{ ...scope("codex", [], { id: "bot_a", botIds: ["bot_a"], observedAt: undefined, state: "unknown" }), reason: "not_loaded" as const }],
      truncated: false,
    };
    const synced = ingestQuotaDirectory(conn2, emptyLive, now);
    expect(synced.directory.scopes[0]).toMatchObject({ id: "bot_a", state: "stale", observedAt: iso(-45) });
    expect(synced.directory.scopes[0]?.reason).toBeUndefined();
    expect(synced.cachedScopeIds.has("bot_a")).toBe(true);
    expect(readStoredQuota(conn2, "bot_a", now)?.fromCache).toBe(true);

    // When a fresh reading arrives (from Settings refresh or background retry), listeners are notified and both views show fresh data
    const listener = vi.fn();
    const unsub = subscribeQuotaStore(conn2, listener);
    applyHostQuotaScope(conn2, "bot_a", reading("bot_a", -1, 15, 300), now);
    expect(listener).toHaveBeenCalledTimes(1);
    const fresh = readStoredQuota(conn2, "bot_a", now)!;
    expect(fresh.fromCache).toBe(false);
    expect(quotaView(fresh.scope, "gpt-6.1", now, { fromCache: fresh.fromCache })).toMatchObject({ left: 85, stale: false });
    unsub();
  });

  it("batches ingestQuotaDirectory once and makes projectQuotaDirectory side-effect-free inside subscribers (no recursion)", () => {
    const conn = fakeConnection("host-batch-1");
    const setItem = vi.fn((key: string, value: string) => { mem.set(key, value); });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => mem.get(key) ?? null,
      setItem,
      removeItem: (key: string) => { mem.delete(key); },
    });

    const dir = {
      generatedAt: iso(0),
      scopes: [reading("bot_1", -2, 20, 300), reading("bot_2", -2, 40, 300), reading("bot_3", -2, 60, 300)],
      truncated: false,
    };
    let listenerRuns = 0;
    const unsub = subscribeQuotaStore(conn, () => {
      listenerRuns++;
      // Calling projectQuotaDirectory inside a subscriber must never mutate storage or re-notify.
      projectQuotaDirectory(conn, dir, now);
    });

    ingestQuotaDirectory(conn, dir, now);
    expect(listenerRuns).toBe(1);
    expect(setItem).toHaveBeenCalledTimes(1);

    setItem.mockClear();
    const projected = projectQuotaDirectory(conn, dir, now);
    expect(projected.directory.scopes).toHaveLength(3);
    expect(listenerRuns).toBe(1);
    expect(setItem).not.toHaveBeenCalled();
    unsub();
  });

  it("propagates newer readings, preserves live state on not_loaded, never overwrites offline, and never resurrects auth_changed", () => {
    const conn = fakeConnection("host-project-1");
    const older = reading("bot_a", -10, 50, 300);
    const newer = reading("bot_a", -1, 20, 300);

    // 1. Directory holds older reading, background conversation updates store with strictly newer same-revision reading
    const dirWithOlder = { generatedAt: iso(-10), scopes: [older], truncated: false };
    ingestQuotaDirectory(conn, dirWithOlder, now);
    applyHostQuotaScope(conn, "bot_a", newer, now);
    const updated = projectQuotaDirectory(conn, dirWithOlder, now);
    expect(updated.directory.scopes[0]).toMatchObject({ id: "bot_a", state: "ready", observedAt: iso(-1) });
    expect(updated.directory.scopes[0]?.pools[0]?.windows[0]).toMatchObject({ usedPercent: 20 });
    expect(updated.cachedScopeIds.size).toBe(0);

    // 2. Directory holds not_loaded while store holds a live fresh reading -> keeps state="ready" and clears reason="not_loaded"
    const dirNotLoaded = {
      generatedAt: iso(0),
      scopes: [{ ...scope("codex", [], { id: "bot_a", botIds: ["bot_a"], observedAt: undefined, state: "unknown" }), reason: "not_loaded" as const }],
      truncated: false,
    };
    const withLive = projectQuotaDirectory(conn, dirNotLoaded, now);
    expect(withLive.directory.scopes[0]).toMatchObject({ id: "bot_a", state: "ready", observedAt: iso(-1) });
    expect(withLive.directory.scopes[0]?.reason).toBeUndefined();
    expect(withLive.cachedScopeIds.has("bot_a")).toBe(false);

    // 3. Hub offline fallback keeps state="offline" and reason="offline" (never turns into state="stale" enabling Refresh)
    const dirOffline = {
      generatedAt: iso(0),
      scopes: [{ ...scope("codex", [], { id: "bot_a", botIds: ["bot_a"], revision: "offline", observedAt: undefined, state: "offline" }), reason: "offline" as const }],
      truncated: false,
    };
    const withOffline = projectQuotaDirectory(conn, dirOffline, now);
    expect(withOffline.directory.scopes[0]).toMatchObject({ id: "bot_a", state: "offline", reason: "offline", revision: "offline", observedAt: iso(-1) });
    expect(withOffline.cachedScopeIds.has("bot_a")).toBe(true);

    // 4. auth_changed clears held + saved + storage and projecting an older directory inside subscribe never resurrects it
    const staleDir = { generatedAt: iso(-1), scopes: [newer], truncated: false };
    const unsub = subscribeQuotaStore(conn, () => { projectQuotaDirectory(conn, staleDir, now); });
    const authChanged = { ...scope("codex", [], { id: "bot_a", botIds: ["bot_a"], revision: "r_new", observedAt: undefined, state: "unknown" }), reason: "auth_changed" as const };
    applyHostQuotaScope(conn, "bot_a", authChanged, now);
    unsub();
    expect(readStoredQuota(conn, "bot_a", now)).toBeUndefined();
    expect(mem.get(SAVED_QUOTA_KEY) ?? "{}").not.toContain("bot_a");
    // Settings still owns staleDir: projection must also retire its old login's reading.
    const retired = projectQuotaDirectory(conn, staleDir, now);
    expect(retired.directory.scopes[0]).toMatchObject({ revision: "r_new", reason: "auth_changed", observedAt: undefined, pools: [] });
    expect(retired.cachedScopeIds.size).toBe(0);
    const afterAuth = projectQuotaDirectory(conn, { generatedAt: iso(0), scopes: [authChanged], truncated: false }, now);
    expect(afterAuth.directory.scopes[0]).toMatchObject({ id: "bot_a", state: "unknown", reason: "auth_changed", observedAt: undefined });
  });

  it("projects a conversation's new login reading without letting a Hub no-answer retire it", () => {
    const conn = fakeConnection("host-login-project");
    const old = reading("bot_a", -10, 50);
    const directory = { generatedAt: iso(-10), scopes: [old], truncated: false };
    ingestQuotaDirectory(conn, directory, now);
    const current = { ...reading("bot_a", -1, 20), revision: "new_login" };
    applyHostQuotaScope(conn, "bot_a", current, now);
    for (const reason of ["offline", "timeout", "invalid_response", "host_upgrade_required"] as const) {
      const fallback = { ...current, revision: reason, reason, state: "unavailable" as const, observedAt: undefined, pools: [] };
      applyHostQuotaScope(conn, "bot_a", fallback, now);
      const projected = projectQuotaDirectory(conn, directory, now);
      expect(projected.directory.scopes[0]).toEqual(current);
      expect(projected.cachedScopeIds.size).toBe(0);
      // The fallback's own availability/Refresh boundary is still respected.
      expect(projectQuotaDirectory(conn, { ...directory, scopes: [fallback] }, now).directory.scopes[0])
        .toMatchObject({ revision: reason, reason });
    }
    clearStoredQuotaHost(conn);
    // Revocation discards in-memory worker answers as well as readings.
    expect(projectQuotaDirectory(conn, directory, now).directory.scopes[0]).toEqual(old);
  });

  it("keeps fromCache=true after adopting a persisted reading on not_loaded even if refresh fails", () => {
    const conn1 = fakeConnection("host-cache-prov");
    applyHostQuotaScope(conn1, "bot_a", reading("bot_a", -10, 30, 300), now);

    // Restart App: only saved reading exists (10m old, < 30m fresh threshold).
    resetQuotaStoreForTests();
    const conn2 = fakeConnection("host-cache-prov");
    expect(readStoredQuota(conn2, "bot_a", now)?.fromCache).toBe(true);

    // Host replies not_loaded (same revision) -> adopts saved reading while preserving fromCache: true
    const notLoaded = { ...scope("codex", [], { id: "bot_a", botIds: ["bot_a"], observedAt: undefined, state: "unknown" }), reason: "not_loaded" as const };
    const adopted = applyHostQuotaScope(conn2, "bot_a", notLoaded, now)!;
    expect(adopted.fromCache).toBe(true);
    expect(quotaView(adopted.scope, "gpt-6.1", now, { fromCache: adopted.fromCache })).toMatchObject({ left: 70, stale: true, fromCache: true });

    // Subsequent refresh fails with timeout -> still fromCache: true (never un-greys pre-restart reading)
    const timedOut = { ...scope("codex", [], { id: "bot_a", botIds: ["bot_a"], observedAt: undefined, state: "unavailable" }), reason: "timeout" as const };
    const afterFail = applyHostQuotaScope(conn2, "bot_a", timedOut, now)!;
    expect(afterFail.fromCache).toBe(true);
    expect(quotaView(afterFail.scope, "gpt-6.1", now, { fromCache: afterFail.fromCache })).toMatchObject({ left: 70, stale: true, fromCache: true });

    // Once a live reading arrives, fromCache flips to false and battery becomes fresh
    const live = applyHostQuotaScope(conn2, "bot_a", reading("bot_a", 0, 25, 300), now)!;
    expect(live.fromCache).toBe(false);
    expect(quotaView(live.scope, "gpt-6.1", now, { fromCache: live.fromCache })).toMatchObject({ left: 75, stale: false });
  });

  it("evicts all in-memory and localStorage quota readings for a host on clearStoredQuotaHost", () => {
    const connA = fakeConnection("host-revoke-a");
    const connB = fakeConnection("host-keep-b");
    applyHostQuotaScope(connA, "bot_a", reading("bot_a", -2, 30, 300), now);
    applyHostQuotaScope(connB, "bot_b", reading("bot_b", -2, 40, 300), now);

    const listenerA = vi.fn();
    const unsub = subscribeQuotaStore(connA, listenerA);
    clearStoredQuotaHost(connA);
    unsub();

    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(readStoredQuota(connA, "bot_a", now)).toBeUndefined();
    expect(cachedQuotaDirectory(connA, now)).toBeUndefined();
    expect(readStoredQuota(connB, "bot_b", now)).toBeDefined();
    const raw = JSON.parse(mem.get(SAVED_QUOTA_KEY) ?? "{}") as Record<string, unknown>;
    expect(raw["host-revoke-a"]).toBeUndefined();
    expect(raw["host-keep-b"]).toBeDefined();
  });
});
