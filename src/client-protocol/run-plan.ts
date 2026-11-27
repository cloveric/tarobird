import { z } from "zod";
import { runEntrySchema, type RunEntry, type RunSummary } from "./run.js";

export const MAX_RUN_PLAN_ITEMS = 50;
export const MAX_RUN_PLAN_ITEM_CHARS = 320;
export const MAX_RUN_PLAN_INPUT_CHARS = 32768;

export const runPlanItemSchema = z.object({
  content: z.string().min(1).max(MAX_RUN_PLAN_ITEM_CHARS),
  status: z.enum(["pending", "in_progress", "completed"]),
}).strict();
export type RunPlanItem = z.infer<typeof runPlanItemSchema>;

const runPlanPreviewSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  revision: z.number().int().nonnegative(),
  seq: z.number().int().positive(),
  items: z.array(runPlanItemSchema).min(1).max(MAX_RUN_PLAN_ITEMS),
  total: z.number().int().positive().optional(),
  completed: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
}).strict().superRefine((data, ctx) => {
  if (data.total !== undefined && data.total < data.items.length) {
    ctx.addIssue({ code: "custom", message: "total must be >= items.length" });
  }
  const maxTotal = data.total ?? data.items.length;
  if (data.completed !== undefined && data.completed > maxTotal) {
    ctx.addIssue({ code: "custom", message: "completed must be <= total" });
  }
});
export type RunPlanPreview = z.infer<typeof runPlanPreviewSchema>;

export interface ParsedRunPlan {
  items: RunPlanItem[];
  total: number;
  completed: number;
  knownTotal: boolean;
  truncated: boolean;
}

function normalizePlanStatus(raw: unknown): RunPlanItem["status"] {
  if (typeof raw !== "string") return "pending";
  const value = raw.toLowerCase();
  if (value === "completed" || value === "done") return "completed";
  if (value === "in_progress" || value === "inprogress" || value === "running") return "in_progress";
  return "pending";
}

function extractPlanList(rec: Record<string, unknown>): unknown[] | undefined {
  const list = rec.todos ?? rec.entries ?? rec.plan;
  return Array.isArray(list) ? list : undefined;
}

function parsePlanRecord(rec: Record<string, unknown>, maxItems: number): ParsedRunPlan {
  const list = extractPlanList(rec);
  if (!list) return { items: [], total: 0, completed: 0, knownTotal: false, truncated: false };
  const items: RunPlanItem[] = [];
  let parsedTotal = 0;
  let parsedCompleted = 0;
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const text = typeof item.content === "string" ? item.content.trim() : typeof item.text === "string" ? item.text.trim() : "";
    if (!text) continue;
    const status = normalizePlanStatus(item.status);
    parsedTotal++;
    if (status === "completed") parsedCompleted++;
    if (items.length < maxItems) {
      items.push({ content: text.slice(0, MAX_RUN_PLAN_ITEM_CHARS), status });
    }
  }
  if (!items.length) return { items: [], total: 0, completed: 0, knownTotal: false, truncated: false };
  const reportedTotal = typeof rec.total === "number" && Number.isInteger(rec.total) && rec.total >= parsedTotal ? rec.total : undefined;
  const total = reportedTotal ?? parsedTotal;
  const reportedCompleted = reportedTotal !== undefined && reportedTotal > parsedTotal
    && typeof rec.completed === "number" && Number.isInteger(rec.completed)
    && rec.completed >= parsedCompleted && rec.completed <= total
    ? rec.completed
    : undefined;
  const completed = reportedCompleted ?? parsedCompleted;
  const truncated = total > items.length || rec.truncated === true;
  const knownTotal = !truncated || total > items.length;
  return { items, total, completed, knownTotal, truncated };
}

export function parseRunPlan(rawInput: string | undefined): ParsedRunPlan {
  if (!rawInput) return { items: [], total: 0, completed: 0, knownTotal: false, truncated: false };
  let parsed: unknown;
  try { parsed = JSON.parse(rawInput); } catch { return { items: [], total: 0, completed: 0, knownTotal: false, truncated: false }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { items: [], total: 0, completed: 0, knownTotal: false, truncated: false };
  }
  return parsePlanRecord(parsed as Record<string, unknown>, MAX_RUN_PLAN_ITEMS);
}

export function parseRunPlanItems(rawInput: string | undefined): RunPlanItem[] {
  return parseRunPlan(rawInput).items;
}

/**
 * Serialize a plan tool input compactly so valid plans never exceed the
 * run-record input limit and break JSON parsing. When oversized, strips
 * auxiliary fields and bounds the stored items while preserving exact counts.
 */
export function serializeRunPlanInput(value: unknown, maxChars = MAX_RUN_PLAN_INPUT_CHARS): string {
  let compact: string | undefined;
  try { compact = JSON.stringify(value); } catch { return "[unavailable]"; }
  if (compact === undefined) return "";
  if (compact.length <= maxChars) return compact;
  if (!value || typeof value !== "object" || Array.isArray(value)) return compact;
  const rec = value as Record<string, unknown>;
  const parsed = parsePlanRecord(rec, MAX_RUN_PLAN_ITEMS);
  if (!parsed.items.length) return compact;
  const buildPayload = (items: RunPlanItem[], truncated: boolean) => (
    truncated
      ? { todos: items, ...(parsed.knownTotal || parsed.total > items.length ? { total: parsed.total, completed: parsed.completed } : {}), truncated: true as const }
      : { todos: items }
  );
  const direct = JSON.stringify(buildPayload(parsed.items, parsed.truncated));
  if (direct.length <= maxChars) return direct;
  const kept: RunPlanItem[] = [];
  let used = JSON.stringify(buildPayload([], true)).length;
  for (const item of parsed.items) {
    const encoded = JSON.stringify(item);
    const added = encoded.length + (kept.length ? 1 : 0);
    if (used + added > maxChars) break;
    kept.push(item);
    used += added;
  }
  return JSON.stringify(buildPayload(kept, true));
}

/**
 * Latest bounded foreground plan snapshot, kept outside strict v1 run summaries
 * so older clients continue to read nativeRun normally.
 */
export function publicPlanPreview(entries: readonly RunEntry[], run: RunSummary): RunPlanPreview | undefined {
  if (!Array.isArray(entries)) return;
  let best: { revision: number; seq: number; plan: ParsedRunPlan } | undefined;
  for (const entry of entries) {
    if (entry?.kind !== "plan" || entry.scope || entry.status === "error") continue;
    const parsed = runEntrySchema.safeParse(entry);
    if (!parsed.success || parsed.data.status === "error" || parsed.data.revision > run.revision) continue;
    const plan = parseRunPlan(parsed.data.input);
    if (!plan.items.length) continue;
    if (!best || parsed.data.revision > best.revision || (parsed.data.revision === best.revision && parsed.data.seq > best.seq)) {
      best = { revision: parsed.data.revision, seq: parsed.data.seq, plan };
    }
  }
  if (!best) return;
  return {
    version: 1 as const,
    runId: run.id,
    revision: run.revision,
    seq: best.seq,
    items: best.plan.items,
    ...(best.plan.truncated
      ? {
        ...(best.plan.knownTotal ? { total: best.plan.total, completed: best.plan.completed } : {}),
        truncated: true,
      }
      : {}),
  };
}

export function runPlanPreview(block: { extra?: Record<string, unknown> }, run: RunSummary): RunPlanPreview | undefined {
  if (block.extra?.scopedRun !== undefined) return;
  const parsed = runPlanPreviewSchema.safeParse(block.extra?.nativeRunPlan);
  return parsed.success && parsed.data.runId === run.id && parsed.data.revision === run.revision ? parsed.data : undefined;
}
