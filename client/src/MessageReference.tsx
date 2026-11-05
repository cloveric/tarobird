import { botLabels } from "./bot-references.js";
import { RichMessagePreview } from "./RichMessagePreview.js";
import type { HubConnection } from "./connection.js";
import { ArrowUpRight, Forward, Reply } from "lucide-react";
import { blocksText, type Message } from "../../src/client-protocol/index.js";
import { t, useLocale } from "./i18n.js";

export function messageExcerpt(message: Message): string {
  const text = blocksText(message.blocks).trim();
  const audio = message.blocks.filter((b) => b.type === "audio").map((b) => b.name ?? t("语音消息"));
  return [text, ...audio].filter(Boolean).join(" · ").slice(0, 180) || t("卡片消息");
}
export function messageAuthor(message: Message, bots: { id: string; name: string }[]): string {
  return botLabels(bots).get(message.authorId) ?? (message.authorType === "user" ? t("我") : "TaroBird");
}
export function MessageReference({ message, original, author, connection, open, available = true }: { message: Message; original?: Message; author?: string; connection: HubConnection; open: () => void; available?: boolean }) {
  useLocale();
  const forward = message.forwardedFrom;
  const enabled = forward ? available : !!original && original.status !== "deleted";
  return <div className={`message-reference ${forward ? "forwarded-message" : "quoted-message"}`}>
    <button type="button" className="message-reference-source" onClick={open} disabled={!enabled}
      aria-label={forward ? t("查看转发来源") : t("查看引用原消息")}
      title={enabled ? t("点击定位原消息") : t("原消息已删除或当前不可访问")}>
      {forward ? <Forward size={14}/> : <Reply size={14}/>}
      <span><strong>{forward ? t("转发自 {0}", forward.authorName) : t("回复 {0}", author ?? "")}</strong>{forward && <><span>{forward.conversationTitle}</span><small>{new Date(forward.createdAt).toLocaleString()}</small></>}{!enabled && <span>{t("原消息已删除或当前不可访问")}</span>}</span>
      {enabled && <ArrowUpRight size={14}/>}
    </button>
    {!forward && enabled && original && <RichMessagePreview key={original.id} message={original} connection={connection}/>}
  </div>;
}
