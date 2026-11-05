import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { CreationDialog } from "./CreationDialog.js";
import { t, useLocale } from "./i18n.js";
import type { HubConnection } from "./connection.js";
import type { Conversation } from "../../src/client-protocol/index.js";

/** A focused metadata edit. Saving never selects the chat or touches its binding. */
export function RenameConversation({ connection, conversation, close, returnFocus }: { connection: HubConnection; conversation: Conversation; close: () => void; returnFocus: RefObject<HTMLElement | null> }) {
  useLocale();
  const online = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state.status === "online");
  const [title, setTitle] = useState(conversation.title), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null), saving = useRef(false), alive = useRef(false);
  useEffect(() => { alive.current = true; input.current?.select(); return () => { alive.current = false; }; }, []);
  useEffect(() => { if (error && !busy) input.current?.focus(); }, [error, busy]);
  const save = async () => {
    const value = title.trim();
    if (saving.current || !value || !online) return;
    if (value === conversation.title) { close(); return; }
    saving.current = true; setBusy(true); setError("");
    try {
      await connection.send({ v: 1, type: "conversation.rename", conversationId: conversation.id, title: value });
      // A successful socket write is not a save receipt. Close only after the
      // Hub update has reached this host's durable cache, as in conversation management.
      const deadline = Date.now() + 20_000;
      while (alive.current) {
        const saved = (await connection.cache.conversations()).find(item => item.id === conversation.id);
        if (!alive.current) return;
        if (saved?.title === value) { close(); return; }
        if (connection.state.status !== "online") throw new Error(t("连接恢复后即可操作"));
        if (Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (alive.current) throw new Error(t("未能确认操作结果，请核对最新状态后再试。"));
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : t("重命名失败")); }
    finally { saving.current = false; if (alive.current) setBusy(false); }
  };
  return <CreationDialog title={conversation.parentId ? t("重命名话题") : t("重命名对话")} className="rename-conversation" initialFocus={input} returnFocus={returnFocus} closeLabel={t("关闭重命名")} close={close} busy={busy}>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>{conversation.parentId ? t("话题名称") : t("对话名称")}<input ref={input} value={title} required maxLength={256} disabled={busy} onChange={event => { setTitle(event.target.value); setError(""); }} onKeyDown={event => { if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault(); }}/></label>
      {!online && <p className="muted" role="status">{t("连接恢复后即可操作")}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="rename-conversation-actions"><button type="button" disabled={busy} onClick={close}>{t("取消")}</button><button className="primary" type="submit" disabled={busy || !online || !title.trim()}>{busy ? t("正在保存…") : t("保存")}</button></div>
    </form>
  </CreationDialog>;
}
