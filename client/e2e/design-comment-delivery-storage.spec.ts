import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import type { ViteDevServer } from "vite";

const html = `<!doctype html><html><body><script type="module">
import { ClientCache } from '/src/storage.ts';
import { designCommentVersions, designCommentReceiptKey } from '/src/design-comment-delivery.ts';
import { emptyDesign } from '/src/workbench-design.ts';
const identity={deviceId:'device',hubPublicKey:'hub',publicKey:'key',name:'test',routes:[]};
const cache=new ClientCache('design-comment-delivery'); await cache.initializeIdentity(identity);
const scope=JSON.stringify(['hub','owner','conversation']), target={deviceId:'device',windowId:'window',tabId:'design'};
const thread=(n=1)=>({id:'c_'+String(n).repeat(10),anchor:'artboard:page.html',label:'评论 '+n,location:{file:'page.html'},status:'open',createdAt:'2026-11-03T00:00:00Z',updatedAt:'2026-11-03T00:00:00Z',messages:[{id:'m_'+String(n).repeat(10),author:{kind:'user',name:'You',principal:'user:owner'},text:'请改善 '+n,at:'2026-11-03T00:00:00Z'}]});
const doc={schema:1,revision:1,threads:[thread(1),thread(2)],receipts:[]};
const db=await cache.db; await db.put('workbenchDesign',emptyDesign('design','Canvas'),[scope,'design']);await db.put('workbenchDesignMeta',doc,[scope,'design','comments']);
const draft={context:{kind:'design',target,revision:0},files:[],designComments:doc.threads.map(t=>t.id),designCommentVersions:designCommentVersions(doc.threads)};
const frame={v:1,type:'message.send',conversationId:'conversation',clientMsgId:'send-one',text:'comments',attachments:[],workbench:draft.context};
window.delivery={cache,ClientCache,identity,scope,target,doc,draft,frame,db,thread,designCommentReceiptKey,enqueue:()=>cache.enqueue(frame,{identity,userId:'owner',draft}),read:()=>cache.readWorkbenchDesignMeta(scope,'design','comments')};document.body.append('ready');
</script></body></html>`;
let server: ViteDevServer, url: string;
test.use({ serviceWorkers: "block" });
test.beforeAll(async () => {
  server = await createServer({ plugins: [{ name: "design-delivery-harness", configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => { if (req.url !== "/__delivery") return next(); res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/__delivery", html)); });
  } }], server: { port: 0, host: "127.0.0.1" } });
  await server.listen(); url = server.resolvedUrls!.local[0] + "__delivery";
});
test.afterAll(async () => { await server.close(); });
test.beforeEach(async ({ page }) => { await page.goto(url); await expect(page.locator("body")).toContainText("ready"); });

test("queue is not delivered; the persisted receipt settles once after reopening the cache", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const f=(window as any).delivery;await f.enqueue();const queued=await f.read();f.cache.close();
    const cache=new f.ClientCache('design-comment-delivery');await cache.acknowledge('send-one',true,{messageId:'actual-message'});
    const delivered=await cache.readWorkbenchDesignMeta(f.scope,'design','comments');await cache.acknowledge('send-one',true,{messageId:'actual-message'});
    const duplicate=await cache.readWorkbenchDesignMeta(f.scope,'design','comments');const outbox=await cache.outbox();cache.close();return {queued,delivered,duplicate,outbox};
  });
  expect(result.queued.threads.every((t:any)=>!t.agent)).toBe(true);
  expect(result.delivered.threads.map((t:any)=>t.agent)).toEqual([1,2].map(()=>expect.objectContaining({status:'delivered',messageId:'actual-message'})));
  expect(result.duplicate).toEqual(result.delivered);expect(result.outbox).toEqual([]);
});
test("an edited thread and a newly added thread do not inherit an older receipt", async ({ page }) => {
  const result=await page.evaluate(async()=>{const f=(window as any).delivery;await f.enqueue();const doc=await f.read();doc.threads[0].messages[0].text='changed';doc.threads[0].updatedAt='later';doc.threads.push(f.thread(3));doc.revision++;await f.cache.saveWorkbenchDesignMeta(f.scope,'design','comments',1,doc);await f.cache.acknowledge('send-one',true,{messageId:'actual-message'});return f.read();});
  expect(result.threads[0].agent).toBeUndefined();expect(result.threads[1].agent?.status).toBe('delivered');expect(result.threads[2].agent).toBeUndefined();
});
test("deleted comments and Bot replies remain untouched",async({page})=>{
  const result=await page.evaluate(async()=>{const f=(window as any).delivery;await f.enqueue();const doc=await f.read();doc.threads.shift();doc.threads[0].agent={status:'replied',sentAt:'then',repliedAt:'now'};doc.revision++;await f.cache.saveWorkbenchDesignMeta(f.scope,'design','comments',1,doc);await f.cache.acknowledge('send-one',true,{messageId:'actual-message'});return f.read();});
  expect(result.threads).toHaveLength(1);expect(result.threads[0].agent.status).toBe('replied');expect(result.revision).toBe(2);
});
test("history-limit and unknown message receipts never claim delivered",async({page})=>{
  const result=await page.evaluate(async()=>{const f=(window as any).delivery;await f.enqueue();await f.cache.acknowledge('send-one',true,{messageId:'actual-message',workbenchContextOmitted:'history_limit'});await f.cache.acknowledge('send-one',true,{messageId:'actual-message'});await f.cache.acknowledge('unknown',true,{messageId:'other'});return f.read();});
  expect(result.threads.every((t:any)=>!t.agent)).toBe(true);
});
test("a receipt pins target, identity and immutable queued bytes",async({page})=>{
  const result=await page.evaluate(async()=>{const f=(window as any).delivery;await f.enqueue();const errors=[];for(const request of [{frame:{...f.frame,text:'replacement'},identity:f.identity,draft:f.draft},{frame:{...f.frame,clientMsgId:'other'},identity:{...f.identity,publicKey:'foreign'},draft:f.draft},{frame:{...f.frame,clientMsgId:'other'},identity:f.identity,draft:{...f.draft,context:{...f.draft.context,target:{...f.target,tabId:'other'}}}}])try{await f.cache.enqueue(request.frame,{identity:request.identity,userId:'owner',draft:request.draft});errors.push('accepted');}catch(e){errors.push(String(e));}return {errors,outbox:await f.cache.outbox()};});
  expect(result.errors.every((e:string)=>e!=='accepted')).toBe(true);expect(result.outbox).toHaveLength(1);expect(result.outbox[0].frame.text).toBe('comments');
});
test("failed discard consumes the receipt without marking comments",async({page})=>{
  const result=await page.evaluate(async()=>{const f=(window as any).delivery;await f.enqueue();await f.cache.fail('send-one','rejected');await f.cache.discardFailed('send-one');await f.cache.acknowledge('send-one',true,{messageId:'late'});return {doc:await f.read(),receipt:await f.db.get('settings',f.designCommentReceiptKey('send-one'))};});
  expect(result.doc.threads.every((t:any)=>!t.agent)).toBe(true);expect(result.receipt).toBeUndefined();
});
test("optional comment quota failure does not strand an accepted message in the outbox",async({page})=>{
  const result=await page.evaluate(async()=>{
    const f=(window as any).delivery;await f.enqueue();const original=IDBObjectStore.prototype.put;let failed=0;
    IDBObjectStore.prototype.put=function(value:any,...keys:any[]){if(this.name==='workbenchDesignMeta' && value?.threads?.some((t:any)=>t.agent?.status==='delivered')){failed++;throw new DOMException('fixture quota exhausted','QuotaExceededError');}return (original as any).call(this,value,...keys);};
    try{await f.cache.acknowledge('send-one',true,{messageId:'actual-message'});}finally{IDBObjectStore.prototype.put=original;}
    return {failed,doc:await f.read(),outbox:await f.cache.outbox(),receipt:await f.db.get('settings',f.designCommentReceiptKey('send-one'))};
  });
  expect(result.failed).toBe(1);expect(result.outbox).toEqual([]);expect(result.receipt).toBeUndefined();expect(result.doc.threads.every((t:any)=>!t.agent)).toBe(true);
});
test("non-message and incomplete ACKs cannot mark delivered",async({page})=>{
  const result=await page.evaluate(async()=>{const f=(window as any).delivery;await f.enqueue();await f.cache.acknowledge('send-one',false,{messageId:'action'});const afterAction=await f.read();await f.cache.acknowledge('send-one',true,{});return {afterAction,afterIncomplete:await f.read()};});
  expect(result.afterAction.threads.every((t:any)=>!t.agent)).toBe(true);expect(result.afterIncomplete).toEqual(result.afterAction);
});
test("corrupt optional comments do not block actual message acceptance",async({page})=>{
  const result=await page.evaluate(async()=>{const f=(window as any).delivery;await f.enqueue();await f.db.put('workbenchDesignMeta',{corrupt:true},[f.scope,'design','comments']);await f.cache.acknowledge('send-one',true,{messageId:'actual-message'});return {doc:await f.read(),outbox:await f.cache.outbox()};});
  expect(result.outbox).toEqual([]);expect(result.doc).toEqual({corrupt:true});
});
