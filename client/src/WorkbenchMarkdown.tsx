import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MarkdownText } from "./MarkdownText.js";
import { useLocale } from "./i18n.js";
import { exportAttachment } from "./attachment-export.js";
import { markdownEditorText, markdownFromEditor, type MarkdownSession } from "./workbench-markdown.js";
import type Vditor from "vditor";
import { loadVditor, VDITOR_ROOT } from "./workbench-vditor.js";
import "vditor/dist/index.css";
import "./workbench-markdown.css";

export function markdownErrorText(error: string, en: boolean): string {
  const messages: Record<string, [string, string]> = {
    markdown_editor_load_failed: ["编辑器未能加载，内容已保留。可以重试加载或导出备份；若仍失败，请重新打开应用。", "The editor could not load. Your content is kept. Retry loading or export a copy. If it still fails, reopen the App."],
    markdown_export_failed: ["导出未完成，笔记内容仍保留。请重试导出。", "Export did not finish. Your note is kept. Retry exporting."],
    markdown_too_large: ["笔记最多支持 128 KB，请拆分文件。", "Notes support up to 128 KB. Split this file into smaller notes."],
    markdown_invalid_input: ["内容或修改格式无效，请检查后重试。", "The content or edit is invalid. Check it and retry."],
    markdown_revision_conflict: ["笔记已在其他位置修改，当前内容仍保留。请先导出，再重新打开最新版本。", "This note changed elsewhere. Your text is kept. Export it before reopening the latest version."],
    markdown_text_missing: ["要修改的原文已变化，请重新读取笔记。", "The original text changed. Read the note again."],
    markdown_text_ambiguous: ["找到多处相同文字，尚未修改。请指定更完整的原文。", "The text appears more than once. Use a more specific excerpt."],
    markdown_editing: ["正在输入，请结束输入后重试。", "Finish composing text, then retry."],
    markdown_read_only: ["另一窗口正在编辑，此处为只读。", "Another window is editing this note. This view is read only."],
    markdown_invalid_encoding: ["文件不是有效的 UTF-8 文本，请转换编码后导入。", "Use a UTF-8 text file."],
    markdown_invalid_file: ["请选择 .md、.markdown 或 .txt 文件。", "Choose a .md, .markdown or .txt file."],
    markdown_not_found: ["笔记内容不可用。", "The note is unavailable."],
    markdown_nothing_to_undo: ["没有可撤销的修改。", "No changes to undo."],
    markdown_nothing_to_redo: ["没有可重做的修改。", "No changes to redo."],
  };
  return messages[error]?.[en ? 1 : 0] ?? (en ? "Could not save the note. Your text is kept; retry or export a copy." : "笔记暂未保存，内容仍保留。请重试或导出备份。");
}

export default function WorkbenchMarkdown({ session, title, botAvailable }: { session: MarkdownSession; title: string; botAvailable: boolean }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot), en = useLocale() === "en";
  const word = (zh: string, english: string) => en ? english : zh;
  const [confirmReload, setConfirmReload] = useState(false);
  const [preview, setPreview] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), composing = useRef(false), editor = useRef<Vditor | undefined>(undefined), mount = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false), [loadFailed, setLoadFailed] = useState(false);
  const [editorAttempt, setEditorAttempt] = useState(0);
  const shown = useRef(session.text()), shownRevision = useRef(session.document.revision);
  const actions = useRef({ history: (_action: "undo" | "redo") => {}, flush: () => {}, exportFile: () => {}, preview: () => {} });
  const flush = async () => { clearTimeout(timer.current); try { await session.refresh(); await session.flush(); setError(undefined); } catch (cause) { setError(cause instanceof Error ? cause.message : "markdown_save_failed"); } };
  useEffect(() => {
    const refresh = () => { void session.refresh().catch(() => undefined); };
    const background = () => { if (document.hidden) void session.flush().catch(() => undefined); else refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", background);
    return () => { session.setComposing(false); clearTimeout(timer.current); document.removeEventListener("visibilitychange", background); window.removeEventListener("focus", refresh); void session.flush().catch(() => undefined); };
  }, [session]);
  const history = async (action: "undo" | "redo") => {
    if (composing.current || snapshot.readOnly || busy) return;
    setBusy(true); clearTimeout(timer.current);
    try {
      await session.flush();
      const result = await session[action]({ requestId: crypto.randomUUID(), expectedRevision: session.document.revision });
      if (result.status !== "applied") throw new Error(result.error ?? "markdown_save_failed"); setError(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "markdown_save_failed"); }
    finally { setBusy(false); editor.current?.focus(); }
  };
  const exportFile = async () => {
    setBusy(true);
    try {
      const name = (title.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\.(?:md|markdown|txt)$/i, "").trim() || "note").slice(0, 110) + ".md";
      await exportAttachment(new Blob([session.text()], { type: "text/markdown;charset=utf-8" }), name);
      setError(undefined);
    } catch { setError("markdown_export_failed"); }
    finally { setBusy(false); }
  };
  actions.current = { history: action => { void history(action); }, flush: () => { void flush(); }, exportFile: () => { void exportFile(); }, preview: () => { void flush(); setPreview(value => !value); } };
  useEffect(() => {
    const node = mount.current!; let cancelled = false, instance: Vditor | undefined;
    setReady(false); setLoadFailed(false);
    const accept = () => {
      if (!instance || cancelled) return;
      // Source mode is intentionally byte preserving. getValue() normalizes
      // NBSP and adds a newline; neither should silently rewrite imported files.
      const input = node.querySelector<HTMLTextAreaElement>("textarea.vditor-sv");
      if (!input || input.value === markdownEditorText(shown.current)) return;
      const text = markdownFromEditor(input.value, shown.current);
      try { session.local(text, { revision: shownRevision.current, content: shown.current }); shown.current = text; setError(undefined); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "markdown_too_large"); input.value = session.text(); shown.current = session.text(); }
      clearTimeout(timer.current); if (!composing.current) timer.current = setTimeout(() => actions.current.flush(), 400);
    };
    const start = () => { composing.current = true; session.setComposing(true); clearTimeout(timer.current); };
    const end = () => { composing.current = false; session.setComposing(false); accept(); clearTimeout(timer.current); timer.current = setTimeout(() => actions.current.flush(), 400); };
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || composing.current) return;
      if (session.readOnly || event.key === "Tab" || event.key === "Escape" || (event.ctrlKey || event.metaKey) && event.altKey && /^Digit[1-9]$/.test(event.code)) { event.stopImmediatePropagation(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); event.stopImmediatePropagation(); actions.current.history("redo"); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.stopImmediatePropagation(); actions.current.history(event.shiftKey ? "redo" : "undo"); }
    };
    const paste = (event: ClipboardEvent) => {
      if (!(event.target instanceof HTMLTextAreaElement)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (session.readOnly) return;
      const text = event.clipboardData?.getData("text/plain"); if (!text) return;
      event.target.setRangeText(text, event.target.selectionStart, event.target.selectionEnd, "end");
      event.target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
    };
    const drop = (event: DragEvent) => {
      if (!(event.target instanceof HTMLTextAreaElement)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (session.readOnly) return;
      const text = event.dataTransfer?.getData("text/plain"); if (!text) return;
      event.target.setRangeText(text, event.target.selectionStart, event.target.selectionEnd, "end");
      event.target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromDrop" }));
    };
    node.addEventListener("paste", paste, true); node.addEventListener("drop", drop, true);
    node.addEventListener("compositionstart", start, true); node.addEventListener("compositionend", end, true); node.addEventListener("keydown", key, true);
    // Also retain an in-progress IME draft if the user closes/switches the Tab.
    node.addEventListener("input", accept);
    void loadVditor(en).then(({ Constructor, i18n }) => {
      if (cancelled) return;
      instance = new Constructor(node, {
        mode: "sv", i18n, cdn: VDITOR_ROOT, lang: en ? "en_US" : "zh_CN", value: session.text(), height: "100%", minHeight: 100,
        cache: { enable: false }, resize: { enable: false }, counter: { enable: false }, hint: { parse: false },
        preview: { mode: "editor", theme: { current: "", path: "" }, hljs: { enable: false }, markdown: { sanitize: true } },
        toolbar: [
          { name: "notePreview", tip: en ? "Preview" : "预览", icon: en ? "Preview" : "预览", className: "note-preview", click: () => actions.current.preview() },
          "bold", "italic", { name: "more", toolbar: ["headings", "link", "list", "ordered-list", "check", "quote", "code", "table"] },
          { name: "noteUndo", tip: en ? "Undo note edit" : "撤销笔记修改", icon: '<svg><use href="#vditor-icon-undo"/></svg>', click: () => actions.current.history("undo") },
          { name: "noteRedo", tip: en ? "Redo note edit" : "重做笔记修改", icon: '<svg><use href="#vditor-icon-redo"/></svg>', click: () => actions.current.history("redo") },
          { name: "noteExport", tip: en ? "Export Markdown" : "导出 Markdown", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/></svg>', click: () => actions.current.exportFile() },
        ],
        placeholder: en ? "Write a note… Markdown supported" : "写点什么…支持 Markdown", input: accept,
        blur: () => { if (composing.current) end(); accept(); actions.current.flush(); },
        after: () => {
          if (cancelled) { instance?.destroy(); return; }
          editor.current = instance;
          const input = node.querySelector<HTMLTextAreaElement>("textarea.vditor-sv");
          input?.setAttribute("aria-label", en ? "Note content" : "笔记内容");
          if (instance) { instance.setValue(session.text(), true); shown.current = session.text(); shownRevision.current = session.document.revision; if (session.readOnly) { instance.disabled(); if (input) { input.disabled = false; input.readOnly = true; } } else instance.enable(); }
          setReady(true);
        },
      });
    }).catch(() => { if (!cancelled) setLoadFailed(true); });
    return () => {
      // Read synchronously before destroy; React teardown must not erase text.
      accept(); cancelled = true; composing.current = false; session.setComposing(false); clearTimeout(timer.current); void session.flush().catch(() => undefined);
      node.removeEventListener("paste", paste, true); node.removeEventListener("drop", drop, true); node.removeEventListener("compositionstart", start, true); node.removeEventListener("compositionend", end, true); node.removeEventListener("keydown", key, true); node.removeEventListener("input", accept);
      if (editor.current === instance) { instance?.destroy(); editor.current = undefined; }
    };
  }, [session, en, editorAttempt]);
  useEffect(() => {
    const instance = editor.current, input = mount.current?.querySelector<HTMLTextAreaElement>("textarea.vditor-sv");
    if (!ready || !instance || !input) return;
    if (!composing.current && input.value !== markdownEditorText(snapshot.content)) { instance.setValue(snapshot.content, true); shown.current = snapshot.content; }
    if (!composing.current && snapshot.error !== "markdown_revision_conflict") shownRevision.current = snapshot.document.revision;
    if (snapshot.readOnly) { instance.disabled(); input.disabled = false; input.readOnly = true; } else { instance.enable(); input.readOnly = false; }
  }, [ready, snapshot.content, snapshot.readOnly, snapshot.document.revision, snapshot.error]);
  useEffect(() => {
    if (!ready) return;
    const button = (name: string) => mount.current?.querySelector<HTMLButtonElement>(`button[data-type="${name}"]`);
    const previewButton = button("notePreview");
    if (previewButton) { previewButton.disabled = false; previewButton.textContent = preview ? word("编辑", "Edit") : word("预览", "Preview"); previewButton.setAttribute("aria-label", previewButton.textContent); previewButton.setAttribute("aria-pressed", String(preview)); }
    const undo = button("noteUndo"), redo = button("noteRedo"), download = button("noteExport");
    if (undo) undo.disabled = snapshot.readOnly || busy || !snapshot.dirty && !snapshot.document.undo.length;
    if (redo) redo.disabled = snapshot.readOnly || busy || snapshot.dirty || !snapshot.document.redo.length;
    if (download) download.disabled = busy;
  }, [ready, preview, en, busy, snapshot]);
  const message = error ?? (loadFailed ? "markdown_editor_load_failed" : snapshot.error);
  return <div className="workbench-markdown-editor" data-note-id={snapshot.document.id} data-note-revision={snapshot.document.revision} data-note-saved={!snapshot.dirty}>
    {!botAvailable && <p className="workbench-markdown-note">{word("更新主机后可让 Bot 编辑，本机编辑仍可用。", "Update the Host to enable Bot editing. Local editing is available.")}</p>}
    {message && <div className="workbench-markdown-error" role="alert"><span>{markdownErrorText(message, en)}</span>{loadFailed ? <><button disabled={busy} onClick={() => { setError(undefined); setEditorAttempt(value => value + 1); }}>{word("重新加载编辑器", "Retry editor")}</button><button disabled={busy} onClick={() => void exportFile()}>{word("导出 Markdown", "Export Markdown")}</button></> : <>{message !== "markdown_revision_conflict" && <button onClick={() => void flush()}>{word("重新保存", "Retry save")}</button>}<button onClick={() => setConfirmReload(true)}>{word("重新载入", "Reload")}</button></>}</div>}
    {confirmReload && <div className="workbench-markdown-error" role="alert"><span>{word("重新载入会放弃未保存的修改。需要保留时请先导出。", "Reload discards unsaved edits. Export a copy first if needed.")}</span><button onClick={() => setConfirmReload(false)}>{word("取消", "Cancel")}</button><button onClick={() => { void session.reloadSaved().then(() => { setConfirmReload(false); setError(undefined); }).catch(cause => setError(cause.message)); }}>{word("确认重新载入", "Confirm reload")}</button></div>}
    {!ready && !loadFailed && <p className="workbench-markdown-note" role="status">{word("正在加载编辑器…", "Loading editor…")}</p>}
    <div className="workbench-vditor" ref={mount} data-preview={preview} data-ready={ready}/>
    {preview && <div className="workbench-markdown-preview" role="region" aria-label={word("Markdown 预览", "Markdown preview")} tabIndex={0}><MarkdownText text={snapshot.content || word("尚未输入内容。", "This note is empty.")}/></div>}
    <div className="workbench-markdown-status" role="status"><span>{snapshot.readOnly ? word(snapshot.ownership === "waiting" ? "正在打开…" : snapshot.ownership === "other_window" ? "另一窗口正在编辑 · 只读" : "无法取得编辑锁 · 只读", snapshot.ownership === "waiting" ? "Opening…" : snapshot.ownership === "other_window" ? "Editing in another window · Read only" : "Could not acquire edit lock · Read only") : snapshot.dirty ? word("尚未保存", "Unsaved") : word("已保存在本机", "Saved on this device")}</span><span>{new TextEncoder().encode(snapshot.content).length.toLocaleString()} B</span></div>
  </div>;
}
