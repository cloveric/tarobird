import { z } from "zod";

const count = z.number().int().nonnegative();
const text = z.string();
const nullableText = text.nullable();
export const dashboardUsageBucketSchema = z.object({
  totalInputTokens: count, totalOutputTokens: count, totalCachedTokens: count,
  totalCostUsd: z.number().nonnegative(), requestCount: count, unmeteredRequestCount: count,
  lastUpdatedAt: text,
});
export type DashboardUsageBucket = z.infer<typeof dashboardUsageBucketSchema>;
const liveSchema = z.object({
  sampledAt: z.iso.datetime(), activeCount: count,
  active: z.array(z.object({ conversation: text, startedAt: nullableText })),
  queued: count, approvals: count, choices: count, batches: count, schedulerAvailable: z.boolean(),
});
export type DashboardLive = z.infer<typeof liveSchema>;
export const botDashboardSchema = z.object({
  generatedAt: z.iso.datetime(), live: liveSchema.nullable(),
  config: z.object({ engine: nullableText, model: nullableText, effort: nullableText, approvalMode: nullableText, permissionLabel: z.string().optional(), budgetUsd: z.number().positive().nullable() }).nullable(),
  sessions: count.nullable(),
  usage: z.object({ source: z.enum(["current", "last-good"]), total: dashboardUsageBucketSchema,
    daily: z.record(text, dashboardUsageBucketSchema), monthly: z.record(text, dashboardUsageBucketSchema) }).nullable(),
  cron: z.array(z.object({
    id: text, title: text, channel: text, conversation: text, kind: z.enum(["once", "recurring"]), enabled: z.boolean(),
    schedule: text, timezone: nullableText, nextRunAt: nullableText, lastRunAt: nullableText, lastSuccessAt: nullableText,
    lastError: nullableText, failureCount: count, maxFailures: count, prompt: text,
    sessionMode: text, deliveryMode: text, mute: z.boolean(), silent: z.boolean(), timeoutMins: count,
    history: z.array(z.object({ ranAt: text, success: z.boolean(), error: nullableText })),
  })).nullable(),
  crew: z.object({
    runId: text, workflow: text, status: text, currentStage: text, coordinator: text,
    chatId: text, prompt: text, updatedAt: text, lastError: nullableText,
    stages: z.array(z.object({ stage: text, status: text, updatedAt: text, detail: nullableText, verdict: nullableText, revisionCount: count.nullable() })),
  }).nullable(),
  warnings: z.array(text),
});
export type BotDashboard = z.infer<typeof botDashboardSchema>;
