import { z } from "zod";
import type { EngineStreamEvent } from "./adapter.js";

// Validated against the installed CLI's public ThreadItem protocol. Project known
// fields only; never read another thread or turn a lifecycle receipt into prose.
const activitySchema = z.object({
  type: z.literal("subAgentActivity"), id: z.string().min(1).max(512),
  kind: z.enum(["started", "interacted", "interrupted", "completed"]),
  agentThreadId: z.string().min(1).max(512), agentPath: z.string().min(1).max(512),
  model: z.string().max(512).nullish(), reasoningEffort: z.string().max(512).nullish(),
});
export function codexSubagentActivity(item: unknown): Extract<EngineStreamEvent, { type: "subagent_activity" }> | undefined {
  const parsed = activitySchema.safeParse(item);
  if (!parsed.success) return;
  const value = parsed.data;
  return { type: "subagent_activity", id: value.id, kind: value.kind, agentId: value.agentThreadId, label: value.agentPath,
    ...(value.model ? { model: value.model } : {}), ...(value.reasoningEffort ? { effort: value.reasoningEffort } : {}) };
}
