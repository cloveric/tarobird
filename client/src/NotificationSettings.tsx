import { ExplanationList } from "./ExplanationList.js";
import { NotificationReadiness } from "./NotificationReadiness.js";
import { UnifiedPushSettings } from "./UnifiedPushSettings.js";
import { t, useLocale } from "./i18n.js";
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Info, MessageCircle, FileText, CircleAlert, Bell, Eye, Volume2, ChevronRight } from "lucide-react";
import { openSystemNotificationSettings, supportsSystemNotificationSettings } from "./notification-system-settings.js";
import { DesktopNotificationPermissionError } from "./desktop-notifications.js";
import { nativePlatform, autostartEnabled, setAutostart } from "./native.js";
import { enableNotifications, updateNotificationPreferences, type NotificationState } from "./notifications.js";
import { RuntimeHostContext } from "./RuntimeHost.js";
import { SettingsGroupHeading } from "./SettingsParts.js";
import type { UnifiedRegistration } from "./unifiedpush-controller.js";
import type { HubConnection } from "./connection.js";
import "./notification-settings.css";

type Platform = ReturnType<typeof nativePlatform>;
type Blocker = { title: string; detail: string; recheck: boolean };
const browserBlocked = () => "Notification" in window && Notification.permission === "denied";
const blockedBrowser = (): Blocker => ({ title: t("浏览器已阻止通知"), detail: t("请在浏览器的网站设置中允许此网站发送通知，然后点「重新检查」。"), recheck: true });
/** Mirrors enableNotifications' preconditions, so the next step is explained
 * before Enable is pressed instead of arriving only as its error. */
function enableBlocker(platform: Platform, state: NotificationState, unifiedActive?: boolean): Blocker | undefined {
  if (platform === "macos" || platform === "windows") return undefined;
  if (platform === "ios") return state.providers.apns ? undefined : { title: t("此主机尚未配置 iPhone / iPad 推送"), detail: t("需要主机管理员在 Hub 配置中启用 APNs，此设备才能在后台收到提醒。配置完成后点「重新检查」。"), recheck: true };
  if (platform === "android") {
    // Unknown UnifiedPush state keeps the original button; an active
    // registration is re-enabled through the same queued UnifiedPush path.
    if (state.providers.fcm || unifiedActive !== false) return undefined;
    return state.providers.unifiedpush
      ? { title: t("手机通知尚未接通"), detail: t("请展开「通知连接选项」完成连接。接通前，锁屏或离开 App 后还不能收到提醒。"), recheck: false }
      : { title: t("手机通知尚未接通"), detail: t("这台主机尚未接通手机通知服务。锁屏或离开 App 后还不能收到提醒；回复和文件会保留在对话里。"), recheck: true };
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return { title: t("此浏览器不支持后台提醒"), detail: t("打开 TaroBird 时，新消息仍会实时显示。"), recheck: false };
  if (!state.providers.webpush || !state.vapidPublicKey) return { title: t("此主机尚未配置浏览器推送"), detail: t("需要主机管理员在 Hub 配置中启用 Web Push，此浏览器才能在后台收到提醒。配置完成后点「重新检查」。"), recheck: true };
  return browserBlocked() ? blockedBrowser() : undefined;
}
function quietSummary(start: string, end: string, zone: string): string {
  if (!start || !end || start === end) return t("未设置勿扰时段。");
  return start < end ? t("每天 {0}–{1} 不提醒（时区 {2}）。", start, end, zone) : t("每天 {0} 至次日 {1} 不提醒（时区 {2}）。", start, end, zone);
}

export function NotificationSettings({ connection, dirtyChange, busyChange }: { connection: HubConnection; dirtyChange?: (dirty: boolean) => void; busyChange?: (busy: boolean) => void }) {
  useLocale(); const hostName = useContext(RuntimeHostContext);
  const snapshot = useSyncExternalStore((notify) => connection.subscribe(notify), () => connection.state);
  const state = snapshot.notifications, online = snapshot.status === "online";
  const [error, setError] = useState<{ area: "status" | "quiet"; text: string; systemPermission?: boolean }>();
  const [busy, setBusy] = useState<"toggle" | "choice" | "quiet" | "repair">(), busyRef = useRef(false);
  const [loading, setLoading] = useState(false), [loadFailed, setLoadFailed] = useState(false);
  const [saved, setSaved] = useState(false), [unifiedBusy, setUnifiedBusy] = useState(false);
  const [openingSystem, setOpeningSystem] = useState(false), [systemError, setSystemError] = useState<"failed" | "unknown">();
  const systemRequest = useRef(0);
  const [quietDraft, setQuietDraft] = useState<{ quietStart: string; quietEnd: string }>();
  // A successful PUT is already a receipt. Keep its values if the follow-up GET
  // fails; any subsequently accepted store snapshot supersedes this receipt.
  const [receipt, setReceipt] = useState<NotificationState>();
  const preferences = state?.preferences;
  const [unifiedActive, setUnifiedActive] = useState<boolean>();
  const request = useRef(0), lifetime = useRef(0);
  const platform = nativePlatform();
  const load = useCallback(async () => {
    const id = ++request.current; setLoading(true);
    try { await connection.refreshNotificationPreferences(); if (id === request.current) setLoadFailed(false); return true; }
    catch { if (id === request.current) setLoadFailed(true); return false; }
    finally { if (id === request.current) setLoading(false); }
  }, [connection]);
  useEffect(() => {
    if (online) void load(); else setLoading(false);
    return () => { request.current++; };
  }, [load, online]);
  useEffect(() => { busyRef.current = false; setBusy(undefined); setError(undefined); setQuietDraft(undefined); setReceipt(undefined); setSaved(false); setUnifiedActive(undefined); setUnifiedBusy(false); setOpeningSystem(false); setSystemError(undefined); return () => { lifetime.current++; systemRequest.current++; }; }, [connection]);
  const quietStart = quietDraft?.quietStart ?? preferences?.quietStart ?? "", quietEnd = quietDraft?.quietEnd ?? preferences?.quietEnd ?? "";
  const quietDirty = !!quietDraft && (quietDraft.quietStart !== preferences?.quietStart || quietDraft.quietEnd !== preferences?.quietEnd);
  const working = !!busy || unifiedBusy;
  useLayoutEffect(() => { dirtyChange?.(quietDirty); }, [quietDirty, dirtyChange]);
  useLayoutEffect(() => { busyChange?.(working); }, [working, busyChange]);
  const act = async (kind: "toggle" | "choice" | "quiet" | "repair", work: () => Promise<NotificationState["preferences"] | void>) => {
    if (busyRef.current || unifiedBusy || connection.state.status !== "online") return;
    busyRef.current = true; request.current++; setLoading(false); const epoch = lifetime.current;
    setBusy(kind); setError(undefined); setSaved(false);
    if (kind === "toggle") setSystemError(undefined);
    try {
      const accepted = await work();
      if (epoch !== lifetime.current) return;
      if (accepted) { connection.acceptNotificationPreferences(accepted); setReceipt(connection.state.notifications); }
      if (kind === "quiet") { setQuietDraft(undefined); setSaved(true); }
      // Refresh failures have their own retry state, never a false write failure.
      void load();
    } catch (e) {
      if (epoch === lifetime.current) setError({ area: kind === "quiet" ? "quiet" : "status", text: e instanceof Error ? e.message : t("设置失败"), systemPermission: e instanceof DesktopNotificationPermissionError });
    } finally { if (epoch === lifetime.current) { busyRef.current = false; setBusy(undefined); } }
  };
  const lede = <p className="settings-lede">{hostName ? t("此设备 · 主机「{0}」", hostName) : t("此设备 · 当前主机")}</p>;
  const retry = <button type="button" className="secondary" disabled={!online || working} aria-disabled={!online || working || loading} onClick={() => { if (online && !working && !loading) void load(); }}>{loading ? t("检查中…") : t("重新检查")}</button>;
  const loadNotice = loadFailed && <div className="settings-callout" role="alert"><Info size={16} aria-hidden="true"/><div><strong>{t("通知设置暂时无法刷新")}</strong><p>{state ? receipt === state ? t("已保存的修改仍然有效。重新检查可获取主机上的最新设置。") : t("当前显示的是上次读取的设置，可能不是最新。") : t("未能读取主机上的通知设置，请重试。")}</p>{retry}</div></div>;
  if (!state || !preferences) return <><h3>{t("通知")}</h3>{lede}{!online ? <p role="status" className="settings-offline">{t("连接主机后即可设置通知。")}</p> : loadNotice || <p role="status" className="muted">{t("正在读取通知设置…")}</p>}</>;
  const currentState = { ...state, preferences }, enabled = preferences.enabled;
  const blocker = enabled ? platform === "web" && browserBlocked() ? blockedBrowser() : undefined : enableBlocker(platform, currentState, unifiedActive);
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const activeQuiet = !!quietStart && !!quietEnd && quietStart !== quietEnd;
  const zoneDirty = activeQuiet && deviceZone !== preferences.timeZone;
  const custom = state.customization === true;
  const desktop = platform === "macos" || platform === "windows";
  const editPreference = (key: "replyCompleted" | "filesReceived" | "needsAttention" | "showPreview") => {
    if (!custom) return;
    void act("choice", async () => {
      const next = { ...preferences, [key]: preferences[key] === false };
      await updateNotificationPreferences(connection, next); return next;
    });
  };
  const events = [
    { key: "replyCompleted", label: t("回复完成"), detail: t("Bot 回复完成或发来后台任务更新时提醒。"), Icon: MessageCircle },
    { key: "filesReceived", label: t("收到文件"), detail: t("收到文件、图片或音频时提醒。"), Icon: FileText },
    { key: "needsAttention", label: t("需要处理"), detail: t("需要你确认、补充信息或任务出错时提醒。"), Icon: CircleAlert },
  ] as const;
  const systemLabel = platform === "android" ? t("声音与振动设置") : desktop ? t("声音与横幅设置") : t("声音与锁屏设置");
  const systemHelp = platform === "macos" ? t("打开系统设置后，选择「通知 → TaroBird」管理声音与横幅。") : platform === "android" ? t("在系统设置中管理通知声音、振动与横幅。") : desktop ? t("打开系统通知设置后，在应用列表中选择 TaroBird。") : t("在系统设置中管理声音、横幅与锁屏预览。");
  const systemFallback = platform === "macos" ? t("请打开系统设置 → 通知 → TaroBird。") : platform === "windows" ? t("请打开 Windows 设置 → 系统 → 通知 → TaroBird。") : platform === "ios" ? t("请打开 iPhone / iPad 设置 → 通知 → TaroBird。") : t("无法打开系统设置，请在手机设置中进入 TaroBird 的通知设置。");
  const systemSettings = async () => {
    if (openingSystem) return;
    const id = ++systemRequest.current;
    setOpeningSystem(true); setSystemError(undefined);
    const timer = setTimeout(() => { if (id === systemRequest.current) { setOpeningSystem(false); setSystemError("unknown"); } }, 10_000);
    try { await openSystemNotificationSettings(); if (id === systemRequest.current) setSystemError(undefined); }
    catch { if (id === systemRequest.current) setSystemError("failed"); }
    finally { clearTimeout(timer); if (id === systemRequest.current) setOpeningSystem(false); }
  };
  return <><h3>{t("通知")}</h3>{lede}<div className="notification-settings">
    {!online && <p role="status" className="settings-offline">{t("当前离线，已保存的设置仍然保留。连接恢复后可修改。")}</p>}
    <div className="settings-group notification-master">
      <div className="settings-row notification-option">
        <Bell size={20} aria-hidden="true"/>
        <div className="settings-row-text"><span id="notification-master-label">{t("消息提醒")}</span><small id="notification-master-detail">{busy === "toggle" ? t("正在保存…") : enabled ? t("已开启") : blocker ? t("暂不可用") : t("已关闭")}</small></div>
        <button type="button" className="model-brand-toggle" role="switch" aria-labelledby="notification-master-label" aria-describedby="notification-master-detail" aria-checked={enabled} disabled={working || !online || !enabled && !!blocker} onClick={() => { void act("toggle", async () => { const next = { ...preferences, enabled: !enabled }; if (enabled) await updateNotificationPreferences(connection, next); else await enableNotifications(connection, currentState); return next; }); }}><span className="model-brand-toggle-track" aria-hidden="true"/></button>
      </div>
      {blocker && <div className="settings-callout" role="note"><Info size={16} aria-hidden="true"/><div><strong>{blocker.title}</strong><details className="settings-help"><summary>{t("如何开启提醒")}</summary><p>{blocker.detail}</p></details>{blocker.recheck && !loadFailed && retry}</div></div>}
    </div>
    <p className="settings-note muted">{desktop ? t("使用其他应用时接收系统通知；点按通知回到对应对话。完全退出 TaroBird 后不再提醒。") : t("离开 TaroBird 或锁屏后接收系统通知；点按通知回到对应对话。")}</p>
    {enabled && <NotificationReadiness connection={connection} state={state} online={online} working={working} refresh={load} repair={(work) => act("repair", work)}/>}
    {loadNotice}
    {error?.area === "status" && <>
      <p role="alert" className="error-text">{error.text}</p>
      {desktop && error.systemPermission && <div className="settings-callout notification-permission-help"><Info size={16} aria-hidden="true"/><div>
        <p>{systemFallback} {t("允许 TaroBird 通知后，返回此页重新开启消息提醒。")}</p>
        <button type="button" className="secondary" disabled={openingSystem || !supportsSystemNotificationSettings()} onClick={() => void systemSettings()}>{openingSystem ? t("正在打开…") : t("前往系统设置")}</button>
        {systemError && <p role={systemError === "failed" ? "alert" : "status"}>{systemError === "failed" ? systemFallback : t("也可手动打开系统设置，选择「通知 → TaroBird」。")}</p>}
      </div></div>}
    </>}
    <SettingsGroupHeading>{t("提醒内容")}</SettingsGroupHeading>
    <div className="settings-group" role="group" aria-label={t("提醒内容")}>
      {events.map(({ key, label, detail, Icon }) => <div className="settings-row notification-option" key={key}>
        <Icon size={20} aria-hidden="true"/>
        <div className="settings-row-text"><span id={`notification-${key}`}>{label}</span><small id={`notification-${key}-detail`}>{detail}</small></div>
        {custom && <button type="button" className="model-brand-toggle" role="switch" aria-labelledby={`notification-${key}`} aria-describedby={`notification-${key}-detail`} aria-checked={preferences[key] !== false} disabled={working || !online} onClick={() => editPreference(key)}><span className="model-brand-toggle-track" aria-hidden="true"/></button>}
      </div>)}
    </div>
    {!custom && <p className="settings-note muted">{t("更新主机后，可分别选择提醒内容和隐藏消息详情。")}</p>}
    {custom && <>
      <p className="settings-note muted">{enabled ? t("同时包含回复和文件时，任一对应提醒开启即可通知；需确认或出错时按「需要处理」设置。") : t("消息提醒关闭时不会通知；以上选择会保留。")}</p>
      <SettingsGroupHeading>{t("通知显示内容")}</SettingsGroupHeading>
      <div className="settings-group"><div className="settings-row notification-option">
        <Eye size={20} aria-hidden="true"/>
        <div className="settings-row-text"><span id="notification-preview-label">{t("显示消息详情")}</span><small id="notification-preview-detail">{t("关闭后隐藏对话名称、Bot 名称、回复内容和文件名。")}</small></div>
        <button type="button" className="model-brand-toggle" role="switch" aria-labelledby="notification-preview-label" aria-describedby="notification-preview-detail" aria-checked={preferences.showPreview !== false} disabled={working || !online} onClick={() => editPreference("showPreview")}><span className="model-brand-toggle-track" aria-hidden="true"/></button>
      </div></div>
    </>}
    {platform !== "web" && <>
      <SettingsGroupHeading>{t("声音与系统通知")}</SettingsGroupHeading>
      <div className="settings-group"><button type="button" className="settings-row notification-system-link" disabled={openingSystem || !supportsSystemNotificationSettings()} onClick={() => void systemSettings()} aria-label={systemLabel}>
        <Volume2 size={20} aria-hidden="true"/><span className="settings-row-text"><span>{systemLabel}</span><small>{systemHelp}</small></span><span className="notification-system-value">{openingSystem ? t("正在打开…") : t("前往系统设置")}</span><ChevronRight size={18} aria-hidden="true"/>
      </button></div>
      {systemError && !error?.systemPermission && <p role={systemError === "failed" ? "alert" : "status"} className={systemError === "failed" ? "error-text" : "settings-note muted"}>{systemError === "failed" ? systemFallback : t("也可手动打开系统设置，选择「通知 → TaroBird」。")}</p>}
    </>}
    <details className="notification-quiet">
      <summary><span>{t("勿扰时段")}</span><small>{activeQuiet ? t("{0}–{1}", quietStart, quietEnd) : t("未开启")}{quietDirty ? ` · ${t("有未保存的修改")}` : ""}</small><ChevronRight size={18} aria-hidden="true"/></summary>
    <form className="settings-quiet" onSubmit={(event) => { event.preventDefault(); if (!quietDirty && !zoneDirty) return; void act("quiet", async () => { const next = { ...preferences, quietStart, quietEnd, timeZone: deviceZone }; await updateNotificationPreferences(connection, next); return next; }); }}>
      <div className="settings-group quiet-card" role="group" aria-label={t("勿扰时段")}>
        <div className="quiet-times">
          <label>{t("勿扰开始")}<input type="time" disabled={working || !online} value={quietStart} onChange={(e) => { setSaved(false); setQuietDraft({ quietEnd, quietStart: e.target.value }); }}/></label>
          <label>{t("勿扰结束")}<input type="time" disabled={working || !online} value={quietEnd} onChange={(e) => { setSaved(false); setQuietDraft({ quietStart, quietEnd: e.target.value }); }}/></label>
        </div>
        <p className="quiet-preview">{quietSummary(quietStart, quietEnd, quietDirty ? deviceZone : preferences.timeZone)}</p>
        <div className="quiet-save-row"><span role="status">{busy === "quiet" ? t("正在保存…") : quietDirty ? t("有未保存的修改") : saved ? t("勿扰时段已保存") : loading ? t("正在同步…") : !online || loadFailed ? t("上次保存的设置") : t("已与主机同步")}</span><div className="quiet-actions">{(quietStart || quietEnd) && <button type="button" className="secondary" disabled={working || !online} onClick={() => { setQuietDraft({ quietStart: "", quietEnd: "" }); setSaved(false); }}>{t("清空时段")}</button>}{quietDirty && <button type="button" className="secondary" disabled={working} onClick={() => { setQuietDraft(undefined); setSaved(false); setError(undefined); }}>{t("还原")}</button>}<button type="submit" className={quietDirty || zoneDirty ? "primary" : "secondary"} disabled={working || !online || !quietDirty && !zoneDirty}>{t("保存")}</button></div></div>
      </div>
      <p className="settings-note muted">{t("勿扰时段内不会提醒，消息照常同步。清空任一时间即可关闭勿扰。")}{zoneDirty ? t("保存后将改用此设备的时区（{0}）。", deviceZone) : ""}</p>
      {error?.area === "quiet" && <p role="alert" className="error-text">{error.text}</p>}
    </form>
    </details>
    <details className="settings-help notification-policy"><summary>{t("哪些消息会提醒我")}</summary><ExplanationList items={[
      { label: t("提醒时机"), description: t("Bot 完成回复、发来文件、出错或等待你确认时提醒；正在生成的内容不会逐条打扰。") },
      { label: t("不提醒时"), description: t("TaroBird 在前台，或对话已开启免打扰。") },
      { label: t("通知内容"), description: desktop ? t("通知显示方式与声音由电脑系统设置控制。") : t("锁屏是否显示通知内容，由手机系统设置控制。") },
      { label: t("设置范围"), description: t("仅此设备；设置保存在当前主机，其他设备各自设置。") },
    ]}/></details>
    {platform === "android" && <details className="settings-help notification-connection-options"><summary>{t("通知连接选项")}</summary><UnifiedPushSettings connection={connection} state={currentState} disabled={!!busy || !online} busyChange={setUnifiedBusy} changed={async (accepted) => { if (accepted) { connection.acceptNotificationPreferences(accepted); setReceipt(connection.state.notifications); } await load(); }} registrationChange={(registration?: UnifiedRegistration) => setUnifiedActive(registration ? registration.phase === "active" && !!registration.registrationId && !!registration.distributor : undefined)}/></details>}
  </div></>;
}


export function DesktopPreferences() {
  const platform = nativePlatform(), desktop = platform === "macos" || platform === "windows";
  const [autostart, setAuto] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { if (desktop) void autostartEnabled().then(setAuto).catch(() => undefined); }, [desktop]);
  if (!desktop) return null;
  return <><SettingsGroupHeading scope="device">{t("桌面")}</SettingsGroupHeading><div className="settings-group"><label className="settings-row"><span>{t("登录电脑时自动启动")}</span><input type="checkbox" checked={autostart} disabled={busy} onChange={(e) => {
    const enabled = e.target.checked; setBusy(true); setError("");
    void setAutostart(enabled).then(() => setAuto(enabled)).catch(() => setError(t("设置失败"))).finally(() => setBusy(false));
  }}/></label></div><p className="settings-note muted">{t("全局快捷键：")}{platform === "macos" ? "⌘" : "Ctrl"} + Shift + T</p>{error && <p role="alert" className="error-text">{error}</p>}</>;
}
