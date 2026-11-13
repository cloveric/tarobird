import { z } from "zod";
import { idSchema } from "./index.js";

export const ENGINE_SETTINGS_CAPABILITY = "engines.settings.v1";
export const hostEngineSchema = z.enum(["codex", "claude", "antigravity", "kimi", "deepseek"]);
export type HostEngine = z.infer<typeof hostEngineSchema>;
export const enginePathSchema = z.string().min(1).max(4096).refine(value => !/[\x00-\x1f\x7f]/.test(value));
export const engineSettingsUpdateSchema = z.object({
  requestId: idSchema, revision: z.string().min(1).max(100), engine: hostEngineSchema, path: enginePathSchema.nullable(),
}).strict();
export type EngineSettingsUpdate = z.infer<typeof engineSettingsUpdateSchema>;
export const engineSettingsSchema = z.object({
  revision: z.string(), platform: z.string(), searchPaths: z.array(z.string()),
  receipt: z.object({ requestId: z.string(), revision: z.string() }).nullable(),
  engines: z.array(z.object({ id: hostEngineSchema, override: z.string().nullable(), source: z.enum(["setting", "environment", "auto"]), command: z.string(), executable: z.string().nullable(), available: z.boolean() })),
});
export type EngineSettingsState = z.infer<typeof engineSettingsSchema>;
