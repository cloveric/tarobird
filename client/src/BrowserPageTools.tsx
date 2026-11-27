import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Camera, ExternalLink, Puzzle, ChevronDown, ChevronUp, Download, History, Minus, MoreHorizontal, Plus, Printer, RotateCw, Search, Settings2, Smartphone, Trash2, X } from "lucide-react";
import { DesktopMenu } from "./DesktopMenu.js";
import { localeIntlTag, t, useLocale } from "./i18n.js";
import type { BrowserUserClient } from "./workbench-browser.js";
export type BrowserPageOwner = {
  readonly isVisible?: boolean; browser: BrowserUserClient; setError(error?: string): void; openBrowser(url?: string): Promise<unknown> };
import type { BrowserEvent, BrowserReceipt, BrowserTabState } from "./workbench-browser.js";
import { scheduleBrowserLayout } from "./workbench-browser.js";
import { BROWSER_SEARCH_ENGINES, BROWSER_ZOOM_STEPS, DEFAULT_BROWSER_SETTINGS, browserZoomStep, readBrowserDevicePreview, readBrowserHistory, readBrowserSettings, type BrowserDevicePreview, type BrowserHistoryEntry, type BrowserSettings } from "./workbench-browser-tools.js";
import "./browser-page-tools.css";
import { BrowserExtensionsManager } from "./BrowserExtensions.js";
import { extensionsSupported } from "./browser-extensions.js";
import { openDesktopUrl } from "./desktop-bridge.js";

type Manager = "downloads" | "history" | "clear" | "settings" | "extensions";
type FindResult = { matches: number; activeMatchOrdinal: number };
type DownloadEntry = { download: string; name: string; state: string; received: number; total: number };
const scoped = new Set(["settings", "settings_set", "history", "clear_history", "clear_data", "downloads", "download_cancel", "download_open", "download_reveal"]);
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

/** Each instance is bound to one native page. No action resolves its target from
 * a global active tab after an asynchronous dialog, find or save operation. */
export function useBrowserPageTools({ controller, tabId, active, native, errorText, personal = false }: { controller: BrowserPageOwner; personal?: boolean; tabId: string; active: boolean; native?: BrowserTabState; errorText(code: string): string }) {
  const locale = useLocale();
  const trigger = useRef<HTMLButtonElement>(null), dialog = useRef<HTMLDialogElement>(null), findInput = useRef<HTMLInputElement>(null);
  const alive = useRef(active), lifetime = useRef(0), pending = useRef<object | null>(null); alive.current = active;
  const [menuPoint, setMenuPoint] = useState<{ x: number; y: number }>(), [manager, setManager] = useState<Manager>();
  const managerRef = useRef(manager); managerRef.current = manager;
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [notice, setNotice] = useState<string>();
  const [settingsUnavailable, setSettingsUnavailable] = useState(false), [extensionBusy, setExtensionBusy] = useState(false);
  const [settings, setSettings] = useState<BrowserSettings>(DEFAULT_BROWSER_SETTINGS), [settingsLoaded, setSettingsLoaded] = useState(false), [draft, setDraft] = useState<BrowserSettings>(DEFAULT_BROWSER_SETTINGS);
  const draftDirty = useRef(new Set<keyof BrowserSettings>()), draftRef = useRef(draft); draftRef.current = draft;
  const changeDraft = (value: Partial<BrowserSettings>) => { for (const key of Object.keys(value) as (keyof BrowserSettings)[]) draftDirty.current.add(key); setDraft(old => ({ ...old, ...value })); };
  const [zoom, setZoom] = useState(1), [device, setDevice] = useState<BrowserDevicePreview>(), [deviceBar, setDeviceBar] = useState(false);
  const [findOpen, setFindOpen] = useState(false), [query, setQuery] = useState(""), [matchCase, setMatchCase] = useState(false), [found, setFound] = useState<FindResult>();
  const clearPending = useRef(false);
  const findSeq = useRef(0), findId = useRef<number | undefined>(undefined), findEvents = useRef(new Map<number, FindResult>()), findStarted = useRef(false);
  const navigation = useRef(native?.navigation); navigation.current = native?.navigation;
  const [history, setHistory] = useState<BrowserHistoryEntry[]>([]), [historyQuery, setHistoryQuery] = useState(""), [historyLimit, setHistoryLimit] = useState(100), [reading, setReading] = useState(false);
  const [downloads, setDownloads] = useState<DownloadEntry[]>([]), [clearHistory, setClearHistory] = useState(true), [clearWeb, setClearWeb] = useState(false);
  const supports = (action: string) => controller.browser.supports(action), hasTools = supports("settings");
  const message = (code: string) => ({
    browser_external_open_failed: t("无法打开系统浏览器，请重试或复制网址手动打开。"),
    browser_tools_unavailable: t("请更新桌面版后使用这些网页工具。下载和网站数据清理仍可使用。"),
    browser_settings_failed: t("无法读取浏览器设置，请重试。"),
    history_unavailable: t("无法读取或清理浏览历史，请重试。"),
    settings_unavailable: t("无法读取浏览器设置，未更改记录历史的选择。请重试。"),
    scope_reset: t("主机的浏览数据已被清理，本次操作未完成。请重新打开目标网页后再试。"),
    window_hidden: t("窗口已隐藏，请先显示窗口再操作。"),
    settings_write_failed: t("浏览器设置未保存，请重试。"),
    tool_busy: t("请先完成或取消当前的打印或保存操作。"),
    print_no_printers: t("未找到可用打印机。请连接打印机，或在网页工具中选择「保存为 PDF」。"),
    print_failed: t("未能完成打印请求。请检查打印机，或选择「保存为 PDF」。"),
    pdf_failed: t("未能生成 PDF，请等待网页加载完成后重试。"),
    save_failed: t("文件未保存，请检查保存位置的权限和可用空间后重试。"),
    tab_sleeping: t("网页已休眠，请先唤醒网页再使用页面工具。"),
    capture_failed: t("未能截取当前网页，请确认网页已显示后重试。"),
    browser_history_failed: t("无法读取历史记录，请重试。"),
    browser_result_unknown: t("结果尚未确认，请先检查目标页面或保存位置，避免重复操作。"),
    stale_navigation: t("网页已跳转，请在当前页面重新操作。"),
    tab_closed: t("网页已关闭，操作没有完成。"),
  }[code] ?? errorText(code));
  const apply = (result: BrowserReceipt | BrowserEvent) => {
    if (typeof result.zoomFactor === "number" && Number.isFinite(result.zoomFactor)) setZoom(result.zoomFactor);
    const preview = readBrowserDevicePreview(result.devicePreview); if (preview) { setDevice(preview); if (preview.preset !== "desktop") setDeviceBar(true); }
    const next = readBrowserSettings(result.settings); if (next) {
      setSettings(next); setSettingsLoaded(true); setSettingsUnavailable(false);
      const dirty = draftDirty.current;
      if (managerRef.current === "settings" && dirty.size && (Object.keys(next) as (keyof BrowserSettings)[]).some(key => next[key] !== draftRef.current[key])) setNotice(t("设置已在其他位置更新。未修改的选项已同步，保存将使用当前显示的选项。"));
      setDraft(old => ({ searchEngine: dirty.has("searchEngine") ? old.searchEngine : next.searchEngine, defaultZoom: dirty.has("defaultZoom") ? old.defaultZoom : next.defaultZoom, recordHistory: dirty.has("recordHistory") ? old.recordHistory : next.recordHistory }));
    }
  };
  const handlers = useRef<(command: string) => void>(() => {});
  const run = async (action: string, fields: Record<string, unknown> = {}, settle = false): Promise<BrowserReceipt | undefined> => {
    if (pending.current || !alive.current) return;
    const generation = lifetime.current, token = {}; pending.current = token; setBusy(true); setError(undefined); setNotice(undefined);
    try {
      if (settle) { setMenuPoint(undefined); scheduleBrowserLayout(); await frame(); await frame(); }
      if (!alive.current || generation !== lifetime.current) return;
      const result = await controller.browser.command(action, scoped.has(action) ? undefined : tabId, fields);
      if (!alive.current || generation !== lifetime.current) return;
      if (result.status === "cancelled" && (!result.error || result.error === "print_cancelled")) return;
      if (result.status !== "ok") throw new Error(result.status === "unknown" ? "browser_result_unknown" : result.error ?? "browser_action_failed");
      apply(result); scheduleBrowserLayout(); return result;
    } catch (cause) { if (alive.current && generation === lifetime.current) { const code = cause instanceof Error ? cause.message : "browser_action_failed"; setError(code); if (action === "settings") { setSettingsLoaded(false); setSettingsUnavailable(code === "settings_unavailable"); } } }
    finally { if (pending.current === token) { pending.current = null; if (generation === lifetime.current && alive.current) setBusy(false); } }
  };
  const showManager = (next: Manager) => { setMenuPoint(undefined); setError(undefined); setNotice(undefined); if (next === "settings") { draftDirty.current.clear(); setDraft(settingsLoaded ? settings : { ...settings, recordHistory: false }); } if (next === "history") { setHistoryQuery(""); setHistoryLimit(100); } setManager(next); };
  const stopFind = () => { findSeq.current++; findId.current = undefined; findEvents.current.clear(); setFound(undefined); if (findStarted.current) { findStarted.current = false; void controller.browser.command("stop_find", tabId).catch(() => {}); } };
  const closeFind = (restoreFocus = true) => { stopFind(); setFindOpen(false); if (restoreFocus) trigger.current?.focus({ preventScroll: true }); };
  const showFind = () => { setMenuPoint(undefined); setFindOpen(true); setError(undefined); requestAnimationFrame(() => { findInput.current?.focus(); findInput.current?.select(); }); };
  const find = async (forward = true, initial = false) => {
    if (!query || !alive.current) return;
    const newSession = initial || findId.current === undefined;
    const sequence = ++findSeq.current, generation = lifetime.current; findId.current = undefined; setFound(undefined); findStarted.current = true;
    try {
      const result = await controller.browser.command("find", tabId, { text: query, matchCase, forward, findNext: newSession });
      if (sequence !== findSeq.current || generation !== lifetime.current || !alive.current) return;
      if (result.status !== "ok" || typeof result.findRequestId !== "number") throw new Error(result.error ?? "browser_action_failed");
      if (typeof result.navigation === "number" && result.navigation !== navigation.current) return;
      findId.current = result.findRequestId;
      const direct = result.find as { requestId?: number; matches?: number; activeMatchOrdinal?: number } | undefined;
      const cached = findEvents.current.get(result.findRequestId);
      if (!result.superseded && direct?.requestId === result.findRequestId && typeof direct.matches === "number" && Number.isFinite(direct.matches) && typeof direct.activeMatchOrdinal === "number" && Number.isFinite(direct.activeMatchOrdinal)) setFound({ matches: Math.max(0, direct.matches), activeMatchOrdinal: Math.max(0, direct.activeMatchOrdinal) });
      else if (cached) setFound(cached);
    } catch (cause) { if (sequence === findSeq.current && alive.current) setError(cause instanceof Error ? cause.message : "browser_action_failed"); }
  };
  const print = async (mode: "dialog" | "pdf") => {
    const result = await run("print", { mode, english: locale === "en", locale }, true);
    if (result?.saved === true) setNotice(t("PDF 已保存"));
    else if (result && mode === "dialog") setNotice(t("打印请求已处理，请在系统打印队列中查看状态。"));
  };
  handlers.current = command => { if (!alive.current) return; if (command === "find") showFind(); else if (command === "print") void print("dialog"); else if (command === "find_next" || command === "find_prev") { if (!findOpen) showFind(); else void find(command === "find_next"); } else if (command === "escape" && findOpen) closeFind(false); };
  useEffect(() => {
    let cancelled = false, remove: (() => void) | undefined;
    void controller.browser.subscribe(event => {
      if (!alive.current) return;
      if (event.kind === "settings") { apply(event); return; }
      if (event.tab !== tabId) return;
      if (event.kind === "state") apply(event);
      if (event.kind === "shortcut" && typeof event.command === "string") handlers.current(event.command);
      if (event.kind === "find" && typeof event.requestId === "number" && typeof event.matches === "number" && typeof event.activeMatchOrdinal === "number" && (event.navigation === undefined || event.navigation === navigation.current)) {
        const value = { matches: Math.max(0, event.matches), activeMatchOrdinal: Math.max(0, event.activeMatchOrdinal) };
        findEvents.current.set(event.requestId, value); if (findEvents.current.size > 8) findEvents.current.delete(findEvents.current.keys().next().value!);
        if (event.requestId === findId.current) setFound(value);
      }
    }).then(stop => { if (cancelled) stop(); else remove = stop; }).catch(() => {});
    return () => { cancelled = true; remove?.(); };
  }, [controller, tabId, locale]);
  useEffect(() => {
    alive.current = active;
    if (!active) { pending.current = null; setMenuPoint(undefined); setManager(undefined); setFindOpen(false); setBusy(false); setError(undefined); stopFind(); }
    return () => { lifetime.current++; alive.current = false; findSeq.current++; if (findStarted.current) { findStarted.current = false; void controller.browser.command("stop_find", tabId).catch(() => {}); } };
  }, [controller, tabId, active]);
  useEffect(() => { if (native?.zoomFactor !== undefined) setZoom(native.zoomFactor); if (native?.devicePreview) { setDevice(native.devicePreview); if (native.devicePreview.preset !== "desktop") setDeviceBar(true); } }, [native?.zoomFactor, native?.devicePreview]);
  useEffect(() => {
    if (!active || !hasTools) return; let current = true; setSettingsLoaded(false); setSettingsUnavailable(false);
    void controller.browser.command("settings", undefined).then(result => { if (!current) return; const next = readBrowserSettings(result.settings); if (result.status === "ok" && next) { setSettings(next); setDraft(next); setSettingsLoaded(true); } else { setError(result.error ?? "browser_settings_failed"); setSettingsUnavailable(result.error === "settings_unavailable"); } }, () => { if (current) setError("browser_settings_failed"); });
    return () => { current = false; };
  }, [controller, active, hasTools]);
  useEffect(() => {
    if (!findOpen || !active) return;
    findSeq.current++; findId.current = undefined; setFound(undefined);
    if (!query) { stopFind(); return; }
    const timer = setTimeout(() => void find(true, true), 180); return () => { clearTimeout(timer); findSeq.current++; };
  }, [findOpen, query, matchCase, native?.navigation, active]);
  useLayoutEffect(() => { if (manager) dialog.current?.showModal(); else dialog.current?.close(); scheduleBrowserLayout(); }, [manager]);
  useEffect(() => {
    if (manager !== "history" && manager !== "downloads") return; let current = true, pendingRead = false;
    const read = async () => {
      if (pendingRead) return; pendingRead = true; setReading(true);
      try { const result = await controller.browser.command(manager, undefined, manager === "history" ? { limit: 500 } : {}); if (!current) return; if (result.status !== "ok") throw new Error(result.error ?? (manager === "history" ? "browser_history_failed" : "browser_downloads_failed")); if (manager === "history") setHistory(readBrowserHistory(result.entries)); else setDownloads(Array.isArray(result.downloads) ? result.downloads as DownloadEntry[] : []); }
      catch (cause) { if (current) setError(cause instanceof Error ? cause.message : "browser_action_failed"); }
      finally { pendingRead = false; if (current) setReading(false); }
    };
    void read(); const timer = manager === "downloads" ? setInterval(() => void read(), 1000) : undefined;
    return () => { current = false; if (timer) clearInterval(timer); };
  }, [controller, manager]);
  const saveSettings = async () => { const result = await run("settings_set", { settings: draft }); if (result) { draftDirty.current.clear(); setSettings(readBrowserSettings(result.settings) ?? draft); setManager(undefined); } };
  const clear = async () => {
    if (clearPending.current) return; clearPending.current = true;
    try {
    const completed: string[] = [];
    if (clearHistory) { const result = await run("clear_history"); if (!result) return; completed.push(t("历史记录已清理")); setClearHistory(false); setHistory([]); }
    if (clearWeb) { const result = await run("clear_data"); if (!result) { if (completed.length) setNotice(completed.join(t("；"))); return; } completed.push(t("网站数据已清理")); setClearWeb(false); }
    if (alive.current) { setManager(undefined); setNotice(completed.join(t("；"))); }
    } finally { clearPending.current = false; }
  };
  const openSystemBrowser = async () => {
    setMenuPoint(undefined); setError(undefined);
    try { const url = new URL(native?.url ?? ""); if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid_browser_url"); await openDesktopUrl(url.href); }
    catch { if (alive.current) setError("browser_external_open_failed"); }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (manager || !active) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && supports("find") && event.key.toLowerCase() === "f") { event.preventDefault(); event.stopPropagation(); showFind(); }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && supports("print") && event.key.toLowerCase() === "p") { event.preventDefault(); event.stopPropagation(); void print("dialog"); }
  };
  const unavailable = busy || !active || !!native?.fullscreen, pageUnavailable = unavailable || !!native?.sleeping || !!native?.error;
  const filtered = history.filter(entry => `${entry.title}\n${entry.url}`.toLocaleLowerCase().includes(historyQuery.toLocaleLowerCase()));
  const button = <><button ref={trigger} type="button" aria-label={t("网页工具与下载")} title={t("网页工具")} aria-expanded={!!menuPoint} onClick={() => { const rect = trigger.current!.getBoundingClientRect(); setMenuPoint(menuPoint ? undefined : { x: rect.right - 260, y: rect.bottom + 4 }); }}><MoreHorizontal size={15}/></button>
    <DesktopMenu id={`browser-tools-${tabId}`} label={t("网页工具")} open={!!menuPoint} close={() => setMenuPoint(undefined)} trigger={trigger} placement="down-end" point={menuPoint} className="browser-tools-menu">
      <button aria-label={t("在页面中查找")} disabled={pageUnavailable || !supports("find")} onClick={showFind}><Search size={15}/>{t("在页面中查找")}<kbd>⌘ / Ctrl F</kbd></button>
      <button disabled={pageUnavailable || !supports("print")} onClick={() => void print("dialog")}><Printer size={15}/>{t("打印…")}</button>
      <button disabled={pageUnavailable || !supports("print")} onClick={() => void print("pdf")}><Download size={15}/>{t("保存为 PDF…")}</button><hr/>
      <div className="browser-zoom-row"><span>{t("缩放")}</span><button data-menu-keep aria-disabled={busy || undefined} disabled={!active || !!native?.fullscreen || !supports("zoom") || zoom <= .25} aria-label={t("缩小网页")} onClick={() => void run("zoom", { factor: browserZoomStep(zoom, -1) })}><Minus size={14}/></button><button data-menu-keep aria-disabled={busy || undefined} disabled={!active || !!native?.fullscreen || !supports("zoom")} aria-label={t("重置网页缩放")} title="100%" onClick={() => void run("zoom", { factor: 1 })}>{Math.round(zoom * 100)}%</button><button data-menu-keep aria-disabled={busy || undefined} disabled={!active || !!native?.fullscreen || !supports("zoom") || zoom >= 3} aria-label={t("放大网页")} onClick={() => void run("zoom", { factor: browserZoomStep(zoom, 1) })}><Plus size={14}/></button></div>
      <button disabled={unavailable || !supports("device")} onClick={() => { setMenuPoint(undefined); setDeviceBar(true); }}><Smartphone size={15}/>{t("设备预览")}</button>
      <button disabled={pageUnavailable || !supports("save_screenshot")} onClick={() => { void run("save_screenshot", { english: locale === "en", locale }, true).then(result => { if (result?.saved === true) setNotice(t("截图已保存")); }); }}><Camera size={15}/>{t("保存网页截图…")}</button><hr/>
      <button disabled={busy} onClick={() => showManager("downloads")}><Download size={15}/>{t("下载")}</button>
      <button disabled={busy || !supports("history")} onClick={() => showManager("history")}><History size={15}/>{t("历史记录")}</button>
      <button disabled={busy} onClick={() => { setClearHistory(supports("clear_history")); setClearWeb(!supports("clear_history")); showManager("clear"); }}><Trash2 size={15}/>{t("清除浏览数据…")}</button><hr/>
      {extensionsSupported() && <button disabled={busy} onClick={() => showManager("extensions")}><Puzzle size={15}/>{t("扩展程序")}</button>}
      <button disabled={busy || !/^https?:\/\//i.test(native?.url ?? "")} onClick={() => void openSystemBrowser()}><ExternalLink size={15}/>{t("在系统浏览器打开")}</button>
      <button disabled={busy || !hasTools} onClick={() => showManager("settings")}><Settings2 size={15}/>{t("浏览器设置")}</button>
      {!hasTools && <p className="browser-tools-hint">{message("browser_tools_unavailable")}</p>}{native?.sleeping && <p className="browser-tools-hint">{message("tab_sleeping")}</p>}{native?.error && <p className="browser-tools-hint">{message("page_unavailable")}</p>}{native?.fullscreen && <p className="browser-tools-hint">{t("请先退出网页全屏")}</p>}
    </DesktopMenu></>;
  const panels = <>
    {findOpen && <form className="browser-find-bar" role="search" aria-label={t("在网页中查找")} onSubmit={event => { event.preventDefault(); void find(true); }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeFind(); } else if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "g") { event.preventDefault(); event.stopPropagation(); void find(!event.shiftKey); } else if (event.key === "Enter" && event.shiftKey) { event.preventDefault(); void find(false); } }}>
      <input ref={findInput} aria-label={t("查找内容")} placeholder={t("在页面中查找")} value={query} maxLength={1024} onChange={event => setQuery(event.target.value)}/><span role="status" aria-live="polite">{!query ? "" : found ? found.matches ? `${found.activeMatchOrdinal} / ${found.matches}` : t("无匹配") : t("查找中…")}</span>
      <button type="button" aria-label={t("区分大小写")} aria-pressed={matchCase} onClick={() => setMatchCase(!matchCase)}>Aa</button><button type="button" disabled={!query} aria-label={t("上一个匹配")} onClick={() => void find(false)}><ChevronUp size={14}/></button><button type="submit" disabled={!query} aria-label={t("下一个匹配")}><ChevronDown size={14}/></button><button type="button" aria-label={t("关闭查找")} onClick={() => closeFind()}><X size={14}/></button>
    </form>}
    {deviceBar && <div className="browser-device-bar"><label>{t("设备预览")}<select aria-label={t("预览设备")} value={device?.preset ?? "desktop"} disabled={busy} onChange={event => void run("device", { preset: event.target.value, landscape: device?.landscape ?? false })}><option value="desktop">{t("桌面")}</option><option value="phone">{t("手机")} · 390 × 844</option><option value="tablet">{t("平板")} · 768 × 1024</option></select></label>
      {device && device.preset !== "desktop" && <span>{device.width} × {device.height}</span>}<button disabled={busy || !device || device.preset === "desktop"} aria-label={t("切换横竖屏")} onClick={() => void run("device", { preset: device!.preset, landscape: !device!.landscape })}><RotateCw size={14}/></button><button disabled={busy} aria-label={t("关闭设备预览")} onClick={() => { void run("device", { preset: "desktop" }).then(result => { if (result) setDeviceBar(false); }); }}><X size={14}/></button><small>{t("预设尺寸基于 100% 缩放，仅预览布局，不代表真机表现")}</small></div>}
    {!manager && (error || notice) && <div className={`browser-tools-feedback${error ? " is-error" : ""}`} role={error ? "alert" : "status"}><span>{error ? message(error) : notice}</span><button aria-label={t("关闭提示")} onClick={() => { setError(undefined); setNotice(undefined); }}><X size={13}/></button></div>}
    <dialog ref={dialog} aria-labelledby={`browser-manager-title-${tabId}`} className="workbench-dialog browser-tools-dialog" onCancel={event => { event.preventDefault(); if (!busy && !extensionBusy) setManager(undefined); }}>
      <header><h3 id={`browser-manager-title-${tabId}`}>{t(manager === "downloads" ? (personal ? "下载" : "本对话的下载") : manager === "history" ? (personal ? "浏览历史" : "本对话的浏览历史") : manager === "clear" ? "清除浏览数据" : manager === "extensions" ? "扩展程序" : "浏览器设置")}</h3><button disabled={busy || extensionBusy} aria-label={t("关闭")} onClick={() => setManager(undefined)}><X size={17}/></button></header>
      {error && <p role="alert" className="browser-tools-feedback is-error">{message(error)}</p>}{notice && <p role="status" className="browser-tools-feedback">{notice}</p>}
      {manager === "extensions" && <BrowserExtensionsManager key={JSON.stringify(controller.browser.scope)} scope={controller.browser.scope} personal={personal} onClose={() => setManager(undefined)} onBusyChange={setExtensionBusy}/> }
      {manager === "settings" && <form onSubmit={event => { event.preventDefault(); void saveSettings(); }}><p>{personal ? t("仅用于此设备的个人浏览器。网站登录、聊天和文档不受影响。") : t("仅用于当前设备的本对话。网站登录、聊天和文档不受影响。")}</p>
        <fieldset disabled={!settingsLoaded || busy}><label>{t("地址栏搜索引擎")}<select value={draft.searchEngine} onChange={event => changeDraft({ searchEngine: event.target.value as BrowserSettings["searchEngine"] })}>{BROWSER_SEARCH_ENGINES.map(engine => <option key={engine} value={engine}>{{google:"Google",bing:"Bing",duckduckgo:"DuckDuckGo",baidu:t("百度")}[engine]}</option>)}</select></label>
        <label>{t("新网页的默认缩放")}<select value={draft.defaultZoom} onChange={event => changeDraft({ defaultZoom: Number(event.target.value) })}>{BROWSER_ZOOM_STEPS.map(value => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}</select></label>
        <label className="browser-checkbox"><input type="checkbox" checked={draft.recordHistory} onChange={event => changeDraft({ recordHistory: event.target.checked })}/>{t("记录浏览历史")}</label><small>{t("最多保存 500 条。关闭后不再新增，已有记录可单独清理。")}</small></fieldset>
        {!settingsLoaded && settingsUnavailable && <p>{t("设置文件无法读取。你可以重新读取，或重置搜索与缩放设置并停用历史记录；已有历史保留。")}</p>}
        <footer>{!settingsLoaded && settingsUnavailable && <button type="button" disabled={busy} onClick={() => void run("settings_set", { settings: { ...DEFAULT_BROWSER_SETTINGS, recordHistory: false } }).then(result => { const next = readBrowserSettings(result?.settings); if (next) { setDraft(next); setNotice(t("设置已重置，历史记录已停用。")); } })}>{t("重置设置并停用历史记录")}</button>}{!settingsLoaded && <button type="button" disabled={busy} onClick={() => void run("settings").then(result => { const next = readBrowserSettings(result?.settings); if (next) setDraft(next); })}>{t("重新读取")}</button>}<button type="submit" disabled={busy || !settingsLoaded}>{t(busy ? "保存中…" : "保存")}</button></footer>
      </form>}
      {manager === "history" && <><input className="browser-history-search" aria-label={t("搜索浏览历史")} placeholder={t("搜索标题或网址")} value={historyQuery} onChange={event => { setHistoryQuery(event.target.value); setHistoryLimit(100); }}/><p className="browser-tools-hint">{personal ? t("此设备个人浏览器的记录。点击记录会在新标签打开。") : t("仅显示当前设备、本对话的浏览记录。点击记录会在新标签打开。")}</p>{reading ? <p role="status">{t("正在读取…")}</p> : !filtered.length ? <p>{t("暂无匹配的浏览记录")}</p> : <ul className="browser-history-list">{filtered.slice(0, historyLimit).map(entry => <li key={entry.id}><button disabled={busy} title={entry.url} onClick={() => { setManager(undefined); void controller.openBrowser(entry.url).catch(cause => controller.setError(cause instanceof Error ? cause.message : "browser_open_failed")); }}><strong>{entry.title || entry.url}</strong><span>{entry.url}</span><time>{new Date(entry.visitedAt).toLocaleString(localeIntlTag(locale))}</time></button></li>)}</ul>}
        {filtered.length > historyLimit && <button onClick={() => setHistoryLimit(value => value + 100)}>{t("显示更多")}</button>}<footer><button disabled={busy || !history.length} onClick={() => { setClearHistory(true); setClearWeb(false); showManager("clear"); }}>{t("清理历史记录")}</button><button onClick={() => setManager(undefined)}>{t("关闭")}</button></footer></>}
      {manager === "clear" && <><p>{personal ? t("只清理此设备个人浏览器的数据。聊天、笔记、白板和各对话的网页数据保留。") : t("只清理当前设备、本对话的浏览数据。聊天、笔记、白板和其他对话保留。")}</p>
        {supports("clear_history") && <label className="browser-checkbox"><input type="checkbox" checked={clearHistory} disabled={busy} onChange={event => setClearHistory(event.target.checked)}/>{t("浏览历史")}</label>}
        <label className="browser-checkbox"><input type="checkbox" checked={clearWeb} disabled={busy} onChange={event => setClearWeb(event.target.checked)}/>{t("网站与部分扩展数据")}</label>{clearWeb && <p>{personal ? t("会退出个人浏览器中网站的登录。") : t("会退出此对话网页的登录，并停止正在进行的 Bot 网页操作。")}</p>}
        {clearWeb && <p>{t("包括网站登录、Cookie、缓存和扩展的网页存储；扩展安装与访问授权保留。")}</p>}
        <footer><button disabled={busy} onClick={() => setManager(undefined)}>{t("取消")}</button><button className="danger" disabled={busy || !clearHistory && !clearWeb} onClick={() => void clear()}>{t(busy ? "正在清理…" : "清理所选数据")}</button></footer></>}
      {manager === "downloads" && <>{reading && !downloads.length ? <p role="status">{t("正在读取…")}</p> : !downloads.length && <p>{t("暂无下载")}</p>}<ul className="browser-download-list">{downloads.map(download => <li key={download.download}><strong>{download.name}</strong><small>{t(download.state === "completed" ? "已完成" : download.state === "progressing" ? "下载中" : download.state === "cancelled" ? "已取消" : "下载中断")} · {Math.round(download.received / 1024)} KB</small><footer>{download.state === "progressing" ? <button disabled={busy} onClick={() => void run("download_cancel", { download: download.download })}>{t("取消下载")}</button> : download.state === "completed" ? <><button disabled={busy} onClick={() => void run("download_open", { download: download.download, english: locale === "en", locale })}>{t("打开")}</button><button disabled={busy} onClick={() => void run("download_reveal", { download: download.download })}>{t("显示文件")}</button></> : null}</footer></li>)}</ul><footer><button disabled={busy} onClick={() => { setClearHistory(false); setClearWeb(true); showManager("clear"); }}>{t("清理网站数据")}</button><button onClick={() => setManager(undefined)}>{t("关闭")}</button></footer></>}
    </dialog>
  </>;
  return { button, panels, onKeyDown, searchEngine: settings.searchEngine };
}
