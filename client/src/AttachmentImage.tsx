import { useMessageReader } from "./message-overlay.js";
import { WorkbenchContext } from "./workbench-context.js";
import { ImageGalleryContext, type GalleryImage } from "./image-gallery.js";
import { ImagePreview } from "./ImagePreview.js";
import { useCallback, useContext, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { exportAttachment, shareAttachment, attachmentSaveLabel, type ExportDelivery, type ExportStage } from "./attachment-export.js";
import { imageExportFilename } from "./image-export.js";
import { RuntimeHostActiveContext } from "./RuntimeHost.js";
import { useAttachment } from "./use-attachment.js";
import { t, useLocale } from "./i18n.js";
import { Copy, Download, ImageOff, SquarePen } from "lucide-react";
import { canCopyImage, copyImage } from "./image-clipboard.js";
import type { HubConnection } from "./connection.js";
import { imageDimensions, imageReservation, rememberImageDimensions, subscribeImageDimensions } from "./image-dimensions.js";

import { DesktopMenu } from "./DesktopMenu.js";
import { nativePlatform } from "./native.js";

export function AttachmentImage({ connection, id, title }: { connection: HubConnection; id: string; title?: string }) {
  useLocale();
  const active = useContext(RuntimeHostActiveContext);
  const workbench = useContext(WorkbenchContext);
  const { url, blob, error, retry } = useAttachment(connection, id);
  const gallery = useContext(ImageGalleryContext);
  const images = gallery.some(image => image.id === id) ? gallery : [{ id, title }];
  const menuId = useId();
  const [menu, setMenu] = useState<{x:number;y:number}>();
  const desktopAction = () => !["ios", "android"].includes(nativePlatform()) && !/Android|iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  useLayoutEffect(() => { setMenu(undefined); }, [connection, id, active]);
  const addToWhiteboard = async () => {
    if (!workbench || !blob || !active || running.current || !desktopAction()) return;
    running.current = true; setSaving(true); setFeedback(undefined); setMenu(undefined);
    const attempt = ++operation.current;
    try { await workbench.openImage(new File([blob], imageExportFilename(title || id, blob.type), {type:blob.type}), id); }
    catch (cause) { if (attempt === operation.current) setFeedback({id,text:cause instanceof Error ? cause.message : t("工作台暂不可用"),error:true}); }
    finally { if (attempt === operation.current) { running.current = false; setSaving(false); } }
  };
  const [selected, setSelected] = useState(id);
  const [saving, setSaving] = useState(false), [feedback, setFeedback] = useState<{ id: string; text: string; error?: boolean }>();
  const operation = useRef(0), running = useRef(false);
  useLayoutEffect(() => { ++operation.current; running.current = false; setSaving(false); setFeedback(undefined); return () => { ++operation.current; }; }, [connection, id]);
  const save = async (action: "save" | "share", image: GalleryImage, blob: Blob) => {
    if (!blob || !active || running.current) return;
    running.current = true; setSaving(true); setFeedback(undefined);
    const attempt = ++operation.current;
    const show = (text: string, error = false) => { if (attempt === operation.current) setFeedback({ id: image.id, text, error }); };
    const stage = (value: ExportStage) => show(value === "choosing" ? t("请选择保存位置…") : value === "saving" ? t("正在保存…") : value === "sharing" ? t("请在系统分享中选择去处") : value === "handoff" ? t("正在交给浏览器下载…") : t("正在准备文件…"));
    let delivery: ExportDelivery | undefined, location: string | undefined;
    try {
      // Export the authenticated original already used by this preview, never
      // a resized thumbnail, canvas encoding, public URL or screenshot.
      const accepted = await (action === "share" ? shareAttachment : exportAttachment)(blob, imageExportFilename(image.title || `${t("图片")}-${image.id.slice(-8)}`, blob.type), {
        stage, delivered: (value, _path, savedLocation) => { delivery = value; location = savedLocation; },
      });
      show(!accepted ? action === "share" ? t("已关闭系统分享") : t("已取消保存") : delivery === "saved" ? location ? t("已保存到 {0}", location) : t("已保存") : delivery === "shared" ? t("已交给系统分享") : delivery === "browser" ? t("已交给浏览器下载") : t("保存结果未确认，请重试。"));
    } catch (cause) { show(cause instanceof Error ? cause.message : t("保存失败，请检查剩余空间和文件权限后重试。"), true); }
    finally { if (attempt === operation.current) { running.current = false; setSaving(false); } }
  };
  // Same clipboard path and wording as the full-size viewer's 复制图片. The
  // write must start inside the menu click so WebKit keeps user activation.
  const copyAttempt = useRef(0), [copyBusy, setCopyBusy] = useState(false);
  useLayoutEffect(() => { ++copyAttempt.current; setCopyBusy(false); }, [connection, id]);
  const copy = () => {
    setMenu(undefined);
    if (!blob || !active || copyBusy || running.current) return;
    const attempt = ++copyAttempt.current;
    const show = (text: string, error = false) => { if (attempt === copyAttempt.current && !running.current) setFeedback({ id, text, error }); };
    setCopyBusy(true); show(t("正在复制图片…"));
    void copyImage(blob).then(() => show(t("图片已复制")), cause => show(t(cause instanceof Error && cause.message === "image_copy_too_large"
      ? "图片过大，无法复制，请另存为。" : "无法复制图片，请重试或另存为。"), true))
      .finally(() => { if (attempt === copyAttempt.current) setCopyBusy(false); });
  };
  const [large, setLarge] = useState(false);
  useMessageReader(active && (large || saving));
  const [dimensions, setDimensions] = useState<{ url: string; width: number; height: number }>();
  const retainedDimensions = useSyncExternalStore(
    useCallback(notify => subscribeImageDimensions(connection, id, notify), [connection, id]),
    useCallback(() => imageDimensions(connection, id), [connection, id]),
  );
  const known = dimensions && dimensions.url === url ? dimensions : retainedDimensions;
  const [failedUrl, setFailedUrl] = useState<string>();
  const decodeFailed = !!url && failedUrl === url;
  const long = known && known.height > known.width * 2;
  const opener = useRef<HTMLButtonElement>(null);
  const close = () => { if (opener.current?.getClientRects().length) opener.current.focus({ preventScroll: true }); setLarge(false); };
  useLayoutEffect(() => { if (!active) setLarge(false); }, [active]);
  return <figure className="attachment-image" data-long={long || undefined} style={known ? { "--image-ratio": known.width / known.height } as CSSProperties : undefined}>
    {decodeFailed ? <div className="image-load-state" role="alert"><ImageOff size={20} aria-hidden="true"/><span>{t("此设备无法预览该文件，请另存为后打开。")}</span>{blob && <button disabled={saving} onClick={() => { void save("save", { id, title }, blob); }}>{attachmentSaveLabel()}</button>}</div> : url || known && !error ? <button ref={opener} className="image-thumbnail" disabled={!url} data-message-hold onContextMenuCapture={event => {
      if (!blob || !active || !desktopAction()) return;
      event.preventDefault(); event.stopPropagation(); setMenu({x:event.clientX,y:event.clientY});
    }} onKeyDownCapture={event => {
      if ((event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) && blob && active && desktopAction()) {
        event.preventDefault(); event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); setMenu({x:rect.left,y:rect.bottom});
      }
    }} aria-label={title ?? t("查看图片")} title={title ?? t("查看图片")} onClick={() => { if (!url) return; setSelected(id); setLarge(true); }}>
      <img src={url ?? imageReservation(known!)} width={known?.width} height={known?.height} alt={url ? title ?? t("附件图片") : ""} loading="lazy" onLoad={event => {
        if (!url) return;
        const image = event.currentTarget;
        rememberImageDimensions(connection, id, { width: image.naturalWidth, height: image.naturalHeight });
        setDimensions({ url, width: image.naturalWidth, height: image.naturalHeight });
      }} onError={() => { if (url) setFailedUrl(url); }}/>
      {!url && <span className="image-thumbnail-loading" role="status">{t("加载图片…")}</span>}
      {long && <span className="long-image-label">{t("长图 · 点击查看")}</span>}
    </button> : <div className="image-load-state" role={error ? "alert" : "status"}>
      {error && <ImageOff size={20} aria-hidden="true"/>}
      <span>{error ? t("图片加载失败") : t("加载图片…")}</span>
      {error && <button type="button" aria-label={t("重新加载图片")} onClick={retry}>{t("重试")}</button>}
    </div>}
    {title && <figcaption title={title}>{title}</figcaption>}
    {menu && active && desktopAction() && <DesktopMenu id={menuId} label={t("图片操作")} open close={() => setMenu(undefined)} trigger={opener} placement="down-start" point={menu} className="image-preview-menu">
      <button type="button" role="menuitem" disabled={!blob || saving || copyBusy || !canCopyImage()} onClick={copy}><Copy size={16}/>{t("复制图片")}</button>
      <button type="button" role="menuitem" disabled={!blob || saving} onClick={() => { setMenu(undefined); if (blob) void save("save", { id, title }, blob); }}><Download size={16}/>{attachmentSaveLabel()}</button>
      {workbench && <><hr/><button type="button" role="menuitem" disabled={saving || !blob} onClick={() => { void addToWhiteboard(); }}><SquarePen size={16}/>{t("放到白板")}</button></>}
    </DesktopMenu>}
    {!large && feedback?.id === id && <small role={feedback.error ? "alert" : "status"}>{feedback.text}</small>}
    {large && active && <ImagePreview connection={connection} original={{ id, url, blob, error, retry }} images={images} selected={selected} select={setSelected} close={close} saving={saving} feedback={feedback} save={(action, image, blob) => { void save(action, image, blob); }}/>}
  </figure>;
}
