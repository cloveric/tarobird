import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, Package, RotateCw, Settings, Trash2 } from "lucide-react";
import type { BrowserScope } from "./workbench-browser.js";
import { PERSONAL_BROWSER_SCOPE } from "../shared/personal-browser.mjs";
import { extensionCommand, extensionErrorText, extensionFeatureLabel, onExtensionsChanged, type BrowserExtension } from "./browser-extensions.js";

/** Main owns installation, permission review and scope changes. This panel is
 * keyed to the page's scope by its parent, so a late reply cannot switch hosts. */
export function BrowserExtensionsManager({ scope, personal, word, onClose, onBusyChange }: {
  scope: BrowserScope; personal: boolean; word(zh: string, en: string): string; onClose(): void; onBusyChange(busy: boolean): void;
}) {
  const [extensions, setExtensions] = useState<BrowserExtension[]>(), [compat, setCompat] = useState<{ enabled: boolean; active: boolean; error?: string }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [notice, setNotice] = useState<string>(), [store, setStore] = useState("");
  const [removing, setRemoving] = useState<string>();
  const mounted = useRef(false), pending = useRef(false), reading = useRef(0), english = word("zh", "en") === "en";
  const refresh = useCallback(async () => {
    const sequence = ++reading.current;
    try {
      const [list, mode] = await Promise.all([extensionCommand("list"), extensionCommand("compat", { scope })]);
      if (!mounted.current || sequence !== reading.current) return;
      if (list.status !== "ok") throw new Error(list.error ?? "extension_action_failed");
      if (mode.status !== "ok" || typeof mode.enabled !== "boolean" || typeof mode.active !== "boolean") throw new Error(mode.error ?? "extensions_unavailable");
      setExtensions(list.extensions ?? []); setCompat({ enabled: mode.enabled, active: mode.active, error: mode.error });
    } catch (cause) { if (mounted.current && sequence === reading.current) setError(cause instanceof Error ? cause.message : "extension_action_failed"); }
  }, [scope]);
  useEffect(() => {
    mounted.current = true; void refresh();
    let stop: (() => void) | undefined, cancelled = false;
    void onExtensionsChanged(() => void refresh()).then(remove => { if (cancelled) remove(); else stop = remove; }, () => {});
    return () => { mounted.current = false; cancelled = true; reading.current++; stop?.(); };
  }, [refresh]);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  const run = async (action: "install" | "set" | "reload" | "remove" | "compat_set" | "options", fields: Record<string, unknown>, done?: (extension?: BrowserExtension) => string | undefined) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const result = await extensionCommand(action, fields);
      if (!mounted.current) return;
      if (result.status === "cancelled") { if (result.error) setNotice(extensionErrorText(result.error, word)); await refresh(); return; }
      if (result.status !== "ok") throw new Error(result.error ?? "extension_action_failed");
      setNotice(done?.(result.extension)); await refresh();
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "extension_action_failed"); }
    finally { pending.current = false; if (mounted.current) { setBusy(false); setRemoving(undefined); } }
  };
  const install = (source: "folder" | "file" | "store") => void run("install", { source, ...(source === "store" ? { store: store.trim() } : {}), english }, extension => extension && word(`已添加“${extension.name}”。请刷新网页，并检查下方兼容性信息。`, `Added “${extension.name}”. Reload the page and review compatibility details below.`));
  return <div className="browser-extensions">
    <p className="browser-tools-hint">{word("安装方法：复制扩展的 Chrome 应用商店链接，粘贴到下方，点「从应用商店添加」并确认权限。商店网页里的「添加至 Chrome」按钮在 TaroBird 中不可用。", "To install: copy the extension’s Chrome Web Store URL, paste it below, choose “Add from Web Store”, then review and confirm its permissions. The store page’s “Add to Chrome” button does not work in TaroBird.")}</p>
    <p className="browser-tools-hint">{word("扩展保存在此设备，默认用于个人浏览器。可另行允许它在对话网页中运行；Bot 无法安装或管理扩展。", "Extensions are saved on this device and run in the personal browser by default. You can also allow conversation webpages. Bots cannot install or manage extensions.")}</p>
    <form className="browser-extension-store" onSubmit={event => { event.preventDefault(); if (store.trim()) install("store"); }}>
      <label>{word("Chrome 应用商店链接或扩展 ID", "Chrome Web Store URL or extension ID")}<input value={store} maxLength={2048} disabled={busy} onChange={event => setStore(event.target.value)} placeholder="https://chromewebstore.google.com/detail/…" spellCheck={false}/></label>
      <button type="submit" disabled={busy || !store.trim()}>{word("从应用商店添加", "Add from Web Store")}</button>
    </form>
    <details className="browser-extension-local"><summary>{word("从本地文件添加", "Add from local files")}</summary><div className="browser-extensions-actions"><button type="button" disabled={busy} onClick={() => install("folder")}><FolderOpen size={15}/>{word("已解压的文件夹…", "Unpacked folder…")}</button><button type="button" disabled={busy} onClick={() => install("file")}><Package size={15}/>{word(".crx / .zip 安装包…", ".crx / .zip package…")}</button></div></details>
    <section className="browser-extension-compat" aria-label={word("扩展兼容模式", "Extension compatibility mode")}>
      <label className="browser-checkbox"><input type="checkbox" checked={compat?.enabled ?? false} disabled={busy || !compat} onChange={event => void run("compat_set", { scope, enabled: event.target.checked, english })}/>{word("扩展兼容模式", "Extension compatibility mode")}</label>
      <p>{personal ? word("仅此设备的个人浏览器", "Only this device’s personal browser") : word("仅此设备当前对话的网页", "Only this conversation’s webpages on this device")} · {compat?.active ? word("已开启", "On") : compat?.enabled ? word("尚未生效", "Not active") : word("默认关闭", "Off by default")}</p>
      <p className="browser-tools-hint">{word("安装扩展无需开启此模式。它用于安装后的广告拦截等网络规则，不会启用商店网页的安装按钮。", "You do not need this mode to install extensions. It enables network rules such as ad blocking after installation; it does not enable the store page’s install button.")}</p>
      <p className="browser-tools-hint">{word("开启后，已安装扩展的后台脚本和设置页可访问本机和局域网服务。开启前会再次说明并确认。", "When enabled, installed extensions’ background scripts and settings pages can access local and LAN services. You will review and confirm this before enabling it.")}</p>
      {compat?.active && extensions && !extensions.some(extension => extension.enabled && (personal || extension.scope === "all")) && <p className="browser-tools-hint">{word("兼容模式已开启，但当前浏览器没有获准运行的已启用扩展。请检查下方的「运行位置」。", "Compatibility mode is on, but no enabled extension is allowed in this browser. Check Runs in below.")}</p>}
      {compat?.error && <p role="alert" className="browser-tools-feedback is-error">{extensionErrorText(compat.error, word)} <button disabled={busy} onClick={() => void run("compat_set", { scope, enabled: true, english })}>{word("重试", "Retry")}</button></p>}
    </section>
    {busy && <p role="status">{word("正在处理，请完成弹出的选择或确认…", "Working. Complete any open selection or confirmation…")}</p>}
    {error && <p role="alert" className="browser-tools-feedback is-error">{extensionErrorText(error, word)} <button disabled={busy} onClick={() => { setError(undefined); void refresh(); }}>{word("重新读取", "Reload list")}</button></p>}{notice && <p role="status" className="browser-tools-feedback">{notice}</p>}
    {!extensions ? !error && <p role="status">{word("正在读取…", "Loading…")}</p> : !extensions.length ? <p>{word("尚未添加扩展", "No extensions added")}</p> :
    <ul className="browser-extension-list">{extensions.map(extension => {
      const applies = personal || extension.scope === "all";
      const personalSettings = !applies;
      const needsNetworkRules = extension.report.features.some(item => item.code === "network_rules" && item.status === "not_enforced");
      const runStatus = !extension.enabled ? word("已停用", "Disabled") : !applies ? word("当前网页未授权", "Not allowed in this browser") : word("已启用", "Enabled");
      const optionsHint = extension.optionsAvailable === undefined ? word("更新桌面 App 后可使用扩展设置。", "Update the desktop App to open extension settings.")
        : !extension.optionsAvailable ? word("此扩展未提供可用的独立设置页。", "This extension has no available options page.")
        : !extension.enabled ? word("先启用扩展，再打开设置。", "Enable the extension before opening its settings.") : undefined;
      const groups = (["supported", "not_enforced", "unavailable"] as const).map(status => [status, extension.report.features.filter(item => item.status === status)] as const).filter(([, items]) => items.length);
      return <li key={extension.id} data-extension={extension.id}>
        <div className="browser-extension-head">
          <div className="browser-extension-identity"><strong>{extension.name}</strong><div className="browser-extension-meta"><small>{extension.version}</small><span>{runStatus}</span></div></div>
          <label className="browser-checkbox browser-extension-toggle"><input type="checkbox" checked={extension.enabled} disabled={busy} onChange={event => void run("set", { id: extension.id, enabled: event.target.checked }, entry => entry?.enabled ? word("扩展已启用，请刷新需要使用它的网页。", "Extension enabled. Reload the webpages where you want to use it.") : undefined)}/>{word("启用", "Enabled")}</label>
        </div>
        <label className="browser-extension-scope"><span>{word("运行位置", "Runs in")}</span><select value={extension.scope} disabled={busy} onChange={event => void run("set", { id: extension.id, scope: event.target.value, english }, () => word("运行位置已更新，请刷新需要使用扩展的网页。", "Browser access updated. Reload the webpages where you want to use the extension."))}><option value="personal">{word("仅个人浏览器", "Personal browser only")}</option><option value="all">{word("个人浏览器和对话网页", "Personal browser and conversation webpages")}</option></select></label>
        {!applies && <p className="browser-tools-hint">{word("此扩展不会在当前对话网页运行。若要用于此处，将「运行位置」改为「个人浏览器和对话网页」并确认权限；开启兼容模式不会授予运行权限。", "This extension does not run in this conversation’s webpages. To use it here, change Runs in to Personal browser and conversation webpages, then confirm access. Compatibility mode does not grant this access.")}</p>}
        {extension.enabled && applies && needsNetworkRules && compat && !compat.active && <p className="browser-tools-hint">{compat.enabled ? word("此浏览器的网络拦截尚未生效，请查看上方兼容模式提示。", "Network blocking is not active in this browser. Check the compatibility-mode notice above.") : word("此浏览器尚未开启网络拦截。广告请求拦截需要在上方开启「扩展兼容模式」并确认；开启后刷新网页。", "Network blocking is off in this browser. To block ad requests, enable Extension compatibility mode above, review the confirmation, then reload the webpage.")}</p>}
        {extension.error && <p role="alert" className="browser-tools-feedback is-error">{extensionErrorText(extension.error, word)}</p>}
        <div className="browser-extension-controls">
          <button type="button" disabled={busy || !!optionsHint} aria-label={personalSettings ? word(`在个人浏览器中设置 ${extension.name}`, `Personal browser settings for ${extension.name}`) : word(`设置 ${extension.name}`, `Settings for ${extension.name}`)} title={optionsHint} onClick={() => void run("options", { id: extension.id, scope: personalSettings ? PERSONAL_BROWSER_SCOPE : scope, english })}><Settings size={14}/>{word("设置", "Settings")}</button>
          <button type="button" disabled={busy} aria-label={word(`重新加载 ${extension.name}`, `Reload ${extension.name}`)} onClick={() => void run("reload", { id: extension.id })}><RotateCw size={14}/>{word("重新加载", "Reload")}</button>
          {removing === extension.id ? <><button type="button" className="danger browser-extension-remove" disabled={busy} onClick={() => void run("remove", { id: extension.id }, () => word(`已移除“${extension.name}”。`, `Removed “${extension.name}”.`))}>{word("确认移除", "Confirm remove")}</button><button type="button" disabled={busy} onClick={() => setRemoving(undefined)}>{word("取消", "Cancel")}</button></>
            : <button type="button" className="browser-extension-remove" disabled={busy} aria-label={word(`移除 ${extension.name}`, `Remove ${extension.name}`)} onClick={() => setRemoving(extension.id)}><Trash2 size={14}/>{word("移除", "Remove")}</button>}
        </div>
        <p className="browser-tools-hint">{optionsHint ?? (personal || personalSettings ? word("设置仅影响此设备的个人浏览器。", "Settings apply only to this device’s personal browser.") : word("设置仅影响此设备当前对话的网页。", "Settings apply only to this conversation’s webpages on this device."))}</p>
        <details className="browser-extension-details"><summary>{word("权限与兼容性", "Permissions and compatibility")}</summary>{extension.report.description && <p>{extension.report.description}</p>}
          <p className="browser-tools-hint">{extension.signature === "store" ? word("已验证 Chrome 应用商店签名。", "Chrome Web Store signature verified.") : extension.signature === "developer" ? word("已验证开发者签名。", "Developer signature verified.") : word("本地未签名安装包。", "Local unsigned package.")}</p>
          <p className="browser-tools-hint">{extension.report.hostAccess === "all" ? word("可读取和更改它所运行网页中的所有网站。", "Can read and change all websites in pages where it runs.") : extension.report.hostAccess === "some" ? word(`可读取和更改：${extension.report.hosts.join("，")}`, `Can read and change: ${extension.report.hosts.join(", ")}`) : word("未声明网站内容访问权限。", "No website-content access declared.")}</p>
          <dl className="browser-extension-features">{groups.map(([status, items]) => <div key={status}><dt>{status === "supported" ? word("已适配", "Supported interfaces") : status === "not_enforced" ? !extension.enabled ? word("需先启用扩展", "Enable extension first") : !applies ? word("需先授权此浏览器", "Browser access required") : compat?.active ? word("兼容模式已启用", "Compatibility mode active") : word("需兼容模式", "Needs compatibility mode") : word("尚不支持", "Not supported")}</dt><dd>{items.map(item => extensionFeatureLabel(item.code, word)).join(word("、", ", "))}</dd></div>)}</dl>
          <p className="browser-tools-hint">{word("以上为功能声明检查，实际效果还取决于扩展本身和目标网站。", "This checks declared features. Actual behavior also depends on the extension and website.")}</p>
          {extension.report.warnings.length > 0 && <details><summary>{word("加载提示", "Load warnings")}</summary><ul>{extension.report.warnings.map(line => <li key={line}>{line}</li>)}</ul></details>}
        </details>
      </li>;
    })}</ul>}
    <footer><button type="button" disabled={busy} onClick={onClose}>{word("关闭", "Close")}</button></footer>
  </div>;
}
