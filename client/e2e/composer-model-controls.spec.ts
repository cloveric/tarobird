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
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import type { InstanceEngine } from "../../src/state/instance-config.js";
import { DEFAULT_PALETTE } from "../src/palettes.js";

test.use({ serviceWorkers: "block" });
async function fixture(page: Page, alpha: { engine: InstanceEngine; model: string; effort: string } = { engine: "codex", model: "gpt-6.1-sol", effort: "high" }) {
  const root=await mkdtemp(path.join(os.tmpdir(),"composer-model-"));
  const hub=await HubServer.start({stateDir:path.join(root,"hub"),clientDir:path.resolve("dist")});
  await hub.profile.update({name:"测试主机",revision:(await hub.profile.read()).revision});
  const gateways=[];let calls=0;
  for(const [id,engine,model,effort] of [["alpha",alpha.engine,alpha.model,alpha.effort],["beta","claude","opus","high"]] as const) {
    const stateDir=path.join(root,id),secret=randomBytes(32).toString("base64url");await mkdir(stateDir);
    await writeFile(path.join(stateDir,"config.json"),JSON.stringify({engine,model,...(effort ? {effort} : {}),locale:"zh"}));
    await writeFile(path.join(stateDir,"session.json"),"preserved-session");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)",[id,id,hashSecret(secret)]);
    gateways.push(await attachGateway({stateDir,url:hub.instanceUrl.replace("http","ws")+"/instance",secret,botId:id,engine,model,effort,runtime:createCoreServiceRuntime(),bridge:{handleAuthorizedMessage:async()=>{calls++;return{text:"unused"};}}}));
  }
  const direct=await hub.store.createConversation("owner",["alpha"],"模型快捷选择","direct");
  const other=await hub.store.createConversation("owner",["beta"],"另一个 Bot","other");
  const group=await hub.store.createConversation("owner",["alpha","beta"],"指定回复对象","group",{type:"group"});
  await page.goto(hub.url);await preparePairing(page, hub); await page.getByRole("button",{name:"配对此设备",exact:true}).click();
  await hub.auth.approve(await page.getByLabel("配对码",{exact:true}).innerText(),"local-owner");
  await page.getByLabel("配对码",{exact:true}).waitFor({state:"hidden"});await waitForClientOnline(page);
  return {root,hub,direct,other,group,gateways,calls:()=>calls,config:async(id:string)=>JSON.parse(await readFile(path.join(root,id,"config.json"),"utf8")),
    dispose:async()=>{await page.close();for(const gateway of gateways)await gateway.disconnect();await hub.close();await rm(root,{recursive:true,force:true});}};
}
const controls=(page:Page)=>page.locator(".host-workspace:not([hidden]) .composer-model-controls");

async function expectControlsBesideSend(page: Page) {
  const toolbar = page.locator(".host-workspace:not([hidden]) .composer-toolbar");
  const geometry = await toolbar.evaluate(node => {
    const group = node.querySelector(".composer-model-controls")!;
    const bounds = group.getBoundingClientRect(), send = node.querySelector(".send-button")!.getBoundingClientRect();
    return { adjacent: group.nextElementSibling?.classList.contains("send-button"),
      gap: send.left - bounds.right, centerOffset: bounds.top + bounds.height / 2 - (send.top + send.height / 2),
      fits: node.scrollWidth <= node.clientWidth };
  });
  expect(geometry.adjacent).toBe(true);
  expect(geometry.gap).toBeGreaterThanOrEqual(0);expect(geometry.gap).toBeLessThanOrEqual(14);
  expect(Math.abs(geometry.centerOffset)).toBeLessThanOrEqual(1);expect(geometry.fits).toBe(true);
}

test("desktop composer model and effort save through shared settings and retain the draft",async({page},info)=>{
  const f=await fixture(page);
  try {
    await selectConversation(page,f.direct.title);
    await page.getByLabel("消息",{exact:true}).fill("保留输入中的草稿");
    const model=controls(page).getByRole("button",{name:/^模型设置：/});
    const effort=controls(page).getByRole("button",{name:/^思考强度：/});
    await expect(model).toHaveAccessibleName(/gpt-6\.1-sol/);
    await expect(effort).toHaveAccessibleName(/high/);
    await expect(model).toHaveText("gpt-6.1-sol");await expect(effort).toHaveText("high");
    for(const theme of ["light","dark","cli"]) {
      await page.evaluate(({theme,palette})=>{document.documentElement.dataset.theme=theme==="dark"?"dark":"light";document.documentElement.dataset.palette=theme==="cli"?theme:palette;},{theme,palette:DEFAULT_PALETTE});
      await page.locator(".host-workspace:not([hidden]) .composer").screenshot({path:info.outputPath(`composer-${theme}.png`),animations:"disabled"});
      await expectControlsBesideSend(page);
    }
    for (const width of [900, 761]) {
      await page.setViewportSize({width,height:900});
      await expect(model).toBeVisible();await expect(effort).toBeVisible();
      await expectControlsBesideSend(page);
      await expect(page.getByRole("button",{name:"发送消息",exact:true})).toBeInViewport();
    }
    await page.setViewportSize({width:1360,height:900});
    await model.click();
    const modelMenu=page.getByRole("group",{name:"快捷选择模型",exact:true});
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(modelMenu).toContainText("alpha · 所有对话共用，下次任务生效");
    await modelMenu.getByRole("button",{name:/^gpt-6-luna /}).click();
    await expect(modelMenu).toHaveCount(0);
    await expect(model).toBeFocused();await expect(model).toHaveText("gpt-6-luna");await expect(effort).toHaveText("high");
    await effort.click();
    const effortMenu=page.getByRole("group",{name:"快捷选择思考强度",exact:true});
    await expect(effortMenu.getByRole("button",{name:"ultra",exact:true})).toHaveCount(0);
    await effortMenu.getByRole("button",{name:"max",exact:true}).click();
    await expect(effortMenu).toHaveCount(0);await expect(effort).toHaveText("max");
    await effort.click();
    await effortMenu.getByRole("button",{name:"low",exact:true}).click();
    await expect(effortMenu).toHaveCount(0);
    await expect(effort).toBeFocused();await expect(effort).toHaveText("low");
    await expect(page.getByLabel("消息",{exact:true})).toHaveValue("保留输入中的草稿");
    expect(await f.config("alpha")).toMatchObject({model:"gpt-6-luna",effort:"low"});
    expect(await f.config("beta")).toMatchObject({model:"opus",effort:"high"});
    expect(await readFile(path.join(f.root,"alpha/session.json"),"utf8")).toBe("preserved-session");
    expect(f.calls()).toBe(0);expect(await f.hub.store.db.get("SELECT COUNT(*) AS count FROM messages")).toEqual({count:0});
    await page.reload();await waitForClientOnline(page);await selectConversation(page,f.direct.title);
    await expect(model).toHaveText("gpt-6-luna");await expect(effort).toHaveText("low");
    await expect(page.getByLabel("消息",{exact:true})).toHaveValue("保留输入中的草稿");
    const run=await f.hub.store.publishBotMessage("alpha",{conversationId:f.direct.id,status:"streaming",blocks:[{type:"text",text:"正在处理"}]});
    await expect(page.locator(".host-workspace:not([hidden]) .composer-stop")).toBeVisible();
    await expectControlsBesideSend(page);
    await f.hub.store.publishBotMessage("alpha",{id:run.id,conversationId:f.direct.id,status:"complete",blocks:[{type:"text",text:"处理完成"}]});
    await expect(page.locator(".host-workspace:not([hidden]) .composer-stop")).toHaveCount(0);
    await page.setViewportSize({width:390,height:844});await expect(page.locator(".composer-model-controls")).toHaveCount(0);
    await page.setViewportSize({width:1360,height:900});await selectConversation(page,f.direct.title);
    await f.gateways[0]!.disconnect();await expect(model).toBeDisabled();await expect(effort).toBeDisabled();
    await f.hub.store.db.run("INSERT INTO bot_grants(user_id,bot_id) VALUES(?,?)",["owner","beta"]);
    await f.hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
    await page.reload();await waitForClientOnline(page);await selectConversation(page,f.other.title);
    await expect(model).toBeDisabled();await expect(effort).toBeDisabled();await expect(model).toHaveAttribute("title","仅拥有者可修改 Bot 设置");
  }finally{await f.dispose();}
});

test("group controls target the chosen Bot and ADHD omits composer model controls",async({page},info)=>{
  const f=await fixture(page);
  try {
    await selectConversation(page,f.group.title);await expect(controls(page)).toHaveCount(0);
    const recipients=page.locator(".host-workspace:not([hidden]) .composer-recipients");
    await recipients.click();await page.getByRole("group",{name:"回复的 Bot",exact:true}).getByRole("checkbox",{name:"beta",exact:true}).click();await recipients.click();
    await expect(controls(page).getByRole("button",{name:/^模型设置：/})).toHaveText("opus");
    await page.getByLabel("消息", { exact: true }).fill("@alpha，请看这里");
    await expect(controls(page).getByRole("button", { name: /^模型设置：/ })).toHaveText("gpt-6.1-sol");
    await page.getByLabel("消息", { exact: true }).fill("");
    await expect(controls(page).getByRole("button", { name: /^模型设置：/ })).toHaveText("opus");
    await controls(page).getByRole("button",{name:/^思考强度：/}).click();
    const menu=page.getByRole("group",{name:"快捷选择思考强度",exact:true});await expect(menu).toContainText("beta · 所有对话共用，下次任务生效");
    await menu.getByRole("button",{name:"max",exact:true}).click();await expect(menu).toHaveCount(0);
    expect(await f.config("alpha")).toMatchObject({effort:"high"});expect(await f.config("beta")).toMatchObject({effort:"max"});
    await recipients.click();await page.getByRole("group",{name:"回复的 Bot",exact:true}).getByRole("checkbox",{name:"alpha",exact:true}).click();await recipients.click();
    await expect(controls(page)).toHaveCount(0);
    const panes=[f.direct,f.other];
    for(let i=0;i<4;i++)panes.push(await f.hub.store.createConversation("owner",["alpha"],`布局窗口 ${i+1}`,`layout-${i}`));
    await page.reload();await waitForClientOnline(page);
    await page.getByRole("button",{name:"打开 ADHD 模式",exact:true}).click();
    for(const chat of panes)await page.getByRole("checkbox",{name:`加入面板：测试主机 · ${chat.title}`,exact:true}).check();
    await page.getByLabel("ADHD 每行窗口数").selectOption("6");
    const first=page.locator(`.adhd-card[data-pane-conversation="${f.direct.id}"]`),second=page.locator(`.adhd-card[data-pane-conversation="${f.other.id}"]`);
    await first.locator(".composer textarea").fill("窗口自己的草稿");
    await expect(page.locator(".adhd-card")).toHaveCount(6);
    expect((await first.boundingBox())!.width).toBeLessThanOrEqual(310);
    expect(await page.locator(".adhd-grid").evaluate(node=>getComputedStyle(node).gridTemplateColumns.split(" ").length)).toBe(6);
    for(const card of [first,second]) {
      await expect(card.locator(".composer-model-controls")).toHaveCount(0);
      await expect(card.locator(".send-button")).toBeInViewport();
      expect(await card.locator(".composer").evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
    }
    await expect(page.locator(".adhd-card .composer-model-controls")).toHaveCount(0);
    await expect(first.locator(".composer textarea")).toHaveValue("窗口自己的草稿");
    await first.locator(".composer").screenshot({path:info.outputPath("adhd-composer.png"),animations:"disabled"});
    await page.getByRole("button",{name:"返回聊天",exact:true}).click();
    await selectConversation(page,f.direct.title);
    await expect(controls(page).getByRole("button",{name:/^模型设置：/})).toHaveText("gpt-6.1-sol");
    await expectControlsBesideSend(page);
    await expect(page.getByLabel("消息",{exact:true})).toHaveValue("窗口自己的草稿");
    expect(f.calls()).toBe(0);
  }finally{await f.dispose();}
});


test("quick menus clamp to small windows, support keyboard and reset incompatible effort atomically", async ({page}, info) => {
  const f=await fixture(page, {engine:"codex",model:"gpt-6-astra",effort:"ultra"});
  try {
    await selectConversation(page,f.direct.title);
    await page.setViewportSize({width:900,height:500});
    const model=controls(page).getByRole("button",{name:/^模型设置：/});
    const effort=controls(page).getByRole("button",{name:/^思考强度：/});
    await model.click();
    const menu=page.getByRole("group",{name:"快捷选择模型",exact:true});
    await expect(menu.getByRole("button",{name:/^gpt-6-astra /})).toBeFocused();
    const bounds=await menu.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(8);expect(bounds!.y).toBeGreaterThanOrEqual(8);
    expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(892);expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(492);
    await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);await expect(model).toBeFocused();
    await model.click();
    await menu.getByRole("button",{name:/^gpt-6-luna /}).click();
    await expect(menu).toHaveCount(0);await expect(model).toHaveText("gpt-6-luna");await expect(effort).toHaveText("跟随默认");
    expect(await f.config("alpha")).toMatchObject({model:"gpt-6-luna"});expect((await f.config("alpha")).effort).toBeUndefined();
    await effort.click();
    const levels=page.getByRole("group",{name:"快捷选择思考强度",exact:true});
    await expect(levels.getByRole("button")).toHaveText(["跟随默认","low","medium","high","xhigh","max"]);
    await page.keyboard.press("End");await expect(levels.getByRole("button",{name:"max",exact:true})).toBeFocused();
    await page.keyboard.press("Enter");await expect(levels).toHaveCount(0);await expect(effort).toHaveText("max");
    await page.setViewportSize({width:1200,height:820});
    for (const theme of ["light","dark","cli"]) {
      await page.evaluate(({theme,palette})=>{document.documentElement.dataset.theme=theme==="dark"?"dark":"light";document.documentElement.dataset.palette=theme==="cli"?theme:palette;},{theme,palette:DEFAULT_PALETTE});
      await effort.click();await expect(levels.getByRole("button",{name:"max",exact:true})).toBeFocused();
      await page.screenshot({path:info.outputPath(`quick-effort-${theme}.png`),animations:"disabled"});
      await page.keyboard.press("Escape");
    }
    await page.evaluate(({palette})=>{document.documentElement.dataset.theme="light";document.documentElement.dataset.palette=palette;},{palette:DEFAULT_PALETTE});
    await model.click();await expect(menu.getByRole("button",{name:/^gpt-6-luna /})).toBeFocused();
    await page.screenshot({path:info.outputPath("quick-model-light.png"),animations:"disabled"});
    await menu.getByRole("button",{name:/^gpt-6-luna /}).click();await expect(menu).toHaveCount(0);
    expect(await f.config("alpha")).toMatchObject({model:"gpt-6-luna",effort:"max"});
  } finally {await f.dispose();}
});

test("quick settings hold saves, block uncertain retries, and reread revision conflicts", async ({page}) => {
  const f=await fixture(page);
  try {
    await selectConversation(page,f.direct.title);
    const model=controls(page).getByRole("button",{name:/^模型设置：/}), effort=controls(page).getByRole("button",{name:/^思考强度：/});
    const menu=page.getByRole("group",{name:"快捷选择模型",exact:true});
    let writes=0, release: (()=>void)|undefined;
    const held=new Promise<void>(resolve=>{release=resolve;});
    await page.route("**/api/bots/alpha/model",async route=>{
      if(route.request().method()==="PUT") {writes++;await held;await route.abort("failed");} else await route.continue();
    });
    await model.click();await menu.getByRole("button",{name:/^gpt-6-luna /}).click();
    await expect(menu.getByRole("status")).toHaveText("保存中…");await expect(effort).toBeDisabled();
    await page.keyboard.press("Escape");await expect(menu).toBeVisible();
    release!();await expect(menu.getByRole("alert")).toContainText("未能确认设置结果");expect(writes).toBe(1);
    await expect(menu.getByRole("button",{name:/^gpt-6-sol /})).toBeDisabled();await expect(model).toHaveText("gpt-6.1-sol");
    await page.unroute("**/api/bots/alpha/model");
    await menu.getByRole("button",{name:"重新读取",exact:true}).click();await expect(menu.getByRole("button",{name:/^gpt-6-sol /})).toBeEnabled();
    await writeFile(path.join(f.root,"alpha/config.json"),JSON.stringify({...await f.config("alpha"),effort:"low"}));
    await menu.getByRole("button",{name:/^gpt-6-luna /}).click();await expect(menu.getByRole("alert")).toContainText("其他设备或本机已修改设置");
    await menu.getByRole("button",{name:"重新读取",exact:true}).click();
    await menu.getByRole("button",{name:/^gpt-6-luna /}).click();await expect(menu).toHaveCount(0);
    expect(await f.config("alpha")).toMatchObject({model:"gpt-6-luna",effort:"low"});
    await model.click();await selectConversation(page,f.other.title);await expect(menu).toHaveCount(0);
    await expect(model).toHaveText("opus");expect(f.calls()).toBe(0);
  } finally {await f.dispose();}
});

for (const spec of [
  {engine:"claude",model:"claude-opus-5-5[1m]",effort:"xhigh",levels:["跟随默认","low","medium","high","xhigh","max"]},
  {engine:"kimi",model:"kimi-for-coding",effort:"high",levels:["跟随默认","low","high","max"]},
  {engine:"deepseek",model:"deepseek-v4-pro",effort:"high",levels:["跟随默认","low","high","max"]},
  {engine:"antigravity",model:"gemini-3.8-flash-high",effort:"",levels:["low","medium","high"]},
] as const) test(`quick effort uses ${spec.engine} model capabilities`,async({page})=>{
  const previous=process.env.ANTIGRAVITY_EXECUTABLE;
  if(spec.engine==="antigravity")process.env.ANTIGRAVITY_EXECUTABLE=path.resolve("../tests/fixtures/agy-models.mjs");
  const f=await fixture(page,spec);
  try {
    await selectConversation(page,f.direct.title);
    const effort=controls(page).getByRole("button",{name:/^思考强度：/});await effort.click();
    const menu=page.getByRole("group",{name:"快捷选择思考强度",exact:true});
    await expect(menu.getByRole("button")).toHaveText([...spec.levels]);
    // Merely opening the preset does not turn its implicit effort into an override.
    expect((await f.config("alpha")).model).toBe(spec.model);expect((await f.config("alpha")).effort).toBe(spec.effort || undefined);
    await menu.getByRole("button",{name:"low",exact:true}).click();await expect(menu).toHaveCount(0);
    expect(await f.config("alpha")).toMatchObject({model:spec.engine==="antigravity"?"gemini-3.8-flash-low":spec.model,effort:"low"});
    await effort.click();await expect(menu.getByRole("button",{name:"low",exact:true})).toHaveAttribute("aria-pressed","true");
    await page.keyboard.press("Escape");
    if(spec.engine==="antigravity") {
      await controls(page).getByRole("button",{name:/^模型设置：/}).click();
      await page.getByRole("group",{name:"快捷选择模型",exact:true}).getByRole("button",{name:/^GPT-OSS 120B /}).click();
      await expect(controls(page).getByRole("button",{name:/^模型设置：/})).toHaveText("gpt-oss-120b-medium");
      await effort.click();await expect(menu.getByRole("button")).toHaveText(["medium"]);
      expect(await f.config("alpha")).toMatchObject({model:"gpt-oss-120b-medium",effort:"medium"});
    }
    expect(f.calls()).toBe(0);expect(await readFile(path.join(f.root,"alpha/session.json"),"utf8")).toBe("preserved-session");
  } finally {await f.dispose();if(previous===undefined)delete process.env.ANTIGRAVITY_EXECUTABLE;else process.env.ANTIGRAVITY_EXECUTABLE=previous;}
});
