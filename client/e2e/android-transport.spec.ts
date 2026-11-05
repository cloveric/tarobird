import {test,expect} from "@playwright/test";
import type {ViteDevServer} from "vite";
import {createServer} from "./fixtures/vite.js";
import type {hubFetch,hubSocket,usesPinnedTransport} from "../src/transport.js";
declare global {interface Window {androidTransportFixture:{hubFetch:typeof hubFetch;hubSocket:typeof hubSocket;usesPinnedTransport:typeof usesPinnedTransport;handle(next:(method:string,args:Record<string,unknown>)=>unknown):void;emit(value:unknown):void}}}
let server:ViteDevServer;
test.beforeAll(async()=>{server=await createServer({server:{host:"127.0.0.1",port:0}});await server.listen();});
test.afterAll(async()=>{await server?.close();});
for (const platform of ["android", "ios"] as const) test.describe(platform, () => {
test.beforeEach(async({page})=>{await page.goto(server.resolvedUrls!.local[0]+`e2e/fixtures/android-transport.html?platform=${platform}`);await page.waitForFunction(()=>!!window.androidTransportFixture);});
test("native detection uses Capacitor HTTP streaming and retires old document work",async({page})=>{
  expect(await page.evaluate(async()=>{
    const f=window.androidTransportFixture,log:unknown[]=[];let reads=0;
    f.handle((method,args)=>{log.push([method,args]);if(method==="allocate")return {value:"h"};if(method==="httpOpen")return {status:200,headers:[]};if(method==="httpRead")return {data:++reads===1?"AP+A":""};});
    window.fetch=()=>{throw Error("WebView fallback");};
    const response=await f.hubFetch("https://hub.invalid","/api/data","trusted"),bytes=[...new Uint8Array(await response.arrayBuffer())];
    window.dispatchEvent(new PageTransitionEvent("pagehide"));const retired=await f.hubFetch("https://hub.invalid","/api/data","trusted").then(()=>false,()=>true);
    return {pinned:f.usesPinnedTransport(),bytes,retired,allocation:log[0]};
  })).toEqual({pinned:true,bytes:[0,255,128],retired:true,allocation:["allocate",{kind:"http",document:`${platform}-doc`}]});
});
test("native socket SDK events preserve ordered send, ack and actual close",async({page})=>{
  expect(await page.evaluate(async()=>{
    const f=window.androidTransportFixture,sent:unknown[]=[];let callback!:()=>void;
    f.handle((method,args)=>{if(method==="allocate")return {value:"s"};if(method==="socketOpen"){f.emit({id:"s",kind:"open"});}if(method==="socketSend"||method==="socketAck")sent.push([method,args]);if(method==="socketClose"){callback=()=>f.emit({id:"s",kind:"close",code:3333,reason:"peer done",clean:true});return {value:true};}});
    const socket=f.hubSocket("https://hub.invalid","trusted");await new Promise<void>(r=>{socket.onopen=()=>r();});
    const received:string[]=[];socket.onmessage=e=>received.push(e.data);f.emit({id:"s",kind:"message",data:"answer",sequence:1});socket.send("hello");socket.close(3333,"done");
    while(!callback)await new Promise(r=>setTimeout(r,0));const pending=socket.readyState;const closed=new Promise<number>(r=>{socket.onclose=e=>r(e.code);});callback();return {sent,received,pending,closed:await closed};
  })).toEqual({sent:[["socketAck",{id:"s",sequence:1}],["socketSend",{id:"s",text:"hello"}]],received:["answer"],pending:2,closed:3333});
});
test("plugin failure never starts unpinned WebView networking",async({page})=>{
  expect(await page.evaluate(async()=>{
    const f=window.androidTransportFixture;let escaped=0;f.handle(()=>{throw Error("native unavailable");});window.fetch=()=>{escaped++;throw Error("fetch fallback");};
    window.WebSocket = new Proxy(window.WebSocket, { construct() { escaped++; throw Error("WebSocket fallback"); } });
    window.XMLHttpRequest = new Proxy(window.XMLHttpRequest, { construct() { escaped++; throw Error("XHR fallback"); } });
    const error=await f.hubFetch("https://hub.invalid","/health","trusted").then(()=>"",(e:Error)=>e.message);
    const socket=f.hubSocket("https://hub.invalid","trusted");const closed=await new Promise<number>(r=>{socket.onclose=e=>r(e.code);});return {error,closed,escaped};
  })).toEqual({error:"native unavailable",closed:1006,escaped:0});
});

});
