// The quota reply schemas exactly as the released 1.6.0 App and CLI parse them: lines 12 to 61 of
// src/client-protocol/engine-quota.ts at the tag v1.6.0, copied unchanged. They are closed (`.strict()`, one
// balance kind), so a test that parses a Hub reply with them shows what a 1.6.0 client accepts.
// Do not update this file when the live schema changes.
import { z } from "zod";

const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const label = z.string().min(1).max(120).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const timestamp = z.string().datetime({ offset: true });
export const quotaEngineSchema = z.enum(["codex", "claude", "antigravity", "kimi", "deepseek", "pi"]);
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
// Only native credit balances are currently implemented. They are not currency or token estimates.
export const quotaBalanceSchema = z.object({
  id: identifier, kind: z.literal("credits"), amount: z.string().max(80).regex(/^\d+(?:\.\d+)?$/).nullable(),
  unit: z.literal("credits"), observedAt: timestamp, expiresAt: timestamp, unlimited: z.boolean().optional(),
}).strict();
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
  // Every Gateway and the Hub send "unverified": no reader proves that two Bots share an account, and the App
  // never adds readings together. "verified" is accepted only so the schema need not change if one ever does.
  botIds: z.array(identifier).max(1000), sharing: z.enum(["verified", "unverified"]),
}).strict();
export const quotaDirectorySchema = z.object({ generatedAt: timestamp, scopes: z.array(quotaScopeSchema).max(256), truncated: z.boolean().optional() }).strict();
