import { clearMessagesPlanSchema, clearMessagesResultSchema } from "./message-clear.js";
import type { z } from "zod";

export type ClearMessagesPlan = z.infer<typeof clearMessagesPlanSchema>;
export type ClearMessagesResult = z.infer<typeof clearMessagesResultSchema>;

/** Each request keeps the reviewed boundary. A lost receipt can be retried
 * against that same boundary without including messages that arrived later. */
export async function clearMessageHistory(plan: ClearMessagesPlan,
  batch: (throughId: string) => Promise<unknown>,
  accepted?: (result: ClearMessagesResult) => Promise<void> | void): Promise<{ cleared: number }> {
  clearMessagesPlanSchema.parse(plan);
  if (!plan.count) return { cleared: 0 };
  if (!plan.throughId) throw new Error("message_clear_unconfirmed");
  let remaining = plan.count, cleared = 0;
  for (let step = 0; step < plan.count + 1; step++) {
    const result = clearMessagesResultSchema.parse(await batch(plan.throughId));
    if (result.throughId !== plan.throughId || result.remaining > remaining
      || result.remaining > 0 && result.remaining === remaining) throw new Error("message_clear_unconfirmed");
    remaining = result.remaining; cleared += result.clearedIds.length;
    await accepted?.(result);
    if (!remaining) return { cleared };
  }
  throw new Error("message_clear_unconfirmed");
}
