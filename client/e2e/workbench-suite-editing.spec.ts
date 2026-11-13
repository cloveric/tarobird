import { workbenchContentTargets } from "./fixtures/workbench-targets.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import type { WorkbenchBroker } from "../../src/hub/workbench.js";
import type { WorkbenchRequest } from "../../src/client-protocol/workbench.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

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

test("canvas comments bind a Unicode page and create a durable exact-design chat draft",async({page},info)=>{
 test.setTimeout(90000);const f=await fixture(page);try{
 const fileName="中文 页面 (第一版)+é.dc.html";
 const created=await f.command({requestId:"comment-create",operation:"design.create",payload:{title:"Commented design"}});const target={...created.target,tabId:(created.result as {tabId:string}).tabId};const editor=page.frameLocator(".workbench-design-frame:visible");
 const first=await f.command({requestId:"comment-file",operation:"design.read",target,payload:{path:"project/Main.dc.html"}});
 const index=await f.command({requestId:"comment-index",operation:"design.read",target,payload:{path:"project/canvas.json"}});const canvas=JSON.parse((index.result as {content:string}).content);
 canvas.boards[fileName]=canvas.boards["Main.dc.html"];delete canvas.boards["Main.dc.html"];canvas.order=canvas.order.map((file:string)=>file==="Main.dc.html"?fileName:file);
 expect(await f.command({requestId:"comment-unicode",operation:"design.publish",target,expectedRevision:index.revision,payload:{files:{"project/canvas.json":{content:JSON.stringify(canvas),contentType:"application/json"},["project/"+fileName]:{content:(first.result as {content:string}).content,contentType:"text/html"},"project/Main.dc.html":null}}})).toMatchObject({status:"applied",saved:true});
 await expect(editor.locator("#root")).not.toBeEmpty({timeout:40000});
 await expect(editor.getByRole("button",{name:"Comments",exact:true})).toBeVisible({timeout:25000});await editor.getByRole("button",{name:"Comments",exact:true}).click();const commentTarget=editor.getByRole("button",{name:"Comment on artboard Commented design",exact:true});const bounds=await commentTarget.boundingBox();expect(bounds).not.toBeNull();await page.mouse.click(bounds!.x+bounds!.width/2,bounds!.y+bounds!.height/2);await expect(editor.getByRole("textbox",{name:"Comment",exact:true})).toBeVisible();
 const note="请把标题变大 — Keep the English subtitle 🌿";
 await editor.getByRole("textbox",{name:"Comment",exact:true}).fill(note);await editor.getByRole("checkbox",{name:"Send to Agent",exact:true}).check();await editor.getByRole("button",{name:"Send",exact:true}).click();
 await expect(page.getByRole("textbox",{name:"消息",exact:true})).toHaveValue(new RegExp("Keep the English subtitle"),{timeout:15000});
 await expect(page.getByText("设计请求已加入草稿；修改回到原设计项目。",{exact:true})).toBeVisible();
 const comments=await f.command({requestId:"comments-read",operation:"design.comments.read",target,payload:{}});expect(comments.status).toBe("success");console.log("COMMENT_READ",JSON.stringify(comments.result));expect((comments.result as {threads:{file:string}[]}).threads[0].file).toBe("project/"+fileName);
 const draft=await page.getByRole("textbox",{name:"消息",exact:true}).inputValue();expect(draft).toContain(note);expect(draft).toContain("project/"+fileName);
 const messages=await f.hub.store.db.get<{n:number}>("SELECT count(*) AS n FROM messages WHERE conversation_id=?",[f.conversation.id]);expect(messages?.n).toBe(0);
 await page.reload();await waitForClientOnline(page);await selectConversation(page,f.conversation.title);await expect(page.getByRole("textbox",{name:"消息",exact:true})).toHaveValue(draft);
 await expect(page.getByText("设计请求已加入草稿；修改回到原设计项目。",{exact:true})).toBeVisible();
 await page.screenshot({path:info.outputPath("comments-draft.png")});
 }finally{await f.close();}
});

for (const format of ["canvas","slides"] as const) test(`history UI restores an old ${format} as a new saved version`,async({page},info)=>{
 test.setTimeout(120000);const f=await fixture(page);const documentPath=format==="slides"?"project/slides/cover.html":"project/Main.dc.html";try{
 const created=await f.command({requestId:"history-create",operation:"design.create",payload:{title:"History original",format}});const target={...created.target,tabId:(created.result as {tabId:string}).tabId};
 const editor=page.frameLocator(".workbench-design-frame:visible");await expect(editor.locator("#root")).not.toBeEmpty({timeout:40000});
 const before=await f.command({requestId:"history-read",operation:"design.read",target,payload:{path:documentPath}});expect(before.status).toBe("success");
 const changed=await f.command({requestId:"history-change",operation:"design.publish",target,expectedRevision:before.revision,payload:{files:{[documentPath]:{content:(before.result as {content:string}).content.replace("History original","History revised"),contentType:"text/html"}}}});expect(changed).toMatchObject({status:"applied",saved:true});
 const newest=await f.command({requestId:"history-change-2",operation:"design.publish",target,expectedRevision:changed.revision,payload:{files:{[documentPath]:{content:(before.result as {content:string}).content.replace("History original","History newest"),contentType:"text/html"}}}});expect(newest).toMatchObject({status:"applied",saved:true});
 const history=await f.command({requestId:"history-list",operation:"design.history.list",target,payload:{}});expect(history.status).toBe("success");const rows=(history.result as {rows:{n:number,revision:number,initial?:boolean,current?:boolean}[]}).rows;expect(rows.length).toBeGreaterThan(2);const original=rows.find(row=>row.revision===changed.revision)!;expect(original).toBeDefined();const baseline=rows.find(row=>row.initial)!;expect(baseline).toBeDefined();
 await panel(page).getByRole("button",{name:"历史",exact:true}).click();const dialog=page.getByRole("dialog",{name:"版本历史",exact:true});await expect(dialog).toBeVisible();
 await dialog.locator("ol > li").filter({hasText:`#${original.n} ·`}).getByRole("button",{name:"恢复整版",exact:true}).click();await dialog.getByRole("alertdialog",{name:"确认恢复",exact:true}).getByRole("button",{name:"恢复",exact:true}).click();
 await expect(dialog.getByRole("alertdialog")).toHaveCount(0,{timeout:25000});await dialog.getByRole("button",{name:"关闭",exact:true}).click();
 const restored=await f.command({requestId:"history-restored",operation:"design.read",target,payload:{path:documentPath}});expect(restored.status).toBe("success");expect(restored.revision).toBeGreaterThan(newest.revision!);expect((restored.result as {content:string}).content).toContain("History revised");
 await panel(page).getByRole("button",{name:"历史",exact:true}).click();
 await dialog.locator("ol > li").filter({hasText:`#${baseline.n} ·`}).getByRole("button",{name:"恢复整版",exact:true}).click();await dialog.getByRole("alertdialog",{name:"确认恢复",exact:true}).getByRole("button",{name:"恢复",exact:true}).click();
 await expect(dialog.getByRole("alertdialog")).toHaveCount(0,{timeout:25000});await dialog.getByRole("button",{name:"关闭",exact:true}).click();
 const initial=await f.command({requestId:"history-baseline-restored",operation:"design.read",target,payload:{path:documentPath}});expect(initial.status).toBe("success");expect(initial.revision).toBeGreaterThan(restored.revision!);expect((initial.result as {content:string}).content).toContain("History original");
 await page.screenshot({path:info.outputPath("history-restored.png")});
 }finally{await f.close();}
});

test("PPT comments create a durable exact-slide chat draft",async({page},info)=>{
 test.setTimeout(90000);const f=await fixture(page);
 try {
  const title="评审 Review deck",note="请强调增长数据 — Keep the English figures 🌱";
  const made=await f.command({requestId:"ppt-comment",operation:"design.create",payload:{title,format:"slides"}});
  expect(made).toMatchObject({status:"applied",saved:true});
  const target={...made.target,tabId:(made.result as {tabId:string}).tabId};const editor=page.frameLocator(".workbench-design-frame:visible");
  const heading=editor.getByText(title,{exact:true}).first();await expect(heading).toBeVisible({timeout:45000});
  await editor.getByRole("button",{name:"Comments",exact:true}).click();
  const bounds=await heading.boundingBox();expect(bounds).not.toBeNull();await page.mouse.click(bounds!.x+bounds!.width/2,bounds!.y+bounds!.height/2);
  await expect(editor.getByRole("textbox",{name:"Comment",exact:true})).toBeVisible();
  await editor.getByRole("textbox",{name:"Comment",exact:true}).fill(note);await editor.getByRole("checkbox",{name:"Send to Agent",exact:true}).check();await editor.getByRole("button",{name:"Send",exact:true}).click();
  const composer=page.getByRole("textbox",{name:"消息",exact:true});await expect(composer).toHaveValue(/Keep the English figures/,{timeout:15000});
  const draft=await composer.inputValue();expect(draft).toContain(note);expect(draft).toContain("project/slides/cover.html");
  const comments=await f.command({requestId:"ppt-comment-read",operation:"design.comments.read",target,payload:{}});expect(comments.status).toBe("success");expect((comments.result as {threads:{file:string}[]}).threads[0].file).toBe("project/slides/cover.html");
  expect((await f.hub.store.db.get<{n:number}>("SELECT count(*) AS n FROM messages WHERE conversation_id=?",[f.conversation.id]))?.n).toBe(0);
  await page.reload();await waitForClientOnline(page);await selectConversation(page,f.conversation.title);await expect(composer).toHaveValue(draft);
  await page.screenshot({path:info.outputPath("ppt-comment-draft.png")});
 }finally {await f.close();}
});
