import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Zap } from "lucide-react";
import { effortSettingsSchema, type EffortSettings } from "../../src/client-protocol/effort.js";
import { CreationDialog } from "./CreationDialog.js";
import type { HubConnection } from "./connection.js";
import { useBotSettingsRequest } from "./bot-settings-request.js";
import { t, useLocale } from "./i18n.js";
import { modelEffortPreset } from "./model-selection.js";

function errorText(error: unknown): string {
  switch (error instanceof Error ? error.message : "") {
    case "effort_conflict": return t("其他设备或本机已修改设置。请重新读取后再选择，避免覆盖对方的修改。");
    case "effort_incompatible": return t("当前引擎或模型不支持此档位，请重新读取可用选项。");
    case "effort_config_unreadable": return t("无法完整读取 Bot 配置，请先检查主机上的配置文件。");
    case "effort_engine_changed": return t("Bot 引擎已更改，请待主机完成重启后再调整。");
    case "bot_offline": return t("Bot 当前离线。连接恢复后再调整思考强度。");
    default: return t("未能确认设置结果，请重新读取后核对。不会自动重试保存。");
  }
}
type Bot = { id: string; name: string; engine: string; model: string; effort: string };
export function EffortControl({ connection, bots, summary, online, owner, compact = false }: { connection: HubConnection; bots: Bot[]; summary: ReactNode; online: boolean; owner: boolean; compact?: boolean }) {
  useLocale(); const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!owner || !bots.length) setOpen(false); }, [owner, bots.length]);
  return <><button ref={trigger} type="button" className={compact ? "composer-effort-trigger" : "header-effort"} aria-label={compact ? t("思考强度：{0}", typeof summary === "string" ? summary : bots[0]?.effort || t("跟随默认")) : t("调整 Bot 思考强度")} aria-haspopup="dialog" aria-expanded={open} title={!owner ? t("仅拥有者可修改 Bot 设置") : compact && !online ? t("Bot 当前离线。连接恢复后再调整思考强度。") : t("修改此 Bot 的思考强度，影响它的所有对话")} disabled={!owner || !bots.length || compact && !online} onClick={() => setOpen(true)}>{compact && <Zap size={13} aria-hidden="true"/>}<span>{summary}</span><ChevronDown size={12} aria-hidden="true"/></button>
    {open && owner && bots.length > 0 && <EffortDialog connection={connection} bots={bots} online={online} close={() => setOpen(false)} returnFocus={trigger}/>}
  </>;
}
function EffortDialog({ connection, bots, online, close, returnFocus }: { connection: HubConnection; bots: Bot[]; online: boolean; close: () => void; returnFocus: React.RefObject<HTMLButtonElement | null> }) {
  const [selection, setBotId] = useState(bots[0]!.id), [draft, setDraft] = useState<EffortSettings["effort"]>("");
  const bot = bots.find((item) => item.id === selection) ?? bots[0]!, botId = bot.id;
  const { data, busy, saving, error, saved, load, save } = useBotSettingsRequest(connection, botId, "effort", effortSettingsSchema);
  const preset = data && modelEffortPreset(data.engine, data.model, data.choices);
  useEffect(() => { if (data) setDraft(data.effort); }, [data]);
  return <CreationDialog mobilePage title={t("思考强度")} closeLabel={t("关闭思考强度")} close={close} busy={saving} returnFocus={returnFocus}>
    <div className="effort-settings">
      {bots.length > 1 && <label>{t("选择要调整的 Bot")}<select aria-label={t("选择要调整的 Bot")} value={botId} disabled={busy} onChange={(event) => setBotId(event.target.value)}>{bots.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      <p className="effort-scope"><strong>{bot?.name}</strong><span>{t("此 Bot 的所有对话、群聊和话题共用")}</span></p>
      {data && <form onSubmit={(event) => {
        event.preventDefault(); if (busy || !online) return;
        void save({ revision: data.revision, effort: draft });
      }}>
        <p className="muted">{data.engine}{data.model ? ` · ${preset?.model ?? data.model}` : ` · ${t("引擎默认模型")}`}</p>
        <label>{t("Effort 档位")}<select aria-label={t("Effort 档位")} disabled={busy || !online} value={draft} onChange={(event) => setDraft(event.target.value as EffortSettings["effort"])}>
          {!data.choices.includes(data.effort) && <option value={data.effort} disabled>{data.effort} · {data.engine === "antigravity" ? t("当前值，未确认兼容") : t("当前模型不支持")}</option>}
          {data.choices.map((value) => <option key={value} value={value}>{value || (preset ? t("沿用模型预设（{0}）", preset.effort) : t("跟随默认（不强制指定）"))}</option>)}
        </select></label>
        {data.engine === "antigravity" && data.choices.length === 1 && <p className="muted">{t("尚未确认此模型的可用档位。可先跟随默认；选择具体模型或稍后重新读取。")}</p>}
        <p className="muted">{t("各家档位不同，同名档位也不代表相同强度。跟随默认不等于关闭思考。")}</p>
        <p className="muted">{t("后续任务读取新设置；当前任务不打断，后台任务繁忙时可能延后应用。不会新建会话或清空上下文。")}</p>
        {data.activeTurns > 0 && <p className="dashboard-notice">{t("此 Bot 有 {0} 个执行中的任务。", data.activeTurns)}</p>}
        {saved && draft === data.effort && <p role="status" className="dashboard-notice">{t("已保存为 {0}，此 Bot 的其他对话也会沿用。", data.effort || t("跟随默认"))}</p>}
        <div className="effort-actions"><button type="button" disabled={busy || !online} onClick={() => void load()}>{t("重新读取")}</button><button type="submit" className="primary" disabled={busy || !online || draft === data.effort || !data.choices.includes(draft)}>{busy ? t("保存中…") : t("保存到此 Bot")}</button></div>
      </form>}
      {!data && <button disabled={busy || !online} onClick={() => void load()}>{busy ? t("正在读取…") : t("重新读取")}</button>}
      {!online && <p role="status">{t("连接恢复后即可操作")}</p>}
      {error !== undefined && <p role="alert" className="error-text">{errorText(error)}</p>}
    </div>
  </CreationDialog>;
}
