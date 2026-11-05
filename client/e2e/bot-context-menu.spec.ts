import { setListOption } from "./fixtures/mobile.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";

test.use({ serviceWorkers: "block" });
const workspace = (page: Page) => page.locator(".host-workspace:not([hidden])");
async function pair(page: Page, hub: HubServer, name: string, add = false) {
  await hub.profile.update({ name, revision: (await hub.profile.read()).revision });
  if (add) await clickAppAction(page,"连接另一台主机",workspace(page).getByRole("button",{name:"连接另一台主机",exact:true})); else await page.goto(hub.url);
  await page.getByLabel("主机名称",{exact:true}).fill(name);await page.getByLabel("Hub 地址",{exact:true}).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole("button",{name:"配对此设备",exact:true}).click();
  await hub.auth.approve(await page.getByLabel("配对码",{exact:true}).innerText(),"local-owner");
  await page.getByLabel("配对码",{exact:true}).waitFor({state:"hidden"});await expect(workspace(page).locator(".connection-pill.online")).toBeVisible();
}
async function seed(hub: HubServer, root: string, name: string) {
  const stateDir=path.join(root,"bot");await mkdir(stateDir,{recursive:true});await mkdir(path.join(stateDir,"workspace"));
  await writeFile(path.join(stateDir,"config.json"),JSON.stringify({engine:"codex",model:"gpt-5.5",effort:"high",locale:"zh",workspacePath:path.join(stateDir,"workspace")}));
  await writeFile(path.join(stateDir,"session.json"),JSON.stringify({chats:[]}));
  const secret=randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha',?,?)",[name,hashSecret(secret)]);
  return attachGateway({stateDir,botId:"alpha",secret,url:hub.instanceUrl.replace("http","ws")+"/instance",engine:"codex",model:"gpt-5.5",effort:"high",runtime:createCoreServiceRuntime(),bridge:{handleAuthorizedMessage:async()=>{throw new Error("must_not_invoke_engine");}}});
}

test("Bot right-click settings work before a first chat, preserve drafts and route tools/new chats to that Bot",async({page},info)=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"bot-menu-")),hub=await HubServer.start({stateDir:path.join(root,"hub"),clientDir:path.resolve("dist")});
  const gateway=await seed(hub,root,"研究助手");const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('other','其他助手','fixture')");
    const current=await hub.store.createConversation("owner",["other"],"保留的对话","existing");
    await pair(page,hub,"本机验收");
    const composer=workspace(page).getByLabel("消息",{exact:true});await composer.fill("不要丢失这份草稿");
    const bot=workspace(page).getByRole("button",{name:"打开 研究助手",exact:true}),menu=page.getByRole("menu",{name:"Bot 操作",exact:true});
    await bot.locator(".avatar").click({button:"right"});await expect(menu.getByRole("menuitem")).toHaveText(["Bot 设置","新建对话","Skills & MCP","运行状态"]);
    await page.screenshot({path:info.outputPath("bot-context-menu.png")});await menu.getByRole("menuitem",{name:"Bot 设置",exact:true}).click();
    const settings=page.getByRole("dialog",{name:"Bot 设置",exact:true});await expect(settings).toContainText("研究助手");await expect(settings).toContainText("gpt-5.5");
    await expect(settings.getByRole("button",{name:"设置Bot 头像",exact:true})).toBeEnabled();
    await settings.getByRole("button",{name:"调整 Bot 思考强度",exact:true}).click();await page.getByLabel("Effort 档位",{exact:true}).selectOption("low");
    await page.getByRole("button",{name:"保存到此 Bot",exact:true}).click();await expect(page.getByRole("dialog",{name:"思考强度",exact:true}).getByRole("status")).toContainText("已保存为 low");
    await page.getByRole("button",{name:"关闭思考强度",exact:true}).click();await expect(settings.getByRole("button",{name:"调整 Bot 思考强度",exact:true})).toContainText("low");
    await page.getByRole("button",{name:"关闭 Bot 设置",exact:true}).click();await expect(bot).toBeFocused();await expect(composer).toHaveValue("不要丢失这份草稿");
    expect((await hub.store.conversations("owner")).map(c=>c.id)).toEqual([current.id]);
    expect(JSON.parse(await readFile(path.join(root,"bot/config.json"),"utf8"))).toMatchObject({effort:"low",model:"gpt-5.5"});
    expect(await readFile(path.join(root,"bot/session.json"),"utf8")).toBe(JSON.stringify({chats:[]}));
    await bot.press("Shift+F10");await expect(menu.getByRole("menuitem",{name:"Bot 设置",exact:true})).toBeFocused();await page.keyboard.press("Escape");await expect(bot).toBeFocused();
    for (const [label,dialog,url] of [["Skills & MCP","Skills 与 MCP","/capabilities"],["运行状态","运行状态","/dashboard"]]) {
      const request=page.waitForRequest(r=>r.url().startsWith(hub.url+"/api/bots/alpha"+url));
      await bot.click({button:"right"});await menu.getByRole("menuitem",{name:label,exact:true}).click();await request;
      await expect(page.getByRole("dialog",{name:dialog,exact:true})).toBeVisible();await page.keyboard.press("Escape");
    }
    await bot.click({button:"right"});await menu.getByRole("menuitem",{name:"新建对话",exact:true}).click();
    const create=page.getByRole("dialog",{name:"新建对话",exact:true});await expect(create.getByRole("checkbox",{name:/研究助手/})).toBeChecked();
    await create.getByPlaceholder("为这段对话起个名字").fill("右键新对话");await create.getByRole("button",{name:"创建对话",exact:true}).click();
    await expect(workspace(page).getByRole("heading",{name:"右键新对话",exact:true})).toBeVisible();
    expect((await hub.store.conversations("owner")).find(c=>c.title==="右键新对话")?.botIds).toEqual(["alpha"]);
    expect(await hub.store.db.get("SELECT COUNT(*) AS count FROM messages")).toEqual({count:0});expect(errors).toEqual([]);
  } finally {await gateway.disconnect();await hub.close();await rm(root,{recursive:true,force:true});}
});

test("Bot settings stay on the clicked host even when Bot IDs collide and another host is active",async({page})=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"bot-menu-hosts-"));
  const a=await HubServer.start({stateDir:path.join(root,"a/hub"),clientDir:path.resolve("dist")}),b=await HubServer.start({stateDir:path.join(root,"b/hub"),origins:[a.url]});
  const ga=await seed(a,path.join(root,"a"),"甲助手"),gb=await seed(b,path.join(root,"b"),"乙助手");
  try {
    await pair(page,a,"主机甲");await pair(page,b,"主机乙",true);
    await setListOption(page, '按主机分组', true);
    const row=workspace(page).getByRole("region",{name:"主机：主机甲",exact:true}).getByRole("button",{name:"打开 甲助手",exact:true});
    await row.click({button:"right"});await page.getByRole("menuitem",{name:"Bot 设置",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"Bot 设置",exact:true});await expect(dialog).toContainText("运行于 主机甲");await expect(dialog).toContainText("甲助手");
    await dialog.getByRole("button",{name:"调整 Bot 思考强度",exact:true}).click();await page.getByLabel("Effort 档位",{exact:true}).selectOption("low");
    await page.getByRole("button",{name:"保存到此 Bot",exact:true}).click();await expect(page.getByRole("dialog",{name:"思考强度",exact:true}).getByRole("status")).toContainText("已保存为 low");
    expect(JSON.parse(await readFile(path.join(root,"a/bot/config.json"),"utf8")).effort).toBe("low");expect(JSON.parse(await readFile(path.join(root,"b/bot/config.json"),"utf8")).effort).toBe("high");
    await page.getByRole("button",{name:"关闭思考强度",exact:true}).click();await page.getByRole("button",{name:"关闭 Bot 设置",exact:true}).click();
    await row.click({button:"right"});await page.setViewportSize({width:390,height:844});await expect(page.getByRole("menu",{name:"Bot 操作",exact:true})).toHaveCount(0);
    expect(await a.store.conversations("owner")).toEqual([]);expect(await b.store.conversations("owner")).toEqual([]);
  } finally {await ga.disconnect();await gb.disconnect();await a.close();await b.close();await rm(root,{recursive:true,force:true});}
});
