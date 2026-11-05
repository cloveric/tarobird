import { z } from "zod";
import { idSchema, type Block, type CardElement, type Message } from "./index.js";

/** Waiting for Core execution is not an engine run. Keep runs.v1 unchanged and
 * retain readable card content for clients without this additive presentation. */
export const queueNoticeSchema = z.object({ version: z.literal(1), taskId: idSchema,
  conversationKey: z.string().min(1).max(512), state: z.enum(["queued", "started", "cancelled", "skipped", "interrupted", "failed", "expired"]), at: z.number().int().nonnegative(),
}).strict();
export type QueueNoticeData = z.infer<typeof queueNoticeSchema> & { cancel?: CardElement };
export function queueNotice(block: Extract<Block, { type: "card" }>, message: Pick<Message, "authorType" | "conversationId" | "replyTo" | "createdAt">): QueueNoticeData | undefined {
  if (message.authorType !== "bot" || !message.replyTo || block.extra?.nativeRun || block.extra?.scopedRun || block.extra?.answerFollowup) return;
  const cancel = block.elements.find(e => e.type === "button" && !!e.actionId && !e.url
    && e.value && typeof e.value === "object" && !Array.isArray(e.value) && e.value.cctb_lark === "stop");
  const value = cancel?.value && typeof cancel.value === "object" && !Array.isArray(cancel.value) ? cancel.value : undefined;
  let raw = block.extra?.appQueue;
  if (raw === undefined) {
    // Precisely recognize the former Gateway compact notice, without parsing
    // localized prose or treating arbitrary stop/approval cards as queue state.
    const config = block.extra?.config;
    if (block.title || block.template || block.elements.length !== 2 || block.elements[0]?.type !== "markdown"
      || block.elements[1] !== cancel || block.extra?.schema !== "2.0" || block.layout?.padding !== "8px 12px 8px 12px"
      || !config || typeof config !== "object" || Array.isArray(config) || config.update_multi !== true) return;
    raw = { version: 1, state: "queued", taskId: value?.taskId ?? null, conversationKey: value?.conversationKey ?? null, at: message.createdAt };
  }
  const parsed = queueNoticeSchema.safeParse(raw);
  if (!parsed.success) return;
  const data = parsed.data;
  if (data.taskId !== message.replyTo || data.conversationKey !== `lark:${message.conversationId}`) return;
  if (data.state === "queued" && (!cancel || value?.taskId !== data.taskId || value.conversationKey !== data.conversationKey)) return;
  return { ...data, ...(data.state === "queued" ? { cancel } : {}) };
}
