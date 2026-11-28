import { z } from "zod";

const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

export const WORKSPACE_FILES_CAPABILITY = "workspace.files.v1";
/** The Host can return the workspace root as a home-relative display path ("~/projects/app") when asked with `display=1`. */
export const WORKSPACE_FILES_DISPLAY_PATH_CAPABILITY = "workspace.files.display-path.v1";
export const WORKSPACE_FILES_MAX_ENTRIES = 500;
export const WORKSPACE_FILES_MAX_TEXT_BYTES = 512 * 1024;
export const WORKSPACE_FILES_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const WORKSPACE_FILES_MAX_PDF_BYTES = 10 * 1024 * 1024;

export const workspaceFilePathSchema = z.string().max(4096).refine((value) => {
  if (value === "") return true;
  if (/^[\\/]|[\\:\x00-\x1f\x7f]/.test(value)) return false;
  return value.split("/").every((part) => Boolean(part) && part !== "." && part !== "..");
}, "Invalid workspace file path");

export const workspaceRequiredPathSchema = workspaceFilePathSchema.refine((value) => value.length > 0, "Workspace file path required");

export const workspaceTreeQuerySchema = z.object({
  botId: idSchema,
  path: workspaceFilePathSchema.default(""),
  changes: z.enum(["0", "1"]).optional(),
  // Only sent to Hosts that advertise WORKSPACE_FILES_DISPLAY_PATH_CAPABILITY.
  display: z.enum(["1"]).optional(),
}).strict();

export const workspacePreviewQuerySchema = z.object({
  botId: idSchema,
  path: workspaceRequiredPathSchema,
  reveal: z.enum(["0", "1"]).optional(),
}).strict();

export const workspaceChangeBadgeSchema = z.enum(["added", "modified", "deleted", "untracked", "conflicted", "type_changed"]);
export type WorkspaceChangeBadge = z.infer<typeof workspaceChangeBadgeSchema>;

export const workspaceFileEntrySchema = z.object({
  name: z.string().min(1).max(512),
  path: workspaceRequiredPathSchema,
  kind: z.enum(["dir", "file", "symlink"]),
  size: z.number().int().nonnegative().safe().nullable(),
  mtimeMs: z.number().int().nonnegative().safe().nullable(),
  sensitive: z.boolean(),
  heavy: z.boolean(),
  changed: workspaceChangeBadgeSchema.optional(),
  hasChangedChildren: z.boolean().optional(),
}).strict();
export type WorkspaceFileEntry = z.infer<typeof workspaceFileEntrySchema>;

export const workspaceTreeResponseSchema = z.object({
  workspaceName: z.string().min(1).max(256),
  path: workspaceFilePathSchema,
  entries: z.array(workspaceFileEntrySchema).max(WORKSPACE_FILES_MAX_ENTRIES),
  truncated: z.boolean(),
  changedFiles: z.array(z.object({
    path: workspaceRequiredPathSchema,
    status: workspaceChangeBadgeSchema,
  }).strict()).max(200),
  fingerprint: z.string().min(1).max(128),
  // Present only when the request asked for it (`display=1`), so strict older clients never see it.
  displayPath: z.string().min(1).max(4096).optional(),
}).strict();
export type WorkspaceTreeResponse = z.infer<typeof workspaceTreeResponseSchema>;

export const workspacePreviewResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    path: workspaceRequiredPathSchema,
    name: z.string().min(1).max(512),
    size: z.number().int().nonnegative().safe(),
    mtimeMs: z.number().int().nonnegative().safe(),
    language: z.string().max(64),
    markdown: z.boolean(),
    sensitive: z.boolean(),
    content: z.string(),
    lines: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("image"),
    path: workspaceRequiredPathSchema,
    name: z.string().min(1).max(512),
    size: z.number().int().nonnegative().safe(),
    mtimeMs: z.number().int().nonnegative().safe(),
    mime: z.string().min(1).max(128),
    dataUrl: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("pdf"),
    path: workspaceRequiredPathSchema,
    name: z.string().min(1).max(512),
    size: z.number().int().nonnegative().safe(),
    mtimeMs: z.number().int().nonnegative().safe(),
    mime: z.literal("application/pdf"),
    base64: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("sensitive"),
    path: workspaceRequiredPathSchema,
    name: z.string().min(1).max(512),
    size: z.number().int().nonnegative().safe(),
    mtimeMs: z.number().int().nonnegative().safe(),
  }).strict(),
  z.object({
    kind: z.literal("binary"),
    path: workspaceRequiredPathSchema,
    name: z.string().min(1).max(512),
    size: z.number().int().nonnegative().safe(),
    mtimeMs: z.number().int().nonnegative().safe(),
  }).strict(),
  z.object({
    kind: z.literal("too_large"),
    path: workspaceRequiredPathSchema,
    name: z.string().min(1).max(512),
    size: z.number().int().nonnegative().safe(),
    mtimeMs: z.number().int().nonnegative().safe(),
  }).strict(),
]);
export type WorkspacePreviewResponse = z.infer<typeof workspacePreviewResponseSchema>;
