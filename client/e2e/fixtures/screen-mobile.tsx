// Actual Capacitor JS dispatch and screen transport with a native plugin double.
// Synthetic pixels/decoder/Hub responses only; no user's screen or input target.
import type { HubConnection } from "../../src/connection.js";
const params = new URL(location.href).searchParams;
const platform = params.get("platform") === "ios" ? "ios" : "android";
// Optional remote geometry (?res=WxH) and host name (?host=); defaults unchanged.
const [displayWidth, displayHeight] = /^\d+x\d+$/.test(params.get("res") ?? "") ? params.get("res")!.split("x").map(Number) as [number, number] : [1280, 720];
// Like a Host, encode within the mobile default (smooth) caps, never upscaled.
const streamScale = Math.min(1, 1280 / Math.max(displayWidth, displayHeight), Math.sqrt(1280 * 800 / (displayWidth * displayHeight)));
const remoteWidth = Math.round(displayWidth * streamScale / 2) * 2, remoteHeight = Math.round(displayHeight * streamScale / 2) * 2;
const blocked = new URL(location.href).searchParams.get("blocked");
const fixture = { calls: [] as { plugin: string; method: string; args: any }[], commands: [] as any[], opens: 0, stops: 0, documents: 0, active: true, locked: false, delayOpen: false, resumeOpen: undefined as (()=>void)|undefined, statusFailure: "" as ""|"abort"|"offline", renewals: false, viewOnly: false, endBehind: undefined as undefined|{ method: string; code: string; reason: string }, withdrawOnRenew: false, pauseFrames: false, rejectQuality: false, holdHubOpen: false, settingsOpened: 0 };
let challenge = 0;
let socketListener = (_value: any) => {}, appListener = (_value: any) => {};
const groups = new Map<string, { join: any; delivery: number; frame: number; generation: number; timer: number; packets: Map<number, Uint8Array>; pending: boolean }>();
let allocation = 0;
const doc = `${platform}-screen-document`;
Object.assign(window, { ...(platform === "ios" ? { webkit: { messageHandlers: { bridge: {} } } } : { androidBridge: {} }), Capacitor: {
  PluginHeaders: [{ name: "TaroCubHubTransport", methods: [..."document allocate cancel screenOpen screenSend screenRead screenAck screenClose".split(" ").map(name=>({name,rtype:"promise"})),{name:"addListener",rtype:"callback"}] }, { name: "App", methods: [{name:"getState",rtype:"promise"},{name:"addListener",rtype:"callback"},{name:"removeListener",rtype:"promise"}] }],
  nativePromise: async (plugin:string, method:string, args:any = {}) => {
    fixture.calls.push({plugin,method,args});
    if(plugin==="App")return method==="getState"?{isActive:fixture.active}:{};
    if(platform==="ios"&&args.pageToken!==(window as any).__TAROCUB_NATIVE_PAGE_TOKEN__)throw Error("missing_current_page_token");
    if(method==="document"){fixture.documents++;return {value:doc};}
    if(method==="allocate"){if(new URL(location.href).searchParams.has("old-native"))throw Error("invalid_native_kind");if(args.kind!=="screen"||args.document!==doc)throw Error("wrong_screen_allocation");return {value:`screen-${++allocation}`};}
    if(method==="screenOpen") {
      fixture.opens++; const group={join:args.join,delivery:0,frame:0,generation:1,timer:0,packets:new Map<number,Uint8Array>(),pending:false};groups.set(args.id,group);
      setTimeout(()=>{if(!groups.has(args.id))return;event(args.id,{type:"attached",sessionId:args.join.session.id});status(args.id);stream(args.id);},10);
      group.timer=window.setInterval(()=>frame(args.id),400);
      if(fixture.delayOpen)await new Promise<void>(resolve=>{fixture.resumeOpen=resolve;});return {};
    }
    const group=groups.get(args.id);
    // Android's order when a session ends under a running call: native queues the close
    // event, retires the slot, then rejects that call; the page sees the rejection first.
    if(group&&fixture.endBehind?.method===method){const {code,reason}=fixture.endBehind;fixture.endBehind=undefined;clearInterval(group.timer);groups.delete(args.id);
      setTimeout(()=>socketListener({id:args.id,document:doc,kind:"close",reason}),0);throw Error(code);}
    if(method==="screenClose"){if(group){clearInterval(group.timer);groups.delete(args.id);}return {value:true};}
    if(!group)throw Error("screen_inactive");
    if(method==="screenRead"){const bytes=group.packets.get(args.deliverySequence)!;return {data:btoa(String.fromCharCode(...bytes.slice(args.offset,args.offset+args.maxBytes)))};}
    if(method==="screenAck"){group.packets.delete(args.deliverySequence);return {};}
    if(method==="screenSend"){
      const value=args.command;fixture.commands.push(value);
      if(value.type==="ack"){event(args.id,{type:"frame-ready",sessionId:group.join.session.id,generation:group.join.session.generation,streamGeneration:group.generation,frameSequence:value.frameSequence,expiresAt:Date.now()+2000});if(group.pending){group.pending=false;status(args.id,true);}}
      if(value.type==="control"){group.pending=true;group.generation++;stream(args.id);}
      if(value.type==="release")status(args.id);
      // The Hub withdrew control (here: the lease expired) just before this renew reached
      // native: native has applied that state and refuses the renew; the page sees the refusal first.
      if(value.type==="renew"&&fixture.withdrawOnRenew){fixture.withdrawOnRenew=false;fixture.commands.pop();
        setTimeout(()=>event(args.id,{type:"state",session:{...group.join.session,state:"viewing",reason:"screen_lease_expired"},streamGeneration:group.generation,serverTime:Date.now()}),0);throw Error("screen_control_ended");}
      // Opt-in Host behaviour: each accepted renew issues the next challenge.
      if(value.type==="renew"&&fixture.renewals)status(args.id,true);
      return {};
    }
    throw Error("unexpected_native_call");
  },
  nativeCallback: (plugin:string,_method:string,args:any,callback:(value:any)=>void)=>{if(plugin==="App")appListener=callback;else {if(args.eventName!==(platform==="ios"?`socket:${(window as any).__TAROCUB_NATIVE_PAGE_TOKEN__}`:"socket"))throw Error("wrong_listener_scope");socketListener=callback;}return `${plugin}-listener`;},
} });
document.documentElement.dataset.platform=platform;
const [{createRoot},{useState},{RemoteScreenPanel},{writeScreenFrame}]=await Promise.all([import("react-dom/client"),import("react"),import("../../src/RemoteScreenPanel.js"),import("../../../src/client-protocol/screen-wire.js")]);
(await import("../../src/i18n.js")).setLocale(navigator.language.startsWith("zh")?"zh":"en");
const sample=document.createElement("canvas");sample.width=remoteWidth;sample.height=remoteHeight;const context=sample.getContext("2d")!;context.fillStyle="#dce8ee";context.fillRect(0,0,remoteWidth,remoteHeight);context.fillStyle="#fff";context.fillRect(90,90,remoteWidth-180,remoteHeight-190);context.fillStyle="#243849";context.font="34px sans-serif";context.fillText("Synthetic screen · no remote computer",140,180);context.fillStyle="#e58e56";context.fillRect(140,250,180,180);if(params.has("res")){context.fillStyle="#3d6fb4";context.fillRect(0,remoteHeight-40,remoteWidth,40);context.strokeStyle="#c0392b";context.lineWidth=6;context.strokeRect(3,3,remoteWidth-6,remoteHeight-6);}
class Decoder {static async isConfigSupported(config:any){return {supported:true,config};}state="unconfigured";constructor(private output:{output:(frame:VideoFrame)=>void}){}configure(){this.state="configured";}close(){this.state="closed";}decode(chunk:EncodedVideoChunk){queueMicrotask(()=>{if(this.state==="configured")this.output.output(new VideoFrame(sample,{timestamp:chunk.timestamp}));});}}
Object.defineProperty(window,"VideoDecoder",{value:Decoder});
function event(id:string,value:any){const group=groups.get(id);if(group)socketListener({id,document:doc,kind:"screen",deliverySequence:++group.delivery,value});}
function frame(id:string){const group=groups.get(id);if(!group||fixture.pauseFrames)return;const bytes=writeScreenFrame({key:true,codec:"h264",sequence:++group.frame,geometryRevision:1,streamGeneration:group.generation,captureMs:Date.now(),width:remoteWidth,height:remoteHeight},new Uint8Array([1,2,3]));const deliverySequence=++group.delivery;group.packets.set(deliverySequence,bytes);socketListener({id,document:doc,kind:"binary",deliverySequence,byteLength:bytes.byteLength});}
function stream(id:string){const group=groups.get(id);if(group){event(id,{type:"stream",streamGeneration:group.generation,geometryRevision:1,codec:"h264",codecString:"avc1.42001f",width:remoteWidth,height:remoteHeight,contentRect:{x:0,y:0,width:remoteWidth,height:remoteHeight}});frame(id);}}
function status(id:string,control=false){const group=groups.get(id);if(group)event(id,{type:"state",session:{...group.join.session,state:control?"controlling":"viewing"},streamGeneration:group.generation,serverTime:Date.now(),...(control?{lease:{id:"l".repeat(43),expiresAt:Date.now()+6000,challenge:fixture.renewals?String(++challenge).padStart(43,"c"):"c".repeat(43),challengeExpiresAt:Date.now()+3000}}:{})});}
const display={id:"display",nativeId:"1",name:"Fixture display",revision:1,x:0,y:0,width:displayWidth,height:displayHeight,scale:1,rotation:0};
const connection={state:{screenAvailable:true,screenQualityAvailable:true,screenQhdAvailable:!new URLSearchParams(location.search).has("old-host")},identity:{hubPublicKey:"fixture-key"},screenStatus:async()=>{
  // The two client-side failures seen when the Host drops: the bounded request's abort and the offline guard.
  if(fixture.statusFailure==="abort")throw new DOMException("The request was aborted.","AbortError");
  if(fixture.statusFailure==="offline")throw new Error("连接恢复后即可操作");
  return {supported:true,enabled:blocked!=="screen_disabled",canManage:false,permission:blocked==="screen_not_authorized"?"none":fixture.viewOnly?"view":"control",desktop:blocked?null:{desktopId:"desktop",instanceId:"instance",loginSession:"login",platform:"macos",capture:"granted",accessibility:true,locked:fixture.locked,displays:[display]},sessions:[],serverTime:Date.now()};},screenOpen:async(input:any)=>{if(fixture.holdHubOpen)await new Promise(()=>{});if(fixture.rejectQuality&&input.quality)throw new Error("screen_quality_unsupported");return {network:{url:"https://fixture.invalid",publicKey:"fixture-key",certificateAuthority:"PUBLIC_FIXTURE_CA"},join:{quality:input.quality,session:{id:`session-${fixture.opens+1}`,desktopId:"desktop",deviceId:"device",deviceName:"Fixture phone",generation:`generation-${fixture.opens+1}`,display,controlAllowed:!fixture.viewOnly,state:"viewing",createdAt:Date.now()},controlTicket:"c".repeat(43),mediaTicket:"m".repeat(43),expiresAt:Date.now()+30000,serverTime:Date.now()}};},screenStop:async()=>{fixture.stops++;}} as unknown as HubConnection;
function App(){const[visible,setVisible]=useState(true),[opened,setOpened]=useState(true);Object.assign(fixture,{hide:()=>setVisible(false),show:()=>setVisible(true)});return <>{opened?<RemoteScreenPanel connection={connection} hostName={params.get("host")??"Paired fixture computer with a long display name"} visible={visible} standalone close={()=>setOpened(false)} openSettings={params.has("settings")?()=>{fixture.settingsOpened++;}:undefined}/>:<p>Closed fixture viewer</p>}<textarea aria-label="Local chat draft" defaultValue="Local draft stays local"/></>;}
Object.assign(window,{screenMobileHostClose:(reason:string)=>{for(const [id,group]of groups){clearInterval(group.timer);groups.delete(id);socketListener({id,document:doc,kind:"close",reason});}},screenMobileFixture:fixture,screenMobileActive:(active:boolean)=>{fixture.active=active;appListener({isActive:active});if(!active)for(const [id,group]of groups){clearInterval(group.timer);groups.delete(id);socketListener({id,document:doc,kind:"close",reason:"screen_inactive"});}}});
createRoot(document.getElementById("root")!).render(<App/>);
await import("../../src/styles.css");await import("../../src/side-conversation.css");
// Opt-in (?theme=app): the App's theme stack in main.tsx order and its first-run
// appearance, so layout checks see the real palette tokens. ?viewport=native
// adds the App's viewport controller with this platform's overlay keyboard.
if(params.get("theme")==="app"){
  Object.assign(document.documentElement.dataset,{theme:params.get("scheme")??"light",palette:params.get("palette")??"mono",monoAccent:params.get("accent")??"warm-gray",density:(await import("../../src/layout-density.js")).normalizeLayoutDensity(undefined)});
  await import("../../src/brand-theme.css");await import("../../src/palette-tokens.css");await import("../../src/mobile-im.css");await import("../../src/mobile-shell.css");await import("../../src/safe-area.css");await import("../../src/viewport.css");
  await import("../../src/message-images.css");await import("../../src/expressive-themes.css");await import("../../src/cli-typography.css");await import("../../src/bot-name.css");await import("../../src/layout-density.css");await import("../../src/quoted-reply.css");
  await import("../../src/motion.css");await import("../../src/porcelain-details.css");await import("../../src/desktop-window-chrome.css");await import("../../src/ios-adaptive.css");
}
if(params.get("viewport")==="native"){const {installAppViewport,nativeKeyboardMotion}=await import("../../src/viewport.js");installAppViewport(window,document,nativeKeyboardMotion[platform]);}
