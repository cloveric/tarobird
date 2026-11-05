import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { DiffCode } from "./DiffCode.js";
import { ArrowLeft, RefreshCw, MessageSquarePlus, Trash2, FileCode2, Columns2, Rows3 } from "lucide-react";
import { workspaceChangesSchema, workspaceFileDiffSchema, type WorkspaceChanges, type WorkspaceFileDiff, type WorkspaceDiffLine } from "../../src/client-protocol/workspace-diff.js";
import type { HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import { HubHttpError } from "./http-error.js";
import { adhdSupported } from "./adhd-board-state.js";
import { nativePlatform } from "./native.js";
import { diffExcerpt } from "./diff-view-rows.js";
import { useDiffReview } from "./use-diff-review.js";
import { makeDiffReviewExcerpt, DiffReviewTextTooLargeError, DIFF_REVIEW_MAX_NOTES, DIFF_REVIEW_MAX_COMMENT } from "./diff-review-draft.js";
import { t, useLocale } from "./i18n.js";
import "./diff-viewer.css";

function errorText(error: unknown) {
  if (error instanceof HubHttpError) {
    if ([404, 405, 501].includes(error.status) && ["not_found", "method_not_allowed", "not_implemented"].includes(error.code)) return t("此主机尚不支持改动查看，请更新主机。");
    if ([401, 403].includes(error.status)) return t("没有权限查看此工作区，请检查连接和对话权限。");
    if (error.code === "workspace_diff_not_changed") return t("文件已不在当前改动中，请刷新文件列表。");
    if (error.code === "workspace_diff_changed_during_read") return t("读取期间文件或仓库发生变化，请刷新后重试。");
    if ([404, 410].includes(error.status)) return t("对话、Bot 或工作区已不可用，请返回对话列表检查。");
    if (error.status === 413) return t("本次读取超过安全上限，请在主机缩小改动范围后重试。");
    if ([408, 429, 503, 504].includes(error.status)) return t("主机正忙或检查超时，请稍后重试。");
  }
  return t("暂时无法读取改动，请检查主机连接后重试。");
}
function repositoryText(state: WorkspaceChanges["state"], notes: string[] = []) {
  if (notes.includes("external_git_metadata")) return t("此版本不支持外部 Git 元数据、关联工作树或链接的 Git 对象目录。");
  if (notes.includes("repository_root_unsafe")) return t("仓库根目录覆盖用户目录或磁盘根目录，无法安全查看。");
  if (notes.includes("git_metadata_limit")) return t("仓库元数据超过安全检查上限，当前无法查看。");
  switch (state) {
    case "not_repository": return t("这个 Bot 的工作区不是 Git 仓库。");
    case "git_unavailable": return t("主机没有可用的 Git，请先在主机安装 Git。");
    case "workspace_unavailable": return t("Bot 工作区当前不可用。");
    case "unsafe_repository": return t("此仓库配置不适合安全的只读查看，请在主机检查 Git 配置。");
    case "git_error": return t("Git 无法读取此仓库，请在主机检查仓库状态或权限。");
    default: return "";
  }
}
function metadataText(reason: WorkspaceFileDiff["reason"]) {
  switch (reason) {
    case "binary": return t("二进制文件，仅显示改动状态。");
    case "too_large": return t("改动过大，默认不加载代码内容。");
    case "symlink": return t("符号链接仅显示状态，不读取链接目标。");
    case "submodule": return t("子模块仅显示状态，不读取其中的改动。");
    case "conflict": return t("此文件存在合并冲突，请在主机解决后再查看。");
    case "protected": return t("此路径可能包含凭据，不提供内容预览。");
    default: return t("此文件暂时无法预览，请刷新后重试。");
  }
}
function statusText(status: WorkspaceChanges["items"][number]["status"]) {
  switch (status) {
    case "added": case "untracked": return t("新增");
    case "deleted": return t("已删除");
    case "conflicted": return t("合并冲突");
    case "type_changed": return t("类型变化");
    default: return t("已修改");
  }
}
function Counts({ add, del }: { add: number | null; del: number | null }) {
  return <span className="diff-counts"><span>+{add ?? "—"}</span><span>−{del ?? "—"}</span></span>;
}

export default function DiffViewer({ connection, conversationId, botId, close, onSummary, sharedReview }: { connection: HubConnection; conversationId: string; botId: string; close: () => void; onSummary?: (summary: string) => void; sharedReview?: ReturnType<typeof useDiffReview> }) {
  useLocale();
  const state = useSyncExternalStore(cb => connection.subscribe(cb), () => connection.state);
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => { const resize = () => setWidth(window.innerWidth); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, []);
  const desktop = adhdSupported(nativePlatform(), width);
  const scope = useMemo(() => ({ conversationId, botId }), [conversationId, botId]);
  const ownReview = useDiffReview(connection, scope, desktop && !sharedReview);
  const review = sharedReview ?? ownReview;
  const [list, setList] = useState<WorkspaceChanges>(), [file, setFile] = useState<WorkspaceFileDiff>();
  const [selected, setSelected] = useState<string>(), [preview, setPreview] = useState(false), [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false), [fileLoading, setFileLoading] = useState(false), [error, setError] = useState(""), [fileError, setFileError] = useState("");
  const [split, setSplit] = useState(false), [activeNote, setActiveNote] = useState<string>(), [actionError, setActionError] = useState(""), [sending, setSending] = useState(false);
  const [discardOnClose, setDiscardOnClose] = useState(false), cancelDiscard = useRef<HTMLButtonElement>(null);
  const anchor = useRef<{ path: string; side: "old" | "new"; line: number } | undefined>(undefined);
  const base = `/api/conversations/${encodeURIComponent(conversationId)}/changes`;
  const query = `botId=${encodeURIComponent(botId)}`;
  const permitted = state.user?.role === "owner" && !connection.isReadOnly;
  const online = state.status === "online" && permitted;
  useEffect(() => {
    const controller = new AbortController(); setList(undefined); setFile(undefined); setError(""); setLoading(false);
    if (!online || state.workspaceDiffAvailable === false) return () => controller.abort();
    setLoading(true);
    void connection.http<unknown>(`${base}?${query}`, { signal: controller.signal }).then(raw => {
      if (controller.signal.aborted) return;
      const value = workspaceChangesSchema.parse(raw); if (value.botId !== botId || value.conversationId !== conversationId) throw new Error("scope_mismatch"); setList(value);
      if (value.state === "ready" || value.state === "no_head") onSummary?.(t("改动 {0} 个文件", value.items.length) + (value.truncated ? "+" : "") + (value.items.every(item => item.additions !== null && item.deletions !== null) ? ` +${value.items.reduce((n, item) => n + item.additions!, 0)} −${value.items.reduce((n, item) => n + item.deletions!, 0)}` : ""));
    }).catch(err => { if (!controller.signal.aborted) setError(errorText(err)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base, query, revision, online, state.workspaceDiffAvailable]);
  useEffect(() => {
    const controller = new AbortController(); setFile(undefined); setFileError(""); setFileLoading(false); anchor.current = undefined;
    if (list?.items.find(item => item.path === selected)?.protected) { setFileError(t("此路径可能包含凭据，不提供内容预览。")); return () => controller.abort(); }
    if (!selected || !list || !online) return () => controller.abort();
    if (!list.items.some(item => item.path === selected)) { setFileError(t("文件已不在当前改动中，请刷新文件列表。")); return () => controller.abort(); }
    setFileLoading(true);
    void connection.http<unknown>(`${base}/file?${query}&path=${encodeURIComponent(selected)}${preview ? "&preview=1" : ""}`, { signal: controller.signal }).then(raw => {
      if (controller.signal.aborted) return;
      const value = workspaceFileDiffSchema.parse(raw);
      if (value.file.path !== selected || value.botId !== botId || value.conversationId !== conversationId) throw new Error("scope_mismatch");
      setFile(value);
    }).catch(err => { if (!controller.signal.aborted) setFileError(errorText(err)); }).finally(() => { if (!controller.signal.aborted) setFileLoading(false); });
    return () => controller.abort();
  }, [base, query, list, selected, preview, online]);
  const choose = (path: string) => { setSelected(path); setPreview(false); setActiveNote(undefined); };
  const refresh = () => { setPreview(false); setRevision(value => value + 1); };
  const doClose = () => { if (review.error === "read") { close(); return; } void review.flush().then(close).catch(() => setDiscardOnClose(true)); };
  const annotate = (line: WorkspaceDiffLine, side: "old" | "new", event: MouseEvent) => {
    if (!desktop || !file || !review.ready || review.error || line.clipped) return;
    const n = side === "old" ? line.oldLine : line.newLine; if (n === null) return;
    const previous = anchor.current, range = event.shiftKey && previous?.path === file.file.path && previous.side === side;
    const start = range ? Math.min(previous.line, n) : n, end = range ? Math.max(previous.line, n) : n;
    const selectedLines = file.hunks.find(h => h.lines.some(value => (side === "old" ? value.oldLine : value.newLine) === start))?.lines.filter(value => { const number = side === "old" ? value.oldLine : value.newLine; return number !== null && number >= start && number <= end; }) ?? [];
    if (selectedLines.length !== end - start + 1 || selectedLines.some(value => value.clipped)) { setActionError(t("请选择同一差异片段内连续且完整的代码行。")); return; }
    if (!range) anchor.current = { path: file.file.path, side, line: n };
    const existing = review.draft.notes.find(note => note.path === file.file.path && note.side === side && note.start === start && note.end === end && note.head === file.head);
    if (existing) { setActiveNote(existing.id); return; }
    if (review.draft.notes.length >= DIFF_REVIEW_MAX_NOTES) { setActionError(t("最多保留 50 条批注，请先发送或删除部分批注。")); return; }
    const id = crypto.randomUUID();
    review.change([...review.draft.notes, { id, path: file.file.path, head: file.head, side, start, end, excerpt: makeDiffReviewExcerpt(diffExcerpt(file, side, start, end)), comment: "" }]); setActiveNote(id);
  };
  const act = async (fn: () => Promise<unknown>) => { setSending(true); setActionError(""); try { await fn(); } catch (error) { setActionError(error instanceof DiffReviewTextTooLargeError ? t("批注消息为 {0} KB，超过 {1} KB 上限。请缩短意见或减少批注后发送。", Math.ceil(error.bytes / 1024), error.limit / 1024) : t("操作未完成，批注仍保留，请检查连接、草稿状态或内容长度后重试。")); } finally { setSending(false); } };
  const general = !permitted ? t("没有权限查看此工作区，请检查连接和对话权限。") : !online ? t("连接恢复后即可查看工作区改动。") : state.workspaceDiffAvailable === false ? t("此主机尚不支持改动查看，请更新主机。") : error || (list && repositoryText(list.state, list.notes));
  const regular = list?.items.filter(item => !item.generated) ?? [], generated = list?.items.filter(item => item.generated) ?? [];
  const fileButton = (item: WorkspaceChanges["items"][number]) => <button type="button" className={`diff-file ${selected === item.path ? "is-selected" : ""}`} key={item.path} onClick={() => choose(item.path)} title={item.path} aria-current={selected === item.path ? "true" : undefined}><FileCode2 size={15}/><span className="diff-file-path">{item.path}</span><Counts add={item.additions} del={item.deletions}/>{item.protected ? <small>{t("受保护")}</small> : item.status === "untracked" && <small>{t("新增")}</small>}</button>;
  return <><CreationDialog title={t("工作区改动")} close={doClose} onBack={() => { if (selected) setSelected(undefined); else doClose(); }} closeLabel={t("关闭改动查看器")} showHost={false} className={`diff-viewer ${desktop ? "is-desktop" : "is-mobile"} ${selected ? "has-file" : ""}`}>
    <div className="diff-toolbar"><div><strong>{state.bots.find(bot => bot.id === botId)?.name ?? botId}</strong><span>{t("当前工作区 · 相对 HEAD 的未提交改动")}</span>{(file ?? list)?.head && <code>{(file ?? list)!.head!.slice(0, 8)}</code>}{(file ?? list) && <time dateTime={new Date((file ?? list)!.capturedAt).toISOString()} title={t("本次读取时间")}>{new Date((file ?? list)!.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}</div><button type="button" className="icon-button" aria-label={t("刷新工作区改动")} disabled={loading || fileLoading || !online} onClick={refresh}><RefreshCw size={17}/></button></div>
    {general ? <div className="diff-empty" role="status">{general}</div> : loading ? <div className="diff-empty" role="status">{t("正在检查工作区…")}</div> : <div className="diff-layout">
      <nav className="diff-files" aria-label={t("改动文件")}><div className="diff-section-heading">{t("改动文件")} <span>{list?.items.length ?? 0}{list?.truncated ? "+" : ""}</span></div>
        {regular.map(fileButton)}{generated.length > 0 && <details className="diff-generated"><summary>{t("生成文件与锁文件")} <span>{generated.length}</span></summary>{generated.map(fileButton)}</details>}
        {list?.items.length === 0 && !list.truncated && <p className="diff-hint">{t("当前没有未提交改动。")}</p>}{list?.truncated && <p className="diff-hint">{list.notes.includes("path_unavailable") ? t("部分路径无法安全读取，已省略；当前列表不完整。") : t("文件过多，仅显示前 200 个文件。")}</p>}
        {list?.notes.includes("changed_during_read") && <p className="diff-hint">{t("部分文件正在变化，暂不显示行数；可稍后刷新。")}</p>}
        <p className="diff-hint">{t("含暂存、未暂存和未跟踪文件。忽略子模块内容；不读取全局 Git 配置。")}</p>{list?.notes.includes("conflicts") && <p className="diff-warning">{t("仓库存在合并冲突，冲突文件只显示状态。")}</p>}{list?.state === "no_head" && <p className="diff-hint">{t("仓库尚无提交，以空版本作为比较基准。")}</p>}
      </nav>
      <section className="diff-content" aria-label={t("文件差异")}>
        {!selected ? <div className="diff-empty"><FileCode2 size={30}/><p>{t("选择一个文件查看改动")}</p></div> : <><div className="diff-file-toolbar"><button type="button" className="icon-button diff-back" aria-label={t("返回改动文件")} onClick={() => setSelected(undefined)}><ArrowLeft size={18}/></button><strong title={selected}>{selected}</strong>{file && <><span className="diff-status">{statusText(file.file.status)}</span><Counts add={file.additions} del={file.deletions}/></>} {desktop && <button type="button" className="icon-button" aria-label={split ? t("切换单栏差异") : t("切换左右对比")} onClick={() => setSplit(!split)}>{split ? <Rows3 size={17}/> : <Columns2 size={17}/>}</button>}</div>
          {fileLoading ? <div className="diff-empty" role="status">{t("正在读取文件改动…")}</div> : fileError ? <div className="diff-empty" role="alert">{fileError}</div> : file && <>
            {file.metadataOnly ? <div className="diff-empty" role="status"><p>{file.notes.includes("unsupported_encoding") ? t("此文本不是 UTF-8 编码，当前仅显示状态。") : file.notes.includes("index_removed_worktree") ? t("文件已从暂存索引移除，但仍存在于工作区；当前仅显示状态。") : file.notes.includes("nested_repository") ? t("嵌套仓库或目录仅显示状态，请在对应工作区查看内容。") : file.notes.includes("path_unavailable") ? t("此路径为多重链接、特殊文件或无法安全读取的路径，仅显示状态。") : metadataText(file.reason)}</p>{file.reason === "too_large" && <button type="button" className="primary" onClick={() => setPreview(true)}>{t("只看前 200 行")}</button>}</div> : <>
              {file.notes.includes("preview_prefix") && <p className="diff-warning">{t("这是文件文本的前 200 行预览，不是完整差异。")}</p>}
              {file.notes.includes("preview_patch") && <p className="diff-warning">{t("这是差异的前 200 行预览，不是完整差异。")}</p>}
              {file.truncated && <p className="diff-warning" role="status">{t("仅显示部分改动；其余内容未展示。")}</p>}
              {file.hunks.length === 0 && <p className="diff-hint">{t("文件内容与 HEAD 相同，仅文件模式或暂存状态发生变化。")}</p>}
              <DiffCode file={file} split={desktop && split} canAnnotate={desktop && review.ready && !review.error} notes={review.draft.notes.filter(note => !review.draft.references?.[note.id])} annotate={annotate}/>
            </>}
          </>}
        </>}
      </section>
      {desktop && <aside className="diff-review" aria-label={t("审阅批注")}><div className="diff-section-heading"><span>{t("审阅批注")}</span><span>{review.draft.notes.length}</span></div>
        {review.draft.notes.length === 0 && <div className="diff-review-empty"><MessageSquarePlus size={25}/><p>{t("点击代码行添加批注，Shift + 点击选择多行。")}</p></div>}
        <div className="diff-note-list">{review.draft.notes.map(note => <article key={note.id} className={`diff-note ${activeNote === note.id ? "is-active" : ""}`}><header><button type="button" onClick={() => { if (review.draft.references?.[note.id]) setActionError(t("这条批注来自本轮记录，请返回本轮改动查看对应代码。")); else choose(note.path); setActiveNote(note.id); }} title={note.path}>{note.path.split("/").pop()} <span>{note.side === "old" ? t("旧") : t("新")} {note.start}{note.end !== note.start ? `–${note.end}` : ""}</span></button><button type="button" className="icon-button" aria-label={t("删除批注")} disabled={!!review.error} onClick={() => review.change(review.draft.notes.filter(value => value.id !== note.id))}><Trash2 size={14}/></button></header><pre>{note.excerpt}</pre><textarea aria-label={t("批注意见")} placeholder={t("说明需要修改什么…")} maxLength={DIFF_REVIEW_MAX_COMMENT} value={note.comment} disabled={!!review.error} onFocus={() => setActiveNote(note.id)} onChange={event => review.change(review.draft.notes.map(value => value.id === note.id ? { ...value, comment: event.target.value } : value))}/></article>)}</div>
        <footer><p className="diff-hint">{t("批注按所选行保存，不会随代码移动。发送后对话成员均可看到代码和批注。")}</p>
          {review.saving && <p role="status">{t("正在保存批注…")}</p>}{review.error && <div role="alert"><p>{t("批注保存失败或已在另一窗口更改；请先复制当前意见，再重新读取。")}</p><button type="button" onClick={() => void navigator.clipboard.writeText(review.draft.notes.map(note => { const ref = review.draft.references?.[note.id]; return `${ref ? `${ref.messageId} / ${ref.runId} / ${ref.operation}\n` : ""}${note.path}:${note.start}\n${note.excerpt}\n${note.comment}`; }).join("\n\n")).catch(() => setActionError(t("复制失败，请手动复制批注意见。")))}>{t("复制当前批注")}</button><button type="button" onClick={review.reload}>{t("放弃未保存修改并重新读取")}</button></div>}
          {actionError && <p role="alert" className="diff-warning">{actionError}</p>}
          {review.draft.pending ? <div className="diff-pending"><p role="status">{review.draft.pendingState === "queued" ? t("批注已排队，等待主机确认。") : t("批注尚未确认送达，原稿仍保留。")}</p>{review.draft.pendingState !== "queued" && <div><button type="button" disabled={sending} onClick={() => void act(review.retry)}>{t("重试原消息")}</button><button type="button" disabled={sending} onClick={() => void act(review.abandon)}>{t("取消本次发送，保留批注")}</button></div>}</div> : <button type="button" className="primary diff-send" disabled={!review.ready || !!review.error || sending || !review.draft.notes.length || review.draft.notes.some(note => !note.comment.trim()) || !permitted} onClick={() => void act(review.send)}>{t("发送批注给 Bot")}</button>}
        </footer>
      </aside>}
    </div>}
  </CreationDialog>{discardOnClose && <CreationDialog title={t("放弃未保存批注并关闭？")} close={() => setDiscardOnClose(false)} closeLabel={t("继续编辑")} initialFocus={cancelDiscard} showHost={false} className="confirmation-dialog"><p>{t("仅放弃尚未保存的修改，已保存草稿和已排队消息会保留。可先返回复制当前意见。")}</p><footer><button type="button" ref={cancelDiscard} onClick={() => setDiscardOnClose(false)}>{t("继续编辑")}</button><button type="button" onClick={close}>{t("放弃未保存修改并关闭")}</button></footer></CreationDialog>}</>;
}
