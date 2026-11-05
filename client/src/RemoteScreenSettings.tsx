import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { ScreenStatus, ScreenPolicy } from "../../src/client-protocol/remote-screen.js";
import type { HubConnection } from "./connection.js";
import { isElectron, invoke } from "./desktop-bridge.js";
import { t, useLocale } from "./i18n.js";
import "./remote-screen.css";
export function screenError(reason: string) {
  const messages: Record<string,string> = {
    screen_host_unavailable: "找不到本机主机服务，请检查主机状态后重试屏幕服务。",
    screen_host_timeout: "连接本机主机服务超时，请重试屏幕服务。",
    screen_host_reply_invalid: "主机回复格式无效，请检查 App 与主机版本后重试。",
    screen_host_connect_failed: "无法连接主机的屏幕服务，请检查主机状态后重试。",
    screen_host_disconnected: "屏幕服务与主机的连接已断开，正在自动重连。",
    screen_host_directory_conflict: "检测到多份主机数据，请先解决主机目录冲突，再重试屏幕服务。",
    screen_host_directory_redirected: "主机目录被重定向，请检查主机数据目录。",
    screen_host_directory_unavailable: "无法读取主机目录，请检查文件访问权限后重试屏幕服务。",
    unsafe_hub_control_key: "主机控制文件权限不安全，请修复主机文件权限后重试。",
    host_control_operation_unsupported: "此主机需要更新后才能使用远程屏幕。",
    screen_host_update_required: "此主机需要更新后才能使用远程屏幕。",
    screen_registration_timeout: "主机未确认屏幕服务注册，请重试屏幕服务。",
    screen_registration_failed: "屏幕服务注册失败，请重试并检查目标主机。",
    screen_registration_rejected: "主机拒绝屏幕服务注册，请检查主机状态后重试。",
    screen_registration_invalid: "主机回复格式无效，请检查 App 与主机版本后重试。",
    screen_desktop_busy: "另一个桌面服务已连接此主机，请检查是否打开了多份 TaroBird。",
    screen_hello_invalid: "屏幕服务协议不兼容，请检查 App 与主机版本后重试。",
    screen_protocol_invalid: "屏幕服务协议不兼容，请检查 App 与主机版本后重试。",
    screen_ticket_invalid: "屏幕服务注册凭据已失效，请重试屏幕服务。",
    screen_rate_limited: "屏幕服务请求过于频繁，请稍候重试。",
    screen_service_start_failed: "屏幕服务启动失败，请重试；若仍失败，请保存工作后重新打开 TaroBird。",
    screen_desktop_invalid: "无法读取本机显示器信息，请确认当前用户已登录桌面后重试。",
    screen_native_unavailable: "屏幕原生模块不可用，请重新安装完整的 TaroBird 桌面版。",
    screen_permission_settings_failed: "系统设置未能打开，请在系统设置 → 隐私与安全性中打开对应权限页面后重试。",
    screen_permission_request_failed: "系统权限请求未完成，请重试或在系统设置 → 隐私与安全性中添加 TaroBird。",
    host_directory_conflict: "检测到多份主机数据，请先解决主机目录冲突，再重试屏幕服务。",
    host_directory_redirected: "主机目录被重定向，请检查主机数据目录。",
    host_directory_probe_failed: "无法读取主机目录，请检查文件访问权限后重试屏幕服务。",
    screen_service_updating: "App 正在安装更新，完成后将重试屏幕服务。",
    screen_service_unavailable: "屏幕服务不可用，请检查本机桌面版是否完整安装。",
    screen_quality_unsupported: "目标 Mac 的 App 暂不支持画质选择，请更新后重试，或以默认画质连接。",
    screen_quality_decoder_unavailable: "此设备不支持清晰画质解码，请改用均衡或流畅。",
    screen_request_timeout: "屏幕连接请求超时，请检查线路后重试。",
    screen_quality_unconfirmed: "主机未确认所选画质，请检查两端版本后重试。",
    screen_display_unavailable: "目标 Mac 没有可用显示器。",
    screen_disabled: "请先在目标 Mac 开启允许远程屏幕。",
    screen_not_authorized: "请在目标 Mac 的远程屏幕设置中授权此设备。",
    screen_capture_denied: "请在目标 Mac 允许 TaroBird 录制屏幕，再重新连接。",
    screen_service_offline: "主机在线，但桌面服务未运行。请在目标 Mac 打开 TaroBird。",
    screen_locked: "目标 Mac 已锁定，请在本机解锁后重新连接。",
    screen_control_busy: "另一台设备正在控制，请先停止该设备的控制。",
    screen_geometry_changed: "显示器发生变化，请重新选择显示器连接。",
    screen_congested: "连接拥塞，屏幕已断开。请检查线路后重新连接。",
    screen_decode_failed: "画面解码失败，请重新连接。",
    screen_policy_changed: "授权已在其他窗口变更，请刷新后重试。",
    screen_focus_required: "请先点击屏幕区域，再开始控制。",
    screen_local_takeover: "目标电脑已停止共享，请重新连接。",
    screen_connect_timeout: "屏幕连接超时，请检查目标 Mac 和当前线路。",
    session_expired: "本次屏幕连接的认证已到期，请重新连接；无需重新配对。",
    device_revoked_or_expired: "本次屏幕连接的认证已到期或设备授权已撤销，请检查授权后重新连接。",
    screen_network_timeout: "屏幕连接超时，请检查目标 Mac 和当前线路。",
    screen_decoder_unavailable: "此设备暂不支持屏幕视频解码，请更新桌面客户端。",
    screen_host_offline: "主机暂时离线，请恢复连接后重试。",
    screen_accessibility_denied: "请在目标 Mac 允许 TaroBird 使用辅助功能，再点击开始控制。",
    screen_lease_expired: "控制授权已过期，请重新点击开始控制。",
    screen_control_not_authorized: "请在目标 Mac 的远程屏幕设置中允许此设备查看并控制。",
    screen_control_revoked: "请在目标 Mac 的远程屏幕设置中允许此设备查看并控制。",
    screen_capture_stale: "画面暂未更新，控制已停止，请等待新画面。",
    screen_takeover_unavailable: "目标 Mac 的本机接管检测未就绪。请在目标 Mac 检查辅助功能和输入监控权限，再重新连接。",
    screen_input_denied: "请在目标 Mac 允许 TaroBird 使用辅助功能，再点击开始控制。",
    screen_lease_invalid: "控制授权已过期，请重新点击开始控制。",
    screen_control_timeout: "目标 Mac 未确认控制，请检查权限后重试。",
    screen_frame_or_lease_expired: "控制已暂停，请等待新画面后重新开始控制。",
    screen_frame_stale: "画面暂未更新，控制已停止，请等待新画面。",
  };
  return messages[reason] ? t(messages[reason]!) : `${t("屏幕连接已结束，请检查主机状态后重试。")} (${reason.slice(0,120)})`;
}
type LocalScreenStatus = {
  supported: boolean; registered?: boolean; phase?: "starting" | "connecting" | "registered" | "retrying" | "failed"; retryAt?: number; error?: string;
  permissions?: { capture: string; accessibility: boolean; inputMonitoring: boolean };
  desktop?: ScreenStatus["desktop"]; inputMonitoring?: boolean;
};
type PermissionResult = LocalScreenStatus & { requested: boolean; opened: boolean; requestError?: string };

/** Host status uses this GUI connection's device identity. Native status is
 * queried only after the selected Host has been proven to be this Mac. */
export function RemoteScreenSettings({ connection, local, open, openBlocked, busyChange }: {
  connection: HubConnection; local: boolean; open?: () => void; openBlocked?: string; busyChange?: (busy: boolean) => void;
}) {
  useLocale();
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const desktopApp = isElectron();
  const localMac = local && desktopApp && window.tarobotDesktop?.platform === "darwin";
  const [snapshot, setSnapshot] = useState<{ connection: HubConnection; status?: ScreenStatus; native?: LocalScreenStatus; error?: string; nativeError?: string }>();
  const [busy, setBusy] = useState(false), [actionError, setActionError] = useState("");
  const [permissionRequest, setPermissionRequest] = useState<{ kind: "capture" | "accessibility" | "input-monitoring"; opened: boolean }>();
  const readVersion = useRef(0);
  const lifetime = useRef<object | null>(null), operation = useRef(false), refresh = useRef<() => void>(() => {});
  const entryDescription = useId();
  const devicePermissions = useRef<HTMLDetailsElement>(null);
  const current = snapshot?.connection === connection ? snapshot : undefined;
  const status = current?.status, native = localMac ? current?.native : undefined;
  useEffect(() => {
    if (!desktopApp) return;
    const scope = {}; lifetime.current = scope;
    let reading = false, queued = false;
    setSnapshot(undefined); setActionError(""); setPermissionRequest(undefined); setBusy(false); operation.current = false;
    const read = async () => {
      if (lifetime.current !== scope) return;
      if (reading || operation.current) { queued = true; return; }
      queued = false; reading = true; const version = readVersion.current;
      const [host, desktop] = await Promise.allSettled([
        state.status === "online" && state.screenAvailable ? connection.screenStatus() : Promise.reject(new Error(state.status !== "online" ? "screen_host_offline" : "screen_host_update_required")),
        localMac ? invoke<LocalScreenStatus>("screen_service_status") : Promise.resolve(undefined),
      ]);
      if (lifetime.current === scope && !operation.current && readVersion.current === version) setSnapshot({ connection,
        status: host.status === "fulfilled" ? host.value : undefined,
        error: host.status === "rejected" ? reason(host.reason) : undefined,
        native: desktop.status === "fulfilled" ? desktop.value : undefined,
        nativeError: desktop.status === "rejected" ? reason(desktop.reason) : undefined,
      });
      reading = false;
      if (queued && !operation.current) void read();
    };
    refresh.current = () => { void read(); };
    void read();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void read(); }, 3000);
    const focus = () => { if (document.visibilityState === "visible") void read(); };
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", focus);
    return () => { lifetime.current = null; clearInterval(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus); refresh.current = () => {}; busyChange?.(false); };
  }, [connection, desktopApp, localMac, state.status, state.screenAvailable, busyChange]);
  const run = async (work: () => Promise<unknown>) => {
    if (operation.current) return;
    const scope = lifetime.current;
    ++readVersion.current; operation.current = true; setBusy(true); busyChange?.(true); setActionError("");
    try { await work(); } catch (e) { if (lifetime.current === scope) setActionError(reason(e)); }
    finally { if (lifetime.current === scope) { operation.current = false; setBusy(false); busyChange?.(false); refresh.current(); } }
  };
  const save = (policy: ScreenPolicy) => run(() => connection.screenConfigure({ operation: "screen.configure", expectedRevision: policy.revision, enabled: policy.enabled, grants: policy.grants, requestId: crypto.randomUUID() }));
  const permission = (kind: "capture" | "accessibility" | "input-monitoring") => run(async () => {
    if (!localMac || !status?.canManage) return;
    const scope = lifetime.current;
    setPermissionRequest(undefined);
    const result = await invoke<PermissionResult>("screen_service_permission", { kind });
    if (lifetime.current === scope) {
      setPermissionRequest({ kind, opened: result.opened });
      if (result.requestError) setActionError(result.requestError);
    }
  });
  if (!desktopApp) return null;
  const permissions = native?.permissions ?? (native?.desktop ? { capture: native.desktop.capture, accessibility: native.desktop.accessibility, inputMonitoring: !!native.inputMonitoring } : undefined);
  const requestedPermissionGranted = permissionRequest?.kind === "capture" ? permissions?.capture === "granted"
    : permissionRequest?.kind === "accessibility" ? permissions?.accessibility : permissionRequest?.kind === "input-monitoring" ? permissions?.inputMonitoring : false;
  const blocked = openBlocked || (state.status !== "online" ? t("主机暂时离线，请恢复连接后重试。")
    : !state.screenAvailable ? t("此主机需要更新后才能使用远程屏幕。")
    : !status ? current?.error ? t("无法读取屏幕状态，请刷新重试。") : t("正在读取屏幕状态，请稍候或刷新。")
    : !status.enabled ? t("请先在目标 Mac 开启允许远程屏幕。")
    : status.permission === "none" ? t("此设备尚未获得查看授权。")
    : !status.desktop ? t("屏幕服务尚未注册，请在目标 Mac 检查或重试屏幕服务。")
    : status.desktop.locked ? t("目标 Mac 已锁定，请在本机解锁后重新连接。")
    : status.desktop.capture !== "granted" ? t("请在目标 Mac 允许 TaroBird 录制屏幕，再重新连接。")
    : !status.desktop.displays.length ? t("目标 Mac 没有可用显示器。") : !open ? t("此入口暂时无法打开屏幕，请重新打开连接设置。") : "");
  const error = actionError || current?.error || current?.nativeError;
  const nativePhase = native?.phase === "starting" ? t("正在启动") : native?.phase === "connecting" ? t("正在连接主机")
    : native?.phase === "registered" ? t("已注册") : native?.phase === "retrying" ? t("等待重试") : native?.phase === "failed" ? t("启动失败") : undefined;
  const serviceState = native && !native.supported ? t("不可用")
    : nativePhase && native?.phase !== "registered" ? nativePhase
    : !status ? current?.error ? t("未知") : t("正在读取…")
    : status.desktop ? t("已注册") : native?.registered ? t("等待主机确认")
    : status.canManage || status.permission !== "none" ? t("尚未注册") : t("授权后可查询");
  const devices = [...status?.devices ?? []].sort((a, b) => Number(b.id === connection.identity.deviceId) - Number(a.id === connection.identity.deviceId));
  const manageDevices = () => {
    const details = devicePermissions.current;
    if (!details) return;
    details.open = true;
    const target = details.querySelector<HTMLElement>('[data-current-device="true"] select') ?? details.querySelector("summary");
    target?.scrollIntoView({ block: "nearest" }); target?.focus({ preventScroll: true });
  };
  return <section className="screen-settings" aria-label={t("远程屏幕")}>
    <header className="screen-settings-heading">
      <h3>{t("远程屏幕")}</h3>
      {status?.canManage && status.policy && <label className="screen-enable">
        <span>{t("允许远程屏幕")}</span>
        <input type="checkbox" checked={status.policy.enabled} disabled={busy} onChange={event => void save({ ...status.policy!, enabled: event.target.checked })}/>
      </label>}
    </header>
    {status?.canManage && status.policy && <p className="screen-settings-intro">{t("开启后，仍需单独授权设备。")}</p>}
    <div className="screen-overview">
      <dl className="screen-readiness">
        <div><dt>{t("主机连接")}</dt><dd data-ready={state.status === "online"}>{state.status === "online" ? t("已连接") : t("未连接")}</dd></div>
        <div><dt>{t("屏幕服务")}</dt><dd data-ready={!!status?.desktop}>{serviceState}</dd></div>
        <div><dt>{t("此设备权限")}</dt><dd data-ready={!!status && status.permission !== "none"}>{!status ? current?.error ? t("未知") : t("正在读取…") : status.permission === "control" ? t("查看并控制") : status.permission === "view" ? t("仅查看") : t("未授权")}</dd></div>
      </dl>
      <div className="screen-entry-actions">
        <button className="screen-view-button" disabled={busy || !!blocked} aria-describedby={blocked ? entryDescription : undefined} onClick={() => { if (!busy && !blocked) open?.(); }}>{t("查看屏幕")}</button>
        <button className="screen-text-action" disabled={busy} onClick={() => refresh.current()}>{t("刷新状态")}</button>
      </div>
      {blocked && <div className="screen-entry-help"><p id={entryDescription}>{blocked}</p>
        {status?.permission === "none" && (status.canManage && status.policy
          ? <button className="screen-text-action" disabled={busy} onClick={manageDevices}>{t("管理设备授权")}</button>
          : <p>{t("请在目标 Mac 的已配对设备列表中，明确允许此设备“仅查看”或“查看并控制”。")}</p>)}
      </div>}
    </div>
    {error && <p className="screen-notice" role="alert">{screenError(error)}</p>}
    {localMac && native && <div className="screen-service-recovery">
      {native.phase === "retrying" && Number.isFinite(native.retryAt) && <p role="status">{t("自动重试时间：{0}", new Date(native.retryAt!).toLocaleTimeString())}</p>}
      {native.error && native.error !== error && <p className="screen-notice" role="status">{screenError(native.error)}</p>}
      {!native.supported && error !== "screen_native_unavailable" && native.error !== "screen_native_unavailable" && <p className="screen-notice" role="alert">{screenError("screen_native_unavailable")}</p>}
      {native.supported && !native.registered && <button disabled={busy || native.phase === "starting" || native.phase === "connecting" || native.error === "screen_service_updating"} onClick={() => void run(() => invoke("screen_service_retry", {}))}>{t("重试屏幕服务")}</button>}
    </div>}
    {!!status?.sessions.length && <div className="screen-active-sessions"><h4>{t("当前共享")}</h4>{status.sessions.map(session => <div className="screen-setting-row" key={session.id}><span>{session.deviceName}<small>{session.display.name} · {session.state === "controlling" ? t("正在控制") : t("查看中")}</small></span><button disabled={busy} onClick={() => void run(() => connection.screenStop(session.id))}>{t("断开")}</button></div>)}</div>}
    {status?.canManage && status.policy && <>
      {localMac && <div className="screen-system-permissions">
        <h4>{t("本机系统权限")}</h4>
        <div className="screen-permissions">
          {([
            { kind: "capture", name: t("屏幕录制"), label: t("设置屏幕录制权限"), detail: t("查看屏幕所需"), granted: permissions?.capture === "granted" },
            { kind: "accessibility", name: t("辅助功能"), label: t("设置辅助功能权限"), detail: t("远程控制所需"), granted: permissions?.accessibility },
            { kind: "input-monitoring", name: t("输入监控"), label: t("设置输入监控权限"), detail: t("远程控制所需"), granted: permissions?.inputMonitoring },
          ] as const).map(item => <div className="screen-permission-row" role="group" aria-label={item.name} key={item.kind}>
            <div><span>{item.name}</span><small>{item.detail}</small></div>
            <span className="screen-permission-value" data-ready={!!permissions && item.granted}>{!permissions ? t("未检测") : item.granted ? t("已授权") : t("未授权")}</span>
            <button aria-label={item.label} disabled={busy} onClick={() => void permission(item.kind)}>{t("设置")}</button>
          </div>)}
        </div>
        {permissionRequest && <div className="screen-permission-help" role="status">
          <p>{permissionRequest.opened ? t("已打开系统设置，是否授权以返回后的检测结果为准。") : t("已检查权限，请以当前检测结果为准。")}</p>
          {!requestedPermissionGranted && <>
            <p>{t("列表中没有 TaroBird 时，点击“+”，选择“应用程序”中当前安装的 TaroBird；不要选择旧备份、Node 或其他应用。")}</p>
            <p>{t("若 macOS 要求重新打开应用，请先保存当前工作，再退出并重新打开 TaroBird。打开设置页面不等于已授权。")}</p>
          </>}
        </div>}
      </div>}
      <details className="screen-device-permissions" ref={devicePermissions}>
        <summary>{t("设备授权")}</summary>
        <p>{t("配对和总开关不会自动授权设备。")}</p>
        {devices.map(device => <label className="screen-setting-row" data-current-device={device.id === connection.identity.deviceId} key={device.id}><span>{device.name}{device.id === connection.identity.deviceId && <small>{t("当前设备")}</small>}<small>{device.platform}</small></span><select aria-label={t("{0}的屏幕权限", device.name)} disabled={busy} value={status.policy!.grants.find(g => g.deviceId === device.id && g.publicKey === device.publicKey)?.permission ?? "none"} onChange={e => { const permission = e.target.value; void save({ ...status.policy!, grants: [...status.policy!.grants.filter(g => g.deviceId !== device.id), ...(permission === "none" ? [] : [{ deviceId: device.id, publicKey: device.publicKey, permission: permission as "view" | "control" }])] }); }}><option value="none">{t("不允许")}</option><option value="view">{t("仅查看")}</option><option value="control">{t("查看并控制")}</option></select></label>)}
      </details>
    </>}
    <details className="screen-permission-explanation"><summary>{t("权限说明")}</summary><p>{t("查看只需屏幕录制权限；远程控制还需辅助功能与输入监控。配对和总开关不会自动授权设备。")}</p></details>

  </section>;
}
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
