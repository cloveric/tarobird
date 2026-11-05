import { ArrowUpRight, GitBranch } from "lucide-react";
import type { Message } from "../../src/client-protocol/index.js";
import type { BackgroundTaskNotice } from "../../src/client-protocol/background-task.js";
import { messageExcerpt } from "./MessageReference.js";
import { t } from "./i18n.js";
import "./background-task.css";

export type BackgroundSource = { original?: Message; open: () => void };
export function BackgroundTaskReference({ notice, message, source, compact = false }: { notice: BackgroundTaskNotice; message: Message; source?: BackgroundSource; compact?: boolean }) {
  const candidate = source?.original;
  const original = notice.origin === "bound" && candidate && candidate.id === message.replyTo
    && candidate.conversationId === message.conversationId && candidate.status !== "deleted" ? candidate : undefined;
  if (compact) return <div className="background-task-compact">
    {original ? <button type="button" onClick={source?.open} aria-label={t("查看关联请求")} title={t("点击定位原消息")}><ArrowUpRight size={13}/><span>{messageExcerpt(original)}</span></button>
      : <span title={notice.origin === "unattributed" ? t("暂时无法确认关联的原请求。这是独立通知，不是当前提问的回答。") : undefined}>{notice.origin === "unattributed" ? t("来源待确认 · 不是当前提问的回答") : candidate?.status === "deleted" ? t("原消息已删除或当前不可访问") : message.replyTo ? t("原请求暂不在当前记录中") : t("此回复未关联可定位的原请求")}</span>}
  </div>;
  return <div className="background-task-reference">
    <div className="background-task-label"><GitBranch size={13}/><span>{t("后台任务结果")}</span></div>
    {notice.origin === "unattributed" ? <p>{t("暂时无法确认关联的原请求。这是独立通知，不是当前提问的回答。")}</p> : original ?
      <button className="background-task-source" onClick={source?.open} aria-label={t("查看关联请求")} title={t("点击定位原消息")}>
        <span><small>{t("关联请求")} · <time dateTime={new Date(original.createdAt).toISOString()}>{new Date(original.createdAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></small><span className="background-task-excerpt">{messageExcerpt(original)}</span></span><ArrowUpRight size={14}/>
      </button> : <p>{candidate?.status === "deleted" ? t("原消息已删除或当前不可访问") : message.replyTo ? t("原请求暂不在当前记录中") : t("此回复未关联可定位的原请求")}</p>}
  </div>;
}
