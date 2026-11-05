import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "./i18n.js";
import { UnifiedPush, UnifiedPushRemovalError, enableUnifiedPush, unregisterHostNotifications, clearUnifiedPush, unifiedState, pushScopeFor } from "./unifiedpush.js";
import type { UnifiedRegistration } from "./unifiedpush-controller.js";
import type { HubConnection } from "./connection.js";
import { enableNotifications, type NotificationState } from "./notifications.js";

function registrationError(error: unknown): string {
  if (error instanceof UnifiedPushRemovalError) return error.message;
  if (error instanceof Error && error.message === "unifiedpush_client_update_required") return t("请更新 Android 客户端以启用多主机推送；已有注册保持不变。");
  if (error instanceof Error && error.message === "unifiedpush_distributor_in_use") return t("分发器由所有主机共用。请先断开已有主机的分发器连接，再更换分发器。");
  if (error instanceof Error && error.message === "unifiedpush_distributor_unavailable") return t("原分发器不可用，请重新安装它，或先断开使用它的主机再更换。");
  if (error instanceof Error && error.message === "unifiedpush_removal_pending") return t("请先完成此主机的推送清理，再重新连接。");
  return t("推送注册未完成。请检查通知权限、分发器网络及 Hub 允许的分发器域名，再重试。");
}

/** `registrationChange` only reports state for explanatory text; every
 * registration, provider switch and removal still runs through the queued
 * per-host operations below. */
export function UnifiedPushSettings({ connection, state, changed, registrationChange, disabled = false, busyChange }: { connection: HubConnection; state: NotificationState; changed: (accepted?: NotificationState["preferences"]) => Promise<unknown>; registrationChange?: (registration?: UnifiedRegistration) => void; disabled?: boolean; busyChange?: (busy: boolean) => void }) {
  const [distributors, setDistributors] = useState<{ id: string; name: string }[]>([]); const [selected, setSelected] = useState("");
  const [registration, setRegistration] = useState<UnifiedRegistration>(); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const busyRef = useRef(false), readId = useRef(0), lifetime = useRef(0);
  useLayoutEffect(() => { busyChange?.(busy); }, [busy, busyChange]);
  const refresh = useCallback(async () => {
    const id = ++readId.current;
    try {
      const [available, current] = await Promise.all([UnifiedPush.distributors(), unifiedState({ ...pushScopeFor(connection), migrateLegacy: false })]);
      if (id !== readId.current) return;
      setDistributors(available.distributors); setRegistration(current);
      setSelected(current.distributor || current.sharedDistributor || available.distributors[0]?.id || ""); setReadError("");
    } catch (error) {
      if (id === readId.current) setReadError(error instanceof Error && error.message.startsWith("unifiedpush_") ? registrationError(error) : t("暂时无法读取分发器状态，请刷新。"));
    }
  }, [connection]);
  useEffect(() => { busyRef.current = false; setBusy(false); setError(""); setReadError(""); setRegistration(undefined); setDistributors([]); setSelected(""); void refresh(); return () => { readId.current++; lifetime.current++; }; }, [refresh]);
  useEffect(() => { registrationChange?.(registration); }, [registration]);
  const act = async (disable = false, systemPush = false) => {
    if (busyRef.current || disabled) return;
    busyRef.current = true; readId.current++; const epoch = lifetime.current; setBusy(true); setError("");
    try {
      if (systemPush) { await enableNotifications(connection, state, { systemPush: true }); if (epoch === lifetime.current) await changed({ ...state.preferences, enabled: true }); return; }
      if (disable && registration?.phase === "removing" && !registration.remoteRemoval) {
        await clearUnifiedPush(pushScopeFor(connection)); if (epoch === lifetime.current) await changed(); return;
      }
      if (disable) { await unregisterHostNotifications(connection, state.preferences); }
      else await enableUnifiedPush(connection, selected, state.preferences);
      if (epoch === lifetime.current) await changed({ ...state.preferences, enabled: !disable });
    } catch (error) { if (epoch === lifetime.current) setError(registrationError(error)); }
    finally { if (epoch === lifetime.current) { await refresh(); if (epoch === lifetime.current) { busyRef.current = false; setBusy(false); } } }
  };
  const active = registration?.confirmed && registration.phase === "active" && registration.registrationId ? distributors.find((item) => item.id === registration.distributor)?.name ?? registration.distributor : undefined;
  return <div className="notification-help">
    <strong>{t("UnifiedPush（无谷歌服务时使用）")}</strong>
    <p>{t("没有谷歌服务的 Android 设备，可以通过 UnifiedPush 分发器（如 ntfy）接收后台提醒。")}{state.providers.unifiedpush ? t("此主机已启用 UnifiedPush。") : t("此主机尚未启用 UnifiedPush，需要主机管理员在 Hub 配置中启用，并允许分发器的服务器地址。")}{t("打开 TaroBird 时，新消息仍会实时显示。")}</p>
    {active && <p className="settings-state-line">{t("此主机已注册到分发器「{0}」。", active)}</p>}
    {distributors.length ? <div className="settings-row"><select aria-label={t("推送分发器")} value={selected} disabled={disabled || busy} onChange={(event) => setSelected(event.target.value)}>{distributors.map((item) => <option key={item.id} value={item.id} disabled={!!registration?.registrationCount && !!registration.sharedDistributor && registration.sharedDistributor !== item.id}>{item.name}</option>)}</select><button disabled={disabled || busy || registration?.phase === "removing" || !selected || !state.providers.unifiedpush} onClick={() => void act()}>{busy ? t("处理中…") : t("连接分发器")}</button></div> : <p>{t("未找到分发器。安装并打开 ntfy，完成服务器设置后，返回此处刷新。")}</p>}
    <p className="muted">{t("每台主机独立注册与断开；分发器应用由所有主机共用。")}</p>
    <div className="notification-actions"><button disabled={disabled || busy} onClick={() => void refresh()}>{t("刷新")}</button>{state.providers.fcm && registration?.phase === "active" && <button disabled={disabled || busy} onClick={() => void act(false, true)}>{t("改用系统推送（FCM）")}</button>}{registration?.registrationId && <button disabled={disabled || busy} onClick={() => void act(true)}>{registration.phase === "removing" ? t("继续完成清理") : t("断开分发器")}</button>}</div>
    {registration?.phase === "removing" ? <p role="status">{t("请先完成此主机的推送清理，再重新连接。")}</p> : (registration?.error || registration?.registrationId && !registration.confirmed) && <p role="status">{t("分发器注册需要重试。")}</p>}{error && <p role="alert" className="error-text">{error}</p>}{readError && <p role="alert" className="error-text">{readError}</p>}
  </div>;
}
