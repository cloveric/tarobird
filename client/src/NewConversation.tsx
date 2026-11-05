import { Avatar } from "./Avatar.js";
import { useBotLabels } from "./BotReferences.js";
import { useRef, useState } from "react";
import { Bot as BotIcon, LoaderCircle, Plus } from "lucide-react";
import type { ClientFrame, Conversation } from "../../src/client-protocol/index.js";
import type { Bot, HubConnection } from "./connection.js";
import { HubHttpError } from "./http-error.js";
import { CreationDialog } from "./CreationDialog.js";
import { t, useLocale } from "./i18n.js";
import { isDispatcher } from "./dispatcher.js";
import "./conversation-creation.css";

export type ConversationCreation = { kind: "direct" | "group"; botId?: string } | { kind: "topic"; group: Conversation };
export function NewConversation({ hostName, connection, bots: allBots, request, created, close, newBot }: { hostName?: string; connection: HubConnection; bots: Bot[]; request: ConversationCreation; created: (conversation: Conversation) => void; close: () => void; newBot: () => void }) {
  useLocale(); const labels = useBotLabels();
  // A dispatcher has one conversation and joins no group. Opening it without that
  // conversation is the only way it is requested here.
  const bots = allBots.filter(bot => !isDispatcher(bot) || request.kind === "direct" && bot.id === request.botId);
  const [title, setTitle] = useState("");
  const [chosen, setChosen] = useState(request.kind === "topic" ? request.group.botIds : request.botId ? [request.botId] : []);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const submitted = useRef<Extract<ClientFrame, { type: "conversation.create" | "topic.create" }>>(undefined);
  const heading = request.kind === "topic" ? t("新建话题") : request.kind === "group" ? t("新建群组") : t("新建对话");
  const submit = async () => {
    if (busy) return; setBusy(true); setError("");
    submitted.current ??= request.kind === "topic" ? { v: 1, type: "topic.create", groupId: request.group.id, title: title.trim() || t("新话题"), clientActionId: `create_${crypto.randomUUID()}` }
      : { v: 1, type: "conversation.create", conversationType: request.kind, botIds: chosen, title: title.trim() || (request.kind === "group" ? t("新群组") : t("与 {0} 的新对话", labels.get(chosen[0] ?? "") ?? bots.find((b) => b.id === chosen[0])?.name ?? "Bot")), clientActionId: `create_${crypto.randomUUID()}` };
    try { created(await connection.createConversation(submitted.current)); }
    catch (error) {
      if (error instanceof HubHttpError && error.status >= 400 && error.status < 500) {
        submitted.current = undefined; setError(error.status === 403 ? t("当前账号没有创建此对话的权限。") : error.message === "conversation_archived" ? t("这个群组已归档，请先恢复群组。") : error.message === "dispatcher_single_conversation" ? t("幕僚长只有一个对话，请回到它现有的对话。") : error.message === "dispatcher_group_forbidden" ? t("幕僚长不能加入群组。") : t("无法创建，请检查选择的 Bot 和名称。"));
      } else setError(t("暂未收到创建结果，请重试。重试会继续同一次创建。"));
    }
    finally { setBusy(false); }
  };
  return <CreationDialog className="conversation-creation" title={heading} close={close} busy={busy} movable><form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
    <p className="creation-help">{request.kind === "topic" ? t("在「{0}」里开始独立话题，沿用群组的 Bot。", request.group.title) : request.kind === "group" ? t("选择已有 Bot 即可开群，一个 Bot 也可以。模型和 effort 沿用 Bot 设置。") : t("为已有 Bot 开一个新的独立对话。旧对话和记录仍然保留。")}</p>
    <label>{request.kind === "topic" ? t("话题名称（可选）") : request.kind === "group" ? t("群组名称（可选）") : t("对话名称（可选）")}<input autoFocus maxLength={256} placeholder={t("为这段对话起个名字")} disabled={busy || !!submitted.current} value={title} onChange={(e) => setTitle(e.target.value)}/></label>
    {request.kind !== "topic" && <fieldset disabled={busy || !!submitted.current}><legend>{request.kind === "group" ? t("选择群组 Bot") : t("选择 Bot")}</legend>{bots.map((bot) => <label className="bot-option" key={bot.id}><input type="checkbox" checked={chosen.includes(bot.id)} onChange={(e) => setChosen((old) => e.target.checked ? request.kind === "direct" ? [bot.id] : [...old, bot.id] : old.filter((id) => id !== bot.id))}/><Avatar kind="bot" id={bot.id} name={labels.get(bot.id) ?? bot.name} size={32}/><span className="bot-option-copy"><strong>{labels.get(bot.id) ?? bot.name}</strong><small>{[bot.engine, bot.model, bot.effort].filter(Boolean).join(" · ")}</small></span><span className={`bot-option-status ${bot.online ? "online-label" : "muted"}`}>{bot.online ? t("在线") : t("离线")}</span></label>)}</fieldset>}
    {request.kind === "topic" && <div className="inherited-bots">{bots.filter((b) => chosen.includes(b.id)).map((b) => <span key={b.id}><BotIcon size={15}/>{labels.get(b.id) ?? b.name}</span>)}</div>}
    {!bots.length && <div className="creation-empty"><p>{t("先创建一个 Bot，之后就能快速开对话和群组。")}</p><button type="button" onClick={newBot}>{t("新建 Bot")}</button></div>}
    {chosen.some((id) => !bots.find((b) => b.id === id)?.online) && <p className="muted">{t("离线 Bot 会在上线后处理消息。")}</p>}
    {error && <p role="alert" className="error-text">{error}</p>}
    <button className="primary full" disabled={busy || !chosen.length || connection.state.status !== "online"}>{busy ? <LoaderCircle className="spin" size={17}/> : <Plus size={17}/>} {busy ? t("正在创建…") : error ? t("重试创建") : request.kind === "group" ? t("创建群组") : request.kind === "topic" ? t("创建话题") : t("创建对话")}</button>
  </form></CreationDialog>;
}
