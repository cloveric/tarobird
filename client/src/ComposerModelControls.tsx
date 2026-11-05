import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Check, ChevronDown, Cpu, LoaderCircle, Zap } from "lucide-react";
import { modelSettingsSchema, type ModelSettings } from "../../src/client-protocol/model.js";
import type { Bot, HubConnection } from "./connection.js";
import { DesktopMenu, DesktopMenuPortalContext } from "./DesktopMenu.js";
import { useBotSettingsRequest } from "./bot-settings-request.js";
import { modelSettingsErrorText } from "./ModelControl.js";
import { modelOptionLabel, modelOptions, selectedModelOption, selectedModelEffort, selectModel, selectModelEffort } from "./model-selection.js";
import { t, useLocale } from "./i18n.js";
import "./composer-model-controls.css";

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
  const title = !owner ? t("仅拥有者可修改 Bot 设置") : !online ? t("Bot 当前离线。连接恢复后再调整模型和思考强度。") : t("此 Bot 的所有对话、群聊和话题共用");
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
  const selected = data && selectedModelOption(options, data.model);
  const effort = data ? selectedModelEffort(selected, data) : "";
  const levels = selected?.efforts ?? data?.customEfforts ?? [];
  // An uncertain write must be read back before another choice can be submitted.
  const disabled = busy || !online || error !== undefined;
  function choose(next: { model: string; effort: ModelSettings["effort"] } | undefined) {
    if (!data || disabled || !next) return;
    if (next.model === data.model && next.effort === data.effort) { trigger.current?.focus({ preventScroll: true }); close(); return; }
    void save({ revision: data.revision, ...next });
  }
  return <DesktopMenuPortalContext.Provider value={true}>
    <DesktopMenu id={id} label={picker === "model" ? t("快捷选择模型") : t("快捷选择思考强度")} open close={() => { if (!saving) close(); }} trigger={trigger} placement="up-end" className="composer-settings-menu">
      <p className="desktop-menu-heading"><span>{picker === "model" ? t("选择模型") : (selected ? modelOptionLabel(selected, t("引擎默认模型")) : data?.model || bot.model || t("引擎默认模型"))}</span><span className="desktop-menu-value">{data?.engine ?? bot.engine}</span></p>
      {data && picker === "model" && options.map(option => {
        const next = selectModel(options, option.id, data, data.customEfforts);
        return <button key={option.id} type="button" data-menu-keep="" aria-pressed={selected?.id === option.id} disabled={disabled} onClick={() => choose(selected?.id === option.id ? { model: data.model, effort: data.effort } : next)}><span className="quick-setting-check">{selected?.id === option.id && <Check size={14}/>}</span><span className="desktop-menu-label">{modelOptionLabel(option, t("引擎默认模型"))}</span><span className="desktop-menu-value">{next.effort || t("跟随默认")}</span></button>;
      })}
      {data && picker === "effort" && levels.map(level => <button key={level} type="button" data-menu-keep="" aria-pressed={effort === level} disabled={disabled} onClick={() => choose(level === effort ? { model: data.model, effort: data.effort } : selectModelEffort(selected, data.model, level))}><span className="quick-setting-check">{effort === level && <Check size={14}/>}</span><span className="desktop-menu-label">{level || t("跟随默认")}</span></button>)}
      {busy && <p className="desktop-menu-note" role="status"><LoaderCircle size={14} className="spin"/>{saving ? t("保存中…") : t("正在读取…")}</p>}
      {error !== undefined && <><p className="quick-setting-error" role="alert">{modelSettingsErrorText(error)}</p><button type="button" data-menu-keep="" disabled={busy || !online} onClick={() => void load()}>{t("重新读取")}</button></>}
      {!online && <p className="desktop-menu-note" role="status">{t("连接恢复后即可操作")}</p>}
      <p className="quick-setting-scope">{t("{0} · 所有对话共用，下次任务生效", bot.name)}</p>
    </DesktopMenu>
  </DesktopMenuPortalContext.Provider>;
}
