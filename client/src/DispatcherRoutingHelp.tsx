import { useRef, useState } from "react";
import { CircleHelp } from "lucide-react";
import { CreationDialog } from "./CreationDialog.js";
import { t, useLocale } from "./i18n.js";
import "./dispatch.css";

/** Native hover help, with the same explanation available by touch/keyboard. */
export function DispatcherRoutingHelp() {
  useLocale();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const explanation = t("自动选型会受幕僚长自身模型影响，可能偏向同系列，也可能选择其他系列。若需要特定系列，请在任务中明确指定，例如“用 Claude 完成”。相关引擎需已安装，并在幕僚长设置中允许使用。");
  return <>
    <button ref={trigger} type="button" className="icon-button dispatcher-routing-help" aria-label={t("幕僚长模型选择说明")} title={explanation} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><CircleHelp size={16} aria-hidden="true"/></button>
    {open && <CreationDialog title={t("幕僚长模型选择说明")} close={() => setOpen(false)} closeLabel={t("关闭说明")} returnFocus={trigger} showHost={false}>
      <p>{explanation}</p>
      <p className="muted">{t("不同模型和任务的选择可能不同；自动选型不保证选到最合适的模型，仍需核对任务结果。")}</p>
      <button type="button" className="primary full" onClick={() => setOpen(false)}>{t("知道了")}</button>
    </CreationDialog>}
  </>;
}
