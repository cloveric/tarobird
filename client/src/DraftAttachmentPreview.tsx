import { AttachmentPreviewHeader } from "./AttachmentPreviewHeader.js";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { exportAttachment, shareAttachment, openAttachmentExternally, previewAttachment, type AttachmentPreview } from "./attachment-export.js";
import { MediaReader } from "./MediaReader.js";
import { LocalImagePreview } from "./LocalImagePreview.js";
import { DocumentReader, MarkdownReader, SpreadsheetReader } from "./DocumentReader.js";
import { PdfReader } from "./PdfReader.js";
import { useBackAction } from "./back-navigation.js";
import { t } from "./i18n.js";
import { useDialogDrag } from "./dialog-drag.js";

/** Drafts already own the local File. Preview without uploading or changing it. */
export function DraftAttachmentPreview({ file, close, returnFocus }: { file: File; close: () => void; returnFocus: RefObject<HTMLElement | null> }) {
  const panel = useRef<HTMLDialogElement>(null), saving = useRef(false), alive = useRef(true);
  const [preview, setPreview] = useState<AttachmentPreview>(), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  const previewBody = useRef<HTMLElement>(null), previewHeader = useRef<HTMLElement>(null);
  useDialogDrag(previewBody, previewHeader, preview?.kind === "video");
  useBackAction(panel, close, 200);
  useLayoutEffect(() => {
    const node = panel.current;
    node?.showModal();
    return () => { node?.close(); };
  }, [preview?.kind]);
  useEffect(() => () => { if (returnFocus.current?.getClientRects().length) returnFocus.current.focus({ preventScroll: true }); }, [returnFocus]);
  useEffect(() => {
    alive.current = true;
    let disposed = false; setPreview(undefined); setError("");
    void previewAttachment(file, file.name).then(value => { if (!disposed) setPreview(value); }).catch(() => {
      if (!disposed) setError(t("文件读取失败，请重新选择文件。"));
    });
    return () => { disposed = true; alive.current = false; };
  }, [file]);
  const save = async (action: "save" | "share" | "external" = "save") => {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(""); setStatus(t("正在准备…"));
    try {
      const accepted = await (action === "external" ? openAttachmentExternally : action === "share" ? shareAttachment : exportAttachment)(file, file.name, { delivered: (delivery, _path, location) => {
        if (alive.current) setStatus(delivery === "opened" ? t("已打开应用选择器") : delivery === "saved" ? location ? t("已保存到 {0}", location) : t("已保存") : delivery === "shared" ? t("已交给系统分享") : t("已交给浏览器下载"));
      } });
      if (!accepted && alive.current) setStatus("");
    } catch (error) { if (alive.current) { setStatus(""); setError(error instanceof Error ? error.message : t("附件不可用")); } }
    finally { saving.current = false; if (alive.current) setBusy(false); }
  };
  if (preview?.kind === "image") return <LocalImagePreview blob={preview.blob} name={file.name} close={close} saving={busy} save={action => { void save(action); }}
    feedbackKey={error || status} feedback={error ? <span role="alert">{error}</span> : status ? <span role="status">{status}</span> : undefined}/>;
  return createPortal(<dialog ref={panel} className="lightbox file-preview-lightbox draft-attachment-preview" aria-label={t("附件预览")}
    onClose={event => { if (!event.currentTarget.open) close(); }}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }}>
    <section ref={previewBody} className={`file-preview${preview?.kind === "video" ? " is-movable" : ""}`}>
      <AttachmentPreviewHeader headerRef={previewHeader} name={file.name} busy={busy} save={() => { void save(); }} share={() => { void save("share"); }} external={() => { void save("external"); }} close={close}/>
      {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
      {!preview && !error && <p role="status">{t("正在准备预览…")}</p>}
      {preview && (preview.kind === "audio" || preview.kind === "video" ? <MediaReader blob={preview.blob} kind={preview.kind} name={file.name}/>
        : preview.kind === "spreadsheet" ? <SpreadsheetReader blob={preview.blob}/>
        : preview.kind === "docx" ? <DocumentReader blob={preview.blob}/>
        : preview.kind === "pdf" ? <PdfReader blob={preview.blob} name={file.name}/>
        : preview.kind === "markdown" ? <MarkdownReader text={preview.text} truncated={preview.truncated}/>
        : preview.kind === "text" ? <><pre>{preview.text}</pre>{preview.truncated && <p>{t("预览显示前 1 MB，另存为可查看完整文件。")}</p>}</>
        : <p>{t("此文件不支持内置预览，请另存为后使用对应应用打开。")}</p>)}
    </section>
  </dialog>, document.body);
}
