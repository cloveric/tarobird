import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Check, ChevronDown, Cpu, LoaderCircle, Zap } from "lucide-react";
import { deepSeekDefaultUnavailable, modelSettingsSchema, type ModelSettings } from "../../src/client-protocol/model.js";
import type { Bot, HubConnection } from "./connection.js";
import { DesktopMenu, DesktopMenuPortalContext } from "./DesktopMenu.js";
import { useBotSettingsRequest } from "./bot-settings-request.js";
import { modelSettingsErrorText } from "./ModelControl.js";
import { modelOptionLabel, modelOptions, selectedModelOption, selectedModelEffort, selectModel, selectModelEffort } from "./model-selection.js";
import { t, useLocale } from "./i18n.js";
import "./composer-model-controls.css";
import { PiModelCatalogNotice } from "./PiModelSelect.js";
import { DeepSeekModelCatalogNotice, deepSeekCatalogBlocked } from "./DeepSeekModelCatalog.js";

type Picker = "model" | "effort";

/** Quick choices share the model API so the model and compatible effort are
 * always committed together. No request is made until a picker opens. */
export function ComposerModelControls({ connection, bot, online, owner }: {
  connection: HubConnection; bot: Bot; online: boolean; owner: boolean;
}) {
  useLocale();
  const [picker, setPicker] = useState<Picker>(), [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const modelTrigger = useRef<HTMLButtonElement>(null), effortTrigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  useEffect(() => { if (!owner) setPicker(undefined); }, [owner]);
  useLayoutEffect(() => {
    if (!picker && !saving && restoreFocus.current) { restoreFocus.current.focus({ preventScroll: true }); restoreFocus.current = null; }
  }, [picker, saving]);
  const title = !owner ? t("仅拥有者可修改 Bot 设置") : !online ? t("Bot 当前离线。连接恢复后再调整模型和思考强度。") : bot.engine === "pi" ? t("修改 Bot 默认会用于后续任务；/model 只调整当前对话") : t("此 Bot 的所有对话、群聊和话题共用");
  function open(next: Picker) { if (saving) return; setNotice(""); setPicker(previous => previous === next ? undefined : next); }
  return <div className="composer-model-controls" role="group" aria-label={t("Bot 设置")}>
    <button ref={modelTrigger} type="button" className="composer-model-trigger" aria-label={t("模型设置：{0}", bot.model || t("引擎默认模型"))} aria-controls={picker === "model" ? id : undefined} aria-expanded={picker === "model"} title={title} disabled={!owner || !online || saving} onClick={() => open("model")}><Cpu size={13} aria-hidden="true"/><span>{bot.model || t("引擎默认模型")}</span><ChevronDown size={12} aria-hidden="true"/></button>
    <button ref={effortTrigger} type="button" className="composer-effort-trigger" aria-label={t("思考强度：{0}", bot.effort || t("跟随默认"))} aria-controls={picker === "effort" ? id : undefined} aria-expanded={picker === "effort"} title={title} disabled={!owner || !online || saving} onClick={() => open("effort")}><Zap size={13} aria-hidden="true"/><span>{bot.effort || t("跟随默认")}</span><ChevronDown size={12} aria-hidden="true"/></button>
    <span className="screen-reader-only" role="status">{notice}</span>
    {picker && owner && <ComposerModelMenu key={picker} id={id} picker={picker} connection={connection} bot={bot} online={online} trigger={picker === "model" ? modelTrigger : effortTrigger} close={() => setPicker(undefined)} onSaving={setSaving} saved={data => { restoreFocus.current = (picker === "model" ? modelTrigger : effortTrigger).current; setNotice(t("已切换为 {0} · {1}", data.model || t("引擎默认模型"), data.effort || t("跟随默认"))); }}/>}
  </div>;
}

function ComposerModelMenu({ id, picker, connection, bot, online, trigger, close, onSaving, saved: announce }: {
  id: string; picker: Picker; connection: HubConnection; bot: Bot; online: boolean;
  trigger: RefObject<HTMLButtonElement | null>; close: () => void; onSaving: (value: boolean) => void; saved: (data: ModelSettings) => void;
}) {
  const { data, busy, saving, error, saved, load, save } = useBotSettingsRequest(connection, bot.id, "model", modelSettingsSchema);
  const [search, setSearch] = useState("");
  // The last choice submitted, so a refusal can name what was refused.
  const attempt = useRef<{ model: string; effort: ModelSettings["effort"] }>(undefined);
  useEffect(() => { onSaving(saving); return () => onSaving(false); }, [saving, onSaving]);
  // Keep callbacks fresh without making a successful response run twice.
  const callbacks = useRef({ close, announce }); callbacks.current = { close, announce };
  useEffect(() => {
    if (!saved || !data) return;
    callbacks.current.announce(data); callbacks.current.close();
  }, [saved, data, trigger]);
  useEffect(() => {
    if (!data || busy || saved || error !== undefined) return;
    const panel = document.getElementById(id);
    (panel?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]') ?? panel?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus({ preventScroll: true });
  }, [data, busy, saved, error, id]);
  const options = modelOptions(data?.engine ?? bot.engine, data?.choices ?? []);
  const shownOptions = (data?.engine === "pi" || data?.engine === "omp") && search.trim()
    ? options.filter(option => `${option.label ?? ""} ${option.id} ${option.provider ?? ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) : options;
  const selected = data && selectedModelOption(options, data.model);
  const effort = data ? selectedModelEffort(selected, data) : "";
  const levels = selected?.efforts ?? data?.customEfforts ?? [];
  // An uncertain write must be read back before another choice can be submitted.
  const disabled = busy || !online || error !== undefined || deepSeekCatalogBlocked(data?.engine ?? bot.engine, data?.catalogStatus);
  // The Host refuses "follow default" (and effort changes while following it) when DSH has no usable default.
  const defaultUnavailable = deepSeekDefaultUnavailable(data?.engine, data?.catalogStatus, data?.choices);
  function choose(next: { model: string; effort: ModelSettings["effort"] } | undefined) {
    if (!data || disabled || !next) return;
    if (next.model === data.model && next.effort === data.effort) { trigger.current?.focus({ preventScroll: true }); close(); return; }
    attempt.current = next;
    void save({ revision: data.revision, ...next });
  }
  return <DesktopMenuPortalContext.Provider value={true}>
    <DesktopMenu id={id} label={picker === "model" ? t("快捷选择模型") : t("快捷选择思考强度")} open close={() => { if (!saving) close(); }} trigger={trigger} placement="up-end" className="composer-settings-menu">
      <p className="desktop-menu-heading"><span>{picker === "model" ? t("选择模型") : (selected ? modelOptionLabel(selected, t("引擎默认模型")) : data?.model || bot.model || t("引擎默认模型"))}</span><span className="desktop-menu-value">{data?.engine ?? bot.engine}</span></p>
      {(data?.engine === "pi" || data?.engine === "omp") && picker === "model" && <><input className="pi-model-search" type="search" aria-label={t("搜索提供商或模型")} placeholder={t("搜索提供商或模型")} value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation(); }}/><PiModelCatalogNotice engine={data.engine} status={data.catalogStatus}/></>}
      {data?.engine === "deepseek" && <DeepSeekModelCatalogNotice status={data.catalogStatus} defaultUnavailable={defaultUnavailable}/>}
      {data && picker === "model" && shownOptions.map(option => {
        const next = selectModel(options, option.id, data, data.customEfforts);
        return <button key={option.id} type="button" data-menu-keep="" aria-pressed={selected?.id === option.id} disabled={disabled || defaultUnavailable && !option.id} onClick={() => choose(selected?.id === option.id ? { model: data.model, effort: data.effort } : next)}><span className="quick-setting-check">{selected?.id === option.id && <Check size={14}/>}</span><span className="desktop-menu-label">{defaultUnavailable && !option.id ? t("引擎默认模型（未设置）") : modelOptionLabel(option, t("引擎默认模型"))}</span><span className="desktop-menu-value">{data.engine === "deepseek" && next.effort === "off" ? t("关闭推理（off）") : next.effort || t("跟随默认")}</span></button>;
      })}
      {data && picker === "model" && !shownOptions.length && <p className="desktop-menu-note" role="status">{t("没有匹配的模型")}</p>}
      {data && picker === "effort" && levels.map(level => <button key={level} type="button" data-menu-keep="" aria-pressed={effort === level} disabled={disabled || defaultUnavailable && selected?.id === ""} onClick={() => choose(level === effort ? { model: data.model, effort: data.effort } : selectModelEffort(selected, data.model, level))}><span className="quick-setting-check">{effort === level && <Check size={14}/>}</span><span className="desktop-menu-label">{data.engine === "deepseek" && level === "off" ? t("关闭推理（off）") : level || t("跟随默认")}</span></button>)}
      {busy && <p className="desktop-menu-note" role="status"><LoaderCircle size={14} className="spin"/>{saving ? t("保存中…") : t("正在读取…")}</p>}
      {error !== undefined && <><p className="quick-setting-error" role="alert">{modelSettingsErrorText(error, data && attempt.current ? { engine: data.engine, ...attempt.current, choices: data.choices } : undefined)}</p><button type="button" data-menu-keep="" disabled={busy || !online} onClick={() => void load()}>{t("重新读取")}</button></>}
      {error === undefined && (data?.engine === "pi" || data?.engine === "omp" || data?.engine === "deepseek") && data.catalogStatus !== "ready" && <button type="button" data-menu-keep="" disabled={busy || !online} onClick={() => void load()}>{t("重新读取")}</button>}
      {!online && <p className="desktop-menu-note" role="status">{t("连接恢复后即可操作")}</p>}
      <p className="quick-setting-scope">{bot.engine === "pi" ? t("修改 Bot 默认会用于后续任务；/model 只调整当前对话") : t("{0} · 所有对话共用，下次任务生效", bot.name)}</p>
    </DesktopMenu>
  </DesktopMenuPortalContext.Provider>;
}
