import { z } from "zod";
import { idSchema } from "../../src/client-protocol/index.js";
import type { DiffReviewNote, DiffReviewScope } from "./diff-review-draft.js";

// Reserved non-commit anchor also prevents old workspace viewers from marking
// a run note on an unborn repository's head:null lines.
export const RUN_REVIEW_HEAD = "0".repeat(40);
export const runReviewReferenceSchema = z.object({ messageId: idSchema, runId: idSchema,
  fileKey: z.string().regex(/^[a-f0-9]{64}$/), operation: z.string().regex(/^\d+-\d+$/), anchor: z.string().max(32768),
}).strict();
export type RunReviewReference = z.infer<typeof runReviewReferenceSchema>;
export type RunReviewReferences = Record<string, RunReviewReference>;
export const reviewReferenceKey = (scope: DiffReviewScope) => `diff-review-references:${JSON.stringify([scope.conversationId, scope.botId])}`;
export const reviewAnchor = (note: DiffReviewNote) => JSON.stringify([note.path, note.head, note.side, note.start, note.end, note.excerpt]);
export const reviewReferencesSchema = z.object({ v: z.literal(1), owner: z.string(), scope: z.object({ conversationId: idSchema, botId: idSchema }).strict(), refs: z.record(idSchema, runReviewReferenceSchema).refine(value => Object.keys(value).length <= 100) }).strict();
export function validateReviewReferences(notes: DiffReviewNote[], refs: RunReviewReferences): RunReviewReferences {
  const result: RunReviewReferences = {};
  for (const note of notes) {
    const ref = refs[note.id];
    if (note.head === RUN_REVIEW_HEAD) {
      if (!ref || ref.anchor !== reviewAnchor(note)) throw new Error("diff_review_reference_missing");
      result[note.id] = runReviewReferenceSchema.parse(ref);
    } else if (ref) throw new Error("diff_review_reference_changed");
  }
  return result;
}
