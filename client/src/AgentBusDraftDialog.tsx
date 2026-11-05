import { useId, useRef } from "react";
import { CreationDialog } from "./CreationDialog.js";
import { t } from "./i18n.js";
import "./agent-bus-draft-dialog.css";

/** Keep draft protection compact and default keyboard activation non-destructive. */
export function AgentBusDraftDialog({ kind, close, discard }: { kind: "leave" | "reload"; close: () => void; discard: () => void }) {
  const keepEditing = useRef<HTMLButtonElement>(null);
  const descriptionId = useId(), noteId = useId();
  return <CreationDialog
    title={kind === "leave" ? t("放弃未保存的内容？") : t("重新载入配置？")}
    className="agent-bus-draft-dialog" showHost={false}
    close={close} closeLabel={t("关闭确认")} initialFocus={keepEditing}
    describedBy={`${descriptionId} ${noteId}`}
  >
    <p id={descriptionId} className="agent-bus-draft-description">{kind === "leave"
      ? t("未保存的配置和未发送的任务将丢失。")
      : t("未保存的配置（含各步骤任务）将被已保存的配置替换。")}</p>
    <p id={noteId} className="agent-bus-draft-note">{kind === "leave"
      ? t("正在运行的协作会继续。")
      : t("共同目标草稿会保留。")}</p>
    <footer className="agent-bus-draft-actions">
      <button type="button" className="agent-bus-draft-discard" onClick={discard}>{kind === "leave" ? t("放弃并离开") : t("重新载入配置")}</button>
      <button ref={keepEditing} type="button" className="primary" onClick={close}>{t("继续编辑")}</button>
    </footer>
  </CreationDialog>;
}
