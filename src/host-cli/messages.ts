import { idSchema } from "../client-protocol/index.js";
import { deleteMessagesSchema, deleteMessagesResultSchema, messagePageSchema } from "../client-protocol/message-deletion.js";
import type { LocalHostClient } from "./client.js";
import { clearMessagesPlanSchema, clearMessagesResultSchema } from "../client-protocol/message-clear.js";
import { clearMessageHistory } from "../client-protocol/clear-messages-operation.js";

/** Personal history uses the same authenticated user and API as the Apps. */
export async function runMessagesCommand(client: Pick<LocalHostClient, "request">, command: string | undefined, conversationId: string | undefined, options: { ids?: string; before?: string; through?: string; yes?: boolean }, boundary?: (throughId: string) => void) {
  if (command !== "list" && command !== "delete" && command !== "clear") throw new Error("用法：tarobot messages list|delete|clear CONVERSATION；delete 需 --ids ID,ID --yes；clear 不加 --yes 仅预览。");
  const conversation = idSchema.parse(conversationId), route = `/api/conversations/${conversation}/messages`;
  if (command === "clear") {
    if (options.ids !== undefined || options.before !== undefined) throw new Error("messages clear 不支持 --ids 或 --before。");
    if (options.through && !options.yes) throw new Error("继续清理指定范围需要 --through ID --yes。");
    const fixed = options.through === undefined ? undefined : idSchema.parse(options.through);
    const plan = fixed ? undefined : clearMessagesPlanSchema.parse(await client.request(`${route}/clear`));
    if (!options.yes) return { ...plan, preview: true, scope: "personal", sessionPreserved: true };
    const throughId = fixed ?? plan?.throughId;
    if (!throughId) return { cleared: 0, scope: "personal", sessionPreserved: true };
    boundary?.(throughId);
    try {
      const batch = (id: string) => client.request(`${route}/clear`, "POST", { throughId: id });
      // A resumed command starts with the SAME boundary, even when its last
      // response was lost and all original records have already been cleared.
      const first = fixed ? clearMessagesResultSchema.parse(await batch(fixed)) : undefined;
      if (first && first.throughId !== fixed) throw new Error("message_clear_unconfirmed");
      const result = await clearMessageHistory(plan ?? { throughId, count: first!.remaining }, batch);
      return { cleared: result.cleared + (first?.clearedIds.length ?? 0), throughId, scope: "personal", sessionPreserved: true };
    } catch (cause) {
      const reason = cause instanceof Error && cause.message.includes("message_clear_active") ? "请先处理运行中的任务、待回答的问题或审批。" : "";
      throw new Error(`清理未完成，部分记录可能已清理。${reason}保留原范围重试：tarobot messages clear ${conversation} --through ${throughId} --yes`, { cause });
    }
  }
  if (options.through !== undefined) throw new Error("--through 仅适用于 messages clear。");
  if (command === "list") {
    if (options.ids !== undefined || options.yes !== undefined) throw new Error("messages list 不支持 --ids 或 --yes。");
    return messagePageSchema.parse(await client.request(route + (options.before ? `?before=${idSchema.parse(options.before)}` : "")));
  }
  if (options.before !== undefined) throw new Error("messages delete 不支持 --before。");
  if (!options.yes) throw new Error("仅删除当前用户的聊天记录并同步自己的设备；Bot 已收到的内容不会撤回。核对消息 ID 后加 --yes 执行。");
  const input = deleteMessagesSchema.parse({ messageIds: options.ids?.split(",").map(id => id.trim()) });
  return deleteMessagesResultSchema.parse(await client.request(route, "DELETE", input));
}
