import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { ArrowLeft, Columns2, FileCode2, RefreshCw, Rows3, Trash2 } from "lucide-react";
import { runChangesSchema, runChangeDetailSchema, type RunChanges, type RunChangeDetail } from "../../src/client-protocol/run-changes.js";
import type { WorkspaceDiffLine } from "../../src/client-protocol/workspace-diff.js";
import type { HubConnection } from "./connection.js";
import { HubHttpError } from "./http-error.js";
import { CreationDialog } from "./CreationDialog.js";
import DiffViewer from "./DiffViewer.js";
import { DiffCode } from "./DiffCode.js";
import { adhdSupported } from "./adhd-board-state.js";
import { nativePlatform } from "./native.js";
import { useDiffReview } from "./use-diff-review.js";
import { makeDiffReviewExcerpt, DIFF_REVIEW_MAX_NOTES, DIFF_REVIEW_MAX_COMMENT, type DiffReviewNote } from "./diff-review-draft.js";
import { reviewAnchor, RUN_REVIEW_HEAD } from "./diff-review-reference.js";
import { t, useLocale } from "./i18n.js";
import "./diff-viewer.css";

function failure(error: unknown): string {
  if (error instanceof HubHttpError) {
    if (error.status === 429 || error.status === 504) return t("主机正在处理其他修改记录，请稍后刷新。");
    if (error.code === "run_changes_changed") return t("修改记录已更新，请刷新列表后继续查看。");
    if (error.code === "run_changes_expired") return t("这轮修改记录已超过保存期限，无法恢复当时的差异。");
    if (error.code === "run_changes_not_recorded") return t("这条回复没有保存可查看的修改记录。");
    if ([401, 403].includes(error.status)) return t("没有权限查看此工作区，请检查连接和对话权限。");
    if ([404, 405, 501].includes(error.status) && ["not_found", "method_not_allowed", "not_implemented"].includes(error.code)) return t("请更新主机以查看本轮修改记录。");
    if ([404, 410].includes(error.status)) return t("这条消息或修改记录已不可用。");
  }
  return t("暂时无法读取修改记录，请稍后重试。");
}
/** Only these idempotent reads retry temporary admission/timeout failures. */
async function readEvidence(connection: HubConnection, route: string, signal: AbortSignal): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try { return await connection.http<unknown>(route, { signal }); }
    catch (error) {
      if (signal.aborted || attempt >= 3 || !(error instanceof HubHttpError) || ![429, 504].includes(error.status)) throw error;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 250 * 2 ** attempt);
        signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      });
    }
  }
}
function Counts({ value }: { value: { additions: number | null; deletions: number | null } }) {
  return <span className="diff-counts"><span>+{value.additions ?? "—"}</span><span>−{value.deletions ?? "—"}</span></span>;
}
export default function RunDiffViewer({ connection, conversationId, botId, messageId, runId, snapshotKey, close }: {
  connection: HubConnection; conversationId: string; botId: string; messageId: string; runId: string; snapshotKey?: string; close: () => void;
}) {
  useLocale();
  const state = useSyncExternalStore(cb => connection.subscribe(cb), () => connection.state);
  const [width, setWidth] = useState(window.innerWidth), [live, setLive] = useState(false);
  useEffect(() => { const resize = () => setWidth(window.innerWidth); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, []);
  const desktop = adhdSupported(nativePlatform(), width), permitted = state.user?.role === "owner" && !connection.isReadOnly;
  const online = state.status === "online" && permitted;
  const review = useDiffReview(connection, useMemo(() => ({ conversationId, botId }), [conversationId, botId]), desktop);
  const [list, setList] = useState<RunChanges>(), [detail, setDetail] = useState<RunChangeDetail>();
  const [selected, setSelected] = useState<string>(), [operation, setOperation] = useState<string>(), [preview, setPreview] = useState(false);
  const [revision, setRevision] = useState(0), [loading, setLoading] = useState(false), [fileLoading, setFileLoading] = useState(false);
  const [error, setError] = useState(""), [fileError, setFileError] = useState(""), [actionError, setActionError] = useState("");
  const [split, setSplit] = useState(false), [activeNote, setActiveNote] = useState<string>(), [sending, setSending] = useState(false), [discard, setDiscard] = useState(false);
  const anchor = useRef<{ line: number; side: "old" | "new" } | undefined>(undefined);
  const base = `/api/messages/${encodeURIComponent(messageId)}/changes`, query = new URLSearchParams({ conversationId, botId, runId }).toString();
  useEffect(() => {
    const controller = new AbortController(); setList(undefined); setDetail(undefined); setError(""); setLoading(false);
    if (!online || state.runChangesAvailable !== true || live) return () => controller.abort();
    setLoading(true);
    void readEvidence(connection, `${base}?${query}`, controller.signal).then(raw => {
      if (controller.signal.aborted) return;
      const value = runChangesSchema.parse(raw);
      if (value.messageId !== messageId || value.runId !== runId || value.botId !== botId || value.conversationId !== conversationId) throw new Error("scope_mismatch");
      setList(value);
    }).catch(err => { if (!controller.signal.aborted) setError(failure(err)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base, query, online, state.runChangesAvailable, revision, live, snapshotKey]);
  useEffect(() => {
    const controller = new AbortController(); setDetail(undefined); setFileError(""); setFileLoading(false); anchor.current = undefined;
    if (!selected || !list || !online || live) return () => controller.abort();
    if (!list.items.some(file => file.key === selected)) { setFileError(list.truncated ? t("此文件不在前 200 项记录中，当前视图无法显示。") : t("修改记录已更新，请刷新列表后继续查看。")); return () => controller.abort(); }
    const params = new URLSearchParams({ conversationId, botId, runId, key: selected, revision: list.revision });
    if (operation) params.set("operation", operation); if (preview) params.set("preview", "1");
    setFileLoading(true);
    void readEvidence(connection, `${base}/file?${params}`, controller.signal).then(raw => {
      if (controller.signal.aborted) return;
      const value = runChangeDetailSchema.parse(raw);
      if (value.messageId !== messageId || value.runId !== runId || value.botId !== botId || value.conversationId !== conversationId || value.file.key !== selected || value.revision !== list.revision || operation && value.operation.id !== operation) throw new Error("scope_mismatch");
      setDetail(value);
    }).catch(err => { if (!controller.signal.aborted) setFileError(failure(err)); }).finally(() => { if (!controller.signal.aborted) setFileLoading(false); });
    return () => controller.abort();
  }, [base, query, list, selected, operation, preview, online, live]);
  const choose = (key: string, op?: string) => { setSelected(key); setOperation(op); setPreview(false); setActiveNote(undefined); };
  const sameOperation = (id: string) => { const ref = review.draft.references?.[id]; return ref?.messageId === messageId && ref.runId === runId && ref.fileKey === detail?.file.key && ref.operation === detail?.operation.id; };
  const annotate = (line: WorkspaceDiffLine, side: "old" | "new", event: MouseEvent) => {
    if (!detail || !review.ready || review.error || line.clipped || detail.operation.partial || detail.operation.format !== "unified") return;
    const n = side === "old" ? line.oldLine : line.newLine; if (n === null) return;
    const previous = anchor.current, range = event.shiftKey && previous?.side === side;
    const start = range ? Math.min(previous.line, n) : n, end = range ? Math.max(previous.line, n) : n;
    const lines = detail.hunks.find(h => h.lines.some(value => (side === "old" ? value.oldLine : value.newLine) === start))?.lines.filter(value => { const i = side === "old" ? value.oldLine : value.newLine; return i !== null && i >= start && i <= end; }) ?? [];
    if (lines.length !== end - start + 1 || lines.some(value => value.clipped)) { setActionError(t("请选择同一差异片段内连续且完整的代码行。")); return; }
    if (!range) anchor.current = { line: n, side };
    const existing = review.draft.notes.find(note => sameOperation(note.id) && note.side === side && note.start === start && note.end === end);
    if (existing) { setActiveNote(existing.id); return; }
    if (review.draft.notes.length >= DIFF_REVIEW_MAX_NOTES) { setActionError(t("最多保留 50 条批注，请先发送或删除部分批注。")); return; }
    const note: DiffReviewNote = { id: crypto.randomUUID(), path: detail.file.path, head: RUN_REVIEW_HEAD, side, start, end, excerpt: makeDiffReviewExcerpt(lines.map(value => value.text)), comment: "" };
    review.change([...review.draft.notes, note], { ...review.draft.references, [note.id]: { messageId, runId, fileKey: detail.file.key, operation: detail.operation.id, anchor: reviewAnchor(note) } }); setActiveNote(note.id);
  };
  const act = async (fn: () => Promise<unknown>) => { setSending(true); setActionError(""); try { await fn(); } catch { setActionError(t("操作未完成，批注仍保留，请检查连接、草稿状态或内容长度后重试。")); } finally { setSending(false); } };
  const doClose = () => { if (review.error === "read") close(); else void review.flush().then(close).catch(() => setDiscard(true)); };
  const empty = !permitted ? t("没有权限查看此工作区，请检查连接和对话权限。") : !online ? t("连接恢复后即可查看修改记录。") : state.runChangesAvailable !== true ? t("请更新主机以查看本轮修改记录。") : error || (list?.state === "active" ? t("本轮仍在进行，完成后可查看已确认的修改。") : list?.state === "expired" ? t("这轮修改记录已超过保存期限，无法恢复当时的差异。") : list?.state === "not_recorded" ? t("这轮没有保存可查看的差异，不代表没有修改文件。") : "");
  const fileButton = (file: RunChanges["items"][number]) => <button type="button" aria-label={file.path} className={`diff-file run-diff-file ${selected === file.key ? "is-selected" : ""}`} key={file.key} title={file.path} onClick={() => choose(file.key)}><FileCode2 size={15}/><span className="diff-file-path"><strong>{file.path.replaceAll("\\", "/").split("/").pop()}</strong><small>{file.path.replaceAll("\\", "/").split("/").slice(0, -1).join("/")}</small></span><Counts value={file}/></button>;
  if (live) return <DiffViewer connection={connection} conversationId={conversationId} botId={botId} sharedReview={review} close={() => setLive(false)}/>;
  return <><CreationDialog title={t("本轮改动")} close={doClose} onBack={() => { if (selected) setSelected(undefined); else doClose(); }} closeLabel={t("关闭改动查看器")} showHost={false} className={`diff-viewer ${desktop ? "is-desktop" : "is-mobile"} ${selected ? "has-file" : ""}`}>
    <div className="diff-toolbar"><div><strong>{state.bots.find(bot => bot.id === botId)?.name ?? botId}</strong><span title={t("多次编辑按已记录步骤累计，不等于文件最终净变化。")}>{t("本轮已记录的修改")}</span><button type="button" className="run-diff-live" onClick={() => void review.flush().then(() => setLive(true)).catch(() => setActionError(t("批注状态暂不可用，请先复制意见并重新读取草稿。")))}>{t("当前工作区（实时）")}</button></div><button type="button" className="icon-button" aria-label={t("刷新修改记录")} disabled={!online || loading || fileLoading} onClick={() => { setPreview(false); setRevision(value => value + 1); }}><RefreshCw size={17}/></button></div>
    <div className="diff-layout">
      <nav className="diff-files" aria-label={t("改动文件")}><div className="diff-section-heading">{t("改动文件")} <span>{list?.items.length ?? "—"}{list?.truncated ? "+" : ""}</span></div>
        {empty ? <p role="status" className="diff-hint">{empty}</p> : loading ? <p role="status">{t("正在加载…")}</p> : <>{list?.items.filter(file => !file.generated).map(fileButton)}{list?.items.some(file => file.generated) && <details className="diff-generated"><summary>{t("生成文件与锁文件")}</summary>{list.items.filter(file => file.generated).map(fileButton)}</details>}</>}
        {list?.partial && <p className="diff-hint">{t("记录不完整，仅展示已保存的部分。")}</p>}{!!list?.unavailable && <p className="diff-hint">{t("有修改未保存差异或未确认成功，未计入增删统计。")}</p>}{!!list?.childEdits && <p className="diff-hint">{t("子任务的修改另见运行过程，未混入本轮统计。")}</p>}{list?.truncated && <p className="diff-hint">{t("文件过多，仅显示前 200 个文件。")}</p>}
      </nav>
      <section className="diff-content" aria-label={t("文件差异")}>{!selected ? <div className="diff-empty"><FileCode2 size={30}/><p>{empty || t("选择一个文件查看改动")}</p></div> : <>
        <div className="diff-file-toolbar"><button type="button" className="icon-button diff-back" aria-label={t("返回改动文件")} onClick={() => setSelected(undefined)}><ArrowLeft size={18}/></button><strong title={detail?.file.path}>{detail?.file.path ?? list?.items.find(file => file.key === selected)?.path}</strong>{detail && <Counts value={detail.operation}/>} {desktop && <button type="button" className="icon-button" aria-label={split ? t("切换单栏差异") : t("切换左右对比")} onClick={() => setSplit(!split)}>{split ? <Rows3 size={17}/> : <Columns2 size={17}/>}</button>}</div>
        {fileLoading ? <div className="diff-empty" role="status">{t("正在读取文件改动…")}</div> : fileError || empty ? <div className="diff-empty" role="alert">{fileError || empty}</div> : detail && <>
          <div className="run-diff-operation"><label>{t("修改步骤")} <select aria-label={t("修改步骤")} value={detail.operation.id} onChange={event => { setOperation(event.target.value); setPreview(false); }}>{detail.operations.map(op => <option key={op.id} value={op.id}>{t("步骤 {0}", op.seq)} · {new Date(op.at).toLocaleTimeString()}</option>)}</select></label>{detail.operationsTruncated && <span>{t("仅列出前 200 次修改。")}</span>}</div>
          {detail.operation.format !== "unified" && <p className="diff-hint">{t("记录未提供可靠行号；仅展示原始内容，不能添加行内批注。")}</p>}
          {detail.operation.format === "signed" && <p className="diff-hint">{t("此记录只保存了替换片段，无法可靠计算增删行数。")}</p>}
          {(detail.truncated || detail.operation.partial) && <p className="diff-warning">{t("仅显示部分改动；其余内容未展示。")}</p>}
          {detail.reason ? <div className="diff-empty" role="status"><p>{detail.reason === "protected" ? t("此路径可能包含凭据，不提供内容预览。") : detail.reason === "binary" ? t("二进制文件，仅显示改动状态。") : detail.reason === "too_large" ? t("改动过大，默认不加载代码内容。") : t("这条回复没有保存可查看的修改记录。")}</p>{detail.reason === "too_large" && <button type="button" onClick={() => setPreview(true)}>{t("只看前 200 行")}</button>}</div> : <DiffCode file={{ file: detail.file, head: RUN_REVIEW_HEAD, hunks: detail.hunks }} split={desktop && split} canAnnotate={desktop && review.ready && !review.error && !detail.operation.partial && detail.operation.format === "unified"} notes={review.draft.notes.filter(note => sameOperation(note.id))} annotate={annotate}/>}
        </>}
      </>}</section>
      {desktop && <aside className="diff-review" aria-label={t("审阅批注")}><div className="diff-section-heading"><span>{t("审阅批注")}</span><span>{review.draft.notes.length}</span></div><div className="diff-note-list">
        {!review.draft.notes.length && <p className="diff-hint">{t("点击代码行添加批注，Shift + 点击选择多行。")}</p>}
        {review.draft.notes.map(note => { const ref = review.draft.references?.[note.id]; return <article key={note.id} className={`diff-note ${activeNote === note.id ? "is-active" : ""}`}><header><button type="button" title={note.path} onClick={() => {
          if (ref?.messageId === messageId && ref.runId === runId) choose(ref.fileKey, ref.operation);
          else setActionError(ref ? t("这条批注来自另一条回复，仍可编辑和发送。") : t("这条批注来自实时工作区，仍可编辑和发送。"));
          setActiveNote(note.id);
        }}>{note.path.replaceAll("\\", "/").split("/").pop()} <span>{note.start}{note.end !== note.start ? `–${note.end}` : ""}</span></button><button type="button" className="icon-button" aria-label={t("删除批注")} disabled={!!review.error} onClick={() => review.change(review.draft.notes.filter(value => value.id !== note.id))}><Trash2 size={14}/></button></header>
          <p className="diff-hint">{ref ? ref.messageId === messageId ? t("本轮 · 步骤 {0}", ref.operation.split("-")[0]!) : t("其他回复 · 步骤 {0}", ref.operation.split("-")[0]!) : t("当前工作区（实时）")}</p><pre>{note.excerpt}</pre><textarea aria-label={t("批注意见")} placeholder={t("说明需要修改什么…")} maxLength={DIFF_REVIEW_MAX_COMMENT} value={note.comment} disabled={!!review.error} onChange={event => review.change(review.draft.notes.map(value => value.id === note.id ? { ...value, comment: event.target.value } : value))}/></article>; })}
      </div><footer><p className="diff-hint">{t("所有待发送批注会一起发送；对话成员可看到文件路径、代码和意见。")}</p>
        {review.saving && <p role="status">{t("正在保存批注…")}</p>}{review.error && <div role="alert"><p>{t("批注保存失败或已在另一窗口更改；请先复制当前意见，再重新读取。")}</p><button type="button" onClick={() => void navigator.clipboard.writeText(review.draft.notes.map(note => { const ref = review.draft.references?.[note.id]; return `${ref ? `${ref.messageId} / ${ref.runId} / ${ref.operation}\n` : ""}${note.path}:${note.start}\n${note.excerpt}\n${note.comment}`; }).join("\n\n")).catch(() => setActionError(t("复制失败，请手动复制批注意见。")))}>{t("复制当前批注")}</button><button type="button" onClick={review.reload}>{t("放弃未保存修改并重新读取")}</button></div>}
        {actionError && <p role="alert">{actionError}</p>}
        {review.draft.pending ? <div className="diff-pending"><p role="status">{review.draft.pendingState === "queued" ? t("批注已排队，等待主机确认。") : t("批注尚未确认送达，原稿仍保留。")}</p>{review.draft.pendingState !== "queued" && <><button type="button" disabled={sending} onClick={() => void act(review.retry)}>{t("重试原消息")}</button><button type="button" disabled={sending} onClick={() => void act(review.abandon)}>{t("取消本次发送，保留批注")}</button></>}</div> : <button type="button" className="primary diff-send" disabled={!review.ready || !!review.error || sending || !review.draft.notes.length || review.draft.notes.some(note => !note.comment.trim()) || !permitted} onClick={() => void act(review.send)}>{t("发送批注给 Bot")}</button>}
      </footer></aside>}
    </div>
  </CreationDialog>{discard && <CreationDialog title={t("放弃未保存批注并关闭？")} close={() => setDiscard(false)} showHost={false}><p>{t("仅放弃尚未保存的修改，已保存草稿和已排队消息会保留。可先返回复制当前意见。")}</p><button type="button" onClick={() => setDiscard(false)}>{t("继续编辑")}</button><button type="button" onClick={close}>{t("放弃未保存修改并关闭")}</button></CreationDialog>}</>;
}
