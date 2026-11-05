import { ArrowUpRight, Reply } from "lucide-react";
import type { Message } from "../../src/client-protocol/index.js";
import { ReferencePreview } from "./BotReferences.js";
import { messageExcerpt } from "./MessageReference.js";
import { t, useLocale } from "./i18n.js";
import "./bot-reply-source.css";

/** Chronological proximity is not reply ownership: queued inputs can arrive
 * before a running task publishes its response, question or attachment. */
export function BotReplySource({ message, original, open }: { message: Message; original?: Message; open: () => void }) {
  useLocale();
  const source = original && original.id === message.replyTo && original.conversationId === message.conversationId && original.status !== "deleted" ? original : undefined;
  const excerpt = source ? messageExcerpt(source) : t("原消息已删除或当前不可访问");
  return <div className="bot-reply-source-row"><button type="button" className="bot-reply-source" data-reply-to={message.replyTo}
    aria-label={t("查看回复对应的消息")} title={excerpt} disabled={!source} onClick={open}>
    <Reply size={13} aria-hidden="true"/><span className="bot-reply-source-label">{t("回复：")}</span>
    <span className="bot-reply-source-excerpt"><ReferencePreview text={excerpt}/></span>
    {source && <ArrowUpRight size={13} aria-hidden="true"/>}
  </button></div>;
}
