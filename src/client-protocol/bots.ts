import { permissionChoiceSchema } from "./permissions.js";
import type { PermissionChoice, PermissionOption } from "../state/permission-options.js";
import { z } from "zod";
import { EFFORT_LEVELS } from "../state/config-file-schema.js";
import { idSchema } from "./index.js";
import { botRoleSchema, dispatcherSettingsSchema } from "./dispatch.js";

// Shared HTTP contract. Keep host process, database and filesystem imports out
// of this module so clients can build with only their own dependencies.
export const createBotSchema = z.object({
  requestId: idSchema,
  name: z.string().trim().min(1).max(100),
  engine: z.enum(["codex", "claude", "kimi", "deepseek", "antigravity"]),
  model: z.string().trim().max(128),
  effort: z.enum(["", ...EFFORT_LEVELS]),
  permission: permissionChoiceSchema.optional(),
  workspace: z.string().trim().max(4096).default(""),
  // Optional and omitted for ordinary Bots: the stored specification of an
  // existing Bot must stay byte-identical for idempotent retries.
  role: botRoleSchema.optional(),
  dispatcher: dispatcherSettingsSchema.optional(),
}).strict().refine(input => !input.dispatcher || input.role === "dispatcher", { message: "dispatcher_settings_require_role", path: ["dispatcher"] });

export type CreateBotInput = z.infer<typeof createBotSchema>;
// Read legacy CLI-registered names verbatim so the compare-and-set baseline is
// exact; newly saved names use the same limits as Bot creation.
export const botNameSchema = z.object({ name: z.string() }).strict();
export const renameBotSchema = z.object({ name: z.string().trim().min(1).max(100) }).extend({ expectedName: z.string() }).strict();
export type RenameBotInput = z.infer<typeof renameBotSchema>;
export type BotCatalog = {
  engines: {
    id: CreateBotInput["engine"];
    available: boolean;
    models: { id: string; label?: string; efforts: string[] }[];
    defaultModel: string;
    defaultEffort: string;
    permissions?: { defaultChoice: PermissionChoice; choices: PermissionOption[] };
  }[];
};

/** The confirmation is bound to the name the owner actually reviewed. */
export const deleteBotSchema = z.object({ expectedName: z.string().min(1), confirm: z.literal(true) }).strict();
export type DeleteBotInput = z.infer<typeof deleteBotSchema>;
