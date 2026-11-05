import { useEffect, useRef, useState } from "react";
import { ChevronDown, Cpu } from "lucide-react";
import { modelSettingsSchema, modelValueSchema, type ModelSettings } from "../../src/client-protocol/model.js";
import type { Bot, HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import { useBotSettingsRequest } from "./bot-settings-request.js";
import { HubHttpError } from "./http-error.js";
import { t, useLocale } from "./i18n.js";
import { modelOptionLabel, modelOptions, selectedModelOption, selectedModelEffort, selectModel, selectModelEffort } from "./model-selection.js";

export function modelSettingsErrorText(error: unknown) {
  if (error instanceof HubHttpError && error.status === 404) return t("此主机尚不支持在设置中切换模型，请更新主机版本。");
  switch (error instanceof Error ? error.message : "") {
    case "model_conflict": return t("其他设备或本机已修改设置。请重新读取后再选择，避免覆盖对方的修改。");
    case "model_effort_incompatible": return t("所选模型不支持此思考强度，请选择跟随默认或重新读取可用档位。");
    case "model_config_unreadable": return t("无法完整读取 Bot 配置，请先检查主机上的配置文件。");
    case "model_engine_changed": return t("Bot 引擎已更改，请待主机完成重启后再调整。");
    case "bot_offline": return t("Bot 当前离线。连接恢复后再调整模型和思考强度。");
    default: return t("未能确认设置结果，请重新读取后核对。不会自动重试保存。");
  }
}
export function ModelControl({ connection, bot, online, owner, compact = false }: { connection: HubConnection; bot: Bot; online: boolean; owner: boolean; compact?: boolean }) {
  useLocale();
  const [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!owner) setOpen(false); }, [owner]);
  return <><button ref={trigger} type="button" className={compact ? "composer-model-trigger" : "header-effort"} aria-label={compact ? t("模型设置：{0}", bot.model || t("引擎默认模型")) : t("调整 Bot 模型")} aria-haspopup="dialog" aria-expanded={open} title={!owner ? t("仅拥有者可修改 Bot 设置") : compact && !online ? t("Bot 当前离线。连接恢复后再调整模型和思考强度。") : `${bot.model || t("引擎默认模型")} · ${t("修改此 Bot 的模型，影响它的所有对话")}`} disabled={!owner || compact && !online} onClick={() => setOpen(true)}>{compact && <Cpu size={13} aria-hidden="true"/>}<span>{bot.model || t("引擎默认模型")}</span><ChevronDown size={12} aria-hidden="true"/></button>
    {open && owner && <ModelDialog connection={connection} bot={bot} online={online} close={() => setOpen(false)} returnFocus={trigger}/>}
  </>;
}
function ModelDialog({ connection, bot, online, close, returnFocus }: { connection: HubConnection; bot: Bot; online: boolean; close: () => void; returnFocus: React.RefObject<HTMLButtonElement | null> }) {
  const { data, busy, saving, error, saved, load, save } = useBotSettingsRequest(connection, bot.id, "model", modelSettingsSchema);
  const [draft, setDraft] = useState(""), [custom, setCustom] = useState(false), [effort, setEffort] = useState<ModelSettings["effort"]>(""), [adjusted, setAdjusted] = useState(false);
  useEffect(() => { if (data) { setDraft(data.model); setEffort(data.effort); setCustom(false); setAdjusted(false); } }, [data]);
  const models = modelOptions(data?.engine ?? "", data?.choices ?? []), selectedModel = selectedModelOption(models, draft);
  const displayedEffort = selectedModelEffort(selectedModel, { model: draft, effort });
  const levels = selectedModel?.efforts ?? data?.customEfforts ?? [""];
  function changeModel(model: string) {
    const next = selectModel(models, model, { model: draft, effort }, data?.customEfforts);
    setDraft(next.model); setEffort(next.effort); setAdjusted(next.effort !== displayedEffort);
  }
  const valid = modelValueSchema.safeParse(draft).success && (!custom || !!draft.trim()) && levels.includes(displayedEffort);
  return <CreationDialog mobilePage title={t("模型设置")} closeLabel={t("关闭模型设置")} close={close} busy={saving} returnFocus={returnFocus}>
    <div className="effort-settings">
      <p className="effort-scope"><strong>{bot.name}</strong><span>{t("此 Bot 的所有对话、群聊和话题共用")}</span></p>
      {data && <form onSubmit={event => { event.preventDefault(); if (!busy && online && valid) void save({ revision: data.revision, model: draft, effort }); }}>
        <p className="muted">{t("引擎")} · {data.engine}</p>
        <label>{t("选择模型")}<select aria-label={t("选择模型")} disabled={busy || !online} value={custom ? "__custom__" : selectedModel?.id ?? draft} onChange={event => {
          const value = event.target.value; setCustom(value === "__custom__"); changeModel(value === "__custom__" ? "" : value);
        }}>
          {models.map(choice => <option key={choice.id} value={choice.id}>{modelOptionLabel(choice, t("引擎默认模型"))}</option>)}
          <option value="__custom__">{t("自定义模型…")}</option>
        </select></label>
        {custom && <label>{t("模型 ID")}<input aria-label={t("模型 ID")} value={draft} maxLength={128} disabled={busy || !online} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={event => {
          const value = event.target.value; setDraft(value);
          const choices = data.choices.find(choice => choice.id === value)?.efforts ?? data.customEfforts;
          if (!choices.includes(effort)) { setEffort(""); setAdjusted(true); }
        }}/></label>}
        {custom && <p className="muted">{t("填写该引擎支持的模型 ID；实际可用性由主机上的账号和引擎确认。")}</p>}
        <label>{t("思考强度")}<select aria-label={t("模型思考强度")} disabled={busy || !online} value={displayedEffort} onChange={event => { const next = selectModelEffort(selectedModel, draft, event.target.value as ModelSettings["effort"]); if (next) { setDraft(next.model); setEffort(next.effort); setAdjusted(false); } }}>
          {!levels.includes(displayedEffort) && <option value={displayedEffort} disabled>{displayedEffort} · {t("当前模型不支持")}</option>}
          {levels.map(value => <option key={value} value={value}>{value || t("跟随默认（不强制指定）")}</option>)}
        </select></label>
        {adjusted && <p className="dashboard-notice">{selectedModel?.variants ? t("已调整为此模型支持的思考强度，请确认。") : t("新模型不支持原思考强度，已选为跟随默认。你也可以选择其他可用档位。")}</p>}
        <p className="muted">{t("后续任务读取新设置；当前任务不打断，后台任务繁忙时可能延后应用。不会新建会话或清空上下文。")}</p>
        {data.activeTurns > 0 && <p className="dashboard-notice">{t("此 Bot 有 {0} 个执行中的任务。", data.activeTurns)}</p>}
        {saved && draft === data.model && effort === data.effort && <p role="status" className="dashboard-notice">{t("已保存为 {0}，此 Bot 的其他对话也会沿用。", data.model || t("引擎默认模型"))}</p>}
        <div className="effort-actions"><button type="button" disabled={busy || !online} onClick={() => void load()}>{t("重新读取")}</button><button type="submit" className="primary" disabled={busy || !online || !valid || draft === data.model && effort === data.effort}>{busy ? t("保存中…") : t("保存到此 Bot")}</button></div>
      </form>}
      {!data && <button disabled={busy || !online} onClick={() => void load()}>{busy ? t("正在读取…") : t("重新读取")}</button>}
      {!online && <p role="status">{t("连接恢复后即可操作")}</p>}
      {error !== undefined && <p role="alert" className="error-text">{modelSettingsErrorText(error)}</p>}
    </div>
  </CreationDialog>;
}
