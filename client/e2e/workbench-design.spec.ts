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
const exposed = (page: Page) => page.locator('.workbench-design-frame:visible').evaluateAll(frames => frames.length > 0 && frames.every(frame => {
  const rect = frame.getBoundingClientRect();
  return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === frame;
}));

test("embedded upstream design renders, Bot edit persists and editor is isolated", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message.slice(0, 180)));
  const f = await fixture(page);
  try {
    const created = await f.command({ requestId: "design_create", operation: "design.create", payload: { title: "设计验收" } });
    expect(created).toMatchObject({ status: "applied", saved: true });
    const target = { ...created.target, tabId: (created.result as { tabId: string }).tabId };
    const editor = page.frameLocator(".workbench-design-frame");
    await expect(editor.getByText("设计验收", { exact: true }).first()).toBeVisible({ timeout: 20000 });
    await expect(panel(page).getByRole("button", { name: "共享", exact: true })).toHaveCount(0);
    await expect(panel(page).getByText("本机保存 · 当前对话", { exact: true })).toHaveCount(0);
    const read = await f.command({ requestId: "design_read", operation: "design.read", target, payload: { path: "project/Main.dc.html" } });
    expect(read.status).toBe("success");
    const content = (read.result as { content: string }).content;
    const publish = await f.command({ requestId: "design_publish", operation: "design.publish", target, expectedRevision: read.revision, payload: { files: { "project/Main.dc.html": { content: content.replace("设计验收", "TaroBird Design"), contentType: "text/html" } } } });
    expect(publish).toMatchObject({ status: "applied", saved: true });
    const titles = async () => Promise.all(page.frames().filter(frame => frame.parentFrame()?.parentFrame() === page.mainFrame()).map(frame => frame.locator("h1").textContent({ timeout: 300 }).catch(() => "")));
    await expect.poll(titles, { timeout: 15000 }).toContain("TaroBird Design");
    await expect.poll(() => exposed(page)).toBe(true);
    const guest = page.frames().find(frame => frame.parentFrame() === page.mainFrame())!;
    expect(await guest.evaluate(() => { try { return parent.document.title; } catch { return "isolated"; } })).toBe("isolated");
    await page.screenshot({ path: info.outputPath("design-desktop.png") });
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, f.conversation.title); await page.getByRole("button", { name: "工作台", exact: true }).click();
    await expect.poll(titles, { timeout: 15000 }).toContain("TaroBird Design");
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('manual editing flushes on close, reopens, exports and imports an independent copy', async ({page}, info) => {
  const f=await fixture(page);
  try {
    await panel(page).getByRole('button',{name:'新建内容',exact:true}).click();
    await panel(page).getByRole('menu').getByRole('button',{name:'画布',exact:true}).click();
    const titles=()=>Promise.all(page.frames().filter(frame=>frame.parentFrame()?.parentFrame()===page.mainFrame()).map(frame=>frame.locator('h1').textContent({timeout:300}).catch(()=>'')));
    await expect.poll(titles,{timeout:20000}).toContain('画布');
    const artboard=page.frames().find(frame=>frame.parentFrame()?.parentFrame()===page.mainFrame())!;
    await artboard.locator('h1').dblclick();
    await page.keyboard.press('Meta+A');await page.keyboard.type('Human edit');await page.keyboard.press('Escape');
    // Close immediately, before the upstream debounce interval. Closing is not deletion.
    await panel(page).getByRole('tab',{name:'画布',exact:true}).click({button:'right'});
    await page.getByRole('menu',{name:'标签选项',exact:true}).getByRole('button',{name:'关闭标签',exact:true}).click();
    await expect(page.locator('.workbench-design-frame')).toHaveCount(0,{timeout:15000});
    await panel(page).getByRole('button',{name:'全部标签和已关闭内容',exact:true}).click();
    await panel(page).locator('.workbench-closed-row').getByRole('button',{name:'画布',exact:true}).click();
    await expect.poll(titles,{timeout:20000}).toContain('Human edit');
    const download=page.waitForEvent('download');await panel(page).getByRole('button',{name:'导出设计',exact:true}).click();const exported=await download;
    const bytes=await readFile((await exported.path())!);const project=JSON.parse(bytes.toString());
    // V2 preserves optional comments/history; legacy V1 import stays covered
    // by workbench-design-backup.test.ts.
    expect(project).toMatchObject({format:'tarobot-design',version:2});expect(project.document.revision).toBeGreaterThan(0);
    await panel(page).locator('input[accept=".tarobot-design.json"]').setInputFiles({name:'copy.tarobot-design.json',mimeType:'application/json',buffer:bytes});
    await expect(panel(page).getByRole('tab',{name:'画布',exact:true})).toHaveCount(2);
    await expect.poll(titles,{timeout:20000}).toContain('Human edit');
    await page.screenshot({path:info.outputPath('design-manual.png')});
    await panel(page).getByRole('tab',{name:'画布',exact:true}).last().click({button:'right'});
    await page.getByRole('menu',{name:'标签选项',exact:true}).getByRole('button',{name:'删除这个设计',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'删除设计',exact:true}).click();
    await expect(panel(page).getByRole('tab',{name:'画布',exact:true})).toHaveCount(1);
    await panel(page).getByRole('tab',{name:'画布',exact:true}).click();
    await expect.poll(titles,{timeout:20000}).toContain('Human edit');

  } finally {await f.close();}
});

test('phone width keeps Design actions accessible and yields to App menus', async ({page},info)=>{
  await page.setViewportSize({width:390,height:844});const f=await fixture(page);
  try {
    const create=await f.command({requestId:'phone-design',operation:'design.create',payload:{title:'手机设计'}});expect(create.status).toBe('applied');
    await expect(page.frameLocator('.workbench-design-frame').getByText('手机设计',{exact:true}).first()).toBeVisible({timeout:20000});
    const canvas=page.frameLocator('.workbench-design-frame').frameLocator('iframe').locator('h1');
    await expect(canvas).toHaveText('手机设计',{timeout:20000});await expect(canvas).toBeVisible();
    // DOM visibility alone misses a body portal hidden behind the phone panel.
    await expect.poll(() => exposed(page)).toBe(true);
    await expect(panel(page).getByRole('button',{name:'导出设计',exact:true})).toBeInViewport();
    await expect(panel(page).getByRole('button',{name:'共享',exact:true})).toHaveCount(0);
    await expect(panel(page).getByText('本机保存 · 当前对话',{exact:true})).toHaveCount(0);
    await panel(page).getByRole('button',{name:'新建内容',exact:true}).click();
    await expect(page.locator('.workbench-design-frame')).not.toBeVisible();
    await expect(panel(page).getByRole('menu').getByRole('button',{name:'画布',exact:true})).toBeInViewport();
    await page.keyboard.press('Escape');await expect(page.locator('.workbench-design-frame')).toBeVisible();
    await expect.poll(() => exposed(page)).toBe(true);
    await expect(canvas).toBeVisible();
    await page.screenshot({path:info.outputPath('design-phone.png')});
  } finally {await f.close();}
});


test('split designs keep their own revisions and user focus selects the exact Bot target', async ({page},info)=>{
  test.setTimeout(90000);
  const f=await fixture(page);
  try {
    const a=await f.command({requestId:'split-a',operation:'design.create',payload:{title:'海报 A'}});
    const aId=(a.result as {tabId:string}).tabId;
    const b=await f.command({requestId:'split-b',operation:'design.create',payload:{title:'海报 B'}});
    const bTarget={...b.target,tabId:(b.result as {tabId:string}).tabId};
    await panel(page).getByRole('button',{name:'分屏',exact:true}).click();
    const picker=page.getByRole('dialog',{name:'选择分屏标签',exact:true});
    await picker.getByRole('checkbox',{name:'海报 A',exact:true}).check();await picker.getByRole('checkbox',{name:'海报 B',exact:true}).check();
    await picker.getByRole('button',{name:'应用分屏',exact:true}).click();
    await expect(page.locator('.workbench-design-frame:visible')).toHaveCount(2);
    const artboards=()=>page.frames().filter(frame=>frame.parentFrame()?.parentFrame()===page.mainFrame());
    await expect.poll(()=>Promise.all(artboards().map(frame=>frame.locator('h1').textContent({timeout:300}).catch(()=>''))),{timeout:20000}).toEqual(expect.arrayContaining(['海报 A','海报 B']));
    await expect.poll(() => exposed(page)).toBe(true);
    let first;for(const frame of artboards())if(await frame.locator('h1').textContent().catch(()=>'' )==='海报 A')first=frame;
    await first!.locator('h1').click();await expect.poll(async()=>(await f.targets())[0].activeTabId).toBe(aId);
    const read=await f.command({requestId:'split-read',operation:'design.read',target:{...a.target,tabId:aId},payload:{path:'project/Main.dc.html'}});
    expect(read.target?.tabId).toBe(aId);expect((read.result as {content:string}).content).toContain('海报 A');
    const originalB=await f.command({requestId:'split-b-read',operation:'design.read',target:bTarget,payload:{path:'project/Main.dc.html'}});
    expect(originalB.revision).toBe(0);expect((originalB.result as {content:string}).content).toContain('海报 B');
    await page.screenshot({path:info.outputPath('design-split.png')});
    await panel(page).getByRole('button',{name:'合并分屏',exact:true}).click();await expect(page.locator('.workbench-design-frame:visible')).toHaveCount(1);await expect(panel(page).getByRole('tab')).toHaveCount(2);
  }finally{await f.close();}
});


test("Bot adds nine Unicode artboards to an existing Design", async ({ page }, info) => {
  test.setTimeout(90000);
  const f = await fixture(page);
  try {
    const created = await f.command({requestId: "nine-create", operation: "design.create", payload: {title: "Blank"}});
    const target = {...created.target, tabId: (created.result as {tabId:string}).tabId};
    const titles = () => Promise.all(page.frames().filter(frame => frame.parentFrame()?.parentFrame() === page.mainFrame()).map(frame => frame.locator("h1").textContent({timeout:300}).catch(() => "")));
    await expect.poll(titles, {timeout:20000}).toContain("Blank");
    const read = await f.command({requestId:"nine-read", operation:"design.read",target,payload:{path:"project/Main.dc.html"}});
    const meta = await f.command({requestId:"nine-meta", operation:"design.read",target,payload:{path:"project/canvas.json"}});
    const canvas = JSON.parse((meta.result as {content:string}).content);
    const files: Record<string, {content:string;contentType:string}> = {};
    for(let i=1;i<=9;i++) {
      const name = `0${i} 页面 (副本)+e\u0301.dc.html`;
      canvas.boards[name] = {x:((i-1)%3)*2040,y:Math.floor((i-1)/3)*1200,w:1920,h:1080,title:`页面 ${i}`};
      canvas.order.push(name);
      files[`project/${name}`] = {content:(read.result as {content:string}).content.replaceAll("Blank",`SLIDE ${i}`),contentType:"text/html"};
    }
    files["project/canvas.json"]={content:JSON.stringify(canvas),contentType:"application/json"};
    const publish=await f.command({requestId:"nine-publish",operation:"design.publish",target,expectedRevision:meta.revision,payload:{files}});
    expect(publish).toMatchObject({status:"applied",saved:true});
    const expected = Array.from({length:9}, (_, i) => `SLIDE ${i+1}`);
    await expect.poll(titles,{timeout:20000}).toEqual(expect.arrayContaining(["Blank", ...expected]));
    const after = await f.command({requestId:"nine-after",operation:"design.read",target,payload:{path:"project/canvas.json"}});
    expect(JSON.parse((after.result as {content:string}).content)).toEqual(canvas);
    await page.screenshot({path:info.outputPath("nine-artboards.png")});
    // Reopen the saved project: no file rename, republish or destructive migration.
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, f.conversation.title);
    await page.getByRole("button",{name:"工作台",exact:true}).click();
    await expect.poll(titles,{timeout:20000}).toEqual(expect.arrayContaining(["Blank", ...expected]));
  } finally {await page.screenshot({path:info.outputPath("nine-final.png")}); await f.close();}
});
