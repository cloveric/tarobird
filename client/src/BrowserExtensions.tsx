import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, Package, RotateCw, Settings, Trash2 } from "lucide-react";
import type { BrowserScope } from "./workbench-browser.js";
import { PERSONAL_BROWSER_SCOPE } from "../shared/personal-browser.mjs";
import { extensionCommand, extensionErrorText, extensionFeatureLabel, onExtensionsChanged, type BrowserExtension } from "./browser-extensions.js";
import { formatList, t, useLocale } from "./i18n.js";

/** Main owns installation, permission review and scope changes. This panel is
 * keyed to the page's scope by its parent, so a late reply cannot switch hosts. */
export function BrowserExtensionsManager({ scope, personal, onClose, onBusyChange }: {
  scope: BrowserScope; personal: boolean; onClose(): void; onBusyChange(busy: boolean): void;
}) {
  const locale = useLocale();
  const [extensions, setExtensions] = useState<BrowserExtension[]>(), [compat, setCompat] = useState<{ enabled: boolean; active: boolean; error?: string }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [notice, setNotice] = useState<string>(), [store, setStore] = useState("");
  const [removing, setRemoving] = useState<string>();
  const mounted = useRef(false), pending = useRef(false), reading = useRef(0), english = locale === "en";
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
      if (result.status === "cancelled") { if (result.error) setNotice(extensionErrorText(result.error)); await refresh(); return; }
      if (result.status !== "ok") throw new Error(result.error ?? "extension_action_failed");
      setNotice(done?.(result.extension)); await refresh();
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "extension_action_failed"); }
    finally { pending.current = false; if (mounted.current) { setBusy(false); setRemoving(undefined); } }
  };
  const install = (source: "folder" | "file" | "store") => void run("install", { source, ...(source === "store" ? { store: store.trim() } : {}), english, locale }, extension => extension && t("已添加“{0}”。请刷新网页，并检查下方兼容性信息。", extension.name));
  return <div className="browser-extensions">
    <p className="browser-tools-hint">{t("安装方法：复制扩展的 Chrome 应用商店链接，粘贴到下方，点「从应用商店添加」并确认权限。商店网页里的「添加至 Chrome」按钮在 TaroBird 中不可用。")}</p>
    <p className="browser-tools-hint">{t("扩展保存在此设备，默认用于个人浏览器。可另行允许它在对话网页中运行；Bot 无法安装或管理扩展。")}</p>
    <form className="browser-extension-store" onSubmit={event => { event.preventDefault(); if (store.trim()) install("store"); }}>
      <label>{t("Chrome 应用商店链接或扩展 ID")}<input value={store} maxLength={2048} disabled={busy} onChange={event => setStore(event.target.value)} placeholder="https://chromewebstore.google.com/detail/…" spellCheck={false}/></label>
      <button type="submit" disabled={busy || !store.trim()}>{t("从应用商店添加")}</button>
    </form>
    <details className="browser-extension-local"><summary>{t("从本地文件添加")}</summary><div className="browser-extensions-actions"><button type="button" disabled={busy} onClick={() => install("folder")}><FolderOpen size={15}/>{t("已解压的文件夹…")}</button><button type="button" disabled={busy} onClick={() => install("file")}><Package size={15}/>{t(".crx / .zip 安装包…")}</button></div></details>
    <section className="browser-extension-compat" aria-label={t("扩展兼容模式")}>
      <label className="browser-checkbox"><input type="checkbox" checked={compat?.enabled ?? false} disabled={busy || !compat} onChange={event => void run("compat_set", { scope, enabled: event.target.checked, english, locale })}/>{t("扩展兼容模式")}</label>
      <p>{personal ? t("仅此设备的个人浏览器") : t("仅此设备当前对话的网页")} · {compat?.active ? t("已开启") : compat?.enabled ? t("尚未生效") : t("默认关闭")}</p>
      <p className="browser-tools-hint">{t("安装扩展无需开启此模式。它用于安装后的广告拦截等网络规则，不会启用商店网页的安装按钮。")}</p>
      <p className="browser-tools-hint">{t("开启后，已安装扩展的后台脚本和设置页可访问本机和局域网服务。开启前会再次说明并确认。")}</p>
      {compat?.active && extensions && !extensions.some(extension => extension.enabled && (personal || extension.scope === "all")) && <p className="browser-tools-hint">{t("兼容模式已开启，但当前浏览器没有获准运行的已启用扩展。请检查下方的「运行位置」。")}</p>}
      {compat?.error && <p role="alert" className="browser-tools-feedback is-error">{extensionErrorText(compat.error)} <button disabled={busy} onClick={() => void run("compat_set", { scope, enabled: true, english, locale })}>{t("重试")}</button></p>}
    </section>
    {busy && <p role="status">{t("正在处理，请完成弹出的选择或确认…")}</p>}
    {error && <p role="alert" className="browser-tools-feedback is-error">{extensionErrorText(error)} <button disabled={busy} onClick={() => { setError(undefined); void refresh(); }}>{t("重新读取")}</button></p>}{notice && <p role="status" className="browser-tools-feedback">{notice}</p>}
    {!extensions ? !error && <p role="status">{t("正在读取…")}</p> : !extensions.length ? <p>{t("尚未添加扩展")}</p> :
    <ul className="browser-extension-list">{extensions.map(extension => {
      const applies = personal || extension.scope === "all";
      const personalSettings = !applies;
      const needsNetworkRules = extension.report.features.some(item => item.code === "network_rules" && item.status === "not_enforced");
      const runStatus = !extension.enabled ? t("已停用") : !applies ? t("当前网页未授权") : t("已启用");
      const optionsHint = extension.optionsAvailable === undefined ? t("更新桌面 App 后可使用扩展设置。")
        : !extension.optionsAvailable ? t("此扩展未提供可用的独立设置页。")
        : !extension.enabled ? t("先启用扩展，再打开设置。") : undefined;
      const groups = (["supported", "not_enforced", "unavailable"] as const).map(status => [status, extension.report.features.filter(item => item.status === status)] as const).filter(([, items]) => items.length);
      return <li key={extension.id} data-extension={extension.id}>
        <div className="browser-extension-head">
          <div className="browser-extension-identity"><strong>{extension.name}</strong><div className="browser-extension-meta"><small>{extension.version}</small><span>{runStatus}</span></div></div>
          <label className="browser-checkbox browser-extension-toggle"><input type="checkbox" checked={extension.enabled} disabled={busy} onChange={event => void run("set", { id: extension.id, enabled: event.target.checked, locale }, entry => entry?.enabled ? t("扩展已启用，请刷新需要使用它的网页。") : undefined)}/>{t("启用")}</label>
        </div>
        <label className="browser-extension-scope"><span>{t("运行位置")}</span><select value={extension.scope} disabled={busy} onChange={event => void run("set", { id: extension.id, scope: event.target.value, english, locale }, () => t("运行位置已更新，请刷新需要使用扩展的网页。"))}><option value="personal">{t("仅个人浏览器")}</option><option value="all">{t("个人浏览器和对话网页")}</option></select></label>
        {!applies && <p className="browser-tools-hint">{t("此扩展不会在当前对话网页运行。若要用于此处，将「运行位置」改为「个人浏览器和对话网页」并确认权限；开启兼容模式不会授予运行权限。")}</p>}
        {extension.enabled && applies && needsNetworkRules && compat && !compat.active && <p className="browser-tools-hint">{compat.enabled ? t("此浏览器的网络拦截尚未生效，请查看上方兼容模式提示。") : t("此浏览器尚未开启网络拦截。广告请求拦截需要在上方开启「扩展兼容模式」并确认；开启后刷新网页。")}</p>}
        {extension.error && <p role="alert" className="browser-tools-feedback is-error">{extensionErrorText(extension.error)}</p>}
        <div className="browser-extension-controls">
          <button type="button" disabled={busy || !!optionsHint} aria-label={personalSettings ? t("在个人浏览器中设置 {0}", extension.name) : t("设置 {0}", extension.name)} title={optionsHint} onClick={() => void run("options", { id: extension.id, scope: personalSettings ? PERSONAL_BROWSER_SCOPE : scope, english, locale })}><Settings size={14}/>{t("设置")}</button>
          <button type="button" disabled={busy} aria-label={t("重新加载 {0}", extension.name)} onClick={() => void run("reload", { id: extension.id })}><RotateCw size={14}/>{t("重新加载")}</button>
          {removing === extension.id ? <><button type="button" className="danger browser-extension-remove" disabled={busy} onClick={() => void run("remove", { id: extension.id }, () => t("已移除“{0}”。", extension.name))}>{t("确认移除")}</button><button type="button" disabled={busy} onClick={() => setRemoving(undefined)}>{t("取消")}</button></>
            : <button type="button" className="browser-extension-remove" disabled={busy} aria-label={t("移除 {0}", extension.name)} onClick={() => setRemoving(extension.id)}><Trash2 size={14}/>{t("移除")}</button>}
        </div>
        <p className="browser-tools-hint">{optionsHint ?? (personal || personalSettings ? t("设置仅影响此设备的个人浏览器。") : t("设置仅影响此设备当前对话的网页。"))}</p>
        <details className="browser-extension-details"><summary>{t("权限与兼容性")}</summary>{extension.report.description && <p>{extension.report.description}</p>}
          <p className="browser-tools-hint">{extension.signature === "store" ? t("已验证 Chrome 应用商店签名。") : extension.signature === "developer" ? t("已验证开发者签名。") : t("本地未签名安装包。")}</p>
          <p className="browser-tools-hint">{extension.report.hostAccess === "all" ? t("可读取和更改它所运行网页中的所有网站。") : extension.report.hostAccess === "some" ? t("可读取和更改：{0}", formatList(extension.report.hosts)) : t("未声明网站内容访问权限。")}</p>
          <dl className="browser-extension-features">{groups.map(([status, items]) => <div key={status}><dt>{status === "supported" ? t("已适配") : status === "not_enforced" ? !extension.enabled ? t("需先启用扩展") : !applies ? t("需先授权此浏览器") : compat?.active ? t("兼容模式已启用") : t("需兼容模式") : t("尚不支持")}</dt><dd>{formatList(items.map(item => extensionFeatureLabel(item.code)))}</dd></div>)}</dl>
          <p className="browser-tools-hint">{t("以上为功能声明检查，实际效果还取决于扩展本身和目标网站。")}</p>
          {extension.report.warnings.length > 0 && <details><summary>{t("加载提示")}</summary><ul>{extension.report.warnings.map(line => <li key={line}>{line}</li>)}</ul></details>}
        </details>
      </li>;
    })}</ul>}
    <footer><button type="button" disabled={busy} onClick={onClose}>{t("关闭")}</button></footer>
  </div>;
}
