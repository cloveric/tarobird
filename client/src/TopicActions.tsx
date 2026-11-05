import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { Conversation } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import { RenameConversation } from "./RenameConversation.js";
import { RemoveConversation } from "./RemoveConversation.js";
import { t, useLocale } from "./i18n.js";

/** Operates on the clicked topic; opening its menu never switches conversations. */
export function TopicActions({ connection, topic, close, removed, returnFocus }: {
  connection: HubConnection; topic: Conversation; close: () => void; removed: () => void; returnFocus: RefObject<HTMLElement | null>;
}) {
  useLocale();
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const allowed = state.status === "online" && state.user?.id === topic.ownerId;
  const [view, setView] = useState<"menu" | "rename" | "remove">("menu");
  useEffect(() => { if (topic.archived) removed(); }, [topic.archived, removed]);
  if (view === "rename") return <RenameConversation connection={connection} conversation={topic} close={close} returnFocus={returnFocus}/>;
  if (view === "remove") return <RemoveConversation connection={connection} conversation={topic} close={close} removed={removed} returnFocus={returnFocus}/>;
  return <CreationDialog title={t("话题操作")} closeLabel={t("关闭话题操作")} close={close} returnFocus={returnFocus} showHost={false}>
    <p className="topic-action-title">{topic.title}</p>
    <div className="mobile-chat-action-list">
      <button type="button" disabled={!allowed} onClick={() => setView("rename")}><Pencil size={20}/><span>{t("重命名话题")}</span></button>
      <button type="button" disabled={!allowed} className="text-danger" onClick={() => setView("remove")}><Trash2 size={20}/><span>{t("删除话题")}</span></button>
    </div>
    {!allowed && <p className="muted">{state.status !== "online" ? t("连接恢复后即可操作") : t("仅话题创建者可改名或删除。")}</p>}
  </CreationDialog>;
}
