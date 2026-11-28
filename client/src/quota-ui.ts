import { quotaReadingExpired, type QuotaAuthMode, type QuotaEngine, type QuotaScope } from "../../src/client-protocol/engine-quota.js";
import { t } from "./i18n.js";

export function quotaScopeCanRead(scope: QuotaScope): boolean {
  return scope.capability.mode !== "unsupported" && scope.state !== "offline" && scope.reason !== "offline"
    && (scope.state !== "unsupported" || scope.capability.mode === "active") && scope.reason !== "host_upgrade_required";
}

export function quotaRefreshAfter(scopes: readonly QuotaScope[]): string | undefined {
  return scopes.reduce<string | undefined>((latest, scope) => {
    const next = scope.nextRefreshAt;
    if (!next || !Number.isFinite(Date.parse(next))) return latest;
    return !latest || Date.parse(next) > Date.parse(latest) ? next : latest;
  }, undefined);
}

const UNVERIFIED_FALLBACK_REVISIONS = new Set([
  "offline",
  "timeout",
  "invalid_response",
  "host_upgrade_required",
]);

const GENERIC_POOL_LABELS: Record<QuotaEngine, ReadonlySet<string>> = {
  codex: new Set(["codex"]),
  claude: new Set(["claude", "claude code"]),
  antigravity: new Set(["antigravity"]),
  kimi: new Set(["kimi"]),
  deepseek: new Set(["deepseek"]),
  pi: new Set(["pi"]),
  omp: new Set(["omp", "oh-my-pi", "oh-my-pi (omp)"]),
};

/** "Opus · 7 days", "Coding · 30 days": a scope, then the window. */
const SCOPED_WINDOW_LABEL = /^(.+?)\s*·\s*(.+)$/;

export interface QuotaWindowLabelInput {
  id?: string;
  label: string;
  periodSeconds?: number;
}

/** Map raw engine window names (Primary, Secondary, 5 hours, 7 days, Opus · 7 days)
 * into uniform window names so window lengths are never misread as time remaining.
 * Explicit positive `periodSeconds` always takes precedence over generic labels;
 * names that cannot be mapped retain their original engine label.
 * A scoped window keeps its scope ("Opus · 7 days", Kimi's "Coding · 30 days"). With `siblings` (the windows
 * shown beside this one), two unscoped windows of one length keep the engine's own names instead of sharing one. */
export function formatQuotaWindowLabel(window: QuotaWindowLabelInput, siblings?: readonly QuotaWindowLabelInput[]): string {
  const raw = window.label.trim();
  const split = SCOPED_WINDOW_LABEL.exec(raw);
  const rawPrefix = split?.[1]?.trim();
  const prefix = rawPrefix === "Coding" ? t("编程") : rawPrefix;
  const tail = (split?.[2] ?? raw).trim();
  const period = window.periodSeconds;

  let mapped: string | undefined;
  if (period !== undefined && period > 0) {
    if (period === 18_000) {
      mapped = t("5 小时窗口");
    } else if (period === 604_800) {
      mapped = t("周额度（7 天）");
    } else if (period >= 172_800 && period % 86_400 === 0) {
      mapped = t("{0} 天窗口", period / 86_400);
    } else if (period >= 3_600 && period % 3_600 === 0) {
      mapped = t("{0} 小时窗口", period / 3_600);
    } else if (period >= 60 && period % 60 === 0) {
      mapped = t("{0} 分钟窗口", period / 60);
    }
  } else if (/^(?:primary|5\s*h(?:ours?)?|5\s*小时(?:窗口)?|session)$/i.test(tail)) {
    mapped = t("5 小时窗口");
  } else if (/^(?:secondary|weekly|7\s*d(?:ays?)?|7\s*天|周额度(?:（7 天）)?)$/i.test(tail)) {
    mapped = t("周额度（7 天）");
  }

  if (!mapped) return raw;
  if (siblings && !rawPrefix && period !== undefined && period > 0 && siblings.some(other => other !== window
    && !(other.id !== undefined && other.id === window.id) && other.periodSeconds === period && !SCOPED_WINDOW_LABEL.test(other.label.trim()))) {
    return raw;
  }
  if (prefix && prefix.toLowerCase() !== mapped.toLowerCase()) {
    return `${prefix} · ${mapped}`;
  }
  return mapped;
}

/** Hide a single pool's heading only when it merely repeats the card's engine title.
 * Distinct model/group pools (such as Claude "Fable" or Antigravity model groups) always keep their heading. */
export function shouldShowQuotaPoolHeading(engine: QuotaEngine, poolLabel: string, poolCount: number): boolean {
  if (poolCount > 1) return true;
  const normalized = poolLabel.trim().toLowerCase();
  if (!normalized) return false;
  return !GENERIC_POOL_LABELS[engine].has(normalized);
}

export interface ResetCountdown {
  text: string;
  expired: boolean;
}

/** Format a reset timestamp as a countdown ("Resets in 4 days", "Resets in 3 d 20 h",
 * "Resets in 3 h 20 min", "Resets in 25 min", or already-passed wording). */
export function formatResetCountdown(resetsAt: string, now: number): ResetCountdown {
  const targetMs = Date.parse(resetsAt);
  if (!Number.isFinite(targetMs)) return { text: "", expired: false };
  const remainingMs = targetMs - now;
  if (remainingMs <= 0) {
    return { text: t("已到重置时间，等待更新"), expired: true };
  }
  const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  if (totalMinutes >= 1440) {
    const totalHours = Math.round(totalMinutes / 60);
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    if (hours > 0) {
      return {
        text: t("{0} 天 {1} 小时后重置", days, hours),
        expired: false,
      };
    }
    return {
      text: days === 1 ? t("1 天后重置") : t("{0} 天后重置", days),
      expired: false,
    };
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 1) {
    return {
      text: minutes > 0
        ? t("{0} 小时 {1} 分钟后重置", hours, minutes)
        : t("{0} 小时后重置", hours),
      expired: false,
    };
  }
  return {
    text: t("{0} 分钟后重置", Math.max(1, minutes)),
    expired: false,
  };
}

export interface QuotaAccountBot {
  id: string;
  label: string;
  scope: QuotaScope;
}

export interface QuotaAccountCard {
  key: string;
  engine: QuotaEngine;
  primary: QuotaScope;
  scopes: QuotaScope[];
  bots: QuotaAccountBot[];
  /** True when multiple Bots are confirmed to share this account. */
  merged: boolean;
  /** True when other Bots of the same engine exist, but account sharing could not be confirmed. */
  unconfirmedPeer: boolean;
}

export interface GroupQuotaScopesOptions {
  now?: number;
  botLabels?: ReadonlyMap<string, string>;
}

function parseTimestamp(value: string | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function isPassiveUninitialized(scope: QuotaScope): boolean {
  return scope.state === "offline"
    || scope.reason === "not_loaded"
    || scope.reason === "no_passive_event";
}

function isAuthFailure(scope: QuotaScope): boolean {
  return scope.state === "login_required" || scope.reason === "auth_changed";
}

function effectiveStateScore(scope: QuotaScope, now: number): number {
  if (scope.state === "ready") return quotaReadingExpired(scope, now) ? 2 : 3;
  if (scope.state === "stale") return 2;
  if (scope.observedAt) return 1;
  return 0;
}

function scopeActivityTime(scope: QuotaScope): number {
  return Math.max(parseTimestamp(scope.observedAt), parseTimestamp(scope.lastAttemptAt));
}

function compareScopePriority(candidate: QuotaScope, best: QuotaScope, now: number): number {
  const candAuth = !isPassiveUninitialized(candidate);
  const bestAuth = !isPassiveUninitialized(best);
  if (candAuth !== bestAuth) return candAuth ? 1 : -1;

  const candTime = scopeActivityTime(candidate);
  const bestTime = scopeActivityTime(best);

  const candAuthFail = isAuthFailure(candidate);
  const bestAuthFail = isAuthFailure(best);
  if (candAuthFail !== bestAuthFail) {
    if (candAuthFail && (candTime === 0 || candTime >= bestTime)) return 1;
    if (bestAuthFail && (bestTime === 0 || bestTime >= candTime)) return -1;
  }

  if (candTime !== bestTime) return candTime > bestTime ? 1 : -1;

  const candScore = effectiveStateScore(candidate, now);
  const bestScore = effectiveStateScore(best, now);
  if (candScore !== bestScore) return candScore > bestScore ? 1 : -1;

  const candMeta = Number(!!candidate.reason) + Number(!!candidate.nextRefreshAt);
  const bestMeta = Number(!!best.reason) + Number(!!best.nextRefreshAt);
  return candMeta - bestMeta;
}

function pickPrimaryScope(scopes: readonly QuotaScope[], now: number): QuotaScope {
  let best = scopes[0]!;
  for (let i = 1; i < scopes.length; i++) {
    const candidate = scopes[i]!;
    if (compareScopePriority(candidate, best, now) > 0) {
      best = candidate;
    }
  }
  return best;
}

function supportsQuotaSharing(scope: QuotaScope): boolean {
  return scope.capability.mode !== "unsupported" && scope.state !== "unsupported";
}

function compatibleAuthModes(a: QuotaAuthMode, b: QuotaAuthMode): boolean {
  if (a === "unknown" || b === "unknown") return true;
  return a === b;
}

function canonicalMemberIds(scope: QuotaScope): string[] {
  return [...new Set(scope.botIds)].sort();
}

function resolveCardBots(
  scopes: readonly QuotaScope[],
  primary: QuotaScope,
  botLabels?: ReadonlyMap<string, string>,
): QuotaAccountBot[] {
  const scopeById = new Map<string, QuotaScope>();
  for (const scope of scopes) scopeById.set(scope.id, scope);

  const allBotIds: string[] = [];
  const seenBotIds = new Set<string>();
  for (const scope of scopes) {
    for (const botId of scope.botIds) {
      if (!seenBotIds.has(botId)) {
        seenBotIds.add(botId);
        allBotIds.push(botId);
      }
    }
  }

  if (allBotIds.length === 0) {
    return scopes.map((scope) => ({ id: scope.id, label: scope.label, scope }));
  }

  const bots: QuotaAccountBot[] = [];
  const added = new Set<string>();
  // Preserve directory order for Bots present as scopes first.
  for (const scope of scopes) {
    if (seenBotIds.has(scope.id) && !added.has(scope.id)) {
      added.add(scope.id);
      bots.push({ id: scope.id, label: scope.label, scope });
    }
  }
  // Resolve any additional member botIds (e.g. a pre-merged verified scope).
  for (const botId of allBotIds) {
    if (added.has(botId)) continue;
    added.add(botId);
    const matchingScope = scopeById.get(botId);
    bots.push({
      id: botId,
      label: matchingScope?.label ?? botLabels?.get(botId) ?? botId,
      scope: matchingScope ?? primary,
    });
  }
  return bots;
}

/** Group scopes by confirmed account. Multiple Bots with `sharing === "verified"` and
 * identical verified member `botIds` for the same engine merge into one card listing every Bot
 * (independent of per-Bot concurrency `revision`). Unverified scopes stay separate and set
 * `unconfirmedPeer: true` only when another quota-capable, auth-compatible Bot uses the same engine. */
export function groupQuotaScopesByAccount(
  scopes: readonly QuotaScope[],
  options?: GroupQuotaScopesOptions,
): QuotaAccountCard[] {
  const now = options?.now ?? Date.now();
  const botLabels = options?.botLabels;

  const cards: QuotaAccountCard[] = [];
  const verifiedGroups = new Map<string, QuotaScope[]>();

  for (const scope of scopes) {
    const members = canonicalMemberIds(scope);
    const canVerify = scope.sharing === "verified"
      && members.length > 0
      && Boolean(scope.revision)
      && !UNVERIFIED_FALLBACK_REVISIONS.has(scope.revision);
    if (canVerify) {
      const groupKey = `verified:${scope.engine}:${members.join(",")}`;
      let list = verifiedGroups.get(groupKey);
      if (!list) {
        list = [];
        verifiedGroups.set(groupKey, list);
        cards.push({
          key: groupKey,
          engine: scope.engine,
          primary: scope,
          scopes: list,
          bots: [],
          merged: false,
          unconfirmedPeer: false,
        });
      }
      list.push(scope);
    } else {
      const unconfirmedPeer = supportsQuotaSharing(scope) && scopes.some((other) =>
        other !== scope
        && other.engine === scope.engine
        && supportsQuotaSharing(other)
        && compatibleAuthModes(scope.authMode, other.authMode),
      );
      cards.push({
        key: `scope:${scope.id}`,
        engine: scope.engine,
        primary: scope,
        scopes: [scope],
        bots: [{ id: scope.id, label: scope.label, scope }],
        merged: false,
        unconfirmedPeer,
      });
    }
  }

  for (const card of cards) {
    if (!verifiedGroups.has(card.key)) continue;
    card.primary = pickPrimaryScope(card.scopes, now);
    card.bots = resolveCardBots(card.scopes, card.primary, botLabels);
    card.merged = card.bots.length > 1;
    card.unconfirmedPeer = false;
  }

  return cards;
}
