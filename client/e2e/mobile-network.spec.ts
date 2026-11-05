import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
import type { mobileNetwork } from "../src/native-network.js";
declare global { interface Window { mobileNetwork: typeof mobileNetwork } }
let server: ViteDevServer;
test.beforeAll(async () => { server=await createServer({server:{host:"127.0.0.1",port:0}});await server.listen(); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({page}) => { await page.goto(server.resolvedUrls!.local[0]+"e2e/fixtures/mobile-network.html");await page.waitForFunction(()=>!!window.mobileNetwork); });

test("mobile socket waits for native event registration and isolates cancelled receipts",async ({page})=>{
  expect(await page.evaluate(async()=>{
    const calls:string[]=[],received:string[]=[];
    let release!:()=>void, emit!:(event:{id:string;kind:string})=>void;
    const plugin={
      addListener:async (_:string, callback:typeof emit)=>{ calls.push("listen");emit=callback;await new Promise<void>(r=>{release=r;});return {remove:async()=>{}}; },
      socketOpen:async (args:Record<string,unknown>)=>{ calls.push("open"); if("events" in args) throw Error("non-serializable channel leaked");emit({id:String(args.id),kind:"open"}); },
      cancel:async()=>{calls.push("cancel");},
    } as Parameters<typeof window.mobileNetwork>[0];
    const invoke=window.mobileNetwork(plugin),opening=invoke("net_socket_open",{id:"s",origin:"https://hub.invalid",hubKey:"trusted",events:{onmessage:(event:{kind:string})=>received.push(event.kind)}});
    await Promise.resolve();const before=[...calls];release();await opening;await invoke("net_cancel",{id:"s"});emit({id:"s",kind:"message"});emit({id:"foreign",kind:"message"});
    return {before,calls,received};
  })).toEqual({before:["listen"],calls:["listen","open","cancel"],received:["open"]});
});

test("mobile listener failure rejects before socket/network work",async ({page})=>{
  expect(await page.evaluate(async()=>{
    let opens=0, attempts=0;
    const invoke=window.mobileNetwork({addListener:async()=>{attempts++;throw Error("listener unavailable");},socketOpen:async()=>{opens++;}} as unknown as Parameters<typeof window.mobileNetwork>[0]);
    const error=await invoke("net_socket_open",{id:"s",events:{onmessage:()=>{}}}).then(()=>"",(e:Error)=>e.message);
    const retry=await invoke("net_socket_open",{id:"retry",events:{onmessage:()=>{}}}).then(()=>"",(e:Error)=>e.message);
    return {opens,attempts,error,retry};
  })).toEqual({opens:0,attempts:2,error:"listener unavailable",retry:"listener unavailable"});
});

for (const pageToken of [undefined, "0123456789abcdef0123456789abcdef"]) test(`QR authority reaches mobile HTTP and WebSocket equally (${pageToken ? "iOS" : "Android"})`, async ({ page }) => {
  const sent = await page.evaluate(async (pageToken) => {
    const requests: Record<string, unknown>[] = [];
    const invoke = window.mobileNetwork({
      addListener: async () => ({ remove: async () => {} }),
      httpOpen: async args => { requests.push(args); },
      socketOpen: async args => { requests.push(args); },
    } as Parameters<typeof window.mobileNetwork>[0], pageToken);
    const route = { origin: "https://192.168.1.2:8788", hubKey: "host-a", certificateAuthority: "PUBLIC_CA_A" };
    await invoke("net_http_open", { id: "http", ...route });
    await invoke("net_socket_open", { id: "socket", ...route, events: { onmessage: () => {} } });
    await invoke("net_socket_open", { id: "other", origin: "https://other.example", hubKey: "host-b", events: { onmessage: () => {} } });
    return requests;
  }, pageToken);
  expect(sent[0]).toMatchObject({ certificateAuthority: "PUBLIC_CA_A", hubKey: "host-a" });
  expect(sent[1]).toEqual({ ...sent[0], id: "socket" });
  expect(sent[2]).not.toHaveProperty("certificateAuthority");
});

for (const pageToken of [undefined, "0123456789abcdef0123456789abcdef"]) test(`mobile reconnect retries a failed listener once for concurrent hosts (${pageToken ? "iOS" : "Android"})`, async ({ page }) => {
  expect(await page.evaluate(async (pageToken) => {
    let attempts = 0, rejectFirst!: (error: Error) => void;
    let emit!: (event: { id: string; kind: string }) => void;
    const opens: string[] = [], received: string[] = [];
    const invoke = window.mobileNetwork({
      addListener: async (name, callback) => {
        if (name !== (pageToken ? `socket:${pageToken}` : "socket")) throw Error("wrong event scope");
        attempts++;
        if (attempts === 1) await new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
        emit = callback; return { remove: async () => {} };
      },
      socketOpen: async args => { if (args.pageToken !== pageToken) throw Error("wrong page scope"); opens.push(String(args.id)); emit({ id: String(args.id), kind: "open" }); },
    } as Parameters<typeof window.mobileNetwork>[0], pageToken);
    const connect = (id: string) => invoke("net_socket_open", { id, events: { onmessage: (event: { kind: string }) => received.push(id + ":" + event.kind) } });
    const first = Promise.allSettled([connect("first-a"), connect("first-b")]);
    rejectFirst(Error("temporary bridge failure"));
    const failures = (await first).map(result => result.status);
    const before = { attempts, opens: [...opens] };
    const retry = await Promise.allSettled([connect("retry-a"), connect("retry-b")]);
    return { failures, before, retry: retry.map(result => result.status), attempts, opens, received };
  }, pageToken)).toEqual({ failures: ["rejected", "rejected"], before: { attempts: 1, opens: [] }, retry: ["fulfilled", "fulfilled"], attempts: 2, opens: ["retry-a", "retry-b"], received: ["retry-a:open", "retry-b:open"] });
});

test("mobile native reads preserve binary bytes and reject oversized chunks",async ({page})=>{
  expect(await page.evaluate(async()=>{
    let encoded="AP+A",data=()=>encoded;
    const invoke=window.mobileNetwork({httpRead:async()=>({data:data()})} as Parameters<typeof window.mobileNetwork>[0]);
    const bytes=[...new Uint8Array(await invoke("net_http_read",{id:"h"}) as ArrayBuffer)];
    encoded=btoa("a".repeat(256*1024));const limit=(await invoke("net_http_read") as ArrayBuffer).byteLength;
    encoded=btoa("a".repeat(256*1024+1));const oversized=await invoke("net_http_read").then(()=>false,()=>true);
    encoded="%%%";const malformed=await invoke("net_http_read").then(()=>false,()=>true);return {bytes,limit,oversized,malformed};
  })).toEqual({bytes:[0,255,128],limit:262144,oversized:true,malformed:true});
});

for (const synchronous of [false, true]) test(`rejected registrations cannot deliver stale messages or retire current channels (${synchronous ? "throw" : "reject"})`, async ({ page }) => {
  expect(await page.evaluate(async (synchronous) => {
    const callbacks: ((event: { id: string; kind: string }) => void)[] = [], received: string[] = [];
    const invoke = window.mobileNetwork({
      addListener: (_name, callback) => {
        callbacks.push(callback);
        if (callbacks.length === 1) {
          if (synchronous) throw Error("partial registration");
          return Promise.reject(Error("partial registration"));
        }
        return Promise.resolve({ remove: async () => {} });
      },
      socketOpen: async () => {},
    } as Parameters<typeof window.mobileNetwork>[0]);
    const args = { id: "s", events: { onmessage: (event: { kind: string }) => received.push(event.kind) } };
    const failed = await invoke("net_socket_open", args).then(() => false, () => true);
    await invoke("net_socket_open", args);
    for (const kind of ["open", "message", "close"]) callbacks[0]({ id: "s", kind });
    for (const kind of ["open", "message", "close"]) callbacks[1]({ id: "s", kind });
    callbacks[1]({ id: "s", kind: "message" });
    return { failed, attempts: callbacks.length, received };
  }, synchronous)).toEqual({ failed: true, attempts: 2, received: ["open", "message", "close"] });
});

test("mobile bridge preserves document, allocation and send/close wire contracts",async ({page})=>{
  expect(await page.evaluate(async()=>{
    const sent:unknown[]=[];
    const invoke=window.mobileNetwork({document:async()=>({value:"doc"}),allocate:async args=>{sent.push(args);return {value:"slot"};},socketSend:async args=>{sent.push(args);},socketClose:async args=>{sent.push(args);return {value:true};}} as Parameters<typeof window.mobileNetwork>[0]);
    const document=await invoke("net_document"),id=await invoke("net_allocate",{kind:"socket",document});await invoke("net_socket_send",{id,text:"hello"});const close=await invoke("net_socket_close",{id,code:1000,reason:""});
    const unknown=await invoke("bogus").then(()=>false,()=>true);return {document,id,close,unknown,sent};
  })).toEqual({document:"doc",id:"slot",close:true,unknown:true,sent:[{kind:"socket",document:"doc"},{id:"slot",text:"hello"},{id:"slot",code:1000,reason:""}]});
});

test("mobile terminal receipts remove channels and failed opens can be retried independently",async({page})=>{
  expect(await page.evaluate(async()=>{
    let emit!:(event:{id:string;kind:string})=>void, attempts=0, listeners=0;const received:string[]=[];
    const invoke=window.mobileNetwork({addListener:async(_,callback)=>{listeners++;emit=callback;return {remove:async()=>{}};},socketOpen:async()=>{if(++attempts===1) throw Error("failed");}} as Parameters<typeof window.mobileNetwork>[0]);
    const args={id:"s",events:{onmessage:(e:{kind:string})=>received.push(e.kind)}};
    await invoke("net_socket_open",args).catch(()=>{});emit({id:"s",kind:"message"});await invoke("net_socket_open",args);emit({id:"s",kind:"open"});emit({id:"s",kind:"close"});emit({id:"s",kind:"message"});return {listeners,received};
  })).toEqual({listeners:1,received:["open","close"]});
});
