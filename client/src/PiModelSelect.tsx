import { decodePiModel } from "../../src/codex/pi-models.js";
import { modelOptionLabel, type ModelOption } from "./model-selection.js";
import { t } from "./i18n.js";
import "./pi-model-select.css";

/** Pi and omp identify models natively as provider + model, not one globally unique model ID. */
export function PiModelSelect({ models, value, disabled, change, engine = "pi", defaultLabel, searching = false }: {
  models: readonly ModelOption[]; value: string; disabled?: boolean; change: (value: string) => void; engine?: "pi" | "omp"; defaultLabel?: string; searching?: boolean;
}) {
  const effectiveDefaultLabel = defaultLabel ?? (engine === "omp" ? t("跟随 omp 默认") : t("跟随 Pi 默认"));
  if (searching) {
    if (!models.length) return <div className="pi-model-fields"><p className="muted" role="status">{t("没有匹配的模型")}</p></div>;
    return <div className="pi-model-fields">
      <label>{t("模型")}<select aria-label={t("模型")} value={value} disabled={disabled} onChange={event => change(event.target.value)}>
        {!models.some(model => model.id === value) && <option value={value} disabled>{t("选择模型")}</option>}
        {models.map(model => <option key={model.id} value={model.id}>{model.id ? model.label || (model.provider ? `${model.modelId || model.id} · ${model.provider}` : model.id) : modelOptionLabel(model, effectiveDefaultLabel)}</option>)}
      </select></label>
    </div>;
  }
  const selected = models.find(model => model.id === value);
  const provider = selected?.provider ?? decodePiModel(value)?.provider ?? "";
  const providers = [...new Set(models.flatMap(model => model.provider ? [model.provider] : []))];
  if (provider && !providers.includes(provider)) providers.push(provider);
  const choices = provider ? models.filter(model => model.provider === provider) : models.filter(model => !model.id);
  return <div className="pi-model-fields">
    <label>{t("模型提供商")}<select aria-label={t("模型提供商")} value={provider} disabled={disabled} onChange={event => {
      const next = event.target.value;
      change(next ? models.find(model => model.provider === next)?.id ?? value : "");
    }}><option value="">{effectiveDefaultLabel}</option>{providers.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
    <label>{t("模型")}<select aria-label={t("模型")} value={value} disabled={disabled || !provider} onChange={event => change(event.target.value)}>
      {!choices.some(model => model.id === value) && <option value={value}>{value ? (selected?.label || decodePiModel(value)?.modelId || value) : effectiveDefaultLabel}</option>}
      {choices.map(model => <option key={model.id} value={model.id}>{model.id ? (model.label?.endsWith(` · ${model.provider}`) ? model.label.slice(0, -(` · ${model.provider}`).length) : model.label) || model.modelId || model.id : modelOptionLabel(model, effectiveDefaultLabel)}</option>)}
    </select></label>
  </div>;
}

export function PiModelCatalogNotice({ status, engine = "pi" }: { status: "ready" | "no-models" | "unavailable" | undefined; engine?: "pi" | "omp" }) {
  if (status === "ready") return null;
  if (engine === "omp") {
    return <p className="dashboard-notice" role="status">{status === "no-models"
      ? t("omp 已安装，但未提供可用模型。请在主机上运行 omp 并执行 /login 完成登录，或配置本地模型，然后重新读取。")
      : t("暂未读取到 omp 模型列表。请检查主机上的 omp 配置，然后重新读取；已保存的选择不会被清除。")}</p>;
  }
  return <p className="dashboard-notice" role="status">{status === "no-models"
    ? t("Pi 已安装，但未提供可用模型。请在主机上运行 pi auth login 完成登录，或配置本地模型，然后重新读取。")
    : t("暂未读取到 Pi 模型列表。请检查主机上的 Pi 配置，然后重新读取；已保存的选择不会被清除。")}</p>;
}
