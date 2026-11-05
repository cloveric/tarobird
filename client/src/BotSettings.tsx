import { DispatcherSettingsControl } from "./DispatcherSettings.js";
import { DispatcherRoutingHelp } from "./DispatcherRoutingHelp.js";
import { isDispatcher } from "./dispatcher.js";
import { ClaudeChromeControl } from "./ClaudeChromeControl.js";
import { DeleteBotControl } from "./DeleteBotControl.js";
import { PermissionControl } from "./PermissionControl.js";
import { PersonaControl } from "./PersonaControl.js";
import { BotNameControl } from "./BotNameControl.js";
import { BotMessageGrantsControl } from "./BotMessageGrantsControl.js";
import { useState, useSyncExternalStore, type RefObject } from "react";
import type { Bot, HubConnection } from "./connection.js";
import { AvatarEditor } from "./Avatar.js";
import { CreationDialog } from "./CreationDialog.js";
import { EffortControl } from "./EffortControl.js";
import { ModelControl } from "./ModelControl.js";
import { t, useLocale } from "./i18n.js";

/** Bot-scoped settings must also work before its first conversation exists. */
export function BotSettings({ connection, bot: initialBot, name: initialName, choices, close, returnFocus }: {
  connection: HubConnection; bot: Bot; name: string; choices?: Bot[]; close: () => void; returnFocus: RefObject<HTMLElement | null>;
}) {
  useLocale();
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const [selection, setSelection] = useState(initialBot.id);
  const bots = (choices ?? [{ ...initialBot, name: initialName }]).map(value => [...state.bots, ...(state.deletedBots ?? [])].find(current => current.id === value.id) ?? value);
  const bot = bots.find(value => value.id === selection) ?? bots[0] ?? initialBot;
  const name = bot.name;
  const controlBots = [bot, ...bots.filter(value => value.id !== bot.id)];
  const online = !bot.deletedAt && state.status === "online" && !!bot.online;
  return <CreationDialog mobilePage title={t("Bot 设置")} closeLabel={t("关闭 Bot 设置")} close={close} returnFocus={returnFocus} movable className="settings-panel bot-settings-panel">
    {bots.length > 1 && <label className="details-bot-select">{t("选择要调整的 Bot")}<select aria-label={t("选择要调整的 Bot")} value={bot.id} onChange={event => setSelection(event.target.value)}>{bots.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>}
    {!bot.deletedAt && <><AvatarEditor key={bot.id} kind="bot" id={bot.id} name={name} label={t("Bot 头像")}/>
    <BotNameControl key={`name-${bot.id}`} connection={connection} bot={bot}/>
    <p className="muted">{t("此 Bot 的所有对话、群聊和话题共用")}</p>
    <dl className="dashboard-config">
      <div><dt>{t("引擎")}</dt><dd>{bot.engine || t("未记录")}</dd></div>
    </dl>
    <div className="details-effort"><span>{t("模型")}</span><ModelControl key={`model-${bot.id}`} connection={connection} bot={bot} online={online} owner={state.user?.role === "owner"}/></div>
    <div className="details-effort"><span>{t("思考强度")}</span><EffortControl connection={connection} bots={controlBots} summary={bot.effort || t("跟随默认")} online={online} owner={state.user?.role === "owner"}/></div>
    <div className="details-effort"><span>{t("权限与批准")}</span><PermissionControl connection={connection} bots={controlBots} online={online} owner={state.user?.role === "owner"}/></div>
    {isDispatcher(bot) && state.dispatchAvailable && <div className="details-effort"><div className="dispatcher-role-label">{t("幕僚长设置")}<DispatcherRoutingHelp key={`routing-${bot.id}`}/></div><DispatcherSettingsControl key={`dispatch-${bot.id}`} connection={connection} bot={bot} online={state.status === "online"} owner={state.user?.role === "owner"}/></div>}
    {bot.engine === "claude" && <div className="details-effort"><span>{t("Chrome 浏览器联动")}</span><ClaudeChromeControl key={`chrome-${bot.id}`} connection={connection} bot={bot} online={online} owner={state.user?.role === "owner"}/></div>}
    <BotMessageGrantsControl key={`messages-${bot.id}`} connection={connection} bot={bot} online={state.status === "online"} owner={state.user?.role === "owner"}/>
    {!online && <p className="muted" role="status">{t("Bot 当前离线。连接恢复后再调整模型和思考强度。")}</p>}
    {state.user?.role !== "owner" && <p className="muted">{t("仅拥有者可修改 Bot 设置")}</p>}
    <PersonaControl key={`persona-${bot.id}`} connection={connection} bot={bot} online={online} owner={state.user?.role === "owner"}/></>}
    {bot.deletedAt && <p role="status">{t("此 Bot 已删除，历史对话和文件已保留。")}</p>}
    <DeleteBotControl key={`delete-${bot.id}`} connection={connection} bot={bot} deleted={close}/>
  </CreationDialog>;
}
