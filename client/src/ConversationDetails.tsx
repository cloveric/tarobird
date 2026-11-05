import { isDispatcher } from "./dispatcher.js";
import { useId, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { Activity, Camera, Monitor, Users, ChevronDown, ChevronRight, FolderOpen, MessageSquare, MessageSquarePlus, Plug, Settings, Wifi } from "lucide-react";
import type { Conversation } from "../../src/client-protocol/index.js";
import type { Bot, HubConnection } from "./connection.js";
import { ClearHistoryControl } from "./ClearHistoryControl.js";
import { GroupSettings } from "./GroupSettings.js";
import { BotSettings } from "./BotSettings.js";
import { canEditConversationAvatar, ConversationAvatar } from "./Avatar.js";
import { ConversationAvatarDialog } from "./ConversationAvatarDialog.js";
import { useBotLabels } from "./BotReferences.js";
import { ConversationDetailsFrame } from "./ConversationDetailsFrame.js";
import { t, useLocale } from "./i18n.js";

type Destination = "manage" | "conversation-files" | "files" | "capabilities" | "operations" | "connection";
/** Keep conversation, shared Bot settings and host tools in distinct scopes. */
export function ConversationDetails({ connection, conversation, group, bots, phone, hostName, connectionSummary, close, open, newChat, browseBot, returnFocus, suspended = false }: {
  connection: HubConnection; conversation: Conversation; group?: Conversation; bots: Bot[]; phone: boolean;
  hostName: string; connectionSummary: string; close: () => void; open: (destination: Destination, botId?: string) => void;
  newChat: (botId: string) => void; returnFocus: RefObject<HTMLElement | null>; suspended?: boolean;
  browseBot?: (botId: string) => void;
}) {
  const scopeId = useId();
  useLocale(); const labels = useBotLabels();
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const members = bots.filter(bot => conversation.botIds.includes(bot.id)).map(bot => ({ ...bot, name: labels.get(bot.id) ?? bot.name }));
  const [groupSettings, setGroupSettings] = useState(false), [botSettings, setBotSettings] = useState(false);
  const groupTrigger = useRef<HTMLButtonElement>(null), botTrigger = useRef<HTMLButtonElement>(null);
  const [selection, setSelection] = useState(conversation.botIds[0]);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const avatarTrigger = useRef<HTMLButtonElement>(null);
  const avatarHint = state.status !== "online" ? t("连接主机后可设置")
    : !state.conversationAvatarsAvailable ? t("升级此主机后即可设置对话头像")
    : state.user?.id !== conversation.ownerId ? t("你没有修改此头像的权限")
    : t("只改此对话，不影响 Bot 头像");
  const [resumeTarget, setResumeTarget] = useState<Destination>();
  const bot = members.find(value => value.id === selection) ?? members[0];
  const navigate = (destination: Destination) => { setResumeTarget(destination); open(destination, bot?.id); };
  return <ConversationDetailsFrame phone={phone} returnFocus={returnFocus} busy={false} close={close} suspended={suspended} resumeTarget={resumeTarget}>
    <div className="details-identity">
      <ConversationAvatar conversation={conversation} size={44}/>
      <div><h3 title={conversation.title}>{conversation.title}</h3><p>{conversation.parentId ? (group ? t("{0} · 独立话题", group.title) : t("独立话题")) : group ? t("{0} 个 Bot", conversation.botIds.length) : t("{0} · 独立对话", labels.get(conversation.botIds[0]!) ?? bot?.name ?? "Bot")}</p></div>
    </div>
    <section className="details-section" aria-label={t("当前对话")}>
      <h4>{t("当前对话")}</h4>
      {conversation.type === "direct" && !conversation.parentId && <button ref={avatarTrigger} className="details-link" aria-label={t("设置{0}", t("对话头像"))} aria-describedby={`${scopeId}-avatar`} disabled={!canEditConversationAvatar(state, conversation)} onClick={() => setAvatarOpen(true)}><Camera size={20}/><span><strong>{t("设置{0}", t("对话头像"))}</strong><small id={`${scopeId}-avatar`}>{avatarHint}</small></span><ChevronRight size={16}/></button>}
      <button className="details-link" data-details-destination="manage" aria-label={t("对话设置")} aria-describedby={`${scopeId}-conversation`} onClick={() => navigate("manage")}><Settings size={20}/><span><strong>{t("对话设置")}</strong><small id={`${scopeId}-conversation`}>{t("名称、通知与上下文")}</small></span><ChevronRight size={16}/></button>
      <button className="details-link" data-details-destination="conversation-files" aria-label={t("此对话文件")} aria-describedby={`${scopeId}-files`} onClick={() => navigate("conversation-files")}><FolderOpen size={20}/><span><strong>{t("此对话文件")}</strong><small id={`${scopeId}-files`}>{t("在这段对话中收发的文件")}</small></span><ChevronRight size={16}/></button>
      {group && <button ref={groupTrigger} className="details-link" aria-label={t("群组设置")} onClick={() => setGroupSettings(true)}><Users size={20}/><span><strong>{t("群组设置")}</strong><small>{conversation.parentId ? t("所属群：{0}", group.title) : t("群头像、名称与群组 Bot")}</small></span><ChevronRight size={16}/></button>}
      <ClearHistoryControl connection={connection} conversationId={conversation.id} disabled={suspended} variant="details"/>
    </section>
    <section className="details-section" aria-label={t("Bot 配置")}>
      <div className="details-section-heading"><h4>Bot</h4>{members.length > 1 && <select aria-label={t("查看 Bot")} value={bot?.id ?? ""} onChange={event => setSelection(event.target.value)}>{members.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select>}</div>
      <button ref={botTrigger} className="details-link" aria-label={t("Bot 设置")} aria-describedby={`${scopeId}-bot`} disabled={!bot} onClick={() => setBotSettings(true)}><Settings size={20}/><span><strong>{t("Bot 设置")}</strong><small id={`${scopeId}-bot`}>{t("模型、人设与权限 · 所有对话共用")}</small></span><ChevronRight size={16}/></button>
      {browseBot && bot && <button className="details-link" aria-label={t("查看此 Bot 的全部对话")} onClick={() => browseBot(bot.id)}><MessageSquare size={20}/><span><strong>{t("查看此 Bot 的全部对话")}</strong><small>{bot.name}</small></span><ChevronRight size={16}/></button>}
      {!isDispatcher(bot) && <button className="details-link" aria-label={t("新建独立对话")} aria-describedby={`${scopeId}-new`} disabled={!bot} onClick={() => bot && newChat(bot.id)}><MessageSquarePlus size={20}/><span><strong>{t("新建独立对话")}</strong><small id={`${scopeId}-new`}>{t("沿用 Bot 设置，从新的上下文开始")}</small></span><ChevronRight size={16}/></button>}
    </section>
    <section className="details-host" aria-label={t("主机工具")}>
      <button className="details-link details-tools-toggle" aria-expanded={toolsOpen} aria-controls={`${scopeId}-tools`} onClick={() => setToolsOpen(value => !value)}><Monitor size={20}/><span><strong>{t("主机工具")}</strong><small className="details-host-summary"><span>{hostName}</span><span>{" · "}{connectionSummary}</span></small></span><ChevronDown size={16}/></button>
      <div id={`${scopeId}-tools`} hidden={!toolsOpen} className="details-tools">
        <button className="details-link" data-details-destination="files" onClick={() => navigate("files")}><FolderOpen size={20}/><span><strong>{t("完整工作区")}</strong><small>{t("查看主机上的工作区文件")}</small></span><ChevronRight size={16}/></button>
        <button className="details-link" data-details-destination="capabilities" onClick={() => navigate("capabilities")}><Plug size={20}/><span><strong>Skills &amp; MCP</strong><small>{t("查看主机上的能力配置")}</small></span><ChevronRight size={16}/></button>
        <button className="details-link" data-details-destination="operations" onClick={() => navigate("operations")}><Activity size={20}/><span><strong>{t("运行状态")}</strong><small>{t("任务、用量与运行记录")}</small></span><ChevronRight size={16}/></button>
        <button className="details-link" data-details-destination="connection" onClick={() => navigate("connection")}><Wifi size={20}/><span><strong>{t("连接设置")}</strong><small>{hostName}</small></span><ChevronRight size={16}/></button>
      </div>
    </section>
    {groupSettings && group && <GroupSettings connection={connection} group={group} bots={bots} returnFocus={groupTrigger} close={() => setGroupSettings(false)}/>}
    {botSettings && bot && <BotSettings connection={connection} bot={bot} name={bot.name} choices={[bot, ...members.filter(value => value.id !== bot.id)]} returnFocus={botTrigger} close={() => setBotSettings(false)}/>}
    {avatarOpen && <ConversationAvatarDialog conversation={conversation} returnFocus={avatarTrigger} close={() => setAvatarOpen(false)}/>}
  </ConversationDetailsFrame>;
}
