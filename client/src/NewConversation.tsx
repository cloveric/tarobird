import { Avatar } from "./Avatar.js";
import { useBotLabels } from "./BotReferences.js";
import { useRef, useState, useSyncExternalStore } from "react";
import { Bot as BotIcon, Folder, FolderPlus, LoaderCircle, Plus } from "lucide-react";
import type { ClientFrame, Conversation } from "../../src/client-protocol/index.js";
import { workspaceDisplayName } from "../../src/client-protocol/saved-workspaces.js";
import type { Bot, HubConnection } from "./connection.js";
import { HubHttpError } from "./http-error.js";
import { CreationDialog } from "./CreationDialog.js";
import { t, useLocale } from "./i18n.js";
import { useSavedWorkspaces, WorkspaceAddForm } from "./WorkspacePicker.js";
import "./conversation-creation.css";
import "./workspace-picker.css";

export type ConversationCreation = { kind: "direct" | "group"; botId?: string } | { kind: "topic"; group: Conversation };
export function NewConversation({ hostName, connection, bots, request, created, close, newBot }: { hostName?: string; connection: HubConnection; bots: Bot[]; request: ConversationCreation; created: (conversation: Conversation) => void; close: () => void; newBot: () => void }) {
  useLocale(); const labels = useBotLabels();
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const [title, setTitle] = useState("");
  const [chosen, setChosen] = useState(request.kind === "topic" ? request.group.botIds : request.botId ? [request.botId] : []);
  const [workspaceOverride, setWorkspaceOverride] = useState<string>("");
  const [addingWorkspace, setAddingWorkspace] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const submitted = useRef<Extract<ClientFrame, { type: "conversation.create" | "topic.create" }>>(undefined);
  const showWorkspacePicker = request.kind !== "topic" && state.user?.role === "owner" && !!state.savedWorkspacesAvailable;
  const savedWorkspaces = useSavedWorkspaces(connection, showWorkspacePicker && state.status === "online");
  const primaryBot = chosen.length === 1 ? bots.find(b => b.id === chosen[0]) : undefined;
  const defaultWorkspacePath = primaryBot?.workspacePath;
  const defaultWorkspaceLabel = defaultWorkspacePath ? workspaceDisplayName(defaultWorkspacePath) : t("Bot 默认目录");
  const heading = request.kind === "topic" ? t("新建话题") : request.kind === "group" ? t("新建群组") : t("新建对话");
  const submit = async () => {
    if (busy) return; setBusy(true); setError("");
    submitted.current ??= request.kind === "topic" ? { v: 1, type: "topic.create", groupId: request.group.id, title: title.trim() || t("新话题"), clientActionId: `create_${crypto.randomUUID()}` }
      : { v: 1, type: "conversation.create", conversationType: request.kind, botIds: chosen, title: title.trim() || (request.kind === "group" ? t("新群组") : t("与 {0} 的新对话", labels.get(chosen[0] ?? "") ?? bots.find((b) => b.id === chosen[0])?.name ?? "Bot")), ...(workspaceOverride ? { workspacePath: workspaceOverride } : {}), clientActionId: `create_${crypto.randomUUID()}` };
    try { created(await connection.createConversation(submitted.current)); }
    catch (error) {
      if (error instanceof HubHttpError && error.status >= 400 && error.status < 500) {
        submitted.current = undefined; setError(error.status === 403 ? t("当前账号没有创建此对话的权限。") : error.message === "conversation_archived" ? t("这个群组已归档，请先恢复群组。") : error.message === "dispatcher_single_conversation" ? t("此主机版本尚不支持为幕僚长新建对话，请更新主机后重试。") : error.message === "dispatcher_group_forbidden" ? t("此主机版本尚不支持将幕僚长加入群组，请更新主机后重试。") : error.message === "workspace_unavailable" ? t("所选工作区在主机上不存在，请选择其他目录。") : t("无法创建，请检查选择的 Bot 和名称。"));
      } else setError(t("暂未收到创建结果，请重试。重试会继续同一次创建。"));
    }
    finally { setBusy(false); }
  };
  return <CreationDialog className="conversation-creation" title={heading} close={close} busy={busy} movable><form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
    <p className="creation-help">{request.kind === "topic" ? t("在「{0}」里开始独立话题，沿用群组的 Bot。", request.group.title) : request.kind === "group" ? t("选择已有 Bot 即可开群，一个 Bot 也可以。模型和 effort 沿用 Bot 设置。") : t("为已有 Bot 开一个新的独立对话。旧对话和记录仍然保留。")}</p>
    <label>{request.kind === "topic" ? t("话题名称（可选）") : request.kind === "group" ? t("群组名称（可选）") : t("对话名称（可选）")}<input autoFocus maxLength={256} placeholder={t("为这段对话起个名字")} disabled={busy || !!submitted.current} value={title} onChange={(e) => setTitle(e.target.value)}/></label>
    {request.kind !== "topic" && <fieldset disabled={busy || !!submitted.current}><legend>{request.kind === "group" ? t("选择群组 Bot") : t("选择 Bot")}</legend>{bots.map((bot) => <label className="bot-option" key={bot.id}><input type="checkbox" checked={chosen.includes(bot.id)} onChange={(e) => setChosen((old) => e.target.checked ? request.kind === "direct" ? [bot.id] : [...old, bot.id] : old.filter((id) => id !== bot.id))}/><Avatar kind="bot" id={bot.id} name={labels.get(bot.id) ?? bot.name} size={32}/><span className="bot-option-copy"><strong>{labels.get(bot.id) ?? bot.name}</strong><small>{[bot.engine, bot.model, bot.effort].filter(Boolean).join(" · ")}</small></span><span className={`bot-option-status ${bot.online ? "online-label" : "muted"}`}>{bot.online ? t("在线") : t("离线")}</span></label>)}</fieldset>}
    {showWorkspacePicker && <div className="new-chat-workspace" role="group" aria-label={t("对话工作区")}>
      <div className="new-chat-workspace-head">
        <span>{t("本次对话工作区")}</span>
        <button type="button" className="workspace-add-trigger" disabled={busy || !!submitted.current || state.status !== "online"} onClick={() => setAddingWorkspace(value => !value)}>
          <FolderPlus size={14} aria-hidden="true"/>
          <span>{addingWorkspace ? t("收起") : t("添加文件夹")}</span>
        </button>
      </div>
      <div className="workspace-quick-chips">
        <button type="button" className={`workspace-chip${!workspaceOverride ? " is-selected" : ""}`} aria-pressed={!workspaceOverride} disabled={busy || !!submitted.current} title={defaultWorkspacePath || t("跟随 Bot 默认工作区")} onClick={() => setWorkspaceOverride("")}>
          <Folder size={13} aria-hidden="true"/>
          <span>{primaryBot ? t("跟随 Bot 默认（{0}）", defaultWorkspaceLabel) : t("跟随 Bot 默认")}</span>
        </button>
        {savedWorkspaces.items.filter(item => item.exists !== false).map(item => (
          <button key={item.id} type="button" className={`workspace-chip${workspaceOverride === item.path ? " is-selected" : ""}`} aria-pressed={workspaceOverride === item.path} disabled={busy || !!submitted.current} title={item.path} onClick={() => setWorkspaceOverride(item.path)}>
            <Folder size={13} aria-hidden="true"/>
            <span>{item.name || workspaceDisplayName(item.path)}</span>
          </button>
        ))}
      </div>
      {(workspaceOverride || defaultWorkspacePath) && <p className="workspace-chip-hint" title={workspaceOverride || defaultWorkspacePath}>{workspaceOverride || defaultWorkspacePath}</p>}
      {savedWorkspaces.error && <p role="alert" className="error-text">{savedWorkspaces.error}</p>}
      {addingWorkspace && <WorkspaceAddForm connection={connection} disabled={busy || !!submitted.current || state.status !== "online"} onAdded={async workspace => { setAddingWorkspace(false); await savedWorkspaces.reload(); setWorkspaceOverride(workspace.path); }} onCancel={() => setAddingWorkspace(false)}/>}
    </div>}
    {request.kind === "topic" && <div className="inherited-bots">{bots.filter((b) => chosen.includes(b.id)).map((b) => <span key={b.id}><BotIcon size={15}/>{labels.get(b.id) ?? b.name}</span>)}</div>}
    {!bots.length && <div className="creation-empty"><p>{t("先创建一个 Bot，之后就能快速开对话和群组。")}</p><button type="button" onClick={newBot}>{t("新建 Bot")}</button></div>}
    {chosen.some((id) => !bots.find((b) => b.id === id)?.online) && <p className="muted">{t("离线 Bot 会在上线后处理消息。")}</p>}
    {error && <p role="alert" className="error-text">{error}</p>}
    <button className="primary full" disabled={busy || !chosen.length || connection.state.status !== "online"}>{busy ? <LoaderCircle className="spin" size={17}/> : <Plus size={17}/>} {busy ? t("正在创建…") : error ? t("重试创建") : request.kind === "group" ? t("创建群组") : request.kind === "topic" ? t("创建话题") : t("创建对话")}</button>
  </form></CreationDialog>;
}
