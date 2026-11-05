import { t } from "./i18n.js";
import type { LocalControllerIssue } from "./local-controller.js";
export function localControllerMessage(issue?: LocalControllerIssue): string {
  switch (issue) {
    case "redirected": return t("当前启动环境会重定向主机数据。请从开始菜单打开 TaroBird，或使用普通终端运行 CLI；原数据未修改。");
    case "directory_missing": return t("原主机数据目录暂时不可见。请检查目录位置或恢复原数据，不要重新初始化主机。");
    case "shadow_only": return t("原主机数据位于应用的隔离目录中，需要核对后恢复到桌面数据目录。未创建新身份。");
    case "conflict": return t("发现多份活动主机数据，已暂停本机启动。请核对目录冲突，不会自动覆盖或合并。");
    case "incomplete": return t("主机身份与数据库不完整。现有文件已保留，请先核对初始化或恢复记录；不会自动生成替代身份。");
    case "probe_failed": return t("无法确认 Windows 实际数据目录，已暂停本机启动。请检查安装包及目录访问权限。");
    case "foreign_runtime": return t("检测到另一进程占用本机主机入口，当前数据无法验证它。请先核对并停止原后台。");
    case "runtime_update_required": return t("正在运行的主机组件与此 App 不兼容，请更新主机组件。原身份、授权和聊天记录保留。");
    case "runtime_restart_required": return t("正在运行旧版主机，尚不支持自动安全切换。请等待任务结束后重启本机后台，无需重新配对。");
    case "runtime_waiting": return t("App 已更新，正在等待本机任务收尾后切换新版后台。当前任务不会被强制中断。");
    case "runtime_recovery_failed": return t("本机后台更新未完成，已停止自动切换。请在任务结束后重启本机后台；原身份和数据保留，无需重新初始化。");
    case "identity_changed": return t("当前目录返回了不同的主机身份。已保留原授权，请核对数据目录，不能自动替换身份。");
    case "credentials": return t("本机主机已找到，但设备安全凭据验证失败。正在自动重试，原授权和草稿保留。");
    case "keychain": return t("暂时无法读取系统保存的设备凭据。请检查系统钥匙串或凭据存储访问权限；原授权保留。");
    case "controller_failed": return t("本机控制连接尚未完成验证，正在重试。原授权和数据保留，暂时不要重新配对。");
    case "stopped": return t("本机主机已停止，自动恢复不会替你重新启用。其他主机仍可使用。");
    default: return t("本机后台尚未恢复，正在自动重试。其他主机仍可使用。");
  }
}
