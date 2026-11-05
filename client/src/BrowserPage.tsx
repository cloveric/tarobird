import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, ExternalLink, RotateCw, Square, X } from "lucide-react";
import { useLocale } from "./i18n.js";
import { registerBrowserSurface, scheduleBrowserLayout, browserAddress, type BrowserTabState } from "./workbench-browser.js";
import { googleSigninRejected } from "./browser-google-signin.js";
import { openDesktopUrl } from "./desktop-bridge.js";
import { useBrowserPageTools, type BrowserPageOwner } from "./BrowserPageTools.js";

export function BrowserPage({ controller, tab, active, native, supported, personal = false, errorText }: { controller: BrowserPageOwner; tab: {id: string; url?: string}; active: boolean; native?: BrowserTabState; supported: boolean; personal?: boolean; errorText(code: string): string }) {
  const locale = useLocale();
  const word = (zh: string, en: string) => locale === "en" ? en : zh;
  const viewport = useRef<HTMLDivElement>(null), activeRef = useRef(active); activeRef.current = active;
  const [address, setAddress] = useState(native?.url ?? tab.url ?? ""), [editing, setEditing] = useState(false);
  const rejected = googleSigninRejected(native?.url ?? tab.url), rejectionKey = `${tab.id}:${native?.url ?? tab.url}:${native?.navigation ?? 0}`;
  const [dismissed, setDismissed] = useState<string>(), [opening, setOpening] = useState(false), [externalError, setExternalError] = useState(false);
  const mounted = useRef(true); useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const rejectionRef = useRef(rejectionKey); rejectionRef.current = rejectionKey;
  useLayoutEffect(scheduleBrowserLayout, [rejectionKey, dismissed]);
  useEffect(() => setExternalError(false), [rejectionKey]);
  const continueGoogle = async () => {
    if (!rejected || opening) return;
    const key = rejectionKey; setOpening(true); setExternalError(false);
    try { await openDesktopUrl(rejected.target); }
    catch { if (mounted.current && rejectionRef.current === key) setExternalError(true); }
    finally { if (mounted.current) setOpening(false); }
  };
  const tools = useBrowserPageTools({ controller, tabId: tab.id, active, native, errorText, personal });
  const action = (name: string, fields: Record<string, unknown> = {}) => {
    const scoped = ["clear_data", "downloads", "download_cancel", "download_open", "download_reveal"].includes(name);
    void controller.browser.command(name, scoped ? undefined : tab.id, fields).then(result => { if (result.status !== "ok") controller.setError(result.error ?? "browser_action_failed"); scheduleBrowserLayout(); }, error => controller.setError(error instanceof Error ? error.message : "browser_action_failed"));
  };
  useEffect(() => { if (!editing) setAddress(native?.url ?? tab.url ?? ""); }, [native?.url, tab.url, editing]);
  useLayoutEffect(() => {
    if (!supported || !viewport.current) return;
    return registerBrowserSurface(tab.id, viewport.current, () => activeRef.current && controller.isVisible !== false);
  }, [controller, supported, tab.id]);
  useLayoutEffect(scheduleBrowserLayout, [active]);
  if (!supported) return <p className="workbench-unavailable">{errorText("workbench_browser_requires_desktop")}</p>;
  // Keep the typed address through pointer/keyboard Go activation; navigation
  // controls and leaving the form end editing so native URLs can update.
  return <div className="workbench-browser-content" onKeyDown={tools.onKeyDown}><form className="workbench-address" onBlur={event => { const next = event.relatedTarget; if (!(next instanceof HTMLButtonElement && next.type === "submit" && event.currentTarget.contains(next))) setEditing(false); }} onSubmit={event => { event.preventDefault(); try { action("navigate", { url: browserAddress(address, tools.searchEngine) }); setEditing(false); } catch (error) { controller.setError(error instanceof Error ? error.message : "invalid_browser_url"); } }}>
    <button type="button" aria-label={word("后退", "Back")} disabled={native?.canGoBack === false} onClick={() => action("back")}><ArrowLeft size={15}/></button><button type="button" aria-label={word("前进", "Forward")} disabled={native?.canGoForward === false} onClick={() => action("forward")}><ArrowRight size={15}/></button><button type="button" aria-label={word(native?.loading ? "停止加载" : "刷新网页", native?.loading ? "Stop loading" : "Reload")} onClick={() => action(native?.loading ? "stop" : "reload")}>{native?.loading ? <Square size={13}/> : <RotateCw size={14}/>}</button>
    <input value={address} onFocus={() => setEditing(true)} onChange={event => setAddress(event.target.value)} aria-label={word("网址或搜索", "Address or search")} placeholder={word("输入网址或搜索内容", "Enter an address or search")} spellCheck={false}/><button type="submit" onPointerDown={event => event.preventDefault()} aria-label={word("打开网址", "Go")}><ArrowRight size={15}/></button>{tools.button}
  </form>
    {active && rejected && dismissed !== rejectionKey && <div className="browser-signin-notice" role="status">
      <div><strong>{word("Google 拒绝了此次内置浏览器登录", "Google declined this embedded-browser sign-in")}</strong><p>{word("请在系统浏览器继续。登录状态不会同步回这里。", "Continue in your system browser. Its sign-in will not transfer back here.")}</p>
      <button type="button" disabled={opening} onClick={() => void continueGoogle()}><ExternalLink size={14}/>{word("在系统浏览器继续", "Continue in system browser")}</button>{externalError && <p role="alert">{word("未能打开系统浏览器，请复制网址手动打开或重试。", "Could not open your system browser. Copy the URL or try again.")}</p>}</div>
      <button type="button" aria-label={word("关闭登录提示", "Dismiss sign-in notice")} onClick={() => setDismissed(rejectionKey)}><X size={14}/></button>
    </div>}
    {tools.panels}
    {!personal && <div className="workbench-browser-state"><span>{native?.activity ? word("Bot 正在操作", "Bot is working") : native?.takeover ? word("你正在操作", "You are in control") : word("可在主对话中让 Bot 操作此页", "Ask your Bot to work on this page")}</span>
      {native?.activity && <button onClick={() => action("cancel")}>{word("停止", "Stop")}</button>}<button onClick={() => action(native?.takeover ? "resume" : "takeover")}>{word(native?.takeover ? "允许 Bot 操作" : "接管", native?.takeover ? "Allow Bot" : "Take control")}</button>
      <button aria-label={word(native?.sleeping ? "唤醒网页" : "休眠网页", native?.sleeping ? "Wake page" : "Sleep page")} onClick={() => action(native?.sleeping ? "wake" : "sleep")}><ChevronDown size={13}/></button>
    </div>}
    {native?.fullscreen && <p className="workbench-browser-note">{word("网页全屏 · 按 Esc 退出", "Page fullscreen · press Esc to exit")}</p>}
    {native?.popup && <p className="workbench-browser-note">{word("登录窗口已打开，请在该窗口完成操作。", "A login window is open. Complete the action there.")}</p>}
    {native?.requestedUrl && <p className="workbench-browser-note">{word("网页数量已达上限，请先关闭或休眠其他网页。", "Close or sleep another webpage before opening this link.")}<button onClick={() => void controller.openBrowser(native.requestedUrl).catch(error => controller.setError(error instanceof Error ? error.message : "browser_open_failed"))}>{word("重新打开链接", "Retry link")}</button></p>}
    {native?.notice && <p className="workbench-browser-note">{word("本次网页跳转未打开：", "This page navigation was blocked: ")}{native.notice}</p>}
    {native?.error && <p className="workbench-error">{errorText("page_unavailable")}</p>}
    <div className="workbench-browser-viewport" ref={viewport} aria-label={word("内嵌网页", "Embedded webpage")}>{native?.sleeping && <button onClick={() => action("wake")}>{word("网页已休眠，点击重新加载", "Page is sleeping. Reload to continue.")}</button>}</div>

  </div>;
}
