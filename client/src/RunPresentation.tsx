import { TurnStopContext } from "./use-turn-stop.js";
import { DiffViewerTrigger } from "./DiffViewerTrigger.js";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, ChevronsLeft, ChevronsRight, CircleStop, Copy, Download, GitBranch, ListTree, LoaderCircle, RefreshCw, Search } from "lucide-react";
import type { Block, Message } from "../../src/client-protocol/index.js";
import { RUN_ENTRY_LIMIT, runPageSchema, scopedJournal, type ScopedJournal, type RunEntry, type RunPage, type RunSummary } from "../../src/client-protocol/run.js";
import type { HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import { MarkdownText } from "./MarkdownText.js";
import { CodeBlock } from "./CodeBlock.js";
import { AttachmentFile } from "./Content.js";
import { exportAttachment } from "./attachment-export.js";
import { RuntimeHostActiveContext } from "./RuntimeHost.js";
import { STOP_CONFIRMATION_MS, stopOutcome, type StopWait } from "./run-stop.js";
import { entryStatus, formatRunDuration, runDiff, runEntryTitle, runKind, runPhaseLabel, runSources, runExitCode, runPlan, runScopeLabel, runScopeParent, runProse, runInput, codexAgentReports, codexAgentStatus } from "./run-presentation.js";
import { backgroundTaskNotice } from "../../src/client-protocol/background-task.js";
import { scopedTaskLabelSchema } from "../../src/client-protocol/engine-tasks.js";
import { BackgroundTaskReference, type BackgroundSource } from "./BackgroundTaskReference.js";
import { useMessageOverlay } from "./message-overlay.js";
import { useRunReaderState } from "./run-reader-state.js";
import { useRunReportPreview } from "./RunReportPreview.js";
import { RunReport } from "./RunReport.js";
import { ScopedTaskDescription } from "./ScopedTaskDescription.js";
import { t, useLocale } from "./i18n.js";
import { useConnectionSelection } from "./connection-selection.js";
import { isContextMaintenance } from "../../src/client-protocol/run.js";
import { runThinkingPreview } from "../../src/client-protocol/run-thinking.js";
import { runReportExcerpt } from "./run-presentation.js";
import "./run-presentation.css";

type View = { after: number; before?: number; tail?: boolean; history: number[]; query: string; expanded: Set<number>; scroll: number };
const views = new Map<string, View>(); // UI position only; never retain raw logs globally.
function position(key: string): View { let value = views.get(key); if (!value) { value = { after: 0, history: [], query: "", expanded: new Set(), scroll: 0 }; views.set(key, value); } while (views.size > 64) views.delete(views.keys().next().value!); return value; }
const activePhase = (phase: RunSummary["phase"]) => !["done", "partial", "error", "stopped", "interrupted"].includes(phase);

export function RunPresentation({ run, block, message, connection, backgroundSource, compact = false, compactReturnFocus }: { compactReturnFocus?: React.RefObject<HTMLButtonElement | null>; compact?: boolean; run: RunSummary; block: Extract<Block, { type: "card" }>; message: Message; connection: HubConnection; backgroundSource?: BackgroundSource }) {
  const requestStop = useContext(TurnStopContext);
  useLocale(); const hostActive = useContext(RuntimeHostActiveContext);
  const state = useConnectionSelection(connection, value => ({
    status: value.state.status, bots: value.state.bots, runScopesAvailable: value.state.runScopesAvailable,
    serverTimeOffset: value.state.serverTimeOffset, ...value.stopReceipt(),
  }));
  const key = JSON.stringify([connection.identity.hubPublicKey, connection.identity.deviceId, message.conversationId, message.id, run.id]);
  const [opened, open] = useRunReaderState(key);
  const [stopWait, setStopWait] = useState<StopWait>(), [stopExpired, setStopExpired] = useState<StopWait>(), [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null), reportTrigger = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLElement>(null);
  const detailFocus = useMemo(() => ({ get current() { return compact && !trigger.current?.getClientRects().length ? compactReturnFocus?.current ?? trigger.current : trigger.current; } }), [compact, compactReturnFocus]);
  const reportFocus = useMemo(() => ({ get current() { return reportTrigger.current ?? detailFocus.current ?? card.current; } }), [detailFocus]);
  const scoped = block.extra?.scopedRun !== undefined;
  const taskLabel = scopedTaskLabelSchema.safeParse(block.extra?.scopedTask);
  const scopeUnsupported = scoped && state.runScopesAvailable === false;
  const sync = scopedJournal(block, run);
  const active = activePhase(run.phase);
  const thinking = runThinkingPreview(block, run);
  const disconnected = active && (state.status !== "online" || !state.bots.find(bot => bot.id === message.authorId)?.online);
  const interrupted = active && message.status === "error";
  // A request waits until the run reports "stopping", which shows the host
  // received a stop, and that phase until the run ends. A failure, reconnect or
  // deadline ends the wait and re-enables the button; neither locks it forever.
  const reportedStopping = active && run.phase === "stopping";
  const stopState = stopWait ? stopOutcome(stopWait, connection.stopReceipt(), stopExpired === stopWait) : reportedStopping ? "waiting" : undefined;
  const waiting = active && stopState === "waiting";
  const phase = interrupted ? "interrupted" : waiting ? "stopping" : run.phase;
  const [now, setNow] = useState(Date.now);
  const ticking = active && !disconnected && !interrupted && !scopeUnsupported && hostActive;
  useEffect(() => {
    setNow(Date.now());
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking, run.id]);
  useEffect(() => { if (!active) setStopWait(undefined); }, [active]);
  useEffect(() => { if (reportedStopping) setStopWait({}); }, [reportedStopping]);
  useEffect(() => {
    if (!stopWait) return;
    const timer = setTimeout(() => setStopExpired(stopWait), STOP_CONFIRMATION_MS);
    return () => clearTimeout(timer);
  }, [stopWait]);
  // A retry is a new explicit click on this card, for this run's Bot only.
  const stop = async () => {
    if (scoped || waiting || disconnected) return;
    const previous = stopWait;
    let request: StopWait | undefined;
    const beforeSend = () => { request = { receipt: connection.stopReceipt() }; setStopWait(request); setError(""); };
    try {
      const sent = requestStop ? await requestStop(message.conversationId, message.authorId, beforeSend)
        : (beforeSend(), await connection.send({ v: 1, type: "turn.stop", conversationId: message.conversationId, botId: message.authorId }), true);
      if (!sent) setStopWait(current => current === request ? previous : current);
    }
    catch { setStopWait(current => current === request ? previous : current); setError(t("停止请求未发送，请恢复连接后重试。")); }
  };
  // Reuse the already-cleaned, full App answer text. Drop only the legacy
  // process panels/status/button chrome; original card remains the fallback.
  const prose = runProse(block);
  const notice = backgroundTaskNotice(block);
  const backgroundNote = block.elements.find(entry => entry.id === "run_background_note")?.text;
  useLayoutEffect(() => { open(current => hostActive && current?.key === key && !(current.kind === "process" && scopeUnsupported) ? current : undefined); }, [key, hostActive, scopeUnsupported]);
  useMessageOverlay(message.id, opened?.key === key && hostActive);
  const reportPreview = useRunReportPreview(prose.map(entry => entry.text!).join("\n\n"), active);
  const publicReply = prose.map(entry => entry.text!).join("\n\n").trim();
  const inlineScopedReply = scoped && !active && publicReply.length > 0 && publicReply.length <= 1600 && publicReply.split("\n").length <= 16;
  // Wall time is not evidence of engine progress. Freeze offline/terminal
  // records; a gap between public events does not imply idle or stalled work.
  const observedNow = now + (state.serverTimeOffset ?? 0);
  const elapsed = (run.endedAt ?? (ticking ? Math.max(run.updatedAt, observedNow) : run.updatedAt)) - run.startedAt;
  const waitingForBackground = active && run.current?.name === "background_review_wait" && run.current.status === "waiting";
  const waitingForNativeInput = active && run.current?.name === "native_input_wait" && run.current.status === "waiting";
  const recovering = active && phase !== "stopping" && !disconnected && run.current?.name === "engine_retry";
  const retrySeconds = recovering && run.current?.status === "waiting"
    ? Math.max(0, Math.ceil((run.current.at + Number(runInput(run.current).delayMs ?? 0) - Math.max(run.current.at, observedNow)) / 1000)) : 0;
  const phaseLabel = notice?.delivery === "unconfirmed" ? t("交付未确认") : scopeUnsupported && active ? t("最后状态待确认") : disconnected ? t("连接中断，当前状态待确认") : active && run.current && phase === "working" ? runEntryTitle(run.current) : phase === "done" && backgroundNote ? t("本轮已回复") : scoped && phase === "partial" ? t("最终状态未确认") : runPhaseLabel(phase);
  const readers = <>
    {opened?.key === key && opened.kind === "report" && hostActive && createPortal(<RunReport key={key} status={phaseLabel} block={block} message={message} source={backgroundSource} returnFocus={reportFocus} close={() => open(undefined)} process={scopeUnsupported ? undefined : () => open({ key, kind: "process" })}/>, document.body)}
    {opened?.key === key && opened.kind === "process" && hostActive && !scopeUnsupported && createPortal(<RunDetails key={key} scoped={scoped} run={run} phase={phase} observedNow={observedNow} sync={sync} connection={connection} message={message} view={position(key)} returnFocus={detailFocus} close={() => open(undefined)} report={compact ? () => open({ key, kind: "report" }) : undefined}/>, document.body)}
  </>;
  if (compact && scoped) return <>
    <button type="button" ref={trigger} className="background-task-row" data-phase={phase}
      title={`${taskLabel.success ? taskLabel.data.label : t("后台任务")} · ${phaseLabel}`} aria-label={t("查看子代理过程：{0}", taskLabel.success ? taskLabel.data.label : t("后台任务"))}
      onClick={() => open({ key, kind: scopeUnsupported ? "report" : "process" })}>
      <span className={`background-task-dot${disconnected || scopeUnsupported ? " is-uncertain" : ""}`} aria-hidden="true"/>
      <span className="background-task-name">{taskLabel.success ? taskLabel.data.label : t("后台任务")}</span>
      <time title={t(ticking ? "本次运行总耗时" : "截至最近一次事件")}>{formatRunDuration(elapsed)}</time>
      <span className="background-task-state">{notice?.delivery === "unconfirmed" ? t("交付未确认") : disconnected || scopeUnsupported ? t("待确认") : phase === "done" ? t("完成") : phase === "error" ? t("失败") : ["stopped", "interrupted"].includes(phase) ? t("中断") : phase === "partial" ? t("待确认") : ["waiting_approval", "waiting_answer"].includes(phase) ? t("等待") : run.count ? t("{0} 步", `${run.count}${run.truncated ? "+" : ""}`) : t("运行中")}</span>
      <ChevronRight size={13} aria-hidden="true"/>
    </button>
    {readers}
  </>;
  return <section ref={card} tabIndex={-1} className={`native-run${scoped ? " is-scoped" : ""}`} aria-label={t("运行回复")} data-phase={phase}>
    <div className="native-run-heading">
    {scoped && <span className="run-scope-heading"><GitBranch size={14}/>{t(notice ? "后台任务" : "子代理")}</span>}
    <div className={`native-run-status${active && run.current && phase === "working" && !disconnected && !scopeUnsupported ? " has-current" : ""}${disconnected || interrupted ? " is-interrupted" : ""}`}>
      {active && !disconnected && !interrupted && !scopeUnsupported && !["waiting_approval", "waiting_answer"].includes(phase) ? <LoaderCircle size={14} className="spin"/> : phase === "done" ? <Check size={14}/> : <span className="run-state-dot"/>}
      <span>{phaseLabel}</span>
      <time title={t(ticking ? "本次运行总耗时" : "截至最近一次事件")}>{formatRunDuration(elapsed)}</time>
    </div>
    </div>
    {scoped && notice && <BackgroundTaskReference notice={notice} message={message} source={backgroundSource} compact/>}
    {scoped && taskLabel.success && <ScopedTaskDescription key={taskLabel.data.label} text={taskLabel.data.label}/>}
    {scopeUnsupported && <p className="run-notice">{t("当前连接暂不提供子任务过程，已保留公开回复。")}</p>}
    {scoped && run.detailsUnavailable && <p className="run-notice">{t("部分过程尚未同步，回复不受影响。")}</p>}
    {disconnected && <small>{t("最后确认：{0}", runPhaseLabel(run.phase))}</small>}
    {waitingForBackground && <p className="run-notice">{t("Claude 正在处理上一项后台结果，本条消息尚未交给模型。")}</p>}
    {recovering && <p className="run-notice run-recovery-notice" role="status">{retrySeconds > 0
      ? t("会话进度已保留，约 {0} 秒后自动重试。可随时停止。", retrySeconds)
      : run.current?.status === "waiting" ? t("会话进度已保留，即将自动重试。可随时停止。")
        : t("正在续接原会话，已完成的工作仍然保留。可随时停止。")}</p>}
    {thinking && <div className="run-thinking-preview"><span>{t("公开思考摘要")}</span><p>{(thinking.truncated ? "…" : "") + runReportExcerpt(thinking.text, true).replace(/^…/, thinking.truncated ? "" : "…")}</p></div>}
    {scoped && !inlineScopedReply ? reportPreview.preview : <div className="native-run-prose">{prose.map((entry, index) => <div className="card-text" key={entry.id ?? index}><MarkdownText text={entry.text!} reply/></div>)}</div>}
    {backgroundNote && <p className="run-notice">{backgroundNote}</p>}
    <div className="native-run-actions">{scoped && !inlineScopedReply && reportPreview.needsReader && <button type="button" ref={reportTrigger} className="run-report-trigger" onClick={() => open({ key, kind: "report" })}>{t("查看完整回复")}</button>}{!scopeUnsupported && <button ref={trigger} className="run-process-trigger" onClick={() => open({ key, kind: "process" })} aria-label={t("查看运行过程")}><ChevronRight size={14}/><span>{run.count ? t("过程 · {0} 个动作", run.count) : t("查看运行过程")}</span></button>}
      {!scoped && <DiffViewerTrigger connection={connection} message={message}/>}
      {!scoped && active && !interrupted && <button className="run-stop" disabled={disconnected || waiting} onClick={() => void stop()}><CircleStop size={14}/>{waiting ? t("等待停止确认") : waitingForBackground || waitingForNativeInput ? t("取消等待") : t("停止")}</button>}
    </div>{error && <p role="alert">{error}</p>}
    {!scoped && active && !interrupted && !disconnected && stopState === "unconfirmed" && <p className="run-notice" role="status">{t("尚未收到停止确认。请核对运行状态，需要时可再次停止。")}</p>}
    {readers}
  </section>;
}

function RunDetails({ scoped, run, phase, observedNow, sync, message, connection, view, close, returnFocus, report }: { report?: () => void; scoped: boolean; run: RunSummary; phase: RunSummary["phase"]; observedNow: number; sync?: ScopedJournal; message: Message; connection: HubConnection; view: View; close: () => void; returnFocus: React.RefObject<HTMLButtonElement | null> }) {
  const locale = useLocale(); const [after, setAfter] = useState(view.after), [query, setQuery] = useState(view.query), [search, setSearch] = useState(view.query);
  const [before, setBefore] = useState(view.before), [tail, setTail] = useState(!!view.tail);
  const [page, setPage] = useState<RunPage>(), [error, setError] = useState(""), [busy, setBusy] = useState(false), [exporting, setExporting] = useState(false), [notice, setNotice] = useState("");
  const [refresh, reload] = useState(0); const body = useRef<HTMLDivElement>(null), alive = useRef(true);
  const pendingScroll = useRef<number | undefined>(view.scroll);
  useLayoutEffect(() => {
    if (!page || !body.current || pendingScroll.current === undefined) return;
    // Restore after rows commit, only on entry/page changes. Live refreshes
    // must not rewrite scrollTop and cancel a native swipe or its momentum.
    // WebKit can wrap an oversized scrollTop instead of clamping it. Resolve
    // the latest-page sentinel to the actual committed content height first.
    body.current.scrollTop = Math.min(pendingScroll.current, body.current.scrollHeight);
    pendingScroll.current = undefined;
  }, [page]);
  const freshness = `${run.revision}:${run.phase}:${run.endedAt ?? ""}:${!!run.detailsUnavailable}:${sync?.pending ?? ""}:${message.status}`;
  const latestRevision = useRef(freshness); latestRevision.current = freshness;
  const latestRun = useRef(run); latestRun.current = run;
  const trailingAttempt = useRef({ runId: run.id, revision: -1 });
  if (trailingAttempt.current.runId !== run.id) trailingAttempt.current = { runId: run.id, revision: -1 };
  const liveDetails = useRef(activePhase(run.phase)); liveDetails.current = activePhase(run.phase) && message.status !== "error";
  const terminalPollUntil = useRef(0);
  const refreshDetails = useRef<(() => void) | undefined>(undefined);
  const connectionState = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const online = connectionState.status;
  const tailAvailable = connectionState.runTailAvailable === true;
  useEffect(() => {
    // Only recent terminal records need catch-up. Opening historical details
    // performs one read; completion metadata can still invalidate it later.
    const age = Date.now() + (connectionState.serverTimeOffset ?? 0) - (run.endedAt ?? run.updatedAt);
    terminalPollUntil.current = activePhase(run.phase) ? 0 : Date.now() + Math.max(0, 10_000 - Math.max(0, age));
  }, [run.phase, run.endedAt, run.updatedAt, connectionState.serverTimeOffset]);
  const disconnected = activePhase(run.phase) && (online !== "online" || !connectionState.bots.find(bot => bot.id === message.authorId)?.online);
  const live = activePhase(phase) && !disconnected;
  const age = Math.max(0, observedNow - run.updatedAt);
  const updateDate = new Date(run.updatedAt), updateAt = updateDate.toLocaleString(locale === "zh" ? "zh-CN" : "en-GB", { hourCycle: "h23" });
  const unit: Intl.RelativeTimeFormatUnit = age >= 86_400_000 ? "day" : age >= 3_600_000 ? "hour" : "minute";
  const unitMs = unit === "day" ? 86_400_000 : unit === "hour" ? 3_600_000 : 60_000;
  const updateWhen = age < 60_000 ? t("刚刚") : new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(-Math.floor(age / unitMs), unit);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setError("");
    let reading = false, requestedRevision = "";
    let trailing: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (controller.signal.aborted || reading) return;
      clearTimeout(trailing); trailing = undefined;
      reading = true; requestedRevision = latestRevision.current;
      try {
        const params = new URLSearchParams({ after: String(after), q: query, scopes: "1" });
        if (tailAvailable && tail) params.set("tail", "1");
        else if (tailAvailable && before !== undefined) params.set("before", String(before));
        const raw = await connection.http(`/api/messages/${message.id}/run?${params}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const result = runPageSchema.parse(raw);
        setPage(result); setError("");
        const observed = latestRun.current;
        // A live summary can win the race with its optional journal write.
        // Give a stable thinking tail one bounded follow-up; newer summaries
        // already invalidate this read, and slow Hosts keep the 1 s fallback.
        if (!scoped && !query && before === undefined && !tail && result.next === null && !result.expired
          && online === "online" && liveDetails.current && observed.phase === "thinking" && !observed.detailsUnavailable
          && observed.revision > 0 && requestedRevision === latestRevision.current && trailingAttempt.current.revision < observed.revision
          && result.entries.every(entry => entry.revision < observed.revision)) {
          trailingAttempt.current.revision = observed.revision;
          const revision = requestedRevision;
          trailing = setTimeout(() => {
            trailing = undefined;
            if (latestRevision.current === revision) void read();
          }, 180);
        }
        if (tailAvailable && tail) {
          // Jump once, then pin the first visible row. Live refreshes must not
          // slide a moving tail underneath someone reading or scrolling.
          const anchor = Math.max(0, (result.entries[0]?.seq ?? 1) - 1);
          view.after = anchor; view.before = undefined; view.tail = false;
          setAfter(anchor); setBefore(undefined); setTail(false);
        }
      } catch { if (!controller.signal.aborted) setError(t("过程读取失败，请检查连接后重试。")); }
      finally {
        reading = false;
        if (!controller.signal.aborted) {
          // Existing rows remain usable while a newer journal revision loads.
          setBusy(false);
          if (!tail && requestedRevision !== latestRevision.current) void read();
        }
      }
    };
    const invalidate = () => { if (requestedRevision !== latestRevision.current) void read(); };
    refreshDetails.current = invalidate;
    void read();
    // Live body snapshots can precede their journal batch. While this panel is
    // open, refresh even if no further engine event arrives (e.g. a long tool).
    // The reading guard permits only one request and keeps existing rows open.
    // Optional scoped batches may land just after the terminal body. Give them
    // a bounded catch-up window; older history never polls indefinitely.
    const timer = setInterval(() => { if ((liveDetails.current || Date.now() < terminalPollUntil.current) && online === "online") void read(); }, 1000);
    return () => { clearInterval(timer); clearTimeout(trailing); controller.abort(); if (refreshDetails.current === invalidate) refreshDetails.current = undefined; };
  }, [connection, message.id, after, before, tail, tailAvailable, query, refresh, online, scoped]);
  // Streaming events can arrive faster than a request through a relay. Keep
  // the in-flight read and coalesce revisions instead of aborting every event.
  useEffect(() => { refreshDetails.current?.(); }, [freshness]);
  const move = (next: number, previous?: number, latest = false) => {
    view.after = next; view.before = previous; view.tail = latest;
    view.scroll = latest ? Number.MAX_SAFE_INTEGER : 0; pendingScroll.current = view.scroll;
    setPage(undefined); setAfter(next); setBefore(previous); setTail(latest);
  };
  const exportRun = async () => {
    if (exporting) return; setExporting(true); setNotice("");
    try {
      const startedAt = new Date().toISOString();
      let cursor = 0; const entries: RunEntry[] = [];
      do {
        const part = runPageSchema.parse(await connection.http(`/api/messages/${message.id}/run?after=${cursor}&scopes=1`));
        if (!alive.current) return;
        entries.push(...part.entries); if (entries.length > RUN_ENTRY_LIMIT) throw new Error("run_limit");
        if (part.next === null) break; if (part.next <= cursor) throw new Error("invalid_cursor"); cursor = part.next;
      } while (alive.current);
      const blob = new Blob([JSON.stringify({ run, captureStartedAt: startedAt, captureFinishedAt: new Date().toISOString(), live: activePhase(run.phase), detailsPending: !!sync?.pending, entries }, null, 2)], { type: "application/json" });
      if (await exportAttachment(blob, `run-${run.id}.json`)) setNotice(t("过程记录已导出"));
    } catch { if (alive.current) setNotice(t("导出失败，请重试。")); }
    finally { if (alive.current) setExporting(false); }
  };
  const hasPagination = page?.next != null || page?.previous != null || after > 0 || before !== undefined || tail || view.history.length > 0;
  return <CreationDialog title={t("运行过程")} closeLabel={t("关闭运行过程")} close={close} returnFocus={returnFocus} className="run-details" back>
    <p className="run-details-meta"><span className="run-details-phase">{disconnected ? t("连接中断，当前状态待确认") : scoped && phase === "partial" ? t("最终状态未确认") : runPhaseLabel(phase)}</span><span>{t("{0} 个动作完成", run.completed)}{run.failed ? ` · ${t("{0} 个动作失败", run.failed)}` : ""}{run.model ? ` · ${run.model}${run.effort ? ` · ${run.effort}` : ""}` : ""}</span></p>
    {report && <button type="button" className="run-report-trigger" onClick={report}>{t("查看完整回复")}</button>}
    <form className="run-details-tools" onSubmit={e => { e.preventDefault(); view.query = search.trim(); view.history = []; setQuery(view.query); move(0); reload(value => value + 1); }}><label><Search size={16}/><input aria-label={t("搜索过程记录")} placeholder={t("搜索过程记录")} value={search} maxLength={200} onChange={e => setSearch(e.target.value)}/></label><button>{t("搜索")}</button><button type="button" disabled={busy || online !== "online"} onClick={() => reload(value => value + 1)} aria-label={t("刷新过程记录")} title={t("刷新过程记录")}><RefreshCw size={16}/></button><button type="button" disabled={exporting || online !== "online"} onClick={() => void exportRun()} aria-label={t("导出过程记录")} title={t("导出过程记录")}><Download size={16}/></button></form>
    <div className="run-details-body" ref={body} onScroll={e => { view.scroll = e.currentTarget.scrollTop; }} aria-busy={busy}>
      {/* Two stable lines keep changing relative-time text from wrapping and
          moving the journal. Exact time is also readable on touch screens.
          State changes update this timestamp too, not only engine progress. */}
      <p className="run-update-time">
        <span className="run-update-heading"><span>{t("最后更新：")}</span>{live && <span className="run-update-relative">{updateWhen}</span>}</span>
        <time dateTime={updateDate.toJSON() ?? undefined}>{t("主机记录：{0}", updateAt)}</time>
      </p>
      {sync?.pending && !run.detailsUnavailable && <p className="run-notice">{t("过程记录正在同步，回复已可查看。")}</p>}
      {run.detailsUnavailable && <p className="run-notice">{t("部分过程尚未同步，回复不受影响。")}</p>}
      {run.truncated && <p className="run-notice">{t("记录达到采集上限，部分内容已截短。")}</p>}
      {error && <p role="alert">{error}<button onClick={() => reload(n => n + 1)}>{t("重试")}</button></p>}
      {!page && busy && !error && <div className="run-details-empty" role="status"><LoaderCircle size={24} className="spin" aria-hidden="true"/><p>{t("正在加载过程…")}</p></div>}
      {page?.expired && !error && <div className="run-details-empty"><ListTree size={28} aria-hidden="true"/><p>{t("详细记录已过保留期，回复与摘要仍然保留。")}</p></div>}
      {page && !page.expired && !page.entries.length && !error && <div className="run-details-empty" role="status">
        {query ? <Search size={28} aria-hidden="true"/> : <ListTree size={28} aria-hidden="true"/>}
        <p>{query ? t("没有匹配的过程记录") : t("尚无过程记录")}</p>
        <span>{query ? t("换个关键词再试试。") : disconnected ? t("连接恢复后可刷新查看过程记录。") : live ? t("收到过程记录后会自动显示。") : t("可返回对话查看回复。")}</span>
      </div>}
      <ol className="run-timeline">{page?.entries.map(entry => <RunStep key={entry.seq} entry={entry} initialOpen={view.expanded.has(entry.seq)} change={open => { if (open) view.expanded.add(entry.seq); else view.expanded.delete(entry.seq); }}/>)}</ol>
      {!!page?.files.length && <section className="run-delivered-files"><h3>{t("已发送的文件")}</h3>{page.files.map(file => <AttachmentFile key={file.attachmentId} connection={connection} block={file} list/>)}</section>}
      <details className="run-record-info"><summary data-disclosure-icon><ChevronRight size={14} aria-hidden="true"/>{t("关于过程记录")}</summary>
        {live && !["waiting_approval", "waiting_answer", "stopping"].includes(phase) && <p className="run-update-explanation">{t("部分任务会在完成后返回结果；进度上报间隔不一定代表任务停顿。")}</p>}
        <p className="run-retention">{t("公开事件记录保留 30 天；最多 2000 步、8 MiB。仅展示 CLI 返回的内容。")}</p>
      </details>
    </div>
    {(hasPagination || notice) && <footer className="run-details-footer">
      {hasPagination && <>
      {tailAvailable && <button aria-label={t("跳到最早记录")} title={t("跳到最早记录")} disabled={busy || page?.previous == null} onClick={() => { view.history = []; move(0); }}><ChevronsLeft size={16}/></button>}
      <button disabled={busy || (tailAvailable ? page?.previous == null : !view.history.length)} onClick={() => tailAvailable ? page?.previous != null && move(0, page.previous) : move(view.history.pop() ?? 0)}>{t("上一页")}</button>
      </>}
      <span>{notice || (busy ? t("正在加载过程…") : t("按事件顺序显示"))}</span>
      {hasPagination && <>
      <button disabled={page?.next == null || busy} onClick={() => { if (page?.next != null) { view.history.push(after); move(page.next); } }}>{t("下一页")}</button>
      {tailAvailable && <button aria-label={t("跳到最新记录")} title={t("跳到最新记录")} disabled={busy || page?.next == null} onClick={() => { view.history = []; move(0, undefined, true); }}><ChevronsRight size={16}/></button>}
      </>}
    </footer>}
  </CreationDialog>;
}

function RunStep({ entry, initialOpen, change }: { entry: RunEntry; initialOpen: boolean; change: (open: boolean) => void }) {
  const [open, setOpen] = useState(initialOpen), [copied, setCopied] = useState(false), [copyError, setCopyError] = useState(false);
  const plan = runPlan(entry), diff = runDiff(entry), sources = runKind(entry) === "search" ? runSources([entry.output, ...(entry.sources?.map(source => source.url) ?? [])].join("\n")) : [], exit = runExitCode(entry);
  const activity = entry.kind === "text" && entry.name?.startsWith("subagent_") ? runInput(entry) : undefined;
  const childReports = codexAgentReports(entry);
  const copy = async () => { try { await navigator.clipboard.writeText(JSON.stringify(entry, null, 2)); setCopied(true); setCopyError(false); } catch { setCopyError(true); } };
  return <li className={`run-step is-${entry.status}`} data-seq={entry.seq}><details open={open} onToggle={e => { const next = e.currentTarget.open; setOpen(next); change(next); }}>
    <summary data-disclosure-icon><ChevronRight size={14} aria-hidden="true"/><span className="run-step-title">{entry.scope && <span className="run-step-scope"><span>{runScopeLabel(entry.scope)}</span></span>}{runEntryTitle(entry)}</span><span className="run-step-status">{entryStatus(entry)}</span>{(entry.durationMs !== undefined || entry.endedAt !== undefined) && <time>{formatRunDuration(entry.durationMs ?? (entry.endedAt! - entry.at), true)}</time>}</summary>
    {open && <div className="run-step-detail"><button className="run-copy" onClick={() => void copy()}><Copy size={14}/>{copied ? t("已复制") : t("复制此步骤")}</button>{copyError && <p role="alert">{t("复制失败，请手动选择内容。")}</p>}
      {entry.name === "engine_retry" ? <p>{t("短暂故障后在原会话中自动续接，保留已完成的工作。")}</p> : isContextMaintenance(entry) ? <p>{entry.name === "context_checkpoint" ? t("生成对话摘要，供后续处理使用。") : t("整理较早的对话内容，为后续处理腾出上下文空间。")}</p> : activity ? <>
        {typeof activity.model === "string" && <p>{t("模型")} · {activity.model}{typeof activity.effort === "string" ? ` · ${activity.effort}` : ""}</p>}
        {typeof activity.label === "string" && <small>{activity.label}</small>}
        {typeof activity.agentId === "string" && <small>{t("子代理 ID：{0}", activity.agentId)}</small>}
      </> : entry.name && entry.name !== "CodexAgent" && <small>{entry.name}</small>}{entry.truncated && <p className="run-notice">{t("此步骤内容已截短")}</p>}
      {entry.scope && <><small>{t("作用域：{0}", entry.scope.id)}</small>{runScopeParent(entry.scope) && <small>{runScopeParent(entry.scope)}</small>}</>}
      {exit !== undefined && <p>{t("退出状态：{0}", exit)}</p>}{(entry.durationMs !== undefined || entry.endedAt !== undefined) && <p>{t("耗时：{0}", formatRunDuration(entry.durationMs ?? (entry.endedAt! - entry.at), true))}</p>}{entry.text && <section className={runKind(entry) === "delegate" ? "run-child-progress" : undefined}>{runKind(entry) === "delegate" && <h4>{t("子代理进展")}</h4>}<div className="card-text"><MarkdownText text={entry.text}/></div></section>}
      {!!plan.length && <ul className="run-plan">{plan.map((item, index) => <li key={index}><span>{item.status === "completed" ? "✓" : item.status === "in_progress" ? "◉" : "○"}</span><span>{item.content}</span><small>{item.status === "completed" ? t("已完成") : item.status === "in_progress" ? t("执行中") : t("待执行")}</small></li>)}</ul>}
      {diff && <section><h4>{entry.changes?.length ? t("工具返回的差异") : t("请求的修改")}</h4><pre className="run-diff">{diff.split("\n").map((line, i) => <span key={i} className={line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : ""}>{line}{"\n"}</span>)}</pre></section>}
      {!!sources.length && <section><h4>{t("搜索来源")}</h4><ul>{sources.map(url => <li key={url}><a href={url} target="_blank" rel="noopener noreferrer">{url}</a></li>)}</ul></section>}
      {entry.input && <details className="run-raw"><summary>{t("原始参数")}</summary><CodeBlock text={entry.input} language="json" className="run-code" copyLabel={t("复制原始参数")}/></details>}
      {childReports !== undefined ? <section className="run-child-result"><h4>{t("子代理回复")}</h4>{childReports.length ? childReports.map(report => <article className="run-agent-report" key={report.id}>
        <header><span>{report.id}</span><strong data-state={report.status === "errored" ? "errored" : undefined}>{codexAgentStatus(report.status)}</strong></header>
        {report.unreadable && <p>{t("回复格式暂不支持，请查看原始输出。")}</p>}
        {report.message && <div className="card-text"><MarkdownText text={report.message}/></div>}
      </article>) : <p>{t("尚无子代理状态回执")}</p>}</section> : runKind(entry) === "delegate" && entry.name !== "CodexAgent" && entry.output && <section className="run-child-result"><h4>{t("子代理回复")}</h4><div className="card-text"><MarkdownText text={entry.output}/></div></section>}
      {entry.output !== undefined && (runKind(entry) === "delegate" ? <details className="run-raw" open={entry.name === "CodexAgent" && childReports === undefined ? true : undefined}><summary>{t("原始输出")}</summary><CodeBlock text={entry.output} className="run-code" copyLabel={t("复制原始输出")}/></details> : <section><h4>{t("原始输出")}</h4>{entry.output ? <CodeBlock text={entry.output} className="run-code" copyLabel={t("复制原始输出")}/> : <p>{t("工具未返回文本输出")}</p>}</section>)}
    </div>}
  </details></li>;
}
