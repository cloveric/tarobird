import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Check, Clock3, LoaderCircle } from "lucide-react";
import { blocksText, messageSchema, type Block, type Message } from "../../src/client-protocol/index.js";
import type { NativeInputAction, NativeInputCapability } from "../../src/client-protocol/native-input.js";
import type { HubConnection } from "./connection.js";
import { controlNativeInput } from "./native-input-request.js";
import { settleSteeringRequest } from "./steering-request.js";
import { timeoutSignal } from "./abort-signals.js";
import { nativeControlReason } from "./steering-reason.js";
import { t, useLocale } from "./i18n.js";

/** A rejected native message never entered the current task. Name why; the
 * sender may already have sent it as the next turn from the same draft. */
function rejectedLabel(reason?: string) {
  switch (reason) {
    case "unsupported": return t("CLI 不支持运行中收信，未投递");
    case "idle": case "stale": return t("当前任务已结束，未投递到任务中");
    case "not_ready": case "queued": return t("当前任务暂不能接收，未投递到任务中");
    case "binding_changed": return t("对话绑定已改变，未投递");
    default: return t("发送失败，未投递");
  }
}

export const NativeInputContext = createContext<{ capability?: NativeInputCapability; editable?: boolean; draftText?: (conversationId: string) => string | undefined; restore?: (message: Message) => void }>({});
export function NativeInputReceipt({ block, message, connection }: { block: Extract<Block, { type: "steering" }>; message: Message; connection: HubConnection }) {
  useLocale();
  const context = useContext(NativeInputContext), [busy, setBusy] = useState(false), busyRef = useRef(false), [notice, setNotice] = useState("");
  const restored = useRef(false);
  const [noticePendingOnly, setNoticePendingOnly] = useState(false);
  const [sendNowRequested, setSendNowRequested] = useState(false);
  useEffect(() => {
    if (connection.state.user?.id === message.authorId) settleSteeringRequest(connection, message, () => context.draftText?.(message.conversationId));
  }, [connection, message, block.outcome, context]);
  const state = block.nativeInput?.state;
  const endedWithoutReceipt = state === "unknown" && block.nativeInput?.reason === "ended_without_model_receipt";
  const engineExited = state === "unknown" && block.nativeInput?.reason === "engine_exit";
  const label = state === "received" ? t("模型已收到") : state === "cancelled" ? t("已撤回") : state === "dropped" ? t("未进入模型")
    : endedWithoutReceipt ? t("CLI 已结束本轮，模型接收情况无法确认") : engineExited ? t("CLI 已退出，模型接收情况无法确认")
    : state === "unknown" || block.outcome === "unknown" ? t("发送结果待确认") : block.outcome === "rejected" ? rejectedLabel(block.reason)
    : state === "dequeued" ? t("CLI 正在处理，等待模型回执") : state === "queued" || block.outcome === "accepted" ? t("CLI 已接收 · 待处理") : t("待处理，等待 CLI 回执");
  const ownsMessage = connection.state.user?.id === message.authorId;
  // Controls act on the CLI's queue: only a queued (or just admitted) input can move or be withdrawn.
  const canControl = state === "queued" || !state && block.outcome === "accepted";
  const pending = ownsMessage && !endedWithoutReceipt && block.outcome !== "rejected" && !["received", "cancelled", "dropped"].includes(state ?? "");
  const control = async (action: NativeInputAction) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setNotice(""); setNoticePendingOnly(false); setSendNowRequested(false);
    try {
      const result = await controlNativeInput(connection, message.conversationId, message.id, action);
      if (result.outcome === "unknown") { setNoticePendingOnly(true); setNotice(t("操作结果待确认；重试将核对同一请求，不会重复发送消息。")); }
      else if (result.result === "cancelled") { if (!restored.current) { restored.current = true; context.restore?.(message); } }
      else if (result.result === "not_queued") setNotice(action === "cancel" ? t("消息已开始处理或已不在原生队列，未撤回。") : t("消息已开始处理或已不在原生队列，本次未改变任务。"));
      else if (result.result === "nothing_waiting") setNotice(t("消息已不在原生队列，本次未改变任务。"));
      else if (result.outcome === "accepted") setSendNowRequested(true);
      else setNotice(nativeControlReason(result.reason));
    } catch { setNoticePendingOnly(true); setNotice(t("操作结果待确认；重试将核对同一请求，不会重复发送消息。")); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const check = async () => {
    if (busyRef.current || !message.clientMsgId) return;
    busyRef.current = true; setBusy(true); setNotice(""); setNoticePendingOnly(false); setSendNowRequested(false);
    try {
      const updated = messageSchema.parse(await connection.http(`/api/conversations/${message.conversationId}/steer`, { method: "POST", body: JSON.stringify({ botId: block.botId, requestId: message.clientMsgId, targetId: block.targetId, text: blocksText(message.blocks), mode: "message" }), signal: timeoutSignal(15_000) }));
      settleSteeringRequest(connection, updated, () => context.draftText?.(message.conversationId));
      if (updated.blocks.some(b => b.type === "steering" && b.outcome === "unknown")) { setNoticePendingOnly(true); setNotice(t("发送结果待确认")); }
    } catch { setNoticePendingOnly(true); setNotice(t("暂时无法核对消息回执，请恢复连接后重试。")); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <div className={`steering-receipt native-input-receipt ${block.outcome}`} role="status" data-input-state={state ?? block.outcome}>
    {busy ? <LoaderCircle size={13} className="spin"/> : state === "received" ? <Check size={13}/> : <Clock3 size={13}/>}<span>{label}</span>
    {pending && (block.outcome === "pending" || block.outcome === "unknown") && <button disabled={busy} onClick={() => void check()}>{t("核对消息回执")}</button>}
    {pending && canControl && context.capability?.sendNow && <button disabled={busy} onClick={() => void control("send-now")}>{t("立即发送")}</button>}
    {pending && canControl && context.capability?.cancel && context.editable && <button disabled={busy} onClick={() => void control("cancel")}>{t("撤回编辑")}</button>}
    {state === "cancelled" && ownsMessage && context.editable && <button disabled={busy} onClick={() => context.restore?.(message)}>{t("编辑已撤回内容")}</button>}
    {sendNowRequested && state === "queued" && <span>{t("已请求立即发送。")}</span>}
    {notice && (!noticePendingOnly || pending) && notice !== label && <span>{notice}</span>}
  </div>;
}
