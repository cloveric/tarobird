import { useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CreationDialog } from "./CreationDialog.js";
import { RuntimeHostActiveContext } from "./RuntimeHost.js";
import { CornerDownRight, CircleAlert, CircleHelp, CirclePause, CircleSlash, LoaderCircle, MessageCircleQuestion } from "lucide-react";
import type { UserReply, UserReplyState } from "./user-reply-status.js";
import { t, useLocale } from "./i18n.js";
import "./user-reply-status.css";

function label(state: UserReplyState): string {
  switch (state) {
    case "replying": return t("回复中");
    case "done": return t("已回复");
    case "error": return t("回复失败");
    case "partial": return t("回复不完整");
    case "stopped": return t("已停止");
    case "interrupted": return t("已中断");
    case "waiting_approval": return t("等你批准");
    case "waiting_answer": return t("等你回答");
    case "stopping": return t("正在停止");
    case "unconfirmed": return t("状态待确认");
  }
}
function Icon({ state }: { state: UserReplyState }) {
  if (state === "replying") return <LoaderCircle className="reply-status-spinner"/>;
  if (state === "done") return <CornerDownRight/>;
  if (state === "error" || state === "partial") return <CircleAlert/>;
  if (state === "waiting_approval" || state === "waiting_answer") return <MessageCircleQuestion/>;
  if (state === "interrupted") return <CircleSlash/>;
  if (state === "unconfirmed") return <CircleHelp/>;
  return <CirclePause/>;
}

/** In the existing metadata line: state transitions never add a second bubble
 * or a footer row. No live region announcing every streamed render. */
export function UserReplyStatus({ replies, group, labels }: { replies?: UserReply[]; group: boolean; labels: ReadonlyMap<string, string> }) {
  const locale = useLocale();
  const [opened, open] = useState(false), trigger = useRef<HTMLButtonElement>(null);
  const hostActive = useContext(RuntimeHostActiveContext);
  useEffect(() => { if (!hostActive) open(false); }, [hostActive]);
  if (!replies?.length) return null;
  const detail = replies.map(reply => t("{0}：{1}", labels.get(reply.botId) ?? t("Bot"), label(reply.state))).join(locale === "en" ? "; " : "；");
  const multiple = group || replies.length > 1;
  // One compact mark even for large groups. Its count only refers to observed
  // replies, never an invented historical recipient total. Details remain
  // available by touch/keyboard, not solely in a desktop hover tooltip.
  const priority: UserReplyState[] = ["waiting_approval", "waiting_answer", "error", "interrupted", "partial", "replying", "stopping", "unconfirmed", "stopped", "done"];
  const state = priority.find(state => replies.some(reply => reply.state === state))!;
  const count = replies.filter(reply => reply.state === state).length, other = replies.length - count;
  const mark = <span className={`user-reply-state is-${state}`} data-reply-state={state}>
    <Icon state={state}/><span>{multiple ? t("{0} 个 Bot · {1}", count, label(state)) : label(state)}</span>{other > 0 && <span className="reply-status-other">+{other}</span>}
  </span>;
  if (!multiple) return <span className="user-reply-status" role="img" aria-label={t("此消息的回复状态：{0}", detail)} title={detail}>{mark}</span>;
  return <>
    <button ref={trigger} type="button" className="user-reply-status reply-status-trigger" aria-label={t("查看此消息的回复状态：{0}", detail)} aria-haspopup="dialog" onClick={() => open(true)} title={detail}>{mark}</button>
    {opened && hostActive && createPortal(<CreationDialog title={t("此消息的回复状态")} closeLabel={t("关闭回复状态")} close={() => open(false)} returnFocus={trigger} showHost={false} className="reply-status-dialog">
      <p>{t("仅列出已经开始回复的 Bot，尚未开始的不计入。")}</p>
      <ul>{replies.map(reply => <li key={reply.botId}><span>{labels.get(reply.botId) ?? t("Bot")}</span><span className={`user-reply-state is-${reply.state}`}><Icon state={reply.state}/>{label(reply.state)}</span></li>)}</ul>
    </CreationDialog>, document.body)}
  </>;
}
