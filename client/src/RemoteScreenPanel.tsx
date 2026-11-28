import { screenControllerCode, screenModifierModeApplies, screenShortcuts, type ScreenModifierMode } from "../../src/client-protocol/screen-keys.js";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Capacitor } from "@capacitor/core";
import { Activity, Maximize, Maximize2, Minimize, Minimize2, X, Monitor, MoreHorizontal, ChevronDown, Unplug, Keyboard, Plug, MousePointer2, CornerDownLeft } from "lucide-react";
import type { HubConnection } from "./connection.js";
import type { ScreenStatus } from "../../src/client-protocol/remote-screen.js";
import { estimateServerTimeOffset, tcpRouteFromConnectionRoute, type ScreenPerformanceSnapshot, type ScreenRouteKind } from "../../src/client-protocol/screen-metrics.js";
import { screenInputEventSchema, screenKeyCodeSchema } from "../../src/client-protocol/remote-screen.js";
import { RemoteScreenViewer, supportedScreenCodecs, type ViewerState } from "./remote-screen-viewer.js";
import { screenError } from "./screen-errors.js";
import { t, useLocale, type SupportedLocale } from "./i18n.js";
import "./remote-screen.css";
import { SCREEN_DEFAULT_QUALITY, type ScreenQuality } from "../../src/client-protocol/screen-quality.js";
import { useScreenFullscreen } from "./use-screen-fullscreen.js";
import { isMobileScreenApp, mobileScreenViewerTransport, screenViewerFlight } from "./mobile-screen-viewer-transport.js";
import { isScreenReasonCode } from "./screen-errors.js";
import { useScreenMobileLifecycle } from "./use-screen-mobile-lifecycle.js";
import { ScreenTouch, SCREEN_TOUCH_HOLD_MS, type ScreenTransform } from "./screen-touch.js";

// A phone on its side keeps the picture at full height: the heading becomes a
// right-hand rail and the status a small label over the picture. Tablets and
// portrait phones keep the stacked layout.
const LANDSCAPE_PHONE = "(orientation: landscape) and (max-height: 540px)";
const landscapeMedia = () => typeof matchMedia === "function" ? matchMedia(LANDSCAPE_PHONE) : undefined;
const watchLandscape = (listener: () => void) => { const media = landscapeMedia(); media?.addEventListener("change", listener); return () => media?.removeEventListener("change", listener); };
const isLandscape = () => !!landscapeMedia()?.matches;
function useLandscapePhone(enabled: boolean) { const matches = useSyncExternalStore(watchLandscape, isLandscape); return enabled && matches; }
/** Visible rail captions. Each button keeps its full accessible name, which
 * contains the caption; "连接" alone is already the noun "Connection". */
const RAIL_LABELS: Record<SupportedLocale, { connect: string; disconnect: string; control: string; stop: string; wait: string; send: string }> = {
  zh: { connect: "连接", disconnect: "断开", control: "控制", stop: "停止", wait: "等待", send: "发送" },
  en: { connect: "Connect", disconnect: "End", control: "Control", stop: "Stop", wait: "Wait", send: "Send" },
  ja: { connect: "接続", disconnect: "切断", control: "操作", stop: "停止", wait: "待機", send: "送信" },
};
const SCREEN_STATUS_LABEL_MS = 4000;

function routeDisplayLabel(route: ScreenRouteKind, udpRequested: boolean, udpConnected: boolean): string {
  switch (route) {
    case "udp_lan_direct": return t("UDP · 局域网直连");
    case "udp_tailscale_direct": return t("UDP · Tailscale 直连");
    case "udp_p2p": return t("UDP · P2P 直连");
    case "udp_vps_relay": return t("UDP · VPS 中转");
    case "tcp_lan_direct": return udpRequested && !udpConnected ? t("TCP · 局域网直连（UDP 未连通）") : t("TCP · 局域网直连");
    case "tcp_tailscale": return udpRequested && !udpConnected ? t("TCP · Tailscale（UDP 未连通）") : t("TCP · Tailscale");
    case "tcp_vps_relay": return udpRequested && !udpConnected ? t("TCP · VPS 中转（UDP 未连通）") : t("TCP · VPS 中转");
    default: return udpRequested && !udpConnected ? t("TCP（UDP 未连通）") : t("TCP（默认）");
  }
}

function formatBitrate(kbps: number): string {
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${kbps} kbps`;
}

function resolveScreenRoute(routeName?: "Direct" | "Tailscale" | "VPS" | "Cloudflare"): ScreenRouteKind {
  return tcpRouteFromConnectionRoute(routeName === "Cloudflare" ? undefined : routeName);
}

function ScreenMetricsOverlay({ metrics, activeRoute, udpRequested, udpConnected, fallbackWidth, fallbackHeight }: {
  metrics?: ScreenPerformanceSnapshot;
  activeRoute: ScreenRouteKind;
  udpRequested: boolean;
  udpConnected: boolean;
  fallbackWidth?: number;
  fallbackHeight?: number;
}) {
  const fps = metrics?.fps ?? 0;
  const latency = metrics?.latencyMs;
  const p95 = metrics?.p95LatencyMs;
  const bitrate = formatBitrate(metrics?.bitrateKbps ?? 0);
  const w = metrics?.width || fallbackWidth || 0;
  const h = metrics?.height || fallbackHeight || 0;
  const codec = metrics?.codec ? metrics.codec.toUpperCase() : "";
  const dropped = metrics?.droppedFrames ?? 0;
  const skipped = metrics?.skippedFrames ?? 0;
  const route = metrics?.route ?? activeRoute;
  const isUdpRequested = metrics?.udpRequested ?? udpRequested;
  const isUdpConnected = metrics?.udpConnected ?? udpConnected;
  return <div className="screen-metrics-overlay" role="region" aria-label={t("屏幕性能数据")}>
    <div className="screen-metrics-row"><span>{t("帧率")}</span><strong>{fps} fps</strong></div>
    <div className="screen-metrics-row"><span>{t("端到端延迟")}</span><strong>{latency !== null && latency !== undefined ? `${latency} ms${p95 !== null && p95 !== undefined ? ` (p95 ${p95})` : ""}` : "—"}</strong></div>
    <div className="screen-metrics-row"><span>{t("码率与分辨率")}</span><strong>{bitrate}{w && h ? ` · ${w}×${h}` : ""}{codec ? ` · ${codec}` : ""}</strong></div>
    <div className="screen-metrics-row"><span>{t("丢帧 / 跳帧")}</span><strong>{dropped} / {skipped}</strong></div>
    <div className="screen-metrics-row"><span>{t("当前链路")}</span><strong>{routeDisplayLabel(route, isUdpRequested, isUdpConnected)}</strong></div>
  </div>;
}

export function RemoteScreenPanel({connection,hostName,visible,close,openSettings,standalone=false}:{connection:HubConnection;hostName:string;visible:boolean;close:()=>void;openSettings?:()=>void;standalone?:boolean}) {
  const locale = useLocale(), windows = window.tarobotDesktop?.platform === "win32", mobile = isMobileScreenApp(), landscape = useLandscapePhone(mobile);
  const connState = useSyncExternalStore(notify => typeof connection.subscribe === "function" ? connection.subscribe(notify) : () => {}, () => connection.state);
  const landscapeNow = useRef(landscape); landscapeNow.current = landscape;
  // Android hardware keyboards use Ctrl-based shortcuts; iOS keeps Mac keys.
  // Explicit on-screen shortcuts already contain the target's codes.
  const controller = windows || mobile && Capacitor.getPlatform() === "android" ? "windows" : "mac";
  const [sharpSupported,setSharpSupported]=useState(false);
  useEffect(()=>{let live=true;void supportedScreenCodecs("sharp").then(()=>{if(live)setSharpSupported(true);},()=>{if(live)setSharpSupported(false);});return()=>{live=false;};},[]);
  const [quality,setQuality]=useState<ScreenQuality>(mobile?"smooth":SCREEN_DEFAULT_QUALITY),[legacyQuality,setLegacyQuality]=useState(false);
  // Sessions and barriers belong to one Host. An unreachable previous Host
  // must not block opening the newly selected one, or clean up its sessions.
  const lifecycles=useRef(new WeakMap<HubConnection,{opening:Promise<void>;retiring:Promise<void>;sessions:Set<string>}>());
  const lifecycle=lifecycles.current.get(connection)??{opening:Promise.resolve(),retiring:Promise.resolve(),sessions:new Set<string>()};
  lifecycles.current.set(connection,lifecycle);
  const retire=()=>{const task=lifecycle.retiring.catch(()=>undefined).then(async()=>{for(const id of lifecycle.sessions){await connection.screenStop(id);lifecycle.sessions.delete(id);}});lifecycle.retiring=task;return task;};
  const [modifierMode, setModifierMode] = useState<ScreenModifierMode>("command"), lastClick = useRef<{button:number;x:number;y:number;at:number;count:1|2|3}|undefined>(undefined);
  const knownTarget = useRef<{connection:HubConnection;platform:"macos"|"windows"}|undefined>(undefined);
  const visibleNow=useRef(visible);visibleNow.current=visible;
  const panel=useRef<HTMLElement>(null),canvas=useRef<HTMLCanvasElement>(null),keyboardButton=useRef<HTMLButtonElement>(null),tray=useRef<HTMLDivElement>(null),viewer=useRef<RemoteScreenViewer>(undefined),attempt=useRef(0);
  const [status,setStatus]=useState<ScreenStatus>(),[display,setDisplay]=useState(""),[error,setError]=useState(""),[statusError,setStatusError]=useState(""),[notice,setNotice]=useState(""),[state,setState]=useState<ViewerState>({state:"closed",controlling:false,pending:false,fresh:false});
  const [wide,setWide]=useState(false),[scale,setScale]=useState("fit"),[text,setText]=useState(""),[showText,setShowText]=useState(false),[bounds,setBounds]=useState<{left:number;top:number;width:number;height:number}>();
  const viewport=useRef<HTMLDivElement>(null),touch=useRef<ScreenTouch>(undefined),touchFrame=useRef(0),holdTimer=useRef<ReturnType<typeof setTimeout>>(undefined),composing=useRef(false);
  const [imeComposing,setImeComposing]=useState(false);
  const [transform,setTransform]=useState<ScreenTransform>({zoom:1,x:0,y:0}),[fitSize,setFitSize]=useState({width:640,height:360});
  const clearTouch=()=>{clearTimeout(holdTimer.current);cancelAnimationFrame(touchFrame.current);touchFrame.current=0;touch.current?.cancel();};
  // Closing the tray removes its text field. If that field held focus (the
  // toggle never takes focus from it), focus would fall to <body> and the
  // viewer's input gate would close, so renewals stop and control lapses.
  // Hand it to the shown picture while the session lives, else to this toggle.
  // Only focus moves: nothing reconnects, resumes control or renews by itself;
  // a real blur, background or a closed session keeps its own outcome.
  const toggleKeyboard=()=>{
    setTools(false);if(!showText){setShowText(true);return;}
    const owned=!!tray.current?.contains(document.activeElement);setShowText(false);
    if(owned&&activeNow.current&&document.hasFocus())(state.state!=="closed"?canvas.current:keyboardButton.current)?.focus({preventScroll:true});
  };
  const clearPicture=()=>{clearTouch();if(canvas.current){canvas.current.width=1;canvas.current.height=1;}setText("");composing.current=false;setImeComposing(false);};
  // Background/lock ends a session exactly as before; on return the status line
  // says why (screen_background) until the next connect. Repeated lifecycle
  // events while away keep it; hiding the viewer starts fresh.
  const mobileForeground=useScreenMobileLifecycle(mobile,visible,reason=>{if(!reason)setNotice("");else if(viewer.current||state.state!=="closed")setNotice(reason);disconnect();clearPicture();});
  const activeNow=useRef(true);activeNow.current=!mobile||mobileForeground&&visible&&document.documentElement.dataset.mobileLocked!=="true";
  const chrome=useRef<HTMLDivElement>(null), hideTimer=useRef<ReturnType<typeof setTimeout>>(undefined);
  const [tools,setTools]=useState(false),[chromeVisible,setChromeVisible]=useState(true),[showMetrics,setShowMetrics]=useState(false);
  const closing=useRef<object>(undefined),[isClosing,setClosing]=useState(false);
  // Navigation hides this Host-owned viewer without unmounting it. A pending
  // close belongs to the visibility instance where the user requested it.
  useEffect(()=>{setClosing(false);return()=>{closing.current=undefined;};},[connection,visible]);
  const fullscreen=useScreenFullscreen(panel,visible,()=>viewer.current?.release());
  useEffect(()=>{if(state.state==="closed")setLegacyQuality(false);},[state.state]);
  useEffect(()=>{if(fullscreen.active)canvas.current?.focus({preventScroll:true});},[fullscreen.active]);
  const reveal=()=>{clearTimeout(hideTimer.current);setChromeVisible(true);};
  const hideLater=()=>{clearTimeout(hideTimer.current);if(fullscreen.active&&state.fresh&&!tools&&!chrome.current?.contains(document.activeElement))hideTimer.current=setTimeout(()=>setChromeVisible(false),2400);};
  useEffect(()=>{reveal();hideLater();return()=>clearTimeout(hideTimer.current);},[fullscreen.active,state.fresh,tools]);
  useEffect(()=>{if(mobile)clearPicture();setStatus(undefined);setDisplay("");setError("");setStatusError("");setNotice("");setQuality(mobile?"smooth":SCREEN_DEFAULT_QUALITY);setLegacyQuality(false);setText("");setShowText(false);setTools(false);lastClick.current=undefined;setState({state:"closed",controlling:false,pending:false,fresh:false});return()=>{++attempt.current;clearTouch();viewer.current?.dispose();viewer.current=undefined;void retire().catch(()=>undefined);};},[connection]);
  // While disconnected, refresh permissions and displays after the target
  // recovers or the user returns from Settings. Never reuse another Host's data.
  useEffect(()=>{
    if(!visible||mobile&&!mobileForeground||state.state!=="closed")return;
    let live=true,reading=false;
    const read=async()=>{if(reading||!live||document.visibilityState!=="visible")return;reading=true;const n=attempt.current;
      try{const s=await connection.screenStatus();if(live&&n===attempt.current){setStatus(s);setDisplay(id=>s.desktop?.displays.some(d=>d.id===id)?id:s.desktop?.displays[0]?.id??"");setStatusError("");}}
      catch(e){if(live&&n===attempt.current){setStatus(undefined);setDisplay("");setStatusError(e instanceof Error?e.message:String(e));}}finally{reading=false;}};
    void read();const timer=setInterval(()=>void read(),3000),focus=()=>void read();
    window.addEventListener("focus",focus);document.addEventListener("visibilitychange",focus);
    return()=>{live=false;clearInterval(timer);window.removeEventListener("focus",focus);document.removeEventListener("visibilitychange",focus);};
  },[connection,visible,state.state,mobile,mobileForeground]);
  useEffect(()=>{const update=()=>viewer.current?.visibility(visible&&document.visibilityState==="visible");update();document.addEventListener("visibilitychange",update);window.addEventListener("focus",update);const blur=()=>viewer.current?.release();window.addEventListener("blur",blur);return()=>{document.removeEventListener("visibilitychange",update);window.removeEventListener("focus",update);window.removeEventListener("blur",blur);};},[visible]);
  useLayoutEffect(()=>{
    const element=viewport.current;if(!mobile||!element)return;
    const next=new ScreenTouch({width:1,height:1,imageWidth:state.width??640,imageHeight:state.height??360},event=>{if(event.kind==="wheel")viewer.current?.wheel(event);else viewer.current?.input(event);},setTransform);touch.current=next;next.setControl(state.controlling&&state.fresh);
    // Rotation and new streams refit. On a landscape phone the system keyboard
    // only shortens the picture area: keep the picture's scale and place.
    let keyboardBefore=false;
    const measure=()=>{clearTouch();const size={width:element.clientWidth,height:element.clientHeight,imageWidth:state.width??640,imageHeight:state.height??360},keyboard=document.documentElement.dataset.keyboardOpen==="true";
      if(landscapeNow.current&&(keyboard||keyboardBefore))next.reframe(size);else next.resize(size);keyboardBefore=keyboard;setFitSize(next.dimensions);};
    const observer=new ResizeObserver(measure);observer.observe(element);measure();return()=>{observer.disconnect();clearTouch();if(touch.current===next)touch.current=undefined;};
  },[mobile,state.width,state.height]);
  useEffect(()=>{clearTouch();touch.current?.setControl(state.controlling&&state.fresh);},[state.controlling,state.fresh]);
  useEffect(()=>{const target=canvas.current;if(!target)return;const wheel=(e:WheelEvent)=>{const current=viewer.current;if(!current?.state.controlling)return;e.preventDefault();const factor=e.deltaMode===1?16:e.deltaMode===2?target.clientHeight:1;current.wheel({kind:"wheel",...point(e),dx:Math.max(-2000,Math.min(2000,e.deltaX*factor)),dy:Math.max(-2000,Math.min(2000,e.deltaY*factor))});};target.addEventListener("wheel",wheel,{passive:false});return()=>target.removeEventListener("wheel",wheel);},[]);
  useLayoutEffect(()=>{if(!wide||!visible){setBounds(undefined);return;}const shell=panel.current?.parentElement,main=shell?.querySelector<HTMLElement>(":scope > .conversation-main");if(!shell||!main)return;const measure=()=>{const a=shell.getBoundingClientRect(),b=main.getBoundingClientRect();setBounds({left:b.left-a.left,top:b.top-a.top,width:a.right-b.left,height:b.height});};const ro=new ResizeObserver(measure);ro.observe(shell);ro.observe(main);measure();return()=>ro.disconnect();},[wide,visible]);
  const connect=(requested:ScreenQuality=quality,legacy=legacyQuality)=>{
    if(mobile&&!activeNow.current)return;
    const n=++attempt.current,previous=lifecycle.opening;
    viewer.current?.dispose();viewer.current=undefined;setError("");setNotice("");setState({state:"connecting",controlling:false,pending:false,fresh:false});
    const run=async()=>{let cleanupOnError=false;try{
      // An earlier open may still return a session after cancellation. It owns
      // its cleanup; do not let a replacement race ahead of that response.
      await previous;await retire();if(n!==attempt.current)return;
      const s=await connection.screenStatus();if(n!==attempt.current)return;setStatus(s);setStatusError("");
      if(!s.enabled)throw new Error("screen_disabled");if(s.permission==="none")throw new Error("screen_not_authorized");if(s.desktop?.locked)throw new Error("screen_locked");if(s.desktop&&s.desktop.capture!=="granted")throw new Error("screen_capture_denied");
      const d=s.desktop?.displays.find(d=>d.id===display);if(!s.desktop||!d)throw new Error("screen_service_offline");
      const codecs=await supportedScreenCodecs(connection.state.screenQualityAvailable&&!legacy?requested:SCREEN_DEFAULT_QUALITY);if(n!==attempt.current)return;
      const explicit=connection.state.screenQualityAvailable&&!legacy;
      // What this App can hold unacknowledged, named only to a Host that knows the field.
      const flight=connection.state.screenFlightAvailable?await screenViewerFlight():undefined;if(n!==attempt.current)return;
      const openStartMs = Date.now(), openMonoStart = performance.now();
      const result=await connection.screenOpen({desktopId:s.desktop.desktopId,displayId:d.id,displayRevision:d.revision,requestId:crypto.randomUUID(),codecs,...(explicit?{quality:requested}:{}),...(flight?{flight}:{})});
      const openEndMs = Date.now(), openMonoRtt = Math.max(0, performance.now() - openMonoStart);
      const serverTimeOffsetMs = typeof (result as { serverTimeOffsetMs?: number }).serverTimeOffsetMs === "number"
        ? (result as { serverTimeOffsetMs: number }).serverTimeOffsetMs
        : estimateServerTimeOffset(result.join.serverTime, openStartMs, openEndMs, openMonoRtt);
      lifecycle.sessions.add(result.join.session.id);cleanupOnError=true;
      if(n!==attempt.current||!canvas.current){cleanupOnError=false;await retire();return;}
      if(explicit&&result.join.quality!==requested)throw new Error("screen_quality_unconfirmed");
      setQuality(result.join.quality??SCREEN_DEFAULT_QUALITY);
      const connectRoute = resolveScreenRoute(connection.state.route?.name);
      const metricsOpts = { routeHint: connectRoute, udpRequested: s.udpStatus?.enabled ?? false, serverTimeOffsetMs, rtcSignaling: result.rtcSignaling };
      const next=new RemoteScreenViewer(result.join,canvas.current,value=>{if(n===attempt.current){if(mobile&&value.state==="closed")clearPicture();setState(value);}},mobile?{...metricsOpts,transport:mobileScreenViewerTransport,flight,inputActive:()=>activeNow.current&&document.hasFocus()&&document.visibilityState==="visible"&&!!panel.current?.contains(document.activeElement)}:{...metricsOpts,flight});viewer.current=next;
      next.visibility(visibleNow.current&&document.visibilityState==="visible");await next.open(result.network);
      if(n!==attempt.current){next.dispose();cleanupOnError=false;await retire();return;}next.visibility(visibleNow.current&&document.visibilityState==="visible");
    }catch(e){if(n===attempt.current){viewer.current?.dispose();viewer.current=undefined;setError(mobile&&e instanceof Error&&e.message==="screen_decoder_unavailable"?"screen_mobile_decoder_unavailable":e instanceof Error?e.message:String(e));setState({state:"closed",controlling:false,pending:false,fresh:false});}if(cleanupOnError)await retire().catch(()=>undefined);}};
    lifecycle.opening=run();return lifecycle.opening;
  };
  const disconnect=()=>{setLegacyQuality(false);const n=++attempt.current;clearTouch();viewer.current?.dispose();viewer.current=undefined;if(mobile)clearPicture();setState({state:"closed",controlling:false,pending:false,fresh:false});void retire().catch(e=>{if(n===attempt.current)setError(e instanceof Error?e.message:String(e));});};
  const closeViewer=async()=>{
    if(closing.current)return;
    const token={};closing.current=token;setClosing(true);disconnect();
    // Keep the fullscreen element mounted until the browser has exited. A
    // failed exit leaves a disconnected viewer with working retry controls.
    // Host changes/unmount invalidate this close before its await can finish.
    try{if(await fullscreen.exit()&&closing.current===token)close();}
    finally{if(closing.current===token){closing.current=undefined;setClosing(false);}}
  };
  const changeQuality=(value:ScreenQuality)=>{setQuality(value);setError("");if(state.state!=="closed")void connect(value);};
  const point=(e:{clientX:number;clientY:number})=>{const b=canvas.current!.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-b.left)/b.width)),y:Math.max(0,Math.min(1,(e.clientY-b.top)/b.height))};};
  const touchPoint=(e:{clientX:number;clientY:number})=>{const b=viewport.current!.getBoundingClientRect();return{x:e.clientX-b.left,y:e.clientY-b.top};};
  const shortcut=(codes:readonly string[])=>{if(!state.controlling)return;canvas.current?.focus();for(const code of codes)viewer.current?.input({kind:"key",code,down:true});for(const code of [...codes].reverse())viewer.current?.input({kind:"key",code,down:false});};
  // Keys and shortcuts follow the controlled computer; mobile hardware keys
  // use the controller platform instead of the browser user-agent brand.
  const target = status?.desktop?.platform ?? "macos", remap = screenModifierModeApplies(controller, target);
  // Desktop control: the picture carries the target's own pointer, so the local
  // one is hidden over the picture only (toolbar, menus and the letterbox keep
  // it). It returns the moment input stops: stale picture, control withdrawn,
  // window blur (which releases control) or the end of the session. Both kinds
  // of target capture their own pointer into the picture (Mac verified
  // 2026-11-21; Windows 2026-11-22, the ordinary arrow in a captured frame).
  const hideLocalPointer = !mobile && state.controlling && state.fresh;
  // Reasons name the computer last read for this Host: once a session ends its
  // desktop service may be gone (sleep, App quit), leaving no platform to read.
  if(status?.desktop?.platform)knownTarget.current={connection,platform:status.desktop.platform};
  const errorTarget = status?.desktop?.platform ?? (knownTarget.current?.connection===connection?knownTarget.current.platform:undefined) ?? "unknown";
  const blocked = status ? !status.enabled ? "screen_disabled" : status.permission === "none" ? "screen_not_authorized"
    : !status.desktop ? "screen_service_offline" : status.desktop.locked ? "screen_locked"
    : status.desktop.capture !== "granted" ? "screen_capture_denied" : !status.desktop.displays.length ? "screen_display_unavailable" : "" : "";
  // A status read that failed in transport (no reason code) must not hide the
  // localized reason that ended the session.
  const endedBy=state.reason||(state.state==="closed"&&!blocked?notice:""),statusShown=statusError&&!(endedBy&&!isScreenReasonCode(statusError));
  const stateText=error?screenError(error,errorTarget):statusShown?screenError(statusError,errorTarget):state.reason?screenError(state.reason,errorTarget):state.controlling?mobile?t("正在控制 · 可随时停止控制"):t("正在控制 · Ctrl+Alt+Shift+Esc 退出控制"):state.state==="connecting"?t("正在连接屏幕…"):state.state==="closed"?(blocked?screenError(blocked,errorTarget):notice?screenError(notice,errorTarget):t("尚未连接")):!state.fresh?t("画面暂未更新，控制已停止，请等待新画面。"):state.controlAllowed?t("查看中 · 点击开始控制后操作"):t("查看中 · 仅查看");
  const actualResolution=!error&&!statusError&&state.state!=="closed"&&state.fresh&&state.width&&state.height?`${state.width}×${state.height}`:"";
  const qualityHint=sharpSupported?t("720p 节省带宽，最高 3K 保留更多文字细节"):t("此设备不支持最高 3K 解码，请改用 1080p 或 720p。");
  const qualityTitle=!connection.state.screenQualityAvailable?t("更新主机后可选择清晰度"):legacyQuality?t("目标电脑的 App 暂不支持画质选择，请更新后重试，或以默认画质连接。"):actualResolution?t("当前 {0} · {1}",actualResolution,qualityHint):qualityHint;
  const qualitySelect=<select aria-label={t("画面清晰度")} title={qualityTitle} value={quality} disabled={!connection.state.screenQualityAvailable||legacyQuality||state.state==="connecting"} onChange={e=>changeQuality(e.target.value as ScreenQuality)}><option value="smooth">720p</option><option value="balanced">1080p</option><option value="sharp" disabled={!sharpSupported}>{t("最高 3K")}</option></select>;
  // Landscape status label: a calm view fades after a few seconds, anything
  // that needs attention stays. Only opacity changes; the live region remains.
  const calm=state.state!=="closed"&&state.state!=="connecting"&&state.fresh&&!state.pending&&!error&&!statusShown&&!state.reason&&!imeComposing;
  const attention=!!(error||statusShown||state.reason||state.state==="closed"&&(blocked||notice));
  const resolution=!error&&!statusError&&!state.reason&&state.fresh&&state.width?` · ${state.width} × ${state.height}`:"";
  const statusLabel=`${hostName} · ${imeComposing?t("请先在键盘上确认候选词，再发送。"):stateText}${resolution}`;
  const [labelAwake,setLabelAwake]=useState(true),labelTimer=useRef<ReturnType<typeof setTimeout>>(undefined);
  const wakeLabel=()=>{clearTimeout(labelTimer.current);setLabelAwake(true);labelTimer.current=setTimeout(()=>setLabelAwake(false),SCREEN_STATUS_LABEL_MS);};
  useEffect(()=>{if(landscape)wakeLabel();return()=>clearTimeout(labelTimer.current);},[landscape,statusLabel]);
  // Rotation swaps the heading for the rail. If that removed the focused
  // control, keep focus in the viewer so its input gate stays open.
  const lastFocus=useRef<Element|null>(null);
  useLayoutEffect(()=>{const node=lastFocus.current;if(!mobile||!node||node.isConnected||document.activeElement&&document.activeElement!==document.body||!activeNow.current||!document.hasFocus())return;(state.state!=="closed"?canvas.current:keyboardButton.current)?.focus({preventScroll:true});},[landscape]);
  const activeRoute = resolveScreenRoute(connState.route?.name);
  const udpRequested = status?.udpStatus?.enabled ?? false;
  const udpConnected = state.metrics?.udpConnected === true;
  useEffect(() => {
    viewer.current?.setRoute(activeRoute, { udpRequested });
  }, [activeRoute, udpRequested]);
  const settingsShown=state.state==="closed"&&!!openSettings&&!!(blocked||statusError||error);
  const legacyConnect=()=>{setLegacyQuality(true);setQuality(SCREEN_DEFAULT_QUALITY);void connect(SCREEN_DEFAULT_QUALITY,true);};
  const rail=RAIL_LABELS[locale];
  return <aside ref={panel} hidden={!visible||mobile&&!mobileForeground} style={!mobile&&bounds?{position:"absolute",...bounds}:undefined} className={`conversation-side-panel remote-screen-panel${mobile?" screen-mobile":""}${landscape?" screen-landscape":""}${wide?" screen-wide":""}${fullscreen.active?" screen-fullscreen":""}`} aria-label={t("远程屏幕")} onFocusCapture={e=>{lastFocus.current=e.target;}} onBlurCapture={e=>{if(!mobile)return;if(e.relatedTarget instanceof Node&&panel.current?.contains(e.relatedTarget))return;queueMicrotask(()=>{if(!panel.current?.contains(document.activeElement))viewer.current?.release();});}} onPointerMove={e=>{if(fullscreen.active&&e.clientY<28){reveal();hideLater();}}}>
    {fullscreen.active&&!chromeVisible&&<button className="screen-reveal" aria-label={t("显示屏幕工具栏")} title={t("显示屏幕工具栏")} onClick={reveal}><ChevronDown size={16}/></button>}
    <div ref={chrome} className={`screen-chrome${fullscreen.active&&!chromeVisible?" screen-chrome-hidden":""}`} onPointerEnter={reveal} onPointerLeave={hideLater} onFocusCapture={reveal} onBlurCapture={()=>queueMicrotask(hideLater)} inert={fullscreen.active&&!chromeVisible?true:undefined}>
    {!landscape&&<header className="screen-heading">
      <div className="screen-title"><strong><Monitor size={15}/>{t("远程屏幕")}</strong><small title={hostName}>{hostName}</small></div>
      <div className="screen-toolbar">
        {!mobile&&qualitySelect}
        {!mobile&&<select aria-label={t("画面缩放")} value={scale} onChange={e=>setScale(e.target.value)}><option value="fit">{t("适应窗口")}</option><option value="1">100%</option><option value="1.5">150%</option><option value="2">200%</option></select>}
        {state.state==="closed"?<button onClick={()=>void connect()} disabled={isClosing||!display||!!blocked||mobile&&!mobileForeground}>{t("连接屏幕")}</button>:<button className="screen-disconnect" aria-label={t("断开")} title={t("断开")} onClick={disconnect}><Unplug size={15}/></button>}
        {(state.state==="closed"?status?.permission==="control":state.controlAllowed)&&<button disabled={!state.fresh||state.pending} onMouseDown={e=>e.preventDefault()} onClick={()=>{state.controlling?viewer.current?.release():viewer.current?.control();hideLater();}}>{state.pending?t("等待新画面…"):state.controlling?t("停止控制"):t("开始控制")}</button>}
      </div>
      <div className="screen-window-actions">
        {mobile&&<button ref={keyboardButton} className="icon-button" aria-label={t("键盘与快捷键")} aria-expanded={showText} onMouseDown={e=>e.preventDefault()} onClick={toggleKeyboard}><Keyboard size={19}/></button>}
        {!mobile&&!standalone&&!fullscreen.active&&<button className="icon-button" aria-label={wide?t("返回并排"):t("展开屏幕")} title={wide?t("返回并排"):t("展开屏幕")} onClick={()=>setWide(v=>!v)}>{wide?<Minimize2 size={17}/>:<Maximize2 size={17}/>}</button>}
        {!mobile&&<button className="icon-button" aria-label={fullscreen.active?t("退出全屏"):t("全屏")} title={fullscreen.active?t("退出全屏"):t("全屏")} disabled={isClosing||!fullscreen.supported} onClick={fullscreen.toggle}>{fullscreen.active?<Minimize size={17}/>:<Maximize size={17}/>}</button>}
        <button className="icon-button" aria-label={showMetrics?t("隐藏性能数据"):t("显示性能数据")} title={showMetrics?t("隐藏性能数据"):t("显示性能数据")} aria-pressed={showMetrics} onMouseDown={e=>e.preventDefault()} onClick={()=>setShowMetrics(v=>!v)}><Activity size={16}/></button>
        <button className="icon-button" aria-label={t("屏幕更多操作")} title={t("屏幕更多操作")} aria-expanded={tools} onMouseDown={e=>e.preventDefault()} onClick={()=>setTools(v=>!v)}><MoreHorizontal size={17}/></button>
        <button className="icon-button" aria-label={t("断开并关闭屏幕")} title={t("断开并关闭屏幕")} disabled={isClosing} onClick={()=>void closeViewer()}><X size={18}/></button>
      </div>
    </header>}
    {landscape&&<div className="screen-rail">
      <div className="screen-rail-group">
        <button className="icon-button screen-rail-close" aria-label={t("断开并关闭屏幕")} title={t("断开并关闭屏幕")} disabled={isClosing} onClick={()=>void closeViewer()}><X size={20}/></button>
        <button className="icon-button screen-rail-more" aria-label={t("屏幕更多操作")} title={t("屏幕更多操作")} aria-expanded={tools} onMouseDown={e=>e.preventDefault()} onClick={()=>{wakeLabel();setTools(v=>!v);}}><MoreHorizontal size={20}/></button>
        <button ref={keyboardButton} className="icon-button" aria-label={t("键盘与快捷键")} aria-expanded={showText} onMouseDown={e=>e.preventDefault()} onClick={()=>{wakeLabel();toggleKeyboard();}}><Keyboard size={20}/></button>
      </div>
      <div className="screen-rail-group screen-rail-session">
        {state.state==="closed"
          ?<button className="screen-rail-labeled" aria-label={t("连接屏幕")} onClick={()=>{wakeLabel();void connect();}} disabled={isClosing||!display||!!blocked||mobile&&!mobileForeground}><span className="screen-rail-icon"><Plug size={19}/></span><span className="screen-rail-label" aria-hidden="true">{rail.connect}</span></button>
          :<button className="screen-rail-labeled" aria-label={t("断开")} title={t("断开")} onClick={()=>{wakeLabel();disconnect();}}><span className="screen-rail-icon"><Unplug size={19}/></span><span className="screen-rail-label" aria-hidden="true">{rail.disconnect}</span></button>}
        {(state.state==="closed"?status?.permission==="control":state.controlAllowed)&&<button className="screen-rail-labeled screen-rail-control" data-active={state.controlling?"":undefined} aria-label={state.pending?t("等待新画面…"):state.controlling?t("停止控制"):t("开始控制")} disabled={!state.fresh||state.pending} onMouseDown={e=>e.preventDefault()} onClick={()=>{wakeLabel();state.controlling?viewer.current?.release():viewer.current?.control();}}><span className="screen-rail-icon"><MousePointer2 size={19}/></span><span className="screen-rail-label" aria-hidden="true">{state.pending?rail.wait:state.controlling?rail.stop:rail.control}</span></button>}
      </div>
    </div>}
    <p className={landscape?"screen-state screen-status-label":"screen-state"} role="status" data-faded={landscape&&calm&&!labelAwake?"":undefined} data-alert={landscape&&attention?"":undefined}>{landscape?statusLabel:<>{fullscreen.error??stateText}{!error&&!statusError&&!state.reason&&state.fresh&&state.width&&<span className="screen-resolution"> · {state.width} × {state.height}</span>}{error==="screen_quality_unsupported"&&<button onClick={legacyConnect}>{t("以默认画质连接")}</button>}</>}</p>
    {!landscape&&settingsShown&&<p className="screen-state"><button onClick={openSettings}>{t("屏幕控制设置")}</button></p>}
    {landscape&&(error==="screen_quality_unsupported"||settingsShown)&&<div className="screen-status-actions">{error==="screen_quality_unsupported"&&<button onClick={legacyConnect}>{t("以默认画质连接")}</button>}{settingsShown&&<button onClick={openSettings}>{t("屏幕控制设置")}</button>}</div>}
    {tools&&<div className="screen-tools-popover" role="region" aria-label={t("屏幕更多操作")}>
    {mobile&&<><label className="screen-display"><span>{t("画面清晰度")}{actualResolution&&<small className="screen-quality-actual">{t("当前 {0}",actualResolution)}</small>}</span>{qualitySelect}</label><button onMouseDown={e=>e.preventDefault()} onClick={()=>{touch.current?.fit();setTools(false);}}>{t("适应窗口")}</button><p className="screen-touch-help">{t("查看时拖动画面、双指缩放。控制时点按左键、长按右键、单指拖动、双指滚动；捏合只缩放画面。")}</p></>}
    {landscape&&<p className="screen-touch-help">{t("仅在开始控制后，点击发送才会提交文本。")}</p>}
    <label className="screen-display screen-metrics-toggle" onMouseDown={e=>e.preventDefault()}><span>{t("性能数据覆盖层")}</span><input type="checkbox" checked={showMetrics} onMouseDown={e=>e.preventDefault()} onChange={e=>setShowMetrics(e.target.checked)}/></label>
    <label className="screen-display">{t("显示器")}<select aria-label={t("显示器")} value={display} onChange={e=>{disconnect();setDisplay(e.target.value);}}>{status?.desktop?.displays.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
    <div className="screen-shortcuts"><details><summary onMouseDown={e=>e.preventDefault()}>{t("发送组合键")}</summary><div>{screenShortcuts(target).map(shortcut=><button key={shortcut.id} disabled={!state.controlling} onMouseDown={e=>e.preventDefault()} onClick={e=>{canvas.current?.focus();for(const code of shortcut.codes)viewer.current?.input({kind:"key",code,down:true});for(const code of [...shortcut.codes].reverse())viewer.current?.input({kind:"key",code,down:false});e.currentTarget.closest("details")?.removeAttribute("open");}}>{shortcut.label[locale] ?? shortcut.label.en}</button>)}</div></details>{remap&&<select aria-label={controller==="windows"?t("Windows 修饰键"):t("Mac 修饰键")} value={modifierMode} onChange={e=>{viewer.current?.release();setModifierMode(e.target.value as ScreenModifierMode);}}>{controller==="windows"?<><option value="command">Ctrl → ⌘ · Win → ⌃</option><option value="physical">Ctrl → ⌃ · Win → ⌘</option></>:<><option value="command">⌘ → Ctrl · ⌃ → Win</option><option value="physical">⌃ → Ctrl · ⌘ → Win</option></>}</select>}</div>
    {!mobile&&<div className="screen-bottom"><button onClick={()=>{viewer.current?.release();setShowText(v=>!v);}}>{t("发送文本")}</button><span>{target==="windows"?<>{remap&&<>{modifierMode==="command"?t("Command 对应 Ctrl，Control 对应 Win，Option 对应 Alt"):t("Control 对应 Ctrl，Command 对应 Win，Option 对应 Alt")}{" · "}</>}{t("按键按键位发送，字符由目标电脑的键盘布局决定。")}</>:windows?(modifierMode==="command"?t("Ctrl 对应 Command，Win 对应 Control，Alt 对应 Option"):t("Windows：Ctrl 对应 Control，Win 对应 Command，Alt 对应 Option")):t("点击聊天输入框会立即停止远端控制。")}</span></div>}
    {!mobile&&showText&&<div className="screen-text"><textarea aria-label={t("发送到远端的文本")} maxLength={2048} value={text} onChange={e=>setText(e.target.value)} placeholder={t("在这里输入或粘贴中文文本，不会同步剪贴板。")}/><button disabled={!text||!state.controlling} onMouseDown={e=>e.preventDefault()} onClick={()=>{canvas.current?.focus();if(viewer.current?.input({kind:"text",text}))setText("");}}>{t("发送到远端")}</button><p>{t("编辑完成后点击开始控制，再发送文本。")}</p></div>}
    </div>}
    </div>
    {mobile&&showText&&<div ref={tray} className="screen-mobile-keyboard"><div className="screen-mobile-keys" aria-label={t("快捷键")}>{["Escape","Tab","Enter","Backspace","ArrowLeft","ArrowUp","ArrowDown","ArrowRight"].map(code=><button key={code} disabled={!state.controlling} onMouseDown={e=>e.preventDefault()} onClick={()=>shortcut([code])} aria-label={landscape&&code==="Enter"?"Enter":undefined}>{landscape&&code==="Enter"?<CornerDownLeft size={16} aria-hidden="true"/>:({Escape:"Esc",Backspace:"⌫",ArrowLeft:"←",ArrowUp:"↑",ArrowDown:"↓",ArrowRight:"→"} as Record<string,string>)[code]??code}</button>)}{screenShortcuts(target).map(item=><button key={item.id} disabled={!state.controlling} onMouseDown={e=>e.preventDefault()} onClick={()=>shortcut(item.codes)}>{item.label[locale] ?? item.label.en}</button>)}</div><div className="screen-text" onPointerDownCapture={e=>{if(e.target instanceof HTMLButtonElement&&e.target.disabled)e.preventDefault();}}><textarea aria-label={t("发送到远端的文本")} maxLength={2048} value={text} onCompositionStart={()=>{composing.current=true;setImeComposing(true);}} onCompositionEnd={()=>{composing.current=false;setImeComposing(false);}} onChange={e=>setText(e.target.value)} placeholder={t("在这里输入或粘贴中文文本，不会同步剪贴板。")}/><button disabled={imeComposing||!state.controlling||!screenInputEventSchema.safeParse({kind:"text",text}).success} onMouseDown={e=>e.preventDefault()} onClick={()=>{if(composing.current)return;if(viewer.current?.input({kind:"text",text}))setText("");}} aria-label={landscape?t("发送到远端"):undefined}>{landscape?rail.send:t("发送到远端")}</button><small>{imeComposing?t("请先在键盘上确认候选词，再发送。"):t("仅在开始控制后，点击发送才会提交文本。")}</small></div></div>}
    <div className="screen-stage">
    <div ref={viewport} className={`screen-viewport${!mobile&&scale==="fit"?" screen-fit":""}`} onPointerDown={e=>{if(!mobile||e.pointerType==="mouse")return;e.preventDefault();canvas.current?.focus({preventScroll:true});e.currentTarget.setPointerCapture(e.pointerId);touch.current?.down(e.pointerId,touchPoint(e),performance.now());clearTimeout(holdTimer.current);holdTimer.current=setTimeout(()=>touch.current?.hold(performance.now()),SCREEN_TOUCH_HOLD_MS);}} onPointerMove={e=>{if(!mobile||e.pointerType==="mouse")return;e.preventDefault();touch.current?.move(e.pointerId,touchPoint(e));if(!touchFrame.current)touchFrame.current=requestAnimationFrame(()=>{touchFrame.current=0;touch.current?.flush();});}} onPointerUp={e=>{if(!mobile||e.pointerType==="mouse")return;e.preventDefault();clearTimeout(holdTimer.current);touch.current?.up(e.pointerId);if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}} onPointerCancel={()=>{if(mobile)clearTouch();}} onLostPointerCapture={e=>{if(mobile&&touch.current?.hasPointer(e.pointerId))clearTouch();}}>
      <canvas ref={canvas} tabIndex={0} aria-label={t("{0}的远程屏幕",hostName)} className={[state.fresh?"":"screen-stale",hideLocalPointer?"screen-pointer-hidden":""].filter(Boolean).join(" ")} style={mobile?{width:fitSize.width,height:fitSize.height,transform:`translate(-50%,-50%) translate(${transform.x}px,${transform.y}px) scale(${transform.zoom})`}:scale==="fit"?{aspectRatio:state.width&&state.height?`${state.width}/${state.height}`:undefined,width:`min(100cqw, calc(100cqh * ${state.width&&state.height?state.width/state.height:16/9}))`}:{width:(state.width??640)*Number(scale),height:(state.height??360)*Number(scale)}}
        onBlur={e=>{if(!mobile||!panel.current?.contains(e.relatedTarget as Node|null))viewer.current?.release();}} onContextMenu={e=>{if(state.controlling||mobile)e.preventDefault();}}
        onPointerDown={e=>{if(mobile&&e.pointerType!=="mouse"||!state.controlling)return;e.preventDefault();e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);if(e.button>=0&&e.button<=2){const at=performance.now(),last=lastClick.current;const count=last&&last.button===e.button&&at-last.at<=450&&Math.hypot(e.clientX-last.x,e.clientY-last.y)<=4&&last.count<3?(last.count+1) as 2|3:1;lastClick.current={button:e.button,x:e.clientX,y:e.clientY,at,count};viewer.current?.input({kind:"button",...point(e),button:e.button as 0|1|2,down:true,clicks:count});}}}
        onPointerUp={e=>{if(mobile&&e.pointerType!=="mouse"||!state.controlling)return;e.preventDefault();if(e.button<=2)viewer.current?.input({kind:"button",...point(e),button:e.button as 0|1|2,down:false,clicks:lastClick.current?.button===e.button?lastClick.current.count:1});if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}}
        onPointerMove={e=>{if((!mobile||e.pointerType==="mouse")&&state.controlling)viewer.current?.pointerMove(e);}} onPointerCancel={()=>viewer.current?.release()}
        onKeyDown={e=>{if(!state.controlling)return;if(e.code==="Escape"&&e.ctrlKey&&e.altKey&&e.shiftKey){e.preventDefault();viewer.current?.release();return;}if(e.nativeEvent.isComposing||!screenKeyCodeSchema.safeParse(e.code).success)return;e.preventDefault();viewer.current?.input({kind:"key",code:screenControllerCode(e.code,controller,modifierMode,target),down:true});}}
        onKeyUp={e=>{if(!state.controlling||e.nativeEvent.isComposing||!screenKeyCodeSchema.safeParse(e.code).success)return;e.preventDefault();viewer.current?.input({kind:"key",code:screenControllerCode(e.code,controller,modifierMode,target),down:false});}}
      />
    </div>
    {showMetrics&&<ScreenMetricsOverlay metrics={state.metrics} activeRoute={activeRoute} udpRequested={udpRequested} udpConnected={udpConnected} fallbackWidth={state.width} fallbackHeight={state.height}/>}
    </div>

  </aside>;
}
