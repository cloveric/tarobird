import { z } from "zod";
import type { RunSummary } from "./run.js";

/** Gateways add grouping only after the Hub negotiates this capability. */
export const BACKGROUND_TASK_GROUP_CAPABILITY = "runs.scope-groups.v1";
const id = z.string().regex(/^[\w-]{1,128}$/);
/** Optional presentation metadata on a bound background subagent report. The
 * group ID is opaque and unique per originating callback, never a native,
 * request or message ID. Each member keeps its own message and journal.
 * Later v1 fields must be optional; readers ignore fields they do not know. */
export const backgroundTaskGroupSchema = z.object({ version: z.literal(1), groupId: id, scopeId: id, runId: id });
export type BackgroundTaskGroup = z.infer<typeof backgroundTaskGroupSchema>;
/** Producer shape before the Gateway binds it to the published scoped summary. */
export const backgroundTaskGroupSourceSchema = backgroundTaskGroupSchema.omit({ runId: true });
export function backgroundTaskGroup(block: { extra?: Record<string, unknown> }, run: Pick<RunSummary, "id">): BackgroundTaskGroup | undefined {
  const parsed = backgroundTaskGroupSchema.safeParse(block.extra?.backgroundTaskGroup);
  return parsed.success && parsed.data.runId === run.id ? parsed.data : undefined;
}
