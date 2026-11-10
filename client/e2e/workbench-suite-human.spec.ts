import { workbenchContentTargets } from "./fixtures/workbench-targets.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import type { WorkbenchBroker } from "../../src/hub/workbench.js";
import type { WorkbenchRequest } from "../../src/client-protocol/workbench.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

import { openSettings, closeSettings } from "./fixtures/settings.js";

test.use({ serviceWorkers: "block" });
async function fixture(page: Page) {
  page.on("pageerror",error=>console.log("HUMAN_PAGEERROR",error.message.slice(0,600)));
  page.on("console",message=>{if(message.type()==="error")console.log("HUMAN_CONSOLE",message.text().slice(0,400));});
  if(process.env.BAOYU_DIAG) {
    page.on("console",m=>{if(m.text().startsWith("SUITE_BRIDGE"))console.log(m.text());});
    await page.addInitScript(()=>{
      const post=MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage=function(data,...rest:any[]){
        if(data?.operation==="db.write" || data?.result?.status>=400 || data?.error) console.log("SUITE_BRIDGE",JSON.stringify({at:performance.now(),id:data?.id,operation:data?.operation,writeOp:data?.payload?.op,path:data?.payload?.path,status:data?.result?.status,error:data?.error,code:data?.result?.body?.code,message:data?.result?.body?.message}));
        return (post as any).call(this,data,...rest);
      };
      addEventListener("beforeunload",e=>queueMicrotask(()=>console.log("SUITE_BRIDGE",JSON.stringify({at:performance.now(),beforeunload:true,canceled:e.defaultPrevented,returned:e.returnValue}))));
    });
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-design-"));
  const hub = await HubServer.start({ stateDir: directory, clientDir: process.env.BAOYU_HUMAN_CLIENT_DIR ?? fileURLToPath(new URL("../dist", import.meta.url)) });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','设计助手','fixture')");
  const conversation = await hub.store.createConversation("owner", ["alpha"], "设计验收", "design_chat");
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner"); await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, conversation.title);
  const broker = (hub as unknown as { workbench: WorkbenchBroker }).workbench, actor = { userId: "owner", conversationId: conversation.id, validate: async () => undefined };
  await page.getByRole("button", { name: "工作台", exact: true }).click(); await expect(panel(page)).toBeVisible();
  await expect.poll(async () => (await workbenchContentTargets(broker, actor)).length).toBe(1);
  return { hub, conversation, targets: () => workbenchContentTargets(broker, actor), command: (request: WorkbenchRequest) => broker.request(actor, request), close: async () => { await page.close({ runBeforeUnload: false }); await hub.close(); await rm(directory, { recursive: true, force: true }); } };
}
const panel = (page: Page) => page.getByRole("complementary", { name: "工作台", exact: true });


// The interaction paths below use the actual opaque upstream editor and a real
// disposable Hub, with Chinese/English payloads. They do not invoke a model.
test.describe("production offline cache",()=>{
 test.use({serviceWorkers:"allow"});
 test("bilingual canvas offline edit survives close, reconnect, backup and language switch", async ({page},info)=>{
 test.setTimeout(150000);const f=await fixture(page);
 try {
  const title="中文画布 English";
  const made=await f.command({requestId:"human-canvas",operation:"design.create",payload:{title}});
  let target={...made.target,tabId:(made.result as {tabId:string}).tabId};
  const titles=()=>Promise.all(page.frames().filter(frame=>frame.parentFrame()?.parentFrame()===page.mainFrame()).map(frame=>frame.locator("h1").textContent({timeout:300}).catch(()=>"")));
  await expect.poll(titles,{timeout:45000}).toContain(title);
  await page.evaluate(()=>navigator.serviceWorker.ready);
  await expect.poll(()=>page.evaluate(()=>!!navigator.serviceWorker.controller),{timeout:20000}).toBe(true);
  await expect.poll(()=>page.evaluate(async()=>!!(await caches.match(new URL("/design-loader.html",location.href).href))),{timeout:20000}).toBe(true);
  // Exercise a controlled online reload before cutting transport. This proves
  // the app shell and Workbench lazy resources are cached for a fresh document.
  await page.reload();await waitForClientOnline(page);await selectConversation(page,f.conversation.title);await page.getByRole("button",{name:"工作台",exact:true}).click();
  await expect.poll(titles,{timeout:45000}).toContain(title);
  await expect.poll(()=>page.evaluate(async()=>{const urls=performance.getEntriesByType("resource").map(e=>e.name).filter(url=>url.startsWith(location.origin+"/assets/")||url.endsWith("/design-sandbox.html"));return (await Promise.all(urls.map(async url=>(await caches.match(url,{ignoreVary:true}))?null:new URL(url).pathname))).filter(Boolean)}),{timeout:20000}).toEqual([]);
  const active=(await f.targets())[0];target={deviceId:active.deviceId,windowId:active.windowId,tabId:target.tabId};
  await page.context().setOffline(true);
  for(const peer of (f.hub as unknown as {clients:Set<{ws:{terminate():void}}>}).clients)peer.ws.terminate();
  await expect.poll(()=>page.evaluate(()=>navigator.onLine)).toBe(false);await expect.poll(async()=>(await f.targets()).length).toBe(0);
  const artboard=page.frames().find(frame=>frame.parentFrame()?.parentFrame()===page.mainFrame())!;
  await artboard.locator("h1").dblclick();await page.keyboard.press("Meta+A");await page.keyboard.insertText("你好 café English e\u0301 🌿");await page.keyboard.press("Escape");
  await panel(page).getByRole("tab",{name:title,exact:true}).click({button:"right"});
  await page.getByRole("menu",{name:"标签选项",exact:true}).getByRole("button",{name:"关闭标签",exact:true}).click();
  await expect(page.locator(".workbench-design-frame")).toHaveCount(0,{timeout:15000});
  await panel(page).getByRole("button",{name:"全部标签和已关闭内容",exact:true}).click();
  await panel(page).locator(".workbench-closed-row").getByRole("button",{name:title,exact:true}).click();
  await expect.poll(titles,{timeout:45000}).toContain("你好 café English e\u0301 🌿");
  await page.reload();
  await selectConversation(page,f.conversation.title);await page.getByRole("button",{name:"工作台",exact:true}).click();
  await expect.poll(titles,{timeout:45000}).toContain("你好 café English e\u0301 🌿");
  await page.context().setOffline(false);await waitForClientOnline(page);await expect.poll(async()=>(await f.targets()).length).toBe(1);
  const reconnected=(await f.targets())[0];target={deviceId:reconnected.deviceId,windowId:reconnected.windowId,tabId:target.tabId};
  const downloaded=page.waitForEvent("download");await panel(page).getByRole("button",{name:/^(导出设计|备份 PPT 项目)$/,exact:true}).click();const exportFile=await downloaded;
  const bytes=await readFile((await exportFile.path())!);const backup=JSON.parse(bytes.toString());expect(backup).toMatchObject({format:"tarobot-design",version:2});
  await panel(page).locator('input[accept=".tarobot-design.json"]').setInputFiles({name:"中文 copy.tarobot-design.json",mimeType:"application/json",buffer:bytes});
  await expect(panel(page).getByRole("tab",{name:title,exact:true})).toHaveCount(2);
  await expect.poll(titles,{timeout:45000}).toContain("你好 café English e\u0301 🌿");
  const after=(await f.targets())[0];expect(after.tabs.filter(t=>t.title===title).map(t=>t.id)).toHaveLength(2);
  // The imported copy has a distinct document identity and cannot rewrite the source.
  const original=await f.command({requestId:"human-canvas-original",operation:"design.read",target,payload:{path:"project/Main.dc.html"}});
  expect(original.status).toBe("success");expect((original.result as {content:string}).content).toContain("你好 café English e\u0301 🌿");
  await openSettings(page,"general");await page.locator("#language").selectOption("en");await closeSettings(page,true);
  await expect(page.locator("html")).toHaveAttribute("lang","en");
  await expect(page.getByRole("complementary",{name:"Workbench",exact:true}).getByRole("tab",{name:title,exact:true})).toHaveCount(2);
  await page.reload();await waitForClientOnline(page);await selectConversation(page,f.conversation.title);await page.getByRole("button",{name:"Workbench",exact:true}).click();
  await expect.poll(titles,{timeout:45000}).toContain("你好 café English e\u0301 🌿");
  await page.screenshot({path:info.outputPath("bilingual-canvas.png")});
 }catch(error){console.log("OFFLINE_FINAL",JSON.stringify({body:(await page.locator("body").innerText().catch(()=>"unavailable")).slice(0,6000),frames:page.frames().map(frame=>frame.url().slice(0,100))}));await page.screenshot({path:info.outputPath("offline-final.png")}).catch(()=>undefined);throw error;}finally{await f.close();}
});
 test("PPT offline typing survives immediate close and reopens before reconnect",async({page},info)=>{
  test.setTimeout(120000);const f=await fixture(page);
  try {
   const title="离线 PPT Offline",text="断网仍可编辑 — Offline café 🌱";
   const made=await f.command({requestId:"ppt-offline",operation:"design.create",payload:{title,format:"slides"}});
   const target={...made.target,tabId:(made.result as {tabId:string}).tabId};const editor=page.frameLocator(".workbench-design-frame:visible");
   await expect(editor.getByText(title,{exact:true}).first()).toBeVisible({timeout:45000});
   await page.evaluate(()=>navigator.serviceWorker.ready);await expect.poll(()=>page.evaluate(()=>!!navigator.serviceWorker.controller)).toBe(true);
   await expect.poll(()=>page.evaluate(async()=>!!(await caches.match(new URL("/slides-sandbox.html",location.href).href,{ignoreVary:true})))).toBe(true);
   await page.context().setOffline(true);for(const peer of (f.hub as unknown as {clients:Set<{ws:{terminate():void}}>}).clients)peer.ws.terminate();
   await expect.poll(async()=>(await f.targets()).length).toBe(0);
   await editor.getByText(title,{exact:true}).first().dblclick();await page.keyboard.press("Meta+A");await page.keyboard.insertText(text);
   await panel(page).getByRole("tab",{name:title,exact:true}).click({button:"right"});await page.getByRole("menu",{name:"标签选项",exact:true}).getByRole("button",{name:"关闭标签",exact:true}).click();await expect(page.locator(".workbench-design-frame")).toHaveCount(0,{timeout:20000});
   await panel(page).getByRole("button",{name:"全部标签和已关闭内容",exact:true}).click();await panel(page).locator(".workbench-closed-row").getByRole("button",{name:title,exact:true}).click();
   await expect(editor.getByText(text,{exact:true}).first()).toBeVisible({timeout:45000});
   await page.context().setOffline(false);await waitForClientOnline(page);await expect.poll(async()=>(await f.targets()).length).toBe(1);
   const read=await f.command({requestId:"ppt-offline-read",operation:"design.read",target,payload:{path:"project/slides/cover.html"}});expect(read.status).toBe("success");expect((read.result as {content:string}).content).toContain(text);
   await page.screenshot({path:info.outputPath("ppt-offline-recovered.png")});
  }finally{await f.close();}
 });

});

test("bilingual PPT manual typing, close/reopen and imported backup preserve content",async({page},info)=>{
 test.setTimeout(150000);const f=await fixture(page);
 try {
  const title="季度回顾 Q4 café", edited="增长 +12% — English 中文 🌱";
  const made=await f.command({requestId:"human-slides",operation:"design.create",payload:{title,format:"slides"}});
  expect(made).toMatchObject({status:"applied",saved:true});
  const editor=page.frameLocator(".workbench-design-frame:visible");
  await expect(editor.getByText(title,{exact:true}).first()).toBeVisible({timeout:45000});
  await editor.getByText(title,{exact:true}).first().dblclick();await page.keyboard.press("Meta+A");await page.keyboard.insertText(edited);
  await panel(page).getByRole("tab",{name:title,exact:true}).click({button:"right"});
  await page.getByRole("menu",{name:"标签选项",exact:true}).getByRole("button",{name:"关闭标签",exact:true}).click();
  await expect(page.locator(".workbench-design-frame")).toHaveCount(0,{timeout:20000});
  await panel(page).getByRole("button",{name:"全部标签和已关闭内容",exact:true}).click();await panel(page).locator(".workbench-closed-row").getByRole("button",{name:title,exact:true}).click();
  await expect(editor.getByText(edited,{exact:true}).first()).toBeVisible({timeout:45000});
  const pptDownload=page.waitForEvent("download",{timeout:45000});
  await editor.getByRole("button",{name:/^Download|^下载/}).first().click();
  await editor.getByRole("menuitem",{name:/PowerPoint, basic fonts/}).click();
  const exportDialog=page.getByRole("dialog",{name:/^(导出已准备好|Export ready)$/});
  const exportOutcome=await Promise.race([pptDownload.then(()=>"downloaded"),exportDialog.waitFor({state:"visible",timeout:45000}).then(()=>"confirm")]);
  if(exportOutcome==="confirm")await exportDialog.getByRole("button",{name:/^(保存文件|Save file)$/}).click();
  const ppt=await pptDownload;expect(ppt.suggestedFilename()).toMatch(/\.pptx$/);
  const {default:AdmZip}=await import("adm-zip");const pptZip=new AdmZip(await readFile((await ppt.path())!));const slideXml=pptZip.readAsText("ppt/slides/slide1.xml");const exportedText=[...slideXml.matchAll(/<a:t>(.*?)<\/a:t>/gs)].map(match=>match[1]).join("");expect(exportedText).toContain(edited);
  console.log("PPTX_BILINGUAL",JSON.stringify({bytes:(await readFile((await ppt.path())!)).length,textPreserved:exportedText.includes(edited)}));
  const download=page.waitForEvent("download");await panel(page).getByRole("button",{name:/^(导出设计|备份 PPT 项目)$/,exact:true}).click();const saved=await download;
  const bytes=await readFile((await saved.path())!);const backup=JSON.parse(bytes.toString());expect(backup.document.format).toBe("slides");
  await panel(page).locator('input[accept=".tarobot-design.json"]').setInputFiles({name:"季度副本 English.tarobot-design.json",mimeType:"application/json",buffer:bytes});
  await expect(panel(page).getByRole("tab",{name:title,exact:true})).toHaveCount(2);await expect(editor.getByText(edited,{exact:true}).first()).toBeVisible({timeout:45000});
  await page.reload();await waitForClientOnline(page);await selectConversation(page,f.conversation.title);await page.getByRole("button",{name:"工作台",exact:true}).click();await expect(editor.getByText(edited,{exact:true}).first()).toBeVisible({timeout:45000});
  await page.screenshot({path:info.outputPath("bilingual-ppt.png")});
 }finally{await f.close();}
});


for (const language of ["zh", "en"] as const) test(`canvas and PPT user entrypoints preserve edits through menus and tab switches (${language})`, async ({page},info) => {
 test.setTimeout(120000);
 const f=await fixture(page);
 try {
  if(language==="en") {await openSettings(page,"general");await page.locator("#language").selectOption("en");await closeSettings(page,true);}
  const wb=page.getByRole("complementary",{name:language==="en"?"Workbench":"工作台",exact:true});
  const newButton=wb.getByRole("button",{name:language==="en"?"New content":"新建内容",exact:true});
  const designName=language==="en"?"Canvas":"画布";
  const times:Record<string,number>={};let phase=Date.now();
  await newButton.click();await wb.getByRole("menu").getByRole("button",{name:designName,exact:true}).click();
  const editor=page.frameLocator(".workbench-design-frame:visible");
  const heading=editor.frameLocator("iframe").locator("h1");
  await expect(heading).toHaveText(designName,{timeout:45000});times.canvasOpenMs=Date.now()-phase;
  // Guard the upstream handshake itself, not a flaky wall-clock deadline.
  const revealCount = () => page.frames().find(frame => frame.parentFrame() === page.mainFrame())!.evaluate(() => performance.getEntriesByName("design:revealed").length);
  expect(await revealCount()).toBe(1);
  const edited=`${language} 手工修改 Canvas café 🌿`;
  await heading.dblclick();await page.keyboard.press("Meta+A");await page.keyboard.insertText(edited);await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+z");await expect(heading).toHaveText(designName);await page.keyboard.press("Meta+Shift+z");await expect(heading).toHaveText(edited);
  await newButton.click();await expect(page.locator(".workbench-design-frame")).not.toBeVisible();await page.keyboard.press("Escape");await expect(heading).toBeVisible();
  phase=Date.now();await newButton.click();await wb.getByRole("menu").getByRole("button",{name:"PPT",exact:true}).click();
  await expect(editor.getByText("PPT",{exact:true}).first()).toBeVisible({timeout:45000});times.pptOpenMs=Date.now()-phase;
  phase=Date.now();await wb.getByRole("tab",{name:designName,exact:true}).click();await expect(heading).toHaveText(edited,{timeout:45000});times.canvasReturnMs=Date.now()-phase;
  expect(await revealCount()).toBe(1);
  await wb.getByRole("tab",{name:"PPT",exact:true}).click();await expect(editor.getByText("PPT",{exact:true}).first()).toBeVisible({timeout:45000});
  await expect(page.locator(".workbench-design-frame:visible")).toHaveCount(1);
  console.log("HUMAN_ENTRY_TIMING",JSON.stringify({language,...times}));
  await page.screenshot({path:info.outputPath(`entrypoints-${language}.png`)});
 }finally {await f.close();}
});
