import { useContext, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Check, Clock3, CircleAlert } from "lucide-react";
import type { CardElement, Message } from "../../src/client-protocol/index.js";
import type { QueueNoticeData } from "../../src/client-protocol/queue-notice.js";
import type { HubConnection } from "./connection.js";
import { RuntimeHostActiveContext } from "./RuntimeHost.js";
import { t, useLocale } from "./i18n.js";
import "./queue-notice.css";

export function QueueNotice({ notice, message, connection, act, error, detail }: { notice: QueueNoticeData; message: Message; connection: HubConnection; act: (element: CardElement) => Promise<boolean>; error: string; detail?: string }) {
  useLocale(); const hostActive = useContext(RuntimeHostActiveContext);
  const labelId = useId();
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const queued = notice.state === "queued" && message.status !== "error";
  const offline = state.status !== "online" || !state.bots.find(bot => bot.id === message.authorId)?.online;
  const [pending, setPending] = useState(false), [expired, setExpired] = useState(false);
  const busy = useRef(false), epoch = useRef(0);
  useEffect(() => { ++epoch.current; busy.current = false; setPending(false); setExpired(false); return () => { ++epoch.current; }; }, [message.id, queued, offline, hostActive]);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => { busy.current = false; setPending(false); setExpired(true); }, 8000);
    return () => clearTimeout(timer);
  }, [pending]);
  const cancel = async () => {
    if (!queued || !notice.cancel || notice.cancel.disabled || offline || !hostActive || busy.current) return;
    busy.current = true; setPending(true); setExpired(false); const attempt = epoch.current;
    const accepted = await act(notice.cancel);
    if (attempt === epoch.current && !accepted) { busy.current = false; setPending(false); }
    // A submitted interaction is not cancellation confirmation. The real card
    // update settles it; the timeout only allows checking/retrying the action.
  };
  const cancelled = notice.state === "cancelled", started = notice.state === "started" && message.status !== "error", skipped = notice.state === "skipped", expiredNotice = notice.state === "expired";
  const label = queued ? t("等待执行") : started ? t("准备中") : cancelled ? t("已取消排队") : skipped ? t("已跳过排队") : expiredNotice ? t("排队提示已失效") : notice.state === "failed" ? t("排队任务未能执行") : t("排队已中断");
  const description = queued ? offline ? t("连接中断，当前状态待确认") : t("已交给 Bot，前一任务结束后开始") : started ? offline ? t("连接中断，当前状态待确认") : detail : cancelled || skipped ? t("这条消息未开始执行") : expiredNotice ? t("实际结果请查看对话中的后续回复") : t("请确认任务状态后再发送");
  const Icon = queued || started ? Clock3 : cancelled || skipped ? Check : CircleAlert;
  return <section className="queue-notice" role="status" aria-labelledby={labelId}>
    <div className="queue-notice-header"><span id={labelId} className="queue-notice-label"><Icon size={14}/>{label}</span>
      {queued && notice.cancel && <button type="button" className="queue-notice-cancel" aria-disabled={pending || notice.cancel.disabled || offline || !hostActive} onClick={() => { void cancel(); }}>{pending ? t("正在取消…") : t("取消排队")}</button>}
    </div>
    <div className="queue-notice-detail">{description}</div>
    {(error || expired) && <div className="queue-notice-error" role="alert">{error || t("尚未收到取消确认，请核对任务状态。")}</div>}
  </section>;
}
