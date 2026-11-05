import { z } from "zod";

// Details are a bounded, separately fetched journal, never a repeated message payload.
export const RUN_CAPABILITY = "runs.v1";
export const RUN_RECOVERY_CAPABILITY = "runs.recovery.v1";
export const RUN_SCOPES_CAPABILITY = "runs.scopes.v1";
export const RUN_TAIL_CAPABILITY = "runs.tail.v1";
export const RUN_ENTRY_LIMIT = 2000;
export const RUN_BYTE_LIMIT = 8 * 1024 * 1024;
export const RUN_RETENTION_MS = 30 * 24 * 60 * 60_000;
export function isContextMaintenance(entry: { kind: string; name?: string }): boolean {
  return entry.kind === "text" && (entry.name === "context_compaction" || entry.name === "context_checkpoint");
}
const short = z.string().max(512);
export const runScopeSchema = z.object({
  id: z.string().min(1).max(128), kind: z.enum(["subagent", "background"]),
  parentId: z.string().min(1).max(128).optional(), parentCallId: short.optional(), label: short.optional(),
}).strict();
export type RunScope = z.infer<typeof runScopeSchema>;
export const runEntrySchema = z.object({
  seq: z.number().int().positive(), revision: z.number().int().positive(),
  kind: z.enum(["text", "thinking", "tool", "plan", "question"]),
  status: z.enum(["running", "waiting", "done", "error", "unknown", "stopped"]),
  at: z.number().nonnegative(), endedAt: z.number().nonnegative().optional(),
  callId: short.optional(), name: short.optional(),
  scope: runScopeSchema.optional(),
  text: z.string().max(32768).optional(), input: z.string().max(32768).optional(), output: z.string().max(65536).optional(),
  exitCode: z.number().int().optional(), durationMs: z.number().nonnegative().optional(),
  changes: z.array(z.object({ path: z.string().max(2048), diff: z.string().max(32768) }).strict()).max(20).optional(),
  sources: z.array(z.object({ url: z.string().max(4096), title: short.optional() }).strict()).max(30).optional(),
  truncated: z.boolean().optional(),
}).strict();
export type RunEntry = z.infer<typeof runEntrySchema>;

export const runSummarySchema = z.object({
  version: z.literal(1), id: z.string().regex(/^[\w-]{1,128}$/), revision: z.number().int().nonnegative(),
  phase: z.enum(["thinking", "working", "answering", "waiting_approval", "waiting_answer", "stopping", "delivering", "done", "partial", "error", "stopped", "interrupted"]),
  startedAt: z.number().nonnegative(), updatedAt: z.number().nonnegative(), endedAt: z.number().nonnegative().optional(),
  count: z.number().int().nonnegative(), completed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
  current: runEntrySchema.optional(), truncated: z.boolean(),
  model: short.optional(), effort: short.optional(), detailsUnavailable: z.boolean().optional(),
}).strict();
export type RunSummary = z.infer<typeof runSummarySchema>;
export function isRunActive(phase: RunSummary["phase"]): boolean {
  return !["done", "partial", "error", "stopped", "interrupted"].includes(phase);
}
export const runWriteSchema = z.object({ conversationId: z.string().regex(/^[\w-]{1,128}$/), messageId: z.string().regex(/^[\w-]{1,128}$/), runId: z.string().regex(/^[\w-]{1,128}$/), entries: z.array(runEntrySchema.omit({ scope: true })).max(4) }).strict();
export const runScopeWriteSchema = runWriteSchema.extend({ entries: z.array(runEntrySchema.extend({ scope: runScopeSchema })).max(4) });
export const runPageSchema = z.object({ entries: z.array(runEntrySchema).max(40), next: z.number().int().nonnegative().nullable(), previous: z.number().int().positive().nullable().optional(), expired: z.boolean(), files: z.array(z.object({ type: z.literal("file"), attachmentId: z.string(), name: z.string(), size: z.number().nonnegative(), mime: z.string() })).max(50).default([]) });
export type RunPage = z.infer<typeof runPageSchema>;

/** Foreground runs only: callers may use these to control the current turn. */
export function nativeRun(block: { extra?: Record<string, unknown> }): RunSummary | undefined {
  const parsed = runSummarySchema.safeParse(block.extra?.nativeRun);
  return parsed.success ? parsed.data : undefined;
}
/** Explicitly opt in to read-only scoped reports for rendering and lifecycle. */
export function anyRun(block: { extra?: Record<string, unknown> }): RunSummary | undefined {
  const scoped = runSummarySchema.safeParse(block.extra?.scopedRun);
  return nativeRun(block) ?? (scoped.success ? scoped.data : undefined);
}

// Kept outside the strict v1 summary so old clients can still parse nativeRun.
export const scopedJournalSchema = z.object({ runId: runSummarySchema.shape.id, revision: z.number().int().nonnegative(), pending: z.boolean() }).strict();
export type ScopedJournal = z.infer<typeof scopedJournalSchema>;
export function scopedJournal(block: { extra?: Record<string, unknown> }, run: RunSummary): ScopedJournal | undefined {
  const parsed = scopedJournalSchema.safeParse(block.extra?.scopedJournal);
  return parsed.success && parsed.data.runId === run.id && parsed.data.revision === run.revision ? parsed.data : undefined;
}
