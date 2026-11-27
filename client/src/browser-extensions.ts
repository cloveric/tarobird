import { invoke, isElectron, listen } from "./desktop-bridge.js";
import { t } from "./i18n.js";

// The person's Chrome extensions for workbench pages. A trusted desktop command
// separate from `workbench_browser`, so no Bot request path can reach it.
export type ExtensionFeature = { code: string; status: "supported" | "not_enforced" | "unavailable" };
export type ExtensionReport = { manifestVersion: 2 | 3; description: string; hostAccess: "all" | "some" | "none"; hosts: string[]; features: ExtensionFeature[]; verdict: "works" | "limited"; warnings: string[] };
export type BrowserExtension = { id: string; name: string; version: string; enabled: boolean; scope: "personal" | "all"; source: "folder" | "zip" | "crx" | "store"; signature: "store" | "developer" | "none"; installedAt: number; loaded: number; optionsAvailable?: boolean; error?: string; report: ExtensionReport };
export type ExtensionResult = { status: "ok" | "cancelled" | "failed"; error?: string; extension?: BrowserExtension; extensions?: BrowserExtension[]; enabled?: boolean; active?: boolean };

const text = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : "";
function readReport(value: unknown): ExtensionReport | undefined {
  const raw = value as Partial<ExtensionReport> | null;
  if (!raw || typeof raw !== "object" || (raw.manifestVersion !== 2 && raw.manifestVersion !== 3)) return undefined;
  const statuses = new Set(["supported", "not_enforced", "unavailable"]);
  return { manifestVersion: raw.manifestVersion, description: text(raw.description, 512), hostAccess: raw.hostAccess === "all" || raw.hostAccess === "some" ? raw.hostAccess : "none",
    hosts: Array.isArray(raw.hosts) ? raw.hosts.map(item => text(item, 256)).filter(Boolean).slice(0, 8) : [],
    features: Array.isArray(raw.features) ? raw.features.filter((item): item is ExtensionFeature => !!item && typeof item.code === "string" && statuses.has(item.status)).slice(0, 64) : [],
    verdict: raw.verdict === "works" ? "works" : "limited", warnings: Array.isArray(raw.warnings) ? raw.warnings.map(item => text(item, 256)).filter(Boolean).slice(0, 16) : [] };
}
export function readExtension(value: unknown): BrowserExtension | undefined {
  const raw = value as Partial<BrowserExtension> | null, report = readReport(raw?.report);
  if (!raw || typeof raw.id !== "string" || !/^[a-p]{32}$/.test(raw.id) || !report) return undefined;
  return { id: raw.id, name: text(raw.name, 128) || raw.id, version: text(raw.version, 32), enabled: raw.enabled === true, scope: raw.scope === "all" ? "all" : "personal",
    source: raw.source === "crx" || raw.source === "zip" || raw.source === "store" ? raw.source : "folder", signature: raw.signature === "store" || raw.signature === "developer" ? raw.signature : "none", installedAt: typeof raw.installedAt === "number" ? raw.installedAt : 0,
    loaded: typeof raw.loaded === "number" ? raw.loaded : 0, ...(typeof raw.optionsAvailable === "boolean" ? { optionsAvailable: raw.optionsAvailable } : {}), ...(typeof raw.error === "string" ? { error: raw.error.slice(0, 64) } : {}), report };
}

export const extensionsSupported = () => isElectron();
export async function extensionCommand(action: "list" | "install" | "set" | "reload" | "remove" | "compat" | "compat_set" | "options", fields: Record<string, unknown> = {}): Promise<ExtensionResult> {
  const result = await invoke<ExtensionResult>("workbench_browser_extensions", { action, ...fields });
  return { status: result?.status === "ok" || result?.status === "cancelled" ? result.status : "failed", ...(typeof result?.error === "string" ? { error: result.error } : {}),
    ...(result?.extension ? { extension: readExtension(result.extension) } : {}),
    ...(typeof result?.enabled === "boolean" ? { enabled: result.enabled } : {}), ...(typeof result?.active === "boolean" ? { active: result.active } : {}),
    ...(Array.isArray(result?.extensions) ? { extensions: result.extensions.map(readExtension).filter((item): item is BrowserExtension => !!item) } : {}) };
}
/** Any window's change (install, toggle, removal, reset) refreshes open lists. */
export function onExtensionsChanged(receive: () => void): Promise<() => void> {
  if (!isElectron()) return Promise.resolve(() => undefined);
  return listen<{ kind?: string }>("workbench-browser", event => { if (event.payload?.kind === "extensions") receive(); });
}

const featureLabel = (code: string): string | undefined => ({
  content_scripts: t("网页脚本和样式"), background: t("后台脚本"), storage: t("本地存储"),
  unlimitedStorage: t("不限量存储"), scripting: t("向网页注入脚本"), tabs: t("网页信息"),
  idle: t("空闲状态"), alarms: t("定时任务"), management: t("扩展信息"),
  network_rules: t("广告/请求拦截规则"), toolbar: t("工具栏按钮和弹出窗口"),
  options_page: t("扩展设置页"), active_tab: t("点击按钮授权当前网页"), context_menus: t("右键菜单"),
  notifications: t("系统通知"), cookies: t("读取 Cookie"), downloads: t("下载管理"), identity: t("账号登录接口"),
  native_messaging: t("与本机程序通信"), debugger: t("调试器"), history: t("浏览历史"), bookmarks: t("书签"),
  web_navigation: t("导航事件"), offscreen: t("离屏文档"), side_panel: t("侧边栏"),
  page_overrides: t("替换新标签页"), shortcuts: t("键盘快捷键"), omnibox: t("地址栏关键字"), devtools: t("开发者工具面板"),
} as Record<string, string>)[code];
export function extensionFeatureLabel(code: string): string {
  const aliases: Record<string, string> = { webNavigation: "web_navigation", contextMenus: "context_menus" };
  return featureLabel(aliases[code] ?? code) ?? (code.startsWith("permission:") ? t("权限 {0}", code.slice(11)) : code);
}
export function extensionErrorText(code: string): string {
  return ({
    extensions_unavailable: t("此版本桌面 App 不支持扩展，请更新后再试。"),
    unknown_desktop_command: t("此版本桌面 App 不支持扩展，请更新后再试。"),
    extensions_unreadable: t("扩展列表文件无法读取，已停止加载扩展。文件已保留。"),
    manifest_missing: t("所选内容中没有 manifest.json，不是 Chrome 扩展。"),
    manifest_invalid: t("manifest.json 格式无效（需要名称和版本号）。"),
    manifest_key_invalid: t("manifest.json 中的 key 无效。"),
    manifest_version_unsupported: t("只支持 Manifest V2 或 V3 扩展。"),
    extension_has_nothing_to_run: t("此扩展只有工具栏弹窗等 TaroBird 不支持的部分，安装后不会有任何作用，因此未安装。"),
    crx_invalid: t("CRX 文件已损坏或格式不正确。"),
    crx_version_unsupported: t("只支持 CRX3 格式的安装包。"),
    crx_signature_invalid: t("CRX 签名校验失败，文件可能被修改，未安装。"),
    package_path_invalid: t("安装包包含不安全的文件路径，未安装。"),
    package_symlink: t("扩展文件夹包含符号链接，未安装。请使用不含链接的文件夹。"),
    package_too_large: t("扩展超过安装包、解压大小或文件数量限制，未安装。"),
    package_format_unsupported: t("请选择 .crx、.zip 文件或已解压的扩展文件夹。"),
    package_unreadable: t("无法读取所选文件。"),
    extension_limit: t("最多安装 50 个扩展。"),
    extension_not_found: t("扩展已被移除。"),
    extension_options_unavailable: t("此扩展未提供可用的独立设置页。"),
    extension_disabled: t("先启用扩展，再打开设置。"),
    extension_not_in_scope: t("此扩展仅用于个人浏览器，请在个人浏览器打开设置，或先调整运行位置。"),
    extension_not_loaded: t("扩展尚未在当前浏览器加载，请重新加载扩展后再打开设置。"),
    extension_background_not_ready: t("扩展后台尚未启动完成，请稍后重试；仍失败时可重新加载扩展。"),
    options_limit: t("最多同时打开 4 个扩展设置窗口，请先关闭一个。"),
    options_load_timeout: t("扩展设置页加载超时，请重试；仍失败时可重新加载扩展。"),
    options_load_failed: t("扩展设置页无法加载，请重新加载扩展后重试。"),
    options_closing: t("上一个扩展设置窗口仍在关闭，请稍后重试。"),
    options_closed: t("扩展设置窗口已关闭。需要时可重新打开。"),
    extension_changed: t("扩展已在其他窗口更改，本次安装已取消。请重新发起安装并确认。"),
    extension_load_failed: t("扩展未能加载。可尝试重新加载或移除。"),
    extension_id_mismatch: t("扩展加载后的 ID 与安装包不一致，已停止加载。"),
    store_address_invalid: t("请输入 Chrome 应用商店的扩展链接或 32 位扩展 ID。"),
    store_download_failed: t("无法下载扩展，请检查网络后重试。"),
    store_extension_unavailable: t("此扩展在应用商店中不可用，或不支持当前浏览器版本。"),
    package_path_collision: t("安装包包含相互冲突的文件名，未安装。"),
    package_changed: t("所选文件在读取时发生变化，请重新选择。"),
    package_encrypted: t("不支持加密的扩展安装包。"),
    extension_id_reserved: t("此安装包使用了应用保留的标识，未安装。"),
    extension_load_timeout: t("扩展加载超时，可稍后重新加载或移除。"),
    compatibility_unavailable: t("兼容模式未能启动，仍保留原来的网络保护。请重试。"),
    extensions_reset: t("浏览数据已清理，本次操作已取消。请重新打开目标浏览器。"),
    extension_write_failed: t("无法保存扩展文件，请检查磁盘空间。"),
  } as Record<string, string>)[code] ?? t("扩展操作失败。");
}
