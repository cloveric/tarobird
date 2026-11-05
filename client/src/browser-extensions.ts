import { invoke, isElectron, listen } from "./desktop-bridge.js";

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

type Word = (zh: string, en: string) => string;
const FEATURES: Record<string, [string, string]> = {
  content_scripts: ["网页脚本和样式", "Page scripts and styles"], background: ["后台脚本", "Background script"], storage: ["本地存储", "Local storage"],
  unlimitedStorage: ["不限量存储", "Unlimited storage"], scripting: ["向网页注入脚本", "Script injection"], tabs: ["网页信息", "Page information"],
  idle: ["空闲状态", "Idle state"], alarms: ["定时任务", "Alarms"], management: ["扩展信息", "Extension information"],
  network_rules: ["广告/请求拦截规则", "Ad and request blocking rules"], toolbar: ["工具栏按钮和弹出窗口", "Toolbar button and popup"],
  options_page: ["扩展设置页", "Options page"], active_tab: ["点击按钮授权当前网页", "Click-to-allow current page"], context_menus: ["右键菜单", "Context menu items"],
  notifications: ["系统通知", "Notifications"], cookies: ["读取 Cookie", "Cookies"], downloads: ["下载管理", "Downloads"], identity: ["账号登录接口", "Sign-in (identity)"],
  native_messaging: ["与本机程序通信", "Native messaging"], debugger: ["调试器", "Debugger"], history: ["浏览历史", "History"], bookmarks: ["书签", "Bookmarks"],
  web_navigation: ["导航事件", "Navigation events"], offscreen: ["离屏文档", "Offscreen documents"], side_panel: ["侧边栏", "Side panel"],
  page_overrides: ["替换新标签页", "Page overrides"], shortcuts: ["键盘快捷键", "Keyboard shortcuts"], omnibox: ["地址栏关键字", "Omnibox"], devtools: ["开发者工具面板", "DevTools panel"],
};
export function extensionFeatureLabel(code: string, word: Word): string {
  const aliases: Record<string, string> = { webNavigation: "web_navigation", contextMenus: "context_menus" };
  const known = FEATURES[aliases[code] ?? code];
  return known ? word(known[0], known[1]) : code.startsWith("permission:") ? word(`权限 ${code.slice(11)}`, `Permission ${code.slice(11)}`) : code;
}
export function extensionErrorText(code: string, word: Word): string {
  return ({
    extensions_unavailable: word("此版本桌面 App 不支持扩展，请更新后再试。", "This desktop App version does not support extensions. Update and try again."),
    unknown_desktop_command: word("此版本桌面 App 不支持扩展，请更新后再试。", "This desktop App version does not support extensions. Update and try again."),
    extensions_unreadable: word("扩展列表文件无法读取，已停止加载扩展。文件已保留。", "The extension list could not be read, so no extensions are loaded. The file was kept."),
    manifest_missing: word("所选内容中没有 manifest.json，不是 Chrome 扩展。", "No manifest.json was found. This is not a Chrome extension."),
    manifest_invalid: word("manifest.json 格式无效（需要名称和版本号）。", "manifest.json is invalid (a name and version are required)."),
    manifest_key_invalid: word("manifest.json 中的 key 无效。", "The key in manifest.json is invalid."),
    manifest_version_unsupported: word("只支持 Manifest V2 或 V3 扩展。", "Only Manifest V2 or V3 extensions are supported."),
    extension_has_nothing_to_run: word("此扩展只有工具栏弹窗等 TaroBird 不支持的部分，安装后不会有任何作用，因此未安装。", "This extension only has parts TaroBird does not support (such as a toolbar popup), so it would do nothing. It was not installed."),
    crx_invalid: word("CRX 文件已损坏或格式不正确。", "The CRX file is damaged or malformed."),
    crx_version_unsupported: word("只支持 CRX3 格式的安装包。", "Only CRX3 packages are supported."),
    crx_signature_invalid: word("CRX 签名校验失败，文件可能被修改，未安装。", "The CRX signature did not verify. The file may have been modified, so it was not installed."),
    package_path_invalid: word("安装包包含不安全的文件路径，未安装。", "The package contains unsafe file paths. It was not installed."),
    package_symlink: word("扩展文件夹包含符号链接，未安装。请使用不含链接的文件夹。", "The folder contains symbolic links. Use a folder without links."),
    package_too_large: word("扩展超过安装包、解压大小或文件数量限制，未安装。", "The extension is too large (over package, unpacked size or file-count limits)."),
    package_format_unsupported: word("请选择 .crx、.zip 文件或已解压的扩展文件夹。", "Choose a .crx or .zip file, or an unpacked extension folder."),
    package_unreadable: word("无法读取所选文件。", "The selected file could not be read."),
    extension_limit: word("最多安装 50 个扩展。", "Up to 50 extensions can be installed."),
    extension_not_found: word("扩展已被移除。", "This extension was already removed."),
    extension_options_unavailable: word("此扩展未提供可用的独立设置页。", "This extension has no available options page."),
    extension_disabled: word("先启用扩展，再打开设置。", "Enable the extension before opening its settings."),
    extension_not_in_scope: word("此扩展仅用于个人浏览器，请在个人浏览器打开设置，或先调整运行位置。", "This extension runs only in the personal browser. Open settings there, or first change where it runs."),
    extension_not_loaded: word("扩展尚未在当前浏览器加载，请重新加载扩展后再打开设置。", "The extension is not loaded in this browser. Reload the extension, then open its settings."),
    extension_background_not_ready: word("扩展后台尚未启动完成，请稍后重试；仍失败时可重新加载扩展。", "The extension background is not ready. Try again shortly, or reload the extension if it still fails."),
    options_limit: word("最多同时打开 4 个扩展设置窗口，请先关闭一个。", "Up to 4 extension settings windows can be open. Close one first."),
    options_load_timeout: word("扩展设置页加载超时，请重试；仍失败时可重新加载扩展。", "The extension settings page timed out. Try again, or reload the extension if it still fails."),
    options_load_failed: word("扩展设置页无法加载，请重新加载扩展后重试。", "The extension settings page could not load. Reload the extension and try again."),
    options_closing: word("上一个扩展设置窗口仍在关闭，请稍后重试。", "The previous extension settings window is still closing. Try again shortly."),
    options_closed: word("扩展设置窗口已关闭。需要时可重新打开。", "The extension settings window was closed. You can open it again when needed."),
    extension_changed: word("扩展已在其他窗口更改，本次安装已取消。请重新发起安装并确认。", "The extension changed in another window, so this installation was cancelled. Start the installation again and review the changes."),
    extension_load_failed: word("扩展未能加载。可尝试重新加载或移除。", "The extension failed to load. Try reloading or removing it."),
    extension_id_mismatch: word("扩展加载后的 ID 与安装包不一致，已停止加载。", "The loaded extension ID did not match the package, so it was stopped."),
    store_address_invalid: word("请输入 Chrome 应用商店的扩展链接或 32 位扩展 ID。", "Enter a Chrome Web Store extension URL or its 32-character ID."),
    store_download_failed: word("无法下载扩展，请检查网络后重试。", "Could not download the extension. Check your connection and try again."),
    store_extension_unavailable: word("此扩展在应用商店中不可用，或不支持当前浏览器版本。", "This extension is unavailable in the store or for this browser version."),
    package_path_collision: word("安装包包含相互冲突的文件名，未安装。", "The package contains conflicting filenames. It was not installed."),
    package_changed: word("所选文件在读取时发生变化，请重新选择。", "The selected files changed while being read. Select them again."),
    package_encrypted: word("不支持加密的扩展安装包。", "Encrypted extension packages are not supported."),
    extension_id_reserved: word("此安装包使用了应用保留的标识，未安装。", "This package uses a reserved ID and was not installed."),
    extension_load_timeout: word("扩展加载超时，可稍后重新加载或移除。", "The extension timed out while loading. Retry later or remove it."),
    compatibility_unavailable: word("兼容模式未能启动，仍保留原来的网络保护。请重试。", "Compatibility mode could not start. Default network protection remains. Try again."),
    extensions_reset: word("浏览数据已清理，本次操作已取消。请重新打开目标浏览器。", "Browser data was cleared and this action was cancelled. Reopen the target browser."),
    extension_write_failed: word("无法保存扩展文件，请检查磁盘空间。", "The extension files could not be saved. Check disk space."),
  } as Record<string, string>)[code] ?? word("扩展操作失败。", "The extension action failed.");
}
