import { z } from "zod";
import type { BotCatalog, CreateBotInput } from "./bots.js";
import { effortValueSchema } from "./effort.js";
import type { QuotaConstraint, QuotaDirectory, QuotaPool, QuotaScope } from "./engine-quota.js";
import type { HostBalanceResources } from "./host-balance-resources.js";
import { deepSeekDefaultUnavailable } from "./model.js";
import type { PermissionChoice } from "../state/permission-options.js";

export const hostBalancePreferenceSchema = z.enum(["normal", "prefer", "less_often", "manual_only"]);
export type HostBalancePreference = z.infer<typeof hostBalancePreferenceSchema>;

export const loadBalancingPreferencesSchema = z.object({
  enabled: z.boolean().default(false),
  hostPreferences: z.record(z.string().max(128), hostBalancePreferenceSchema).default({}),
  botTemplate: z.object({
    namePrefix: z.string().max(48).default(""),
    workspace: z.string().max(1024).default(""),
  }).default({ namePrefix: "", workspace: "" }),
}).strict();
export type LoadBalancingPreferences = z.infer<typeof loadBalancingPreferencesSchema>;

export const defaultLoadBalancingPreferences: LoadBalancingPreferences = {
  enabled: false,
  hostPreferences: {},
  botTemplate: { namePrefix: "", workspace: "" },
};

export type HostBalanceExclusionReason =
  | "offline"
  | "manual_only"
  | "engine_unavailable"
  | "login_required"
  | "quota_exhausted"
  | "resources_unavailable"
  | "overloaded";

export interface HostBalanceCandidate {
  hostId: string;
  hostName: string;
  hostKey?: string;
  online: boolean;
  preference: HostBalancePreference;
  engineAvailable: boolean;
  quotaExhausted: boolean;
  loginRequired?: boolean;
  latencyMs?: number;
  resources?: HostBalanceResources;
  /** Existing online/usable Bot on this Host matching the chosen engine, if any. */
  matchingBotId?: string;
  matchingBotName?: string;
}

export interface RankedHostCandidate {
  candidate: HostBalanceCandidate;
  score: number;
}

export interface ExcludedHostCandidate {
  hostId: string;
  hostName: string;
  reason: HostBalanceExclusionReason;
}

export interface HostBalanceSelection {
  selected: HostBalanceCandidate | null;
  ranked: RankedHostCandidate[];
  excluded: ExcludedHostCandidate[];
  reason?: "no_eligible_host";
}

export interface HostBalanceOptions {
  /** Recent hostIds chosen for new conversations (newest last), used to spread equal ties. */
  recentAssignments?: readonly string[];
  /** Require live Host resource telemetry to consider a Host eligible. */
  requireResources?: boolean;
  /** CPU % threshold above which a Host is treated as overloaded (default 92). */
  maxCpuPercent?: number;
  /** Memory % threshold above which a Host is treated as overloaded (default 95). */
  maxMemoryPercent?: number;
}

const DEFAULT_MAX_CPU = 92;
const DEFAULT_MAX_MEM = 95;

const NO_ANSWER_QUOTA_REASONS = new Set(["offline", "timeout", "invalid_response", "host_upgrade_required"]);
const CLAUDE_MODEL_WINDOWS: Record<string, string> = { seven_day_opus: "opus", seven_day_sonnet: "sonnet" };
const CLAUDE_EXTRA_WINDOWS = new Set(["seven_day_overage_included", "overage"]);
const EFFORT_SUFFIX = /-(low|medium|high|xhigh|max|ultra)$/;

function plainModel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function quotaScopeAnswered(scope: QuotaScope): boolean {
  return !(scope.reason !== undefined && scope.revision === scope.reason && NO_ANSWER_QUOTA_REASONS.has(scope.reason));
}

function timestampPassed(iso: string | undefined, now: number): boolean {
  if (!iso) return false;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && parsed <= now;
}

function hasActiveBlockingConstraint(constraints: readonly QuotaConstraint[], now: number): boolean {
  return constraints.some(
    (constraint) =>
      constraint.availability === "blocked" &&
      constraint.code !== "overage_disabled" &&
      !timestampPassed(constraint.resetsAt, now),
  );
}

function poolCoversModel(scope: QuotaScope, pool: QuotaPool, model: string): boolean {
  if (!pool.models?.length) return true;
  if (!model) return true;
  if (scope.engine === "claude") {
    const normalized = plainModel(model);
    return pool.models.some((name) => {
      const target = plainModel(name);
      return target !== "" && normalized.includes(target);
    });
  }
  const id = plainModel(model);
  const base = plainModel(model.replace(EFFORT_SUFFIX, ""));
  return pool.models.some((name) => {
    const target = plainModel(name);
    return target !== "" && (target === id || target === base);
  });
}

function evaluateQuotaPool(
  scope: QuotaScope,
  pool: QuotaPool,
  model: string,
  now: number,
): { blocked: boolean; hasActiveReading: boolean; hasPassedReset: boolean } {
  if (hasActiveBlockingConstraint(pool.constraints, now)) {
    return { blocked: true, hasActiveReading: true, hasPassedReset: false };
  }

  let hasPassedReset = pool.constraints.some((constraint) => timestampPassed(constraint.resetsAt, now));
  let activeWindows = 0;

  for (const win of pool.windows) {
    if (scope.engine === "claude") {
      if (CLAUDE_EXTRA_WINDOWS.has(win.id)) continue;
      const family = CLAUDE_MODEL_WINDOWS[win.id];
      if (family && (!model || !model.toLowerCase().includes(family))) continue;
    }
    if (timestampPassed(win.resetsAt, now)) {
      hasPassedReset = true;
      continue;
    }
    activeWindows++;
    if (win.availability === "blocked" || (win.metric === "percent" && win.usedPercent >= 100)) {
      return { blocked: true, hasActiveReading: true, hasPassedReset };
    }
  }

  const activeBalances = pool.balances.filter((balance) => !timestampPassed(balance.expiresAt, now));
  if (
    activeBalances.length > 0 &&
    !activeBalances.some((balance) => balance.unlimited === true) &&
    activeBalances.every((balance) => balance.amount !== null && Number(balance.amount) <= 0)
  ) {
    return { blocked: true, hasActiveReading: true, hasPassedReset };
  }

  if (pool.availability === "blocked" && !hasPassedReset && activeWindows === 0) {
    return { blocked: true, hasActiveReading: true, hasPassedReset };
  }

  const hasActiveReading =
    activeWindows > 0 ||
    activeBalances.length > 0 ||
    pool.availability === "allowed" ||
    pool.availability === "warning";
  return { blocked: false, hasActiveReading, hasPassedReset };
}

/** Whether a quota scope reports that the engine on this Host needs sign-in. */
export function isQuotaScopeLoginRequired(scope: QuotaScope): boolean {
  return quotaScopeAnswered(scope) && (scope.state === "login_required" || scope.reason === "login_required");
}

/**
 * Whether a quota scope reports that ordinary usage is currently exhausted/blocked
 * for the given model (ignoring expired windows/constraints whose reset time passed).
 */
export function isQuotaScopeExhausted(
  scope: QuotaScope,
  options: { model?: string; now?: number } = {},
): boolean {
  if (!quotaScopeAnswered(scope)) return false;
  if (scope.state !== "ready" && scope.state !== "stale") return false;
  const now = options.now ?? Date.now();
  const model = options.model?.trim() ?? "";

  if (hasActiveBlockingConstraint(scope.constraints, now)) return true;

  const topPassedReset = scope.constraints.some((constraint) => timestampPassed(constraint.resetsAt, now));
  if (scope.pools.length === 0) {
    return scope.availability === "blocked" && !topPassedReset;
  }

  if (model) {
    const relevant = scope.pools.filter((pool) => poolCoversModel(scope, pool, model));
    if (relevant.length === 0) {
      return scope.availability === "blocked" && !topPassedReset;
    }
    const evaluated = relevant.map((pool) => evaluateQuotaPool(scope, pool, model, now));
    if (evaluated.some((result) => result.blocked)) return true;
    const anyPassedReset = topPassedReset || evaluated.some((result) => result.hasPassedReset);
    const anyAllowed = evaluated.some((result) => result.hasActiveReading);
    return scope.availability === "blocked" && !anyAllowed && !anyPassedReset;
  }

  const sharedPools = scope.pools.filter((pool) => !pool.models?.length);
  const modelPools = scope.pools.filter((pool) => !!pool.models?.length);
  const sharedEvaluated = sharedPools.map((pool) => evaluateQuotaPool(scope, pool, "", now));
  if (sharedEvaluated.some((result) => result.blocked)) return true;

  const modelEvaluated = modelPools.map((pool) => evaluateQuotaPool(scope, pool, "", now));
  if (sharedPools.length === 0 && modelEvaluated.length > 0 && modelEvaluated.every((result) => result.blocked)) {
    return true;
  }

  const allEvaluated = [...sharedEvaluated, ...modelEvaluated];
  const anyPassedReset = topPassedReset || allEvaluated.some((result) => result.hasPassedReset);
  const anyAllowed = allEvaluated.some((result) => result.hasActiveReading);
  return scope.availability === "blocked" && !anyAllowed && !anyPassedReset;
}

export interface ResolvedCatalogBotDefaults {
  model: string;
  effort: CreateBotInput["effort"];
  permission?: PermissionChoice;
}

/**
 * Evaluate whether an engine catalog entry can auto-create a Bot with the requested model,
 * returning valid model, effort, and default permission choices matching Hub validation.
 */
export function resolveCatalogBotDefaults(
  engine: CreateBotInput["engine"],
  entry: BotCatalog["engines"][number] | undefined,
  requestedModel?: string,
): { ok: true; defaults: ResolvedCatalogBotDefaults } | { ok: false; reason: "engine_unavailable" } {
  if (!entry || !entry.available) {
    return { ok: false, reason: "engine_unavailable" };
  }
  if (engine === "deepseek" && (entry.catalogStatus === "unavailable" || entry.catalogStatus === "no-models")) {
    return { ok: false, reason: "engine_unavailable" };
  }

  const trimmed = requestedModel?.trim() ?? "";
  const model = trimmed || entry.defaultModel || "";
  const maxModelLength = engine === "pi" || engine === "deepseek" ? 512 : 128;
  if (model.length > maxModelLength) {
    return { ok: false, reason: "engine_unavailable" };
  }

  if (engine === "deepseek") {
    if (!model && deepSeekDefaultUnavailable("deepseek", entry.catalogStatus, entry.models)) {
      return { ok: false, reason: "engine_unavailable" };
    }
    if (entry.catalogStatus === "ready") {
      const choice = entry.models.find((item) => item.id === model);
      if (!choice?.provider || !choice.modelId) {
        return { ok: false, reason: "engine_unavailable" };
      }
    }
  } else if (engine === "pi" && model) {
    if (entry.catalogStatus === "ready" && !entry.models.some((item) => item.id === model)) {
      return { ok: false, reason: "engine_unavailable" };
    }
  }

  const defaultEffort = effortValueSchema.safeParse(entry.defaultEffort ?? "").data ?? "";
  const choice = entry.models.find((item) => item.id === model);
  const supportedEfforts = choice
    ? choice.efforts.filter((value): value is CreateBotInput["effort"] => effortValueSchema.safeParse(value).success)
    : [];

  let effort: CreateBotInput["effort"] = "";
  if (supportedEfforts.length > 0) {
    if (!trimmed && supportedEfforts.includes(defaultEffort)) {
      effort = defaultEffort;
    } else if (supportedEfforts.includes("")) {
      effort = "";
    } else if (supportedEfforts.includes(defaultEffort)) {
      effort = defaultEffort;
    } else {
      effort = supportedEfforts[0]!;
    }
  } else if (!trimmed) {
    effort = defaultEffort;
  }

  const permission = entry.permissions?.defaultChoice;
  return {
    ok: true,
    defaults: {
      model,
      effort,
      ...(permission ? { permission } : {}),
    },
  };
}

export interface BalanceHostBot {
  id: string;
  name: string;
  engine: string;
  model?: string;
  online?: number | boolean;
  role?: string;
  deletedAt?: number;
}

export interface HostEngineEvaluation {
  engineAvailable: boolean;
  quotaExhausted: boolean;
  loginRequired: boolean;
  matchingBot?: BalanceHostBot;
  createDefaults?: ResolvedCatalogBotDefaults;
}

/**
 * Evaluate a single Host's eligibility for a target engine (and optional model):
 * - Excludes deleted, worker, and dispatcher Bots.
 * - Preserves eligibility of existing usable Bots even if the Host's CLI catalog does not list that engine.
 * - Checks `/api/engine-quotas` scopes for quota exhaustion and sign-in requirements.
 * - Resolves catalog defaults when no matching Bot exists and auto-creation is allowed.
 */
export function evaluateHostEngineCandidate(params: {
  engine: CreateBotInput["engine"];
  requestedModel?: string;
  bots: readonly BalanceHostBot[];
  canCreateBot: boolean;
  catalog?: BotCatalog;
  quotas?: QuotaDirectory;
  now?: number;
}): HostEngineEvaluation {
  const now = params.now ?? Date.now();
  const requestedModel = params.requestedModel?.trim() ?? "";
  const usableBots = params.bots.filter(
    (bot) => !bot.deletedAt && bot.role !== "worker" && bot.role !== "dispatcher",
  );
  const matchingBots = usableBots.filter(
    (bot) => bot.engine === params.engine && (!requestedModel || (bot.model ?? "") === requestedModel),
  );

  const scopeForBot = (botId: string): QuotaScope | undefined =>
    params.quotas?.scopes.find((scope) => scope.id === botId || scope.botIds.includes(botId));

  if (matchingBots.length > 0) {
    const scored = matchingBots.map((bot, index) => {
      const scope = scopeForBot(bot.id);
      const loginRequired = scope ? isQuotaScopeLoginRequired(scope) : false;
      const quotaExhausted = scope
        ? isQuotaScopeExhausted(scope, { model: requestedModel || bot.model, now })
        : false;
      const online = Boolean(bot.online);
      const usable = !loginRequired && !quotaExhausted;
      const rank = (usable ? 0 : 2) + (online ? 0 : 1);
      return { bot, loginRequired, quotaExhausted, rank, index };
    });
    scored.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.index - b.index));
    const best = scored[0]!;
    return {
      engineAvailable: true,
      loginRequired: best.loginRequired,
      quotaExhausted: !best.loginRequired && best.quotaExhausted,
      matchingBot: best.bot,
    };
  }

  if (!params.canCreateBot) {
    return { engineAvailable: false, quotaExhausted: false, loginRequired: false };
  }

  const catalogEntry = params.catalog?.engines.find((item) => item.id === params.engine);
  const resolved = resolveCatalogBotDefaults(params.engine, catalogEntry, requestedModel);
  if (!resolved.ok) {
    return { engineAvailable: false, quotaExhausted: false, loginRequired: false };
  }

  const answeredScopes = (params.quotas?.scopes ?? []).filter(
    (scope) => scope.engine === params.engine && quotaScopeAnswered(scope),
  );
  const loginRequired =
    answeredScopes.length > 0 && answeredScopes.every((scope) => isQuotaScopeLoginRequired(scope));
  const quotaExhausted =
    !loginRequired &&
    answeredScopes.length > 0 &&
    answeredScopes.every((scope) => isQuotaScopeExhausted(scope, { model: resolved.defaults.model, now }));

  return {
    engineAvailable: true,
    loginRequired,
    quotaExhausted,
    createDefaults: resolved.defaults,
  };
}

/**
 * Pick the best Host for a new conversation based on availability, engine/quota
 * readiness, real-time CPU/memory/active-task load, latency, and per-Host
 * preference (Normal / Prefer / Less often / Manual only).
 *
 * Preferences act as soft weights (not fixed ratios): a "Prefer" host receives
 * a bonus when it has spare CPU (<75%) and memory (<85%), and "Less often" gets
 * a penalty so it is only picked when normal/preferred hosts are busier.
 */
export function selectBalancedHost(
  candidates: readonly HostBalanceCandidate[],
  options: HostBalanceOptions = {},
): HostBalanceSelection {
  const maxCpu = options.maxCpuPercent ?? DEFAULT_MAX_CPU;
  const maxMem = options.maxMemoryPercent ?? DEFAULT_MAX_MEM;
  const requireResources = options.requireResources ?? false;
  const recent = options.recentAssignments ?? [];

  const excluded: ExcludedHostCandidate[] = [];
  const eligible: RankedHostCandidate[] = [];

  for (const item of candidates) {
    if (!item.online) {
      excluded.push({ hostId: item.hostId, hostName: item.hostName, reason: "offline" });
      continue;
    }
    if (item.preference === "manual_only") {
      excluded.push({ hostId: item.hostId, hostName: item.hostName, reason: "manual_only" });
      continue;
    }
    if (!item.engineAvailable) {
      excluded.push({ hostId: item.hostId, hostName: item.hostName, reason: "engine_unavailable" });
      continue;
    }
    if (item.loginRequired) {
      excluded.push({ hostId: item.hostId, hostName: item.hostName, reason: "login_required" });
      continue;
    }
    if (item.quotaExhausted) {
      excluded.push({ hostId: item.hostId, hostName: item.hostName, reason: "quota_exhausted" });
      continue;
    }
    if (!item.resources && requireResources) {
      excluded.push({ hostId: item.hostId, hostName: item.hostName, reason: "resources_unavailable" });
      continue;
    }
    if (item.resources && (item.resources.cpuPercent >= maxCpu || item.resources.memoryUsedPercent >= maxMem)) {
      excluded.push({ hostId: item.hostId, hostName: item.hostName, reason: "overloaded" });
      continue;
    }

    const res = item.resources;
    const cpu = res ? res.cpuPercent : 35;
    const mem = res ? res.memoryUsedPercent : 50;
    const activeTurns = res ? res.activeTurns : 0;
    const activeTickets = res ? res.activeTickets : 0;
    const latencyPenalty = Math.min(Math.max(0, item.latencyMs ?? 25), 500) / 10;

    // Lower score = better candidate
    let score = cpu * 0.45 + mem * 0.25 + activeTurns * 18 + activeTickets * 10 + latencyPenalty;

    const hasSpareCapacity = cpu < 75 && mem < 85;
    if (item.preference === "prefer" && hasSpareCapacity) {
      score -= 18;
    } else if (item.preference === "less_often") {
      score += 28;
    }

    // Slight preference for reusing an already-ready matching Bot on that Host
    if (item.matchingBotId) {
      score -= 4;
    }

    // Spread consecutive creations across equally idle Hosts
    const recentCount = recent.filter((id) => id === item.hostId).length;
    const lastIndex = recent.lastIndexOf(item.hostId);
    score += recentCount * 8 + (lastIndex >= 0 && lastIndex === recent.length - 1 ? 6 : 0);

    eligible.push({ candidate: item, score: Math.round(score * 100) / 100 });
  }

  eligible.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.candidate.hostId.localeCompare(b.candidate.hostId);
  });

  if (!eligible.length) {
    return { selected: null, ranked: [], excluded, reason: "no_eligible_host" };
  }
  return { selected: eligible[0]!.candidate, ranked: eligible, excluded };
}
