import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
import { HubServer } from "../../src/hub/server.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";

// Source App + real signed Hub sockets by default. The final unified build can
// run the same journey using WORKBENCH_SHARED_CLIENT_DIST without a local build.
let vite:ViteDevServer|undefined,appUrl:string|undefined;
test.use({serviceWorkers:"block"});
test.beforeAll(async()=>{if(!process.env.WORKBENCH_SHARED_CLIENT_DIST){vite=await createServer({server:{port:0,host:"127.0.0.1"}});await vite.listen();appUrl=vite.resolvedUrls!.local[0];}});
test.afterAll(async()=>{await vite?.close();});
const panel=(page:Page,en=false)=>page.getByRole("complementary",{name:en?"Workbench":"工作台",exact:true});
const listName=(en=false)=>en?"Projects shared with me":"共享给我的项目";
async function fixture(){
 const directory=await mkdtemp(path.join(os.tmpdir(),"shared-entry-"));const hub=await HubServer.start({stateDir:directory,...(appUrl?{origins:[new URL(appUrl).origin]}:{clientDir:process.env.WORKBENCH_SHARED_CLIENT_DIST!})});
 await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','设计助手','fixture')");const conversation=await hub.store.createConversation("owner",["alpha"],"空工作台共享验收","shared_entry");
 return {hub,conversation,close:async()=>{await hub.close();await rm(directory,{recursive:true,force:true});}};
}
async function connect(page:Page,hub:HubServer,title:string){
 await page.goto(appUrl??hub.url);if(appUrl)await page.getByRole("textbox",{name:"Hub 地址",exact:true}).fill(hub.url);
 await preparePairing(page,hub);await page.getByRole("button",{name:"配对此设备",exact:true}).click();await hub.auth.approve(await page.getByLabel("配对码",{exact:true}).innerText(),"local-owner");await page.getByLabel("配对码",{exact:true}).waitFor({state:"hidden"});
 await waitForClientOnline(page);await showDisconnectedBots(page);await selectConversation(page,title);await page.getByRole("button",{name:"工作台",exact:true}).click();await expect(panel(page)).toBeVisible();
}
async function localDesignCount(page:Page){return page.evaluate(async()=>{let count=0;for(const entry of await indexedDB.databases()){const db=await new Promise<IDBDatabase>((resolve,reject)=>{const req=indexedDB.open(entry.name!);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});try{if(db.objectStoreNames.contains("workbenchDesign"))count+=await new Promise<number>((resolve,reject)=>{const req=db.transaction("workbenchDesign").objectStore("workbenchDesign").count();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}finally{db.close();}}return count;});}
async function openList(page:Page,en=false){await panel(page,en).getByRole("button",{name:en?"New content":"新建内容",exact:true}).click();const item=panel(page,en).getByRole("menu").getByRole("button",{name:listName(en),exact:true});await expect(item).toBeVisible();await item.click();return page.getByRole("region",{name:listName(en),exact:true});}

test("empty Workbench opens shared designs in Chinese and English without creating a local document",async({page,browser},info)=>{
 test.setTimeout(240000);const f=await fixture(),context=await browser.newContext({viewport:{width:1360,height:900},serviceWorkers:"block"}),other=await context.newPage();const errors:string[]=[];for(const p of [page,other])p.on("pageerror",e=>{errors.push(e.message);console.log("SHARED_ENTRY_PAGEERROR",e.stack);});
 let releaseJoin:(()=>void)|undefined;
 await other.routeWebSocket("**/ws",socket=>{const upstream=socket.connectToServer();socket.onMessage(message=>{const frame=typeof message==="string"?JSON.parse(message):undefined;if(frame?.type==="design.share.request"&&frame.request?.op==="join"&&!releaseJoin){releaseJoin=()=>upstream.send(message);return;}upstream.send(message);});upstream.onMessage(message=>socket.send(message));});
 try{
  await connect(other,f.hub,f.conversation.title);await expect(panel(other).getByRole("tab")).toHaveCount(0);expect(await localDesignCount(other)).toBe(0);
  const chinese=await openList(other);await expect(chinese).toBeInViewport();await expect(chinese).toContainText("这个对话里暂时没有共享给你的设计。");expect(await localDesignCount(other)).toBe(0);await chinese.getByRole("button",{name:"关闭",exact:true}).click();await expect(chinese).toHaveCount(0);
  await openSettings(other,"general");await other.locator("#language").selectOption("en");await closeSettings(other,true);
  const english=await openList(other,true);await expect(english).toBeInViewport();await expect(english).toContainText("Nothing in this conversation is shared with you yet.");await english.getByRole("button",{name:"Close",exact:true}).click();
  await connect(page,f.hub,f.conversation.title);await panel(page).getByRole("button",{name:"新建内容",exact:true}).click();await panel(page).getByRole("menu").getByRole("button",{name:"画布",exact:true}).click();
  await expect(page.frameLocator(".workbench-design-frame:visible").getByRole("button",{name:"Comments",exact:true})).toBeVisible({timeout:45000});
  // Fixture-only access to the retained sharing component; the product entry is hidden.
  await expect(panel(page).getByRole("button",{name:"共享",exact:true})).toHaveCount(0);
  await panel(page).locator(".workbench-design-sharing-entry").evaluate(node=>node.removeAttribute("hidden"));
  await panel(page).getByRole("button",{name:"共享",exact:true}).click();const sharing=page.getByRole("dialog",{name:"共享与协作",exact:true});await sharing.getByRole("button",{name:"开始共享",exact:true}).click();await expect(sharing.getByText("正在从这台设备共享。",{exact:true})).toBeVisible({timeout:20000});await sharing.getByRole("button",{name:"关闭",exact:true}).click();
  const available=await openList(other,true),row=available.locator("li").filter({hasText:"画布"});await expect(row).toContainText("Source online");await row.getByRole("button",{name:"Open",exact:true}).click();await expect.poll(()=>!!releaseJoin).toBe(true);
  const close=available.getByRole("button",{name:"Close",exact:true});await expect(close).toBeDisabled();expect(await localDesignCount(other)).toBe(0);releaseJoin!();
  const viewer=other.getByRole("region",{name:/^Shared design:/});await expect(viewer).toBeVisible();await expect(close).toBeDisabled();
  await expect(other.frameLocator(".workbench-design-frame:visible").getByRole("button",{name:"Comments",exact:true})).toBeVisible({timeout:45000});
  await expect.poll(async()=>Promise.all(other.frames().filter(frame=>frame.parentFrame()?.parentFrame()).map(frame=>frame.locator("h1").first().textContent({timeout:200}).catch(()=>""))),{timeout:30000}).toContain("画布");
  expect(await localDesignCount(other)).toBe(0);await other.screenshot({path:info.outputPath("empty-workbench-shared-viewer.png")});await viewer.getByRole("button",{name:"Leave",exact:true}).click();await expect(viewer).toHaveCount(0);await expect(close).toBeEnabled();await close.click();await expect(available).toHaveCount(0);await expect(panel(other,true).getByRole("tab")).toHaveCount(0);expect(await localDesignCount(other)).toBe(0);expect(errors).toEqual([]);
 }finally{await context.close();await page.close({runBeforeUnload:false});await f.close();}
});

test("a Host without design sharing does not expose the shared-design menu entry",async({page})=>{
 test.setTimeout(90000);await page.routeWebSocket("**/ws",socket=>{const upstream=socket.connectToServer();upstream.onMessage(message=>{if(typeof message==="string"){const frame=JSON.parse(message);if(frame.type==="ready"){frame.serverCapabilities=frame.serverCapabilities.filter((cap:string)=>cap!=="workbench.design.share.v1");socket.send(JSON.stringify(frame));return;}}socket.send(message);});});
 const f=await fixture();try{await connect(page,f.hub,f.conversation.title);await panel(page).getByRole("button",{name:"新建内容",exact:true}).click();await expect(panel(page).getByRole("menu").getByRole("button",{name:listName(),exact:true})).toHaveCount(0);expect(await localDesignCount(page)).toBe(0);}finally{await page.close({runBeforeUnload:false});await f.close();}
});
