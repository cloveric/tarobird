import { PiModelSelect, PiModelCatalogNotice } from "./PiModelSelect.js";
import { DeepSeekModelCatalogNotice, deepSeekCatalogBlocked, deepSeekSettingsErrorText } from "./DeepSeekModelCatalog.js";
import { decodePiModel } from "../../src/codex/pi-models.js";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Cpu } from "lucide-react";
import { deepSeekDefaultUnavailable, modelSettingsSchema, modelValueSchema, type ModelSettings } from "../../src/client-protocol/model.js";
import type { Bot, HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import { useBotSettingsRequest } from "./bot-settings-request.js";
import { HubHttpError } from "./http-error.js";
import { t, useLocale } from "./i18n.js";
import { piModelSettingsRejectionText } from "./pi-rejection-text.js";
import { modelOptionLabel, modelOptions, selectedModelOption, selectedModelEffort, selectModel, selectModelEffort } from "./model-selection.js";

/** `attempt`: the model and effort that were saved, with the catalog read for them, so a Pi refusal can say which part failed. */
export function modelSettingsErrorText(error: unknown, attempt?: { engine?: string; model: string; effort: string; choices: readonly { id: string; provider?: string; efforts: readonly string[] }[] }) {
  const piError = attempt && error instanceof Error ? piModelSettingsRejectionText(error.message, attempt) : undefined; if (piError) return piError;
  const deepSeekError = deepSeekSettingsErrorText(error); if (deepSeekError) return deepSeekError;
  if (error instanceof HubHttpError && error.status === 404) return t("此主机尚不支持在设置中切换模型，请更新主机版本。");
  switch (error instanceof Error ? error.message : "") {
    case "model_id_invalid": return attempt?.engine === "omp"
      ? t("omp 模型必须包含提供商，例如 provider/model。请从列表选择，或填写完整 ID。")
      : t("Pi 模型必须包含提供商，例如 provider/model。请从列表选择，或填写完整 ID。");
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
  return <><button ref={trigger} type="button" className={compact ? "composer-model-trigger" : "header-effort"} aria-label={compact ? t("模型设置：{0}", bot.model || t("引擎默认模型")) : t("调整 Bot 模型")} aria-haspopup="dialog" aria-expanded={open} title={!owner ? t("仅拥有者可修改 Bot 设置") : compact && !online ? t("Bot 当前离线。连接恢复后再调整模型和思考强度。") : `${bot.model || t("引擎默认模型")} · ${(bot.engine === "pi" ? t("修改 Pi Bot 默认模型，后续任务生效；/model 可单独调整当前对话") : t("修改此 Bot 的模型，影响它的所有对话"))}`} disabled={!owner || compact && !online} onClick={() => setOpen(true)}>{compact && <Cpu size={13} aria-hidden="true"/>}<span>{bot.model || t("引擎默认模型")}</span><ChevronDown size={12} aria-hidden="true"/></button>
    {open && owner && <ModelDialog connection={connection} bot={bot} online={online} close={() => setOpen(false)} returnFocus={trigger}/>}
  </>;
}
function ModelDialog({ connection, bot, online, close, returnFocus }: { connection: HubConnection; bot: Bot; online: boolean; close: () => void; returnFocus: React.RefObject<HTMLButtonElement | null> }) {
  const { data, busy, saving, error, saved, load, save } = useBotSettingsRequest(connection, bot.id, "model", modelSettingsSchema, bot.engine === "deepseek");
  const [draft, setDraft] = useState(""), [custom, setCustom] = useState(false), [effort, setEffort] = useState<ModelSettings["effort"]>(""), [adjusted, setAdjusted] = useState(false);
  const previousRead = useRef<{ connection: HubConnection; botId: string; data: ModelSettings }>(undefined);
  // What the last save sent: a refusal is explained for that, not for what the form shows now.
  const attempt = useRef<{ model: string; effort: ModelSettings["effort"] }>(undefined);
  useEffect(() => {
    if (!data) return;
    const previous = previousRead.current; previousRead.current = { connection, botId: bot.id, data };
    // Refresh discovers capabilities; it must not discard a typed replacement.
    // A confirmed save or a different Bot still adopts the authoritative value.
    if (data.engine === "deepseek" && !saved && previous?.connection === connection && previous.botId === bot.id
      && (custom || draft !== previous.data.model || effort !== previous.data.effort)) return;
    setDraft(data.model); setEffort(data.effort); setCustom(false); setAdjusted(false);
  }, [data]);
  const models = modelOptions(data?.engine ?? "", data?.choices ?? []), selectedModel = selectedModelOption(models, draft);
  const displayedEffort = selectedModelEffort(selectedModel, { model: draft, effort });
  const levels = selectedModel?.efforts ?? data?.customEfforts ?? [""];
  function changeModel(model: string) {
    const next = selectModel(models, model, { model: draft, effort }, data?.customEfforts);
    setDraft(next.model); setEffort(next.effort); setAdjusted(next.effort !== displayedEffort);
  }
  const catalogBlocked = deepSeekCatalogBlocked(data?.engine ?? bot.engine, data?.catalogStatus);
  const defaultUnavailable = deepSeekDefaultUnavailable(data?.engine, data?.catalogStatus, data?.choices);
  const writeBlocked = busy || !online || catalogBlocked || (data?.engine === "deepseek" && error !== undefined);
  const valid = !(defaultUnavailable && !custom && !draft) && modelValueSchema.safeParse(draft).success && (data?.engine === "pi" || data?.engine === "omp" ? !draft || !!decodePiModel(draft) : draft.length <= (data?.engine === "deepseek" ? 512 : 128))
    && (!custom || !!draft.trim()) && levels.includes(displayedEffort);
  return <CreationDialog mobilePage title={t("模型设置")} closeLabel={t("关闭模型设置")} close={close} busy={saving} returnFocus={returnFocus}>
    <div className="effort-settings" data-engine={data?.engine}>
      <p className="effort-scope"><strong>{bot.name}</strong><span>{bot.engine === "pi" ? t("修改 Bot 默认会用于后续任务；/model 只调整当前对话") : t("此 Bot 的所有对话、群聊和话题共用")}</span></p>
      {data && <form onSubmit={event => { event.preventDefault(); if (!writeBlocked && valid) { attempt.current = { model: draft, effort }; void save({ revision: data.revision, model: draft, effort }); } }}>
        <p className="muted">{t("引擎")} · {data.engine}</p>
        {(data.engine === "pi" || data.engine === "omp") && !custom ? <PiModelSelect engine={data.engine} models={models} value={draft} disabled={busy || !online} change={changeModel}/> : <label>{t("选择模型")}<select aria-label={t("选择模型")} disabled={busy || !online} value={custom ? "__custom__" : selectedModel?.id ?? draft} onChange={event => {
          const value = event.target.value; setCustom(value === "__custom__"); changeModel(value === "__custom__" ? "" : value);
        }}>
          {!custom && !selectedModel && <option value={draft} disabled>{draft || t("引擎默认模型")}</option>}
          {models.map(choice => <option key={choice.id} value={choice.id} disabled={defaultUnavailable && !choice.id}>{defaultUnavailable && !choice.id ? t("引擎默认模型（未设置）") : modelOptionLabel(choice, t("引擎默认模型"))}</option>)}
          <option value="__custom__">{t("自定义模型…")}</option>
        </select></label>}
        {(data.engine === "pi" || data.engine === "omp") && <><PiModelCatalogNotice engine={data.engine} status={data.catalogStatus}/><button type="button" disabled={busy || !online} onClick={() => { setCustom(!custom); }}>{custom ? t("从列表选择模型") : t("自定义模型…")}</button></>}
        {data.engine === "deepseek" && <DeepSeekModelCatalogNotice status={data.catalogStatus} defaultUnavailable={defaultUnavailable}/>}
        {custom && <label>{t("模型 ID")}<input aria-label={t("模型 ID")} value={draft} maxLength={data.engine === "pi" || data.engine === "omp" || data.engine === "deepseek" ? 512 : 128} disabled={busy || !online} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={event => {
          const value = event.target.value; setDraft(value);
          const choices = data.choices.find(choice => choice.id === value)?.efforts ?? data.customEfforts;
          if (!choices.includes(effort)) { setEffort(""); setAdjusted(true); }
        }}/></label>}
        {custom && <p className="muted">{data.engine === "pi" || data.engine === "omp" ? t("填写完整的 provider/model；同名模型在不同提供商下是不同选项。") : t("填写该引擎支持的模型 ID；实际可用性由主机上的账号和引擎确认。")}</p>}
        <label>{t("思考强度")}<select aria-label={t("模型思考强度")} disabled={busy || !online} value={displayedEffort} onChange={event => { const next = selectModelEffort(selectedModel, draft, event.target.value as ModelSettings["effort"]); if (next) { setDraft(next.model); setEffort(next.effort); setAdjusted(false); } }}>
          {!levels.includes(displayedEffort) && <option value={displayedEffort} disabled>{displayedEffort} · {catalogBlocked ? t("当前值，未确认兼容") : t("当前模型不支持")}</option>}
          {levels.map(value => <option key={value} value={value}>{data.engine === "deepseek" && value === "off" ? t("关闭推理（off）") : value || t("跟随默认（不强制指定）")}</option>)}
        </select></label>
        {adjusted && <p className="dashboard-notice">{selectedModel?.variants ? t("已调整为此模型支持的思考强度，请确认。") : t("新模型不支持原思考强度，已选为跟随默认。你也可以选择其他可用档位。")}</p>}
        <p className="muted">{t("后续任务读取新设置；当前任务不打断，后台任务繁忙时可能延后应用。不会新建会话或清空上下文。")}</p>
        {data.activeTurns > 0 && <p className="dashboard-notice">{t("此 Bot 有 {0} 个执行中的任务。", data.activeTurns)}</p>}
        {saved && draft === data.model && effort === data.effort && <p role="status" className="dashboard-notice">{data.engine === "pi" ? t("已保存 Bot 默认模型，各对话将在下次任务应用。") : t("已保存为 {0}，此 Bot 的其他对话也会沿用。", data.engine === "deepseek" && selectedModel ? modelOptionLabel(selectedModel, t("引擎默认模型")) : data.model || t("引擎默认模型"))}</p>}
        {busy && !saving && <p role="status" className="muted">{t("正在读取…")}</p>}
        <div className="effort-actions"><button type="button" disabled={busy || !online} onClick={() => void load()}>{t("重新读取")}</button><button type="submit" className="primary" disabled={writeBlocked || !valid || draft === data.model && effort === data.effort}>{saving ? t("保存中…") : t("保存到此 Bot")}</button></div>
      </form>}
      {!data && <button disabled={busy || !online} onClick={() => void load()}>{busy ? t("正在读取…") : t("重新读取")}</button>}
      {!online && <p role="status">{t("连接恢复后即可操作")}</p>}
      {error !== undefined && <p role="alert" className="error-text">{modelSettingsErrorText(error, data && attempt.current ? { engine: data.engine, ...attempt.current, choices: data.choices } : undefined)}</p>}
    </div>
  </CreationDialog>;
}
