import { z } from "zod";
import { PERMISSION_CHOICES } from "../state/permission-options.js";
export const permissionChoiceSchema = z.enum(PERMISSION_CHOICES);
export const permissionOptionSchema = z.object({ id: permissionChoiceSchema, label: z.string(), description: z.string() }).strict();
export const permissionSettingsSchema = z.object({
  scope: z.literal("bot"), revision: z.string().regex(/^[a-f0-9]{64}$/),
  engine: z.enum(["codex", "claude", "kimi", "deepseek", "antigravity"]),
  choice: permissionChoiceSchema, defaultChoice: permissionChoiceSchema,
  choices: z.array(permissionOptionSchema), activeTurns: z.number().int().nonnegative(),
}).strict();
export const permissionPatchSchema = z.object({ revision: permissionSettingsSchema.shape.revision, choice: permissionChoiceSchema }).strict();
export const permissionErrorSchema = z.enum(["permissions_conflict", "permissions_incompatible", "permissions_config_unreadable", "permissions_engine_changed", "permissions_busy"]);
export const permissionResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), settings: permissionSettingsSchema }),
  z.object({ ok: z.literal(false), error: permissionErrorSchema }),
]);
export type PermissionSettings = z.infer<typeof permissionSettingsSchema>;
