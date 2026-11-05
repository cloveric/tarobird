import {test,expect} from '@playwright/test';
import {createServer} from './fixtures/vite.js';
import type {ViteDevServer} from 'vite';
const html=`<!doctype html><body><script type="module">
import {ClientCache} from '/src/storage.ts';
import {emptyDesignDocument,designTextFile,applyDesignFiles} from '/src/workbench-design.ts';
import {DesignSession} from '/src/workbench-design-session.ts';
import {emptyWorkbench,changeWorkbench,workbenchScope} from '/src/workbench-model.ts';
import {bindWorkbenchDraft,resolveWorkbenchDraft} from '/src/workbench-draft.ts';
import {exportDesktopData,indexedDbExportSource} from '/src/desktop-migration-export.ts';
import {importDesktopData,indexedDbImportTarget} from '/src/desktop-migration-import.ts';
import {parseRecordLine} from '/src/desktop-migration-format.ts';
import {createDesignBackup,parseDesignBackup,serializeDesignBackup} from '/src/workbench-design-backup.ts';
import {planDesignHistory} from '/src/workbench-design-history.ts';
import {WorkbenchController} from '/src/workbench-controller.ts';
const identity={deviceId:'d',hubPublicKey:'h',publicKey:'k',name:'test',routes:[]};
const cache=new ClientCache('suite-storage');await cache.initializeIdentity(identity);
window.fixture={cache,ClientCache,identity,emptyDesignDocument,designTextFile,applyDesignFiles,DesignSession,emptyWorkbench,changeWorkbench,workbenchScope,bindWorkbenchDraft,resolveWorkbenchDraft,exportDesktopData,indexedDbExportSource,importDesktopData,indexedDbImportTarget,parseRecordLine,createDesignBackup,parseDesignBackup,serializeDesignBackup,planDesignHistory,WorkbenchController};document.body.append('ready');
</script>`;
let server:ViteDevServer,url:string;
test.use({serviceWorkers:'block'});
test.beforeAll(async()=>{server=await createServer({plugins:[{name:'suite-store',configureServer(vite){vite.middlewares.use(async(req,res,next)=>{if(req.url!=='/__suite_store')return next();res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/__suite_store',html));});}}],server:{port:0,strictPort:false,host:'127.0.0.1'}});await server.listen();url=server.resolvedUrls!.local[0]!;});
test.afterAll(async()=>{await server?.close();});
test.beforeEach(async({page})=>{await page.goto(url+'__suite_store');await expect(page.locator('body')).toContainText('ready');});
test('document/history commit atomically, stale sidecar refuses, delete removes only its own sidecars',async({page})=>{
 const result=await page.evaluate(async()=>{
  const f=(window as any).fixture,c=f.cache,d=f.emptyDesignDocument('design','Original'),scope='scope';
  await c.saveWorkbenchDesign(scope,-1,d);await c.saveWorkbenchDesign('other',-1,d);
  const next=f.applyDesignFiles(d,{'project/Main.dc.html':{base64:f.designTextFile('<h1>Changed</h1>','text/html').base64,contentType:'text/html',ifMatch:d.files['project/Main.dc.html'].sha256}});
  const file=d.files['project/Main.dc.html'],sidecar={history:{expected:-1,next:{revision:0},put:{[file.sha256]:file},drop:[]}};
  await c.saveWorkbenchDesign(scope,0,next,sidecar);
  await c.saveWorkbenchDesignMeta(scope,d.id,'comments',0,{revision:1,threads:[]});
  await c.saveWorkbenchDesignMeta('other',d.id,'comments',0,{revision:1,threads:['keep']});
  let error='';try{await c.saveWorkbenchDesign(scope,1,{...next,revision:2},sidecar);}catch(e){error=(e as Error).message}
  const kept=await c.readWorkbenchDesign(scope,d.id),object=await c.readWorkbenchDesignObject(scope,d.id,file.sha256);
  await c.deleteWorkbenchDesign(scope,d.id,1);
  return{error,revision:kept.revision,object:object.sha256,deleted:await c.readWorkbenchDesign(scope,d.id),history:await c.readWorkbenchDesignMeta(scope,d.id,'history'),comments:await c.readWorkbenchDesignMeta(scope,d.id,'comments'),removedObject:await c.readWorkbenchDesignObject(scope,d.id,file.sha256),other:await c.readWorkbenchDesignMeta('other',d.id,'comments')};
 });
 expect(result.error).toBe('design_history_conflict');expect(result.revision).toBe(1);expect(result.object).toMatch(/^[a-f0-9]{64}$/);expect(result.deleted).toBeUndefined();expect(result.history).toBeUndefined();expect(result.comments).toBeUndefined();expect(result.removedObject).toBeUndefined();expect(result.other.threads).toEqual(['keep']);
});
test('reset fences late comment/history writes and removes their bytes',async({page})=>{
 const result=await page.evaluate(async()=>{
  const f=(window as any).fixture,c=f.cache,d=f.emptyDesignDocument('design','Original');await c.saveWorkbenchDesign('scope',-1,d);
  await c.saveWorkbenchDesignMeta('scope',d.id,'comments',0,{revision:1,threads:[]});await c.beginReset();const errors=[];
  for(const run of [()=>c.saveWorkbenchDesignMeta('scope',d.id,'comments',1,{revision:2}),()=>c.saveWorkbenchDesign('scope',0,{...d,revision:1})])try{await run()}catch(e){errors.push((e as Error).message)}
  const n=new f.ClientCache('suite-storage');await n.finishReset();const gone=await n.readWorkbenchDesignMeta('scope',d.id,'comments');n.close();return{errors,gone};
 });expect(result.errors).toEqual(['local_reset_in_progress','local_reset_in_progress']);expect(result.gone).toBeUndefined();
});
test('comment draft without files survives reload and keeps original target when active tab changes',async({page})=>{
 await page.evaluate(async()=>{const f=(window as any).fixture;await f.cache.saveConversationDraft('conv',{files:[],workbench:{context:{target:{deviceId:'d',windowId:'old',tabId:'design'},kind:'design',revision:3},files:[],designComments:['c_0123456789']},previewStyle:'card'},f.identity);});
 await page.reload();await expect(page.locator('body')).toContainText('ready');
 const result=await page.evaluate(async()=>{const f=(window as any).fixture,{draft}=await f.cache.conversationDraft('conv',f.identity);
  const registration={windowId:'new',conversationId:'conv',activeTabId:'other',visible:true,tabs:[{id:'design',kind:'design'},{id:'other',kind:'design'}]};
  const bound=f.bindWorkbenchDraft(draft.workbench,'d','conv',registration);const target=await f.resolveWorkbenchDraft(bound,[],[]);let wrong='';try{f.bindWorkbenchDraft(draft.workbench,'different','conv',registration)}catch(e){wrong=(e as Error).message}return{target,wrong,ids:draft.workbench.designComments};});
 expect(result.target).toMatchObject({target:{deviceId:'d',windowId:'new',tabId:'design'},kind:'design',revision:3});expect(result.wrong).toBeTruthy();expect(result.ids).toEqual(['c_0123456789']);
});

test('actual IndexedDB export/import/reopen retains comment and history sidecars with content bytes',async({page})=>{
 const result=await page.evaluate(async()=>{
  const f=(window as any).fixture,c=new f.ClientCache('tarocub-v1'),scope='scope',d=f.emptyDesignDocument('design','Migrated');
  await c.initializeIdentity(f.identity);await c.saveWorkbenchDesign(scope,-1,d);
  const source=d.files['project/Main.dc.html'],changed=f.designTextFile('<h1>Edited</h1>','text/html');
  const next=f.applyDesignFiles(d,{'project/Main.dc.html':{base64:changed.base64,contentType:'text/html',ifMatch:source.sha256}});
  const history={revision:0,rows:[{n:1,files:{'project/Main.dc.html':source.sha256}}]},comments={revision:1,threads:[{id:'c_0123456789',text:'Keep this note'}]};
  await c.saveWorkbenchDesign(scope,0,next,{history:{expected:-1,next:history,put:{[source.sha256]:source},drop:[]}});
  await c.saveWorkbenchDesignMeta(scope,d.id,'comments',0,comments);c.close();
  const parts:string[]=[],blobs:Record<string,Uint8Array>={},exportId=crypto.randomUUID();let metadata:any;
  const hash=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(n=>n.toString(16).padStart(2,'0')).join('');
  const exported=await f.exportDesktopData(f.indexedDbExportSource(),{
   begin:async()=>exportId,abort:async()=>undefined,part:async(i:number,text:string)=>{parts[i]=text;},
   blob:async(bytes:Uint8Array)=>{const id=await hash(bytes);blobs[id]=bytes;return id;},
   commit:async(meta:any)=>{metadata=meta;return{exportId,records:parts.join('').split('\n').length-1,bytes:0};}
  },{appVersion:'1.0.127'});
  const counts:Record<string,Record<string,number>>={};let records=0,local=0;
  for(const line of parts.join('').split('\n').filter(Boolean)){const{d,s}=f.parseRecordLine(line);records++;if(d==='localStorage')local++;else{counts[d]??={};counts[d][s]=(counts[d][s]??0)+1;}}
  const manifest={format:'tarobot-desktop-migration',version:1,exportId,createdAt:1,installation:'0'.repeat(64),source:{app:'tauri',appVersion:'1.0.127'},databases:metadata.databases.map((db:any)=>({...db,stores:counts[db.name]})),localStorage:local,parts:await Promise.all(parts.map(async(text,i)=>({file:String(i).padStart(6,'0')+'.jsonl',bytes:new TextEncoder().encode(text).length,sha256:await hash(new TextEncoder().encode(text)),records:text.split('\n').length-1}))),blobs:Object.entries(blobs).map(([sha256,bytes])=>({sha256,bytes:bytes.length})),totals:{records,bytes:0},skipped:metadata.skipped,requiresRepair:metadata.requiresRepair};
  await new Promise<void>((resolve,reject)=>{const r=indexedDB.deleteDatabase('tarocub-v1');r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('fixture_delete_blocked'));});
  const imported=await f.importDesktopData({manifest,part:async(i:number)=>parts[i],blob:async(sha:string)=>blobs[sha]},await f.indexedDbImportTarget());
  const reopened=new f.ClientCache('tarocub-v1');
  const output={exported:exported.state,imported:imported.state,stores:counts['tarocub-v1'],document:await reopened.readWorkbenchDesign(scope,d.id),comments:await reopened.readWorkbenchDesignMeta(scope,d.id,'comments'),history:await reopened.readWorkbenchDesignMeta(scope,d.id,'history'),object:await reopened.readWorkbenchDesignObject(scope,d.id,source.sha256),expected:{next,comments,history,source}};reopened.close();return output;
 });
 expect(result.exported).toBe('exported');expect(result.imported).toBe('imported');expect(result.stores.workbenchDesignMeta).toBe(2);expect(result.stores.workbenchDesignObjects).toBe(1);
 expect(result.document).toEqual(result.expected.next);expect(result.comments).toEqual(result.expected.comments);expect(result.history).toEqual(result.expected.history);expect(result.object).toEqual(result.expected.source);
});

const makeBackup = async (page: import('@playwright/test').Page) => page.evaluate(() => {
 const f=(window as any).fixture,d0=f.emptyDesignDocument('source','Source project');
 const edit=(doc:any,text:string)=>f.applyDesignFiles(doc,{'project/Main.dc.html':{base64:f.designTextFile(text,'text/html').base64,contentType:'text/html',ifMatch:doc.files['project/Main.dc.html'].sha256}});
 const d1=edit(d0,'<h1>First version</h1>'),h1=f.planDesignHistory({before:d0,after:d1,author:{by:'agent',user:{id:'bot:trusted',name:'Trusted Bot'},requestId:'first'}});
 const d2=edit(d1,'<h1>Second version</h1>'),h2=f.planDesignHistory({index:h1.next,before:d1,after:d2,author:{by:'agent',user:{id:'bot:trusted',name:'Trusted Bot'},requestId:'second'}});
 const objects={...h1.put,...h2.put};for(const sha of h2.drop)delete objects[sha];
 const comments={schema:1,revision:1,receipts:[],threads:[{id:'c_0123456789',anchor:'title',label:'Title',location:{file:'project/Main.dc.html'},status:'open',createdAt:'2026-11-03T00:00:00Z',updatedAt:'2026-11-03T00:00:00Z',messages:[{id:'m_0123456789',author:{kind:'agent',name:'Trusted Bot',principal:'bot:trusted'},text:'Keep this comment',at:'2026-11-03T00:00:00Z'}]}]};
 return f.serializeDesignBackup({title:'Full backup',document:d2,comments,history:h2.next,objects});
});

test('controller imports a full backup, reopens it and restores a real stored history version',async({page})=>{
 const text=await makeBackup(page);
 const result=await page.evaluate(async(text)=>{
  const f=(window as any).fixture,connection={cache:f.cache,identity:f.identity,state:{user:{id:'owner',name:'Owner'},status:'online'},isClosed:false,isReadOnly:false,subscribe:()=>()=>{},conversationRevision:()=>0};
  let controller=new f.WorkbenchController({connection,conversationId:'backup-conv'});await controller.initialize();
  const id=await controller.importDesign(new File([text],'project.tarobot-design.json',{type:'application/json'}));
  const first=JSON.parse(await controller.exportDesign(id,'Full backup'));controller.dispose();
  controller=new f.WorkbenchController({connection,conversationId:'backup-conv'});await controller.initialize();
  const session=controller.designSession(id),listing=await session.historyList({});
  const restore=await session.restoreFromUi(2);const last=JSON.parse(await controller.exportDesign(id,'Full backup'));controller.dispose();
  return{id,first,last,listing,restore};
 },text);
 expect(result.id).not.toBe('source');expect(result.first).toMatchObject({format:'tarobot-design',version:2,document:{id:result.id,revision:0,receipts:[]},comments:{revision:0,receipts:[]}});
 expect(result.first.comments.threads[0].messages[0].author).toMatchObject({kind:'user',principal:expect.stringMatching(/^imported:/)});
 expect(result.first.history.versions).toHaveLength(3);expect(Object.keys(result.first.objects)).toHaveLength(2);
 expect(result.listing.result.rows).toHaveLength(3);expect(result.restore).toMatchObject({revision:1,restoredFrom:2});
 expect(Buffer.from(result.last.document.files['project/Main.dc.html'].base64,'base64').toString()).toBe('<h1>First version</h1>');
 expect(result.last.history.versions.at(-1)).toMatchObject({restoredFrom:2,by:'human'});
});

test('a refused backup layout CAS leaves no content, metadata or objects behind',async({page})=>{
 const text=await makeBackup(page);
 const result=await page.evaluate(async(text)=>{
  const f=(window as any).fixture,c=f.cache,scope='import-cas',initial=f.emptyWorkbench();await c.saveWorkbench(scope,-1,initial);
  const imported=f.parseDesignBackup(text,'cas-design'),layout=f.changeWorkbench(initial,{type:'open',tab:{id:imported.document.id,kind:'design',title:imported.title}});
  await c.saveWorkbench(scope,0,{...initial,revision:1});let error='';
  try{await c.createWorkbenchDesignAndLayout(scope,imported.document,0,layout,imported);}catch(e){error=(e as Error).message}
  const objectKeys=Object.keys(imported.objects);return{error,document:await c.readWorkbenchDesign(scope,'cas-design'),comments:await c.readWorkbenchDesignMeta(scope,'cas-design','comments'),history:await c.readWorkbenchDesignMeta(scope,'cas-design','history'),objects:await Promise.all(objectKeys.map(sha=>c.readWorkbenchDesignObject(scope,'cas-design',sha))),layout:await c.readWorkbench(scope)};
 },text);
 expect(result.error).toBe('workbench_revision_conflict');expect(result.document).toBeUndefined();expect(result.comments).toBeUndefined();expect(result.history).toBeUndefined();expect(result.objects.every(x=>x===undefined)).toBe(true);expect(result.layout.tabs).toEqual([]);
});

test('an actual IDB write exception aborts the imported document, layout and every sidecar',async({page})=>{
 const text=await makeBackup(page);
 const result=await page.evaluate(async(text)=>{
  const f=(window as any).fixture,c=f.cache,scope='import-abort',initial=f.emptyWorkbench();await c.saveWorkbench(scope,-1,initial);
  const imported=f.parseDesignBackup(text,'abort-design'),layout=f.changeWorkbench(initial,{type:'open',tab:{id:imported.document.id,kind:'design',title:imported.title}});
  const original=IDBObjectStore.prototype.put;let error='';
  IDBObjectStore.prototype.put=function(value:any,key?:IDBValidKey){if(this.name==='workbenchDesignMeta'&&Array.isArray(key)&&key[2]==='history')throw new DOMException('fixture quota','QuotaExceededError');return original.call(this,value,key)};
  try{await c.createWorkbenchDesignAndLayout(scope,imported.document,0,layout,imported);}catch(e){error=(e as Error).name}finally{IDBObjectStore.prototype.put=original}
  return{error,document:await c.readWorkbenchDesign(scope,'abort-design'),comments:await c.readWorkbenchDesignMeta(scope,'abort-design','comments'),history:await c.readWorkbenchDesignMeta(scope,'abort-design','history'),objects:await Promise.all(Object.keys(imported.objects).map(sha=>c.readWorkbenchDesignObject(scope,'abort-design',sha))),layout:await c.readWorkbench(scope)};
 },text);
 expect(result.error).toBe('QuotaExceededError');expect(result.document).toBeUndefined();expect(result.comments).toBeUndefined();expect(result.history).toBeUndefined();expect(result.objects.every(x=>x===undefined)).toBe(true);expect(result.layout.tabs).toEqual([]);
});

test('backup snapshots stay internally consistent while another cache commits a new version',async({page})=>{
 const text=await makeBackup(page);
 const result=await page.evaluate(async(text)=>{
  const f=(window as any).fixture,c=f.cache,other=new f.ClientCache('suite-storage'),scope='snapshot',initial=f.emptyWorkbench();await c.saveWorkbench(scope,-1,initial);
  const imported=f.parseDesignBackup(text,'snapshot-design'),layout=f.changeWorkbench(initial,{type:'open',tab:{id:imported.document.id,kind:'design',title:imported.title}});
  await c.createWorkbenchDesignAndLayout(scope,imported.document,0,layout,imported);
  const revisions:number[]=[];
  for(let n=0;n<4;n++){
   const doc=await other.readWorkbenchDesign(scope,'snapshot-design'),history=await other.readWorkbenchDesignMeta(scope,'snapshot-design','history');
   const changed=f.designTextFile(`<h1>Concurrent ${n}</h1>`,'text/html'),next=f.applyDesignFiles(doc,{'project/Main.dc.html':{base64:changed.base64,contentType:'text/html',ifMatch:doc.files['project/Main.dc.html'].sha256}}),plan=f.planDesignHistory({index:history,before:doc,after:next,author:{by:'agent',user:{id:'bot:writer',name:'Writer'},requestId:`write-${n}`}});
   const [snapshot]=await Promise.all([c.readWorkbenchDesignBackup(scope,'snapshot-design','Snapshot'),other.saveWorkbenchDesign(scope,doc.revision,next,{history:plan})]);
   f.createDesignBackup(snapshot);revisions.push(snapshot.document.revision);
  }
  const final=await c.readWorkbenchDesignBackup(scope,'snapshot-design','Snapshot');other.close();return{revisions,final:final.document.revision,latest:final.history.versions.at(-1).revision};
 },text);
 expect(result.revisions).toHaveLength(4);expect(result.final).toBe(4);expect(result.latest).toBe(4);
});
