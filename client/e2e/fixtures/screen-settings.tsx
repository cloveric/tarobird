// Use the App theme before component overrides so visual acceptance includes
// the same modal sizing, font and palette rules as the desktop settings page.
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/mobile-im.css";
import "../../src/mobile-shell.css";
import "../../src/safe-area.css";
import "../../src/viewport.css";
import "../../src/expressive-themes.css";
import "../../src/cli-typography.css";
import "../../src/bot-name.css";
import "../../src/layout-density.css";
import "../../src/motion.css";
import "../../src/porcelain-details.css";
import "../../src/side-conversation.css";
import { restoreAppearance, applyAppearance } from "../../src/appearance.js";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionPanel } from "../../src/ConnectionPanel.js";
import { RemoteScreenSettings } from "../../src/RemoteScreenSettings.js";
import { RuntimeHostContext } from "../../src/RuntimeHost.js";
import type { HubConnection } from "../../src/connection.js";
import { setLocale } from "../../src/i18n.js";
const params = new URLSearchParams(location.search);
restoreAppearance();
applyAppearance({theme:"light",palette:"mono",monoAccent:"warm-gray",animations:true});
const display = { id:"display",nativeId:"1",name:"Mac display",revision:1,x:0,y:0,width:1280,height:720,scale:1,rotation:0 };
const desktop = { desktopId:"desktop_mini",instanceId:"instance",loginSession:"login",platform:"macos",capture:"granted",accessibility:true,locked:false,displays:[display] };
const state = { native:[] as {command:string;args:any}[], reads:[] as string[], configured:[] as any[], opens:[] as string[], stops:[] as string[],
  failRead:false, holdRead:false, release:undefined as undefined|(()=>void), permissionError:false, requestError:false,
  holdConfigure:false, releaseConfigure:undefined as undefined|(()=>void),
  local:{supported:true,registered:false,phase:"failed",retryAt:undefined as number|undefined,error:"screen_host_unavailable",permissions:{capture:"granted",accessibility:true,inputMonitoring:false},inputMonitoring:false,desktop},
  status:{supported:true,enabled:true,canManage:true,permission:"none",policy:{revision:7,enabled:true,grants:[] as any[]},devices:[{id:"gui-device",name:"GUI device",platform:"macos",publicKey:"device-key"}],desktop:null as typeof desktop|null,sessions:[],serverTime:Date.now()} };
if(params.has("ready")){state.status.permission="view";state.status.desktop=desktop;state.local.registered=true;state.local.phase="registered";state.local.error="";}
if(params.has("configured")){state.status.desktop=desktop;state.local.registered=true;state.local.phase="registered";state.local.error="";state.local.permissions.inputMonitoring=true;}
if(params.has("en"))setLocale("en");
function connection(key:string) {
 const route={name:"Direct",url:"http://127.0.0.1:8788"};const listeners=new Set<()=>void>();
 return { identity:{hubPublicKey:key,deviceId:"gui-device",routes:[route]},
  state:{status:"online",screenAvailable:true,route,user:{role:"owner",id:"owner"},bots:[],networkAvailable:false},
  subscribe:(f:()=>void)=>{listeners.add(f);return()=>{listeners.delete(f);};},
  screenStatus:async()=>{state.reads.push(key);if(state.holdRead)await new Promise<void>(r=>state.release=r);if(state.failRead)throw Error("screen_host_offline");return structuredClone(state.status);},
  screenConfigure:async(value:any)=>{state.configured.push({key,value});if(state.holdConfigure)await new Promise<void>(r=>state.releaseConfigure=r);state.status.policy=value;state.status.enabled=value.enabled;},
  screenStop:async(id:string)=>{state.stops.push(id);},screenOpen:async()=>{state.opens.push(key);throw Error("screen_connect_timeout");},
 } as unknown as HubConnection;
}
const a=connection("host-a"),b=connection("host-b");
(window as any).tarobotDesktop={version:1,engine:"electron",platform:"darwin",on:()=>()=>{},openSocket:async()=>{},invoke:async(command:string,args:any)=>{
 state.native.push({command,args});
 if(command==="desktop_host")return{running:true,publicKey:"host-a"};
 if(command==="screen_service_status")return structuredClone(state.local);
 if(command==="screen_service_permission"){
  if(state.permissionError)throw Error("screen_permission_settings_failed");
  const granted=args.kind==="capture"?state.local.permissions.capture==="granted":args.kind==="accessibility"?state.local.permissions.accessibility:state.local.permissions.inputMonitoring;
  return {...structuredClone(state.local),requested:!granted,opened:true,...(state.requestError?{requestError:"screen_permission_request_failed"}:{})};
 }
 if(command==="screen_service_retry"){state.local.phase="connecting";state.local.error="";return structuredClone(state.local);}
 return null;
}};
if(params.has("web"))delete (window as any).tarobotDesktop;
function App(){const[host,setHost]=useState(params.has("remote")?b:a),[panel,setPanel]=useState(true),[busy,setBusy]=useState(false);
 return <><textarea aria-label="Local draft" defaultValue="keep draft"/><button onClick={()=>setHost(h=>h===a?b:a)}>Switch host</button><button onClick={()=>setBusy(v=>!v)}>Toggle busy</button>
 <RuntimeHostContext.Provider value={host===a?"macmini":"Other Mac"}>{params.has("panel")?panel&&<ConnectionPanel key={host.identity.hubPublicKey} connection={host} close={()=>setPanel(false)}/>:<RemoteScreenSettings connection={host} local={host===a} open={()=>state.opens.push(host.identity.hubPublicKey)} {...{openBlocked:busy?"请先保存或取消连接修改。":undefined}}/>}</RuntimeHostContext.Provider></>;
}
Object.assign(window,{screenSettingsFixture:{state,desktop,a,b,setLocale}});createRoot(document.getElementById("root")!).render(<App/>);
