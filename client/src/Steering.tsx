import { NativeInputContext, NativeInputReceipt } from "./NativeInput.js";
import { timeoutSignal } from "./abort-signals.js";
import { useContext, useEffect, useState } from "react";
import { Check, Compass, LoaderCircle } from "lucide-react";
import { blocksText, messageSchema, type Block, type Message } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";
import { steerReason } from "./steering-reason.js";
import { settleSteeringRequest } from "./steering-request.js";
export { steerReason } from "./steering-reason.js";
import { t, useLocale } from "./i18n.js";


export function SteeringReceipt(props: { block: Extract<Block, { type: "steering" }>; message: Message; connection: HubConnection }) {
  return props.block.mode === "message" ? <NativeInputReceipt {...props}/> : <LegacySteeringReceipt {...props}/>;
}
function LegacySteeringReceipt({ block, message, connection }: { block: Extract<Block, { type: "steering" }>; message: Message; connection: HubConnection }) {
  useLocale(); const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const context = useContext(NativeInputContext);
  useEffect(() => {
    if (connection.state.user?.id === message.authorId) settleSteeringRequest(connection, message, () => context.draftText?.(message.conversationId));
  }, [connection, message, context]);
  const check = async () => {
    if (busy || !message.clientMsgId) return;
    setBusy(true); setError("");
    try {
      const updated = messageSchema.parse(await connection.http(`/api/conversations/${message.conversationId}/steer`, { method: "POST", body: JSON.stringify({ botId: block.botId, requestId: message.clientMsgId, targetId: block.targetId, text: blocksText(message.blocks) }), signal: timeoutSignal(15_000) }));
      settleSteeringRequest(connection, updated, () => context.draftText?.(message.conversationId));
      if (updated.blocks.some((b) => b.type === "steering" && b.outcome === "unknown")) setError(steerReason("uncertain"));
    } catch { setError(t("暂时无法核对引导结果，请恢复连接后重试。")); }
    finally { setBusy(false); }
  };
  const application = block.application;
  const label = application?.status === "applied" ? t("补充已进入模型上下文") : application?.status === "absorbed" ? t("补充已进入后台复核上下文") : application?.status === "dropped" ? t("补充未进入模型，可重新发送") : block.outcome === "accepted" ? t("CLI 已接收引导") : block.outcome === "pending" ? t("等待 CLI 引导回执…") : steerReason(block.reason);
  return <div className={`steering-receipt ${application?.status === "dropped" ? "rejected" : block.outcome}`} role="status">
    {block.outcome === "accepted" && application?.status !== "dropped" ? <Check size={13}/> : block.outcome === "pending" ? <LoaderCircle size={13} className="spin"/> : <Compass size={13}/>}
    <span>{label}</span>
    {!application && (block.outcome === "unknown" || block.outcome === "pending") && <button disabled={busy} onClick={() => void check()}>{t("核对引导回执")}</button>}
    {error && <span>{error}</span>}
  </div>;
}
