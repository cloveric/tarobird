import type { NativeInputCapability } from "../../src/client-protocol/native-input.js";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpToLine, ChevronRight, ArrowRight, GripVertical, ListOrdered, Pause, Play, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { blocksText, type Message } from "../../src/client-protocol/index.js";
import { promptQueueSnapshotSchema, type PromptQueueSnapshot, type PromptQueueAction } from "../../src/client-protocol/prompt-queue.js";
import { steerStatusSchema } from "../../src/client-protocol/steering.js";
import type { HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import { HubHttpError } from "./http-error.js";
import { assertMessageTextSize } from "./message-validation.js";
import { randomNonce } from "./identity.js";
import { queueRequest as requestSignal } from "./prompt-queue-request.js";
import { usePromptQueueDrag } from "./prompt-queue-drag.js";
import { promptQueueMove } from "./prompt-queue-order.js";
import { PromptQueueContextMenu } from "./PromptQueueContextMenu.js";
import { t, useLocale } from "./i18n.js";
import "./prompt-queue.css";

const textOnly = (message: Message) => message.blocks.filter(block => block.type === "text").map(block => block.text).join("\n");

// HubPromptQueue.mutate checks its durable receipt before these rejections.
// Authentication, membership, routing and schema errors can happen BEFORE that
// lookup: on a retry they cannot settle the earlier attempt's unknown outcome.
const receiptCheckedErrors = new Set([
  "idempotency_conflict", "queue_changed", "message_forbidden", "queue_already_dispatched",
  "queue_item_unsupported", "queue_control_barrier", "queue_command_edit_forbidden", "empty_message",
  "group_unsupported", "conversation_archived", "unsupported_engine", "worker_update_required", "queue_unsupported",
]);

function queueMutationError(cause: HubHttpError, editing: boolean): string {
  switch (cause.code || cause.message) {
    case "queue_command_edit_forbidden": return t("待执行消息不能改成控制命令。请在聊天输入框单独发送命令。");
    case "queue_control_barrier": return t("不能跨过控制命令调整顺序，请在同一段待执行消息中移动。");
    case "conversation_archived": return t("对话已归档，不能调整待执行消息。恢复对话后再操作。");
    case "worker_update_required": return t("此 Bot 的主机组件尚不支持队列管理，请更新主机后重试。");
    case "idempotency_conflict": return t("操作编号与主机记录冲突，本次修改未执行。请刷新队列并核对结果。");
    case "queue_already_dispatched": return editing ? t("这条消息已交给 Bot，不能再修改。编辑内容已保留，可复制后使用。") : t("这条消息已交给 Bot，不能再调整这条消息。");
    case "queue_item_unsupported": return t("这条消息不支持此操作，控制命令和已下发消息保持原有执行方式。");
    case "group_unsupported": case "unsupported_engine": case "queue_unsupported": return t("此 Bot 或对话暂不支持队列管理。");
    case "bot_deleted": return t("Bot 已删除，不能再调整待执行消息。");
    case "empty_message": return t("请输入文字或保留至少一个附件。");
    default: return cause.status === 409 ? editing ? t("队列已变化，已重新读取。编辑内容已保留，请核对后再保存。") : t("队列已变化，已重新读取。请核对后再操作。") : cause.status === 403 ? t("你没有修改这条待执行消息的权限。") : t("这条消息目前不能修改，请刷新队列后重试。");
  }
}

/** Measure actual clipping: character counts do not predict wrapped CJK text. */
function QueueMessageText({ text, disabled }: { text: string; disabled?: boolean }) {
  const paragraph = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false), [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const node = paragraph.current; if (!node) return;
    const measure = () => { if (!expanded) setClipped(node.scrollHeight > node.clientHeight + 1); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [text, expanded]);
  return <><p ref={paragraph} className={`prompt-queue-text${expanded ? " is-expanded" : ""}`}>{text}</p>{(clipped || expanded) && <button type="button" className="prompt-queue-expand" disabled={disabled} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? t("收起全文") : t("查看全文")}</button>}</>;
}

type Mutation = { botId: string; requestId: string; revision: string; action: PromptQueueAction };
type Edit = { id: string; text: string; revision: string; conflict?: boolean };
type LocalState = { edit?: Edit; pending?: Mutation };
// Queue edits never overwrite the chat composer. Keep unfinished edits and an
// uncertain operation across navigation in this App session, scoped to the
// exact connection, conversation and Bot. Nothing is sent on navigation.
const localStates = new WeakMap<HubConnection, Map<string, LocalState>>();
function localState(connection: HubConnection, key: string): LocalState {
  let scopes = localStates.get(connection);
  if (!scopes) { scopes = new Map(); localStates.set(connection, scopes); }
  let value = scopes.get(key);
  if (!value) { value = {}; scopes.set(key, value); }
  return value;
}

/** Capability is queried from this exact worker; engine names are not proof. */
export function useSteeringCapability(connection: HubConnection, conversationId: string, botId: string | undefined, active: boolean, activity: string): { supported: boolean; sendBehavior?: "steer"; nativeInput?: NativeInputCapability; targetId?: string; idle?: boolean } {
  const [supported, setSupported] = useState<{ scope: string; value: boolean; sendBehavior?: "steer"; nativeInput?: NativeInputCapability; targetId?: string; idle?: boolean }>();
  const scope = `${connection.identity.hubPublicKey}:${conversationId}:${botId}`, status = connection.state.status;
  useEffect(() => {
    const controller = new AbortController(); let reading = false, hasTarget = false; let timer: ReturnType<typeof setTimeout>;
    setSupported(previous => previous?.scope === scope ? previous.nativeInput ? previous : { ...previous, value: false } : undefined);
    if (!active || !botId || connection.state.status !== "online") return;
    const load = async () => {
      if (reading || controller.signal.aborted) return;
      reading = true; const request = requestSignal([controller.signal], 8000);
      try {
        const result = steerStatusSchema.parse(await request.wait(connection.http(`/api/conversations/${encodeURIComponent(conversationId)}/steer?${new URLSearchParams({ botId, review: "1" })}`, { signal: request.signal })));
        hasTarget = result.supported && !!result.targetId;
        if (!controller.signal.aborted) setSupported(previous => {
          const value = result.supported && !!result.targetId;
          return previous?.scope === scope && previous.value === value && previous.sendBehavior === result.sendBehavior && previous.targetId === result.targetId && previous.idle === (result.reason === "idle") && JSON.stringify(previous.nativeInput) === JSON.stringify(result.nativeInput) ? previous : { scope, value, sendBehavior: result.sendBehavior, nativeInput: result.nativeInput, targetId: result.targetId, idle: result.reason === "idle" };
        });
      } catch { if (!controller.signal.aborted) setSupported({ scope, value: false }); }
      finally { request.dispose(); reading = false; if (!controller.signal.aborted) timer = setTimeout(() => void load(), activity || hasTarget ? 5000 : 30_000); }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [connection, scope, active, botId, conversationId, status, activity]);
  return status === "online" && active && supported?.scope === scope ? { supported: supported.value, sendBehavior: supported.sendBehavior, nativeInput: supported.nativeInput, targetId: supported.targetId, idle: supported.idle } : { supported: false };
}

export function PromptQueue({ connection, conversationId, botId, phone, active, available, online, cacheRevision, locate }: {
  connection: HubConnection; conversationId: string; botId: string; phone: boolean; active: boolean; available: boolean; online: boolean; cacheRevision: number;
  locate: (conversationId: string, messageId: string) => void;
}) {
  useLocale();
  const local = localState(connection, `${conversationId}:${botId}`);
  const [snapshot, setSnapshot] = useState<PromptQueueSnapshot>();
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState<{ text: string; quiet?: boolean }>({ text: "" });
  const [edit, setEditState] = useState<Edit | undefined>(local.edit), [pending, setPendingState] = useState<Mutation | undefined>(local.pending);
  const [cancellation, setCancellation] = useState<{ id: string; revision: string }>();
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const beforeQueueSnapshot = useRef<((ids?: string[]) => void) | undefined>(undefined);
  const applySnapshot = (next: PromptQueueSnapshot) => { beforeQueueSnapshot.current?.(next.items.filter(item => item.state === "queued").map(item => item.message.id)); setSnapshot(next); };
  const trigger = useRef<HTMLButtonElement>(null), busyRef = useRef(false), scope = useRef(new AbortController());
  const readRequest = useRef<AbortController | undefined>(undefined), readVersion = useRef(0), readAgain = useRef(false);
  const observedCacheRevision = useRef(cacheRevision);
  const route = `/api/conversations/${encodeURIComponent(conversationId)}/queue`;
  const setEdit = (next: Edit | undefined) => { local.edit = next; setEditState(next); };
  const setPending = (next: Mutation | undefined) => { local.pending = next; setPendingState(next); };
  const load = useCallback(async (showError = false, afterCurrent = false): Promise<PromptQueueSnapshot | undefined> => {
    if (!active || !available || !online || busyRef.current || scope.current.signal.aborted) return;
    // Polling must not repeatedly abort a healthy read just because its round
    // trip is longer than the polling interval. Navigation and mutations still
    // cancel reads; an explicit refresh starts a new, fresh read. Cache changes
    // during a read request one follow-up, whereas polling never queues itself.
    if (!showError && readRequest.current && !readRequest.current.signal.aborted) {
      if (afterCurrent) readAgain.current = true;
      return;
    }
    const version = ++readVersion.current; readRequest.current?.abort();
    const controller = new AbortController(); readRequest.current = controller;
    readAgain.current = false;
    const lifetime = scope.current, request = requestSignal([controller.signal, lifetime.signal], 10000);
    if (showError) setLoading(true);
    try {
      const next = promptQueueSnapshotSchema.parse(await request.wait(connection.http(`${route}?${new URLSearchParams({ botId })}`, { signal: request.signal })));
      if (!controller.signal.aborted && !lifetime.signal.aborted && version === readVersion.current) { applySnapshot(next); if (showError && !local.pending) setError(""); return next; }
    } catch (cause) {
      if (!controller.signal.aborted && !lifetime.signal.aborted && version === readVersion.current && showError) setError(cause instanceof HubHttpError && cause.status === 404 ? t("此主机暂不支持管理待执行消息。") : t("无法读取待执行消息，请恢复连接后重试。"));
    } finally {
      request.dispose();
      if (readRequest.current === controller) readRequest.current = undefined;
      if (version === readVersion.current && !controller.signal.aborted && !lifetime.signal.aborted) {
        setLoading(false);
        if (readAgain.current) { readAgain.current = false; void load(); }
      }
    }
  }, [connection, route, botId, available, online, active, local]);
  useEffect(() => {
    scope.current = new AbortController(); busyRef.current = false; setBusy(false); setLoading(false);
    // A lost connection can abort a new save before its catch updates the copy.
    // Its retained receipt is now uncertain, not the previous operation's error.
    if (local.pending) setError("");
    if (!active) setOpen(false);
    void load();
    const timer = active && available && online ? setInterval(() => void load(), 2000) : undefined;
    return () => { scope.current.abort(); readRequest.current?.abort(); clearInterval(timer); };
  }, [load]);
  useEffect(() => {
    if (!active || !online || !available || observedCacheRevision.current === cacheRevision) return;
    const timer = setTimeout(() => { observedCacheRevision.current = cacheRevision; void load(false, true); }, 150);
    return () => clearTimeout(timer);
  }, [cacheRevision, active, online, available, load]);

  const execute = async (operation: Mutation) => {
    if (!active || !online || !available || busyRef.current || connection.state.status !== "online") return;
    const checkingReceipt = local.pending?.requestId === operation.requestId;
    // Keep a previous error's footprint until this operation has a result.
    // Removing it at pickup would resize the list underneath the held preview.
    busyRef.current = true; setBusy(true); setNotice({ text: "", quiet: operation.action.type === "move" });
    readRequest.current?.abort(); ++readVersion.current; setLoading(false);
    const lifetime = scope.current, request = requestSignal([scope.current.signal], 15000);
    // Preserve this exact ID/body until the host gives a definite outcome.
    setPending(operation);
    try {
      const next = promptQueueSnapshotSchema.parse(await request.wait(connection.http(route, { method: "POST", body: JSON.stringify(operation), signal: request.signal })));
      if (lifetime.signal.aborted) return;
      applySnapshot(next); setError(""); setPending(undefined); setCancellation(undefined);
      if (operation.action.type === "edit") { setEdit(undefined); setNotice({ text: t("待执行消息已更新") }); }
      else if (operation.action.type === "cancel") setNotice({ text: t("已取消这条待执行消息，当前任务不受影响。") });
      else if (operation.action.type === "pause") setNotice({ text: t("已暂停这条消息，后面的消息会继续执行。") });
      else if (operation.action.type === "resume") setNotice({ text: t("已恢复排队，将按顺序执行。") });
      else {
        const movedIndex = next.items.filter(item => item.state === "queued").findIndex(item => item.message.id === operation.action.messageId);
        setNotice({ text: movedIndex >= 0 ? t("消息已移到第 {0} 条", movedIndex + 1) : t("执行顺序已更新"), quiet: true });
        requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-queue-message-id="${operation.action.messageId}"] button:not(:disabled)`)?.focus({ preventScroll: true }));
      }
      return next;
    } catch (cause) {
      if (lifetime.signal.aborted) return;
      beforeQueueSnapshot.current?.();
      if (cause instanceof HubHttpError && cause.status >= 400 && cause.status < 500 && ![408, 429].includes(cause.status)
        && (!checkingReceipt || receiptCheckedErrors.has(cause.code))) {
        setPending(undefined); setCancellation(undefined);
        setError(queueMutationError(cause, operation.action.type === "edit"));
        busyRef.current = false; const refreshed = await load();
        if (!lifetime.signal.aborted && refreshed && cause.code === "queue_changed" && operation.action.type === "edit" && local.edit?.id === operation.action.messageId) {
          const editable = refreshed.items.some(item => item.message.id === operation.action.messageId && item.canEdit);
          setEdit({ ...local.edit, revision: refreshed.revision, conflict: editable });
          if (!editable) setError(t("这条消息已下发或不再可编辑。你的文字仍保留在这里，可复制后关闭。"));
        }
      } else setError(t("操作结果尚未确认。请核对结果，避免重复修改。"));
    } finally { request.dispose(); if (lifetime === scope.current) { busyRef.current = false; if (!lifetime.signal.aborted) setBusy(false); } }
  };
  const mutate = (action: PromptQueueAction, moveRevision?: string) => {
    if (!snapshot?.supported || pending || busyRef.current) return;
    // An open edit or cancellation belongs to the version the user reviewed.
    // Polling must not silently approve a destructive operation on newer work.
    const revision = action.type === "edit" && edit?.id === action.messageId ? edit.revision
      : action.type === "cancel" && cancellation?.id === action.messageId ? cancellation.revision : moveRevision ?? snapshot.revision;
    return execute({ botId, requestId: `queue_${randomNonce()}`, revision, action });
  };
  const items = snapshot?.items ?? [], waiting = items.filter(item => item.state === "queued");
  const locateSource = (messageId: string) => {
    if (list.current?.dataset.dragging === "true") return;
    // Order and preview text can change. Both entry points resolve the same
    // canonical source ID, independently of mutation/connection availability.
    const source = waiting.find(item => item.message.id === messageId && item.message.conversationId === conversationId && item.message.status !== "deleted");
    if (!source) { setError(t("原消息已删除或当前不可访问")); return; }
    setOpen(false); setCancellation(undefined);
    locate(source.message.conversationId, source.message.id);
  };
  const editableItem = items.find(item => item.message.id === edit?.id);
  const canAct = online && !busy && !pending && snapshot?.supported === true;
  const pauseState = (id: string) => {
    const item = waiting.find(item => item.message.id === id);
    return snapshot?.capabilities.pause && item && (item.canPause || item.canResume)
      ? { paused: !!item.paused, enabled: canAct } : undefined;
  };
  const togglePause = (id: string) => {
    const state = pauseState(id);
    if (state?.enabled) return mutate({ type: state.paused ? "resume" : "pause", messageId: id });
  };
  const dropPosition = (sourceId: string | undefined, targetId: string, after: boolean): { beforeId: string | null; after: boolean } | undefined => {
    if (!sourceId || !canAct || !snapshot?.capabilities.reorder) return;
    return promptQueueMove(waiting, sourceId, targetId, after);
  };
  const move = usePromptQueueDrag(list, {
    beforeSnapshot: beforeQueueSnapshot,
    open: open && active && available,
    enabled: open && active && available && canAct && snapshot?.capabilities.reorder === true,
    scope: `${connection.identity.hubPublicKey}:${conversationId}:${botId}`, revision: snapshot?.revision,
    resolve: (source, target) => dropPosition(source, target.id, target.after),
    commit: (messageId, beforeId, revision) => mutate({ type: "move", messageId, beforeId }, revision),
  });
  const nextReady = waiting.find(item => !item.paused);
  const preview = (item: typeof items[number]) => textOnly(item.message) || blocksText(item.message.blocks) || t("附件消息");
  // Unsupported/old hosts expose no dead controls. An open view may remain long
  // enough to explain a live capability change or retain the user's edit.
  if (!active || !available || !open && !edit && !pending && (!snapshot?.supported || !waiting.length)) return null;
  const refreshButton = <button type="button" className="icon-button prompt-queue-refresh" disabled={!online || busy || loading} aria-label={t("刷新待执行消息")} onClick={() => void load(true)}><RefreshCw size={16}/></button>;
  return <div className="prompt-queue" data-state={!online ? "offline" : waiting.length > 0 && !nextReady ? "paused" : undefined} ref={root}>
    <button ref={trigger} type="button" className="prompt-queue-trigger" aria-label={t("管理待执行消息，共 {0} 条", waiting.length)} aria-haspopup="dialog" onClick={() => { setOpen(true); void load(true); }}><ListOrdered size={15}/><span className="prompt-queue-total">{t("待执行 {0}", waiting.length)}</span><span className="prompt-queue-compact-total" aria-hidden="true">{t("待执行")}<b className="prompt-queue-count">{waiting.length}</b></span>{waiting[0] && <small className="prompt-queue-next"><span className="prompt-queue-preview-full">{nextReady ? t("下一条：{0}", preview(nextReady).replace(/\s+/g, " ")) : t("全部已暂停")}</span><span className="prompt-queue-preview-compact" aria-hidden="true">{nextReady ? preview(nextReady).replace(/\s+/g, " ") : t("全部已暂停")}</span></small>}{!online && <small>{t("离线")}</small>}<ChevronRight size={14}/></button>
    {open && <CreationDialog title={t("待执行消息")} closeLabel={t("关闭待执行消息")} className="prompt-queue-panel" headerActions={phone ? refreshButton : undefined} back={phone} showHost={false} returnFocus={trigger} close={() => { setOpen(false); setCancellation(undefined); }}>
      <div className="prompt-queue-intro">
        {!phone && <p className="prompt-queue-help">{t("尚未开始执行的消息，可调整执行顺序。")}</p>}
        <div className="prompt-queue-status"><span role="status" data-quiet={phone && online && !loading && notice.quiet || undefined}>{busy ? t("正在保存…") : loading ? t("正在刷新…") : !online ? t("离线时仅可查看，恢复连接后才能修改。") : notice.text}</span>{!phone && refreshButton}</div>
      </div>
      {(error || pending && !busy) && <div className="prompt-queue-alert" role="alert">{error || t("上次操作结果尚未确认，请先核对。")}{pending && !busy && <button type="button" disabled={!online} onClick={() => void execute(pending)}>{t("重试并核对结果")}</button>}</div>}
      {snapshot && !snapshot.supported && <p role="status">{t("此 Bot 当前不支持管理待执行消息。")}</p>}
      <div ref={list} className="prompt-queue-list" aria-busy={busy || loading}>
        {waiting.map(item => {
          const index = waiting.indexOf(item), previous = waiting[index - 1], next = waiting[index + 1];
          const up = previous && dropPosition(item.message.id, previous.message.id, false), down = next && dropPosition(item.message.id, next.message.id, true);
          const front = waiting[0] && dropPosition(item.message.id, waiting[0].message.id, false);
          const last = waiting.at(-1), back = last && dropPosition(item.message.id, last.message.id, true);
          const attachments = item.message.blocks.filter(block => ["file", "image", "audio"].includes(block.type)).length;
          return <article className="prompt-queue-item" key={item.message.id} data-queue-message-id={item.message.id} data-paused={item.paused || undefined} tabIndex={0} aria-label={t("第 {0} 条待执行消息", index + 1)} aria-haspopup="menu">
            <div className="prompt-queue-item-heading"><div className="prompt-queue-item-meta"><strong>{t("第 {0} 条", index + 1)}</strong><time>{new Date(item.message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>{item.canMove && snapshot?.capabilities.reorder && <button type="button" className="icon-button prompt-queue-first" title={index === 0 ? t("已在最前") : t("移到最前")} aria-label={t("将第 {0} 条消息移到最前", index + 1)} disabled={!front} onClick={() => front && move(item.message.id, front.beforeId)}><ArrowUpToLine size={16} aria-hidden="true"/></button>}{item.canMove && snapshot?.capabilities.reorder && <button type="button" className="icon-button prompt-queue-last" title={index === waiting.length - 1 ? t("已在最后") : t("移到最后")} aria-label={t("将第 {0} 条消息移到最后", index + 1)} disabled={!back} onClick={() => back && move(item.message.id, back.beforeId)}><ArrowDownToLine size={16} aria-hidden="true"/></button>}<button type="button" className="prompt-queue-source" title={t("查看原消息")} aria-label={t("查看第 {0} 条原消息", index + 1)} onClick={() => locateSource(item.message.id)}><ArrowRight size={15} strokeWidth={1.8} aria-hidden="true"/></button>{item.canMove && snapshot?.capabilities.reorder && <button type="button" className="icon-button prompt-queue-grip" data-queue-drag-handle aria-label={t("拖动调整第 {0} 条消息", index + 1)} draggable={false} disabled={!canAct}><GripVertical size={16}/></button>}</div>
            {item.paused && <span className="prompt-queue-paused"><Pause size={12} aria-hidden="true"/>{t("已暂停")}</span>}
            <QueueMessageText text={preview(item)} disabled={busy}/>
            {(attachments > 0 || item.message.replyTo) && <small className="prompt-queue-context">{attachments > 0 && t("{0} 个附件", attachments)}{attachments > 0 && item.message.replyTo && " · "}{item.message.replyTo && t("包含引用")}</small>}
            <div className="prompt-queue-actions">
              {pauseState(item.message.id) && <button type="button" className="prompt-queue-toggle" aria-label={item.paused ? t("开始第 {0} 条消息", index + 1) : t("暂停第 {0} 条消息", index + 1)} disabled={!canAct} onClick={() => void togglePause(item.message.id)}>{item.paused ? <Play size={15}/> : <Pause size={15}/>}<span>{item.paused ? t("开始") : t("暂停")}</span></button>}
              {item.canMove && snapshot?.capabilities.reorder && <><button type="button" className="prompt-queue-step" aria-label={t("上移第 {0} 条消息", index + 1)} disabled={!up} onClick={() => up && move(item.message.id, up.beforeId)}><ArrowUp size={16}/><span>{t("上移")}</span></button><button type="button" className="prompt-queue-step" aria-label={t("下移第 {0} 条消息", index + 1)} disabled={!down} onClick={() => down && move(item.message.id, down.beforeId)}><ArrowDown size={16}/><span>{t("下移")}</span></button></>}
              {item.canEdit && snapshot?.capabilities.edit && <button type="button" aria-label={t("编辑第 {0} 条消息", index + 1)} disabled={!canAct || !!edit} onClick={() => { setEdit({ id: item.message.id, text: textOnly(item.message), revision: snapshot!.revision }); setCancellation(undefined); setError(""); }}><Pencil size={15}/><span>{t("编辑")}</span></button>}
              {item.canCancel && snapshot?.capabilities.cancel && <button type="button" aria-label={t("取消第 {0} 条待执行消息", index + 1)} disabled={!canAct || !!edit} onClick={() => setCancellation({ id: item.message.id, revision: snapshot!.revision })}><Trash2 size={15}/><span>{t("取消排队")}</span></button>}
            </div>
            {cancellation?.id === item.message.id && item.canCancel && snapshot?.capabilities.cancel && <div className="prompt-queue-confirm">
              <p className="prompt-queue-confirm-title">{t("取消这条待执行消息？")}</p>
              <p className="prompt-queue-confirm-description">{t("当前任务会继续运行，聊天记录会保留。")}</p>
              <div className="prompt-queue-confirm-actions">
                <button type="button" className="prompt-queue-keep" disabled={busy} onClick={() => setCancellation(undefined)}>{t("保留")}</button>
                <button type="button" className="primary" disabled={!canAct} onClick={() => mutate({ type: "cancel", messageId: item.message.id })}>{t("确认取消排队")}</button>
              </div>
            </div>}
          </article>;
        })}
        {!waiting.length && <p className="prompt-queue-empty">{t("没有待执行的消息")}</p>}
      </div>
      <PromptQueueContextMenu phone={phone} pauseState={pauseState} togglePause={id => void togglePause(id)} root={list} conversationId={conversationId} messages={waiting.map(item => item.message)} locate={message => locateSource(message.id)} copy={async text => {
        try { await navigator.clipboard.writeText(text); setNotice({ text: t("已复制") }); }
        catch { setError(t("复制失败，请选择文字后复制。")); }
      }}/>
      {edit && <form className="prompt-queue-editor" onSubmit={event => { event.preventDefault(); try { assertMessageTextSize(edit.text); if (editableItem?.canEdit) mutate({ type: "edit", messageId: edit.id, text: edit.text }); } catch (cause) { setError(cause instanceof Error ? cause.message : t("操作失败")); } }}>
        {edit.conflict && editableItem?.canEdit && <p className="prompt-queue-edit-conflict">{t("上方是主机当前保存的内容，下方保留你的修改。请核对后再保存。")}</p>}<label>{t("编辑待执行消息")}<textarea aria-label={t("编辑待执行消息")} value={edit.text} rows={4} disabled={busy || !!pending} onChange={event => setEdit({ ...edit, text: event.target.value })} onKeyDown={event => {
          // Match the chat composer's Option/Alt+Enter newline without submitting
          // the edit form or consuming an IME confirmation key.
          if (event.key !== "Enter" || !event.altKey || event.ctrlKey || event.metaKey || event.repeat || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          event.preventDefault();
          const input = event.currentTarget;
          const text = input.value, start = input.selectionStart, end = input.selectionEnd;
          // Native insertion retains undo and uses the regular onChange path.
          if (!document.execCommand("insertLineBreak") && input.value === text) {
            input.setRangeText("\n", start, end, "end");
            setEdit({ ...edit, text: input.value });
          }
        }}/></label>
        <small>{editableItem?.canEdit ? t("仅修改文字，附件和引用保持不变。草稿会保留在本次 App 会话中。") : t("这条消息已下发或不再可编辑。你的文字仍保留在这里，可复制后关闭。")}</small>{editableItem?.canEdit && <small>{t("编辑期间队列仍会继续，保存前消息可能已下发。")}</small>}
        <div><button type="submit" className="primary" disabled={!canAct || !editableItem?.canEdit || !edit.text.trim() && !editableItem?.message.blocks.some(block => ["file", "image", "audio"].includes(block.type))}>{edit.conflict && editableItem?.canEdit ? t("核对后保存我的修改") : t("保存修改")}</button><button type="button" onClick={async () => { try { await navigator.clipboard.writeText(edit.text); setNotice({ text: t("已复制编辑内容") }); } catch { setError(t("复制失败，请选择文字后复制。")); } }}>{t("复制文字")}</button><button type="button" disabled={busy || !!pending} onClick={() => setEdit(undefined)}>{t("放弃编辑")}</button></div>
      </form>}
    </CreationDialog>}
  </div>;
}
