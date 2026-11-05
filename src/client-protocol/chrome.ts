import { z } from "zod";

export const chromeSettingsSchema = z.object({
  scope: z.literal("bot"), engine: z.literal("claude"),
  revision: z.string().regex(/^[a-f0-9]{64}$/), enabled: z.boolean(),
  activeTurns: z.number().int().nonnegative(),
}).strict();
export const chromePatchSchema = z.object({ revision: chromeSettingsSchema.shape.revision, enabled: z.boolean() }).strict();
export const chromeErrorSchema = z.enum(["chrome_conflict", "chrome_unsupported", "chrome_config_unreadable", "chrome_engine_changed"]);
export const chromeResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), settings: chromeSettingsSchema }),
  z.object({ ok: z.literal(false), error: chromeErrorSchema }),
]);
export type ChromeSettings = z.infer<typeof chromeSettingsSchema>;
export type ChromePatch = z.infer<typeof chromePatchSchema>;
