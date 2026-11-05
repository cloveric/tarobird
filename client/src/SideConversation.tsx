import { SidePanelResize } from "./SidePanelResize.js";
import { focusComposerBackground, useComposerPaste } from "./composer-paste.js";
import { ComposerVoiceButton, ComposerVoiceRecording } from "./ComposerVoice.js";
import { useVoiceRecorder } from "./useVoiceRecorder.js";
import { useComposerSize } from "./useComposerSize.js";
import { useEffect, useLayoutEffect, useRef, useState, Fragment, type RefObject } from "react";
import { ArrowDown, ArrowUp, CircleStop, Copy, PanelRight, RotateCcw, TextQuote, X } from "lucide-react";
import { MarkdownText } from "./MarkdownText.js";
import { AttachmentImage } from "./AttachmentImage.js";
import { AttachmentFile } from "./Content.js";
import { AttachmentDraft } from "./AttachmentDraft.js";
import { ComposerAttachmentButton, useAttachmentPicker } from "./AttachmentPicker.js";
import { useAttachmentDrop } from "./attachment-drop.js";
import { SIDE_QUESTION_LIMIT } from "../../src/client-protocol/side.js";
import { sideErrorText, type SideConversationController } from "./use-side-conversation.js";
import { t, useLocale } from "./i18n.js";
import "./side-conversation.css";

export function SideConversation({ side, online, visible, appearance, mainRecording, recordingChanged, close, returnToComposer, insert, trigger }: { side: SideConversationController; online: boolean; visible: boolean; appearance: string; mainRecording: boolean; recordingChanged(busy: boolean): void; close(): void; returnToComposer(): void; insert(text: string): void; trigger: RefObject<HTMLButtonElement | null> }) {
  const locale = useLocale();
  const panel = useRef<HTMLElement>(null), input = useRef<HTMLTextAreaElement>(null), log = useRef<HTMLDivElement>(null), compose = useRef<HTMLFormElement>(null);
  const follow = useRef(side.scroll.follow);
  const [latest, setLatest] = useState(false), [copied, setCopied] = useState(""), [copyError, setCopyError] = useState(false);
  const busy = side.sending || side.view?.phase === "thinking" || side.view?.phase === "stopping";
  const preparing = !side.view && !side.ended || side.view?.phase === "preparing";
  const oversize = side.draft.length > SIDE_QUESTION_LIMIT;
  const canAttach = !!side.capability?.attachments;
  const uploadBusy = side.uploadProgress !== undefined;
  const attachmentDisabled = !online || !canAttach || uploadBusy || side.ended;
  const focusInput = () => requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
  const addFiles = (files: File[]) => { side.addFiles(files); focusInput(); };
  const pasteFiles = useComposerPaste({ scope: `${side.scope}:${visible}`, input, disabled: attachmentDisabled, add: addFiles, change: side.setDraft, reject: () => side.setError(t("当前无法添加侧边附件，请等待连接或上传完成。")) });
  const capture = side.captureTarget();
  const voice = useVoiceRecorder(`${side.scope}:${side.view?.id ?? ""}`, file => { if (capture.add(file)) focusInput(); }, capture.fail);
  const canRecord = side.capability?.attachments?.audio === true;
  useEffect(() => { recordingChanged(voice.busy); return () => recordingChanged(false); }, [voice.busy, recordingChanged]);
  useEffect(() => {
    if (side.ended) { voice.cancel(); return; }
    if (!visible || !online) { if (voice.phase === "requesting") voice.cancel(); else if (voice.phase === "recording") voice.finish(); }
  }, [visible, online, side.ended, voice.phase, voice.cancel, voice.finish]);
  const picker = useAttachmentPicker({ scope: side.scope, hostActive: visible, active: visible, phone: false, disabled: attachmentDisabled, add: addFiles, fail: side.setError, settle: focusInput });
  const drop = useAttachmentDrop(side.scope, visible && !attachmentDisabled, addFiles, reason => side.setError(reason === "directory" ? t("暂不支持拖入文件夹，请选择其中的文件。") : t("当前无法添加侧边附件，请等待连接或上传完成。")), { target: panel, label: t("侧边对话"), disabledMessage: t("当前无法添加侧边附件，请等待连接或上传完成。") });
  useLayoutEffect(() => {
    if (!visible || !panel.current || !compose.current) return;
    const measure = () => panel.current?.style.setProperty("--side-composer-height", `${compose.current?.offsetHeight ?? 112}px`);
    const observer = new ResizeObserver(measure); observer.observe(compose.current); measure();
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    if (visible && side.focus.handled !== side.focusRequest) { side.focus.handled = side.focusRequest; input.current?.focus({ preventScroll: true }); }
  }, [visible, side.focus, side.focusRequest]);
  useLayoutEffect(() => { follow.current = side.scroll.follow; if (log.current) log.current.scrollTop = side.scroll.top; }, [side.scope]);
  useEffect(() => { setLatest(false); setCopied(""); setCopyError(false); }, [side.view?.id]);
  useComposerSize(input, side.draft, side.scope, false, false, `${appearance}:${locale}`, visible);
  useLayoutEffect(() => { const node = log.current; if (!node) return; if (follow.current) node.scrollTop = node.scrollHeight; else if (busy) setLatest(true); }, [side.view?.revision, busy]);
  const choose = (text: string) => { side.setDraft(text); focusInput(); };
  const send = () => { if (!oversize && !voice.busy) { follow.current = true; setLatest(false); void side.send(); } };
  const closePanel = () => { close(); requestAnimationFrame(() => { if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true }); else returnToComposer(); }); };
  return <aside ref={panel} id="side-conversation" className={`side-conversation conversation-side-panel${drop.hover ? " is-file-drop" : ""}`} aria-label={t("侧边对话")} hidden={!visible} {...drop.events} onKeyDown={event => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.defaultPrevented || document.querySelector("dialog[open]")) return;
    event.preventDefault(); event.stopPropagation();
    // An unfinished recording is content too: closing would discard it.
    if (!side.draft && !side.files.length && !side.view?.exchanges.length && !busy && !voice.busy) closePanel(); else returnToComposer();
  }}>
    <SidePanelResize panel={panel} visible={visible} controls="side-conversation" label={t("调整侧边对话宽度")}/>
    <header className="side-heading"><div><h2><PanelRight size={16}/>{t("侧边对话")}</h2></div><div className="side-heading-actions"><button className="icon-button" disabled={!online} aria-label={t("基于最新主对话重新开始")} title={t("基于最新主对话重新开始")} onClick={() => { void side.open(side.draft, true); focusInput(); }}><RotateCcw size={16}/></button><button className="icon-button" aria-label={t("关闭侧边对话")} title={t("关闭侧边对话")} onClick={closePanel}><X size={18}/></button></div></header>
    <div ref={log} className="side-log" role="log" aria-live="off" onScroll={event => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48; side.scroll.top = node.scrollTop; side.scroll.follow = follow.current; if (follow.current) setLatest(false); }}>
      {!side.view?.exchanges.length && <div className="side-empty"><span className="side-empty-icon"><PanelRight size={24}/></span><h3>{t("问问主对话")}</h3><p>{t("理清一个细节，再回到正在做的事。")}</p><div className="side-suggestions">{["总结目前进展", "解释上一条回复", "还有哪些风险或遗漏？"].map(text => <button key={text} disabled={busy} onClick={() => choose(t(text))}>{t(text)}<ArrowUp size={13}/></button>)}</div></div>}
      {!!side.view?.omitted && <p className="side-omitted">{t("已省略 {0} 轮较早的侧边问答", side.view.omitted)}</p>}
      {side.view?.exchanges.map(exchange => <section className="side-exchange" key={exchange.id}>{exchange.question && <p className="side-question">{exchange.question}</p>}{!!exchange.attachments?.length && <div className="side-question-attachments">{exchange.attachments.map(attachment => attachment.type === "image" ? <AttachmentImage key={attachment.attachmentId} connection={side.connection} id={attachment.attachmentId} title={attachment.title}/> : <AttachmentFile key={attachment.attachmentId} connection={side.connection} block={attachment} list/>)}</div>}{!!exchange.partialAttachments?.length && <p className="side-usage-note">{t("部分附件内容较长，模型仅获得了部分文本。")}</p>}{exchange.answer && <MarkdownText text={exchange.answer} reply/>}{exchange.deliveries?.map(delivery => <div className="side-output-attachments" key={delivery.id} data-side-delivery={delivery.id}>{delivery.caption && <MarkdownText text={delivery.caption}/>}{delivery.attachments.map((attachment, index) => <Fragment key={`${attachment.attachmentId}:${index}`}>{attachment.caption && <MarkdownText text={attachment.caption}/>}{attachment.type === "image" ? <AttachmentImage connection={side.connection} id={attachment.attachmentId} title={attachment.title}/> : <AttachmentFile connection={side.connection} block={attachment} list/>}</Fragment>)}</div>)}<div className="side-answer-state">{exchange.status === "running" && <span className="side-thinking" role="status"><i/>{side.view?.phase === "stopping" ? t("正在停止…") : t("思考中…")}</span>}{exchange.status === "stopped" && <span>{t("已停止")}</span>}{exchange.error && exchange.status === "error" && <p role="alert">{sideErrorText(exchange.error)} <button disabled={busy || !!side.draft.trim() || !!side.files.length} onClick={() => { side.retry(exchange.id); focusInput(); }}>{t("重试")}</button></p>}{exchange.truncated && <span>{t("回答过长，已截断显示")}</span>}</div>{exchange.answer && <div className="side-answer-actions"><button onClick={() => { setCopyError(false); void Promise.resolve().then(() => navigator.clipboard.writeText(exchange.answer)).then(() => setCopied(exchange.id)).catch(() => setCopyError(true)); }}><Copy size={13}/>{copied === exchange.id ? t("已复制") : t("复制")}</button><button onClick={() => insert(exchange.answer)}><TextQuote size={14}/>{t("插入主输入框")}</button></div>}</section>)}
      {preparing && <p className="side-preparing" role="status"><span className="side-thinking"><i/>{t("正在准备上下文…")}</span></p>}
      {side.view?.error && <p className="side-inline-error" role="alert">{sideErrorText(side.view.error)}</p>}
      {side.error && <p className="side-inline-error" role="alert">{side.error}</p>}
      {(side.ended || side.view?.phase === "error") && <button className="side-restart" disabled={!online} onClick={() => { void side.open(side.draft, true); }}>{t("基于最新主对话重新开始")}</button>}
      {copyError && <p className="side-inline-error" role="alert">{t("复制失败，请重试。")}</p>}
    </div>
    {latest && <button className="side-jump" onClick={() => { follow.current = true; setLatest(false); if (log.current) log.current.scrollTop = log.current.scrollHeight; }}><ArrowDown size={13}/>{t("最新")}</button>}
    <form ref={compose} className="composer-wrap side-compose" onPaste={pasteFiles} onSubmit={event => { event.preventDefault(); send(); }}>
      {oversize && <p className="side-inline-error" role="alert">{t("问题最多 {0} 个字符", SIDE_QUESTION_LIMIT)}</p>}
      <div className="composer side-composer" onPointerDown={event => focusComposerBackground(event, input)}>{voice.busy && <ComposerVoiceRecording voice={voice}/>}{!!side.files.length && <AttachmentDraft files={side.files} returnFocus={input} remove={index => { side.removeFile(index); focusInput(); }} add={picker.show} busy={uploadBusy} maxFileBytes={Math.min(side.connection.state.maxFileBytes ?? Infinity, side.capability?.attachments?.maxFileBytes ?? Infinity)}/>}
      <textarea ref={input} aria-label={t("侧边问题")} placeholder={side.files.length ? t("添加说明…") : side.view?.exchanges.length ? t("继续追问…") : t("问问这段对话…")} rows={1} value={side.draft} disabled={!online || side.ended} onChange={event => side.setDraft(event.target.value)} onKeyDown={event => {
      if (event.key !== "Enter" || event.repeat || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || !matchMedia("(pointer:fine)").matches) return;
      if (event.altKey || /Mac/.test(navigator.platform) && event.metaKey) { event.preventDefault(); const field = event.currentTarget; field.setRangeText("\n", field.selectionStart, field.selectionEnd, "end"); side.setDraft(field.value); }
      else if (!event.shiftKey) { event.preventDefault(); send(); }
    }}/><div className="composer-toolbar"><ComposerAttachmentButton picker={picker} label={t("添加侧边附件")} title={canAttach ? t("添加图片或文件") : t("当前主机或引擎暂不支持侧边附件，请升级后重试。")} disabled={attachmentDisabled}/><ComposerVoiceButton title={canRecord ? t("录制语音") : t("当前主机暂不支持侧边录音，请升级后重试。")} busy={voice.busy} disabled={attachmentDisabled || preparing || !canRecord || mainRecording} start={() => { side.setError(""); void voice.start(); }}/><span className="side-compose-status" role={uploadBusy || !online ? "status" : undefined}>{uploadBusy ? side.uploadRecovering ? t("连接恢复后继续上传") : t("正在上传 {0}%", Math.round(side.uploadProgress! * 100)) : !online ? t("连接已断开，当前内容已保留") : <span className="side-footnote" title={`Esc ${t("回到主输入框")}`}><kbd>Esc</kbd><span>{t("回到主输入框")}</span></span>}</span>{busy ? <button type="button" className="icon-button composer-stop is-live" aria-label={uploadBusy ? t("取消上传") : t("停止侧边回答")} disabled={!online || side.view?.phase === "stopping"} onClick={event => { event.preventDefault(); event.stopPropagation(); void side.stop(); }}><CircleStop size={19}/></button> : <button type="submit" className="send-button" aria-label={t("发送侧边问题")} disabled={!online || preparing || !side.draft.trim() && !side.files.length || oversize || side.ended || side.view?.phase !== "idle" || voice.busy}><ArrowUp size={18}/></button>}</div></div>
      {picker.input}{picker.sheet}
    </form>
    <span className="sr-only" aria-live="polite">{side.view?.phase === "idle" && side.view.exchanges.at(-1)?.status === "complete" ? t("侧边回答已完成") : ""}</span>
  </aside>;
}
