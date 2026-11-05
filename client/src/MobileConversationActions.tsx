import { beginPinFocus, cancelPinFocus } from "./conversation-pin-focus.js";
import { useConversationBulk } from './ConversationBulkSelection.js';
import { MoveToFolder } from "./ConversationFolders.js";
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { AvatarProvider, canEditConversationAvatar } from "./Avatar.js";
import { ConversationAvatarDialog } from "./ConversationAvatarDialog.js";
import { ListChecks, Camera, FolderInput, Pencil, Pin, PinOff, Settings2, Trash2, UsersRound } from "lucide-react";
import { CreationDialog } from "./CreationDialog.js";
import { RenameConversation } from "./RenameConversation.js";
import { GroupSettings } from "./GroupSettings.js";
import { RemoveConversation } from "./RemoveConversation.js";
import { RuntimeHostContext } from "./RuntimeHost.js";
import type { MobileHost } from "./MobileHome.js";
import { t, useLocale } from "./i18n.js";

/** Resolve against the clicked host on every render; duplicate conversation IDs
 * in another host must never redirect a write or inherit its permission state. */
export function MobileConversationActions({ host, conversationId, returnFocus, close }: {
  host: MobileHost; conversationId: string; returnFocus: RefObject<HTMLElement | null>; close: () => void;
}) {
  useLocale();
  const bulk = useConversationBulk();
  const { connection } = host;
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const conversation = host.conversations.find(c => c.id === conversationId && !c.archived);
  const [view, setView] = useState<"actions" | "rename" | "remove" | "move" | "avatar" | "settings">("actions");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const alive = useRef(false), saving = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!conversation) close(); }, [conversation, close]);
  if (!conversation) return null;
  const group = conversation.type === "group" && !conversation.parentId;
  const pinned = host.pins.includes(conversation.id);
  const globallyPinned = host.globalPins?.includes(conversation.id) ?? false;
  const allowed = state.status === "online" && state.user?.id === conversation.ownerId;
  const pin = async (scope: "group" | "global" = "group") => {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError("");
    const value = !(scope === "global" ? globallyPinned : pinned);
    const owner = connection.identity.hubPublicKey ? JSON.stringify([connection.identity.hubPublicKey, connection.identity.publicKey]) : undefined;
    const intent = beginPinFocus(owner, conversation.id, value, scope, returnFocus.current);
    try { await connection.pinConversation(conversation.id, value, scope); if (alive.current) close(); }
    catch { cancelPinFocus(intent); if (alive.current) setError(t("操作失败")); }
    finally { saving.current = false; if (alive.current) setBusy(false); }
  };
  return <RuntimeHostContext.Provider value={host.name}><AvatarProvider connection={connection} conversations={host.conversations} directory={host.bots}>
    {view === "settings" && group ? <GroupSettings connection={connection} group={conversation} bots={state.bots} returnFocus={returnFocus} close={close}/> : view === "avatar" ? <ConversationAvatarDialog conversation={conversation} returnFocus={returnFocus} close={close}/> : view === "move" ? <MoveToFolder connection={connection} conversationId={conversation.id} returnFocus={returnFocus} close={close}/> : view === "remove" ? <RemoveConversation connection={connection} conversation={conversation} dissolve={group} returnFocus={returnFocus} close={close} removed={close}/> : view === "rename" ? <RenameConversation connection={connection} conversation={conversation} returnFocus={returnFocus} close={close}/> :
      <CreationDialog title={group ? t("群组操作") : t("对话操作")} closeLabel={t("关闭对话操作")} className="mobile-conversation-actions" busy={busy} returnFocus={returnFocus} close={close}>
        <p className="mobile-conversation-action-title">{conversation.title}</p>
        <div className="mobile-chat-action-list">
          {bulk && <button type="button" disabled={busy} onClick={() => { bulk.begin(connection, conversation, returnFocus.current); close(); }}><ListChecks size={20}/><span>{t('多选')}</span></button>}
          {group && <button type="button" disabled={busy} onClick={() => setView("settings")}><Settings2 size={20}/><span>{t("群组设置")}</span></button>}
          <button type="button" disabled={busy} onClick={() => { void pin("global"); }}>{globallyPinned ? <PinOff size={20}/> : <Pin size={20}/>}<span>{globallyPinned ? t("取消全局置顶") : t("全局置顶")}</span></button>
          <button type="button" disabled={busy} onClick={() => { void pin(); }}>{pinned ? <PinOff size={20}/> : <Pin size={20}/>}<span>{pinned ? t("取消分组置顶") : t("分组置顶")}</span></button>
          {!conversation.parentId && <button type="button" disabled={busy || state.status !== "online" || !state.foldersAvailable} onClick={() => setView("move")}><FolderInput size={20}/><span>{t("移至分组")}</span></button>}
          {!conversation.parentId && <button type="button" disabled={busy || !canEditConversationAvatar(state, conversation)} title={!group && !state.conversationAvatarsAvailable ? t("升级此主机后即可设置对话头像") : undefined} onClick={() => setView("avatar")}><Camera size={20}/><span>{t("设置{0}", group ? t("群头像") : t("对话头像"))}</span></button>}
          <button type="button" disabled={busy || !allowed} onClick={() => setView("rename")}><Pencil size={20}/><span>{t("重命名")}</span></button>
          <button type="button" disabled={busy || !allowed} className="text-danger" onClick={() => setView("remove")}>{group ? <UsersRound size={20}/> : <Trash2 size={20}/>}<span>{group ? t("解散群组") : conversation.parentId ? t("删除话题") : t("删除对话")}</span></button>
        </div>
        {!group && state.status === "online" && !state.conversationAvatarsAvailable && <p className="muted">{t("升级此主机后即可设置对话头像")}</p>}
        {!allowed && <p className="muted">{state.status !== "online" ? t("连接恢复后可重命名或删除；置顶仍可使用。") : t("仅对话创建者可修改或删除此对话。")}</p>}
        {error && <p role="alert" className="error-text">{error}</p>}
      </CreationDialog>}
  </AvatarProvider></RuntimeHostContext.Provider>;
}
