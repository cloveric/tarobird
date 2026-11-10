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

// Use the selected project engine; the WebKit configuration covers this journey
// on an isolated runner, without silently launching WebKit in Chromium runs.
test.use({ serviceWorkers: "block", viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true });
async function fixture(page: Page) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-design-"));
  const hub = await HubServer.start({ stateDir: directory, clientDir: fileURLToPath(new URL("../dist", import.meta.url)) });
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

test('Baoyu PPT keeps a nine-slide deck ordered across edits and reopen on a phone-sized viewport',async({page},info)=>{
  test.setTimeout(90000);const f=await fixture(page);
  try {
    const created=await f.command({requestId:'nine-slides',operation:'design.create',payload:{title:'Baoyu PPT 多页验收',format:'slides'}});
    expect(created).toMatchObject({status:'applied',saved:true});
    const target={...created.target,tabId:(created.result as {tabId:string}).tabId};
    const read=await f.command({requestId:'deck-index',operation:'design.read',target,payload:{path:'project/deck.json'}});
    const index=JSON.parse((read.result as {content:string}).content),files:Record<string,{content:string;contentType:'text/html'|'application/json'}|null>={};
    index.order=Array.from({length:9},(_,i)=>`slide${i+1}`);index.cover='slide1';
    files['project/deck.json']={content:JSON.stringify(index),contentType:'application/json'};files['project/slides/cover.html']=null;
    for(let i=1;i<=9;i++)files[`project/slides/slide${i}.html`]={content:`<section id="slide${i}" style="background:#fff;padding:100px"><h1 style="font-size:90px">第 ${i} 页</h1></section>`,contentType:'text/html'};
    expect(await f.command({requestId:'deck-nine-write',operation:'design.publish',target,expectedRevision:read.revision,payload:{files}})).toMatchObject({status:'applied',saved:true});
    const editor=page.frameLocator('.workbench-design-frame:visible');
    await expect(editor.getByRole('heading',{name:'第 1 页',exact:true})).toBeVisible({timeout:20000});
    for(let i=2;i<=9;i++){await editor.getByRole('button',{name:'Next slide',exact:true}).click();await expect(editor.getByRole('heading',{name:`第 ${i} 页`,exact:true})).toBeVisible();}
    await expect(editor.getByRole('button',{name:'Next slide',exact:true})).toBeDisabled();
    await page.screenshot({path:info.outputPath('baoyu-ppt-phone.png')});
    await page.reload();await waitForClientOnline(page);await selectConversation(page,f.conversation.title);await page.getByRole('button',{name:'工作台',exact:true}).click();
    await expect(editor.getByRole('heading',{name:'第 1 页',exact:true})).toBeVisible({timeout:20000});
    const restored=await f.command({requestId:'deck-readback',operation:'design.read',target:{deviceId:(await f.targets())[0].deviceId,windowId:(await f.targets())[0].windowId,tabId:target.tabId},payload:{path:'project/deck.json'}});
    expect(JSON.parse((restored.result as {content:string}).content).order).toEqual(index.order);
  }finally{await f.close();}
});
