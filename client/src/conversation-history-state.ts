import { z } from "zod";
import { historyChangeSchema, historyClientOperationSchema, type HistoryClientReason } from "../../src/client-protocol/conversation-history.js";
import type { HubConnection } from "./connection.js";
import { t } from "./i18n.js";

/** A local admission fence, persisted before POST. Never replay this body on recovery. */
export const historyPendingSchema = z.object({ change: historyChangeSchema, result: historyClientOperationSchema.optional() }).strict();
export type HistoryPending = z.infer<typeof historyPendingSchema>;
export function historyRecordKey(connection: HubConnection, conversationId: string): string {
  return `conversation-history:${JSON.stringify([connection.identity.hubPublicKey, connection.identity.publicKey, connection.state.user?.id ?? "", conversationId])}`;
}
export function historyReason(reason?: HistoryClientReason): string {
  switch (reason) {
    case "busy": return t("当前对话正在回复中，请等待结束后再操作。");
    case "background_work": return t("后台任务正在运行中，请等待结束后再操作。");
    case "side_session": return t("当前有打开的侧边对话，请等待回答结束或关闭后再操作。");
    case "queued": return t("请先处理待执行消息。");
    case "goal_active": return t("请先暂停当前目标。");
    case "shared_session": return t("此会话正被其他对话共用，暂不能修改历史。");
    case "binding_pending": return t("会话绑定尚未完成，请先核对绑定状态。");
    case "outcome_unknown": case "uncertain": return t("操作结果尚未确认，请先核对。");
    case "source_changed": case "anchor_unavailable": return t("会话已变化，请重新选择消息。");
    case "not_ready": return t("原生会话尚未就绪，请在发送消息后重试。");
    case "source_missing": return t("原生会话当前不可访问，请检查 Bot 状态。");
    case "unsupported": case "wrong_scope": return t("此对话暂不支持这项历史操作。");
    case "request_conflict": return t("操作记录不一致，请先核对已有结果。");
    case "storage_unavailable": return t("无法保存操作记录，请检查主机存储后重试。");
    case "cancelled": return t("操作已取消。");
    default: return t("请刷新会话状态后重试。");
  }
}

export type HistoryMenuAction = { reason?: string; run: (trigger: HTMLElement | null) => void };
export type HistoryMessageActions = { fork?: HistoryMenuAction; rewind?: HistoryMenuAction };
