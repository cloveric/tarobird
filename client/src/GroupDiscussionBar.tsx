import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, ChevronRight, ListOrdered, LoaderCircle, MessageSquare, MessagesSquare, Paperclip, Pause, Play, Settings2, Square } from "lucide-react";
import { groupDiscussionActive, groupDiscussionViewSchema, groupDiscussionStepSchema, GROUP_DISCUSSION_TEXT_LIMIT, hasVisibleGroupText, type GroupDiscussionAction, type GroupDiscussionRun, type GroupDiscussionStep, type GroupDiscussionView } from "../../src/client-protocol/group-discussion.js";
import type { Conversation } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import { GroupSettings } from "./GroupSettings.js";
import { DiscussionParticipants } from "./DiscussionParticipants.js";
import { Avatar } from "./Avatar.js";
import { MarkdownText } from "./MarkdownText.js";
import { HubHttpError } from "./http-error.js";
import { timeoutSignal } from "./abort-signals.js";
import { uploadFile } from "./files.js";
import { AttachmentDraft } from "./AttachmentDraft.js";
import { useConversationDrafts } from "./conversation-drafts.js";
import { discussionStartReceiptKey, discussionStartReceiptSchema, type DiscussionStartReceipt } from "./group-discussion-receipt.js";
import { discussionSendProblem as problem, groupReplyModeFromView, type GroupReplyMode } from "./group-composer-send.js";
import { t, useLocale } from "./i18n.js";
import "./group-discussion.css";

const modeLabel = (mode: string) => mode === "parallel" ? t("并行回复") : mode === "independent" ? t("独立评议") : mode === "sequential" ? t("轮流讨论") : t("普通群聊");
function stanceLabel(step?: GroupDiscussionStep): string {
  const stance = step?.stance;
  if (!stance) return step ? t("未明确表态") : t("尚未发言");
  if (stance.kind === "propose") return t("提出提案");
  if (stance.kind === "agree") return step?.vote === "agree" ? t("同意 {0}", stance.proposalId ?? "") : t("同意 {0}（未确认）", stance.proposalId ?? "");
  if (stance.kind === "disagree") return t("持不同意见");
  return t("暂不表态");
}
function runLabel(run: GroupDiscussionRun): string {
  if (run.status === "pausing") return t("本次发言结束后暂停");
  if (run.status === "paused") return run.pauseReason?.startsWith("turn_") ? t("发言未完成，等待处理") : t("讨论已暂停");
  if (run.status === "ending") return t("正在结束讨论…");
  if (run.status === "interrupted") return t("讨论中断，尚未重试");
  if (run.status === "failed") return t("讨论未能完成");
  if (run.status === "ended") return t("讨论已结束");
  if (run.status === "completed") return run.outcome === "consensus" ? t("已达成共识") : t("保留各方意见");
  if (run.mode === "independent" && run.stage === "blind") return t("独立评议中 · {0}/{1}", run.steps.filter(step => step.round === 1 && step.status === "completed").length, run.participants.length);
  const speaker = run.participants.find(p => p.botId === run.currentBotId)?.name;
  if (speaker && run.steps.some(step => step.botId === run.currentBotId && step.status === "queued")) return t("等待 {0} 发言", speaker);
  return speaker ? t("{0} 正在发言", speaker) : t("正在准备下一位发言");
}
/** Owns UI/read-back only. The Hub owns scheduling, ordering and termination. */
export function GroupDiscussionBar({ connection, conversation, group, active, select, modeChanged, participants, participantNames }: {
  connection: HubConnection; conversation: Conversation; group: Conversation; active: boolean; select: (id: string) => void;
  modeChanged?: (value: GroupReplyMode) => void;
  participants: { ids: string[]; ready: boolean; error: boolean; change: (ids: string[]) => void };
  participantNames: ReadonlyMap<string, string>;
}) {
  useLocale();
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const [view, setView] = useState<GroupDiscussionView>(), [error, setError] = useState("");
  const [readError, setReadError] = useState(false);
  const [dialog, setDialog] = useState<"start" | "details" | "settings">(), [confirmEnd, setConfirmEnd] = useState(false);
  const [text, setText] = useState(""), [draftReady, setDraftReady] = useState(false), [draftError, setDraftError] = useState(false);
  const [startReceipt, setStartReceipt] = useState<DiscussionStartReceipt>(), [receiptError, setReceiptError] = useState(false);
  const unreadableReceipt = useRef<string | undefined>(undefined);
  const [confirmReceiptReset, setConfirmReceiptReset] = useState(false);
  const [busy, setBusy] = useState(false), [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [stepDetails, setStepDetails] = useState<Record<string, { value?: GroupDiscussionStep; loading?: boolean; error?: boolean }>>({});
  const detailRequests = useRef(new Set<string>());
  const alive = useRef(false), fetching = useRef<Promise<void> | undefined>(undefined), mutation = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const pending = useRef<{ key: string; body: object } | undefined>(undefined);
  const draftWrites = useRef<Promise<void>>(Promise.resolve());
  const draftKey = `discussion-topic:${conversation.id}`;
  const receiptKey = discussionStartReceiptKey(conversation.id);
  const fileDraft = useConversationDrafts(draftKey, connection.cache, connection.identity);
  const fileInput = useRef<HTMLInputElement>(null), uploadAbort = useRef<AbortController | undefined>(undefined);
  const uploaded = useRef(new WeakMap<File, string>());
  const [uploadProgress, setUploadProgress] = useState<number>();
  const base = `/api/conversations/${conversation.id}/discussion`;
  const online = state.status === "online" && !connection.isReadOnly;
  const visibleError = error || (readError ? t("未能读取讨论状态，请稍后刷新。") : "");
  const run = view?.run, running = run && groupDiscussionActive(run);
  const selectedOrder = view?.settings.policy.botOrder.filter(id => participants.ids.includes(id)) ?? [];
  const memberName = (id: string) => participantNames.get(id) ?? state.bots.find(bot => bot.id === id)?.name ?? id;
  const participantProblem = !participants.ready || participants.error ? t("参与者选择尚未读取或保存，请重新选择后发送。")
    : selectedOrder.length < 2 ? t("发起讨论至少需要两位 Bot；只点名一位时，请从输入框发送。")
    : !state.groupDiscussionRecoveryAvailable && selectedOrder.length !== view?.settings.policy.botOrder.length ? t("更新主机后可选择本次讨论的参与者，内容已保留。") : "";
  useEffect(() => { if (view) modeChanged?.(groupReplyModeFromView(conversation.id, view)); }, [conversation.id, view, modeChanged]);
  const canStart = online && !group.archived && !conversation.archived;
  const canControl = canStart && (state.user?.id === group.ownerId || state.user?.id === run?.createdBy);
  const routeScope = useRef(0), lastReadRevision = useRef(-1), liveRun = useRef(false);
  const knownView = useRef<string | undefined>(undefined);
  liveRun.current = !!running;
  const refresh = useCallback(async () => {
    if (mutation.current) return;
    if (fetching.current) return fetching.current;
    const generation = routeScope.current, revision = connection.groupDiscussionRevision;
    // A committed invalidation needs a fresh projection even on older Hosts,
    // whose known token does not include this reader's personal deletions.
    const known = lastReadRevision.current === revision ? knownView.current : undefined;
    const task = connection.http<unknown>(`${base}?brief=1${known ? `&known=${encodeURIComponent(known)}` : ""}`, { signal: timeoutSignal(10_000) }).then(raw => {
      if (!alive.current || generation !== routeScope.current) return;
      const metadata = raw && typeof raw === "object" ? raw as { unchanged?: unknown } : undefined;
      if (metadata?.unchanged === true && known) {
        lastReadRevision.current = revision; setReadError(false); return;
      }
      const latest = groupDiscussionViewSchema.parse(raw);
      knownView.current = latest.viewRevision ?? `${latest.run ? `${latest.run.id}.${latest.run.revision}` : "none"}.${latest.settings.revision}`;
      lastReadRevision.current = revision; setView(latest); setReadError(false);
    });
    fetching.current = task;
    try { await task; } finally { if (fetching.current === task) fetching.current = undefined; }
  }, [connection, base]);
  useEffect(() => {
    alive.current = true;
    let changed = false;
    void Promise.all([connection.cache.draft(draftKey), connection.cache.operationRecord(receiptKey)]).then(([value, raw]) => {
      if (alive.current && !changed) {
        setText(value);
        try { setStartReceipt(raw ? discussionStartReceiptSchema.parse(JSON.parse(raw)) : undefined); }
        catch { unreadableReceipt.current = raw; setReceiptError(true); }
        setDraftReady(true);
      }
    }).catch(() => { if (alive.current && !changed) { setReceiptError(true); setDraftError(true); } });
    return () => { alive.current = false; changed = true; routeScope.current++; knownView.current = undefined; uploadAbort.current?.abort(); };
  }, [connection, draftKey]);
  useEffect(() => {
    if (!active || !online || !state.groupDiscussionAvailable) return;
    lastReadRevision.current = -1;
    let cancelled = false, reading = false, timer: ReturnType<typeof setTimeout> | undefined, eventTimer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (cancelled || reading || document.visibilityState === "hidden") return;
      reading = true;
      try { if (liveRun.current || lastReadRevision.current !== connection.groupDiscussionRevision) await refresh(); } catch { if (!cancelled && alive.current) setReadError(true); }
      finally { reading = false; }
      if (!cancelled) timer = setTimeout(() => { void read(); }, 4000);
    };
    const wake = () => { lastReadRevision.current = -1; if (timer) clearTimeout(timer); void read(); };
    // Coalesce committed Hub events, so a newly dispatched speaker is shown
    // promptly without one HTTP request per streaming publication.
    const unsubscribe = connection.subscribe(() => {
      if (lastReadRevision.current === connection.groupDiscussionRevision || eventTimer !== undefined) return;
      eventTimer = setTimeout(() => { eventTimer = undefined; if (timer) clearTimeout(timer); void read(); }, 300);
    });
    void read(); document.addEventListener("visibilitychange", wake);
    return () => { cancelled = true; if (timer) clearTimeout(timer); if (eventTimer) clearTimeout(eventTimer); unsubscribe(); document.removeEventListener("visibilitychange", wake); };
  }, [active, online, state.groupDiscussionAvailable, refresh]);
  const editText = (value: string) => {
    setText(value);
    draftWrites.current = draftWrites.current.catch(() => undefined).then(() => connection.cache.saveDraft(draftKey, value));
    void draftWrites.current.then(() => { if (alive.current) setDraftError(false); }, () => { if (alive.current) setDraftError(true); });
  };
  const readStep = async (step: GroupDiscussionStep) => {
    if (!run || !step.textTruncated || stepDetails[step.id]?.value || detailRequests.current.has(step.id)) return;
    detailRequests.current.add(step.id);
    setStepDetails(old => ({ ...old, [step.id]: { loading: true } }));
    try {
      const value = groupDiscussionStepSchema.parse(await connection.http(`/api/conversations/${run.conversationId}/discussion/${run.id}/steps/${step.id}`, { signal: timeoutSignal(15_000) }));
      if (value.id !== step.id) throw new Error("discussion_step_mismatch");
      if (alive.current) setStepDetails(old => ({ ...old, [step.id]: { value } }));
    } catch {
      if (alive.current) setStepDetails(old => ({ ...old, [step.id]: { error: true } }));
    } finally { detailRequests.current.delete(step.id); }
  };
  useEffect(() => { setStepDetails({}); setExpanded(new Set()); }, [run?.id]);
  const mutate = async (action: "start" | GroupDiscussionAction) => {
    if (!view || mutation.current || (action === "start" ? !canStart || !draftReady || receiptError || !fileDraft.ready || !startReceipt && (!!participantProblem || !hasVisibleGroupText(text) || text.length > GROUP_DISCUSSION_TEXT_LIMIT || fileDraft.files.length > 16 || !!running) : !canControl || !run)) return;
    const submitted = text.trim();
    let revision = action === "start" ? view.settings.revision : run!.revision;
    mutation.current = true; routeScope.current++; knownView.current = undefined; setBusy(true); setError("");
    let receipt: DiscussionStartReceipt | undefined, serializedReceipt: string | undefined, received = false;
    try {
      if (action === "start") {
        const raw = await connection.cache.operationRecord(receiptKey);
        if (raw) {
          try { receipt = discussionStartReceiptSchema.parse(JSON.parse(raw)); }
          catch { unreadableReceipt.current = raw; setReceiptError(true); throw new Error("discussion_receipt_unreadable"); }
          setStartReceipt(receipt); serializedReceipt = raw;
          if (!startReceipt) throw new Error("discussion_receipt_changed");
          if (JSON.stringify(startReceipt) !== JSON.stringify(receipt)) throw new Error("discussion_receipt_changed");
        } else if (startReceipt) {
          setStartReceipt(undefined); throw new Error("discussion_receipt_changed");
        }
      }
      if (action !== "start") {
        // Dispatch/attention publications can update the revision between the
        // displayed button and this click. Read the same run before submitting
        // one control request; never replay a mutation automatically.
        const current = groupDiscussionViewSchema.parse(await connection.http(`${base}?brief=1`, { signal: timeoutSignal(10_000) }));
        if (!alive.current) return;
        setView(current); setReadError(false);
        if (current.run?.id !== run!.id || !current.run.actions?.includes(action) || (action === "resume" || action === "retry") && current.run.revision !== run!.revision) {
          setError(t("讨论或设置已变化，已保留输入。请核对最新状态后重试。"));
          return;
        }
        revision = current.run.revision;
      }
      const attachments: string[] = [];
      if (action === "start" && !receipt) {
        await draftWrites.current;
        const fileRevision = await fileDraft.flush();
        if (await connection.cache.draft(draftKey) !== text) throw new Error("discussion_draft_changed");
        const controller = new AbortController(); uploadAbort.current = controller;
        for (let index = 0; index < fileDraft.files.length; index++) {
          const file = fileDraft.files[index]!;
          let id = uploaded.current.get(file);
          if (!id) {
            id = await uploadFile(connection, conversation.id, file, fraction => { if (alive.current) setUploadProgress((index + fraction) / fileDraft.files.length); }, { signal: controller.signal });
            uploaded.current.set(file, id);
          }
          attachments.push(id);
        }
        if (controller.signal.aborted || !alive.current) return;
        uploadAbort.current = undefined; setUploadProgress(undefined);
        receipt = discussionStartReceiptSchema.parse({ version: 1, body: { requestId: `gdc_${crypto.randomUUID()}`, revision, text: submitted, attachments, ...(state.groupDiscussionRecoveryAvailable ? { participants: selectedOrder } : {}) }, draftText: text, fileRevision });
        serializedReceipt = JSON.stringify(receipt);
        if (!await connection.cache.updateOperationIfMatches(receiptKey, "", serializedReceipt)) throw new Error("discussion_receipt_changed");
        setStartReceipt(receipt);
      }
      const key = JSON.stringify([action, revision, action === "start" ? [submitted, attachments] : run!.id]);
      // Retry the same uncertain request only after an explicit click.
      if (pending.current?.key !== key) pending.current = { key, body: { requestId: `gdc_${crypto.randomUUID()}`, revision, ...(action === "start" ? { text: submitted, ...(attachments.length ? { attachments } : {}) } : { action }) } };
      const latest = groupDiscussionViewSchema.parse(await connection.http(action === "start" ? base : `/api/conversations/${run!.conversationId}/discussion/${run!.id}/control`, {
        method: "POST", body: JSON.stringify(action === "start" ? receipt!.body : pending.current.body), signal: timeoutSignal(30_000),
      }));
      received = true;
      pending.current = undefined;
      // A confirmed Hub result remains authoritative even if local draft cleanup fails.
      if (alive.current) { setView(latest); setReadError(false); setConfirmEnd(false); if (action === "start") setDialog("details"); }
      if (action === "start") {
        await draftWrites.current;
        if (await fileDraft.flush() === receipt!.fileRevision) { fileDraft.clearSent(true); await fileDraft.flush(); }
        await connection.cache.clearDraftIfMatches(draftKey, receipt!.draftText);
        await connection.cache.clearOperationIfMatches(receiptKey, serializedReceipt!);
        if (alive.current) { if (text === receipt!.draftText) setText(""); setStartReceipt(undefined); }
      }
    } catch (e) {
      if (e instanceof HubHttpError && e.status >= 400 && e.status < 500) {
        pending.current = undefined;
        if (serializedReceipt) {
          await connection.cache.clearOperationIfMatches(receiptKey, serializedReceipt).then(() => { if (alive.current) setStartReceipt(undefined); }).catch(() => undefined);
        }
      }
      if (alive.current) setError(received ? t("讨论已确认，草稿清理暂未完成。请核对上次发送，不要重新发起。")
        : e instanceof Error && ["discussion_receipt_changed", "discussion_draft_changed"].includes(e.message) ? t("课题或发送记录已在其他窗口变化，请重新打开后核对。")
        : e instanceof Error && e.message === "discussion_receipt_unreadable" ? t("上次发送记录无法读取，请先核对群内记录，暂不重复发起。")
        : uploadAbort.current ? t("附件尚未上传完成，课题未发送。请检查连接后重试。") : problem(e));
      mutation.current = false;
      await refresh().catch(() => undefined);
    } finally { mutation.current = false; uploadAbort.current = undefined; if (alive.current) { setBusy(false); setUploadProgress(undefined); } }
  };
  const openStart = async () => {
    if (mutation.current) return;
    setDialog("start"); setDraftReady(false); setError("");
    try {
      await draftWrites.current;
      const [value, raw] = await Promise.all([connection.cache.draft(draftKey), connection.cache.operationRecord(receiptKey)]);
      if (!alive.current) return;
      setText(value); unreadableReceipt.current = undefined; setReceiptError(false);
      try { setStartReceipt(raw ? discussionStartReceiptSchema.parse(JSON.parse(raw)) : undefined); }
      catch { unreadableReceipt.current = raw; setReceiptError(true); }
      setDraftReady(true);
    } catch { if (alive.current) { setReceiptError(true); setDraftError(true); } }
  };
  const resetReceipt = async () => {
    if (mutation.current || unreadableReceipt.current === undefined) return;
    mutation.current = true; setBusy(true);
    try {
      // Explicit recovery clears only the exact malformed local receipt the
      // user reviewed, never a newer pending send or any Hub task.
      if (!await connection.cache.updateOperationIfMatches(receiptKey, unreadableReceipt.current, "")) throw new Error("receipt_changed");
      setConfirmReceiptReset(false); setReceiptError(false); unreadableReceipt.current = undefined;
    } catch { setError(t("课题或发送记录已在其他窗口变化，请重新打开后核对。")); }
    finally { mutation.current = false; setBusy(false); }
  };
  if (!state.groupDiscussionAvailable) return null;
  const mode = view?.settings.policy.mode ?? "mentions";
  const allowed = (action: GroupDiscussionAction) => canControl && (run?.actions?.includes(action) ?? false);
  const otherConversation = run && run.conversationId !== conversation.id && running;
  const showSettings = () => setDialog("settings");
  return <>
    <section className={`group-discussion-strip${running ? " is-active" : ""}`} aria-label={t("群聊方式与讨论状态")}>
      <button ref={trigger} className="group-discussion-summary" aria-label={t("群聊方式与讨论状态")} disabled={!view} onClick={() => setDialog(run ? "details" : "settings")}>
        {running ? <span className={`group-discussion-dot${run.status === "paused" ? " is-paused" : ""}`}/> : mode === "mentions" ? <MessageSquare size={15}/> : mode === "parallel" ? <MessagesSquare size={15}/> : <ListOrdered size={15}/>}
        <span role="status" aria-live="polite">{!view ? t("正在读取讨论状态…") : run && mode !== "parallel" ? runLabel(run) : modeLabel(mode)}</span>
        {running && <small>{t("第 {0}/{1} 轮", run.round, run.maxRounds)}</small>}<ChevronRight size={14}/>
      </button>
      {(!!startReceipt || receiptError || !running && (mode === "sequential" || mode === "independent")) && <button className="group-discussion-start" disabled={!canStart || !view} onClick={() => void openStart()}><Play size={13}/>{startReceipt || receiptError ? t("核对上次发送") : t("发起讨论")}</button>}
      {!running && view && mode === "mentions" && <small className="group-mention-hint">{t("不 @ 仅记录")}</small>}
      {!running && view && mode === "parallel" && <small className="group-mention-hint">{t("不 @ 全员回复 · @ 仅点名")}</small>}
      <button className="group-discussion-settings" aria-label={t("设置群聊方式")} title={t("设置群聊方式")} onClick={showSettings}><Settings2 size={16}/></button>
    </section>
    {running && <section className="discussion-current-topic" aria-label={t("当前讨论课题")}>
      <button type="button" className="discussion-topic-preview" title={run.topic} onClick={() => setDialog("details")}><span>{t("课题")}</span><strong>{run.topic}</strong><ChevronRight size={13}/></button>
      <div className="discussion-quick-controls">
        {run.status === "running" && <button type="button" disabled={!allowed("pause") || busy} onClick={() => void mutate("pause")}><Pause size={13}/>{t("暂停讨论")}</button>}
        {allowed("resume") && <button type="button" disabled={busy} onClick={() => void mutate("resume")} title={run.pauseReason?.startsWith("turn_") ? t("跳过未完成发言并继续") : t("继续原讨论")}><Play size={13}/>{run.pauseReason?.startsWith("turn_") ? t("跳过并继续") : t("继续原讨论")}</button>}
        {allowed("retry") && <button type="button" disabled={busy} onClick={() => void mutate("retry")}><Play size={13}/>{t("重试未完成发言")}</button>}
        {run.status !== "ending" && <button type="button" disabled={!allowed("end") || busy} onClick={() => void mutate("end")}><Square size={13}/>{t("停止本次讨论")}</button>}
      </div>
    </section>}
    {run && (!!run.noteCount || run.status === "paused") && <div className="discussion-note-receipt">
      {!!run.noteCount && <span>{t("已补充 {0} 条", run.noteCount)}</span>}
      {run.latestNote && <span className="discussion-latest-note" title={run.latestNote.text}>{t("最近补充：{0}", run.latestNote.text || t("附件"))}</span>}
      {!!run.unseenNoteCount && <span role="status">{running ? t("{0} 条补充尚未进入 Bot 的回复", run.unseenNoteCount) : t("本轮已结束，仍有 {0} 条补充未进入回复，请作为新课题发送。", run.unseenNoteCount)}</span>}
      {run.status === "paused" && !!run.retryTargets?.length && <span>{t("重试发言：{0}", run.retryTargets.map(turn => run.participants.find(bot => bot.botId === turn.botId)?.name ?? turn.botId).join("、"))}</span>}
      {run.status === "paused" && run.actions?.includes("resume") && (run.next ? <span>{run.pauseReason?.startsWith("turn_") ? t("跳过后由 {0} 继续", run.participants.find(bot => bot.botId === run.next?.botId)?.name ?? run.next.botId) : t("继续后由 {0} 接着讨论原课题", run.participants.find(bot => bot.botId === run.next?.botId)?.name ?? run.next.botId)}</span> : <span>{t("继续后结束本次讨论")}</span>)}
    </div>}
    {visibleError && !dialog && <div className="group-discussion-error" role="alert"><span>{visibleError}</span><button onClick={() => { setError(""); void refresh().catch(() => setReadError(true)); }}>{t("刷新")}</button></div>}
    {dialog === "settings" && <GroupSettings connection={connection} group={group} bots={state.bots} returnFocus={trigger} close={() => { setDialog(undefined); void refresh().catch(() => undefined); }}/>}
    {dialog === "start" && view && <CreationDialog title={t("发起讨论")} closeLabel={t("关闭讨论课题")} className="group-discussion-dialog" busy={busy} returnFocus={trigger} initialFocus={input} close={() => setDialog(undefined)}>
      <div className="discussion-start-heading"><span>{startReceipt ? t("核对上次发送") : modeLabel(mode)}</span>{!startReceipt && <small>{t("最多 {0} 轮 · {1} 次发言", view.settings.policy.maxRounds, view.settings.policy.maxRounds * selectedOrder.length)}</small>}</div>
      {!startReceipt && <DiscussionParticipants members={view.settings.policy.botOrder.map(id => ({ id, name: memberName(id) }))} selected={selectedOrder} change={participants.change} locked={false} disabled={busy || !participants.ready || receiptError}/>}
      {!startReceipt && participantProblem && <p role="status" className="creation-help">{participantProblem}</p>}
      <form onSubmit={event => { event.preventDefault(); if ((startReceipt || hasVisibleGroupText(text)) && draftReady) void mutate("start"); }}>
        <label>{t("这次讨论什么？")}<textarea ref={input} aria-label={t("讨论课题")} value={startReceipt?.draftText ?? text} rows={5} maxLength={GROUP_DISCUSSION_TEXT_LIMIT} disabled={busy || !draftReady || !!startReceipt || receiptError} placeholder={t("说明目标、背景和需要大家讨论的问题…")} onChange={event => editText(event.target.value)}/></label>
        <input ref={fileInput} type="file" multiple hidden aria-label={t("选择课题附件")} disabled={busy || !fileDraft.ready || !!startReceipt || receiptError} onChange={event => {
          const chosen = Array.from(event.target.files ?? []); event.target.value = "";
          if (chosen.length + fileDraft.files.length > 16) { setError(t("每个课题最多添加 16 个附件。")); return; }
          fileDraft.setFiles(old => [...old, ...chosen]);
        }}/>
        {fileDraft.files.length ? <AttachmentDraft files={fileDraft.files} remove={index => fileDraft.setFiles(old => old.filter((_, i) => i !== index))} add={() => fileInput.current?.click()} busy={busy || !fileDraft.ready || !!startReceipt || receiptError} maxFileBytes={state.maxFileBytes}/> : <button type="button" className="discussion-add-file" disabled={busy || !fileDraft.ready || !!startReceipt || receiptError} onClick={() => fileInput.current?.click()}><Paperclip size={15}/>{t("添加课题附件")}</button>}
        {uploadProgress !== undefined && <div className="discussion-upload" role="status"><progress max={1} value={uploadProgress}/><span>{t("正在上传 {0}%", Math.round(uploadProgress * 100))}</span><button type="button" onClick={() => uploadAbort.current?.abort()}>{t("取消上传")}</button></div>}
        {!startReceipt && <div className="discussion-participant-preview" aria-label={t("参与者与顺序")}>{selectedOrder.map((id, i) => {
          const name = memberName(id); return <span key={id}><b>{i + 1}</b><Avatar kind="bot" id={id} name={name} size={22}/>{name}</span>;
        })}</div>}
        {!startReceipt && <p className="group-mode-footnote">{mode === "independent" ? t("首轮各自回答，收齐后讨论。达到轮数上限仍不一致，会保留各自意见。") : t("按上述顺序逐个发言，可随时暂停或结束。达到轮数上限后保留各方意见。")}</p>}
        {draftError && <p role="alert" className="error-text">{t("课题草稿暂未保存，请保留此窗口。")}</p>}
        {startReceipt && <p role="status" className="creation-help">{t("上次发送结果尚待核对。将使用原课题和原请求编号，不会重新发起同一讨论。")}</p>}
        {receiptError && <div role="alert" className="error-text"><p>{t("上次发送记录无法读取，请先核对群内记录，暂不重复发起。")}</p><button type="button" disabled={busy} onClick={() => void openStart()}>{t("重新读取发送记录")}</button>{unreadableReceipt.current !== undefined && <button type="button" disabled={busy} onClick={() => setConfirmReceiptReset(true)}>{t("我已核对群内记录")}</button>}</div>}
        {fileDraft.error && <p role="alert" className="error-text">{t("附件草稿暂未保存，请保留此窗口。")} <button type="button" onClick={fileDraft.retry}>{t("重试")}</button></p>}
        {visibleError && <p role="alert" className="error-text">{visibleError}</p>}
        <div className="rename-conversation-actions"><button type="button" disabled={busy} onClick={() => setDialog(undefined)}>{t("取消")}</button><button className="primary" type="submit" disabled={receiptError || !draftReady || !fileDraft.ready || !startReceipt && (!!participantProblem || !hasVisibleGroupText(text) || fileDraft.files.length > 16 || !!running) || busy || !canStart}>{busy ? t("正在发起…") : startReceipt ? t("核对上次发送") : t("开始讨论")}</button></div>
      </form>
    </CreationDialog>}
    {confirmReceiptReset && <CreationDialog title={t("解除无法读取的发送保护？")} closeLabel={t("取消解除发送保护")} busy={busy} close={() => setConfirmReceiptReset(false)}>
      <p>{t("上次讨论可能已经执行。此操作只清除本地损坏的发送记录，保留草稿，不停止或重发任何讨论。请先确认群内记录。")}</p>
      <div className="rename-conversation-actions"><button disabled={busy} onClick={() => setConfirmReceiptReset(false)}>{t("取消")}</button><button disabled={busy} onClick={() => void resetReceipt()}>{t("解除发送保护")}</button></div>
    </CreationDialog>}
    {dialog === "details" && run && <CreationDialog title={t("讨论进展")} closeLabel={t("关闭讨论进展")} className="group-discussion-dialog" returnFocus={trigger} busy={busy} close={() => { setDialog(undefined); setConfirmEnd(false); }}>
      <div className="discussion-run-heading"><span>{modeLabel(run.mode)}</span><b>{runLabel(run)}</b></div>
      <h3 className="discussion-topic">{run.topic}</h3>
      {!!run.noteCount && <p className="creation-help">{t("已补充 {0} 条", run.noteCount)}{run.latestNote && <> · {t("最近补充：{0}", run.latestNote.text || t("附件"))}</>}</p>}
      {!!run.unseenNoteCount && <p className="creation-help" role="status">{running ? t("{0} 条补充尚未进入 Bot 的回复", run.unseenNoteCount) : t("本轮已结束，仍有 {0} 条补充未进入回复，请作为新课题发送。", run.unseenNoteCount)}</p>}
      {run.status === "paused" && !!run.retryTargets?.length && <p className="creation-help">{t("重试发言：{0}", run.retryTargets.map(turn => run.participants.find(bot => bot.botId === turn.botId)?.name ?? turn.botId).join("、"))}</p>}
      {run.status === "paused" && run.actions?.includes("resume") && run.next && <p className="creation-help">{run.pauseReason?.startsWith("turn_") ? t("跳过后由 {0} 继续", run.participants.find(bot => bot.botId === run.next?.botId)?.name ?? run.next.botId) : t("继续后由 {0} 接着讨论原课题", run.participants.find(bot => bot.botId === run.next?.botId)?.name ?? run.next.botId)}</p>}

      {run.status === "ending" && run.steps.some(step => step.status === "queued" && step.dispatched) && <p className="creation-help" role="status">{t("已请求取消排队发言。Bot 需先处理完前面的任务，才能确认取消；期间不能发起新的讨论。")}</p>}
      {otherConversation && <button className="discussion-open-topic" onClick={() => { setDialog(undefined); select(run.conversationId); }}>{t("前往正在讨论的话题")}<ChevronRight size={15}/></button>}
      {!online && <p className="creation-help" role="status">{t("连接恢复后即可操作")}</p>}
      {(run.proposal || run.conclusion) && <section className="discussion-conclusion">
        <h4>{run.outcome === "consensus" ? <><Check size={16}/>{t("共同结论")}</> : running ? t("当前提案") : t("各方意见")}</h4>
        {run.proposal && <><p className="discussion-proposal-id">{t("提案 {0} · {1}", run.proposal.id, run.participants.find(p => p.botId === run.proposal?.botId)?.name ?? "")}</p><MarkdownText text={run.proposal.text}/></>}
        {run.outcome === "consensus" && <p>{t("所有仍参与讨论的成员均已明确确认此提案。")}</p>}
        {!running && run.outcome !== "consensus" && <p>{run.outcome === "stopped" ? t("讨论已结束，保留各成员最后的意见。") : t("未达成全员一致，保留各成员最后的意见。")}</p>}
        <ul className="discussion-positions">{run.participants.map(participant => {
          const last = [...run.steps].reverse().find(step => step.botId === participant.botId && step.status === "completed");
          const position = run.positions?.find(value => value.botId === participant.botId);
          const label = position?.agreesWithProposal && position.stance !== "propose" ? t("同意 {0}", run.proposal?.id ?? "") : stanceLabel(last);
          const summary = position?.summary ?? last?.stance?.summary;
          return <li key={participant.botId}><strong>{participant.name}</strong><span>{participant.active === false ? t("已退出讨论") : label}</span>{summary && <small>{summary}</small>}</li>;
        })}</ul>
      </section>}
      {running && <p className="group-mode-footnote discussion-note-policy">{t("未 @ 的发言会作为补充说明供后续轮次参考；独立首轮不接收这些补充。")}</p>}
      <div className="discussion-turns">{run.steps.map((step, index) => {
        const who = run.participants.find(p => p.botId === step.botId)?.name ?? step.botId;
        const detail = stepDetails[step.id], shown = detail?.value ?? step;
        return <details key={step.id} className={`discussion-turn is-${step.status}`} onToggle={event => {
          const open = event.currentTarget.open;
          setExpanded(current => { const next = new Set(current); if (open) next.add(step.id); else next.delete(step.id); return next; });
          if (open) void readStep(step);
        }}>
          <summary><span className="discussion-turn-number">{String(index + 1).padStart(2, "0")}</span><Avatar kind="bot" id={step.botId} name={who} size={26}/><strong>{who}</strong><small>{t("第 {0} 轮", step.round)}</small><span className="discussion-turn-state">{step.status === "completed" ? <><Check size={15} aria-hidden="true"/><span>{stanceLabel(step)}</span></> : step.attention ? step.attention === "approval" ? t("等待审批") : t("等待回答") : step.status === "running" ? <><LoaderCircle size={15} className="spin" aria-hidden="true"/><span className="sr-only">{t("正在发言")}</span></> : step.status === "queued" ? t("等待发言") : t("未完成")}</span></summary>
          {expanded.has(step.id) && (shown.text ? <div className="discussion-turn-text">{shown.stance?.summary && <p className="discussion-position-summary">{shown.stance.summary}</p>}<MarkdownText text={shown.text}/>{shown.textTruncated && <p className="creation-help" role="status">{detail?.loading ? t("正在读取完整发言…") : t("当前只显示部分发言。")}{!detail?.loading && <button type="button" onClick={() => void readStep(step)}>{detail?.error ? t("重试") : t("读取完整发言")}</button>}</p>}</div> : <p className="creation-help">{step.status === "running" ? t("Bot 正在处理，请在群里查看运行过程或待回答的问题。") : step.status === "queued" ? run.status === "paused" || run.status === "pausing" ? step.dispatched ? t("这条发言已进入 Bot 队列，完成后暂停后续发言。") : t("继续讨论后再开始此发言。") : t("轮到后会自动开始。") : t("本次发言没有可展示的结果。")}</p>)}
        </details>;
      })}</div>
      {visibleError && <p role="alert" className="error-text">{visibleError}</p>}
      {run.error && (run.status === "paused" || run.status === "pausing") && <p className="creation-help">{t("发言未完整结束，讨论已暂停推进。请查看群内运行记录。")}</p>}
      <div className="discussion-controls">
        <button disabled={!online || busy} onClick={() => { setError(""); void refresh().catch(() => setReadError(true)); }}>{t("刷新状态")}</button>
        <span/>
        {run.status === "running" && <button disabled={!allowed("pause") || busy} onClick={() => void mutate("pause")}><Pause size={15}/>{t("暂停讨论")}</button>}
        {allowed("resume") && <button disabled={busy} onClick={() => void mutate("resume")}><Play size={15}/>{run.pauseReason?.startsWith("turn_") ? t("跳过未完成发言并继续") : t("继续讨论")}</button>}
        {allowed("retry") && <button disabled={busy} onClick={() => void mutate("retry")}><Play size={15}/>{t("重试未完成发言")}</button>}
        {running && <button disabled={!allowed("end") || busy || run.status === "ending"} onClick={() => setConfirmEnd(true)}><Square size={13}/>{t("结束讨论")}</button>}
      </div>
      {confirmEnd && <CreationDialog title={t("结束这次讨论？")} closeLabel={t("继续查看讨论")} busy={busy} close={() => setConfirmEnd(false)}>
        <p>{t("将停止尚未完成的发言，保留已有结果。确认后不会自动重启。")}</p>
        <div className="rename-conversation-actions"><button disabled={busy} onClick={() => setConfirmEnd(false)}>{t("继续讨论")}</button><button className="primary" disabled={busy} onClick={() => void mutate("end")}>{t("确认结束")}</button></div>
      </CreationDialog>}
    </CreationDialog>}
  </>;
}
