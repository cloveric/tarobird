import type { ContextUsage } from "../../src/client-protocol/context-usage.js";
import type { Locale } from "../../src/runtime/locale.js";
import { quotaScopeSchema, type QuotaConstraint, type QuotaScope } from "../../src/client-protocol/engine-quota.js";

/** How long a quota reading is considered fresh. Older readings stay visible
 * marked as old until a newer reading arrives or their quota windows reset. */
export const QUOTA_SHOWN_FOR_MS = 30 * 60_000;
/** Upper age bound for readings whose windows carry no reset timestamp. */
export const QUOTA_MAX_STALE_MS = 7 * 24 * 60 * 60_000;
/** Modest interval for background quota refresh while a conversation stays open. */
export const QUOTA_BACKGROUND_POLL_MS = 5 * 60_000;
/** Exponential backoff delays after failed background quota refresh attempts. */
export const QUOTA_RETRY_BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000] as const;

/** At or below these shares of what is left the symbol turns amber, then red. */
export const USAGE_LOW_PERCENT = 20, USAGE_EMPTY_PERCENT = 5;
export type UsageTone = "ok" | "low" | "empty";
export const usageTone = (left: number): UsageTone => left <= USAGE_EMPTY_PERCENT ? "empty" : left <= USAGE_LOW_PERCENT ? "low" : "ok";
const percent = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

export type ContextView = { left: number; usedTokens: number; windowTokens: number; /** Share of the window in use at which the engine compacts by itself. */ compactAt?: number };
/** What is left of a conversation's context window, from the engine's own numbers only. */
export function contextView(usage: ContextUsage | undefined): ContextView | undefined {
  if (!usage?.supported || usage.usedTokens === undefined || !usage.windowTokens) return undefined;
  const { usedTokens, windowTokens, autoCompactTokens } = usage;
  return { left: percent(100 - usedTokens / windowTokens * 100), usedTokens, windowTokens, ...(autoCompactTokens ? { compactAt: percent(autoCompactTokens / windowTokens * 100) } : {}) };
}

const plain = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const EFFORT_SUFFIX = /-(low|medium|high|xhigh|max|ultra)$/;
/** Whether one of a pool's model names is the Bot's model: the same id (Codex), or an Antigravity
 * display name ("Claude Opus 5.5") against its id with the effort preset removed ("claude-opus-5-5-high"). */
export function poolCoversModel(models: readonly string[], model: string): boolean {
  if (!model) return false;
  const id = plain(model), base = plain(model.replace(EFFORT_SUFFIX, ""));
  return models.some(name => { const value = plain(name); return value !== "" && (value === id || value === base); });
}
// Claude reports its per-model weekly windows beside the shared ones; extra-usage windows are not quota left.
const CLAUDE_MODEL_WINDOWS: Record<string, string> = { seven_day_opus: "opus", seven_day_sonnet: "sonnet" };
const CLAUDE_EXTRA_WINDOWS = new Set(["seven_day_overage_included", "overage"]);
// Kimi's monthly top-up spending cap is an extra-usage ceiling, not remaining plan quota.
const KIMI_EXTRA_WINDOWS = new Set(["extra_monthly"]);

export type QuotaWindowView = { id: string; pool: string; label: string; periodSeconds?: number; left: number; resetsAt?: string };
/** Engine limits that refuse ordinary use whatever the windows say. Disabled extra usage is not one of them. */
export type QuotaBlock = Exclude<QuotaConstraint["code"], "overage_disabled">;
export type QuotaView = {
  left: number;
  windows: QuotaWindowView[];
  blocked: QuotaBlock[];
  observedAt: string;
  /** True when the reading is past its 30-minute fresh period or shown from restart cache before live confirmation. */
  stale: boolean;
  /** Milliseconds elapsed since `observedAt` at render time. */
  ageMs: number;
  /** True when shown immediately from persisted device storage before a live host reply arrived. */
  fromCache?: boolean;
};

/** Whether a quota scope still contains at least one unreset window or unreset active block. */
export function hasUnresetQuotaData(scope: QuotaScope, now: number): boolean {
  if (!scope.observedAt || (scope.state !== "ready" && scope.state !== "stale")) return false;
  const observedMs = Date.parse(scope.observedAt);
  if (!Number.isFinite(observedMs) || now - observedMs >= QUOTA_MAX_STALE_MS) return false;
  const activeBlock = (constraints: readonly QuotaConstraint[]) =>
    constraints.some(item => item.availability === "blocked" && item.code !== "overage_disabled" && !(item.resetsAt && Date.parse(item.resetsAt) <= now));
  if (activeBlock(scope.constraints)) return true;
  for (const pool of scope.pools) {
    if (activeBlock(pool.constraints)) return true;
    for (const window of pool.windows) {
      if (window.metric === "percent" && !(window.resetsAt && Date.parse(window.resetsAt) <= now)) return true;
    }
  }
  return false;
}

/** The quota that counts for a Bot on `model`: the windows of the pools that cover that model, and
 * the tightest of them. Readings older than `QUOTA_SHOWN_FOR_MS` stay visible marked as `stale: true`
 * rather than disappearing; a window past its reset time is left out so reset readings are never shown as current. */
export function quotaView(
  scope: QuotaScope | undefined,
  model: string,
  now: number,
  options?: { fromCache?: boolean },
): QuotaView | undefined {
  if (!scope?.observedAt || scope.state !== "ready" && scope.state !== "stale") return undefined;
  const observedMs = Date.parse(scope.observedAt);
  if (!Number.isFinite(observedMs)) return undefined;
  const ageMs = Math.max(0, now - observedMs);
  if (ageMs >= QUOTA_MAX_STALE_MS) return undefined;
  // Claude names a model family ("Fable"), which a Bot's model id contains; other engines name whole models.
  const covers = (models: readonly string[]) => scope.engine === "claude" ? models.some(name => plain(name) !== "" && plain(model).includes(plain(name))) : poolCoversModel(models, model);
  const windows: QuotaWindowView[] = [], blocks = (constraints: readonly QuotaConstraint[]) => constraints.flatMap(item =>
    item.availability === "blocked" && item.code !== "overage_disabled" && !(item.resetsAt && Date.parse(item.resetsAt) <= now) ? [item.code] : []);
  const blocked = new Set<QuotaBlock>(blocks(scope.constraints));
  let counted = 0;
  for (const pool of scope.pools) {
    // Every Antigravity group is for certain models. One that names none (an older Host) cannot be attributed.
    if (pool.models?.length ? !covers(pool.models) : scope.engine === "antigravity") continue;
    counted++;
    for (const code of blocks(pool.constraints)) blocked.add(code);
    for (const window of pool.windows) {
      if (window.metric !== "percent" || window.resetsAt && Date.parse(window.resetsAt) <= now) continue;
      if (scope.engine === "claude") {
        const family = CLAUDE_MODEL_WINDOWS[window.id];
        if (CLAUDE_EXTRA_WINDOWS.has(window.id) || family && !model.toLowerCase().includes(family)) continue;
      }
      if (scope.engine === "kimi" && KIMI_EXTRA_WINDOWS.has(window.id)) continue;
      windows.push({ id: `${pool.id}:${window.id}`, pool: pool.label, label: window.label, left: percent(100 - window.usedPercent), ...(window.periodSeconds ? { periodSeconds: window.periodSeconds } : {}), ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}) });
    }
  }
  // An account-wide block counts only where some pool of the reading counts for this Bot.
  if (!windows.length && !(blocked.size && (counted || !scope.pools.length))) return undefined;
  // Decouple the UI's 30-minute fresh period from the Gateway's 60-second cache TTL (which sets state="stale").
  const stale = ageMs >= QUOTA_SHOWN_FOR_MS || options?.fromCache === true;
  return {
    left: blocked.size ? 0 : Math.min(...windows.map(window => window.left)),
    windows,
    blocked: [...blocked],
    observedAt: scope.observedAt,
    stale,
    ageMs,
    ...(options?.fromCache ? { fromCache: true } : {}),
  };
}

/** Replies the Hub makes up when a worker did not answer in time or is away; they say nothing about the account. */
const NO_ANSWER = new Set(["offline", "timeout", "invalid_response", "host_upgrade_required"]);
export const workerAnswered = (scope: QuotaScope) => !(scope.reason !== undefined && scope.revision === scope.reason && NO_ANSWER.has(scope.reason));
/** Reasons that invalidate any previously held reading for this Bot even when the revision stays unchanged. */
export const QUOTA_CLEARING_REASONS = new Set(["auth_changed", "login_required", "mode_not_supported", "not_adapted", "scope_unverifiable"]);
/** What the App holds for a Bot after a reply from its Host. */
export function nextHeldQuota(previous: QuotaScope | undefined, scope: QuotaScope): QuotaScope | undefined {
  if (!workerAnswered(scope)) return previous;
  // A reading replaces the held one unless it is the same login's older answer: another process of the Bot
  // may still hold an earlier one.
  if (scope.observedAt) {
    return previous?.revision === scope.revision && previous.observedAt && Date.parse(previous.observedAt) > Date.parse(scope.observedAt)
      ? previous
      : scope;
  }
  // Another login, or a login without quota: the earlier number is not about it. A login the Host cannot verify
  // keeps the same revision when the account behind it changes, so its one-shot reading is not kept either.
  return previous && (previous.revision !== scope.revision || QUOTA_CLEARING_REASONS.has(scope.reason ?? "")) ? undefined : previous;
}

/** Readings saved on this device, so a Bot's battery appears immediately when the App starts again
 * (marked as old until confirmed or refreshed). Only percentages, reset times and pool names are stored. */
export const SAVED_QUOTA_KEY = "tarobird.quotaReadings.v1";
const SAVED_HOSTS = 16, SAVED_BOTS = 64;
const savedHosts = (raw: string | null): Record<string, Record<string, unknown>> => {
  try { const value: unknown = raw ? JSON.parse(raw) : undefined; return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, Record<string, unknown>> : {}; }
  catch { return {}; }
};
const worthSaving = (scope: QuotaScope, now: number) => hasUnresetQuotaData(scope, now);
/** The saved readings of one Host whose quota windows have not yet reset. Anything unreadable is left out. */
export function loadSavedQuota(raw: string | null, hostKey: string, now: number): Map<string, QuotaScope> {
  const found = new Map<string, QuotaScope>(), host = savedHosts(raw)[hostKey];
  if (host && typeof host === "object") for (const [botId, value] of Object.entries(host).slice(0, SAVED_BOTS)) {
    const scope = quotaScopeSchema.safeParse(value);
    if (scope.success && scope.data.id === botId && worthSaving(scope.data, now)) found.set(botId, scope.data);
  }
  return found;
}
/** The stored text after this Host's readings are replaced. Readings whose windows have all reset are dropped. */
export function saveQuota(raw: string | null, hostKey: string, readings: ReadonlyMap<string, QuotaScope>, now: number): string {
  const hosts: Record<string, Record<string, QuotaScope>> = {};
  for (const key of [hostKey, ...Object.keys(savedHosts(raw)).filter(key => key !== hostKey)].slice(0, SAVED_HOSTS)) {
    const kept = Object.fromEntries([...(key === hostKey ? readings : loadSavedQuota(raw, key, now))].filter(([, scope]) => worthSaving(scope, now)).slice(0, SAVED_BOTS));
    if (Object.keys(kept).length) hosts[key] = kept;
  }
  return JSON.stringify(hosts);
}
/** The stored text without one Host's readings, for when this device forgets that Host. */
export function forgetSavedQuota(raw: string | null, hostKey: string): string {
  const hosts = savedHosts(raw); delete hosts[hostKey]; return JSON.stringify(hosts);
}
/** Drops one Host's saved readings from this device's storage. */
export function forgetSavedQuotaHost(hostKey: string): void {
  try { const raw = localStorage.getItem(SAVED_QUOTA_KEY); if (raw !== null) localStorage.setItem(SAVED_QUOTA_KEY, forgetSavedQuota(raw, hostKey)); } catch { /* blocked storage holds no readings */ }
}
/** What becomes of a saved reading once its Host has answered for that Bot. It is adopted when the Bot's
 * worker confirms the same login ("adopt"); another login discards it ("drop"); while only the Hub answers
 * for a worker that is away, it stays waiting ("wait"). */
export function savedQuotaAfter(saved: QuotaScope, scope: QuotaScope): "adopt" | "drop" | "wait" {
  return !workerAnswered(scope) ? "wait" : saved.revision === scope.revision ? "adopt" : "drop";
}

/** After "sign in first" the engine is left alone this long: asking again can open a browser sign-in. */
export const QUOTA_SIGN_IN_RETRY_MS = 30 * 60_000;
export type QuotaAttempt = { revision: string; at: number; signIn: boolean };
/** Whether the engine itself may be asked now: not while the held reading is newer than `olderThan`, and not
 * sooner than that after the last attempt for this login, so a failing read is not repeated each time a
 * conversation opens. */
export function mayAskEngine(scope: QuotaScope, held: QuotaScope | undefined, attempt: QuotaAttempt | undefined, now: number, olderThan: number): boolean {
  if (!workerAnswered(scope) || scope.capability.mode !== "active" || scope.state === "login_required" || scope.state === "unsupported") return false;
  if (held?.observedAt && held.revision === scope.revision && now - Date.parse(held.observedAt) < olderThan) return false;
  return !(attempt && attempt.revision === scope.revision && now - attempt.at < (attempt.signIn ? Math.max(olderThan, QUOTA_SIGN_IN_RETRY_MS) : olderThan));
}

/** Delay before the next background refresh/retry while a conversation stays open. */
export function quotaRetryDelayMs(consecutiveFailures: number, signInRequired = false): number {
  if (signInRequired) return QUOTA_SIGN_IN_RETRY_MS;
  if (consecutiveFailures <= 0) return QUOTA_BACKGROUND_POLL_MS;
  return QUOTA_RETRY_BACKOFF_MS[Math.min(consecutiveFailures - 1, QUOTA_RETRY_BACKOFF_MS.length - 1)]!;
}

/** When a reading stops being true (earliest window reset, or max stale horizon when no reset is reported). */
export function quotaViewEndsAt(view: QuotaView): number {
  return Math.min(
    Date.parse(view.observedAt) + QUOTA_MAX_STALE_MS,
    ...view.windows.flatMap(window => window.resetsAt ? [Date.parse(window.resetsAt)] : []),
  );
}

/** Next timestamp when the UI should re-evaluate this view: either fresh→stale boundary or earliest window reset. */
export function quotaViewNextChangeAt(view: QuotaView): number {
  const ends = quotaViewEndsAt(view);
  if (!view.stale) return Math.min(ends, Date.parse(view.observedAt) + QUOTA_SHOWN_FOR_MS);
  return ends;
}

/** Compact relative age string for old readings ("just now", "12 min ago", "2 hr ago", "1 day ago"). */
export function quotaReadingAgeLabel(observedAt: string, now: number, locale: Locale): string {
  const ageMs = Math.max(0, now - Date.parse(observedAt));
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 1) return locale === "zh" ? "刚刚" : "just now";
  if (mins < 60) return locale === "zh" ? `${mins} 分钟前` : `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return locale === "zh" ? `${hours} 小时前` : `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return locale === "zh" ? `${days} 天前` : days === 1 ? "1 day ago" : `${days} days ago`;
}

/** "76k", "1.2M": the engine's token counts, shortened. */
export function shortTokens(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 999_500) return `${value < 9950 ? Math.round(value / 100) / 10 : Math.round(value / 1000)}k`;
  return `${Math.round(value / 100_000) / 10}M`;
}

/** Accurate time remaining computed from a provider's reset timestamp (not the window length).
 * Returns null once the reset timestamp has passed. */
export function formatTimeRemaining(resetsAt: string | undefined, now: number, locale: Locale): string | null {
  if (!resetsAt) return null;
  const ms = Date.parse(resetsAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (locale !== "zh") {
    if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    return `${minutes}m`;
  }
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
  return `${minutes} 分钟`;
}
