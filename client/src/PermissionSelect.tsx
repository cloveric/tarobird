import type { PermissionChoice, PermissionOption } from "../../src/state/permission-options.js";
import { t } from "./i18n.js";

export function PermissionSelect({ value, choices, defaultChoice, disabled, change }: {
  value: PermissionChoice; choices: PermissionOption[]; defaultChoice: PermissionChoice; disabled?: boolean; change: (value: PermissionChoice) => void;
}) {
  const selected = choices.find(option => option.id === value);
  return <div className="permission-select">
    <label>{t("权限与批准")}<select aria-label={t("权限与批准")} value={value} disabled={disabled} onChange={event => change(event.target.value as PermissionChoice)}>
      {choices.map(option => <option key={option.id} value={option.id}>{t(option.label)}{option.id === defaultChoice ? ` · ${t("默认")}` : ""}</option>)}
    </select></label>
    <p className="muted" role="note">{selected && t(selected.description)}</p>
    <p className="muted">{t("默认：{0}。可按需选择更严格的审批方式。", t(choices.find(option => option.id === defaultChoice)?.label ?? ""))}</p>
  </div>;
}
