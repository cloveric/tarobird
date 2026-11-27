import { z } from "zod";

export const ENGINE_QUOTA_CAPABILITY = "engines.quota.v1";
/** Additive Host capability: clients pass `?balances=currency` to receive non-`credits` currency
 * balances; `engines.quota.v1` callers without it receive only `credits` balances so v1.6.0 clients
 * with `z.literal("credits")` never fail schema parsing. The query parameter is the only negotiation:
 * the App's native transports refuse any request header outside their short allow-list. */
export const ENGINE_QUOTA_CURRENCY_CAPABILITY = "engines.quota.currency.v1";
export const ENGINE_QUOTA_TTL_MS = 60_000;
/** How long one explicit refresh may take inside an engine. Antigravity's `agy -p /usage` took 4 to 8 seconds
 * when measured (2026-11-22); Codex and Claude Code keep their own shorter limits. The Gateway and the Hub wait
 * a little longer than this, so the engine's own answer ("timeout" included) is the one that comes back. */
export const ENGINE_QUOTA_REFRESH_MS = 15_000;
/** The Hub's wait for one refresh: the engine's limit, the up to 2 s a reader then takes to stop its process, and a
 * margin. The App's Settings page waits longer still, so the Hub's answer is the one it shows. */
export const ENGINE_QUOTA_HUB_REFRESH_MS = ENGINE_QUOTA_REFRESH_MS + 3_000;
const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const label = z.string().min(1).max(120).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const timestamp = z.string().datetime({ offset: true });
export const quotaEngineSchema = z.enum(["codex", "claude", "antigravity", "kimi", "deepseek", "pi", "omp"]);
export const quotaStateSchema = z.enum(["ready", "stale", "unknown", "login_required", "offline", "unavailable", "unsupported"]);
export const quotaAvailabilitySchema = z.enum(["allowed", "warning", "blocked", "unknown"]);
export const quotaReasonSchema = z.enum([
  "not_adapted", "not_loaded", "native_unverified", "mode_not_supported", "no_passive_event", "login_required",
  "auth_changed", "scope_unverifiable", "offline", "timeout", "cancelled", "rate_limited",
  "invalid_response", "cli_unavailable", "native_error", "host_upgrade_required",
]);
export const quotaAuthModeSchema = z.enum(["subscription", "api_key", "adc", "other", "unknown"]);
export const quotaHelpSchema = z.enum(["codex_usage", "claude_usage", "gemini_api_usage", "antigravity_usage", "kimi_usage", "deepseek_balance"]);
const windowFields = {
  id: identifier, label, observedAt: timestamp, expiresAt: timestamp,
  periodSeconds: z.number().int().positive().max(366 * 86400).optional(), resetsAt: timestamp.optional(),
  availability: quotaAvailabilitySchema,
};
export const quotaWindowSchema = z.discriminatedUnion("metric", [
  z.object({ ...windowFields, metric: z.literal("percent"), usedPercent: z.number().finite().min(0).max(2147483647) }).strict(),
  z.object({ ...windowFields, metric: z.literal("unknown") }).strict(),
]);
// Native credit balances, and currency balances (a top-up pack, a wallet). They are not token estimates.
// A "credits" balance keeps the unit it has always had; only a "currency" balance names its own.
const balanceFields = {
  id: identifier, amount: z.string().max(80).regex(/^\d+(?:\.\d+)?$/).nullable(),
  observedAt: timestamp, expiresAt: timestamp, unlimited: z.boolean().optional(),
};
export const quotaBalanceSchema = z.discriminatedUnion("kind", [
  z.object({ ...balanceFields, kind: z.literal("credits"), unit: z.literal("credits") }).strict(),
  z.object({ ...balanceFields, kind: z.literal("currency"), unit: z.string().min(1).max(16).regex(/^[A-Za-z0-9._-]+$/) }).strict(),
]);
export const quotaConstraintSchema = z.object({
  code: z.enum(["ordinary_usage_blocked", "spend_control", "credits_depleted", "overage_disabled", "other_native_limit"]),
  availability: quotaAvailabilitySchema, resetsAt: timestamp.optional(),
}).strict();
export const quotaPoolSchema = z.object({
  id: identifier, label, models: z.array(label).max(32).optional(), sharing: z.enum(["shared", "model", "unspecified"]),
  availability: quotaAvailabilitySchema, windows: z.array(quotaWindowSchema).max(32),
  balances: z.array(quotaBalanceSchema).max(16), constraints: z.array(quotaConstraintSchema).max(16),
}).strict();
export const quotaSnapshotSchema = z.object({
  authMode: quotaAuthModeSchema,
  capability: z.object({ mode: z.enum(["active", "passive", "unsupported"]), reason: quotaReasonSchema.optional() }).strict(),
  state: quotaStateSchema, reason: quotaReasonSchema.optional(), availability: quotaAvailabilitySchema,
  observedAt: timestamp.optional(), lastAttemptAt: timestamp.optional(), nextRefreshAt: timestamp.optional(),
  pools: z.array(quotaPoolSchema).max(64), constraints: z.array(quotaConstraintSchema).max(16), help: quotaHelpSchema.optional(),
}).strict();
export const quotaScopeSchema = quotaSnapshotSchema.extend({
  id: identifier, revision: identifier, engine: quotaEngineSchema, label,
  // Gateways send "unverified". The Hub sets "verified" with the canonical sorted member botIds only when
  // Host-private native account proofs confirm membership; raw account identifiers and proofs never enter this DTO.
  botIds: z.array(identifier).max(1000), sharing: z.enum(["verified", "unverified"]),
}).strict();
export const quotaDirectorySchema = z.object({ generatedAt: timestamp, scopes: z.array(quotaScopeSchema).max(256), truncated: z.boolean().optional() }).strict();
export const nativeQuotaRequestSchema = z.object({ scopeId: identifier, expectedRevision: identifier.optional(), refresh: z.boolean() }).strict();
export const nativeQuotaReplySchema = z.object({ scopeId: identifier, revision: identifier, value: quotaScopeSchema }).strict();

export type QuotaEngine = z.infer<typeof quotaEngineSchema>;
export type QuotaState = z.infer<typeof quotaStateSchema>;
export type QuotaAvailability = z.infer<typeof quotaAvailabilitySchema>;
export type QuotaReason = z.infer<typeof quotaReasonSchema>;
export type QuotaAuthMode = z.infer<typeof quotaAuthModeSchema>;
export type QuotaWindow = z.infer<typeof quotaWindowSchema>;
export type QuotaBalance = z.infer<typeof quotaBalanceSchema>;
export type QuotaConstraint = z.infer<typeof quotaConstraintSchema>;
export type QuotaPool = z.infer<typeof quotaPoolSchema>;
export type QuotaSnapshot = z.infer<typeof quotaSnapshotSchema>;
export type QuotaScope = z.infer<typeof quotaScopeSchema>;
export type QuotaDirectory = z.infer<typeof quotaDirectorySchema>;
export type NativeQuotaRequest = z.infer<typeof nativeQuotaRequestSchema>;
export type NativeQuotaReply = z.infer<typeof nativeQuotaReplySchema>;

/** The single "no longer current" rule shared by Gateway, CLI output and the App.
 * A reading expires with its own TTL, any window/balance expiry, or any reported
 * reset time, including independent constraints. Expiry never manufactures a refill. */
export function quotaReadingExpired(snapshot: Pick<QuotaSnapshot, "observedAt" | "pools" | "constraints">, now: number): boolean {
  const past = (value: string | undefined) => !!value && Date.parse(value) <= now;
  if (snapshot.observedAt && Date.parse(snapshot.observedAt) + ENGINE_QUOTA_TTL_MS <= now) return true;
  if ([...snapshot.constraints, ...snapshot.pools.flatMap(pool => pool.constraints)].some(value => past(value.resetsAt))) return true;
  return snapshot.pools.some(pool => [...pool.windows, ...pool.balances].some(value => past(value.expiresAt) || "resetsAt" in value && past(value.resetsAt)));
}

/** Project a quota scope for v1-only clients (`engines.quota.v1`) that reject
 * `kind: "currency"` balances in strict schema validation. Only `credits` balances are kept (the one kind a
 * v1.6.0 client knows); a pool left with nothing is dropped, and a reading left with nothing is "unknown". */
export function projectQuotaScopeForClient(scope: QuotaScope, options: { currencyBalances: boolean }): QuotaScope {
  if (options.currencyBalances) return scope;
  let strippedCurrency = false;
  const pools: QuotaPool[] = [];
  for (const pool of scope.pools) {
    const hadCurrency = pool.balances.some(balance => balance.kind !== "credits");
    if (!hadCurrency) {
      pools.push(pool);
      continue;
    }
    strippedCurrency = true;
    const balances = pool.balances.filter(balance => balance.kind === "credits");
    if (pool.windows.length > 0 || balances.length > 0 || pool.constraints.length > 0) {
      pools.push({ ...pool, balances });
    }
  }
  if (!strippedCurrency) return scope;
  if (pools.length === 0 && scope.constraints.length === 0 && scope.availability === "unknown"
    && (scope.state === "ready" || scope.state === "stale")) {
    const { observedAt: _observedAt, ...rest } = scope;
    return { ...rest, state: "unknown", pools };
  }
  return { ...scope, pools };
}
