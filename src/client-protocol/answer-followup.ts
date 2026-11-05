import { z } from "zod";
import type { Block } from "./index.js";

/** Optional card metadata: older clients still render its ordinary text. */
export const answerFollowupSchema = z.object({
  version: z.literal(1), startedAt: z.number().int().nonnegative(), locale: z.enum(["en", "zh"]),
  phase: z.enum(["queued", "sent", "processing", "finished", "interrupted", "failed", "skipped", "blocked"]),
}).strict();
export type AnswerFollowup = z.infer<typeof answerFollowupSchema>;
export function answerFollowup(block: Extract<Block, { type: "card" }>): AnswerFollowup | undefined {
  const result = answerFollowupSchema.safeParse(block.extra?.answerFollowup);
  return result.success ? result.data : undefined;
}
export const activeAnswerFollowup = (value: AnswerFollowup | undefined): boolean => value?.phase === "queued" || value?.phase === "processing";
