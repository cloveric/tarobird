import { z } from "zod";
import { idSchema } from "./index.js";

export const scheduleTimingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cron"), expression: z.string().trim().min(1).max(120) }).strict(),
  z.object({ kind: z.literal("once"), at: z.string().trim().min(1).max(120) }).strict(),
]);
export const scheduleSettingsSchema = z.object({
  title: z.string().trim().min(1).max(200), prompt: z.string().trim().min(1).max(4000),
  timezone: z.string().trim().min(1).max(100), timing: scheduleTimingSchema,
  sessionMode: z.enum(["new_per_run", "reuse"]),
}).strict();
const base = { requestId: idSchema, conversationId: idSchema };
const existing = { ...base, id: z.string().regex(/^[a-f0-9]{8}$/), expectedUpdatedAt: z.string().datetime() };
export const scheduleMutationSchema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("create"), settings: scheduleSettingsSchema }).strict(),
  z.object({ ...existing, action: z.literal("update"), settings: scheduleSettingsSchema }).strict(),
  z.object({ ...existing, action: z.literal("enabled"), enabled: z.boolean() }).strict(),
  z.object({ ...existing, action: z.literal("remove") }).strict(),
]);
export const scheduledTaskSchema = scheduleSettingsSchema.extend({
  // Legacy stores allow one-shot jobs without targetAt. Keep those visible for
  // repair/removal; the mutation schema above still requires a nonempty time.
  timing: z.union([scheduleTimingSchema, z.object({ kind: z.literal("once"), at: z.literal("") }).strict()]),
  validationError: z.literal("missing_run_time").optional(),
  id: z.string(), conversationId: idSchema, enabled: z.boolean(), updatedAt: z.string(),
  nextRunAt: z.string().nullable(), lastRunAt: z.string().nullable(), lastError: z.string().nullable(),
  deliveryMode: z.enum(["agent", "notify"]),
});
export const scheduledTasksSchema = z.object({ jobs: z.array(scheduledTaskSchema), schedulerAvailable: z.boolean() });
export const scheduleResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.enum(["invalid_schedule", "schedule_conflict", "schedule_not_found", "scheduler_unavailable", "operation_uncertain"]) }),
]);
export type ScheduleSettings = z.infer<typeof scheduleSettingsSchema>;
export type ScheduleMutation = z.infer<typeof scheduleMutationSchema>;
export type ScheduledTask = z.infer<typeof scheduledTaskSchema>;
