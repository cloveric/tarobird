import { z } from "zod";
import { idSchema } from "./index.js";

export const WORKSPACE_DIFF_CAPABILITY = "workspace.diff.v1";
export const WORKSPACE_DIFF_MAX_FILES = 200;
export const WORKSPACE_DIFF_MAX_BYTES = 200 * 1024;
export const WORKSPACE_DIFF_MAX_LINES = 1000;
export const WORKSPACE_DIFF_PREVIEW_LINES = 200;
export const WORKSPACE_DIFF_LINE_CHARS = 4096;

/** Portable literal paths; callers must additionally enforce filesystem identity. */
export const workspaceDiffPathSchema = z.string().min(1).max(4096).refine(value => {
  if (/^[\\/]|[\\:\x00-\x1f\x7f]/.test(value)) return false;
  return value.split("/").every(part => !!part && part !== "." && part !== ".." && !/^\.git$/i.test(part) && !/[. ]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}, "Invalid workspace path");
export const workspaceChangesQuerySchema = z.object({ botId: idSchema }).strict();
export const workspaceFileDiffQuerySchema = workspaceChangesQuerySchema.extend({
  path: workspaceDiffPathSchema, preview: z.literal("1").optional(),
}).strict();

export const workspaceDiffNoteSchema = z.enum([
  "global_config_ignored", "submodules_ignored", "file_limit", "status_limit", "counts_unavailable",
  "no_head", "conflicts", "binary", "too_large", "preview_prefix", "preview_patch", "index_removed_worktree", "nested_repository", "long_lines", "protected",
  "unsafe_git_config", "partial_clone", "not_repository", "git_unavailable", "workspace_unavailable",
  "external_git_metadata", "repository_root_unsafe", "git_metadata_limit",
  "git_failed", "ownership", "path_unavailable", "changed_during_read", "index_only", "mode_only", "unsupported_encoding",
]);
export type WorkspaceDiffNote = z.infer<typeof workspaceDiffNoteSchema>;
const countSchema = z.number().int().nonnegative().safe().nullable();
export const workspaceChangeSchema = z.object({
  path: workspaceDiffPathSchema,
  status: z.enum(["added", "modified", "deleted", "untracked", "conflicted", "type_changed"]),
  staged: z.boolean(), unstaged: z.boolean(), generated: z.boolean(),
  kind: z.enum(["file", "missing", "symlink", "submodule", "other"]), protected: z.boolean(),
  additions: countSchema, deletions: countSchema,
}).strict();
export type WorkspaceChange = z.infer<typeof workspaceChangeSchema>;
const scopeShape = {
  scope: z.literal("current_workspace"), conversationId: idSchema, botId: idSchema,
  head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable(), capturedAt: z.number().int().nonnegative().safe(),
  state: z.enum(["ready", "not_repository", "no_head", "git_unavailable", "workspace_unavailable", "unsafe_repository", "git_error"]),
  notes: z.array(workspaceDiffNoteSchema).max(24),
};
export const workspaceChangesSchema = z.object({ ...scopeShape,
  items: z.array(workspaceChangeSchema).max(WORKSPACE_DIFF_MAX_FILES), truncated: z.boolean(),
}).strict();
export type WorkspaceChanges = z.infer<typeof workspaceChangesSchema>;
export const workspaceDiffLineSchema = z.object({
  kind: z.enum(["context", "add", "delete", "meta"]), text: z.string().max(WORKSPACE_DIFF_LINE_CHARS),
  oldLine: z.number().int().positive().nullable(), newLine: z.number().int().positive().nullable(), clipped: z.boolean(),
}).strict();
export type WorkspaceDiffLine = z.infer<typeof workspaceDiffLineSchema>;
export const workspaceDiffHunkSchema = z.object({
  header: z.string().max(WORKSPACE_DIFF_LINE_CHARS), oldStart: z.number().int().nonnegative(), oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(), newLines: z.number().int().nonnegative(),
  lines: z.array(workspaceDiffLineSchema).max(WORKSPACE_DIFF_MAX_LINES),
}).strict();
export type WorkspaceDiffHunk = z.infer<typeof workspaceDiffHunkSchema>;
export const workspaceFileDiffSchema = z.object({ ...scopeShape,
  file: workspaceChangeSchema, binary: z.boolean(), metadataOnly: z.boolean(),
  reason: z.enum(["binary", "too_large", "symlink", "submodule", "conflict", "protected", "unavailable"]).nullable(),
  truncated: z.boolean(), preview: z.boolean(), additions: countSchema, deletions: countSchema,
  hunks: z.array(workspaceDiffHunkSchema).max(WORKSPACE_DIFF_MAX_LINES),
}).strict().refine(value => value.hunks.reduce((count, hunk) => count + 1 + hunk.lines.length, 0) <= WORKSPACE_DIFF_MAX_LINES, "Too many diff rows");
export type WorkspaceFileDiff = z.infer<typeof workspaceFileDiffSchema>;
