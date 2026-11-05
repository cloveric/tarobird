import { z } from "zod";
import { isRunActive, runEntrySchema, type RunEntry, type RunSummary } from "./run.js";

const thinkingPreviewSchema = z.object({
  version: z.literal(1), runId: z.string(), revision: z.number().int().nonnegative(),
  seq: z.number().int().positive(), text: z.string().min(1).max(600), truncated: z.boolean(),
}).strict();

/** An exact, bounded tail of an already-public foreground thought. Keep this
 * outside strict v1 run summaries so older clients still read the run normally.
 * Full thinking remains in the journal; no tool output or child text is used. */
export function publicThinkingPreview(entries: readonly RunEntry[], run: RunSummary) {
  if (!isRunActive(run.phase) || !Array.isArray(entries)) return;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.kind !== "thinking" || entry.scope) continue;
    const parsed = runEntrySchema.safeParse(entry);
    if (!parsed.success || parsed.data.revision > run.revision || !parsed.data.text?.trim()) continue;
    const full = parsed.data.text.trim();
    const text = full.slice(-600).replace(/^[\uDC00-\uDFFF]/, "");
    return { version: 1 as const, runId: run.id, revision: run.revision, seq: entry.seq, text, truncated: full.length > text.length };
  }
}

export function runThinkingPreview(block: { extra?: Record<string, unknown> }, run: RunSummary) {
  if (!isRunActive(run.phase) || block.extra?.scopedRun !== undefined) return;
  const parsed = thinkingPreviewSchema.safeParse(block.extra?.nativeRunThinking);
  return parsed.success && parsed.data.runId === run.id && parsed.data.revision === run.revision ? parsed.data : undefined;
}
