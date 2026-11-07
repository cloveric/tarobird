import { InlineAudioControls } from "./InlineAudioControls.js";
import { WorkbenchChartEntry } from "./WorkbenchEntry.js";
import { nativePlatform } from "./native.js";
import { Report } from "./Report.js";
import { readWidget, readReport } from "../../src/client-protocol/widget.js";
import { MessageOverlayOwnerContext, useMessageReader } from "./message-overlay.js";
import { ImageGalleryContext, galleryImages, messageImages } from "./image-gallery.js";
import { backgroundTaskNotice } from "../../src/client-protocol/background-task.js";
import { BackgroundReport, isBackgroundReport } from "./BackgroundReport.js";
import { BackgroundTaskReference, type BackgroundSource } from "./BackgroundTaskReference.js";
import { RunPresentation } from "./RunPresentation.js";
import { QueueNotice } from "./QueueNotice.js";
import { queueNotice } from "../../src/client-protocol/queue-notice.js";
import { anyRun } from "../../src/client-protocol/run.js";
import { AttachmentPreviewHeader } from "./AttachmentPreviewHeader.js";
import { AttachmentImage } from "./AttachmentImage.js";
import { remembersSavedAttachments, restoreSavedAttachment, savedAttachmentKey } from "./android-saved-attachment.js";
import { VideoThumbnail } from "./VideoThumbnail.js";
import { fileKind } from "./file-kind.js";
import { useAttachment } from "./use-attachment.js";
import { useMessageExport } from "./message-export.js";
import { SteeringReceipt } from "./Steering.js";
import { QuestionForm, nativeQuestionData } from "./QuestionForm.js";
import { questionDraftKey } from "./question-draft.js";
import { MessageLinkPreview } from "./LinkPreview.js";
import { cardLayoutStyle } from "./card-layout.js";
import { MarkdownText } from "./MarkdownText.js";
import { selectMessageBubble } from "./message-text-selection.js";
import "./message-text-selection.css";
import { t, useLocale } from "./i18n.js";
import { createPortal } from "react-dom";
import { lazy, Suspense, memo, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { RuntimeHostActiveContext } from "./RuntimeHost.js";
import { useBackAction } from "./back-navigation.js";
import { useDialogDrag } from "./dialog-drag.js";
import { FileTypeIcon } from "./FileTypeIcon.js";
import { Check, ChevronDown, Download, FileText, FolderOpen, LoaderCircle } from "lucide-react";
import type { Block, CardElement, Json, Message } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";
import "katex/dist/katex.min.css";
import { exportAttachment, shareAttachment, attachmentSaveLabel, openAttachmentExternally, canOpenAttachmentExternally, openSavedAttachment, revealSavedAttachment, canRevealSavedAttachment, isAndroidApk, previewAttachment, type AttachmentPreview, type ExportDelivery, type ExportStage } from "./attachment-export.js";
import { formatFileLimit } from "./files.js";
import type { AttachmentSource } from "./download-buffer.js";
import "./message-media.css";
const Widget = lazy(() => import("./Widget.js").then(module => ({ default: module.Widget })));
import { MediaReader } from "./MediaReader.js";
import { LocalImagePreview } from "./LocalImagePreview.js";
import { PdfReader } from "./PdfReader.js";
import { DocumentReader, MarkdownReader, SpreadsheetReader } from "./DocumentReader.js";
import { voiceCardElements } from "../../src/client-protocol/voice-presentation.js";
import { VoiceTranscript, voiceTranscriptElement } from "./VoiceTranscript.js";
import "./file-delivery.css";

export function GoogleExport({ connection, messageId }: { connection: HubConnection; messageId: string }) {
  useLocale();
  const { exported, send } = useMessageExport(connection, messageId);
  const { busy, url, error } = exported ?? {};
  return <><button aria-label={t("导出到 Google 文档")} title={t("导出到 Google 文档")} disabled={busy} onClick={() => { void send(); }}>{busy ? <LoaderCircle size={13} className="spin"/> : <FileText size={13}/>}</button>{url && <a href={url} target="_blank" rel="noopener noreferrer">{t("打开 Google 文档")}</a>}{error && <span role="alert" className="error-text">{error}</span>}</>;
}

function Audio({ connection, id }: { connection: HubConnection; id: string }) {
  useLocale(); const active = useContext(RuntimeHostActiveContext);
  const { url, blob, error, deleted, retry } = useAttachment(connection, id);
  const phone = useSyncExternalStore(subscribePhone, snapshotPhone), platform = nativePlatform();
  const customControls = platform === "macos" || platform === "windows" || platform === "web" && !phone;
  const media = useRef<HTMLAudioElement>(null), epoch = useRef(0), savingRef = useRef(false);
  const [playing, setPlaying] = useState(false), [failedUrl, setFailedUrl] = useState<string>();
  const [saving, setSaving] = useState(false), [feedback, setFeedback] = useState<string>();
  useMessageReader(active && (playing || saving));
  useLayoutEffect(() => { ++epoch.current; savingRef.current = false; setSaving(false); setFeedback(undefined); return () => { ++epoch.current; }; }, [connection, id]);
  useEffect(() => { if (!active) { media.current?.pause(); setPlaying(false); } }, [active]);
  useEffect(() => { const element = media.current; setPlaying(false); return () => { element?.pause(); }; }, [url]);
  const failed = !!url && failedUrl === url;
  const save = async () => {
    if (!blob || !active || savingRef.current) return;
    const attempt = epoch.current; savingRef.current = true; setSaving(true); setFeedback(undefined);
    const extension = ({ "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/ogg": "ogg", "audio/flac": "flac", "audio/webm": "webm" } as Record<string, string>)[blob.type.split(";", 1)[0]!] ?? "bin";
    const show = (text: string) => { if (attempt === epoch.current) setFeedback(text); };
    try {
      const accepted = await exportAttachment(blob, `audio-${id.slice(-8)}.${extension}`, { delivered: delivery => show(delivery === "saved" ? t("已保存") : t("已交给浏览器下载")) });
      if (!accepted) show(t("已取消保存"));
    } catch { show(t("保存失败，请检查剩余空间和文件权限后重试。")); }
    finally { if (attempt === epoch.current) { savingRef.current = false; setSaving(false); } }
  };
  return <div className="attachment-audio">{failed ? <div role="alert"><span>{t("此设备无法预览该文件，请另存为后打开。")}</span><button disabled={saving} onClick={() => { void save(); }}>{attachmentSaveLabel()}</button></div>
    : url ? <><audio ref={media} controls={!customControls} className={customControls ? "inline-audio-source" : undefined} aria-hidden={customControls || undefined} tabIndex={customControls ? -1 : undefined} src={url} onPlay={event => { if (active) setPlaying(true); else event.currentTarget.pause(); }} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => { setPlaying(false); setFailedUrl(url); }}/>{customControls && <InlineAudioControls key={url} media={media} playing={playing} active={active}/>}</>
    : <span role={error && !deleted ? "alert" : "status"}>{deleted ? t("附件已删除") : error ? t("音频加载失败") : t("加载音频…")}{error && !deleted && <button onClick={retry}>{t("重试")}</button>}</span>}{feedback && <small role="status">{feedback}</small>}</div>;
}
/** One file action step at a time. Only the download step can be cancelled; a
 * user's cancel is a neutral result; only a completed native write/export reads "saved". */
type FilePhase = { kind: "idle" } | { kind: "download"; progress: number; recovering: boolean } | { kind: "preview" } | { kind: ExportStage }
  | { kind: "done"; delivery: ExportDelivery; location?: string } | { kind: "cancelled"; step: "download" | "save" | "share"; retained?: boolean } | { kind: "error"; message: string; retry: "open" | "save" | "share" | "external" };
function fileStatusText(phase: Exclude<FilePhase, { kind: "idle" }>): string {
  switch (phase.kind) {
    case "download": return phase.recovering ? t("连接中断，等待恢复…") : phase.progress >= 1 ? t("正在完成下载…") : t("下载中 {0}%", Math.floor(phase.progress * 100));
    case "preview": return t("正在准备预览…");
    case "choosing": return t("请选择保存位置…");
    case "saving": return t("正在保存…");
    case "preparing": return t("正在准备文件…");
    case "sharing": return t("请在系统分享中选择去处");
    case "opening": return t("请在系统中选择阅读应用");
    case "handoff": return t("正在交给浏览器下载…");
    case "done": return phase.delivery === "opened" ? t("已打开应用选择器") : phase.delivery === "saved" ? remembersSavedAttachments() ? t("已保存到手机") : phase.location ? t("已保存到 {0}", phase.location) : t("已保存") : phase.delivery === "shared" ? t("已交给系统分享") : t("已交给浏览器下载");
    case "cancelled": return phase.step === "download" ? phase.retained ? t("下载已取消，进度已暂存") : t("下载已取消") : phase.step === "share" ? t("已关闭系统分享") : t("已取消保存");
    case "error": return phase.message;
  }
}
type SavedFile = { path: string; location?: string; scope?: string; apk?: boolean; action?: "open" | "reveal"; error?: string };
function FileStatusMessage({ phase }: { phase: FilePhase }) {
  if (phase.kind === "idle") return null;
  const tone = phase.kind === "error" ? "error" : phase.kind === "done" && phase.delivery === "saved" ? "done" : undefined;
  return <div className="file-status-message" data-tone={tone}>
    {(phase.kind === "preview" || phase.kind === "saving" || phase.kind === "preparing" || phase.kind === "handoff") && <LoaderCircle className="spin" size={14} aria-hidden="true"/>}
    {tone === "done" && <Check size={14} aria-hidden="true"/>}
    <small role={phase.kind === "error" ? "alert" : "status"}>{fileStatusText(phase)}</small>
  </div>;
}
function FileStatus({ phase, cancel, retry, saved, openSaved, revealSaved, className, primaryActions, hideMessage }: { phase: FilePhase; cancel: () => void; retry: (action: "open" | "save" | "share" | "external") => void; saved?: SavedFile; openSaved: () => void; revealSaved: () => void; className?: string; primaryActions?: ReactNode; hideMessage?: boolean }) {
  if (phase.kind === "idle" && !primaryActions) return null;
  const tone = phase.kind === "error" ? "error" : phase.kind === "done" && phase.delivery === "saved" ? "done" : undefined;
  return <div className={className ? `file-status ${className}` : "file-status"} data-tone={tone} data-local-file={!!saved || undefined}>
    {phase.kind === "download" && <div className="file-progress" data-paused={phase.recovering || undefined} aria-hidden="true"><div style={{ transform: `scaleX(${Math.min(1, Math.max(0, phase.progress))})` }}/></div>}
    {!hideMessage && <FileStatusMessage phase={phase}/>}
    {(primaryActions || phase.kind === "download" || phase.kind === "error" || saved && ["done", "cancelled", "error"].includes(phase.kind)) && <div className="file-status-actions">
      {primaryActions && <div className="file-primary-actions">{primaryActions}</div>}
      {phase.kind === "download" && <button onClick={cancel}>{t("取消下载")}</button>}
      {phase.kind === "error" && <button onClick={() => retry(phase.retry)}>{t("重试")}</button>}
      {saved && ["done", "cancelled", "error"].includes(phase.kind) && <div className="file-saved-actions">
        <button aria-disabled={!!saved.action || undefined} title={saved.apk ? t("打开系统安装器") : t("用系统默认应用打开")} onClick={openSaved}>{saved.action === "open" ? t("正在打开…") : saved.apk ? t("安装 APK") : t("打开文件")}</button>
        {canRevealSavedAttachment() && <button className="file-status-reveal" aria-disabled={!!saved.action || undefined} title={t("打开文件位置")} aria-label={saved.action === "reveal" ? t("正在定位…") : t("打开文件位置")} onClick={revealSaved}>{saved.action === "reveal" ? <LoaderCircle className="spin" size={16} aria-hidden="true"/> : <FolderOpen size={16} aria-hidden="true"/>}</button>}
      </div>}
    </div>}
    {saved?.error && <small role="alert" className="file-open-error">{saved.error}</small>}
  </div>;
}
const phoneQuery = () => matchMedia("(max-width:760px)");
const subscribePhone = (notify: () => void) => { const query = phoneQuery(); query.addEventListener("change", notify); return () => query.removeEventListener("change", notify); };
const snapshotPhone = () => phoneQuery().matches;
export function AttachmentFile({ connection, block, list = false }: { connection: HubConnection; block: Extract<Block, { type: "file" }>; list?: boolean }) {
  useLocale();
  const active = useContext(RuntimeHostActiveContext), activeRef = useRef(active);
  const previewEpoch = useRef(0), opening = useRef(false);
  const phone = useSyncExternalStore(subscribePhone, snapshotPhone);
  const sizeId = useId();
  const thumbnail = !list && fileKind(block.name, block.mime).kind === "video";
  const [phase, setPhase] = useState<FilePhase>({ kind: "idle" }); const [preview, setPreview] = useState<AttachmentPreview>();
  const savedKey = savedAttachmentKey(connection.identity, block.attachmentId);
  const [savedRecord, setSaved] = useState<SavedFile>();
  const saved = savedRecord?.scope === savedKey ? savedRecord : undefined;
  // `running` spans the whole action, not only its download, so a second tap never
  // starts a parallel save. `source` holds the previewed bytes for 另存为 in the preview.
  const running = useRef(false), alive = useRef(true), download = useRef<AbortController | null>(null), source = useRef<AttachmentSource | undefined>(undefined);
  const downloadAttempt = useRef(0), actionRevision = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; download.current?.abort(); void source.current?.dispose(); source.current = undefined; }; }, []);
  const show = (next: FilePhase | ((current: FilePhase) => FilePhase)) => { if (alive.current) setPhase(next); };
  useEffect(() => {
    if (!savedKey || !active) return;
    let disposed = false, check = 0;
    const restore = async () => {
      if (document.visibilityState === "hidden" || running.current) return;
      const revision = actionRevision.current, attempt = ++check;
      const receipt = await restoreSavedAttachment(savedKey);
      if (disposed || !alive.current || attempt !== check || revision !== actionRevision.current || running.current || receipt === undefined) return;
      setSaved(receipt ? { ...receipt, scope: savedKey, apk: isAndroidApk(block.name) } : undefined);
      if (!receipt) setPhase(current => current.kind === "done" && current.delivery === "saved" ? { kind: "idle" } : current);
    };
    void restore(); document.addEventListener("visibilitychange", restore);
    return () => { disposed = true; document.removeEventListener("visibilitychange", restore); };
  }, [savedKey, active, block.name]);
  const panel = useRef<HTMLDialogElement>(null);
  const previewBody = useRef<HTMLElement>(null), previewHeader = useRef<HTMLElement>(null);
  useDialogDrag(previewBody, previewHeader, preview?.kind === "video" && active);
  const opener = useRef<HTMLButtonElement>(null);
  const backdropPress = useRef(false);
  useLayoutEffect(() => {
    activeRef.current = active;
    if (active) return;
    previewEpoch.current++;
    if (opening.current) download.current?.abort();
    panel.current?.close(); setPreview(undefined);
    void source.current?.dispose(); source.current = undefined;
  }, [active]);
  // Close, Escape, the backdrop and native back always close the preview, even
  // mid-save: the save continues and its status returns to the file card.
  const close = () => {
    // Close before React removes the dialog; removing an open dialog alone
    // leaves keyboard focus on body. Restore explicitly for pointer-opened Safari.
    panel.current?.close(); opener.current?.focus({ preventScroll: true });
    void source.current?.dispose(); source.current = undefined; setPreview(undefined);
  };
  useBackAction(panel, close, 200);
  useEffect(() => {
    const dialog = panel.current; if (!preview || !dialog) return;
    // The platform modal owns focus, makes the covered chat inert and restores
    // the opener when it closes. CSS overlays alone do none of these things.
    dialog.showModal(); return () => { dialog.close(); };
  }, [preview]);
  const fetchSource = async (): Promise<AttachmentSource | undefined> => {
    const attempt = ++downloadAttempt.current;
    const controller = new AbortController(); download.current = controller; show({ kind: "download", progress: 0, recovering: false });
    try {
      const result = await connection.file(block.attachmentId, { signal: controller.signal,
        progress: (progress) => show((current) => current.kind === "download" ? { ...current, progress } : current),
        recovering: (recovering) => show((current) => current.kind === "download" ? { ...current, recovering } : current) });
      if (!controller.signal.aborted) return result;
      await result.dispose();
    } catch (error) { if (!controller.signal.aborted) throw error; } finally { download.current = null; }
    show({ kind: "cancelled", step: "download" });
    // Cancellation is immediate even if IndexedDB is busy. A delayed lookup
    // must not overwrite a newer action on this card after the user retries.
    void connection.downloadCheckpoints?.load(block.attachmentId).then((saved) => {
      if (attempt === downloadAttempt.current) show((current) => current.kind === "cancelled" && current.step === "download" ? { ...current, retained: !!saved } : current);
    }).catch(() => undefined);
    return undefined;
  };
  const run = async (action: "open" | "save" | "share" | "external") => {
    if (running.current || !activeRef.current) return; running.current = true; actionRevision.current++;
    const epoch = previewEpoch.current; opening.current = action === "open";
    // Desktop saves may truncate the previous target. Android creates a new
    // public copy, so cancelling another save must preserve the previous one.
    if (action === "save" && !remembersSavedAttachments()) setSaved(undefined);
    const seen: { stage?: ExportStage; delivery?: ExportDelivery; location?: string } = {};
    let acquired: AttachmentSource | undefined;
    try {
      acquired = (action !== "open" ? source.current?.retain() : undefined) ?? await fetchSource(); if (!acquired || !alive.current) return;
      const blob = acquired.blob;
      if (action === "open") {
        if (!activeRef.current || epoch !== previewEpoch.current) return;
        show({ kind: "preview" }); const next = await previewAttachment(blob, block.name); if (!alive.current) return;
        if (!activeRef.current || epoch !== previewEpoch.current) { show({ kind: "idle" }); return; }
        void source.current?.dispose(); source.current = acquired.retain(); setPreview(next); setPhase({ kind: "idle" }); return;
      }
      // The first stage is reported synchronously, so the finished download's cancel never stays on screen.
      const accepted = await (action === "external" ? openAttachmentExternally : action === "share" ? shareAttachment : exportAttachment)(blob, block.name, { browserLock: acquired.browserLock, savedKey, stage: (stage) => { seen.stage = stage; show({ kind: stage }); }, delivered: (delivery, savedPath, savedLocation) => { seen.delivery = delivery; seen.location = savedLocation; if (alive.current && delivery === "saved" && savedPath) setSaved({ path: savedPath, location: savedLocation, scope: savedKey, apk: isAndroidApk(block.name) }); } });
      show(!accepted ? { kind: "cancelled", step: seen.stage === "sharing" ? "share" : seen.stage === "handoff" ? "download" : "save" } : seen.delivery ? { kind: "done", delivery: seen.delivery, location: seen.location } : { kind: "idle" });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("附件不可用");
      // Desktop writes are not atomic: a failure after the file was chosen can leave part of it behind.
      show({ kind: "error", message: seen.stage === "saving" ? t("{0}所选位置可能留下不完整的文件。", message) : message, retry: action });
    } finally { await acquired?.dispose(); running.current = false; opening.current = false; }
  };
  const accessSaved = async (action: "open" | "reveal") => {
    if (running.current || !saved || !activeRef.current) return; running.current = true; actionRevision.current++;
    const { action: _previousAction, error: _previousError, ...receipt } = saved; setSaved({ ...receipt, action });
    try { await (action === "open" ? openSavedAttachment : revealSavedAttachment)(receipt.path); if (alive.current) setSaved(receipt); }
    catch (error) { if (alive.current) setSaved({ ...receipt, error: (error as Error).message }); }
    finally { running.current = false; }
  };
  const busy = !!saved?.action || !(phase.kind === "idle" || phase.kind === "done" || phase.kind === "cancelled" || phase.kind === "error") || undefined;
  useMessageReader(active && (!!preview || !!busy));
  const feedbackPhase: FilePhase = phase.kind === "idle" && saved ? { kind: "done", delivery: "saved", location: saved.location } : phase;
  const status = (className?: string, primaryActions?: ReactNode) => <FileStatus primaryActions={primaryActions} hideMessage={!!primaryActions} phase={preview && primaryActions ? { kind: "idle" } : feedbackPhase} saved={preview && primaryActions ? undefined : saved} openSaved={() => { void accessSaved("open"); }} revealSaved={() => { void accessSaved("reveal"); }} className={className} cancel={() => download.current?.abort()} retry={(action) => { void run(action); }}/>;
  const documentCard = !phone && !list && !thumbnail;
  const saveButton = <button className="file-card-save" aria-disabled={busy} aria-label={canOpenAttachmentExternally() ? t("保存到手机 {0}", block.name) : t("另存为 {0}", block.name)} title={attachmentSaveLabel()} onClick={() => { void run("save"); }}><Download size={18}/></button>;
  return <><section className={`file-card${thumbnail ? " has-video-thumbnail" : ""}${documentCard ? " is-document" : ""}`} aria-label={block.name}>{documentCard ? <>
    <div className="file-card-identity"><FileTypeIcon name={block.name} mime={block.mime}/><div className="file-card-info"><strong>{block.name}</strong><div className="file-card-meta"><small>{formatFileLimit(block.size)}</small>{!preview && <FileStatusMessage phase={feedbackPhase}/>}</div></div></div>
    {status("file-card-toolbar", <><button ref={opener} aria-disabled={busy} onClick={() => { void run("open"); }}>{t("预览")}</button>{saveButton}</>)}
  </> : <>
    {thumbnail ? <><VideoThumbnail connection={connection} id={block.attachmentId} name={block.name} size={block.size} busy={busy} source={preview?.kind === "video" ? preview.blob : undefined} opener={opener} open={() => { void run("open"); }}/><span><strong>{block.name}</strong><small id={sizeId}>{formatFileLimit(block.size)}</small></span></> : <button className="file-card-primary" data-message-hold ref={opener} aria-label={t("预览 {0}", block.name)} aria-describedby={sizeId} aria-disabled={busy} onClick={() => { void run("open"); }}><FileTypeIcon name={block.name} mime={block.mime}/><span><strong>{block.name}</strong><small id={sizeId}>{formatFileLimit(block.size)}</small></span></button>}
    {saveButton}{!preview && status()}
  </>}</section>{preview && active && (preview.kind === "image" ? <LocalImagePreview blob={preview.blob} name={block.name} close={close} saving={busy} save={action => { void run(action); }} feedbackKey={phase.kind === "idle" ? saved?.path : fileStatusText(phase)} feedback={phase.kind !== "idle" || saved ? status("file-preview-status") : undefined}/> : createPortal(<dialog ref={panel} className="lightbox file-preview-lightbox" aria-label={t("文件预览")} onCancel={(event) => { event.preventDefault(); event.stopPropagation(); close(); }} onPointerDown={(event) => { backdropPress.current = event.isPrimary && event.target === event.currentTarget; }} onPointerUp={(event) => { if (event.target !== event.currentTarget) backdropPress.current = false; }} onPointerCancel={() => { backdropPress.current = false; }} onClick={(event) => { if (backdropPress.current && event.target === event.currentTarget) close(); backdropPress.current = false; }}><section ref={previewBody} className={`file-preview${preview.kind === "video" ? " is-movable" : ""}`} onClick={(event) => event.stopPropagation()}><AttachmentPreviewHeader headerRef={previewHeader} name={block.name} busy={busy} save={() => { void run("save"); }} share={() => { void run("share"); }} external={() => { void run("external"); }} close={close}/>{status("file-preview-status")}{preview.kind === "audio" || preview.kind === "video" ? <MediaReader blob={preview.blob} kind={preview.kind} name={block.name} connection={connection} attachmentId={block.attachmentId}/> : preview.kind === "spreadsheet" ? <SpreadsheetReader blob={preview.blob}/> : preview.kind === "docx" ? <DocumentReader blob={preview.blob}/> : preview.kind === "markdown" ? <MarkdownReader text={preview.text} truncated={preview.truncated}/> : preview.kind === "text" ? <><pre>{preview.text}</pre>{preview.truncated && <p>{t("预览显示前 1 MB，另存为可查看完整文件。")}</p>}</> : preview.kind === "pdf" ? <PdfReader blob={preview.blob} name={block.name}/> : <p>{t("此文件不支持内置预览，请另存为后使用对应应用打开。")}</p>}</section></dialog>, document.body))}</>;
}
type ElementProps = { replyProse?: boolean; element: CardElement; connection: HubConnection; messageId: string; values: Record<string, Json>; change: (name: string, value: Json) => void; act: (element: CardElement, overrides?: Record<string, Json>) => Promise<boolean> };
function Element({ element: e, connection, messageId, values, change, act, replyProse = false }: ElementProps) {
  useLocale();
  // Nested form/process content retains its own typography.
  const children = e.children?.map((child, i) => <Element key={child.id ?? i} element={child} connection={connection} messageId={messageId} values={values} change={change} act={act}/>);
  const style = cardLayoutStyle(e);
  switch (e.type) {
    case "markdown": return <div className="card-text" style={style}><MarkdownText text={e.text ?? ""} reply={replyProse}/></div>;
    case "divider": return <hr style={style}/>;
    case "columns": return <div className="card-columns" style={style}>{children}</div>;
    case "column": return <div className="card-column" style={style}>{children}</div>;
    case "buttonGroup": return <div className="button-group" style={style}>{children}</div>;
    case "collapsible": return <details className="card-collapse" open={e.open || undefined} style={style}><summary data-disclosure-icon><ChevronDown size={14} aria-hidden="true"/><MarkdownText text={e.text ?? t("详情")}/></summary><div className="collapse-body" style={{ rowGap: style.rowGap }}>{children}</div></details>;
    case "icon": return <span className="standard-icon" aria-hidden="true">{e.text?.includes("loading") ? <LoaderCircle size={16} className="spin"/> : <ChevronDown size={16}/>}</span>;
    case "image": return e.attachmentId ? <AttachmentImage connection={connection} id={e.attachmentId} title={e.text}/> : null;
    case "button": return <button className={`card-button ${e.style ?? "default"}`} disabled={e.disabled} style={style} onClick={() => { if (e.confirm && !window.confirm(`${e.confirm.title}\n${e.confirm.text}`)) return; if (e.url && /^https?:\/\//i.test(e.url)) { window.open(e.url, "_blank", "noopener,noreferrer"); return; } act(e); }}>{e.text ?? t("确认")}</button>;
    case "form": { const data = nativeQuestionData(e); return data ? <QuestionForm key={questionDraftKey(messageId, data)} data={data} element={e} connection={connection} messageId={messageId} values={values} act={act}/> : <div className="card-form" style={style}>{children}</div>; }
    case "input": {
      // Unnamed inputs are keyed by actionId, as in defaults, validation and submit.
      const key = e.name ?? e.actionId ?? ""; const current = values[key];
      return <label className="card-field" style={style}>{e.text}<input name={e.name} disabled={e.disabled} required={e.required} placeholder={typeof e.extra?.placeholder === "object" && e.extra.placeholder && "content" in e.extra.placeholder ? String(e.extra.placeholder.content) : t("请输入")} value={typeof current === "string" ? current : String(e.extra?.default_value ?? "")} onChange={(event) => change(key, event.target.value)}/></label>;
    }
    case "select": {
      const key = e.name ?? e.actionId ?? ""; const current = values[key] ?? (e.multiple ? e.extra?.initial_options ?? [] : e.extra?.initial_option ?? "");
      if (e.multiple) return <fieldset className="multi-select" style={style} disabled={e.disabled}><legend>{e.text ?? t("可多选")}{e.min !== undefined && t(" · 至少 {0} 项", e.min)}{e.max !== undefined && t(" · 最多 {0} 项", e.max)}</legend>{e.options?.map((o) => <label key={o.value}><input type="checkbox" checked={Array.isArray(current) && current.includes(o.value)} onChange={(event) => { const selected = Array.isArray(current) ? current.filter((v) => v !== o.value) : []; const next = event.target.checked ? [...selected, o.value] : selected; change(key, next); if (e.value !== undefined) act(e, { [key]: next }); }}/>{o.label}</label>)}</fieldset>;
      return <label className="card-field" style={style}>{e.text}<select name={e.name} disabled={e.disabled} required={e.required} value={typeof current === "string" ? current : ""} onChange={(event) => { change(key, event.target.value); if (e.value !== undefined) act(e, { [key]: event.target.value }); }}><option value="">{t("请选择")}</option>{e.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>;
    }
  }
}
function Card({ block, connection, message, backgroundSource, caption }: { caption?: string; backgroundSource?: BackgroundSource; block: Extract<Block, { type: "card" }>; connection: HubConnection; message: Message }) {
  useLocale();
  const elements = voiceCardElements(block.elements);
  const transcript = voiceTranscriptElement(elements);
  const [edits, setValues] = useState<Record<string, Json>>({}); const [error, setError] = useState("");
  const values: Record<string, Json> = {};
  const defaults = (elements: CardElement[]) => { for (const e of elements) { const key = e.name ?? e.actionId; const value = e.extra?.default_value ?? e.extra?.initial_options ?? e.extra?.initial_option; if (key && value !== undefined) values[key] = value; defaults(e.children ?? []); } }; defaults(block.elements); Object.assign(values, edits);
  const act = async (element: CardElement, overrides: Record<string, Json> = {}): Promise<boolean> => { try {
    const submitted = { ...values, ...overrides };
    const validate = (elements: CardElement[]) => { for (const e of elements) { const value = submitted[e.name ?? e.actionId ?? ""];
      if (e.required && (!value || Array.isArray(value) && !value.length)) throw new Error(t("请填写所有必填项"));
      if (e.multiple && e.name) { const other = submitted[`${e.name}_other`]; const n = (Array.isArray(value) ? value.length : 0) + (typeof other === "string" && other.trim() ? 1 : 0); if (e.min !== undefined && n > 0 && n < e.min || e.max !== undefined && n > e.max) throw new Error(t("所选数量不符合要求")); } validate(e.children ?? []);
    } }; if (element.extra?.form_action_type === "submit") validate(block.elements);
    await connection.send({ v: 1, type: "interaction.submit", conversationId: message.conversationId, messageId: message.id, actionId: element.actionId ?? "", values: submitted, clientActionId: `action_${crypto.randomUUID()}` }); setError(""); return true;
  } catch (e: unknown) { setError(e instanceof Error ? e.message : t("提交失败")); return false; } };
  const queued = queueNotice(block, message);
  if (queued) return <QueueNotice notice={queued} message={message} connection={connection} act={act} error={error} detail={block.elements[0]?.text}/>;
  // The existing image batch constructor alternates caption markdown and images.
  // Recognize only that complete shape, so prose in ordinary cards keeps its layout.
  const images = galleryImages(elements);
  // Run/continuation cards retain streaming_mode: false when complete. Use its
  // presence (not the current status or text) so folding and history remounts
  // keep the same reading column. Ordinary short receipts still hug content.
  const config = block.extra?.config;
  const reply = config !== null && typeof config === "object" && !Array.isArray(config) && typeof config.streaming_mode === "boolean";
  const questions = elements.flatMap(element => { const data = nativeQuestionData(element); return data ? data.questions : []; });
  const background = message.authorType === "bot" ? backgroundTaskNotice(block) : undefined;
  const repeatedQuestionTitle = questions.length > 0 && (!!block.title && (/^(?:问题|Question)\s*\d+$/i.test(block.title.trim()) || questions.some(question => question.header.trim() === block.title!.trim())));
  // Match the existing producer's receipt signature so saved submissions also
  // use status-sized text. Other card titles and the answer body keep their type.
  const submittedAnswer = (block.summary === "已提交" || block.summary === "Submitted") && block.title === `✅ ${block.summary}`;
  return <section className={`rich-card template-${block.template ?? "default"}${reply || background ? " reply-card" : ""}`}>
    {block.title && !repeatedQuestionTitle && !(elements.length === 1 && elements[0]?.type === "markdown" && elements[0].text?.trim() === block.title.trim()) && <header className="card-header" style={submittedAnswer ? { fontSize: 12 } : undefined}>{block.title}</header>}
    <div className="card-body" style={cardLayoutStyle({ type: "column", layout: block.layout })}>{caption?.trim() && <div className="card-text"><MarkdownText text={caption} reply={message.authorType === "bot"}/></div>}{images && images.length > 1 ? <div className="image-grid" aria-label={t("图片批次")}>{images.map((image, i) => <AttachmentImage key={`${image.id}:${i}`} connection={connection} id={image.id} title={image.title}/>)}</div> : elements.map((element, i) => background && element.id === "background_context" ? <BackgroundTaskReference key={element.id} notice={background} message={message} source={backgroundSource}/> : element === transcript ? <VoiceTranscript key={element.id ?? i} text={element.text ?? ""} style={cardLayoutStyle(element)}/> : <Element key={element.id ?? i} replyProse={message.authorType === "bot" && (!reply || i > 0)} element={element} connection={connection} messageId={message.id} values={values} change={(key, value) => setValues((old) => ({ ...old, [key]: value }))} act={act}/>)}{error && <p role="alert" className="error-text">{error}</p>}</div>
  </section>;
}
export const MessageContent = memo(function MessageContent({ message, connection, reference, backgroundSource }: { backgroundSource?: BackgroundSource; message: Message; connection: HubConnection; reference?: ReactNode }) {
  useLocale();
  const groupedBlocks = new Set<number>();
  const rejectedInput = message.authorType === "user" && message.blocks.some(block => block.type === "steering" && block.outcome === "rejected");
  return <MessageOverlayOwnerContext.Provider value={message.id}><div className={`message-blocks${reference ? " has-reference" : ""}`} onDoubleClick={selectMessageBubble}>{reference}<ImageGalleryContext.Provider value={messageImages(message.blocks)}>{message.blocks.map((block, i) => {
    if (groupedBlocks.has(i)) return null;
    // Caption and images are already one persisted message. Give them one
    // visual surface too, including existing batch deliveries in history.
    if (message.authorType === "bot" && block.type === "text") {
      const next = message.blocks[i + 1];
      if (next?.type === "card" && !next.title && !next.template && !next.layout && !next.extra && galleryImages(next.elements)) {
        groupedBlocks.add(i + 1);
        return <Card key={i} block={next} caption={block.text} connection={connection} message={message}/>;
      }
      if (next?.type === "image") {
        const elements: CardElement[] = [];
        for (let j = i + 1; j < message.blocks.length; j++) {
          const image = message.blocks[j]; if (image?.type !== "image") break;
          groupedBlocks.add(j);
          elements.push({ type: "image", attachmentId: image.attachmentId, text: image.title });
        }
        return <Card key={i} block={{ type: "card", elements }} caption={block.text} connection={connection} message={message}/>;
      }
    }
    // Keep a Bot's caption and consecutive files on one delivery surface. This
    // changes presentation only: reply/forward still use the original message.
    if (message.authorType === "bot" && (block.type === "file" || block.type === "text" && message.blocks[i + 1]?.type === "file")) {
      const files = [];
      for (let j = block.type === "text" ? i + 1 : i; j < message.blocks.length; j++) {
        const file = message.blocks[j]; if (file?.type !== "file") break;
        groupedBlocks.add(j);
        files.push(<AttachmentFile key={`${file.attachmentId}:${j}`} connection={connection} block={file}/>);
      }
      return <div key={i} className="file-delivery">
        {block.type === "text" && block.text.trim() && <div className="file-delivery-caption card-text"><MarkdownText text={block.text} reply/></div>}
        {files}
      </div>;
    }
    switch (block.type) {
      case "steering": return <SteeringReceipt key={i} block={block} message={message} connection={connection}/>;
      // Older command receipts and simple Bot responses are stored as text.
      // Reuse card typography (including authored line breaks) without rewriting
      // history or treating a slash-prefixed quote as an executable command.
      case "text": return message.authorType === "bot"
        ? <Card key={i} block={{ type: "card", elements: [{ type: "markdown", text: block.text }] }} connection={connection} message={message}/>
        : rejectedInput ? <details className="steering-rejected-input" key={i}><summary>{message.blocks.some(b => b.type === "steering" && b.mode === "message") ? t("未发送的消息") : t("未投递的补充")}</summary><MarkdownText text={block.text}/></details> : <MarkdownText key={i} text={block.text}/>;
      case "card": {
        const widget = readWidget(block);
        if (widget) {
          const report = readReport(block);
          return <WorkbenchChartEntry key={i} source={{messageId:message.id,blockIndex:i,version:message.version}}>{report ? <Report title={widget.title} summary={widget.summary} report={report}/> : <Suspense fallback={<p>{widget.summary}</p>}><Widget widget={widget} instanceKey={String(i)}/></Suspense>}</WorkbenchChartEntry>;
        }
        const queue = block.extra?.promptQueue;
        if (message.authorType === "user" && queue && typeof queue === "object" && !Array.isArray(queue) && queue.state === "cancelled") {
          return <small key={i} className="prompt-queue-cancelled">{t("已取消排队，未发送给 Bot。")}</small>;
        }
        const run = anyRun(block); return run ? <RunPresentation key={i} run={run} block={block} connection={connection} message={message} backgroundSource={backgroundSource}/> : message.authorType === "bot" && isBackgroundReport(block) ? <BackgroundReport key={i} block={block} connection={connection} message={message} source={backgroundSource}/> : <Card key={i} block={block} connection={connection} message={message} backgroundSource={backgroundSource}/>;
      }
      case "image": {
        // Group only consecutive images, preserving caption/file order and the
        // original blocks used by reply, forwarding and engine delivery.
        if (message.blocks[i - 1]?.type === "image") return null;
        const images = [];
        for (let j = i; j < message.blocks.length; j++) {
          const image = message.blocks[j]; if (image?.type !== "image") break;
          images.push(<AttachmentImage key={`${image.attachmentId}:${j}`} connection={connection} id={image.attachmentId} title={image.title}/>);
        }
        return images.length > 1 ? <div key={i} className="image-grid" aria-label={t("图片批次")}>{images}</div> : images[0];
      }
      case "audio": return <Audio key={i} connection={connection} id={block.attachmentId}/>;
      case "file": return <AttachmentFile key={i} connection={connection} block={block}/>;
      case "usage": return <div key={i} className="usage-footer">{[block.model, block.effort, block.contextPercent !== undefined ? t("上下文 {0}%", block.contextPercent) : "", block.outputTokens !== undefined ? `${block.outputTokens} tokens` : ""].filter(Boolean).join(" · ")}</div>;
      case "run": return <div key={i} className="run-status"><LoaderCircle size={14} className="spin"/>{block.phase} · {Math.round(block.elapsedMs / 1000)}s</div>;
    }
  })}</ImageGalleryContext.Provider>{message.previewUrl && <MessageLinkPreview url={message.previewUrl} preview={message.linkPreview} style={message.previewStyle} connection={connection}/>}</div></MessageOverlayOwnerContext.Provider>;
});
