import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { CreationDialog } from "./CreationDialog.js";
import { ExplanationList } from "./ExplanationList.js";
import { t, useLocale } from "./i18n.js";
import type { HubConnection } from "./connection.js";
import type { Conversation } from "../../src/client-protocol/index.js";

/** Removal uses the existing recoverable archive, never a session/workspace deletion. */
export function RemoveConversation({ connection, conversation, close, removed, returnFocus, dissolve = false }: {
  connection: HubConnection; conversation: Conversation; dissolve?: boolean; close: () => void;
  removed: () => void; returnFocus: RefObject<HTMLElement | null>;
}) {
  useLocale();
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const allowed = state.status === "online" && state.user?.id === conversation.ownerId;
  const topic = !!conversation.parentId;
  const label = topic ? t("删除话题") : dissolve ? t("解散群组") : t("删除对话");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const alive = useRef(false), saving = useRef(false), cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const remove = async () => {
    if (!allowed || saving.current) return;
    saving.current = true; setBusy(true); setError("");
    try {
      await connection.send({ v: 1, type: "conversation.archive", conversationId: conversation.id, archived: true });
      const deadline = Date.now() + 20_000;
      while (alive.current) {
        const saved = (await connection.cache.conversations()).find(value => value.id === conversation.id);
        if (!alive.current) return;
        if (saved?.archived) { removed(); return; }
        if (connection.state.status !== "online") throw new Error(t("连接恢复后即可操作"));
        if (Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (alive.current) throw new Error(t("未能确认操作结果，请核对最新状态后再试。"));
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : t("操作失败")); }
    finally { saving.current = false; if (alive.current) setBusy(false); }
  };
  return <CreationDialog title={label} className="confirmation-dialog" closeLabel={topic ? t("关闭删除话题") : dissolve ? t("关闭解散群组") : t("关闭删除对话")} close={close} busy={busy} returnFocus={returnFocus} initialFocus={cancel}>
    <h3 className="confirmation-subject">{conversation.title}</h3>
    <p className="confirmation-lead">{topic ? t("从所有设备移除此话题，群组和其他话题不受影响。") : t("从所有设备的会话列表移除。")}</p>
    <ExplanationList items={[
      ...(conversation.type === "group" && !topic ? [{ label: t("群内话题"), description: t("一并隐藏，恢复群组后重新显示。") }] : []),
      { label: t("可恢复"), description: topic ? t("在群组「全部话题 → 已归档」中恢复。") : t("在「我的 / 工作台 → 已归档对话」中恢复。") },
      { label: t("仍保留"), description: t("聊天记录、Bot、工作区和长期记忆。") },
      { label: t("运行任务"), description: t("继续执行，不会停止。") },
    ]}/>
    {!allowed && <p className="muted" role="status">{state.status !== "online" ? t("连接恢复后即可操作") : t("仅对话创建者可修改或删除此对话。")}</p>}
    {(error || state.error) && <p className="error-text" role="alert">{error || state.error}</p>}
    <div className="confirmation-actions"><button ref={cancel} disabled={busy} onClick={close}>{t("取消")}</button><button className="text-danger" disabled={busy || !allowed} onClick={() => { void remove(); }}>{busy ? t("正在处理…") : label}</button></div>
  </CreationDialog>;
}
