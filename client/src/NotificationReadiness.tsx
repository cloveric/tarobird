import { useEffect, useRef, useState } from "react";
import { Check, Info, RefreshCw, ChevronRight } from "lucide-react";
import { nativePlatform } from "./native.js";
import { t } from "./i18n.js";
import { checkNotificationReadiness, reconnectSystemNotifications, type NotificationReadiness as Readiness } from "./notification-readiness.js";
import { PUSH_FOREGROUND_EVENT } from "./push-maintenance.js";
import type { HubConnection } from "./connection.js";
import type { NotificationState } from "./notifications.js";

function copy(result: Readiness): [string, string] {
  const browser = nativePlatform() === "web";
  switch (result.reason) {
    case "ready": return [t("接收条件已就绪"), t("权限与接收设置检查通过；实际提醒仍取决于网络、系统和勿扰设置。")];
    case "denied": return [browser ? t("浏览器已阻止通知") : t("系统通知已关闭"), browser ? t("请在浏览器的网站设置中允许此网站发送通知，然后点「重新检查」。") : t("请在系统设置中允许 TaroBird 通知，返回后检查接收状态。")];
    case "prompt": return [t("尚未允许通知"), t("关闭后重新开启消息提醒，即可申请通知权限。")];
    case "channel-disabled": return [t("消息通知类别已关闭"), t("请在 Android 的 TaroBird 通知设置中开启消息通知类别，返回后重新检查。")];
    case "channel-missing": return [t("等待首次消息提醒"), t("权限与推送已连接，Android 会在首次提醒时创建通知类别；当前还无法检查该类别。")];
    case "unconfigured": return [t("主机推送尚未配置"), t("请让主机管理员恢复当前推送方式的配置，再重新检查。消息仍会正常同步。")];
    case "apns-topic": return [t("主机无法向此 App 推送"), result.apnsTopic === "apns_topic_unsupported" ? t("请先更新主机，再重新检查。消息仍会正常同步。") : t("请让主机管理员在 APNs 配置中允许此 App 的标识，再重新检查。消息仍会正常同步。")];
    case "unbound": return [t("推送尚未连接"), t("请关闭后重新开启消息提醒，完成此设备与当前主机的推送连接。")];
    case "subscription": return [t("推送连接需要恢复"), result.provider === "unifiedpush" ? t("请在下方重新连接原来的 UnifiedPush 分发器。") : result.provider === "webpush" ? t("请关闭后重新开启消息提醒，重新连接浏览器推送。") : t("提醒开关已保留。重新连接会恢复当前推送方式，不更改勿扰时段。")];
    case "unifiedpush": return [t("分发器连接需要恢复"), t("请检查原分发器是否已安装并正常运行，然后在下方重新连接。")];
    case "browser-subscription": return [t("浏览器推送需要恢复"), t("请关闭后重新开启消息提醒，重新连接浏览器推送。")];
    case "unsupported": return [t("此环境不支持后台提醒"), t("打开 TaroBird 时，新消息仍会实时显示。")];
    default: return [t("暂时无法检查接收状态"), t("提醒开关已保留。请确认连接正常且主机和客户端均为最新版，再重新检查。")];
  }
}

export function NotificationReadiness({ connection, state, online, working, refresh, repair }: {
  connection: HubConnection; state: NotificationState; online: boolean; working: boolean;
  refresh: () => Promise<unknown>; repair: (work: () => Promise<void>) => Promise<void>;
}) {
  const [check, setCheck] = useState(0);
  const [expanded, setExpanded] = useState<boolean>();
  useEffect(() => setExpanded(undefined), [connection]);
  const [result, setResult] = useState<{ connection: HubConnection; state: NotificationState; check: number; value: Readiness }>();
  const action = useRef<AbortController | undefined>(undefined);
  const [repairFailed, setRepairFailed] = useState(false);
  useEffect(() => { setRepairFailed(false); const foreground = () => { setCheck(n => n + 1); void refresh(); }; window.addEventListener(PUSH_FOREGROUND_EVENT, foreground); return () => { window.removeEventListener(PUSH_FOREGROUND_EVENT, foreground); action.current?.abort(); action.current = undefined; }; }, [connection, refresh]);
  useEffect(() => {
    if (!online || working) return;
    const controller = new AbortController(); let active = true;
    const finish = (value: Readiness) => { if (active) { setResult({ connection, state, check, value }); if (value.reason === "ready") setRepairFailed(false); } };
    const timer = setTimeout(() => { controller.abort(); finish({ reason: "unknown" }); active = false; }, 10_000);
    void checkNotificationReadiness(connection, state, controller.signal).then(finish, () => finish({ reason: "unknown" })).finally(() => clearTimeout(timer));
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [connection, state, online, working, check]);
  const value = !online ? undefined : !working && result?.connection === connection && result.state === state && result.check === check ? result.value : undefined;
  const [title, detail] = !online ? [t("连接主机后检查接收状态"), t("提醒开关已保留，当前无法确认接收条件。")]
    : value ? copy(value) : [t("正在检查接收状态…"), t("只读取权限与连接状态，不发送测试通知。")];
  const provider = value?.provider, canRepair = value?.reason === "subscription" && (provider === "apns" || provider === "fcm");
  const open = expanded ?? value?.reason !== "ready";
  return <details className="notification-readiness" data-state={value?.reason} aria-label={t("接收状态")} open={open} onToggle={event => {
    // Native toggle also fires when React changes the default open state. Only
    // a user change should override that default, including closing a warning.
    if (event.currentTarget.open !== open) setExpanded(event.currentTarget.open);
  }}>
    <summary className="notification-readiness-summary">
      {value?.reason === "ready" ? <Check size={18} aria-hidden="true"/> : !value && online ? <RefreshCw size={18} aria-hidden="true"/> : <Info size={18} aria-hidden="true"/>}
      <strong role="status">{title}</strong><ChevronRight size={16} aria-hidden="true"/>
    </summary>
    <div className="notification-readiness-body"><div>{(!value?.channelAlerts || value.reason !== "ready") && <p>{detail}</p>}{value?.channelAlerts && <>
        <p>{t("{0} · {1}", value.channelAlerts.sound ? t("声音开启") : t("声音关闭"), value.channelAlerts.vibration ? t("振动开启") : t("振动关闭"))}</p>
        <p>{t("实际提醒仍受手机静音、音量和勿扰设置影响。")}</p>
      </>}</div>
    </div>
    <div className="notification-readiness-actions">
      {canRepair && <button className="primary" disabled={working || !online} onClick={() => {
        if (action.current || working) return;
        const controller = new AbortController(); action.current = controller; setRepairFailed(false);
        const timeout = setTimeout(() => controller.abort(), 45_000);
        void repair(async () => {
          try { await reconnectSystemNotifications(connection, provider, controller.signal); }
          catch { if (action.current === controller) setRepairFailed(true); }
        }).finally(() => { clearTimeout(timeout); if (action.current === controller) { action.current = undefined; if (!controller.signal.aborted) setCheck(n => n + 1); } });
      }}>{t("重新连接推送")}</button>}
      <button className="secondary" disabled={!online || working} aria-disabled={!value || working || !online} onClick={() => { if (!value || working || !online) return; setCheck(n => n + 1); setRepairFailed(false); void refresh(); }}>{t("检查接收状态")}</button>
    </div>
    {repairFailed && <p role="alert" className="error-text">{t("恢复未完成，请重新检查后重试。不会更改你选择的推送方式。")}</p>}
  </details>;
}
