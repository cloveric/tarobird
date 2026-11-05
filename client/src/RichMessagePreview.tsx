import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Image as ImageIcon, Mic } from "lucide-react";
import type { Message } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";
import { FileTypeIcon } from "./FileTypeIcon.js";
import { MarkdownText } from "./MarkdownText.js";
import { messagePreview, type PreviewAttachment } from "./message-preview.js";
import { useAttachment } from "./use-attachment.js";
import { formatFileLimit } from "./files.js";
import { t, useLocale } from "./i18n.js";
import "./message-preview.css";

function PreviewImage({ item, connection }: { item: PreviewAttachment; connection: HubConnection }) {
  const { url } = useAttachment(connection, item.id);
  return url ? <img src={url} alt={item.name ?? t("附件图片")} loading="lazy"/> : <ImageIcon size={18} aria-hidden="true"/>;
}

export function RichMessagePreview({ message, connection }: { message: Message; connection: HubConnection }) {
  useLocale();
  const preview = useMemo(() => messagePreview(message), [message]);
  const [expanded, setExpanded] = useState(false), [overflow, setOverflow] = useState(false);
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null), id = useId();
  useLayoutEffect(() => {
    if (expanded || !viewport.current || !content.current) return;
    const measure = () => setOverflow(content.current!.getBoundingClientRect().height > viewport.current!.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(viewport.current); observer.observe(content.current); measure();
    return () => observer.disconnect();
  }, [expanded, preview]);
  return <div className={`rich-message-preview${expanded ? " is-expanded" : ""}${overflow && !expanded ? " is-clipped" : ""}`}>
    {preview.text && <div ref={viewport} id={id} className="rich-preview-viewport" tabIndex={expanded ? 0 : undefined} role={expanded ? "region" : undefined} aria-label={expanded ? t("消息内容预览") : undefined}>
      <div ref={content} className="rich-preview-content"><MarkdownText text={preview.text} preview/></div>
    </div>}
    {!!preview.attachments.length && <div className="rich-preview-attachments">{(expanded ? preview.attachments : preview.attachments.slice(0, 3)).map((item, i) => <div className={`rich-preview-attachment ${item.type}`} key={item.id} title={item.name}>
      {item.type === "image" && i < 3 ? <PreviewImage item={item} connection={connection}/> : item.type === "image" ? <ImageIcon size={16}/> : item.type === "audio" ? <Mic size={16}/> : <FileTypeIcon name={item.name} mime={item.mime} size={22}/>}
      <span>{item.name ?? (item.type === "audio" ? t("语音消息") : t("附件图片"))}</span>{item.size !== undefined && <small>{formatFileLimit(item.size)}</small>}
    </div>)}{!expanded && preview.attachments.length > 3 && <small>+{preview.attachments.length - 3}</small>}</div>}
    {!preview.text && !preview.attachments.length && <span className="muted">{t("卡片消息")}</span>}
    {preview.truncated && <small className="rich-preview-truncated">{t("预览已截短，请查看原消息。")}</small>}
    {(overflow || expanded || preview.attachments.length > 3) && <button type="button" className="rich-preview-toggle" aria-expanded={expanded} aria-controls={preview.text ? id : undefined} onClick={() => setExpanded(!expanded)}>{expanded ? <ChevronUp size={13}/> : <ChevronDown size={13}/>}<span>{expanded ? t("收起预览") : t("展开预览")}</span></button>}
  </div>;
}
