import { useId } from "react";
import { layoutDensities, type LayoutDensity } from "./layout-density.js";
import { t } from "./i18n.js";
import "./layout-density-picker.css";

export function LayoutDensityPicker({ value, onChange }: { value: LayoutDensity; onChange: (value: LayoutDensity) => void }) {
  const hintId = useId();
  const labels = { compact: t("紧凑"), standard: t("标准"), comfortable: t("宽松") };
  return <fieldset className="density-picker" aria-describedby={hintId}>
    <legend>{t("界面密度")}</legend>
    <p id={hintId} className="settings-note muted">{t("调整列表、头像和间距，仅影响这台设备。聊天字号单独设置。")}</p>
    <div className="density-options">
      {layoutDensities.map(density => <label key={density}>
        <input type="radio" name="layout-density" value={density} checked={value === density} onChange={() => onChange(density)}/>
        <span>{labels[density]}</span>
      </label>)}
    </div>
    <div className="density-preview" data-density={value} aria-hidden="true">
      {[t("项目讨论"), t("旅行计划")].map(title => <div className="density-preview-row" key={title}>
        <span className="density-preview-avatar"/>
        <span><strong>{title}</strong><small>{t("最近的消息会显示在这里")}</small></span>
      </div>)}
    </div>
  </fieldset>;
}
