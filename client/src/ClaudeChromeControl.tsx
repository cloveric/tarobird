import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { chromeSettingsSchema } from "../../src/client-protocol/chrome.js";
import type { Bot, HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import { useBotSettingsRequest } from "./bot-settings-request.js";
import { HubHttpError } from "./http-error.js";
import { t, useLocale } from "./i18n.js";

function errorText(error: unknown) {
  if (error instanceof HubHttpError && error.status === 404) return t("此主机尚不支持浏览器联动设置，请更新主机版本。");
  switch (error instanceof Error ? error.message : "") {
    case "chrome_conflict": return t("其他设备或本机已修改设置。请重新读取后再选择，避免覆盖对方的修改。");
    case "chrome_config_unreadable": return t("无法完整读取 Bot 配置，请先检查主机上的配置文件。");
    case "chrome_engine_changed": return t("Bot 引擎已更改，请待主机完成重启后再调整。");
    case "chrome_unsupported": return t("此功能仅适用于 Claude Bot。");
    case "bot_offline": return t("Bot 当前离线。连接恢复后再调整浏览器联动。");
    default: return t("未能确认设置结果，请重新读取后核对。不会自动重试保存。");
  }
}
export function ClaudeChromeControl({ connection, bot, online, owner }: { connection: HubConnection; bot: Bot; online: boolean; owner: boolean }) {
  useLocale();
  const [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!owner) setOpen(false); }, [owner]);
  return <><button ref={trigger} className="header-effort" aria-label={t("设置 Chrome 浏览器联动")} disabled={!owner} onClick={() => setOpen(true)}>{t("设置")}<ChevronDown size={12}/></button>
    {open && owner && <ChromeDialog connection={connection} bot={bot} online={online} close={() => setOpen(false)} returnFocus={trigger}/>}
  </>;
}
function ChromeDialog({ connection, bot, online, close, returnFocus }: { connection: HubConnection; bot: Bot; online: boolean; close: () => void; returnFocus: React.RefObject<HTMLButtonElement | null> }) {
  const { data, busy, saving, error, saved, load, save } = useBotSettingsRequest(connection, bot.id, "chrome", chromeSettingsSchema);
  const [enabled, setEnabled] = useState(false);
  useEffect(() => { if (data) setEnabled(data.enabled); }, [data]);
  return <CreationDialog mobilePage title={t("Chrome 浏览器联动")} closeLabel={t("关闭浏览器联动设置")} close={close} busy={saving} returnFocus={returnFocus}>
    <div className="effort-settings">
      <p className="effort-scope"><strong>{bot.name}</strong><span>{t("此 Bot 的所有对话、群聊和话题共用")}</span></p>
      <p>{t("让此 Bot 通过 Claude in Chrome 扩展使用主机上的浏览器，可读取网页并按你的要求操作。")}</p>
      <p className="muted">{t("需在主机安装扩展，并让 Claude Code 与扩展登录同一 Claude 账号及组织。API Key 登录不支持此联动。")}</p>
      {data && <form onSubmit={event => { event.preventDefault(); if (!busy && online) void save({ revision: data.revision, enabled }); }}>
        <label className="chrome-toggle"><span>{t("允许此 Bot 使用 Chrome")}</span><input type="checkbox" role="switch" aria-label={t("允许此 Bot 使用 Chrome")} checked={enabled} disabled={busy || !online} onChange={event => setEnabled(event.target.checked)}/></label>
        <p className="muted">{t("当前任务不会中断。后续任务应用新设置并保留会话；仍有后台任务时，需等它们结束。")}</p>
        <p className="muted">{t("此开关控制 Bot 的联动权限，不代表扩展已连接。网站访问仍遵循 Claude 与扩展的权限设置。")}</p>
        {data.activeTurns > 0 && <p className="dashboard-notice">{t("此 Bot 有 {0} 个执行中的任务。", data.activeTurns)}</p>}
        {saved && enabled === data.enabled && <p role="status" className="dashboard-notice">{t("已保存，后续任务将应用浏览器联动设置。")}</p>}
        <div className="effort-actions"><button type="button" disabled={busy || !online} onClick={() => void load()}>{t("重新读取")}</button><button type="submit" className="primary" disabled={busy || !online || enabled === data.enabled}>{saving ? t("保存中…") : t("保存到此 Bot")}</button></div>
      </form>}
      {!data && <button disabled={busy || !online} onClick={() => void load()}>{busy ? t("正在读取…") : t("重新读取")}</button>}
      {!online && <p role="status">{t("连接恢复后即可操作")}</p>}
      {error !== undefined && <p role="alert" className="error-text">{errorText(error)}</p>}
    </div>
  </CreationDialog>;
}
