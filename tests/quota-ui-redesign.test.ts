import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QuotaScope } from "../src/client-protocol/engine-quota.js";
import { setLocale } from "../client/src/i18n.js";
import {
  formatQuotaWindowLabel,
  formatResetCountdown,
  groupQuotaScopesByAccount,
  shouldShowQuotaPoolHeading,
} from "../client/src/quota-ui.js";

const originalDocument = globalThis.document;
beforeAll(() => {
  if (!globalThis.document) {
    (globalThis as Record<string, unknown>).document = { documentElement: { lang: "" } };
  }
});
afterAll(() => {
  if (!originalDocument) {
    delete (globalThis as Record<string, unknown>).document;
  }
});

function makeScope(overrides: Partial<QuotaScope> & { id: string; label: string; engine: QuotaScope["engine"] }): QuotaScope {
  const now = "2026-11-24T04:00:00.000Z";
  return {
    id: overrides.id,
    revision: overrides.revision ?? `rev_${overrides.id}`,
    engine: overrides.engine,
    label: overrides.label,
    botIds: overrides.botIds ?? [overrides.id],
    sharing: overrides.sharing ?? "unverified",
    authMode: overrides.authMode ?? "subscription",
    capability: overrides.capability ?? { mode: "active" },
    state: overrides.state ?? "ready",
    availability: overrides.availability ?? "allowed",
    ...("observedAt" in overrides ? (overrides.observedAt !== undefined ? { observedAt: overrides.observedAt } : {}) : { observedAt: now }),
    ...(overrides.lastAttemptAt ? { lastAttemptAt: overrides.lastAttemptAt } : {}),
    ...(overrides.nextRefreshAt ? { nextRefreshAt: overrides.nextRefreshAt } : {}),
    pools: overrides.pools ?? [],
    constraints: overrides.constraints ?? [],
    ...(overrides.reason ? { reason: overrides.reason } : {}),
    ...(overrides.help ? { help: overrides.help } : {}),
  };
}

describe("Model quota UI redesign (#77)", () => {
  it("maps raw engine window names uniformly, prioritizes explicit periodSeconds, and keeps unknown names", () => {
    setLocale("en");
    expect(formatQuotaWindowLabel({ label: "Primary", periodSeconds: 18_000 })).toBe("5-hour window");
    expect(formatQuotaWindowLabel({ label: "Secondary", periodSeconds: 604_800 })).toBe("Weekly (7 days)");
    expect(formatQuotaWindowLabel({ label: "5 hours", periodSeconds: 18_000 })).toBe("5-hour window");
    expect(formatQuotaWindowLabel({ label: "7 days", periodSeconds: 604_800 })).toBe("Weekly (7 days)");
    expect(formatQuotaWindowLabel({ label: "Opus · 7 days", periodSeconds: 604_800 })).toBe("Opus · Weekly (7 days)");
    expect(formatQuotaWindowLabel({ label: "Gemini Models" })).toBe("Gemini Models");
    // Explicit periodSeconds always overrides Primary/Secondary/Session regexes
    expect(formatQuotaWindowLabel({ label: "Primary", periodSeconds: 604_800 })).toBe("Weekly (7 days)");
    expect(formatQuotaWindowLabel({ label: "Primary", periodSeconds: 86_400 })).toBe("24-hour window");
    expect(formatQuotaWindowLabel({ label: "Primary", periodSeconds: 1_800 })).toBe("30-minute window");
    expect(formatQuotaWindowLabel({ label: "Secondary", periodSeconds: 2_592_000 })).toBe("30-day window");
    expect(formatQuotaWindowLabel({ label: "Primary", periodSeconds: 45 })).toBe("Primary");
    // Fallback regexes apply only when periodSeconds is omitted
    expect(formatQuotaWindowLabel({ label: "Primary" })).toBe("5-hour window");
    expect(formatQuotaWindowLabel({ label: "Session" })).toBe("5-hour window");
    expect(formatQuotaWindowLabel({ label: "Weekly" })).toBe("Weekly (7 days)");

    setLocale("zh");
    expect(formatQuotaWindowLabel({ label: "Primary", periodSeconds: 18_000 })).toBe("5 小时窗口");
    expect(formatQuotaWindowLabel({ label: "Secondary", periodSeconds: 604_800 })).toBe("周额度（7 天）");
    expect(formatQuotaWindowLabel({ label: "Opus · 7 days", periodSeconds: 604_800 })).toBe("Opus · 周额度（7 天）");
    expect(formatQuotaWindowLabel({ label: "Primary", periodSeconds: 86_400 })).toBe("24 小时窗口");
    expect(formatQuotaWindowLabel({ label: "Primary", periodSeconds: 1_800 })).toBe("30 分钟窗口");
    expect(formatQuotaWindowLabel({ label: "Secondary", periodSeconds: 2_592_000 })).toBe("30 天窗口");
    expect(formatQuotaWindowLabel({ label: "Gemini Models" })).toBe("Gemini Models");
  });

  it("keeps a scoped window's scope, and the engine's own names for two unscoped windows of one length (Kimi, #76)", () => {
    const kimi = [
      { id: "five_hour", label: "5 hours", periodSeconds: 18_000 },
      { id: "seven_day", label: "7 days", periodSeconds: 604_800 },
      { id: "month_total", label: "Monthly", periodSeconds: 30 * 86_400 },
      { id: "month_code", label: "Coding · 30 days", periodSeconds: 30 * 86_400 },
    ];
    setLocale("zh");
    expect(kimi.map(window => formatQuotaWindowLabel(window, kimi))).toEqual(["5 小时窗口", "周额度（7 天）", "30 天窗口", "编程 · 30 天窗口"]);
    setLocale("en");
    expect(kimi.map(window => formatQuotaWindowLabel(window, kimi))).toEqual(["5-hour window", "Weekly (7 days)", "30-day window", "Coding · 30-day window"]);
    // Settings also shows the top-up spending limit, a second unscoped 30-day window: neither is called "30-day window".
    const withLimit = [...kimi, { id: "extra_monthly", label: "Top-up monthly limit", periodSeconds: 30 * 86_400 }];
    expect(withLimit.map(window => formatQuotaWindowLabel(window, withLimit))).toEqual(["5-hour window", "Weekly (7 days)", "Monthly", "Coding · 30-day window", "Top-up monthly limit"]);
    // Nothing is compared without the windows shown beside it, and a per-model scope is not a duplicate.
    expect(formatQuotaWindowLabel(withLimit[4]!)).toBe("30-day window");
    const claude = [{ id: "seven_day", label: "7 days", periodSeconds: 604_800 }, { id: "seven_day_opus", label: "Opus · 7 days", periodSeconds: 604_800 }];
    expect(claude.map(window => formatQuotaWindowLabel(window, claude))).toEqual(["Weekly (7 days)", "Opus · Weekly (7 days)"]);
  });

  it("formats reset countdowns accurately for days, days+hours, hours+minutes, minutes, and passed reset times", () => {
    const now = Date.parse("2026-11-24T04:00:00.000Z");

    setLocale("en");
    expect(formatResetCountdown(new Date(now + 4 * 86_400_000).toISOString(), now)).toEqual({
      text: "Resets in 4 days",
      expired: false,
    });
    expect(formatResetCountdown(new Date(now + 3 * 86_400_000 + 20 * 3_600_000).toISOString(), now)).toEqual({
      text: "Resets in 3 d 20 h",
      expired: false,
    });
    expect(formatResetCountdown(new Date(now + 47 * 3_600_000 + 59 * 60_000).toISOString(), now)).toEqual({
      text: "Resets in 2 days",
      expired: false,
    });
    expect(formatResetCountdown(new Date(now + 86_400_000).toISOString(), now)).toEqual({
      text: "Resets in 1 day",
      expired: false,
    });
    expect(formatResetCountdown(new Date(now + 3 * 3_600_000 + 20 * 60_000).toISOString(), now)).toEqual({
      text: "Resets in 3 h 20 min",
      expired: false,
    });
    expect(formatResetCountdown(new Date(now + 25 * 60_000).toISOString(), now)).toEqual({
      text: "Resets in 25 min",
      expired: false,
    });
    expect(formatResetCountdown(new Date(now - 5_000).toISOString(), now)).toEqual({
      text: "Reset time reached; awaiting an update",
      expired: true,
    });

    setLocale("zh");
    expect(formatResetCountdown(new Date(now + 4 * 86_400_000).toISOString(), now)).toEqual({
      text: "4 天后重置",
      expired: false,
    });
    expect(formatResetCountdown(new Date(now + 3 * 86_400_000 + 20 * 3_600_000).toISOString(), now)).toEqual({
      text: "3 天 20 小时后重置",
      expired: false,
    });
    expect(formatResetCountdown(new Date(now + 47 * 3_600_000 + 59 * 60_000).toISOString(), now)).toEqual({
      text: "2 天后重置",
      expired: false,
    });
    expect(formatResetCountdown(new Date(now + 3 * 3_600_000 + 20 * 60_000).toISOString(), now)).toEqual({
      text: "3 小时 20 分钟后重置",
      expired: false,
    });
    expect(formatResetCountdown(new Date(now + 25 * 60_000).toISOString(), now)).toEqual({
      text: "25 分钟后重置",
      expired: false,
    });
    expect(formatResetCountdown(new Date(now - 5_000).toISOString(), now)).toEqual({
      text: "已到重置时间，等待更新",
      expired: true,
    });
  });

  it("merges Bots confirmed on the same account independently of per-Bot revision and keeps unconfirmed ones separate", () => {
    const codexA = makeScope({
      id: "codex_a",
      label: "Codex Lead",
      engine: "codex",
      sharing: "verified",
      botIds: ["codex_a", "codex_b"],
      revision: "rev_codex_a_unique",
      observedAt: "2026-11-24T04:01:00.000Z",
    });
    const codexB = makeScope({
      id: "codex_b",
      label: "Code Reviewer",
      engine: "codex",
      sharing: "verified",
      botIds: ["codex_a", "codex_b"],
      revision: "rev_codex_b_unique",
      observedAt: "2026-11-24T04:02:00.000Z",
    });
    const codexOther = makeScope({
      id: "codex_other",
      label: "Codex Separate Account",
      engine: "codex",
      sharing: "verified",
      botIds: ["codex_other"],
      revision: "rev_codex_a_unique",
      observedAt: "2026-11-24T04:02:00.000Z",
    });
    const claudeA = makeScope({
      id: "claude_a",
      label: "Claude Alpha",
      engine: "claude",
      sharing: "unverified",
      revision: "rev_claude_a",
    });
    const claudeB = makeScope({
      id: "claude_b",
      label: "Claude Beta",
      engine: "claude",
      sharing: "unverified",
      revision: "rev_claude_b",
    });
    const agySolo = makeScope({
      id: "agy_solo",
      label: "AGY Solo",
      engine: "antigravity",
      sharing: "unverified",
    });

    const now = Date.parse("2026-11-24T04:02:10.000Z");
    const cards = groupQuotaScopesByAccount([codexA, codexB, codexOther, claudeA, claudeB, agySolo], { now });
    expect(cards).toHaveLength(5);

    // Merged Codex card lists both Bots and selects the fresher reading as primary even with distinct revisions
    expect(cards[0]!.merged).toBe(true);
    expect(cards[0]!.unconfirmedPeer).toBe(false);
    expect(cards[0]!.bots.map((b) => b.label)).toEqual(["Codex Lead", "Code Reviewer"]);
    expect(cards[0]!.primary.id).toBe("codex_b");

    // Distinct verified Codex account stays separate without an unconfirmed-peer warning
    expect(cards[1]!.merged).toBe(false);
    expect(cards[1]!.unconfirmedPeer).toBe(false);
    expect(cards[1]!.bots.map((b) => b.label)).toEqual(["Codex Separate Account"]);

    // Two unverified Claude Bots stay separate and flag unconfirmedPeer so the UI explains why
    expect(cards[2]!.merged).toBe(false);
    expect(cards[2]!.unconfirmedPeer).toBe(true);
    expect(cards[2]!.bots.map((b) => b.label)).toEqual(["Claude Alpha"]);
    expect(cards[3]!.merged).toBe(false);
    expect(cards[3]!.unconfirmedPeer).toBe(true);
    expect(cards[3]!.bots.map((b) => b.label)).toEqual(["Claude Beta"]);

    // Solo Antigravity Bot has no peer to merge with
    expect(cards[4]!.merged).toBe(false);
    expect(cards[4]!.unconfirmedPeer).toBe(false);
  });

  it("never lets an older peer shadow a fresher timeout, login_required, or non-expired reading on a merged card", () => {
    const now = Date.parse("2026-11-24T04:03:05.000Z");
    const botA = makeScope({
      id: "bot_a",
      label: "Bot A",
      engine: "codex",
      sharing: "verified",
      botIds: ["bot_a", "bot_b"],
      state: "ready",
      observedAt: "2026-11-24T04:01:00.000Z",
    });

    // Timeout on bot_b with fresher attempt/observation keeps bot_b primary (preserves error + cooldown)
    const botBTimeout = makeScope({
      id: "bot_b",
      label: "Bot B",
      engine: "codex",
      sharing: "verified",
      botIds: ["bot_a", "bot_b"],
      state: "stale",
      reason: "timeout",
      observedAt: "2026-11-24T04:02:00.000Z",
      lastAttemptAt: "2026-11-24T04:03:00.000Z",
      nextRefreshAt: "2026-11-24T04:04:00.000Z",
    });
    const timeoutCards = groupQuotaScopesByAccount([botA, botBTimeout], { now });
    expect(timeoutCards).toHaveLength(1);
    expect(timeoutCards[0]!.primary.id).toBe("bot_b");
    expect(timeoutCards[0]!.primary.reason).toBe("timeout");
    expect(timeoutCards[0]!.primary.nextRefreshAt).toBe("2026-11-24T04:04:00.000Z");

    // login_required without observedAt (or even without lastAttemptAt) must not be shadowed by older ready peer
    const botBLogin = makeScope({
      id: "bot_b",
      label: "Bot B",
      engine: "codex",
      sharing: "verified",
      botIds: ["bot_a", "bot_b"],
      state: "login_required",
      reason: "login_required",
      observedAt: undefined,
    });
    const loginCards = groupQuotaScopesByAccount([botA, botBLogin], { now });
    expect(loginCards).toHaveLength(1);
    expect(loginCards[0]!.primary.id).toBe("bot_b");
    expect(loginCards[0]!.primary.state).toBe("login_required");

    // Uninitialized not_loaded peer with a newer attempt timestamp does not override a ready reading
    const botBNotLoaded = makeScope({
      id: "bot_b",
      label: "Bot B",
      engine: "codex",
      sharing: "verified",
      botIds: ["bot_a", "bot_b"],
      state: "unknown",
      reason: "not_loaded",
      observedAt: undefined,
      lastAttemptAt: "2026-11-24T04:03:00.000Z",
    });
    const notLoadedCards = groupQuotaScopesByAccount([botA, botBNotLoaded], { now });
    expect(notLoadedCards[0]!.primary.id).toBe("bot_a");

    // At equal timestamps, a non-expired reading beats a locally expired one
    const expiredA = makeScope({
      id: "bot_a",
      label: "Bot A",
      engine: "codex",
      sharing: "verified",
      botIds: ["bot_a", "bot_b"],
      state: "ready",
      observedAt: "2026-11-24T04:02:30.000Z",
      pools: [{
        id: "p",
        label: "Codex",
        sharing: "shared",
        availability: "allowed",
        windows: [{ id: "w", label: "5 hours", metric: "percent", usedPercent: 20, availability: "allowed", observedAt: "2026-11-24T04:02:30.000Z", expiresAt: "2026-11-24T04:03:00.000Z" }],
        balances: [],
        constraints: [],
      }],
    });
    const freshB = makeScope({
      id: "bot_b",
      label: "Bot B",
      engine: "codex",
      sharing: "verified",
      botIds: ["bot_a", "bot_b"],
      state: "ready",
      observedAt: "2026-11-24T04:02:30.000Z",
      pools: [{
        id: "p",
        label: "Codex",
        sharing: "shared",
        availability: "allowed",
        windows: [{ id: "w", label: "5 hours", metric: "percent", usedPercent: 25, availability: "allowed", observedAt: "2026-11-24T04:02:30.000Z", expiresAt: "2026-11-24T04:03:30.000Z" }],
        balances: [],
        constraints: [],
      }],
    });
    const expiryCards = groupQuotaScopesByAccount([expiredA, freshB], { now });
    expect(expiryCards[0]!.primary.id).toBe("bot_b");
  });

  it("resolves all member botIds cleanly for a single pre-merged verified scope", () => {
    const botLabels = new Map([["bot_a", "Coding Bot"], ["bot_b", "Review Bot"]]);
    const preMerged = makeScope({
      id: "acct_1",
      label: "Codex Shared",
      engine: "codex",
      sharing: "verified",
      botIds: ["bot_a", "bot_b"],
    });
    const cards = groupQuotaScopesByAccount([preMerged], { botLabels });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.merged).toBe(true);
    expect(cards[0]!.bots.map((b) => ({ id: b.id, label: b.label }))).toEqual([
      { id: "bot_a", label: "Coding Bot" },
      { id: "bot_b", label: "Review Bot" },
    ]);
  });

  it("does not show unconfirmedPeer for unsupported engines or incompatible auth modes", () => {
    const kimiA = makeScope({
      id: "kimi_a",
      label: "Kimi A",
      engine: "kimi",
      capability: { mode: "unsupported", reason: "not_adapted" },
      state: "unsupported",
      reason: "not_adapted",
      authMode: "unknown",
    });
    const kimiB = makeScope({
      id: "kimi_b",
      label: "Kimi B",
      engine: "kimi",
      capability: { mode: "unsupported", reason: "not_adapted" },
      state: "unsupported",
      reason: "not_adapted",
      authMode: "unknown",
    });
    const codexSub = makeScope({
      id: "codex_sub",
      label: "Codex Sub",
      engine: "codex",
      authMode: "subscription",
      state: "ready",
    });
    const codexApiKey = makeScope({
      id: "codex_key",
      label: "Codex API Key",
      engine: "codex",
      authMode: "api_key",
      capability: { mode: "unsupported", reason: "mode_not_supported" },
      state: "unsupported",
      reason: "mode_not_supported",
    });

    const cards = groupQuotaScopesByAccount([kimiA, kimiB, codexSub, codexApiKey]);
    expect(cards.every((c) => c.unconfirmedPeer === false)).toBe(true);
  });

  it("keeps distinct single-pool headings such as Claude Fable while hiding redundant engine-name headings", () => {
    expect(shouldShowQuotaPoolHeading("codex", "Codex", 1)).toBe(false);
    expect(shouldShowQuotaPoolHeading("claude", "Claude", 1)).toBe(false);
    expect(shouldShowQuotaPoolHeading("claude", "Claude Code", 1)).toBe(false);
    expect(shouldShowQuotaPoolHeading("claude", "Fable", 1)).toBe(true);
    expect(shouldShowQuotaPoolHeading("antigravity", "Gemini 4 Argon", 1)).toBe(true);
    expect(shouldShowQuotaPoolHeading("codex", "Codex", 2)).toBe(true);
    expect(shouldShowQuotaPoolHeading("claude", "Claude", 2)).toBe(true);
  });
});
