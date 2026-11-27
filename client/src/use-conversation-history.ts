import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Conversation, Message } from "../../src/client-protocol/index.js";
import { numberedForkTitle, type HistoryAction, type HistoryAnchor, type HistoryBoundary, type HistoryClientOperation, type HistoryClientSnapshot } from "../../src/client-protocol/conversation-history.js";
import { historyPendingSchema, historyReason, historyRecordKey, type HistoryMessageActions, type HistoryPending } from "./conversation-history-state.js";
import type { HubConnection } from "./connection.js";
import { useConnectionSelection } from "./connection-selection.js";
import { messageExcerpt } from "./MessageReference.js";
import { randomNonce } from "./identity.js";
import { t } from "./i18n.js";

export type HistoryIntent = { action: HistoryAction; revision: string; excerpt?: string; boundary?: HistoryBoundary };
type View = { key: string; snapshot?: HistoryClientSnapshot; anchors: Record<string, HistoryAnchor | undefined>; ready: boolean; stale: boolean; raw: string; pending?: HistoryPending; broken: boolean; error: string; notice: string; result?: HistoryClientOperation; destination?: Conversation; intent?: HistoryIntent; open: boolean; busy: boolean };
const initial = (key: string): View => ({ key, anchors: {}, ready: false, stale: false, raw: "", broken: false, error: "", notice: "", open: false, busy: false });

/** One durable operation per Host/user/conversation. Only submit() applies a
 * native action. Explicit recovery reconciles this receipt without replay. */
export function useConversationHistory({ connection, conversation, enabled, activity, backgroundBusy = false, sideState = "", pendingMessages, localBusy, fallback, opened, forkTitles = [] }: {
  connection: HubConnection; conversation?: Conversation; enabled: boolean; activity: string;
  /** True while background tasks are active in this chat; sideState changes when a side panel opens, changes phase, or finishes disposing. */
  backgroundBusy?: boolean; sideState?: string;
  /** Titles of conversations already forked from this one; a default title is numbered past them. */
  forkTitles?: string[];
  pendingMessages: boolean; localBusy: boolean; fallback: RefObject<HTMLElement | null>; opened: (conversation: Conversation) => void;
}) {
  const id = conversation?.id ?? "", botId = conversation?.botIds[0] ?? "";
  const state = useConnectionSelection(connection, value => ({ status: value.state.status, user: value.state.user, historyAvailable: value.state.historyAvailable, readOnly: value.isReadOnly, cacheRevision: value.conversationRevision(id) }));
  const key = historyRecordKey(connection, id);
  const eligible = !!id && conversation?.type === "direct" && conversation.botIds.length === 1 && !conversation.hidden && !conversation.parentId;
  const available = eligible && !!state.historyAvailable && state.user?.role === "owner";
  const [stored, setView] = useState<View>(() => initial(key)), [settled, setSettled] = useState(0);
  const view = stored.key === key ? stored : initial(key);
  const latest = useRef({ key, enabled, available, conversation, opened, pendingMessages, localBusy, state });
  latest.current = { key, enabled, available, conversation, opened, pendingMessages, localBusy, state };
  const stateRef = useRef(view); stateRef.current = view;
  const flight = useRef(false), readSerial = useRef(0), alive = useRef(true), trigger = useRef<HTMLElement | null>(null);
  const matches = (scope: string) => alive.current && latest.current.key === scope;
  const patch = (scope: string, update: Partial<View>) => { if (matches(scope)) setView(old => ({ ...(old.key === scope ? old : initial(scope)), ...update })); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; readSerial.current++; }; }, []);
  const returnFocus = useMemo(() => ({ get current() { return trigger.current?.isConnected && trigger.current.getClientRects().length ? trigger.current : fallback.current; } }), [fallback]);

  async function refresh(messageId?: string) {
    const scope = key, serial = ++readSerial.current;
    if (!available || !enabled || state.status !== "online") return;
    try {
      const snapshot = await connection.historySnapshot(id, botId);
      let anchor: HistoryAnchor | undefined;
      if (historyRecordKey(connection, id) !== scope) return;
      if (messageId && snapshot.supported && (snapshot.capabilities?.rewind || snapshot.capabilities?.anchoredFork)) {
        const page = await connection.historyAnchors(id, botId, messageId);
        anchor = page.anchors.find(value => value.messageId === messageId);
      }
      if (matches(scope) && serial === readSerial.current && latest.current.enabled) setView(old => {
        const current = old.key === scope ? old : initial(scope);
        const anchors = current.snapshot?.revision === snapshot.revision ? current.anchors : {};
        // Older Hosts answer a running conversation without capabilities. Keep
        // what it could do when last read, so the entry stays visible and disabled.
        const known = snapshot.supported && snapshot.blocked && !snapshot.capabilities && current.snapshot?.supported ? current.snapshot.capabilities : undefined;
        return { ...current, snapshot: known ? { ...snapshot, capabilities: known } : snapshot, stale: false, anchors: messageId ? { ...anchors, [messageId]: anchor } : anchors };
      });
    } catch { if (serial === readSerial.current) patch(scope, { stale: true }); }
  }
  useEffect(() => { if (!flight.current && view.ready) void refresh(); }, [key, enabled, available, state.status, activity, backgroundBusy, sideState, conversation?.bindingId, view.ready, settled]);
  useEffect(() => {
    if (!eligible || !state.user?.id || flight.current) return;
    let cancelled = false;
    void connection.cache.operationRecord(key).then(raw => {
      if (cancelled || !matches(key) || flight.current) return;
      let pending: HistoryPending | undefined, broken = false;
      if (raw) { try { pending = historyPendingSchema.parse(JSON.parse(raw)); } catch { broken = true; } }
      patch(key, { raw, pending, broken, ready: true, ...(pending?.result ? { result: pending.result } : {}) });
    }, () => { if (!cancelled) patch(key, { broken: true, ready: true }); });
    return () => { cancelled = true; };
  }, [key, eligible, state.user?.id, state.cacheRevision, settled]);
  useEffect(() => { if (!enabled) patch(key, { open: false, intent: undefined }); }, [key, enabled]);

  const unresolved = !!view.raw || !!view.snapshot?.pendingOperation || view.broken;
  const reason = !view.ready ? t("正在检查会话状态…")
    : view.broken ? t("操作记录无法读取，请先核对会话状态。")
    : unresolved ? t("操作结果尚未确认，请先核对。")
    : state.status !== "online" || connection.isReadOnly ? t("连接恢复后可操作。")
    : conversation?.archived ? t("对话已归档，恢复后可操作。")
    : localBusy || activity ? historyReason("busy")
    : pendingMessages ? historyReason("queued")
    : view.stale ? t("请刷新会话状态后重试。")
    : view.snapshot?.blocked ? historyReason(view.snapshot.blocked)
    : !view.snapshot?.revision ? t("正在检查会话状态…") : undefined;

  function ask(action: HistoryAction, origin: HTMLElement | null, message?: Message, boundary?: HistoryBoundary) {
    if (reason || !view.snapshot?.revision || !enabled) return;
    trigger.current = origin;
    patch(key, { open: true, intent: { action, revision: view.snapshot.revision, excerpt: message ? messageExcerpt(message).slice(0, 500) : undefined, boundary }, error: "", notice: "", result: undefined, destination: undefined });
  }
  const title = numberedForkTitle(t("{0} · 分叉", (conversation?.title ?? "").slice(0, 240)), forkTitles);
  const fork = available && view.snapshot?.supported && view.snapshot.capabilities?.fork ? {
    reason, run: (origin: HTMLElement | null) => ask({ kind: "fork", scope: "whole", title }, origin),
  } : undefined;
  function messageActions(message: Message): HistoryMessageActions | undefined {
    if (!available || !view.snapshot?.supported || message.status === "deleted" || message.historyContext || message.conversationId !== id) return;
    const anchor = view.anchors[message.id]; if (!anchor) return;
    const actions: HistoryMessageActions = {};
    if (view.snapshot.capabilities?.anchoredFork && anchor.fork && anchor.forkBoundary) actions.fork = { reason, run: origin => ask({ kind: "fork", scope: "anchor", anchorId: anchor.id, title }, origin, message, anchor.forkBoundary) };
    if (view.snapshot.capabilities?.rewind && anchor.rewind && message.authorType === "user") actions.rewind = { reason, run: origin => ask({ kind: "rewind", anchorId: anchor.id }, origin, message) };
    return actions;
  }

  async function settle(scope: string, raw: string, record: HistoryPending | undefined, result: HistoryClientOperation, navigate: boolean) {
    if (record && (record.change.requestId !== result.requestId || record.change.expectedRevision !== result.sourceRevision)) throw new Error("history_receipt_mismatch");
    let nextRaw = raw;
    if (record) {
      nextRaw = JSON.stringify({ ...record, result });
      if (!await connection.cache.updateOperationIfMatches(scope, raw, nextRaw)) throw new Error("history_record_changed");
    }
    patch(scope, { result, pending: record ? { ...record, result } : undefined, raw: nextRaw, error: "" });
    if (result.state === "pending" || result.state === "unknown") {
      patch(scope, { error: t("操作结果尚未确认，请先核对。") });
      return;
    }
    // A result can finish after a chat switch, but must never hydrate another
    // authenticated owner or Host. Keep its scoped receipt for later recovery.
    if (historyRecordKey(connection, id) !== scope) return;
    let destination: Conversation | undefined;
    if (result.state === "applied") destination = await connection.acceptHistoryOperation(id, result);
    if (nextRaw) await connection.cache.clearOperationIfMatches(scope, nextRaw);
    const notice = result.state === "rejected" ? "" : destination ? t("分叉对话已创建。") : t("上下文已回退，文件未改动。");
    patch(scope, { raw: "", pending: undefined, destination, result, notice, error: result.state === "rejected" ? historyReason(result.reason) : "", snapshot: undefined, anchors: {}, intent: undefined });
    connection.refreshConversation(id);
    if (matches(scope) && latest.current.enabled) {
      void refresh();
      if (destination && navigate) { patch(scope, { open: false }); latest.current.opened(destination); }
    }
  }

  function finish(scope: string) {
    flight.current = false;
    if (alive.current) {
      // Completion can belong to the previously visible conversation. Clear
      // that retained view and wake the new scope without global cache churn.
      setView(old => old.key === scope ? { ...old, busy: false } : old);
      setSettled(value => value + 1);
    }
    connection.refreshConversation(id);
  }

  async function submit() {
    const intent = stateRef.current.intent, scope = key;
    if (flight.current || !intent || reason || !latest.current.enabled) return;
    flight.current = true; patch(scope, { busy: true, error: "" });
    let raw = "", record: HistoryPending | undefined, stage: "snapshot" | "storage" | "request" = "snapshot";
    try {
      // The preview is not admission. Re-read current native state and refuse
      // a changed boundary instead of silently forking a newer conversation.
      const snapshot = await connection.historySnapshot(id, botId);
      if (!matches(scope) || !latest.current.enabled || !latest.current.available || connection.isReadOnly) return;
      if (!snapshot.supported || snapshot.blocked || snapshot.pendingOperation || snapshot.revision !== intent.revision) {
        patch(scope, { snapshot, error: historyReason(snapshot.blocked ?? (snapshot.pendingOperation ? "outcome_unknown" : "source_changed")), intent: undefined }); return;
      }
      if (latest.current.pendingMessages || latest.current.localBusy || latest.current.state.status !== "online") {
        patch(scope, { error: historyReason(latest.current.pendingMessages ? "queued" : "busy") }); return;
      }
      stage = "storage";
      record = { change: { botId, requestId: randomNonce(), expectedRevision: intent.revision, action: intent.action } };
      raw = JSON.stringify(record);
      if (!await connection.cache.updateOperationIfMatches(scope, "", raw)) {
        const saved = await connection.cache.operationRecord(scope);
        patch(scope, { raw: saved, pending: historyPendingSchema.parse(JSON.parse(saved)), error: t("操作结果尚未确认，请先核对。") }); return;
      }
      stage = "request";
      if (!matches(scope) || !latest.current.enabled || historyRecordKey(connection, id) !== scope) {
        await connection.cache.clearOperationIfMatches(scope, raw); return;
      }
      patch(scope, { raw, pending: record }); connection.refreshConversation(id);
      // Persisting first means even a reload during the POST only reconciles
      // this request. A locally persisted but unadmitted request is tombstoned.
      const result = await connection.changeHistory(id, record.change);
      await settle(scope, raw, record, result, true);
    } catch {
      patch(scope, { ...(stage === "snapshot" ? { stale: true } : {}), error: stage === "snapshot" ? t("请刷新会话状态后重试。") : stage === "storage" ? t("无法保存操作记录，请检查本机存储后重试。") : t("操作结果尚未确认，请先核对。") });
    } finally { finish(scope); }
  }
  async function check() {
    if (flight.current || !available || state.status !== "online" || view.broken) return;
    const scope = key;
    flight.current = true; patch(scope, { busy: true, error: "" });
    try {
      const raw = await connection.cache.operationRecord(scope);
      const record = raw ? historyPendingSchema.parse(JSON.parse(raw)) : undefined;
      if (historyRecordKey(connection, id) !== scope) return;
      const requestId = record?.change.requestId ?? stateRef.current.snapshot?.pendingOperation;
      if (!requestId) { await refresh(); return; }
      const result = record ? await connection.reconcileHistory(id, record.change) : await connection.historyOperation(id, botId, requestId);
      await settle(scope, raw, record, result, true);
    } catch { patch(scope, { error: t("操作结果尚未确认，请先核对。") }); }
    finally { finish(scope); }
  }
  const showRecovery = unresolved || view.result?.state === "pending" || view.result?.state === "unknown";
  return {
    fork, messageActions, inspect: (message: Message) => { void refresh(message.id); }, refresh: () => { void refresh(); },
    view, returnFocus, reason, recovery: showRecovery, sendBlocked: eligible && (showRecovery || available && (!view.ready || view.busy)),
    assertCanSend: () => {
      const current = stateRef.current;
      if (eligible && (flight.current || current.raw || current.broken || current.snapshot?.pendingOperation || available && !current.ready)) throw new Error(t("操作结果尚未确认，请先核对。"));
    },
    canCheck: available && !connection.isReadOnly && state.status === "online" && !view.broken && !view.busy,
    submit: () => { void submit(); }, check: () => { void check(); },
    close: () => { if (!flight.current) patch(key, { open: false, intent: undefined }); },
    recover: (origin: HTMLElement | null) => { trigger.current = origin; patch(key, { open: true, intent: undefined }); },
    openDestination: () => { if (view.destination) { patch(key, { open: false }); opened(view.destination); } },
  };
}

export type ConversationHistory = ReturnType<typeof useConversationHistory>;
