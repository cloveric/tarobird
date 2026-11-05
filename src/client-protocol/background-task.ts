import { z } from "zod";

/** Additive card metadata; older clients retain the readable fallback. No
 * native session/tool IDs or cross-conversation navigation targets are stored. */
export const backgroundTaskSchema = z.object({ version: z.literal(1), origin: z.enum(["bound", "unattributed"]), status: z.enum(["running", "done", "error", "stopped", "unknown"]).optional(), delivery: z.literal("unconfirmed").optional() });
export type BackgroundTaskNotice = z.infer<typeof backgroundTaskSchema>;
export function backgroundTaskNotice(block: { extra?: Record<string, unknown> }): BackgroundTaskNotice | undefined {
  const parsed = backgroundTaskSchema.safeParse(block.extra?.backgroundTask);
  return parsed.success ? parsed.data : undefined;
}

/** Only a structured producer notice may use the historical status-title fallback. */
export function backgroundTaskStatus(block: { extra?: Record<string, unknown>; elements?: Array<{ text?: string }> }): BackgroundTaskNotice["status"] {
  const notice = backgroundTaskNotice(block); if (!notice) return;
  if (notice.status) return notice.status;
  const header = (block.elements?.[0]?.text ?? "").replace(/^\*\*|\*\*$/g, "").trim();
  if (/^(后台任务失败|Background task failed)$/i.test(header)) return "error";
  if (/^(后台任务已(?:中断|停止)|Background task (?:interrupted|stopped))$/i.test(header)) return "stopped";
  if (/^(后台任务(?:已)?完成|Background task completed)$/i.test(header)) return "done";
  if (/^(后台任务更新|Background task update)$/i.test(header)) return "unknown";
  if (/^(后台任务执行中|Background task running)$/i.test(header)) return "running";
}
