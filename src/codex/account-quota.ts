import { createHash } from "node:crypto";
import { ENGINE_QUOTA_TTL_MS, quotaSnapshotSchema } from "../client-protocol/engine-quota.js";
import type { QuotaAuthMode, QuotaAvailability, QuotaConstraint, QuotaEngine, QuotaPool, QuotaReason, QuotaSnapshot, QuotaWindow } from "../client-protocol/engine-quota.js";

export const QUOTA_TTL_MS = ENGINE_QUOTA_TTL_MS;
export class QuotaReadError extends Error {
  constructor(readonly reason: QuotaReason) { super(reason); this.name = "QuotaReadError"; }
}
type ObjectValue = Record<string, unknown>;
export function quotaObject(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new QuotaReadError("invalid_response");
  return value as ObjectValue;
}
function optionalBoolean(value: unknown): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== "boolean") throw new QuotaReadError("invalid_response");
  return value;
}
export function quotaNativeIdentity(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new QuotaReadError("invalid_response");
  return value || undefined;
}
function number(value: unknown, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isInteger(value))) throw new QuotaReadError("invalid_response");
  return value;
}
function unixTime(value: unknown): string | undefined {
  if (value == null) return undefined;
  return new Date(number(value, 253402300799, true) * 1000).toISOString();
}
function isoTime(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) throw new QuotaReadError("invalid_response");
  // agy reports an unused pool's reset as the Unix epoch. That means "no reset scheduled", not a reset in 1970;
  // kept, it would mark every reading expired the moment it arrives (#205).
  if (Date.parse(value) <= 0) return undefined;
  return new Date(value).toISOString();
}
function observed(now: number) { return { observedAt: new Date(now).toISOString(), expiresAt: new Date(now + QUOTA_TTL_MS).toISOString() }; }
function safeSnapshot(value: QuotaSnapshot): QuotaSnapshot {
  const parsed = quotaSnapshotSchema.safeParse(value);
  if (!parsed.success) throw new QuotaReadError("invalid_response");
  return parsed.data;
}
function poolId(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
function availability(values: QuotaAvailability[]): QuotaAvailability {
  if (values.includes("blocked")) return "blocked";
  if (values.includes("warning")) return "warning";
  if (values.includes("allowed")) return "allowed";
  return "unknown";
}
const help: Partial<Record<QuotaEngine, QuotaSnapshot["help"]>> = {
  codex: "codex_usage", claude: "claude_usage", antigravity: "antigravity_usage", kimi: "kimi_usage", deepseek: "deepseek_balance",
};
export function unavailableQuota(engine: QuotaEngine, reason: QuotaReason, now = Date.now(), authMode: QuotaAuthMode = "unknown"): QuotaSnapshot {
  const unsupported = ["not_adapted", "native_unverified", "mode_not_supported"].includes(reason);
  const state = reason === "login_required" ? "login_required" : reason === "offline" ? "offline" : unsupported ? "unsupported" : ["not_loaded", "no_passive_event", "auth_changed", "scope_unverifiable"].includes(reason) ? "unknown" : "unavailable";
  return { authMode, capability: { mode: unsupported ? "unsupported" : engine === "claude" ? "passive" : "active", reason }, state, reason, availability: "unknown", lastAttemptAt: new Date(now).toISOString(), pools: [], constraints: [], ...(help[engine] ? { help: help[engine] } : {}) };
}

export function codexAccountMode(value: unknown): { authMode: QuotaAuthMode; identity: string; userId?: string; accountId?: string } {
  const response = quotaObject(value);
  if (typeof response.requiresOpenaiAuth !== "boolean") throw new QuotaReadError("invalid_response");
  if (response.account == null) {
    if (response.requiresOpenaiAuth) throw new QuotaReadError("login_required");
    return { authMode: "unknown", identity: "none" };
  }
  const account = quotaObject(response.account);
  const type = quotaNativeIdentity(account.type);
  const authMode: QuotaAuthMode = type === "chatgpt" ? "subscription" : type === "apiKey" ? "api_key" : type === "gcp" ? "adc" : "other";
  const userId = quotaNativeIdentity(response.userId);
  const accountId = response.workspaceRouting == null ? undefined : quotaNativeIdentity(quotaObject(response.workspaceRouting).chatgptAccountId);
  // Kept private, including email/workspace as a conservative switch detector when userId is omitted.
  return { authMode, userId, accountId, identity: JSON.stringify([type, userId, accountId, quotaNativeIdentity(account.email), quotaNativeIdentity(account.workspaceName), quotaNativeIdentity(account.planType)]) };
}

/** Complete account/rateLimits/read reply only. Do not feed sparse account/rateLimits/updated events here. */
export function parseCodexQuota(accountValue: unknown, limitsValue: unknown, now = Date.now()): QuotaSnapshot {
  const account = codexAccountMode(accountValue);
  if (account.authMode !== "subscription") return unavailableQuota("codex", "mode_not_supported", now, account.authMode);
  const reply = quotaObject(limitsValue);
  const ordinary = optionalBoolean(reply.ordinaryUsageAllowed);
  const constraints: QuotaConstraint[] = ordinary === false ? [{ code: "ordinary_usage_blocked", availability: "blocked" }] : [];
  const entries = reply.rateLimitsByLimitId == null ? [["default", reply.rateLimits] as const] : Object.entries(quotaObject(reply.rateLimitsByLimitId));
  if (entries.length > 64) throw new QuotaReadError("invalid_response");
  const pools = entries.map(([id, value], index): QuotaPool => {
    if (id.length > 4096) throw new QuotaReadError("invalid_response");
    const raw = quotaObject(value);
    const poolConstraints: QuotaConstraint[] = [];
    if (optionalBoolean(raw.spendControlReached)) poolConstraints.push({ code: "spend_control", availability: "blocked" });
    if (raw.rateLimitReachedType != null) {
      const reason = quotaNativeIdentity(raw.rateLimitReachedType)!;
      poolConstraints.push({ code: reason === "workspace_owner_credits_depleted" || reason === "workspace_member_credits_depleted" ? "credits_depleted" : "other_native_limit", availability: "blocked" });
    }
    const windows: QuotaWindow[] = [];
    for (const key of ["primary", "secondary"] as const) {
      if (raw[key] == null) continue;
      const source = quotaObject(raw[key]);
      const resetsAt = unixTime(source.resetsAt);
      const periodSeconds = source.windowDurationMins == null ? undefined : number(source.windowDurationMins, 366 * 24 * 60, true) * 60;
      windows.push({ id: key, label: key === "primary" ? "Primary" : "Secondary", metric: "percent", usedPercent: number(source.usedPercent, 2147483647, true), availability: "unknown", ...observed(now), ...(resetsAt ? { resetsAt } : {}), ...(periodSeconds ? { periodSeconds } : {}) });
    }
    if (raw.individualLimit != null) {
      const individual = quotaObject(raw.individualLimit);
      const resetsAt = unixTime(individual.resetsAt);
      windows.push({ id: "individual", label: "Individual", metric: "percent", usedPercent: 100 - number(individual.remainingPercent, 100, true), availability: "unknown", ...observed(now), ...(resetsAt ? { resetsAt } : {}) });
    }
    const balances: QuotaPool["balances"] = [];
    if (raw.credits != null) {
      const credits = quotaObject(raw.credits);
      if (typeof credits.hasCredits !== "boolean" || typeof credits.unlimited !== "boolean") throw new QuotaReadError("invalid_response");
      if (credits.balance != null && (typeof credits.balance !== "string" || credits.balance.length > 80 || !/^\d+(?:\.\d+)?$/.test(credits.balance))) throw new QuotaReadError("invalid_response");
      balances.push({ id: "credits", kind: "credits", amount: credits.balance as string | null ?? null, unit: "credits", unlimited: credits.unlimited, ...observed(now) });
    }
    // Native labels may contain account/workspace data. Only a model slug with a conservative grammar is retained.
    const model = typeof raw.normalModelSlug === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(raw.normalModelSlug) ? raw.normalModelSlug : undefined;
    return { id: poolId(id), label: entries.length === 1 ? "Codex" : `Codex ${index + 1}`, sharing: model ? "model" : "unspecified", ...(model ? { models: [model] } : {}), windows, balances, constraints: poolConstraints, availability: availability(poolConstraints.map(item => item.availability)) };
  });
  const available = availability([ordinary === true ? "allowed" : ordinary === false ? "blocked" : "unknown", ...pools.map(pool => pool.availability)]);
  const hasData = available !== "unknown" || pools.some(pool => pool.windows.length || pool.balances.length || pool.constraints.length);
  return safeSnapshot({ authMode: account.authMode, capability: { mode: "active" }, state: hasData ? "ready" : "unknown", availability: available, observedAt: new Date(now).toISOString(), lastAttemptAt: new Date(now).toISOString(), pools, constraints, help: "codex_usage" });
}

const claudeWindows: Record<string, { label: string; periodSeconds?: number }> = {
  five_hour: { label: "5 hours", periodSeconds: 18000 }, seven_day: { label: "7 days", periodSeconds: 604800 },
  seven_day_opus: { label: "Opus · 7 days", periodSeconds: 604800 }, seven_day_sonnet: { label: "Sonnet · 7 days", periodSeconds: 604800 },
  seven_day_overage_included: { label: "Included extra usage · 7 days", periodSeconds: 604800 }, overage: { label: "Extra usage" },
};
function claudeAvailability(value: unknown): QuotaAvailability {
  if (value === "allowed" || value === "normal") return "allowed";
  if (value === "allowed_warning" || value === "warning") return "warning";
  if (value === "rejected") return "blocked";
  // Report severity 'critical' is a warning level, not proof that requests are rejected.
  if (value === "critical") return "warning";
  throw new QuotaReadError("invalid_response");
}

/** Passive only: call on native stream messages already produced by ordinary user activity. No network or model calls. */
export function applyClaudeQuotaEvent(previous: QuotaSnapshot | undefined, value: unknown, now = Date.now()): QuotaSnapshot | undefined {
  const message = quotaObject(value);
  if (message.type !== "rate_limit_event" && !(message.type === "assistant" && message.usage_report != null)) return undefined;
  const snapshot: QuotaSnapshot = previous ? structuredClone(previous) : { authMode: "subscription", capability: { mode: "passive" }, state: "unknown", availability: "unknown", pools: [], constraints: [], help: "claude_usage" };
  if (message.type === "rate_limit_event") {
    const info = quotaObject(message.rate_limit_info);
    snapshot.availability = claudeAvailability(info.status);
    if (info.utilization != null) number(info.utilization, 1);
    const readings: Array<[string | undefined, ObjectValue]> = [[quotaNativeIdentity(info.rateLimitType), info]];
    // Claude Code 2.1.329 emits this additive map in its public stream-json
    // event (verified with isolated OAuth + a loopback response); older SDK typings omit it.
    if (info.unifiedWindows != null) {
      const entries = Object.entries(quotaObject(info.unifiedWindows));
      if (entries.length > 32) throw new QuotaReadError("invalid_response");
      for (const [key, value] of entries) if (Object.hasOwn(claudeWindows, key)) readings.push([key, quotaObject(value)]);
    }
    for (const [type, reading] of readings) {
      if (!type || !Object.hasOwn(claudeWindows, type)) continue;
      const utilization = reading.utilization == null ? undefined : number(reading.utilization, 1);
      const resetsAt = unixTime(reading.resetsAt);
      const windowAvailability = reading.status == null ? "unknown" : claudeAvailability(reading.status);
      // The experimental usage-report meter kinds are a different contract.
      // Do not guess an identity mapping or count both reports as separate quota pools.
      if (snapshot.pools.some(pool => pool.id === "claude-report")) snapshot.pools = [];
      const pool: QuotaPool = snapshot.pools.find(item => item.id === "claude") ?? { id: "claude", label: "Claude", sharing: "shared", availability: "unknown", windows: [], balances: [], constraints: [] };
      if (!snapshot.pools.includes(pool)) snapshot.pools.push(pool);
      const index = pool.windows.findIndex(window => window.id === type);
      const old = index >= 0 ? pool.windows[index] : undefined;
      const detail = claudeWindows[type];
      const common = { id: type, label: detail.label, ...(detail.periodSeconds ? { periodSeconds: detail.periodSeconds } : {}), ...(resetsAt ? { resetsAt } : {}), availability: windowAvailability };
      const window: QuotaWindow = utilization === undefined && old ? { ...old, ...common } : utilization === undefined ? { ...common, ...observed(now), metric: "unknown" } : { ...common, ...observed(now), metric: "percent", usedPercent: utilization * 100 };
      if (index < 0) pool.windows.push(window); else pool.windows[index] = window;
      pool.availability = availability(pool.windows.map(item => item.availability));
    }
    snapshot.availability = availability([snapshot.availability, ...snapshot.pools.map(pool => pool.availability)]);
    // Absence in a sparse event does not clear earlier independent constraints.
    if (info.overageDisabledReason != null) {
      const reason = quotaNativeIdentity(info.overageDisabledReason);
      snapshot.constraints = snapshot.constraints.filter(item => item.code !== "overage_disabled" && item.code !== "credits_depleted");
      snapshot.constraints.push({ code: reason === "out_of_credits" ? "credits_depleted" : "overage_disabled", availability: "blocked", ...(unixTime(info.overageResetsAt) ? { resetsAt: unixTime(info.overageResetsAt) } : {}) });
    }
    if (info.overageStatus != null) {
      const overage = claudeAvailability(info.overageStatus);
      if (overage === "allowed") snapshot.constraints = snapshot.constraints.filter(item => item.code !== "overage_disabled" && item.code !== "credits_depleted");
      else if (overage === "blocked" && !snapshot.constraints.some(item => item.code === "overage_disabled" || item.code === "credits_depleted")) snapshot.constraints.push({ code: "overage_disabled", availability: overage });
    }
  } else {
    const report = quotaObject(message.usage_report);
    if (report.rate_limits == null) return undefined;
    const rateLimits = quotaObject(report.rate_limits);
    if (rateLimits.limits == null) return undefined;
    if (!Array.isArray(rateLimits.limits) || rateLimits.limits.length > 32) throw new QuotaReadError("invalid_response");
    const windows: QuotaWindow[] = rateLimits.limits.map((entry, index) => {
      const row = quotaObject(entry);
      const kind = quotaNativeIdentity(row.kind);
      if (!kind || typeof row.is_active !== "boolean") throw new QuotaReadError("invalid_response");
      const resetsAt = isoTime(row.resets_at);
      return { id: `usage-${poolId(`${kind}:${index}`)}`, label: kind === "session" ? "Session" : kind === "weekly_all" ? "7 days" : `Usage ${index + 1}`, metric: "percent", usedPercent: number(row.percent, 100), availability: claudeAvailability(row.severity), ...observed(now), ...(resetsAt ? { resetsAt } : {}), ...(kind === "weekly_all" || kind === "weekly_scoped" ? { periodSeconds: 604800 } : {}) };
    });
    snapshot.pools = [{ id: "claude-report", label: "Claude", sharing: "shared", availability: availability(windows.map(window => window.availability)), windows, balances: [], constraints: [] }];
    // Extra-usage amounts are minor currency units, not generic credits. No balance is inferred here.
    snapshot.availability = snapshot.pools[0].availability;
  }
  snapshot.observedAt = new Date(now).toISOString();
  snapshot.lastAttemptAt = snapshot.observedAt;
  const numericWindows = snapshot.pools.flatMap(pool => pool.windows).filter(window => window.metric === "percent");
  snapshot.state = numericWindows.some(window => Date.parse(window.expiresAt) <= now) ? "stale" : "ready";
  delete snapshot.reason;
  return safeSnapshot(snapshot);
}

/** The reply to Claude Code's `get_usage` control request, asked of a Bot's own running engine: no prompt, no model call.
 * Observed on Claude Code 2.1.330 on 2026-11-22. A process on an API key answers `rate_limits_available: false`
 * with `rate_limits: null` (isolated probe). A subscription answers one entry per shared window, each `null`
 * (no such window running) or `{ utilization, resets_at }` with utilization already in percent, and
 * `model_scoped: [{ display_name, utilization, resets_at }]` for a model with its own weekly allowance (the
 * same reply lists it under `limits` as kind "weekly_scoped"). A model's window is its own pool naming that
 * model, so it counts only for a Bot on it. Everything else in the reply is ignored. */
export function parseClaudeUsage(value: unknown, now = Date.now()): QuotaSnapshot {
  const reply = quotaObject(value);
  if (reply.rate_limits_available !== true || reply.rate_limits == null) return unavailableQuota("claude", "mode_not_supported", now);
  const limits = quotaObject(reply.rate_limits), windows: QuotaWindow[] = [];
  const window = (id: string, detail: { label: string; periodSeconds?: number }, source: unknown): QuotaWindow | undefined => {
    const reading = quotaObject(source);
    if (reading.utilization == null) return undefined;
    const resetsAt = typeof reading.resets_at === "number" ? unixTime(reading.resets_at) : isoTime(reading.resets_at);
    return { id, label: detail.label, ...(detail.periodSeconds ? { periodSeconds: detail.periodSeconds } : {}), metric: "percent", usedPercent: number(reading.utilization, 100_000), availability: "unknown", ...observed(now), ...(resetsAt ? { resetsAt } : {}) };
  };
  for (const [id, detail] of Object.entries(claudeWindows)) {
    const reading = limits[id] == null ? undefined : window(id, detail, limits[id]);
    if (reading) windows.push(reading);
  }
  const pools: QuotaPool[] = windows.length ? [{ id: "claude", label: "Claude", sharing: "shared", availability: "unknown", windows, balances: [], constraints: [] }] : [];
  if (limits.model_scoped != null) {
    if (!Array.isArray(limits.model_scoped) || limits.model_scoped.length > 32) throw new QuotaReadError("invalid_response");
    for (const [index, entry] of limits.model_scoped.entries()) {
      const name = quotaNativeIdentity(quotaObject(entry).display_name);
      // Only a plain model name is kept as a label; anything else is skipped, not guessed.
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(name)) continue;
      const reading = window("seven_day", claudeWindows.seven_day, entry);
      if (reading) pools.push({ id: `claude-model-${poolId(`${name}:${index}`)}`, label: name, models: [name], sharing: "model", availability: "unknown", windows: [reading], balances: [], constraints: [] });
    }
  }
  const at = new Date(now).toISOString();
  return safeSnapshot({ authMode: "subscription", capability: { mode: "active" }, state: pools.length ? "ready" : "unknown", availability: "unknown", observedAt: at, lastAttemptAt: at, pools, constraints: [], help: "claude_usage" });
}

/** A running Claude process states its model, so which pools count for it is decided here: the shared ones, and
 * a model's own pool only when the process is on that model. A pool that counts no longer names models: the
 * reading then counts for the Bot whatever name its configuration uses for the model (or none, for the default). */
export function claudeQuotaForModel(snapshot: QuotaSnapshot, model: string | undefined): QuotaSnapshot {
  if (!model) return snapshot;
  const plain = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, ""), id = plain(model);
  const pools = snapshot.pools.flatMap((pool): QuotaPool[] => {
    if (!pool.models?.length) return [pool];
    if (!pool.models.some(name => plain(name) !== "" && id.includes(plain(name)))) return [];
    const { models: _models, ...rest } = pool;
    return [{ ...rest, sharing: "shared" }];
  });
  return { ...snapshot, pools, ...(!pools.length && snapshot.state === "ready" ? { state: "unknown" as const } : {}) };
}

/** Antigravity CLI only guarantees local zero-turn `/usage --output-format json` from 1.1.11 onward. */
export function isAntigravityQuotaSupportedVersion(versionOutput: string): boolean {
  const match = versionOutput.trim().match(/\bv?(\d+)\.(\d+)\.(\d+)(?:[-+][^\s]*)?\b/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return false;
  return major > 1 || (major === 1 && minor > 1) || (major === 1 && minor === 1 && patch >= 11);
}

const antigravityWindows: Record<string, { label: string; periodSeconds: number }> = {
  "5h": { label: "5 hours", periodSeconds: 18000 },
  weekly: { label: "7 days", periodSeconds: 604800 },
};

/** The models one usage group covers. agy 1.5.14 states them as "Models within this group: A, B" in the
 * group's description; a group without that sentence is named after its own model ("Gemini 4 Argon").
 * The names are those of `agy models` without the effort suffix. No other prose of the description is kept. */
function antigravityGroupModels(name: string, description: unknown): string[] {
  // Any other description (prose, several lines, not text) simply states no list; it never fails the reading.
  const listed = typeof description === "string" ? /^Models within this group:[ \t]*([^\x00-\x1f\x7f]+)$/.exec(description)?.[1]?.split(",").map(item => item.trim()).filter(Boolean) : undefined;
  return listed?.length && listed.length <= 32 && listed.every(item => item.length <= 120) ? listed : [name];
}

const plainName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const ANTIGRAVITY_EFFORT_WORDS = ["low", "medium", "high", "xhigh", "max", "ultra"];
/** `/usage` names a group's models by their `agy models` display name ("Orchestrator (Neon)"), while a Bot stores
 * the model id ("gemini-pro-orchestrator-neon"); not every id spells its display name. Add the ids whose display
 * name is one of the group's names, with or without an effort word, so a reading can be matched to the Bot (#205). */
export function withAntigravityModelIds(snapshot: QuotaSnapshot, catalog: readonly { id: string; label?: string }[]): QuotaSnapshot {
  if (!catalog.length) return snapshot;
  const pools = snapshot.pools.map(pool => {
    if (!pool.models?.length) return pool;
    const names = pool.models.map(plainName).filter(Boolean);
    const ids = catalog.filter(model => {
      const label = model.label ? plainName(model.label) : "";
      return label !== "" && names.some(name => label === name || ANTIGRAVITY_EFFORT_WORDS.some(word => label === name + word));
    }).map(model => model.id);
    const models = [...new Set([...pool.models, ...ids])].slice(0, 32);
    return models.length === pool.models.length ? pool : { ...pool, models };
  });
  return { ...snapshot, pools };
}

/** Parses `agy -p /usage --output-format json`. Requires `num_turns === 0` so a model turn is never accepted as quota. */
export function parseAntigravityQuota(value: unknown, now = Date.now()): QuotaSnapshot {
  const reply = quotaObject(value);
  if (reply.num_turns !== 0 || reply.status !== "SUCCESS") throw new QuotaReadError("invalid_response");
  const command = quotaObject(reply.command);
  if (command.name !== "usage") throw new QuotaReadError("invalid_response");
  const data = quotaObject(command.data);
  if (!Array.isArray(data.groups) || data.groups.length > 64) throw new QuotaReadError("invalid_response");
  const pools = data.groups.map((entry, index): QuotaPool => {
    const group = quotaObject(entry);
    const name = quotaNativeIdentity(group.name);
    if (!name || name.length > 120) throw new QuotaReadError("invalid_response");
    if (!Array.isArray(group.buckets) || group.buckets.length > 32) throw new QuotaReadError("invalid_response");
    const windows: QuotaWindow[] = group.buckets.map((rawBucket, bucketIndex): QuotaWindow => {
      const bucket = quotaObject(rawBucket);
      const rawId = quotaNativeIdentity(bucket.id);
      if (!rawId) throw new QuotaReadError("invalid_response");
      const id = /^[a-zA-Z0-9_.:-]{1,128}$/.test(rawId) ? rawId : poolId(`${rawId}:${bucketIndex}`);
      const windowKind = bucket.window == null ? undefined : quotaNativeIdentity(bucket.window);
      const rawBucketName = bucket.name == null ? undefined : quotaNativeIdentity(bucket.name);
      const known = windowKind && Object.hasOwn(antigravityWindows, windowKind) ? antigravityWindows[windowKind] : undefined;
      const label = known?.label ?? (rawBucketName && rawBucketName.length <= 120 ? rawBucketName : `Window ${bucketIndex + 1}`);
      const resetsAt = isoTime(bucket.reset_time);
      const common = {
        id,
        label,
        availability: "unknown" as const,
        ...observed(now),
        ...(known ? { periodSeconds: known.periodSeconds } : {}),
        ...(resetsAt ? { resetsAt } : {}),
      };
      if (bucket.remaining_fraction == null) return { ...common, metric: "unknown" };
      const remaining = number(bucket.remaining_fraction, 1);
      const usedPercent = Math.round((1 - remaining) * 10000) / 100;
      return { ...common, metric: "percent", usedPercent };
    });
    return {
      id: poolId(`${name}:${index}`),
      label: name,
      models: antigravityGroupModels(name, group.description),
      sharing: "model",
      availability: "unknown",
      windows,
      balances: [],
      constraints: [],
    };
  });
  const hasData = pools.some(pool => pool.windows.length > 0);
  return safeSnapshot({
    authMode: "subscription",
    capability: { mode: "active" },
    state: hasData ? "ready" : "unknown",
    availability: "unknown",
    observedAt: new Date(now).toISOString(),
    lastAttemptAt: new Date(now).toISOString(),
    pools,
    constraints: [],
    help: "antigravity_usage",
  });
}
