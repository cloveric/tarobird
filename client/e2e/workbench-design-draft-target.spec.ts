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
  const directory = await mkdtemp(path.join(os.tmpdir(), "design-comment-draft-"));
  const hub = await HubServer.start({ stateDir: directory, clientDir: process.env.DESIGN_DRAFT_CLIENT_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)) });
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


async function storedAssociation(page:Page,conversationId:string){return page.evaluate(async(id)=>{
 for(const info of await indexedDB.databases()){
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{const open=indexedDB.open(info.name!);open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
  try{if(!db.objectStoreNames.contains("conversationDrafts"))continue;const row=await new Promise<any>((resolve,reject)=>{const request=db.transaction("conversationDrafts").objectStore("conversationDrafts").get(id);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});if(row?.workbench)return row.workbench;}finally{db.close();}
 }
},conversationId);}
async function comment(page:Page,title:string,text:string){
 const editor=page.frameLocator(".workbench-design-frame:visible");
 await expect(editor.getByRole("button",{name:"Comments",exact:true})).toBeVisible({timeout:30000});
 await editor.getByRole("button",{name:"Comments",exact:true}).click();
 const target=editor.getByRole("button",{name:"Comment on artboard "+title,exact:true});const bounds=await target.boundingBox();expect(bounds).not.toBeNull();
 await page.mouse.click(bounds!.x+bounds!.width/2,bounds!.y+bounds!.height/2);
 await editor.getByRole("textbox",{name:"Comment",exact:true}).fill(text);
 await editor.getByRole("checkbox",{name:"Send to Agent",exact:true}).check();
 await editor.getByRole("button",{name:"Send",exact:true}).click();
}
test("a second canvas comment cannot retarget an existing draft, including after reload",async({page})=>{
 test.setTimeout(150000);const f=await fixture(page);try{
  const first=await f.command({requestId:"draft-a",operation:"design.create",payload:{title:"画布 A"}});expect(first).toMatchObject({status:"applied",saved:true});
  const firstId=(first.result as {tabId:string}).tabId;
  await comment(page,"画布 A","保留 A 的说明 — keep original A");
  const field=page.getByRole("textbox",{name:"消息",exact:true});await expect(field).toHaveValue(/keep original A/);const text=await field.inputValue();
  await expect.poll(()=>storedAssociation(page,f.conversation.id)).toMatchObject({context:{target:{tabId:firstId}}});
  const original=await storedAssociation(page,f.conversation.id);
  const second=await f.command({requestId:"draft-b",operation:"design.create",payload:{title:"Canvas B"}});expect(second).toMatchObject({status:"applied",saved:true});
  const secondTarget={...second.target,tabId:(second.result as {tabId:string}).tabId};
  await comment(page,"Canvas B","B must remain separate 独立");
  await expect.poll(async()=>{const reply=await f.command({requestId:"draft-b-comments-"+Date.now(),operation:"design.comments.read",target:secondTarget,payload:{}});return (reply.result as any)?.threads?.length;}).toBe(1);
  await expect(field).toHaveValue(text);
  expect(await storedAssociation(page,f.conversation.id)).toEqual(original);
  await page.reload();await waitForClientOnline(page);await selectConversation(page,f.conversation.title);
  await expect(page.getByRole("textbox",{name:"消息",exact:true})).toHaveValue(text);
  expect(await storedAssociation(page,f.conversation.id)).toEqual(original);
 }finally{await f.close();}
});

for (const format of ["canvas","slides"] as const) test(`an actual message ACK marks its frozen ${format} comment delivered`,async({page},info)=>{
 test.setTimeout(150000);const f=await fixture(page);try{
  const created=await f.command({requestId:"delivery-"+format,operation:"design.create",payload:{title:"送达验证",format}});expect(created).toMatchObject({status:"applied",saved:true});
  const target={...created.target,tabId:(created.result as {tabId:string}).tabId};
  if(format==="canvas")await comment(page,"送达验证","请改善说明 — verified delivery");
  else {
   const editor=page.frameLocator(".workbench-design-frame:visible"),heading=editor.getByText("送达验证",{exact:true}).first();await expect(heading).toBeVisible({timeout:45000});
   await editor.getByRole("button",{name:"Comments",exact:true}).click();const bounds=await heading.boundingBox();expect(bounds).not.toBeNull();await page.mouse.click(bounds!.x+bounds!.width/2,bounds!.y+bounds!.height/2);
   await editor.getByRole("textbox",{name:"Comment",exact:true}).fill("请改善说明 — verified delivery");await editor.getByRole("checkbox",{name:"Send to Agent",exact:true}).check();await editor.getByRole("button",{name:"Send",exact:true}).click();
  }
  const field=page.getByRole("textbox",{name:"消息",exact:true});await expect(field).toHaveValue(/verified delivery/);
  await expect.poll(()=>storedAssociation(page,f.conversation.id)).toMatchObject({designCommentVersions:expect.any(Object)});
  await page.getByRole("button",{name:"发送消息",exact:true}).click();await expect(field).toHaveValue("");
  await expect.poll(async()=>{const reply=await f.command({requestId:"delivery-read-"+Date.now(),operation:"design.comments.read",target,payload:{}});return (reply.result as any)?.threads?.[0]?.agent;}).toMatchObject({status:"delivered",messageId:expect.any(String)});
  const reply=await f.command({requestId:"delivery-final",operation:"design.comments.read",target,payload:{}}),agent=(reply.result as any).threads[0].agent;
  const message=await f.hub.store.db.get<{id:string}>("SELECT id FROM messages WHERE author_type='user' AND conversation_id=?",[f.conversation.id]);expect(agent.messageId).toBe(message?.id);
  const editor=page.frameLocator(".workbench-design-frame:visible");
  await expect(editor.getByText("Sent to Bot",{exact:true})).toBeVisible();
  await expect(editor.locator('[data-working="working"]')).toHaveCount(0);
  await page.screenshot({path:info.outputPath(`${format}-sent-to-bot.png`)});
 }finally{await f.close();}
});
