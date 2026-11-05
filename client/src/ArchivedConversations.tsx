import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArchiveRestore, History } from "lucide-react";
import type { Conversation } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";
import { useBotLabels } from "./BotReferences.js";
import { CreationDialog } from "./CreationDialog.js";
import { t, useLocale } from "./i18n.js";
import "./archived-conversations.css";

/** Shared by phone, desktop and the ADHD host tools. Restore uses the same
 * host-owned archive operation as conversation settings and awaits its receipt. */
export function ArchivedConversations({ connection, conversations, close, open }: {
  connection: HubConnection; conversations: Conversation[]; close: () => void; open: (id: string) => void;
}) {
  useLocale();
  const labels = useBotLabels();
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const [pending, setPending] = useState<string>(), [error, setError] = useState("");
  const alive = useRef(false), saving = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const archived = conversations.filter(c => c.archived && !c.parentId);
  const blocked = (conversation: Conversation) => {
    if (state.status !== "online") return t("连接恢复后即可操作");
    if (connection.isReadOnly || state.user?.id !== conversation.ownerId) return t("仅对话创建者可恢复此对话。");
    if (!conversation.botIds.length || conversation.botIds.some(id => state.deletedBots?.some(bot => bot.id === id))) return t("Bot 已删除，此对话仅保留历史记录。");
    return "";
  };
  const restore = async (conversation: Conversation) => {
    if (saving.current || blocked(conversation)) return;
    saving.current = true; setPending(conversation.id); setError("");
    try {
      await connection.send({ v: 1, type: "conversation.archive", conversationId: conversation.id, archived: false });
      const deadline = Date.now() + 20_000;
      while (alive.current) {
        const saved = (await connection.cache.conversations()).find(c => c.id === conversation.id);
        if (!alive.current) return;
        if (saved && !saved.archived) { open(conversation.id); return; }
        if (connection.state.status !== "online") throw new Error(t("连接恢复后即可操作"));
        if (Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (alive.current) throw new Error(t("未能确认操作结果，请核对最新状态后再试。"));
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : t("操作失败")); }
    finally { saving.current = false; if (alive.current) setPending(undefined); }
  };
  return <CreationDialog title={t("已归档对话")} closeLabel={t("关闭已归档对话")} className="archived-conversations" close={close} busy={!!pending}>
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="archive-list">{archived.map(conversation => {
      const reason = blocked(conversation);
      return <article className="archive-row" key={conversation.id} aria-label={conversation.title}>
        <div className="archive-title"><strong>{conversation.title}</strong><small>{conversation.botIds.map(id => labels.get(id) ?? state.bots.find(bot => bot.id === id)?.name ?? id).join(" · ")}</small></div>
        <div className="archive-actions">
          <button disabled={!!pending} onClick={() => open(conversation.id)}><History size={15} aria-hidden="true"/>{t("查看记录")}</button>
          <button className="archive-restore" disabled={!!pending || !!reason} onClick={() => { void restore(conversation); }}><ArchiveRestore size={15} aria-hidden="true"/>{pending === conversation.id ? t("正在恢复…") : t("恢复")}</button>
        </div>
        {reason && <p className="archive-reason">{reason}</p>}
      </article>;
    })}</div>
    {!archived.length && <p className="muted">{t("暂无已归档对话")}</p>}
  </CreationDialog>;
}
