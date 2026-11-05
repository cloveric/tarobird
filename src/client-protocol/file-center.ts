import { z } from "zod";

export const fileCategories = ["browser", "project", "deliverable", "download", "environment", "cache", "temporary", "source", "unknown"] as const;
export const fileSafetyStates = ["protected", "important", "active", "rebuildable", "temporary", "review"] as const;
export const fileUnitIdSchema = z.string().regex(/^[a-f0-9]{24}$/);
const count = z.number().int().nonnegative().safe();
const category = z.enum(fileCategories);
export const fileLabelSchema = z.object({ category: category.optional(), important: z.boolean().optional(), note: z.string().max(500).optional(), updatedAt: z.iso.datetime(), revision: count }).strict();
export const fileLabelPatchSchema = z.object({ unitId: fileUnitIdSchema, expectedRevision: count, category: category.nullable().optional(), important: z.boolean().optional(), note: z.string().trim().max(500).nullable().optional() }).strict()
  .refine((p) => p.category !== undefined || p.important !== undefined || p.note !== undefined, "empty file label patch");
export type FileLabelPatch = z.infer<typeof fileLabelPatchSchema>;
export const fileInventoryUnitSchema = z.object({
  id: fileUnitIdSchema, name: z.string(), absolutePath: z.string(), relativePath: z.string(),
  rootKind: z.enum(["workspace", "inbox", "asr"]), instances: z.array(z.string()),
  kind: z.enum(["file", "directory", "symlink", "collection"]), category, categorySource: z.enum(["system", "user"]),
  safety: z.enum(fileSafetyStates), origin: z.enum(["bridge-input", "runtime", "workspace", "unknown"]),
  allocatedBytes: count, logicalBytes: count, fileCount: count, directoryCount: count, symlinkCount: count,
  lastModifiedAt: z.iso.datetime(), topExtensions: z.array(z.object({ extension: z.string(), files: count, allocatedBytes: count })),
  largestFiles: z.array(z.object({ name: z.string(), relativePath: z.string(), allocatedBytes: count })),
  reasons: z.array(z.string()), important: z.boolean(), note: z.string().max(500).optional(), partial: z.boolean(), errorCount: count,
  classification: z.object({ category, reasons: z.array(z.string()), shallowCredential: z.boolean() }),
  labelRevision: count.default(0),
});
const bucket = z.object({ key: z.string(), units: count, allocatedBytes: count });
export const fileInventorySchema = z.object({ generatedAt: z.iso.datetime(), totalAllocatedBytes: count, totalLogicalBytes: count, unitCount: count, byCategory: z.array(bucket), bySafety: z.array(bucket), units: z.array(fileInventoryUnitSchema), warnings: z.array(z.string()) });
export const fileCenterStatusSchema = z.object({ revision: z.string(), scanning: z.boolean(), inventory: fileInventorySchema.nullable(), error: z.enum(["scan_failed", "scan_cancelled"]).nullable(), canReveal: z.boolean() });
export type FileCenterStatus = z.infer<typeof fileCenterStatusSchema>;
export type FileCenterUnit = z.infer<typeof fileInventoryUnitSchema>;
