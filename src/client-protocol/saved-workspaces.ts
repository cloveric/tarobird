import { z } from "zod";

const workspaceIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

export const SAVED_WORKSPACES_CAPABILITY = "workspaces.saved.v1" as const;

export const savedWorkspaceSchema = z.object({
  id: workspaceIdSchema,
  name: z.string().min(1).max(128),
  path: z.string().min(1).max(4096),
  exists: z.boolean().optional(),
  createdAt: z.number().int(),
  lastUsedAt: z.number().int(),
}).strict();
export type SavedWorkspace = z.infer<typeof savedWorkspaceSchema>;

export const savedWorkspaceListSchema = z.object({
  items: z.array(savedWorkspaceSchema),
}).strict();
export type SavedWorkspaceList = z.infer<typeof savedWorkspaceListSchema>;

export const addSavedWorkspaceSchema = z.object({
  path: z.string().trim().min(1).max(4096),
  name: z.string().trim().max(128).optional(),
}).strict();
export type AddSavedWorkspaceInput = z.infer<typeof addSavedWorkspaceSchema>;

export const addSavedWorkspaceResultSchema = z.object({
  workspace: savedWorkspaceSchema,
  items: z.array(savedWorkspaceSchema),
}).strict();

export const workspaceBrowseEntrySchema = z.object({
  name: z.string().min(1).max(256),
  path: z.string().min(1).max(4096),
}).strict();
export type WorkspaceBrowseEntry = z.infer<typeof workspaceBrowseEntrySchema>;

export const workspaceBrowseSchema = z.object({
  path: z.string().min(1).max(4096),
  parent: z.string().min(1).max(4096).nullable(),
  home: z.string().min(1).max(4096),
  entries: z.array(workspaceBrowseEntrySchema),
}).strict();
export type WorkspaceBrowseResult = z.infer<typeof workspaceBrowseSchema>;

export const botWorkspaceSettingsSchema = z.object({
  scope: z.literal("bot"),
  revision: z.string().min(1).max(128),
  workspacePath: z.string().max(4096),
  defaultWorkspacePath: z.string().max(4096),
  activeTurns: z.number().int().nonnegative(),
}).strict();
export type BotWorkspaceSettings = z.infer<typeof botWorkspaceSettingsSchema>;

export const botWorkspacePatchSchema = z.object({
  revision: z.string().min(1).max(128),
  workspacePath: z.string().max(4096),
}).strict();
export type BotWorkspacePatch = z.infer<typeof botWorkspacePatchSchema>;

export const botWorkspaceErrorSchema = z.enum([
  "workspace_conflict",
  "workspace_unavailable",
  "workspace_config_unreadable",
]);
export type BotWorkspaceError = z.infer<typeof botWorkspaceErrorSchema>;

export const botWorkspaceResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), settings: botWorkspaceSettingsSchema }).strict(),
  z.object({ ok: z.literal(false), error: botWorkspaceErrorSchema }).strict(),
]);
export type BotWorkspaceResult = z.infer<typeof botWorkspaceResultSchema>;

/** Short readable folder name for headers and chips; keeps root paths intact. */
export function workspaceDisplayName(workspacePath: string | undefined): string {
  const trimmed = workspacePath?.trim() ?? "";
  if (!trimmed) return "";
  const stripped = trimmed.replace(/[\\/]+$/u, "");
  if (!stripped) return trimmed[0] ?? "/";
  if (/^[A-Za-z]:$/u.test(stripped)) return `${stripped}\\`;
  const parts = stripped.split(/[\\/]+/u).filter(Boolean);
  return parts[parts.length - 1] ?? stripped;
}
