// Actual Capacitor JS dispatch with a native bridge substitute, not a device build.
const platform = new URL(location.href).searchParams.get("platform") === "ios" ? "ios" : "android";
let handler: (method:string,args:Record<string,unknown>)=>unknown=()=>{throw Error("unexpected request");};
let listener: (event:unknown)=>void=()=>{};
Object.assign(window,{...(platform === "ios" ? {webkit:{messageHandlers:{bridge:{}}}} : {androidBridge:{}}),Capacitor:{
  PluginHeaders:[{name:"TaroCubHubTransport",methods:[..."document allocate cancel httpOpen httpRead socketOpen socketSend socketAck socketClose".split(" ").map(name=>({name,rtype:"promise"})),{name:"addListener",rtype:"callback"}]}],
  nativePromise:async(_plugin:string,method:string,args:Record<string,unknown>)=>{
    const {pageToken,...payload}=args ?? {};
    if(platform === "ios" && pageToken !== (window as unknown as Record<string,unknown>).__TAROCUB_NATIVE_PAGE_TOKEN__)throw Error("missing current page token");
    return method==="document"?{value:`${platform}-doc`}:handler(method,payload);
  },
  nativeCallback:(_plugin:string,method:string,args:{eventName:string},callback:(event:unknown)=>void)=>{if(method!=="addListener")throw Error("unexpected callback");if(platform === "ios" && args.eventName !== `socket:${(window as unknown as Record<string,unknown>).__TAROCUB_NATIVE_PAGE_TOKEN__}`)throw Error("unscoped listener");listener=callback;return "listener";},
}});
const transport=await import("../../src/transport");
Object.assign(window,{androidTransportFixture:{...transport,handle:(next:typeof handler)=>{handler=next;},emit:(value:unknown)=>listener(value)}});
export {};
