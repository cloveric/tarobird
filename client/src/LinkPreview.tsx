import { useEffect, useId, useState } from "react";
import { ChevronDown, ChevronUp, Globe, LoaderCircle, X } from "lucide-react";
import { extractLinks, linkPreviewSchema, type LinkPreview, type LinkPreviewStyle } from "../../src/client-protocol/links.js";
import type { HubConnection } from "./connection.js";
import { t, useLocale } from "./i18n.js";
import { useAttachment } from "./use-attachment.js";

export function selectedPreviewUrl(text: string, choice: string | null | undefined): string | null | undefined {
  const links = extractLinks(text); return choice === null ? null : choice && links.includes(choice) ? choice : links[0];
}
function PreviewCover({ id, connection }: { id: string; connection: HubConnection }) {
  const { url } = useAttachment(connection, id);
  const [failed, setFailed] = useState<string>();
  return url && url !== failed ? <img className="link-preview-cover" src={url} alt="" loading="lazy" onError={() => setFailed(url)}/> : null;
}
type PreviewProps = { url: string; preview?: LinkPreview; connection: HubConnection; style?: LinkPreviewStyle; loading?: boolean };
export function LinkPreviewCard({ url, preview, connection, style = "card", loading = false }: PreviewProps) {
  useLocale();
  const host = new URL(url).hostname;
  const title = preview?.status === "ready" ? preview.title : loading ? t("正在读取网页…") : t("打开原链接");
  if (style === "inline") return <a className="link-preview-card link-preview-inline" data-preview-style={style} href={url} target="_blank" rel="noopener noreferrer" aria-label={t("打开链接：{0}", preview?.title ?? host)} title={url}>
    {loading ? <LoaderCircle size={17} className="spin"/> : <Globe size={17}/>}
    <span className="link-preview-copy"><strong>{title}</strong><span className="link-preview-site">{host}</span></span>
  </a>;
  return <a className="link-preview-card" data-preview-style={style} href={url} target="_blank" rel="noopener noreferrer" aria-label={t("打开链接：{0}", preview?.title ?? host)}>
    <span className="link-preview-copy">
      <span className="link-preview-site">{loading ? <LoaderCircle size={13} className="spin"/> : <Globe size={13}/>}<span>{preview?.siteName && preview.siteName !== host ? `${preview.siteName} · ${host}` : host}</span></span>
      {preview?.status === "ready" ? <><strong>{preview.title}</strong>{preview.description && <span className="link-preview-description">{preview.description}</span>}</> : <span className="link-preview-description">{loading ? t("正在读取网页…") : t("未能读取网页信息，可打开原链接")}</span>}
    </span>
    {preview?.imageAttachmentId && <PreviewCover key={preview.imageAttachmentId} id={preview.imageAttachmentId} connection={connection}/>}
  </a>;
}
export function MessageLinkPreview(props: PreviewProps) {
  useLocale();
  const id = useId(), [readingStyle, setReadingStyle] = useState<LinkPreviewStyle>();
  // Folding is a local reading action; the sender's durable choice stays intact.
  useEffect(() => setReadingStyle(undefined), [props.url, props.style]);
  const style = readingStyle ?? props.style ?? "card";
  return <div className="message-link-preview">
    <div id={id}><LinkPreviewCard {...props} style={style} loading={!props.preview}/></div>
    {props.preview?.status === "ready" && <button type="button" className="link-preview-toggle" aria-expanded={style === "card"} aria-controls={id} onClick={() => setReadingStyle(style === "card" ? "inline" : "card")}>
      {style === "card" ? <ChevronUp size={14}/> : <ChevronDown size={14}/>}{t(style === "card" ? "收起链接详情" : "展开链接详情")}
    </button>}
  </div>;
}
export function DraftLinkPreview({ text, choice, choose, style, conversationId, connection, busy }: { text: string; choice?: string | null; choose: (choice: string | null | undefined) => void; style: LinkPreviewStyle; conversationId: string; connection: HubConnection; busy: boolean }) {
  useLocale();
  const links = extractLinks(text), url = selectedPreviewUrl(text, choice);
  const [result, setResult] = useState<{ url: string; conversationId: string; preview?: LinkPreview }>();
  useEffect(() => {
    if (!url) return;
    let disposed = false; const controller = new AbortController();
    const timer = setTimeout(() => {
      void connection.http("/api/link-preview", { method: "POST", signal: controller.signal, body: JSON.stringify({ conversationId, url }) }).then((data) => {
        const preview = linkPreviewSchema.parse(data);
        if (!disposed && preview.url === url) setResult({ url, conversationId, preview });
      }).catch(() => { if (!disposed) setResult({ url, conversationId }); });
    }, 400);
    const timeout = setTimeout(() => controller.abort(), 10_000);
    return () => { disposed = true; clearTimeout(timer); clearTimeout(timeout); controller.abort(); };
  }, [url, conversationId, connection]);
  if (!links.length) return null;
  if (!url) return <button className="link-preview-restore" type="button" disabled={busy} onClick={() => choose(undefined)}><Globe size={13}/>{t("显示链接预览")}</button>;
  const current = result?.url === url && result.conversationId === conversationId ? result : undefined;
  return <section className="link-preview-draft" aria-label={t("待发送的链接预览")}>
    <header><span>{t("链接预览")}</span>{links.length > 1 && <select disabled={busy} aria-label={t("选择预览链接")} value={url} onChange={(event) => choose(event.target.value)}>{links.map((link, i) => <option key={link} value={link}>{i + 1}. {link}</option>)}</select>}<button className="icon-button" type="button" disabled={busy} aria-label={t("关闭链接预览")} title={t("关闭链接预览")} onClick={() => choose(null)}><X size={14}/></button></header>
    <LinkPreviewCard url={url} preview={current?.preview} connection={connection} style={style} loading={!current}/>
  </section>;
}
