import { SCREEN_SHORTCUTS, screenControllerCode, type ScreenModifierMode } from "../../src/client-protocol/screen-keys.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Maximize, Maximize2, Minimize, Minimize2, X, Monitor, MoreHorizontal, ChevronDown, Unplug } from "lucide-react";
import type { HubConnection } from "./connection.js";
import type { ScreenStatus } from "../../src/client-protocol/remote-screen.js";
import { screenKeyCodeSchema } from "../../src/client-protocol/remote-screen.js";
import { RemoteScreenViewer, supportedScreenCodecs, type ViewerState } from "./remote-screen-viewer.js";
import { screenError } from "./RemoteScreenSettings.js";
import { t, useLocale } from "./i18n.js";
import "./remote-screen.css";
import { SCREEN_DEFAULT_QUALITY, type ScreenQuality } from "../../src/client-protocol/screen-quality.js";
import { useScreenFullscreen } from "./use-screen-fullscreen.js";

export function RemoteScreenPanel({connection,hostName,visible,close,openSettings,standalone=false}:{connection:HubConnection;hostName:string;visible:boolean;close:()=>void;openSettings?:()=>void;standalone?:boolean}) {
  const locale = useLocale(), windows = window.tarobotDesktop?.platform === "win32";
  const [sharpSupported,setSharpSupported]=useState(false);
  useEffect(()=>{let live=true;void supportedScreenCodecs("sharp").then(()=>{if(live)setSharpSupported(true);},()=>{if(live)setSharpSupported(false);});return()=>{live=false;};},[]);
  const [quality,setQuality]=useState<ScreenQuality>(SCREEN_DEFAULT_QUALITY),[legacyQuality,setLegacyQuality]=useState(false);
  // Sessions and barriers belong to one Host. An unreachable previous Host
  // must not block opening the newly selected one, or clean up its sessions.
  const lifecycles=useRef(new WeakMap<HubConnection,{opening:Promise<void>;retiring:Promise<void>;sessions:Set<string>}>());
  const lifecycle=lifecycles.current.get(connection)??{opening:Promise.resolve(),retiring:Promise.resolve(),sessions:new Set<string>()};
  lifecycles.current.set(connection,lifecycle);
  const retire=()=>{const task=lifecycle.retiring.catch(()=>undefined).then(async()=>{for(const id of lifecycle.sessions){await connection.screenStop(id);lifecycle.sessions.delete(id);}});lifecycle.retiring=task;return task;};
  const [modifierMode, setModifierMode] = useState<ScreenModifierMode>("command"), lastClick = useRef<{button:number;x:number;y:number;at:number;count:1|2|3}|undefined>(undefined);
  const visibleNow=useRef(visible);visibleNow.current=visible;
  const panel=useRef<HTMLElement>(null),canvas=useRef<HTMLCanvasElement>(null),viewer=useRef<RemoteScreenViewer>(undefined),attempt=useRef(0);
  const [status,setStatus]=useState<ScreenStatus>(),[display,setDisplay]=useState(""),[error,setError]=useState(""),[statusError,setStatusError]=useState(""),[state,setState]=useState<ViewerState>({state:"closed",controlling:false,pending:false,fresh:false});
  const [wide,setWide]=useState(false),[scale,setScale]=useState("fit"),[text,setText]=useState(""),[showText,setShowText]=useState(false),[bounds,setBounds]=useState<{left:number;top:number;width:number;height:number}>();
  const chrome=useRef<HTMLDivElement>(null), hideTimer=useRef<ReturnType<typeof setTimeout>>(undefined);
  const [tools,setTools]=useState(false),[chromeVisible,setChromeVisible]=useState(true);
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
  useEffect(()=>{setStatus(undefined);setDisplay("");setError("");setStatusError("");setQuality(SCREEN_DEFAULT_QUALITY);setLegacyQuality(false);setText("");setShowText(false);setTools(false);lastClick.current=undefined;setState({state:"closed",controlling:false,pending:false,fresh:false});return()=>{++attempt.current;viewer.current?.dispose();viewer.current=undefined;void retire().catch(()=>undefined);};},[connection]);
  // While disconnected, refresh permissions and displays after the target
  // recovers or the user returns from Settings. Never reuse another Host's data.
  useEffect(()=>{
    if(!visible||state.state!=="closed")return;
    let live=true,reading=false;
    const read=async()=>{if(reading||!live||document.visibilityState!=="visible")return;reading=true;const n=attempt.current;
      try{const s=await connection.screenStatus();if(live&&n===attempt.current){setStatus(s);setDisplay(id=>s.desktop?.displays.some(d=>d.id===id)?id:s.desktop?.displays[0]?.id??"");setStatusError("");}}
      catch(e){if(live&&n===attempt.current){setStatus(undefined);setDisplay("");setStatusError(e instanceof Error?e.message:String(e));}}finally{reading=false;}};
    void read();const timer=setInterval(()=>void read(),3000),focus=()=>void read();
    window.addEventListener("focus",focus);document.addEventListener("visibilitychange",focus);
    return()=>{live=false;clearInterval(timer);window.removeEventListener("focus",focus);document.removeEventListener("visibilitychange",focus);};
  },[connection,visible,state.state]);
  useEffect(()=>{const update=()=>viewer.current?.visibility(visible&&document.visibilityState==="visible");update();document.addEventListener("visibilitychange",update);window.addEventListener("focus",update);const blur=()=>viewer.current?.release();window.addEventListener("blur",blur);return()=>{document.removeEventListener("visibilitychange",update);window.removeEventListener("focus",update);window.removeEventListener("blur",blur);};},[visible]);
  useEffect(()=>{const target=canvas.current;if(!target)return;const wheel=(e:WheelEvent)=>{const current=viewer.current;if(!current?.state.controlling)return;e.preventDefault();const factor=e.deltaMode===1?16:e.deltaMode===2?target.clientHeight:1;current.wheel({kind:"wheel",...point(e),dx:Math.max(-2000,Math.min(2000,e.deltaX*factor)),dy:Math.max(-2000,Math.min(2000,e.deltaY*factor))});};target.addEventListener("wheel",wheel,{passive:false});return()=>target.removeEventListener("wheel",wheel);},[]);
  useLayoutEffect(()=>{if(!wide||!visible){setBounds(undefined);return;}const shell=panel.current?.parentElement,main=shell?.querySelector<HTMLElement>(":scope > .conversation-main");if(!shell||!main)return;const measure=()=>{const a=shell.getBoundingClientRect(),b=main.getBoundingClientRect();setBounds({left:b.left-a.left,top:b.top-a.top,width:a.right-b.left,height:b.height});};const ro=new ResizeObserver(measure);ro.observe(shell);ro.observe(main);measure();return()=>ro.disconnect();},[wide,visible]);
  const connect=(requested:ScreenQuality=quality,legacy=legacyQuality)=>{
    const n=++attempt.current,previous=lifecycle.opening;
    viewer.current?.dispose();viewer.current=undefined;setError("");setState({state:"connecting",controlling:false,pending:false,fresh:false});
    const run=async()=>{let cleanupOnError=false;try{
      // An earlier open may still return a session after cancellation. It owns
      // its cleanup; do not let a replacement race ahead of that response.
      await previous;await retire();if(n!==attempt.current)return;
      const s=await connection.screenStatus();if(n!==attempt.current)return;setStatus(s);setStatusError("");
      if(!s.enabled)throw new Error("screen_disabled");if(s.permission==="none")throw new Error("screen_not_authorized");if(s.desktop?.locked)throw new Error("screen_locked");if(s.desktop&&s.desktop.capture!=="granted")throw new Error("screen_capture_denied");
      const d=s.desktop?.displays.find(d=>d.id===display);if(!s.desktop||!d)throw new Error("screen_service_offline");
      const codecs=await supportedScreenCodecs(connection.state.screenQualityAvailable&&!legacy?requested:SCREEN_DEFAULT_QUALITY);if(n!==attempt.current)return;
      const explicit=connection.state.screenQualityAvailable&&!legacy;
      const result=await connection.screenOpen({desktopId:s.desktop.desktopId,displayId:d.id,displayRevision:d.revision,requestId:crypto.randomUUID(),codecs,...(explicit?{quality:requested}:{})});
      lifecycle.sessions.add(result.join.session.id);cleanupOnError=true;
      if(n!==attempt.current||!canvas.current){cleanupOnError=false;await retire();return;}
      if(explicit&&result.join.quality!==requested)throw new Error("screen_quality_unconfirmed");
      setQuality(result.join.quality??SCREEN_DEFAULT_QUALITY);
      const next=new RemoteScreenViewer(result.join,canvas.current,value=>{if(n===attempt.current)setState(value);});viewer.current=next;
      next.visibility(visibleNow.current&&document.visibilityState==="visible");await next.open(result.network);
      if(n!==attempt.current){next.dispose();cleanupOnError=false;await retire();return;}next.visibility(visibleNow.current&&document.visibilityState==="visible");
    }catch(e){if(n===attempt.current){viewer.current?.dispose();viewer.current=undefined;setError(e instanceof Error?e.message:String(e));setState({state:"closed",controlling:false,pending:false,fresh:false});}if(cleanupOnError)await retire().catch(()=>undefined);}};
    lifecycle.opening=run();return lifecycle.opening;
  };
  const disconnect=()=>{setLegacyQuality(false);const n=++attempt.current;viewer.current?.dispose();viewer.current=undefined;setState({state:"closed",controlling:false,pending:false,fresh:false});void retire().catch(e=>{if(n===attempt.current)setError(e instanceof Error?e.message:String(e));});};
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
  const blocked = status ? !status.enabled ? "screen_disabled" : status.permission === "none" ? "screen_not_authorized"
    : !status.desktop ? "screen_service_offline" : status.desktop.locked ? "screen_locked"
    : status.desktop.capture !== "granted" ? "screen_capture_denied" : !status.desktop.displays.length ? "screen_display_unavailable" : "" : "";
  const stateText=error?screenError(error):statusError?screenError(statusError):state.reason?screenError(state.reason):state.controlling?t("正在控制 · Ctrl+Alt+Shift+Esc 退出控制"):state.state==="connecting"?t("正在连接屏幕…"):state.state==="closed"?(blocked?screenError(blocked):t("尚未连接")):!state.fresh?t("画面暂未更新，控制已停止，请等待新画面。"):t("查看中 · 点击开始控制后操作");
  return <aside ref={panel} hidden={!visible} style={bounds?{position:"absolute",...bounds}:undefined} className={`conversation-side-panel remote-screen-panel${wide?" screen-wide":""}${fullscreen.active?" screen-fullscreen":""}`} aria-label={t("远程屏幕")} onPointerMove={e=>{if(fullscreen.active&&e.clientY<28){reveal();hideLater();}}}>
    {fullscreen.active&&!chromeVisible&&<button className="screen-reveal" aria-label={t("显示屏幕工具栏")} title={t("显示屏幕工具栏")} onClick={reveal}><ChevronDown size={16}/></button>}
    <div ref={chrome} className={`screen-chrome${fullscreen.active&&!chromeVisible?" screen-chrome-hidden":""}`} onPointerEnter={reveal} onPointerLeave={hideLater} onFocusCapture={reveal} onBlurCapture={()=>queueMicrotask(hideLater)} inert={fullscreen.active&&!chromeVisible?true:undefined}>
    <header className="screen-heading">
      <div className="screen-title"><strong><Monitor size={15}/>{t("远程屏幕")}</strong><small title={hostName}>{hostName}</small></div>
      <div className="screen-toolbar">
        <select aria-label={t("画面清晰度")} title={!connection.state.screenQualityAvailable?t("更新主机后可选择清晰度"):legacyQuality?t("当前使用默认画质，请更新目标 Mac 的 App 后重试"):sharpSupported?t("流畅节省带宽，清晰保留更多文字细节"):t("此设备不支持清晰画质解码，请改用均衡或流畅。")} value={quality} disabled={!connection.state.screenQualityAvailable||legacyQuality||state.state==="connecting"} onChange={e=>changeQuality(e.target.value as ScreenQuality)}><option value="smooth">{t("流畅")}</option><option value="balanced">{t("均衡")}</option><option value="sharp" disabled={!sharpSupported}>{t("清晰")}</option></select>
        <select aria-label={t("画面缩放")} value={scale} onChange={e=>setScale(e.target.value)}><option value="fit">{t("适应窗口")}</option><option value="1">100%</option><option value="1.5">150%</option><option value="2">200%</option></select>
        {state.state==="closed"?<button onClick={()=>void connect()} disabled={isClosing||!display||!!blocked}>{t("连接屏幕")}</button>:<button className="screen-disconnect" aria-label={t("断开")} title={t("断开")} onClick={disconnect}><Unplug size={15}/></button>}
        {(state.state==="closed"?status?.permission==="control":state.controlAllowed)&&<button disabled={!state.fresh||state.pending} onMouseDown={e=>e.preventDefault()} onClick={()=>{state.controlling?viewer.current?.release():viewer.current?.control();hideLater();}}>{state.pending?t("等待新画面…"):state.controlling?t("停止控制"):t("开始控制")}</button>}
      </div>
      <div className="screen-window-actions">
        {!standalone&&!fullscreen.active&&<button className="icon-button" aria-label={wide?t("返回并排"):t("展开屏幕")} title={wide?t("返回并排"):t("展开屏幕")} onClick={()=>setWide(v=>!v)}>{wide?<Minimize2 size={17}/>:<Maximize2 size={17}/>}</button>}
        <button className="icon-button" aria-label={fullscreen.active?t("退出全屏"):t("全屏")} title={fullscreen.active?t("退出全屏"):t("全屏")} disabled={isClosing||!fullscreen.supported} onClick={fullscreen.toggle}>{fullscreen.active?<Minimize size={17}/>:<Maximize size={17}/>}</button>
        <button className="icon-button" aria-label={t("屏幕更多操作")} title={t("屏幕更多操作")} aria-expanded={tools} onMouseDown={e=>e.preventDefault()} onClick={()=>setTools(v=>!v)}><MoreHorizontal size={17}/></button>
        <button className="icon-button" aria-label={t("断开并关闭屏幕")} title={t("断开并关闭屏幕")} disabled={isClosing} onClick={()=>void closeViewer()}><X size={18}/></button>
      </div>
    </header>
    <p className="screen-state" role="status">{fullscreen.error??stateText}{!error&&!statusError&&!state.reason&&state.fresh&&state.width&&<span className="screen-resolution"> · {state.width} × {state.height}</span>}{error==="screen_quality_unsupported"&&<button onClick={()=>{setLegacyQuality(true);setQuality(SCREEN_DEFAULT_QUALITY);void connect(SCREEN_DEFAULT_QUALITY,true);}}>{t("以默认画质连接")}</button>}</p>
    {state.state==="closed"&&openSettings&&!!(blocked||statusError||error)&&<p className="screen-state"><button onClick={openSettings}>{t("连接设置")}</button></p>}
    {tools&&<div className="screen-tools-popover" role="region" aria-label={t("屏幕更多操作")}>
    <label className="screen-display">{t("显示器")}<select aria-label={t("显示器")} value={display} onChange={e=>{disconnect();setDisplay(e.target.value);}}>{status?.desktop?.displays.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
    <div className="screen-shortcuts"><details><summary onMouseDown={e=>e.preventDefault()}>{t("发送组合键")}</summary><div>{SCREEN_SHORTCUTS.map(shortcut=><button key={shortcut.id} disabled={!state.controlling} onMouseDown={e=>e.preventDefault()} onClick={e=>{canvas.current?.focus();for(const code of shortcut.codes)viewer.current?.input({kind:"key",code,down:true});for(const code of [...shortcut.codes].reverse())viewer.current?.input({kind:"key",code,down:false});e.currentTarget.closest("details")?.removeAttribute("open");}}>{shortcut.label[locale]}</button>)}</div></details>{windows&&<select aria-label={t("Windows 修饰键")} value={modifierMode} onChange={e=>{viewer.current?.release();setModifierMode(e.target.value as ScreenModifierMode);}}><option value="command">Ctrl → ⌘ · Win → ⌃</option><option value="physical">Ctrl → ⌃ · Win → ⌘</option></select>}</div>
    <div className="screen-bottom"><button onClick={()=>{viewer.current?.release();setShowText(v=>!v);}}>{t("发送文本")}</button><span>{windows?(modifierMode==="command"?t("Ctrl 对应 Command，Win 对应 Control，Alt 对应 Option"):t("Windows：Ctrl 对应 Control，Win 对应 Command，Alt 对应 Option")):t("点击聊天输入框会立即停止远端控制。")}</span></div>
    {showText&&<div className="screen-text"><textarea aria-label={t("发送到远端的文本")} maxLength={2048} value={text} onChange={e=>setText(e.target.value)} placeholder={t("在这里输入或粘贴中文文本，不会同步剪贴板。")}/><button disabled={!text||!state.controlling} onMouseDown={e=>e.preventDefault()} onClick={()=>{canvas.current?.focus();if(viewer.current?.input({kind:"text",text}))setText("");}}>{t("发送到远端")}</button><p>{t("编辑完成后点击开始控制，再发送文本。")}</p></div>}
    </div>}
    </div>
    <div className={`screen-viewport${scale==="fit"?" screen-fit":""}`}>
      <canvas ref={canvas} tabIndex={0} aria-label={t("{0}的远程屏幕",hostName)} className={state.fresh?"":"screen-stale"} style={scale==="fit"?{aspectRatio:state.width&&state.height?`${state.width}/${state.height}`:undefined,width:`min(100cqw, calc(100cqh * ${state.width&&state.height?state.width/state.height:16/9}))`}:{width:(state.width??640)*Number(scale),height:(state.height??360)*Number(scale)}}
        onBlur={()=>viewer.current?.release()} onContextMenu={e=>{if(state.controlling)e.preventDefault();}}
        onPointerDown={e=>{if(!state.controlling)return;e.preventDefault();e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);if(e.button>=0&&e.button<=2){const at=performance.now(),last=lastClick.current;const count=last&&last.button===e.button&&at-last.at<=450&&Math.hypot(e.clientX-last.x,e.clientY-last.y)<=4&&last.count<3?(last.count+1) as 2|3:1;lastClick.current={button:e.button,x:e.clientX,y:e.clientY,at,count};viewer.current?.input({kind:"button",...point(e),button:e.button as 0|1|2,down:true,clicks:count});}}}
        onPointerUp={e=>{if(!state.controlling)return;e.preventDefault();if(e.button<=2)viewer.current?.input({kind:"button",...point(e),button:e.button as 0|1|2,down:false,clicks:lastClick.current?.button===e.button?lastClick.current.count:1});if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}}
        onPointerMove={e=>{if(state.controlling)viewer.current?.pointerMove(e);}} onPointerCancel={()=>viewer.current?.release()}
        onKeyDown={e=>{if(!state.controlling)return;if(e.code==="Escape"&&e.ctrlKey&&e.altKey&&e.shiftKey){e.preventDefault();viewer.current?.release();return;}if(e.nativeEvent.isComposing||!screenKeyCodeSchema.safeParse(e.code).success)return;e.preventDefault();viewer.current?.input({kind:"key",code:screenControllerCode(e.code,windows?"windows":"mac",modifierMode),down:true});}}
        onKeyUp={e=>{if(!state.controlling||e.nativeEvent.isComposing||!screenKeyCodeSchema.safeParse(e.code).success)return;e.preventDefault();viewer.current?.input({kind:"key",code:screenControllerCode(e.code,windows?"windows":"mac",modifierMode),down:false});}}
      />
    </div>

  </aside>;
}
