import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Check, ListChecks, Trash2 } from "lucide-react";
import { MAX_DELETE_MESSAGES } from "../../src/client-protocol/message-deletion.js";
import type { Message } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";
import { useBackAction } from "./back-navigation.js";
import { CreationDialog } from "./CreationDialog.js";
import { t } from "./i18n.js";
import "./message-deletion.css";

type Target = { connection: HubConnection; conversationId: string; ids: string[] };
export function useMessageDeletion(connection: HubConnection, conversationId: string, enabled: boolean, messages: Message[], fallback: RefObject<HTMLElement | null>, deleted: (ids: string[]) => void) {
  const [selection, setSelection] = useState<Target>();
  const [confirmation, setConfirmation] = useState<Target>();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const bar = useRef<HTMLDivElement | null>(null);
  const origin = useRef<HTMLElement | null>(null), cancel = useRef<HTMLButtonElement | null>(null);
  const returnFocus = useMemo(() => ({ get current() {
    const node = origin.current;
    return node?.isConnected && node.getClientRects().length ? node : fallback.current;
  } }), [fallback]);
  const latest = useRef({ connection, conversationId, enabled, deleted, confirmation }); latest.current = { connection, conversationId, enabled, deleted, confirmation };
  const matches = (target: Target | undefined) => !!target && enabled && target.connection === connection && target.conversationId === conversationId;
  const active = matches(selection), confirm = matches(confirmation) ? confirmation : undefined;
  const liveIds = new Set(messages.map(message => message.id));
  const selected = new Set(active ? selection!.ids.filter(id => liveIds.has(id)) : []);
  useEffect(() => { if (selection && !matches(selection)) setSelection(undefined); if (confirmation && !matches(confirmation)) { setConfirmation(undefined); setBusy(false); setError(""); } }, [connection, conversationId, enabled]);
  const focus = () => requestAnimationFrame(() => { const node = returnFocus.current; if (node?.isConnected && node.getClientRects().length) node.focus({ preventScroll: true }); });
  const close = () => { setSelection(undefined); focus(); };
  useBackAction(bar, close);
  const start = (message: Message, trigger: HTMLElement | null) => {
    origin.current = trigger; setSelection({ connection, conversationId, ids: [message.id] }); setError(""); focus();
  };
  const ask = (ids: string[], trigger?: HTMLElement | null) => {
    if (!ids.length) return;
    if (trigger) origin.current = trigger;
    setError(""); setBusy(false); setConfirmation({ connection, conversationId, ids });
  };
  const toggle = (id: string) => {
    if (!active) return;
    if (!selected.has(id) && selected.size >= MAX_DELETE_MESSAGES) { setError(t("一次最多选择 {0} 条消息", MAX_DELETE_MESSAGES)); return; }
    setError(""); setSelection({ connection, conversationId, ids: selected.has(id) ? [...selected].filter(item => item !== id) : [...selected, id] });
  };
  const submit = async () => {
    if (!confirm || busy) return;
    const target = confirm; setBusy(true); setError("");
    const current = () => latest.current.confirmation === target && latest.current.enabled && latest.current.connection === target.connection && latest.current.conversationId === target.conversationId;
    try {
      const result = await target.connection.deleteMessages(target.conversationId, target.ids);
      if (!current()) return;
      latest.current.deleted(result.deletedIds); origin.current = null; setConfirmation(undefined); setSelection(undefined); focus();
    } catch { if (current()) setError(t("删除未确认，请检查连接后重试。已选择的消息会保留。")); }
    finally { if (current()) setBusy(false); }
  };
  return {
    active, selected, start, ask, toggle, close,
    check: (id: string) => <span className="message-selection-check" aria-hidden="true">{selected.has(id) && <Check size={15}/>}</span>,
    toolbar: active && <div ref={bar} className="message-selection-bar" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }} role="region" aria-label={t("多选消息")}>
      <ListChecks size={19}/><span role="status">{t("已选择 {0} 条", selected.size)}</span>
      <button type="button" onClick={close}>{t("取消")}</button>
      <button type="button" className="message-delete-action" disabled={!selected.size || busy} onClick={() => ask([...selected])}><Trash2 size={16}/>{t("删除（{0}）", selected.size)}</button>
      {error && !confirm && <small role="alert">{error}</small>}
    </div>,
    dialog: confirm && <CreationDialog title={t("删除 {0} 条消息？", confirm.ids.length)} closeLabel={t("取消删除")} close={() => setConfirmation(undefined)} busy={busy} returnFocus={returnFocus} initialFocus={cancel} showHost={false} className="message-delete-dialog">
      <p>{t("只从你的聊天记录中删除，并同步到你的其他设备。其他成员的记录不受影响。")}</p>
      <p className="muted">{t("删除记录不会取消排队任务，也不会停止正在进行的任务。如需取消，请先在待执行消息中选择“取消排队”。")}</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="message-delete-buttons"><button type="button" ref={cancel} disabled={busy} onClick={() => setConfirmation(undefined)}>{t("取消")}</button><button type="button" className="message-delete-action" disabled={busy} onClick={() => void submit()}>{busy ? t("正在删除…") : t("删除")}</button></div>
    </CreationDialog>,
  };
}
