import { isUnavailableCardAction, outboxFailureBlocks } from "./outbox-failure.js";
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { Message } from "../../src/client-protocol/index.js";
import type { HubConnection, OutboxSettlement } from "./connection.js";
import type { OutboxEntry } from "./storage.js";
import { t } from "./i18n.js";

type Receipt = OutboxSettlement & { reconciling?: boolean };
type View = { connection: HubConnection; conversationId: string; entries: OutboxEntry[]; readRevision: number };
const initial = (connection: HubConnection, conversationId: string): View => ({ connection, conversationId, entries: [], readRevision: -1 });
const belongs = (entry: OutboxEntry, conversationId: string) => "conversationId" in entry.frame && entry.frame.conversationId === conversationId;
const waitingForHistory = (receipt: Receipt, historyRevision: number, messages: Message[]) => (receipt.messageAccepted || receipt.reconciling)
  && (receipt.entry.frame.type === "message.send" || receipt.entry.frame.type === "message.forward")
  && historyRevision <= receipt.revision && !messages.some(message => message.clientMsgId === receipt.entry.id);

/** Fast pending feedback, with committed ACK receipts bridging slow history reads. */
export function useConversationOutbox(connection: HubConnection, conversationId: string, visible: boolean, historyRevision: number, messages: Message[], scoped = false) {
  const [view, setView] = useState<View>();
  const observations = useRef(new WeakMap<HubConnection, Map<string, View>>());
  const registry = useRef(new WeakMap<HubConnection, Map<string, Map<string, Receipt>>>());
  const localSends = useRef(new WeakMap<HubConnection, Map<string, Map<string, { missingRevision?: number }>>>());
  const active = useRef<{ connection: HubConnection; conversationId: string; visible: boolean } | undefined>(undefined);
  useLayoutEffect(() => {
    active.current = { connection, conversationId, visible };
    return () => { active.current = undefined; };
  }, [connection, conversationId, visible, scoped]);
  const [receiptVersion, receiptChanged] = useReducer(value => value + 1, 0);
  let views = observations.current.get(connection);
  if (!views) { views = new Map(); observations.current.set(connection, views); }
  let scopes = registry.current.get(connection);
  if (!scopes) { scopes = new Map(); registry.current.set(connection, scopes); }
  let tracked = localSends.current.get(connection);
  if (!tracked) { tracked = new Map(); localSends.current.set(connection, tracked); }
  let settled = scopes.get(conversationId);
  if (!settled) { settled = new Map(); scopes.set(conversationId, settled); }
  useEffect(() => {
    const showing = (id: string) => active.current?.connection === connection && active.current.visible && active.current.conversationId === id;
    const unqueue = connection.subscribeOutboxQueued(frame => {
      if (!("conversationId" in frame) || !showing(frame.conversationId)) return;
      const id = "clientMsgId" in frame ? frame.clientMsgId : "clientActionId" in frame ? frame.clientActionId : undefined;
      if (!id) return;
      let ids = tracked.get(frame.conversationId);
      if (!ids) { ids = new Map(); tracked.set(frame.conversationId, ids); }
      ids.set(id, {});
    });
    const unsettle = connection.subscribeOutboxSettlement(receipt => {
      if (!("conversationId" in receipt.entry.frame)) return;
      const cid = receipt.entry.frame.conversationId, id = receipt.entry.id, target = scopes.get(cid);
      const locallyQueued = tracked.get(cid)?.delete(id);
      // Preserve feedback actually observed or queued while this view was open,
      // including an ACK that beats its first IDB read. Background share sends
      // never seen here belong to the next history read, not a pile of receipts.
      if (target && (showing(cid) || locallyQueued || target.has(id) || views.get(cid)?.entries.some(entry => entry.id === id))) {
        target.set(id, receipt); receiptChanged();
      }
    });
    return () => { unqueue(); unsettle(); };
  }, [connection, scopes, tracked, views]);

  useEffect(() => {
    if (!visible || !conversationId) return;
    let disposed = false, reading = false, dirty = false, token = 0;
    let revision = scoped ? connection.conversationRevision(conversationId) : connection.state.cacheRevision, queueRevision = connection.outboxRevision;
    const refresh = (replace = false) => {
      dirty = true;
      if (reading && !replace) return;
      reading = true; dirty = false;
      const request = ++token, readRevision = connection.state.cacheRevision, readQueueRevision = connection.outboxRevision;
      void connection.cache.outbox().then(entries => {
        if (disposed || request !== token || readQueueRevision !== connection.outboxRevision) return;
        const previous = views.get(conversationId);
        const current = previous?.connection === connection && previous.conversationId === conversationId ? previous : initial(connection, conversationId);
        const next = entries.filter(entry => belongs(entry, conversationId));
        let reconcile = false;
        const local = tracked.get(conversationId);
        if (local) for (const [id, intent] of local) {
          if (next.some(entry => entry.id === id)) delete intent.missingRevision;
          else if (intent.missingRevision === undefined) {
            // A different window can remove an entry before our first queue
            // read or ACK. Keep the local intent until fresh history confirms
            // its removal; a late hidden ACK still needs this identity.
            intent.missingRevision = connection.state.cacheRevision; reconcile = true;
          }
        }
        for (const entry of current.entries) {
          if (next.some(item => item.id === entry.id) || settled.has(entry.id)
            || !["message.send", "message.forward"].includes(entry.frame.type)) continue;
          // Another window can commit an ACK or discard without a local receipt.
          // Keep a non-retryable placeholder until a history read STARTED after
          // this observation succeeds. Disappearance alone never means "sent".
          settled.set(entry.id, { entry, revision: connection.state.cacheRevision, messageAccepted: false, reconciling: true });
          reconcile = true;
        }
        const updated = { ...current, entries: next, readRevision };
        views.set(conversationId, updated); setView(updated);
        // Confirmation needs a fresh read of this conversation only.
        if (reconcile) { receiptChanged(); connection.refreshConversation(conversationId); }
      }).catch(() => { /* Keep feedback; a later revision retries the read. */ }).finally(() => {
        if (disposed || request !== token) return;
        reading = false;
        if (dirty || readQueueRevision !== connection.outboxRevision) refresh();
      });
    };
    const unsubscribe = connection.subscribe(() => {
      const next = scoped ? connection.conversationRevision(conversationId) : connection.state.cacheRevision, nextQueue = connection.outboxRevision;
      if (revision === next && queueRevision === nextQueue) return;
      const replace = nextQueue !== queueRevision;
      revision = next; queueRevision = nextQueue;
      // Streaming coalesces behind one read and never invalidates its result.
      // A committed local queue mutation can replace that read immediately;
      // its token fences late failures/snapshots from retry, discard or ACK.
      refresh(replace);
    });
    refresh();
    return () => { disposed = true; unsubscribe(); };
  }, [connection, conversationId, visible, scoped, settled, views, tracked]);

  useEffect(() => {
    if (!visible || view?.connection !== connection || view.conversationId !== conversationId) return;
    const local = tracked.get(conversationId);
    if (local) for (const [id, intent] of local) {
      if (intent.missingRevision !== undefined && historyRevision > intent.missingRevision) local.delete(id);
    }
    let removed = false;
    for (const [id, receipt] of settled) {
      const queued = view.entries.find(entry => entry.id === id);
      // Re-enqueuing an acknowledged ID creates a new outbox order. It is a
      // new send attempt, even when the Hub will deduplicate its message.
      if (queued && queued.order > receipt.entry.order || !queued && view.readRevision > receipt.revision && !waitingForHistory(receipt, historyRevision, messages)) {
        settled.delete(id); removed = true;
      }
    }
    if (removed) receiptChanged();
  }, [connection, conversationId, visible, historyRevision, messages, view, settled, receiptVersion, tracked]);

  if (!visible) return [];
  const current = view?.connection === connection && view.conversationId === conversationId ? view : views.get(conversationId) ?? initial(connection, conversationId);
  const entries = new Map(current.entries.map(entry => [entry.id, { entry, sent: false, syncing: false }]));
  for (const [id, receipt] of settled) {
    if ((entries.get(id)?.entry.order ?? -1) > receipt.entry.order) continue;
    // Discard/card receipts mask older outbox snapshots immediately. A message
    // ACK additionally supplies its content even if the fast read never saw it.
    if (waitingForHistory(receipt, historyRevision, messages)) entries.set(id, { entry: receipt.entry, sent: receipt.messageAccepted, syncing: !!receipt.reconciling });
    else entries.delete(id);
  }
  const ordered = [...entries.values()].sort((a, b) => a.entry.order - b.entry.order);
  return ordered.map(({ entry, sent, syncing }, index) => ({
    id: entry.id,
    copyable: entry.frame.type === "message.send" && !!entry.frame.text,
    text: entry.frame.type === "message.send" ? entry.frame.text : entry.frame.type === "message.forward" ? t("转发消息") : t("卡片操作"),
    expired: !sent && !syncing && isUnavailableCardAction(entry),
    error: sent || syncing ? undefined : isUnavailableCardAction(entry) ? t("此卡片操作已失效，请查看最新卡片。") : entry.error === "conversation_archived" ? t("对话已归档，恢复后可重新发送。") : entry.error,
    blocked: !sent && !syncing && !entry.error && ordered.slice(0, index).some(prior => !prior.sent && !prior.syncing && outboxFailureBlocks(prior.entry)),
    sent, syncing,
  }));
}
