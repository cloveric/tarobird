import { t } from "./i18n.js";

export function steerReason(reason?: string): string {
  switch (reason) {
    case "unsupported": return t("当前 Bot 的 CLI 接入暂不支持引导，可发送为下一轮任务。");
    case "idle": return t("当前没有执行中的任务，请直接发送消息。");
    case "stale": return t("刚才的任务已结束或切换，这次补充未发送。");
    case "binding_changed": return t("对话的会话绑定已改变，引导未发送。");
    case "not_ready": return t("当前任务暂不能接收这次补充。");
    case "queued": return t("这条消息仍在排队，开始执行后才能引导。引导内容未发送。");
    default: return t("引导结果待确认，请先核对回执或 Bot 回复，避免重复发送。");
  }
}

export function nativeInputReason(reason?: string): string {
  switch (reason) {
    case "unsupported": return t("当前 CLI 暂不支持运行中收信，可作为下一轮发送。");
    case "idle": case "stale": return t("当前任务已结束或切换，这条消息未投递。");
    case "binding_changed": return t("对话绑定已改变，这条消息未投递。");
    case "not_ready": case "queued": return t("当前任务暂不能接收这条消息，可作为下一轮发送。");
    default: return t("发送结果待确认，请核对消息回执，避免重复发送。");
  }
}
export function nativeControlReason(reason?: string): string {
  return reason === "unsupported" ? t("当前 CLI 不支持此操作。")
    : reason === "binding_changed" ? t("对话绑定已改变，本次操作未执行。")
    : t("当前任务状态暂不允许此操作，本次未执行；可稍后重试。");
}
