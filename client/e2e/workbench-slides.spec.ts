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

test.use({ serviceWorkers: "block" });
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

test("PPT renders a real deck, Bot edits persist, and canvas stays separate", async ({page}, info) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const f = await fixture(page);
  try {
    const canvas = await f.command({requestId:"existing-canvas",operation:"design.create",payload:{title:"Canvas retained"}});
    expect(canvas).toMatchObject({status:"applied",saved:true});
    const created = await f.command({requestId:"slides-new",operation:"design.create",payload:{title:"Slide acceptance",format:"slides"}});
    expect(created).toMatchObject({status:"applied",saved:true});
    const target = {...created.target,tabId:(created.result as {tabId:string}).tabId};
    const editor = page.frameLocator(".workbench-design-frame:visible");
    await expect(editor.getByText("Slide acceptance",{exact:true}).first()).toBeVisible({timeout:20000});
    await expect(panel(page).getByRole("button",{name:"共享",exact:true})).toHaveCount(0);
    await expect(panel(page).getByText("本机保存 · 当前对话",{exact:true})).toHaveCount(0);
    const read = await f.command({requestId:"slides-read",operation:"design.read",target,payload:{path:"project/slides/cover.html"}});
    expect(read.status).toBe("success");
    const publish = await f.command({requestId:"slides-write",operation:"design.publish",target,expectedRevision:read.revision,payload:{files:{"project/slides/cover.html":{content:(read.result as {content:string}).content.replace("Slide acceptance","Bot edited slide"),contentType:"text/html"}}}});
    expect(publish).toMatchObject({status:"applied",saved:true});
    await expect(editor.getByText("Bot edited slide",{exact:true}).first()).toBeVisible({timeout:20000});
    await page.screenshot({path:info.outputPath("baoyu-ppt.png")});
    const guest = page.frames().find(frame => frame.parentFrame() === page.mainFrame())!;
    expect(await guest.evaluate(() => {try{return parent.document.title}catch{return "isolated"}})).toBe("isolated");
    expect(await guest.evaluate(async () => {try{await fetch("https://example.com");return "connected"}catch{return "blocked"}})).toBe("blocked");
    await page.reload();await waitForClientOnline(page);await selectConversation(page,f.conversation.title);await page.getByRole("button",{name:"工作台",exact:true}).click();
    await expect(editor.getByText("Bot edited slide",{exact:true}).first()).toBeVisible({timeout:20000});
    await panel(page).getByRole("tab",{name:"Canvas retained",exact:true}).click();
    await expect(page.frameLocator(".workbench-design-frame:visible").frameLocator("iframe").locator("h1")).toHaveText("Canvas retained",{timeout:20000});
    expect(errors).toEqual([]);
  } catch (error) {
    console.log("SLIDES_ERRORS", errors);
    console.log("SLIDES_FRAMES", await Promise.all(page.frames().map(async frame => ({url:frame.url().slice(0,100),html:await frame.locator("body").innerText().catch(()=>"missing"), state:await frame.evaluate(()=>({title:document.title,root:document.getElementById("root")?.innerHTML.slice(0,400),host:!!(window as any).slidesHost,settler:!!(window as any).__tarobotDesignSettle})).catch(()=>({}))}))));
    await page.screenshot({path: info.outputPath("slides-failure.png")});throw error;
  } finally {await f.close();}
});

test('PPT manual edit survives immediate close, exports PPTX, and renders local assets', async ({page}, info) => {
  test.setTimeout(90000);
  const f=await fixture(page);
  try {
    await panel(page).getByRole('button',{name:'新建内容',exact:true}).click();
    await panel(page).getByRole('menu').getByRole('button',{name:'PPT',exact:true}).click();
    const editor=page.frameLocator('.workbench-design-frame:visible');
    await expect(editor.getByText('PPT',{exact:true}).first()).toBeVisible({timeout:20000});
    await editor.getByText('PPT',{exact:true}).first().dblclick();
    await page.keyboard.press('Meta+A');await page.keyboard.type('Human PPT edit');
    // Deliberately close with the caret active, before the upstream debounce.
    await panel(page).getByRole('tab',{name:'PPT',exact:true}).click({button:'right'});
    await page.getByRole('menu',{name:'标签选项',exact:true}).getByRole('button',{name:'关闭标签',exact:true}).click();
    await expect(page.locator('.workbench-design-frame')).toHaveCount(0,{timeout:15000});
    await panel(page).getByRole('button',{name:'全部标签和已关闭内容',exact:true}).click();
    await panel(page).locator('.workbench-closed-row').getByRole('button',{name:'PPT',exact:true}).click();
    await expect(editor.getByText('Human PPT edit',{exact:true}).first()).toBeVisible({timeout:20000});
    const registration=(await f.targets())[0], tab=registration.tabs.find(t=>t.title==='PPT')!;
    expect(tab.designFormat).toBe('slides');
    const target={deviceId:registration.deviceId,windowId:registration.windowId,tabId:tab.id};
    const guest=page.frames().find(frame=>frame.parentFrame()===page.mainFrame())!;
    const asset=await guest.evaluate(async()=> (window as any).slidesHost.assets.upload(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#82776a"/></svg>'],{type:'image/svg+xml'})));
    const read=await f.command({requestId:'ppt-asset-read',operation:'design.read',target,payload:{path:'project/slides/cover.html'}});
    expect(read.status).toBe('success');
    const publish=await f.command({requestId:'ppt-asset-write',operation:'design.publish',target,expectedRevision:read.revision,payload:{files:{'project/slides/cover.html':{content:(read.result as {content:string}).content.replace('</section>',`<img src="${asset.url}" alt="Local picture" style="width:80px;height:80px;object-fit:contain"></section>`),contentType:'text/html'}}}});
    expect(publish).toMatchObject({status:'applied',saved:true});
    await expect(editor.getByRole('img',{name:'Local picture'}).first()).toBeVisible({timeout:20000});
    await expect.poll(()=>editor.getByRole('img',{name:'Local picture'}).first().evaluate((node:HTMLImageElement)=>node.complete&&node.naturalWidth>0)).toBe(true);
    await editor.getByRole('button',{name:/^Download|^下载/}).first().click();
    const downloaded=page.waitForEvent('download',{timeout:20000});
    await editor.getByRole('menuitem',{name:/PowerPoint, basic fonts/}).click();
    const file=await downloaded;
    expect(file.suggestedFilename()).toMatch(/\.pptx$/);
    const bytes=await readFile((await file.path())!);
    const {default:AdmZip}=await import('adm-zip');const zip=new AdmZip(bytes);
    expect(zip.getEntries().map(item=>item.entryName)).toContain('ppt/slides/slide1.xml');
    expect(zip.readAsText('ppt/slides/slide1.xml')).toContain('Human PPT edit');
    await page.screenshot({path:info.outputPath('baoyu-ppt-manual.png')});
  }catch(error){console.log('PPT_EDITOR_STATE',await page.frameLocator('.workbench-design-frame').locator('body').ariaSnapshot().catch(()=>''));throw error;}
  finally{await f.close();}
});
