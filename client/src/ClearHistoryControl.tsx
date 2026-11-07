import { useEffect, useLayoutEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import { clearMessageHistory, type ClearMessagesPlan } from "../../src/client-protocol/clear-messages-operation.js";
import type { HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import { t } from "./i18n.js";
import { HubHttpError } from "./http-error.js";
import "./message-deletion.css";

export function ClearHistoryControl({ connection, conversationId, disabled = false, variant = "settings" }: { connection: HubConnection; conversationId: string; disabled?: boolean; variant?: "settings" | "details" }) {
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const [plan, setPlan] = useState<ClearMessagesPlan>(), [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const trigger = useRef<HTMLButtonElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false), pending = useRef(false), generation = useRef(0), description = useId();
  useEffect(() => {
    generation.current++; setPlan(undefined); setBusy(false); pending.current = false; setError(""); setNotice("");
    return () => { generation.current++; };
  }, [connection, conversationId]);
  useLayoutEffect(() => {
    // Dialog cleanup runs before the trigger has been re-enabled by this
    // commit. Restore keyboard focus after the busy flag reaches the DOM.
    if (restoreFocus.current && !busy && !plan) { restoreFocus.current = false; trigger.current?.focus({ preventScroll: true }); }
  }, [busy, plan]);
  const available = state.status === "online" && !state.syncProgress && state.messageClearAvailable && !connection.isReadOnly;
  const hint = state.status !== "online" ? t("连接主机后可清理记录") : !state.messageClearAvailable ? t("更新运行 Bot 的主机后可清理记录")
    : state.syncProgress ? t("历史同步完成后可清理记录") : t("仅清理 App 记录，保留 Bot 当前上下文");
  const prepare = async () => {
    if (pending.current || !available) return;
    const current = generation.current; pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const value = await connection.planClearMessages(conversationId);
      if (current !== generation.current) return;
      if (!value.count) setNotice(t("此对话没有可清理的记录"));
      else { setPlan(value); setRemaining(value.count); }
    } catch { if (current === generation.current) setError(t("无法统计聊天记录，请检查连接后重试。")); }
    finally { if (current === generation.current) { pending.current = false; setBusy(false); } }
  };
  const submit = async () => {
    if (!plan || pending.current || !available) return;
    const target = plan, current = generation.current; pending.current = true; setBusy(true); setError("");
    const valid = () => current === generation.current;
    try {
      await clearMessageHistory({ ...target, count: remaining }, async throughId => {
        if (!valid()) throw new Error("message_clear_closed");
        return connection.clearMessagesBatch(conversationId, throughId);
      }, async result => {
        // Do not show completion while this device still displays deleted text.
        await connection.confirmHistoryClear(conversationId, result.seq);
        if (!valid()) throw new Error("message_clear_closed");
        setRemaining(result.remaining);
      });
      if (valid()) { restoreFocus.current = true; setPlan(undefined); setNotice(t("聊天记录已清理，Bot 上下文保持不变。")); }
    } catch (cause) { if (valid()) setError(cause instanceof HubHttpError && cause.code === "message_clear_active"
      ? t("清理已暂停：还有运行中的任务、待回答的问题或待处理的审批。请先处理后再继续；已清理的部分不会恢复。")
      : t("清理未完成。已清理的记录不会恢复；重试只继续清理原先确认的范围。")); }
    finally { if (valid()) { pending.current = false; setBusy(false); } }
  };
  return <>
    <button ref={trigger} type="button" className={variant === "details" ? "details-link details-link-danger" : "session-action session-action-danger"} aria-label={t("清理聊天记录")} aria-describedby={description} disabled={disabled || busy || !available} onClick={() => void prepare()}>
      <Trash2 className="session-action-icon" size={20} aria-hidden="true"/><span><strong>{t("清理聊天记录")}</strong><small id={description}>{hint}</small></span><ChevronRight size={16} aria-hidden="true"/>
    </button>
    {busy && !plan && <p role="status">{t("正在统计记录…")}</p>}
    {notice && <p role="status">{notice}</p>}{error && !plan && <p className="error-text" role="alert">{error}</p>}
    {plan && <CreationDialog title={t("清理 {0} 条聊天记录？", plan.count)} closeLabel={t("关闭清理记录确认")} close={() => { setPlan(undefined); setError(""); }} busy={busy} returnFocus={trigger} initialFocus={cancel} showHost={false} className="message-delete-dialog">
      <p>{t("只清理此对话在你所有设备上的 App 记录，其他成员不受影响。清理后无法在 App 中撤销。")}</p>
      <p>{t("Bot 的会话和上下文保持不变。遇到运行中的任务、待回答的问题或审批时，清理会暂停。")}</p>
      <p className="muted">{t("本次统计之后的新消息、输入草稿和已保存的文件会保留。此操作不释放主机空间，附件也不会删除；需要释放空间请到「文件中心 › 附件管理」。")}</p>
      {(busy || remaining !== plan.count) && <p role="status">{t("已清理 {0} / {1} 条", plan.count - remaining, plan.count)}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="message-delete-buttons"><button ref={cancel} disabled={busy} onClick={() => { setPlan(undefined); setError(""); }}>{t("关闭")}</button><button className="message-delete-action" disabled={busy || !available} onClick={() => void submit()}>{busy ? t("正在清理…") : error ? t("继续清理") : t("清理记录")}</button></div>
    </CreationDialog>}
  </>;
}
