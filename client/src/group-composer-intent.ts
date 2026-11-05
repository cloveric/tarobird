import { z } from "zod";
import type { GroupReplyMode } from "./group-composer-send.js";

/** Editable draft identity is independent of its text. The target survives
 * later run/policy updates; only emptying or explicitly rebinding starts over. */
export const groupComposerIntentSchema = z.object({
  id: z.string(), empty: z.boolean(), legacy: z.boolean().optional(),
  discussionAction: z.enum(["resume", "retry", "new"]).optional(),
  target: z.object({
    conversationId: z.string(), mode: z.enum(["mentions", "parallel", "sequential", "independent"]), revision: z.string(),
    activeRun: z.object({ id: z.string(), conversationId: z.string() }).optional(),
  }).optional(),
});
export type GroupComposerIntent = z.infer<typeof groupComposerIntentSchema>;
export function editGroupComposerIntent(previous: GroupComposerIntent | undefined, target: GroupReplyMode | undefined, empty: boolean): GroupComposerIntent {
  if (target?.activeRun?.status === "ending") target = { ...target, activeRun: undefined };
  const bound = previous?.empty === false && previous.target ? previous.target : target;
  return { id: crypto.randomUUID(), empty, ...(!empty && bound ? { target: bound } : {}),
    ...(!empty && previous?.discussionAction && previous.target?.activeRun?.id === bound?.activeRun?.id ? { discussionAction: previous.discussionAction } : {}) };
}
