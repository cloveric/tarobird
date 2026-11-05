import { ExplanationList } from "./ExplanationList.js";
import { useEffect, useRef, useState } from "react";
import { ChevronRight, SlidersHorizontal } from "lucide-react";
import { PERSONA_MAX_LENGTH, personaSettingsSchema } from "../../src/client-protocol/persona.js";
import type { Bot, HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import { useBotSettingsRequest } from "./bot-settings-request.js";
import { t, useLocale } from "./i18n.js";

export function PersonaControl({ connection, bot, online, owner }: { connection: HubConnection; bot: Bot; online: boolean; owner: boolean }) {
  useLocale(); const [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null);
  return <><button ref={trigger} className="details-link persona-entry" disabled={!owner} onClick={() => setOpen(true)}>
    <SlidersHorizontal size={18}/><span><strong>{t("人设")}</strong><small>{t("编辑角色、语气与偏好 · 此 Bot 的所有对话共用")}</small></span><ChevronRight size={16}/>
  </button>{open && owner && <PersonaDialog key={bot.id} connection={connection} bot={bot} online={online} close={() => setOpen(false)} returnFocus={trigger}/>}</>;
}
function personaError(error: unknown) {
  switch (error instanceof Error ? error.message : "") {
    case "persona_conflict": return t("人设已被其他设备修改。你的草稿仍保留，请复制需要的内容后重新读取。");
    case "persona_too_large": return t("现有人设超出编辑长度，请在主机上整理后重试。原文件未修改。");
    case "persona_unreadable": return t("无法读取现有人设，原文件未修改。请检查主机上的人设文件。");
    case "persona_unwritable": return t("人设未能保存，请检查主机磁盘与文件权限。");
    case "bot_offline": return t("Bot 当前离线，请连接后重试。");
    case "not_found": case "gateway_method_unknown": case "unknown_gateway_operation": return t("主机尚不支持人设编辑，请先更新主机上的 TaroBird。");
    default: return t("未能确认设置结果，请重新读取后核对。不会自动重试保存。");
  }
}
function PersonaDialog({ connection, bot, online, close, returnFocus }: { connection: HubConnection; bot: Bot; online: boolean; close: () => void; returnFocus: React.RefObject<HTMLButtonElement | null> }) {
  const { data, busy, saving, error, saved, load, save } = useBotSettingsRequest(connection, bot.id, "persona", personaSettingsSchema);
  const [draft, setDraft] = useState(""), [confirm, setConfirm] = useState<"close" | "reload">();
  useEffect(() => { if (data) setDraft(data.text); }, [data]);
  const dirty = !!data && draft !== data.text;
  const leave = () => { if (dirty) setConfirm("close"); else close(); };
  return <CreationDialog mobilePage title={t("编辑人设")} closeLabel={t("关闭人设编辑")} close={leave} busy={saving} returnFocus={returnFocus} className="persona-panel">
    <p className="persona-scope"><strong>{bot.name}</strong><span>{t("此 Bot 的所有对话、群聊和话题共用")}</span></p>
    <p className="muted">{t("设置角色、语气与偏好；留空则移除文件中的人设要求。")}</p>
    {data ? <form onSubmit={event => { event.preventDefault(); if (!busy && online && dirty) void save({ revision: data.revision, text: draft }); }}>
      <label>{t("人设内容")}<textarea aria-label={t("人设内容")} value={draft} onChange={event => { setDraft(event.target.value); setConfirm(undefined); }} maxLength={PERSONA_MAX_LENGTH} rows={9} disabled={saving} placeholder={t("例如：你是我的研究助手。用中文回答，先说结论，再列依据；不确定时明确说明。")}/></label>
      <div className="persona-count">{draft.length.toLocaleString()} / {PERSONA_MAX_LENGTH.toLocaleString()}</div>
      <p className="muted">{t("保存只更新文件。需要在当前对话使用新版时，请让 Bot 重新读取人设文件。")}</p>
      {data.activeTurns > 0 && <p className="dashboard-notice">{t("此 Bot 有 {0} 个执行中的任务。", data.activeTurns)}</p>}
      {saved && !dirty && <p role="status" className="dashboard-notice">{t("人设已保存到文件。")}</p>}
      <div className="effort-actions"><button type="button" disabled={busy || !online} onClick={() => dirty ? setConfirm("reload") : void load()}>{t("刷新编辑内容")}</button><button className="primary" type="submit" disabled={busy || !online || !dirty}>{saving ? t("保存中…") : t("保存人设")}</button></div>
    </form> : <button disabled={busy || !online} onClick={() => void load()}>{busy ? t("正在读取…") : t("刷新编辑内容")}</button>}
    {confirm && <div className="persona-discard" role="alert"><p>{t("尚有未保存的人设修改，要放弃这些修改吗？")}</p><button onClick={() => setConfirm(undefined)}>{t("继续编辑")}</button><button onClick={() => { const action = confirm; setConfirm(undefined); if (action === "close") close(); else void load(); }}>{t("放弃修改")}</button></div>}
    {!online && <p role="status">{t("连接恢复后即可操作")}</p>}
    {error !== undefined && <p role="alert" className="error-text">{personaError(error)}</p>}
    <details className="settings-help"><summary>{t("记忆与上下文如何共享")}</summary><ExplanationList items={[
      { label: t("各自独立"), description: t("不同对话的聊天上下文。") },
      { label: t("共同使用"), description: t("此 Bot 的工作区、人设和长期记忆。") },
      { label: t("修改人设后"), description: t("已有对话仍带入历史；需要全新上下文时，可新建对话。") },
    ]}/></details>
  </CreationDialog>;
}
