import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Copy, Download, Expand, Maximize, Minimize, MoveHorizontal, Share2, X, ZoomIn, ZoomOut } from "lucide-react";
import { createPortal } from "react-dom";
import { attachmentSaveLabel, canOpenAttachmentExternally } from "./attachment-export.js";
import { useBackAction } from "./back-navigation.js";
import { t, useLocale } from "./i18n.js";
import { acquireDarkNativeStatusBar } from "./appearance.js";
import { useImageView } from "./use-image-view.js";
import { acquireImageViewerImmersive, useImageFullscreen } from "./image-viewer-fullscreen.js";
import { DesktopMenu } from "./DesktopMenu.js";
import { canCopyImage, copyImage } from "./image-clipboard.js";

export type ImageViewerProps = {
  imageKey: string; name: string; url?: string; blob?: Blob; error?: string; retry?: () => void;
  index?: number; count?: number; change?: (offset: number) => void;
  close: () => void; saving?: boolean; save: (action: "save" | "share") => void;
  feedback?: ReactNode; feedbackKey?: string;
};

/** Shared by authenticated message images and already-local draft/file originals. */
export function ImageViewer({ imageKey, name, url, blob, error, retry, index = 0, count = 1, change, close, saving = false, save, feedback, feedbackKey }: ImageViewerProps) {
  useLocale();
  const panel = useRef<HTMLDialogElement>(null), dismiss = useRef<HTMLButtonElement>(null), reader = useRef<HTMLDivElement>(null), canvas = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLSpanElement>(null);
  const [controls, setControls] = useState(true), [decodeError, setDecodeError] = useState<string>();
  const [menu, setMenu] = useState<{ key: string; x: number; y: number }>();
  const [copyStatus, setCopyStatus] = useState<{ key: string; text: string; error?: boolean }>();
  const copying = useRef(false), [copyBusy, setCopyBusy] = useState(false), menuId = useId();
  const [natural, setNatural] = useState<{ key: string; width: number; height: number }>();
  const sourceKey = `${imageKey}\n${url ?? ""}`, currentSource = useRef(sourceKey); currentSource.current = sourceKey;
  const loaded = !!url && natural?.key === sourceKey && decodeError !== sourceKey;
  const details = useId(), closed = useRef(false);
  const view = useImageView({ reader, canvas, imageKey, natural: loaded ? natural : undefined,
    change: offset => change?.(offset), toggleControls: () => setControls(value => !value), dismiss: () => dismissPreview() });
  const fullscreen = useImageFullscreen(panel);
  const dismissPreview = () => {
    if (closed.current) return; closed.current = true; view.stop(); panel.current?.close(); close();
  };
  const menuOpen = menu?.key === sourceKey;
  const closeMenu = () => setMenu(undefined);
  const back = () => { if (menuOpen) { closeMenu(); reader.current?.focus({ preventScroll: true }); } else if (!fullscreen.consumeEscape()) dismissPreview(); };
  useBackAction(panel, back, 200);
  useEffect(() => { closeMenu(); setCopyStatus(undefined); }, [sourceKey]);
  const openMenu = (x: number, y: number) => { view.stop(); setMenu({ key: sourceKey, x, y }); };
  const copy = () => {
    if (!blob || !loaded || copying.current) return;
    const key = sourceKey;
    copying.current = true; setCopyBusy(true); setControls(true); setCopyStatus({ key, text: t("正在复制图片…") });
    void copyImage(blob).then(() => {
      if (!closed.current && currentSource.current === key) setCopyStatus({ key, text: t("图片已复制") });
    }, error => {
      if (!closed.current && currentSource.current === key) setCopyStatus({ key, error: true, text: t(error instanceof Error && error.message === "image_copy_too_large"
        ? "图片过大，无法复制，请另存为。" : "无法复制图片，请重试或另存为。") });
    }).finally(() => { copying.current = false; if (!closed.current) setCopyBusy(false); });
  };
  useLayoutEffect(acquireDarkNativeStatusBar, []);
  // Keep one native canvas for the whole reader. Toggling the toolbar must
  // not resize the WebView/re-fit the photo as system bars appear/disappear.
  useLayoutEffect(acquireImageViewerImmersive, []);
  useLayoutEffect(() => {
    // Start at passive content, not a visibly focused action. Tab below still
    // reaches Close first, while viewer shortcuts work from the title.
    const dialog = panel.current!; dialog.showModal(); heading.current?.focus({ preventScroll: true });
    return () => { closed.current = true; dialog.close(); };
  }, []);
  useEffect(() => { if (feedbackKey || error || decodeError === sourceKey || fullscreen.error) setControls(true); }, [feedbackKey, error, decodeError, sourceKey, fullscreen.error]);
  const showControls = () => { setControls(true); requestAnimationFrame(() => dismiss.current?.focus({ preventScroll: true })); };
  const failure = error || !!url && decodeError === sourceKey;
  return createPortal(<dialog ref={panel} aria-label={t("图片预览")} className="lightbox image-preview-lightbox" data-long={view.long || undefined} data-controls={controls ? "visible" : "hidden"}
    onPointerDownCapture={event => { if ((event.target as HTMLElement).closest("button")) view.stop(); }}
    onClose={event => { if (!event.currentTarget.open) dismissPreview(); }}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); back(); }}
    onKeyDown={event => {
      if (event.defaultPrevented || event.nativeEvent.isComposing) return;
      // A keyboard interaction supersedes a pending touch tap, including Tab
      // into the toolbar and shortcuts that do not change zoom or image.
      view.stop();
      if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) {
        event.preventDefault(); event.stopPropagation(); const bounds = reader.current!.getBoundingClientRect();
        openMenu(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2); return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "c" && !document.getSelection()?.toString()) {
        event.preventDefault(); event.stopPropagation(); copy(); closeMenu(); return;
      }
      if (menuOpen && (event.target as HTMLElement).closest('[role="menu"]')) return;
      if (event.key === "Tab") {
        event.preventDefault();
        if (!controls) { showControls(); return; }
        const nodes = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex='0']")].filter(node => node.getClientRects().length && !node.closest('[aria-hidden="true"]'));
        const current = nodes.indexOf(document.activeElement as HTMLElement), step = event.shiftKey ? -1 : 1;
        nodes[current < 0 ? event.shiftKey ? nodes.length - 1 : 0 : (current + step + nodes.length) % nodes.length]?.focus();
        return;
      }
      if (event.altKey || (event.ctrlKey || event.metaKey) && !["+", "=", "-", "0"].includes(event.key)) return;
      if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation(); view.stop();
        if (view.zoom === 1) change?.(event.key === "ArrowRight" ? 1 : -1);
        else reader.current!.scrollLeft += event.key === "ArrowRight" ? 80 : -80;
      } else if (["+", "=", "-", "0", "f", "F", "h", "H"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation(); view.stop();
        if (event.key === "0") view.reset();
        else if (event.key === "-" ) view.zoomBy(1 / 1.4);
        else if (event.key === "+" || event.key === "=") view.zoomBy(1.4);
        else if (event.key.toLowerCase() === "f" && fullscreen.supported) fullscreen.toggle();
        else if (event.key.toLowerCase() === "h") { setControls(value => !value); reader.current?.focus({ preventScroll: true }); }
      } else if (["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
        event.preventDefault(); view.stop(); const node = reader.current!;
        node.scrollTop = event.key === "Home" ? 0 : event.key === "End" ? node.scrollHeight : node.scrollTop + (event.key === "ArrowUp" || event.key === "PageUp" ? -1 : 1) * (event.key.startsWith("Page") ? node.clientHeight * .8 : 80);
      }
    }}>
    <header className="image-preview-toolbar" aria-hidden={!controls} inert={!controls}>
      <div className="image-preview-actions">
        <button ref={dismiss} type="button" className="lightbox-close" aria-label={t("关闭")} title={t("关闭")} onClick={dismissPreview}><X size={20}/></button>
        <span ref={heading} tabIndex={-1} className="image-preview-title" title={name}>{name}</span>
        <button type="button" disabled={saving || !blob} aria-label={attachmentSaveLabel()} title={attachmentSaveLabel()} onClick={() => save("save")}><Download size={20}/><span>{attachmentSaveLabel()}</span></button>
        {canOpenAttachmentExternally() && <button type="button" disabled={saving || !blob} aria-label={t("分享图片")} title={t("分享图片")} onClick={() => save("share")}><Share2 size={20}/><span>{t("分享")}</span></button>}
        {fullscreen.supported && <button type="button" aria-label={fullscreen.active ? t("退出全屏") : t("全屏")} title={fullscreen.active ? t("退出全屏") : t("全屏")} onClick={fullscreen.toggle}>{fullscreen.active ? <Minimize size={20}/> : <Maximize size={20}/>}</button>}
      </div>
      {feedback && <div className="image-export-status">{feedback}</div>}
      {fullscreen.error && <p className="image-export-status" role="alert">{fullscreen.error}</p>}
      {copyStatus?.key === sourceKey && <p className="image-export-status" role={copyStatus.error ? "alert" : "status"}>{copyStatus.text}</p>}
    </header>
    <div ref={reader} className="image-preview-scroll" tabIndex={0} aria-label={t("完整图片")} aria-describedby={details} data-zoomed={view.zoom > 1 || undefined} {...view.handlers}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); openMenu(event.clientX, event.clientY); }}>
      <div ref={canvas} className="image-preview-canvas" style={{ width: Math.max(view.viewport.width, view.width), height: Math.max(view.viewport.height, view.height) }}>
        {url && decodeError !== sourceKey && <img key={sourceKey} src={url} alt={name} decoding="sync" draggable={false} style={loaded ? { width: view.width, height: view.height } : { visibility: "hidden" }}
          onError={() => { if (currentSource.current === sourceKey) setDecodeError(sourceKey); }}
          onLoad={event => { if (currentSource.current === sourceKey && event.currentTarget.naturalWidth) setNatural({ key: sourceKey, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); }}/>}</div>
      {!loaded && <div className="image-preview-loading" role={failure ? "alert" : "status"}>
        {!failure && <span className="image-preview-spinner" aria-hidden="true"/>}
        <span>{error ? t("图片加载失败") : failure ? t("此设备无法预览该文件，请另存为后打开。") : t("加载图片…")}</span>
        {error && retry && <button type="button" aria-label={t("重新加载图片")} onPointerDown={event => event.stopPropagation()} onClick={retry}>{t("重试")}</button>}
      </div>}
    </div>
    <p id={details} className="image-preview-assistive">{t("触屏轻点图片或空白处隐藏／显示工具栏；鼠标点击图片外空白处关闭。双击图片放大或还原，放大后可拖动。点击关闭按钮、使用系统返回或按 Esc 关闭。")}</p>
    <footer className="image-preview-controls" aria-hidden={!controls} inert={!controls}>
      {count > 1 && <div className="image-preview-navigation">
        <button type="button" aria-label={t("上一张")} title={t("上一张")} disabled={index === 0} onClick={() => change?.(-1)}><ChevronLeft size={20}/></button>
        <span aria-label={t("图片位置")} aria-live="polite">{index + 1} / {count}</span>
        <button type="button" aria-label={t("下一张")} title={t("下一张")} disabled={index === count - 1} onClick={() => change?.(1)}><ChevronRight size={20}/></button>
      </div>}
      <div className="image-preview-magnification">
        <button type="button" className="image-preview-zoom-out" aria-label={t("缩小图片")} title={t("缩小图片")} disabled={!loaded || view.zoom <= 1} onClick={() => view.zoomBy(1 / 1.4)}><ZoomOut size={20}/></button>
        {view.long && <button type="button" aria-label={view.fit === "width" ? t("适应窗口") : t("适应宽度")} title={view.fit === "width" ? t("适应窗口") : t("适应宽度")} disabled={!loaded} onClick={view.toggleFit}>{view.fit === "width" ? <Expand size={19}/> : <MoveHorizontal size={19}/>}</button>}
        <span aria-label={t("缩放比例")}>{loaded ? `${Math.round(view.ratio * view.zoom * 100)}%` : "—"}</span>
        <button type="button" className="image-preview-zoom" aria-label={view.zoom > 1 ? t("还原图片") : t("放大图片")} title={view.zoom > 1 ? t("还原图片") : t("放大图片")} disabled={!loaded} onClick={() => view.toggleZoom()}>{view.zoom > 1 ? <ZoomOut size={20}/> : <ZoomIn size={20}/>}</button>
      </div>
    </footer>
    {menuOpen && <DesktopMenu id={menuId} label={t("图片操作")} open close={closeMenu} trigger={reader} placement="down-start" point={menu} portalTarget={panel.current} className="image-preview-menu">
      <button type="button" role="menuitem" disabled={!loaded || !blob || copyBusy || !canCopyImage()} onClick={copy}><Copy size={16}/>{t("复制图片")}<kbd>{/Mac/.test(navigator.platform) ? "⌘C" : "Ctrl+C"}</kbd></button>
      <button type="button" role="menuitem" disabled={saving || !blob} onClick={() => save("save")}><Download size={16}/>{attachmentSaveLabel()}</button>
      <hr/>
      <button type="button" role="menuitem" disabled={!loaded} onClick={() => view.toggleZoom()}>{view.zoom > 1 ? <ZoomOut size={16}/> : <ZoomIn size={16}/>} {t(view.zoom > 1 ? "还原图片" : "放大图片")}</button>
      {view.long && <button type="button" role="menuitem" disabled={!loaded} onClick={view.toggleFit}><Expand size={16}/>{t(view.fit === "width" ? "适应窗口" : "适应宽度")}</button>}
      {fullscreen.supported && <button type="button" role="menuitem" onClick={fullscreen.toggle}>{fullscreen.active ? <Minimize size={16}/> : <Maximize size={16}/>} {t(fullscreen.active ? "退出全屏" : "全屏")}</button>}
    </DesktopMenu>}
  </dialog>, document.body);
}
