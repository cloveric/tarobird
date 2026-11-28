import { t } from "./i18n.js";

/** Chinese source text for each remote screen reason code. Every screen
 * surface (desktop settings and viewer, later the phone viewer) explains a code
 * with this one table; `screenError` translates the entry at display time.
 * `check-translations` only sees literal `t("…")` calls, so a unit test keeps
 * every entry translated. */
export const SCREEN_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
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
  screen_mobile_update_required: "请更新此设备上的 TaroBird，以使用手机屏幕查看器。",
  screen_mobile_decoder_unavailable: "此设备暂不支持屏幕视频解码，请更新手机 App 或系统后重试。",
  screen_connection_changed: "屏幕连接已关闭。请重新连接，再单独开始控制。",
  screen_native_inactive: "App 已进入后台或设备已锁定。返回后请重新连接，再单独开始控制。",
  screen_inactive: "App 已进入后台或设备已锁定。返回后请重新连接，再单独开始控制。",
  screen_background: "App 已进入后台或设备已锁定。返回后请重新连接，再单独开始控制。",
  screen_viewer_congested: "连接拥塞，屏幕已断开。请检查线路后重新连接。",
  screen_control_backpressure: "连接拥塞，屏幕已断开。请检查线路后重新连接。",
  screen_network_closed: "屏幕连接已关闭。请重新连接，再单独开始控制。",
  screen_socket_closed: "屏幕连接已关闭。请重新连接，再单独开始控制。",
  screen_control_closed: "屏幕连接已关闭。请重新连接，再单独开始控制。",
  screen_socket_failed: "屏幕连接已关闭。请重新连接，再单独开始控制。",
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
  screen_stale_record_invalid: "上次远程控制的按键记录无法读取，控制已暂停。请在受控电脑注销并重新登录；若仍未恢复，需检查本机记录。",
  screen_service_unavailable: "屏幕服务不可用，请检查本机桌面版是否完整安装。",
  screen_quality_unsupported: "目标 Mac 的 App 暂不支持画质选择，请更新后重试，或以默认画质连接。",
  screen_quality_qhd_unsupported: "目标电脑的 App 暂不支持 2K，请更新后重试，或选择其他清晰度。",
  screen_quality_qhd_host_unsupported: "主机暂不支持 2K，请更新后重试，或选择其他清晰度。",
  screen_quality_qhd_decoder_unavailable: "此设备不支持 2K 解码，请选择其他清晰度。",
  screen_quality_decoder_unavailable: "此设备不支持最高 3K 解码，请选择较低的可用清晰度。",
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
  // Terminal reasons the Host, a native mobile session or the viewer can end a
  // connection with. Mobile now keeps the Host's validated close reason, so
  // each needs its own sentence instead of the generic text with a code.
  screen_permission_revoked: "远程屏幕已关闭，或此设备的授权已撤销。请检查目标电脑的授权后重新连接。",
  screen_stopped: "主机已停止这次屏幕连接，需要时可重新连接。",
  screen_host_stopped: "主机已停止运行，屏幕连接已断开。请在主机恢复后重新连接。",
  device_revoked: "此设备与主机的配对已被撤销，请重新配对后再连接。",
  screen_disconnected: "屏幕连接已断开。",
  screen_stream_invalid: "屏幕画面数据异常，连接已断开，请重新连接。",
  screen_frame_invalid_or_stale: "屏幕画面数据异常，连接已断开，请重新连接。",
  screen_generation_exhausted: "屏幕画面数据异常，连接已断开，请重新连接。",
  screen_input_rate_limited: "输入过于频繁，屏幕连接已断开，请重新连接。",
  screen_desktop_changed: "目标电脑的桌面服务已变更，请重新连接。",
  screen_clock_or_sleep_changed: "主机时钟发生变化或刚从睡眠中唤醒，屏幕连接已断开，请重新连接。",
  screen_service_timeout: "目标电脑的桌面服务没有响应，屏幕连接已断开，请重新连接。",
  screen_attach_timeout: "屏幕连接超时，请检查目标 Mac 和当前线路。",
  screen_socket_timeout: "屏幕连接超时，请检查目标 Mac 和当前线路。",
  screen_open_failed: "无法建立屏幕连接，请检查线路后重新连接。",
  screen_session_changed: "屏幕连接已变更，请重新连接。",
  screen_decoder_congested: "画面解码跟不上，屏幕已断开。请重新连接，或改用 720p。",
  screen_canvas_unavailable: "无法显示屏幕画面，请重新连接。",
  screen_service_stopped: "目标电脑已停止屏幕共享，需要时可重新连接。",
  screen_capture_failed: "目标电脑的屏幕采集失败，请重新连接。",
  screen_input_failed: "目标电脑的远程输入失败，控制已停止。请重新连接。",
  screen_channel_closed: "屏幕连接已关闭。请重新连接，再单独开始控制。",
  screen_input_stale: "控制已暂停，请等待新画面后重新开始控制。",
  screen_renew_expired: "控制授权已过期，请重新点击开始控制。",
  screen_packet_invalid: "屏幕服务协议不兼容，请检查 App 与主机版本后重试。",
  screen_attach_invalid: "屏幕服务协议不兼容，请检查 App 与主机版本后重试。",
  screen_receipt_invalid: "屏幕服务协议不兼容，请检查 App 与主机版本后重试。",
  screen_read_invalid: "屏幕服务协议不兼容，请检查 App 与主机版本后重试。",
  screen_join_invalid: "屏幕服务协议不兼容，请检查 App 与主机版本后重试。",
  screen_quality_invalid: "屏幕服务协议不兼容，请检查 App 与主机版本后重试。",
  screen_scope_invalid: "屏幕服务协议不兼容，请检查 App 与主机版本后重试。",
  screen_command_invalid: "屏幕服务协议不兼容，请检查 App 与主机版本后重试。",
});
/** The reasons whose sentence names a Mac or a Mac permission, for a
 * controlled computer that runs Windows. Windows has no screen-recording or
 * accessibility grant: what stops viewing there is the lock screen or a
 * security prompt, and what stops input is that or a window run as
 * administrator. The sentences say what can be done, not which of these it was;
 * Windows does not tell. Every other reason reads the same for both. */
export const SCREEN_ERROR_MESSAGES_WINDOWS: Readonly<Record<string, string>> = Object.freeze({
  screen_quality_unsupported: "目标电脑的 App 暂不支持画质选择，请更新后重试，或以默认画质连接。",
  screen_display_unavailable: "目标电脑没有可用显示器。",
  screen_disabled: "请先在目标电脑开启允许远程屏幕。",
  screen_not_authorized: "请在目标电脑的远程屏幕设置中授权此设备。",
  screen_capture_denied: "目标电脑已锁定或正在显示安全提示，请在那台电脑上处理后重新连接。",
  screen_service_offline: "主机在线，但桌面服务未运行。请在目标电脑打开 TaroBird。",
  screen_locked: "目标电脑已锁定或正在显示安全提示，请在那台电脑上处理后重新连接。",
  screen_connect_timeout: "屏幕连接超时，请检查目标电脑和当前线路。",
  screen_network_timeout: "屏幕连接超时，请检查目标电脑和当前线路。",
  screen_accessibility_denied: "目标电脑暂时不接受远程输入，请稍后再点击开始控制。",
  screen_control_not_authorized: "请在目标电脑的远程屏幕设置中允许此设备查看并控制。",
  screen_control_revoked: "请在目标电脑的远程屏幕设置中允许此设备查看并控制。",
  screen_takeover_unavailable: "目标电脑无法确认是否有人在本机操作，控制已停止。请重新点击开始控制。",
  screen_input_denied: "目标电脑没有接受远程输入，控制已停止。以管理员身份运行的窗口和安全提示不能被远程控制。",
  screen_control_timeout: "目标电脑未确认控制，请稍后重试。",
  screen_attach_timeout: "屏幕连接超时，请检查目标电脑和当前线路。",
  screen_socket_timeout: "屏幕连接超时，请检查目标电脑和当前线路。",
});
/** For a controlled computer whose platform is unknown (the Host keeps desktop
 * metadata private, or none was read for this Host), nothing may assume a Mac
 * or a Windows-only cause. The Windows sentence is used where it names neither;
 * these replace the ones that describe Windows' lock screen, consent prompts or
 * elevated windows. A known platform keeps its own sentences. */
export const SCREEN_ERROR_MESSAGES_UNKNOWN_TARGET: Readonly<Record<string, string>> = Object.freeze({
  screen_capture_denied: "目标电脑暂时无法共享屏幕，请在那台电脑上检查后重新连接。",
  screen_locked: "目标电脑已锁定或暂时无法查看，请在那台电脑上处理后重新连接。",
  screen_accessibility_denied: "目标电脑暂时不接受远程输入，请在那台电脑上检查后再开始控制。",
  screen_input_denied: "目标电脑没有接受远程输入，控制已停止。请在那台电脑上检查后重试。",
});
/** Host/native reasons are snake_case codes. Anything else is client or
 * platform text (e.g. "The request was aborted.") and is never displayed. */
export const isScreenReasonCode = (reason: string) => /^[a-z][a-z0-9_]*$/.test(reason);
export function screenError(reason: string, target: "macos" | "windows" | "unknown" = "macos") {
  const specific = target === "windows" ? SCREEN_ERROR_MESSAGES_WINDOWS[reason]
    : target === "unknown" ? SCREEN_ERROR_MESSAGES_UNKNOWN_TARGET[reason] ?? SCREEN_ERROR_MESSAGES_WINDOWS[reason] : undefined;
  const message = specific || SCREEN_ERROR_MESSAGES[reason];
  if (message) return t(message);
  // An unknown code stays visible for support; an ordinary disconnect is only the localized sentence.
  return isScreenReasonCode(reason) ? `${t("屏幕连接已结束，请检查主机状态后重试。")} (${reason.slice(0,120)})` : t("屏幕连接已结束，请检查主机状态后重试。");
}
