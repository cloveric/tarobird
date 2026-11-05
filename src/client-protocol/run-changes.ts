import { z } from "zod";
import { idSchema } from "./index.js";
import { workspaceDiffHunkSchema } from "./workspace-diff.js";

export const RUN_CHANGES_CAPABILITY = "runs.changes.v1";
export const recordedPathSchema = z.string().min(1).max(2048).refine(value => !/[\x00-\x1f\x7f]/.test(value));
export const runChangesQuerySchema = z.object({ conversationId: idSchema, botId: idSchema, runId: idSchema.optional() }).strict();
export const runChangeFileQuerySchema = runChangesQuerySchema.extend({
  key: z.string().regex(/^[a-f0-9]{64}$/), revision: z.string().regex(/^[a-f0-9]{64}$/),
  operation: z.string().regex(/^\d+-\d+$/).optional(), preview: z.literal("1").optional(),
}).strict();
const count = z.number().int().nonnegative().safe();
export const runChangesSummarySchema = z.object({ v: z.literal(1), runId: idSchema, revision: count,
  files: count, edits: count, additions: count.nullable(), deletions: count.nullable(),
  unavailable: count, partial: z.boolean(), childEdits: count,
}).strict();
export type RunChangesSummary = z.infer<typeof runChangesSummarySchema>;
export const runChangeFileSchema = z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), path: recordedPathSchema,
  additions: count.nullable(), deletions: count.nullable(), edits: count, generated: z.boolean(), protected: z.boolean(), partial: z.boolean(),
}).strict();
const scope = { scope: z.literal("recorded_run"), messageId: idSchema, conversationId: idSchema, botId: idSchema, runId: idSchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(["recorded", "not_recorded", "active", "expired"]),
  partial: z.boolean(), unavailable: count, childEdits: count,
};
export const runChangesSchema = z.object({ ...scope, items: z.array(runChangeFileSchema).max(200), truncated: z.boolean() }).strict();
export type RunChanges = z.infer<typeof runChangesSchema>;
export const runChangeOperationSchema = z.object({ id: z.string().regex(/^\d+-\d+$/), seq: count, at: count,
  additions: count.nullable(), deletions: count.nullable(), format: z.enum(["unified", "signed", "raw", "empty", "binary"]), partial: z.boolean(),
}).strict();
export const runChangeDetailSchema = z.object({ ...scope, file: runChangeFileSchema,
  operations: z.array(runChangeOperationSchema).max(200), operationsTruncated: z.boolean(), operation: runChangeOperationSchema,
  hunks: z.array(workspaceDiffHunkSchema).max(1000), truncated: z.boolean(), preview: z.boolean(),
  reason: z.enum(["protected", "binary", "too_large", "unavailable"]).nullable(),
}).strict().refine(value => value.hunks.reduce((n, hunk) => n + 1 + hunk.lines.length, 0) <= 1000);
export type RunChangeDetail = z.infer<typeof runChangeDetailSchema>;
