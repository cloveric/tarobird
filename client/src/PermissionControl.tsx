import { ExplanationList } from "./ExplanationList.js";
import { PermissionSelect } from "./PermissionSelect.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { permissionSettingsSchema, type PermissionSettings } from "../../src/client-protocol/permissions.js";
import { CreationDialog } from "./CreationDialog.js";
import type { HubConnection } from "./connection.js";
import { useBotSettingsRequest } from "./bot-settings-request.js";
import { t, useLocale } from "./i18n.js";

function errorText(error: unknown): string {
  switch (error instanceof Error ? error.message : "") {
    case "permissions_conflict": return t("其他设备或本机已修改设置。请重新读取后再选择，避免覆盖对方的修改。");
    case "permissions_incompatible": return t("当前引擎不支持此权限模式，请重新读取可用选项。");
    case "permissions_config_unreadable": return t("无法完整读取 Bot 配置，请先检查主机上的配置文件。");
    case "permissions_engine_changed": return t("Bot 引擎已更改，请待主机完成重启后再调整。");
    case "permissions_busy": return t("此 Bot 仍有任务在执行或等待批准。请先完成或停止任务，再重新读取权限设置。");
    case "bot_offline": return t("Bot 当前离线。连接恢复后再调整权限。");
    default: return t("未能确认设置结果，请重新读取后核对。不会自动重试保存。");
  }
}
type Bot = { id: string; name: string; engine: string; model: string; effort: string };
export function PermissionControl({ connection, bots, summary, online, owner }: { connection: HubConnection; bots: Bot[]; summary?: ReactNode; online: boolean; owner: boolean }) {
  useLocale(); const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!owner || !bots.length) setOpen(false); }, [owner, bots.length]);
  return <><button ref={trigger} className="header-effort" aria-label={t("调整 Bot 权限")} title={owner ? t("修改此 Bot 的权限，影响它的所有对话") : t("仅拥有者可修改 Bot 设置")} disabled={!owner || !bots.length} onClick={() => setOpen(true)}><span>{summary ?? t("查看与调整")}</span><ChevronDown size={12}/></button>
    {open && owner && bots.length > 0 && <PermissionDialog connection={connection} bots={bots} online={online} close={() => setOpen(false)} returnFocus={trigger}/>}
  </>;
}
function PermissionDialog({ connection, bots, online, close, returnFocus }: { connection: HubConnection; bots: Bot[]; online: boolean; close: () => void; returnFocus: React.RefObject<HTMLButtonElement | null> }) {
  const [selection, setBotId] = useState(bots[0]!.id), [draft, setDraft] = useState<PermissionSettings["choice"]>("bypass");
  const bot = bots.find((item) => item.id === selection) ?? bots[0]!, botId = bot.id;
  const { data, busy, saving, error, saved, load, save } = useBotSettingsRequest(connection, botId, "permissions", permissionSettingsSchema);
  useEffect(() => { if (data) setDraft(data.choice); }, [data]);
  return <CreationDialog mobilePage title={t("权限与批准")} closeLabel={t("关闭权限设置")} close={close} busy={saving} returnFocus={returnFocus}>
    <div className="effort-settings">
      {bots.length > 1 && <label>{t("选择要调整的 Bot")}<select aria-label={t("选择要调整的 Bot")} value={botId} disabled={busy} onChange={(event) => setBotId(event.target.value)}>{bots.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      <p className="effort-scope"><strong>{bot?.name}</strong><span>{t("此 Bot 的所有对话、群聊和话题共用")}</span></p>
      {data && <form onSubmit={(event) => {
        event.preventDefault(); if (busy || !online) return;
        void save({ revision: data.revision, choice: draft });
      }}>
        <p className="muted">{data.engine}</p>
        <PermissionSelect value={draft} choices={data.choices} defaultChoice={data.defaultChoice} disabled={busy || !online || data.activeTurns > 0} change={setDraft}/>
        <ExplanationList items={[
          { label: t("生效时间"), description: t("当前任务完成或停止后，用于后续任务。上下文保留。") },
          { label: t("批准操作"), description: t("在对话中批准或拒绝，支持范围取决于引擎。") },
        ]}/>
        {data.activeTurns > 0 && <p className="dashboard-notice">{t("此 Bot 有 {0} 个执行中的任务。", data.activeTurns)}</p>}
        {saved && draft === data.choice && <p role="status" className="dashboard-notice">{t("已保存为 {0}，此 Bot 的其他对话也会沿用。", t(data.choices.find(option => option.id === data.choice)?.label ?? data.choice))}</p>}
        <div className="effort-actions"><button type="button" disabled={busy || !online} onClick={() => void load()}>{t("重新读取")}</button><button type="submit" className="primary" disabled={busy || !online || data.activeTurns > 0 || draft === data.choice || !data.choices.some(option => option.id === draft)}>{busy ? t("保存中…") : t("保存到此 Bot")}</button></div>
      </form>}
      {!data && <button disabled={busy || !online} onClick={() => void load()}>{busy ? t("正在读取…") : t("重新读取")}</button>}
      {!online && <p role="status">{t("连接恢复后即可操作")}</p>}
      {error !== undefined && <p role="alert" className="error-text">{errorText(error)}</p>}
    </div>
  </CreationDialog>;
}
