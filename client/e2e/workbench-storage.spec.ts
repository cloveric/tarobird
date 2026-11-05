import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import type { ViteDevServer } from "vite";

const html = `<!doctype html><html><body><script type="module">
import {ClientCache} from '/src/storage.ts';
import {emptyWorkbench,emptyBoard,changeWorkbench,workbenchScope} from '/src/workbench-model.ts';
import {emptyMarkdown} from '/src/workbench-markdown.ts';
import {noteRecoveryKey,rememberNoteRecovery,readNoteRecovery} from '/src/workbench-note-recovery.ts';
import {annotationDraft,resolveWorkbenchDraft} from '/src/workbench-draft.ts';
const identity={deviceId:'device',hubPublicKey:'hub',publicKey:'key',name:'test',routes:[]};
const cache=new ClientCache('workbench-storage-test');await cache.initializeIdentity(identity);
window.fixture={cache,ClientCache,identity,emptyWorkbench,emptyBoard,emptyMarkdown,noteRecoveryKey,rememberNoteRecovery,readNoteRecovery,changeWorkbench,workbenchScope,annotationDraft,resolveWorkbenchDraft};document.body.append('ready');
</script></body></html>`;
let server:ViteDevServer,url:string;
test.use({serviceWorkers:"block"});
test.beforeAll(async()=>{
  server=await createServer({plugins:[{name:"workbench-storage-test",configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
    if(req.url!=="/__workbench_storage")return next();res.setHeader("Content-Type","text/html");res.end(await vite.transformIndexHtml("/__workbench_storage",html));
  });}}],server:{port:0,strictPort:false,host:"127.0.0.1"}});await server.listen();url=server.resolvedUrls!.local[0]!;
});
test.afterAll(async()=>{await server?.close();});
test.beforeEach(async({page})=>{await page.goto(url+"__workbench_storage");await expect(page.locator("body")).toContainText("ready");});

test("whiteboard and layout CAS reject a stale second window and preserve unrelated scope",async({page})=>{
  const result=await page.evaluate(async()=>{
    const f=(window as any).fixture,scope=f.workbenchScope("hub","user","conversation"),other=f.workbenchScope("hub","other","conversation");
    await f.cache.saveWorkbench(scope,-1,f.emptyWorkbench());await f.cache.saveWorkbenchBoard(scope,-1,f.emptyBoard("board"));
    await f.cache.saveWorkbenchBoard(other,-1,{...f.emptyBoard("board"),scene:{elements:[],appState:{viewBackgroundColor:"#111111"}}});
    const second=new f.ClientCache("workbench-storage-test");
    const board=await second.readWorkbenchBoard(scope,"board"), layout=await second.readWorkbench(scope);
    await f.cache.saveWorkbenchBoard(scope,0,{...board,revision:1,scene:{elements:[{id:"kept",type:"text",text:"manual edit"}],appState:{}}});
    await f.cache.saveWorkbench(scope,0,f.changeWorkbench(layout,{type:"open",tab:{id:"board",kind:"whiteboard",title:"My board"}}));
    const errors=[];
    for(const action of [()=>second.saveWorkbenchBoard(scope,0,{...board,revision:1}),()=>second.saveWorkbench(scope,0,{...layout,revision:1}),()=>second.deleteWorkbenchBoard(scope,"board",0)])try{await action();}catch(e){errors.push((e as Error).message);}
    const after=await f.cache.readWorkbenchBoard(scope,"board"),otherBoard=await f.cache.readWorkbenchBoard(other,"board");second.close();
    return {errors,after,otherBoard,layout:await f.cache.readWorkbench(scope)};
  });
  expect(result.errors).toEqual(["whiteboard_revision_conflict","workbench_revision_conflict","whiteboard_revision_conflict"]);
  expect(result.after.scene.elements[0].text).toBe("manual edit");expect(result.otherBoard.scene.appState.viewBackgroundColor).toBe("#111111");expect(result.layout.visible).toEqual(["board"]);
});

test("reset fences late workbench saves and forget removes local boards",async({page})=>{
  const result=await page.evaluate(async()=>{
    const f=(window as any).fixture;await f.cache.saveWorkbench("scope",-1,f.emptyWorkbench());await f.cache.saveWorkbenchBoard("scope",-1,f.emptyBoard("board"));
    await f.cache.beginReset();const errors=[];
    for(const action of [()=>f.cache.saveWorkbench("scope",0,{...f.emptyWorkbench(),revision:1}),()=>f.cache.saveWorkbenchBoard("scope",0,{...f.emptyBoard("board"),revision:1})])try{await action();}catch(e){errors.push((e as Error).message);}
    const replacement=new f.ClientCache("workbench-storage-test");await replacement.finishReset();const board=await replacement.readWorkbenchBoard("scope","board"),layout=await replacement.readWorkbench("scope");replacement.close();return{errors,board,layout};
  });
  expect(result.errors).toEqual(["local_reset_in_progress","local_reset_in_progress"]);expect(result.board).toBeUndefined();expect(result.layout).toBeUndefined();
});

test("deleting a whiteboard and its tab is atomic when another window changed the layout",async({page})=>{
  const result=await page.evaluate(async()=>{
    const f=(window as any).fixture,scope="atomic-delete";
    const initial=f.changeWorkbench(f.emptyWorkbench(),{type:"open",tab:{id:"board",kind:"whiteboard",title:"Keep"}});
    initial.revision=0;
    await f.cache.saveWorkbench(scope,-1,initial);await f.cache.saveWorkbenchBoard(scope,-1,f.emptyBoard("board"));
    const renamed=f.changeWorkbench(initial,{type:"rename",id:"board",title:"Another window"});await f.cache.saveWorkbench(scope,0,renamed);
    let error="";try{await f.cache.deleteWorkbenchBoardAndLayout(scope,"board",0,0,f.changeWorkbench(initial,{type:"delete",id:"board"}));}catch(e){error=(e as Error).message;}
    const kept=await f.cache.readWorkbenchBoard(scope,"board"),keptLayout=await f.cache.readWorkbench(scope);
    await f.cache.deleteWorkbenchBoardAndLayout(scope,"board",0,1,f.changeWorkbench(renamed,{type:"delete",id:"board"}));
    return {error,kept,keptLayout,deleted:await f.cache.readWorkbenchBoard(scope,"board"),layout:await f.cache.readWorkbench(scope)};
  });
  expect(result.error).toBe("workbench_revision_conflict");expect(result.kept.id).toBe("board");expect(result.keptLayout.tabs[0].title).toBe("Another window");
  expect(result.deleted).toBeUndefined();expect(result.layout.tabs).toEqual([]);expect(result.layout.visible).toEqual([]);
});

test("annotation keeps exact original bytes, survives draft reopen and tracks reordered files",async({page})=>{
  await page.evaluate(async()=>{
    const f=(window as any).fixture;
    const input={boardId:"board",baseRevision:4,originalElementId:"image_original",original:{file:new File([new Uint8Array([0,255,1,9])],"original.png",{type:"image/png"})},preview:new File(["annotations"],"preview.png",{type:"image/png"}),references:[{elementId:"reference",file:new File(["reference"],"reference.png",{type:"image/png"})}]};
    const prepared=await f.annotationDraft({deviceId:"device",windowId:"window",tabId:"board"},input);
    await f.cache.saveDraft("conversation","keep existing text");
    await f.cache.saveConversationDraft("conversation",{files:[new File(["keep"],"keep.txt"),...prepared.files],workbench:prepared.workbench,previewStyle:"card"},f.identity);
  });
  await page.reload();await expect(page.locator("body")).toContainText("ready");
  const result=await page.evaluate(async()=>{
    const f=(window as any).fixture,{draft}=await f.cache.conversationDraft("conversation",f.identity),files=[draft.files[2],draft.files[0],draft.files[3],draft.files[1]];
    const context=await f.resolveWorkbenchDraft(draft.workbench,files,["att_preview","att_keep","att_reference","att_original"]);
    let error="";try{await f.resolveWorkbenchDraft(draft.workbench,[new File(["wrong"],"original.png",{type:"image/png"}),draft.files[2],draft.files[3]],["a","b","c"]);}catch(e){error=(e as Error).message;}
    return {context,error,bytes:[...new Uint8Array(await draft.files[1].arrayBuffer())],text:await f.cache.draft("conversation")};
  });
  expect(result.text).toBe("keep existing text");expect(result.bytes).toEqual([0,255,1,9]);expect(result.context.target.tabId).toBe("board");expect(result.context.imageEdit).toMatchObject({baseRevision:4,originalElementId:"image_original",originalAttachmentId:"att_original",referenceAttachmentIds:["att_reference"],attachmentIds:["att_original","att_preview","att_reference"]});expect(result.error).toBe("workbench_image_draft_changed");
});


test("Markdown creation and deletion are atomic, CAS is scoped, and reset fences late writes", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const f = (window as any).fixture, scope = "notes", other = "other-notes";
    await f.cache.saveWorkbench(scope, -1, f.emptyWorkbench());
    const note = f.emptyMarkdown("note", "# Original😀"), layout = f.changeWorkbench(f.emptyWorkbench(), { type: "open", tab: { id: "note", kind: "markdown", title: "Keep.md" } });
    let createError = ""; try { await f.cache.createWorkbenchMarkdownAndLayout(scope, note, 1, { ...layout, revision: 2 }); } catch (error) { createError = (error as Error).message; }
    const orphan = await f.cache.readWorkbenchMarkdown(scope, "note");
    await f.cache.createWorkbenchMarkdownAndLayout(scope, note, 0, layout);
    await f.cache.saveWorkbenchMarkdown(other, -1, f.emptyMarkdown("note", "Other user"));
    await f.cache.saveWorkbenchMarkdown(scope, 0, { ...note, revision: 1, content: "Current" });
    let stale = ""; try { await f.cache.saveWorkbenchMarkdown(scope, 0, { ...note, revision: 1, content: "Stale" }); } catch (error) { stale = (error as Error).message; }
    const changedLayout = f.changeWorkbench(layout, { type: "rename", id: "note", title: "Renamed.md" }); await f.cache.saveWorkbench(scope, 1, changedLayout);
    let deleteError = ""; try { await f.cache.deleteWorkbenchMarkdownAndLayout(scope, "note", 1, 1, f.changeWorkbench(layout, { type: "delete", id: "note" })); } catch (error) { deleteError = (error as Error).message; }
    const kept = await f.cache.readWorkbenchMarkdown(scope, "note"), unrelated = await f.cache.readWorkbenchMarkdown(other, "note");
    await f.cache.deleteWorkbenchMarkdownAndLayout(scope, "note", 1, 2, f.changeWorkbench(changedLayout, { type: "delete", id: "note" }));
    const deleted = await f.cache.readWorkbenchMarkdown(scope, "note");
    await f.cache.beginReset(); let reset = "";
    try { await f.cache.saveWorkbenchMarkdown(other, 0, { ...unrelated, revision: 1 }); } catch (error) { reset = (error as Error).message; }
    const replacement = new f.ClientCache("workbench-storage-test"); await replacement.finishReset(); const afterReset = await replacement.readWorkbenchMarkdown(other, "note"); replacement.close();
    return { createError, orphan, stale, deleteError, kept, unrelated, deleted, reset, afterReset };
  });
  expect(result.createError).toBe("workbench_revision_conflict"); expect(result.orphan).toBeUndefined();
  expect(result.stale).toBe("markdown_revision_conflict"); expect(result.deleteError).toBe("workbench_revision_conflict");
  expect(result.kept.content).toBe("Current"); expect(result.unrelated.content).toBe("Other user"); expect(result.deleted).toBeUndefined();
  expect(result.reset).toBe("local_reset_in_progress"); expect(result.afterReset).toBeUndefined();
});


test("emergency note drafts survive reconstruction and explicit local reset clears only this device", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const f = (window as any).fixture, own = f.noteRecoveryKey("device", "scope", "note"), other = f.noteRecoveryKey("other-device", "scope", "note");
    f.rememberNoteRecovery(own, { content: "Recover after failed save", revision: 4 }); f.rememberNoteRecovery(other, { content: "Other device", revision: 1 });
    const before = f.readNoteRecovery(own); await f.cache.beginReset();
    return { before, after: f.readNoteRecovery(own), other: f.readNoteRecovery(other), persisted: sessionStorage.getItem(own) };
  });
  expect(result.before).toEqual({ content: "Recover after failed save", revision: 4 }); expect(result.after).toBeUndefined(); expect(result.persisted).toBeNull(); expect(result.other.content).toBe("Other device");
});


test("real IndexedDB v10 upgrade adds notes and keeps prior boards and outbox bytes", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const f = (window as any).fixture, existing = await f.cache.db;
    // Reconstruct v10: notes arrived in v11, Design in v12.
    const descriptions = [...existing.objectStoreNames].filter(name => !["workbenchMarkdown","workbenchDesign","workbenchDesignMeta","workbenchDesignObjects"].includes(name)).map(name => {
      const store = existing.transaction(name).objectStore(name);
      return { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: [...store.indexNames].map(index => { const value = store.index(index); return { name: index, keyPath: value.keyPath, unique: value.unique, multiEntry: value.multiEntry }; }) };
    });
    const old = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open("notes-upgrade-v10", 10); open.onupgradeneeded = () => { for (const item of descriptions) { const store = open.result.createObjectStore(item.name, { keyPath: item.keyPath, autoIncrement: item.autoIncrement }); for (const index of item.indexes) store.createIndex(index.name, index.keyPath, index); } }; open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const tx = old.transaction(["settings", "workbenchBoards", "outbox"], "readwrite");
    tx.objectStore("settings").put(f.identity, "identity"); tx.objectStore("workbenchBoards").put(f.emptyBoard("old"), ["scope", "old"]);
    tx.objectStore("outbox").put({ id: "outbox-keep", clientMsgId: "outbox-keep", text: "keep exact😀" });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); old.close();
    const upgraded = new f.ClientCache("notes-upgrade-v10"), db = await upgraded.db;
    const board = await upgraded.readWorkbenchBoard("scope", "old"), outbox = await db.getAll("outbox");
    await upgraded.saveWorkbenchMarkdown("scope", -1, f.emptyMarkdown("new", "new note"));
    const note = await upgraded.readWorkbenchMarkdown("scope", "new"); upgraded.close();
    return { version: db.version, board, outbox, note };
  });
  expect(result.version).toBe(13); expect(result.board.id).toBe("old"); expect(result.outbox[0].text).toBe("keep exact😀"); expect(result.note.content).toBe("new note");
});

test("new board bytes and layout commit together through stale revisions, aborted writes and reset", async ({page}) => {
  const result=await page.evaluate(async () => {
    const f=(window as any).fixture,scope="atomic-create-board",board=f.emptyBoard("new-board");
    await f.cache.saveWorkbench(scope,-1,f.emptyWorkbench());
    const next=f.changeWorkbench(f.emptyWorkbench(),{type:"open",tab:{id:board.id,kind:"whiteboard",title:"New board"}});
    let stale="";try{await f.cache.createWorkbenchBoardAndLayout(scope,board,1,{...next,revision:2});}catch(error){stale=(error as Error).message;}
    const afterStale=await f.cache.readWorkbenchBoard(scope,board.id);
    const put=IDBObjectStore.prototype.put;let aborted="";
    IDBObjectStore.prototype.put=function(...args:Parameters<IDBObjectStore["put"]>){if(this.name==="workbenchLayouts"){this.transaction.abort();throw Error("injected_layout_abort");}return put.apply(this,args);};
    try{await f.cache.createWorkbenchBoardAndLayout(scope,board,0,next);}catch(error){aborted=(error as Error).message;}finally{IDBObjectStore.prototype.put=put;}
    const afterAbort=await f.cache.readWorkbenchBoard(scope,board.id),layoutAfterAbort=await f.cache.readWorkbench(scope);
    await f.cache.createWorkbenchBoardAndLayout(scope,board,0,next);
    const saved=await f.cache.readWorkbenchBoard(scope,board.id),layout=await f.cache.readWorkbench(scope);
    await f.cache.beginReset();let reset="";
    try{await f.cache.createWorkbenchBoardAndLayout(scope,f.emptyBoard("late-board"),1,f.changeWorkbench(next,{type:"open",tab:{id:"late-board",kind:"whiteboard",title:"Late"}}));}catch(error){reset=(error as Error).message;}
    return {stale,afterStale,aborted,afterAbort,layoutAfterAbort,saved,layout,reset};
  });
  expect(result.stale).toBe("workbench_revision_conflict");expect(result.afterStale).toBeUndefined();
  expect(result.aborted).toBe("injected_layout_abort");expect(result.afterAbort).toBeUndefined();expect(result.layoutAfterAbort.revision).toBe(0);
  expect(result.saved.id).toBe("new-board");expect(result.layout.tabs.map((tab:any)=>tab.id)).toEqual(["new-board"]);
  expect(result.reset).toBe("local_reset_in_progress");
});
