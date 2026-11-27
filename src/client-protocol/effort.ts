import { z } from "zod";

export const effortValueSchema = z.enum(["", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
export const effortSettingsSchema = z.object({
  scope: z.literal("bot"), revision: z.string().regex(/^[a-f0-9]{64}$/),
  engine: z.enum(["codex", "claude", "kimi", "deepseek", "antigravity", "pi", "omp"]),
  model: z.string(), effort: effortValueSchema, choices: z.array(effortValueSchema),
  activeTurns: z.number().int().nonnegative(),
  catalogStatus: z.enum(["ready", "no-models", "unavailable"]).optional(),
}).strict();
export const effortPatchSchema = z.object({ revision: effortSettingsSchema.shape.revision, effort: effortValueSchema }).strict();
export const effortErrorSchema = z.enum(["effort_conflict", "effort_incompatible", "effort_config_unreadable", "effort_engine_changed", "effort_catalog_unavailable", "effort_model_unavailable"]);
export const effortResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), settings: effortSettingsSchema }),
  z.object({ ok: z.literal(false), error: effortErrorSchema }),
]);
export type EffortSettings = z.infer<typeof effortSettingsSchema>;
