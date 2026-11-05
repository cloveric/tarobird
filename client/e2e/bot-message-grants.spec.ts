import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { messageHostId } from "../../src/hub/bot-messages.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { openSettings } from "./fixtures/settings.js";
import { mobileHome, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
const guard=async()=>undefined;
const panel=(page:Page)=>page.locator('.bot-message-grants');
async function openGrants(page: Page) {
  await openSettings(page);
  const back=page.getByRole("button",{name:"返回设置分类",exact:true}); if(await back.isVisible()) await back.click();
  await page.getByRole("navigation",{name:"设置分类"}).getByRole("button",{name:/^Bot 消息授权/}).click();
}
async function fixture(page:Page, runtime=false, oldHost=false, openPermissions=true) {
  page.setDefaultTimeout(12_000);
  const root=await mkdtemp(path.join(os.tmpdir(),"message-grants-ui-"));
  const hub=await HubServer.start({stateDir:root,clientDir:process.env.TAROBOT_E2E_CLIENT_DIR ?? path.resolve("dist")});
  const channels:Awaited<ReturnType<typeof attachGateway>>[]=[];
  const calls:string[]=[];
  for (const [id,name] of [["alpha","研究助手"],["beta","复核助手"],["gamma","离线资料助手"]]) {
    const secret=randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES(?,?,?,'codex')",[id!,name!,hashSecret(secret)]);
    if(runtime&&id!=="gamma") {
      const stateDir=path.join(root,"bots",id!); await mkdir(stateDir,{recursive:true}); await writeFile(path.join(stateDir,"config.json"),JSON.stringify({engine:"codex",locale:"zh",approvalMode:"bypass"}));
      channels.push(await attachGateway({stateDir,botId:id!,secret,engine:"codex",url:hub.instanceUrl.replace("http","ws")+"/instance",runtime:createCoreServiceRuntime(),bridge:{handleAuthorizedMessage:async input=>{calls.push(id!);return{text:`${name} 已处理：${input.text}`,usage:{inputTokens:1,outputTokens:1}};}}}));
    }
  }
  const host=messageHostId(hub.auth.publicKey);
  const grant=(sourceBot:string,targetBot:string,revoke=false)=>hub.botMessages.grant({sourceHost:host,sourceBot,targetBot,revoke},guard);
  await grant("alpha","beta");
  await hub.profile.update({name:"授权验收主机",revision:0});
  await page.goto(hub.url); await page.getByLabel("主机名称",{exact:true}).fill("授权验收主机");
  await preparePairing(page, hub); await page.getByRole("button",{name:"配对此设备",exact:true}).click();
  await hub.auth.approve(await page.getByLabel("配对码",{exact:true}).innerText(),"local-owner");
  await page.getByLabel("配对码",{exact:true}).waitFor({state:"hidden"}); await waitForClientOnline(page);
  if (openPermissions) {
    await openGrants(page);
    if (!oldHost) await expect(panel(page).getByLabel("发起方 Bot",{exact:true})).toHaveValue("alpha");
  }
  return {root,hub,host,calls,grant,close:async()=>{await page.close();for(const channel of channels)await channel.disconnect();await hub.close();await rm(root,{recursive:true,force:true});}};
}

test("message grants hide internal workers but keep the dispatcher and same-name user Bots", async ({ page }) => {
  const f = await fixture(page, false, false, false), p = panel(page);
  try {
    await f.hub.store.db.run("INSERT INTO bots(id,name,secret_hash,role) VALUES('dispatcher','幕僚长','fixture','dispatcher'),('worker','幕僚长 · Claude','fixture','worker')");
    await f.hub.store.db.run("UPDATE bots SET name='幕僚长 · Claude' WHERE id='gamma'");
    await f.grant("worker", "alpha");
    await openGrants(page);
    const source = p.getByLabel("发起方 Bot", { exact: true });
    await expect(source).toHaveValue("alpha");
    await expect(source.locator('option')).toHaveCount(4);
    await expect(source.locator('option[value="worker"]')).toHaveCount(0);
    await expect(p.locator('.message-grants-target[data-bot-id="worker"]')).toHaveCount(0);
    await expect(p.locator('.message-grants-incoming')).not.toContainText("幕僚长 · Claude");
    await expect(source.locator('option[value="dispatcher"]')).toHaveText("幕僚长");
    const peer = p.getByRole("checkbox", { name: "允许 研究助手 → 幕僚长 · Claude", exact: true });
    await peer.check();
    await p.getByRole("button", { name: "保存授权", exact: true }).click();
    await expect(p.getByRole("status")).toHaveText("已保存，并从主机核对生效。");
    expect((await f.hub.botMessages.readGrants("owner", guard)).grants).toContainEqual({ sourceBot: "alpha", targetBot: "gamma" });
    await source.selectOption("dispatcher");
    await expect(p.getByRole("checkbox", { name: "允许 幕僚长 → 研究助手", exact: true })).toBeVisible();
  } finally { await f.close(); }
});

for (const width of [320, 390, 1360]) test(`Bot settings opens permissions for its offline Bot and protects drafts at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  const f = await fixture(page, false, false, false);
  let allowSave = () => {};
  try {
    await showDisconnectedBots(page);
    if (width <= 760) {
      await mobileHome(page).getByRole("navigation").getByRole("button", { name: "Bot", exact: true }).click();
      await mobileHome(page).getByRole("button", { name: "复核助手 的 Bot 设置", exact: true }).click();
    } else {
      await page.locator('.host-workspace:not([hidden]) [data-bot-id="beta"] .bot-identity').click({ button: "right" });
      await page.getByRole("menuitem", { name: "Bot 设置", exact: true }).click();
    }
    const settings = page.getByRole("dialog", { name: "Bot 设置", exact: true });
    const entry = settings.getByRole("button", { name: "Bot 消息授权", exact: true });
    await expect(entry).toBeEnabled(); await entry.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`bot-settings-entry-${width}.png`) });
    await entry.click();
    const dialog = page.getByRole("dialog", { name: "Bot 消息授权", exact: true });
    const p = dialog.locator('.bot-message-grants');
    await expect(p.getByLabel("发起方 Bot", { exact: true })).toHaveValue("beta");
    expect((await f.hub.botMessages.readGrants("owner", guard)).grants).toEqual([{ sourceBot: "alpha", targetBot: "beta" }]);
    const peer = p.getByRole("checkbox", { name: "允许 复核助手 → 离线资料助手", exact: true });
    await peer.check();
    await dialog.getByRole("button", { name: "返回 Bot 设置", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "放弃未保存的修改？", exact: true });
    await expect(confirm).toBeVisible(); await confirm.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(peer).toBeChecked();
    const saveGate = new Promise<void>(resolve => { allowSave = resolve; });
    await page.route("**/api/bot-messages/grants", async route => {
      if (route.request().method() === "POST") await saveGate;
      await route.continue();
    });
    const submitted = page.waitForRequest(request => request.url().endsWith("/api/bot-messages/grants") && request.method() === "POST");
    await p.getByRole("button", { name: "保存授权", exact: true }).click();
    await submitted;
    await expect(dialog.getByRole("button", { name: "返回 Bot 设置", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape"); await expect(dialog).toBeVisible();
    allowSave();
    await expect(p.getByRole("status")).toHaveText("已保存，并从主机核对生效。");
    const savedGrants = (await f.hub.botMessages.readGrants("owner", guard)).grants;
    expect(savedGrants).toHaveLength(2);
    expect(savedGrants).toEqual(expect.arrayContaining([{ sourceBot: "alpha", targetBot: "beta" }, { sourceBot: "beta", targetBot: "gamma" }]));
    await expect.poll(() => dialog.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`bot-settings-grants-${width}.png`) });
    await dialog.getByRole("button", { name: "返回 Bot 设置", exact: true }).click(); await expect(entry).toBeFocused();
    await entry.click(); await expect(peer).toBeChecked();
    await peer.uncheck(); await page.keyboard.press("Escape");
    await expect(confirm).toBeVisible(); await confirm.getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(entry).toBeFocused();
    expect((await f.hub.botMessages.readGrants("owner", guard)).grants).toContainEqual({ sourceBot: "beta", targetBot: "gamma" });
  } finally { allowSave(); await f.close(); }
});

test("existing command grants, one-way task/results and reverse opt-in use the real UI, Hub and Gateway",async({page},info)=>{
  const f=await fixture(page,true), p=panel(page);
  try {
    const beta=p.getByRole("checkbox",{name:"允许 研究助手 → 复核助手",exact:true});
    await expect(beta).toBeChecked(); await expect(p.getByText("暂无其他 Bot 获得此方向的授权。",{exact:true})).toBeVisible();
    const send=async(source:string,target:string)=>{
      const base={host:f.host,bot:target,requestId:`task_${f.calls.length}`,data:{}};
      const chat:any=await f.hub.botMessages.local({...base,operation:"resolve"},source,guard,true);
      const sent:any=await f.hub.botMessages.local({...base,operation:"send",conversation:chat.conversationId,data:{text:"请返回核对结果",attachments:[]}},source,guard,true);
      await expect.poll(async()=>((await f.hub.botMessages.local({...base,operation:"wait",conversation:chat.conversationId,data:{messageId:sent.messageId}},source,guard,true)) as any).status,{timeout:15000}).toBe("completed");
      return f.hub.botMessages.local({...base,operation:"wait",conversation:chat.conversationId,data:{messageId:sent.messageId}},source,guard,true) as Promise<any>;
    };
    expect((await send("alpha","beta")).text).toContain("复核助手 已处理");
    await expect(f.hub.botMessages.local({operation:"resolve",host:f.host,bot:"alpha",requestId:"blocked",data:{}},"beta",guard,true)).rejects.toThrow("not_authorized");
    await p.getByLabel("发起方 Bot",{exact:true}).selectOption("beta");
    const reverse=p.getByRole("checkbox",{name:"允许 复核助手 → 研究助手",exact:true}); await expect(reverse).not.toBeChecked();
    await reverse.check(); await p.getByRole("button",{name:"保存授权",exact:true}).click();
    await expect(p.getByRole("status")).toHaveText("已保存，并从主机核对生效。");
    expect((await send("beta","alpha")).text).toContain("研究助手 已处理");
    expect(f.calls).toEqual(["beta","alpha"]);
    await page.screenshot({path:info.outputPath("desktop-message-permissions.png")});
  }finally{await f.close();}
});

test("mobile refreshes command edits, shows offline separately and refuses stale drafts",async({page},info)=>{
  await page.setViewportSize({width:390,height:844});const f=await fixture(page),p=panel(page);
  try {
    const gamma=p.getByRole("checkbox",{name:"允许 研究助手 → 离线资料助手",exact:true});
    await expect(gamma).not.toBeChecked(); await f.grant("alpha","gamma");
    await expect(gamma).toBeChecked({timeout:10000});
    await expect(p.locator('[data-bot-id="gamma"]')).toContainText("当前离线");
    await gamma.uncheck(); await f.grant("beta","alpha");
    await expect(p.getByText("其他位置已修改授权或 Bot 列表。重新载入会放弃本页未保存的修改，并显示主机当前权限。",{exact:true})).toBeVisible({timeout:10000});
    await expect(p.getByRole("button",{name:"保存授权",exact:true})).toBeDisabled(); await expect(gamma).not.toBeChecked();
    await p.getByRole("button",{name:"重新载入并核对",exact:true}).click(); await expect(gamma).toBeChecked();
    await expect(p.locator('.message-grants-incoming')).toContainText("复核助手");
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({path:info.outputPath("mobile-message-permissions.png")});
  }finally{await f.close();}
});

test("owner enables self messages, receives the task result, reloads and revokes without changing other grants", async ({ page }, info) => {
  const f = await fixture(page, true), p = panel(page);
  try {
    const self = p.getByRole("checkbox", { name: "允许 研究助手 → 研究助手", exact: true });
    await expect(self).not.toBeChecked();
    await expect(p.locator('.message-grants-target').first()).toHaveAttribute("data-bot-id", "alpha");
    await expect(p.locator('[data-bot-id="alpha"]')).toContainText("自身其他对话");
    const base = { host: f.host, bot: "alpha", requestId: "self_ui_task", data: {} };
    await expect(f.hub.botMessages.local({ ...base, operation: "resolve" }, "alpha", guard, true)).rejects.toThrow("target_not_found");
    await self.check(); await p.getByRole("button", { name: "保存授权", exact: true }).click();
    await expect(p.getByRole("status")).toHaveText("已保存，并从主机核对生效。");
    const target: any = await f.hub.botMessages.local({ ...base, operation: "resolve" }, "alpha", guard, true);
    expect(target.conversationName).toBe("来自 研究助手 的协作");
    const sent: any = await f.hub.botMessages.local({ ...base, operation: "send", conversation: target.conversationId, data: { text: "请核对自己的另一段对话", attachments: [] } }, "alpha", guard, true);
    const wait = () => f.hub.botMessages.local({ ...base, operation: "wait", conversation: target.conversationId, data: { messageId: sent.messageId } }, "alpha", guard, true) as Promise<any>;
    await expect.poll(async () => (await wait()).status, { timeout: 15000 }).toBe("completed");
    expect((await wait()).text).toContain("研究助手 已处理");
    expect(f.calls).toEqual(["alpha"]);
    await page.reload(); await waitForClientOnline(page); await openGrants(page);
    await expect(self).toBeChecked();
    await expect(p.locator('[data-bot-id="alpha"]')).not.toContainText("可请求发起方");
    await expect(p.locator('.message-grants-incoming')).not.toContainText("研究助手");
    await page.screenshot({ path: info.outputPath("desktop-self-message-grant.png") });
    await self.uncheck(); await p.getByRole("button", { name: "保存授权", exact: true }).click();
    await expect(p.getByRole("status")).toHaveText("已保存，并从主机核对生效。");
    expect((await f.hub.botMessages.readGrants("owner", guard)).grants).toEqual([{ sourceBot: "alpha", targetBot: "beta" }]);
    await expect(f.hub.botMessages.local({ ...base, operation: "resolve" }, "alpha", guard, true)).rejects.toThrow();
    await p.getByLabel("发起方 Bot", { exact: true }).selectOption("beta");
    await expect(p.locator('.message-grants-target').first()).toHaveAttribute("data-bot-id", "beta");
    await expect(p.getByRole("checkbox", { name: "允许 复核助手 → 复核助手", exact: true })).not.toBeChecked();
  } finally { await f.close(); }
});

for (const width of [390, 320]) test(`a single offline Bot can read and revoke its CLI self grant at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 }); const f = await fixture(page), p = panel(page);
  try {
    await f.hub.store.db.run("UPDATE bots SET deleted_at=? WHERE id IN ('beta','gamma')", [Date.now()]);
    await f.grant("alpha", "alpha");
    const self = p.getByRole("checkbox", { name: "允许 研究助手 → 研究助手", exact: true });
    await expect(p.locator('.message-grants-target')).toHaveCount(1, { timeout: 10000 });
    await expect(self).toBeChecked(); await expect(self).toBeEnabled();
    await expect(p.locator('[data-bot-id="alpha"]')).toContainText("当前离线");
    await expect(p.getByText("已选择 1 个", { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`mobile-self-message-grant-${width}.png`) });
    await self.uncheck(); await p.getByRole("button", { name: "保存授权", exact: true }).click();
    await expect(p.getByRole("status")).toHaveText("已保存，并从主机核对生效。");
    expect((await f.hub.botMessages.readGrants("owner", guard)).grants).toEqual([]);
  } finally { await f.close(); }
});

test("hosts with the older grants API require an update only for self targets", async ({ page }) => {
  await page.route("**/api/bot-messages/grants", async route => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    const response = await route.fetch(); const snapshot = await response.json();
    delete snapshot.selfTargetSupported;
    snapshot.grants = snapshot.grants.filter((grant: any) => grant.sourceBot !== grant.targetBot);
    await route.fulfill({ response, json: snapshot });
  });
  const f = await fixture(page), p = panel(page);
  try {
    await expect(p.getByRole("checkbox", { name: "允许 研究助手 → 研究助手", exact: true })).toBeDisabled();
    await expect(p.getByText("请更新主机后设置自身消息授权。", { exact: true })).toBeVisible();
    const gamma = p.getByRole("checkbox", { name: "允许 研究助手 → 离线资料助手", exact: true });
    await gamma.check(); await p.getByRole("button", { name: "保存授权", exact: true }).click();
    await expect(p.getByRole("status")).toHaveText("已保存，并从主机核对生效。");
    expect((await f.hub.botMessages.readGrants("owner", guard)).grants).not.toContainEqual({ sourceBot: "alpha", targetBot: "alpha" });
  } finally { await f.close(); }
});

test("lost save receipt never claims success, readback recovers without resending; close protects unsaved changes",async({page})=>{
  const f=await fixture(page),p=panel(page);let posts=0;
  try {
    await page.route("**/api/bot-messages/grants",async route=>{if(route.request().method()==="POST"){posts++;await route.fetch();await route.abort("failed");}else await route.continue();});
    await p.getByRole("checkbox",{name:"允许 研究助手 → 研究助手",exact:true}).check();
    await p.getByRole("button",{name:"保存授权",exact:true}).click();
    await expect(p.getByText("尚未确认保存结果。重新载入会清除本页草稿，已生效的授权不会撤回；不会自动重复保存。",{exact:true})).toBeVisible();
    await expect(p.getByText("已保存，并从主机核对生效。",{exact:true})).toHaveCount(0);
    const refreshed=page.waitForResponse(response=>response.url().endsWith("/api/bot-messages/grants")&&response.request().method()==="GET");
    await p.getByRole("button",{name:"刷新消息授权",exact:true}).click(); await refreshed;
    await expect(p.getByText("尚未确认保存结果。重新载入会清除本页草稿，已生效的授权不会撤回；不会自动重复保存。",{exact:true})).toBeVisible();
    await expect(p.getByRole("button",{name:"保存授权",exact:true})).toBeDisabled();
    await p.getByRole("button",{name:"重新载入并核对",exact:true}).click();
    await expect(p.getByRole("checkbox",{name:"允许 研究助手 → 研究助手",exact:true})).toBeChecked();
    expect(posts).toBe(1);
    await p.getByRole("checkbox",{name:"允许 研究助手 → 复核助手",exact:true}).uncheck();
    await page.getByRole("navigation",{name:"设置分类"}).getByRole("button",{name:/^通用/}).click();
    await page.getByRole("button",{name:"关闭设置",exact:true}).click();
    const confirmation=page.getByRole("dialog",{name:"放弃未保存的修改？",exact:true});
    await expect(confirmation).toBeVisible(); await confirmation.getByRole("button",{name:"继续编辑",exact:true}).click();
    await expect(p.getByRole("checkbox",{name:"允许 研究助手 → 复核助手",exact:true})).not.toBeChecked();
    await expect(p).toBeVisible();
  }finally{await f.close();}
});

test("old hosts show an update instruction and no editable permission list",async({page})=>{
  await page.route("**/api/bot-messages/grants",route=>route.fulfill({status:404,contentType:"application/json",body:JSON.stringify({error:"not_found"})}));
  const f=await fixture(page,false,true);
  try{await expect(panel(page).getByRole("alert")).toContainText("请更新主机");await expect(panel(page).getByRole("checkbox")).toHaveCount(0);}finally{await f.close();}
});

test("a rejected write keeps choices, never claims success or a fabricated conflict, and can be retried after refresh",async({page})=>{
  const f=await fixture(page),p=panel(page);let reject=true;
  try {
    await page.route("**/api/bot-messages/grants",async route=>{
      if(reject&&route.request().method()==="POST") await route.fulfill({status:403,contentType:"application/json",body:JSON.stringify({error:"owner_required"})}); else await route.continue();
    });
    const gamma=p.getByRole("checkbox",{name:"允许 研究助手 → 离线资料助手",exact:true}); await gamma.check();
    await p.getByRole("button",{name:"保存授权",exact:true}).click();
    await expect(p.getByRole("alert")).toHaveText("只有已认证的主机所有者可以管理消息授权。");
    expect((await f.hub.botMessages.readGrants("owner",guard)).grants).not.toContainEqual({sourceBot:"alpha",targetBot:"gamma"});
    await expect(gamma).toBeChecked();await expect(p.getByText("已保存，并从主机核对生效。",{exact:true})).toHaveCount(0);
    // A successful automatic GET must not erase a rejected POST. Observe the
    // next actual poll, rather than relying on a fixed timeout.
    await page.waitForResponse(response=>response.url().endsWith("/api/bot-messages/grants")&&response.request().method()==="GET");
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    await expect(p.getByRole("alert")).toHaveText("只有已认证的主机所有者可以管理消息授权。");
    await expect(p.getByRole("button",{name:"保存授权",exact:true})).toBeDisabled();await expect(gamma).toBeChecked();
    reject=false; await p.getByRole("button",{name:"重新核对",exact:true}).click();
    await p.getByRole("button",{name:"保存授权",exact:true}).click();await expect(p.getByRole("status")).toHaveText("已保存，并从主机核对生效。");
  }finally{await f.close();}
});

test("save feedback stays visible beside the action after scrolling a long mobile list",async({page},info)=>{
  await page.setViewportSize({width:390,height:700});const f=await fixture(page),p=panel(page);
  try {
    for(let i=0;i<8;i++) await f.hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES(?,?,?,'codex')",[`extra_${i}`,`资料助手 ${i}`,hashSecret(randomBytes(32).toString("base64url"))]);
    await expect(p.locator('.message-grants-target')).toHaveCount(11,{timeout:10000});
    const search=p.getByRole("textbox",{name:"查找接收方 Bot",exact:true});await search.fill("资料助手 3");await search.press("Escape");
    await expect(search).toHaveValue("");await expect(p).toBeVisible();
    await expect(page.getByRole("dialog",{name:"设置",exact:true}).getByRole("heading",{name:"Bot 消息授权",exact:true})).toHaveCount(1);
    await p.getByRole("checkbox",{name:"允许 研究助手 → 离线资料助手",exact:true}).check();
    const save=p.getByRole("button",{name:"保存授权",exact:true});await save.scrollIntoViewIfNeeded();await save.click();
    const status=p.getByText("已保存，并从主机核对生效。",{exact:true});await expect(status).toBeVisible();
    await page.screenshot({path:info.outputPath("mobile-save-feedback.png")});
    await expect(status).toBeInViewport({ratio:1});
    await expect(p.getByRole("group",{name:"消息授权状态",exact:true})).toHaveCSS("outline-style","none");
    // A concurrent permission edit must explain draft loss where the reload
    // action is visible, including at the bottom of a long phone list.
    await p.getByRole("checkbox",{name:"允许 研究助手 → 离线资料助手",exact:true}).uncheck();await save.scrollIntoViewIfNeeded();
    await f.grant("beta","alpha");
    const conflict=p.getByRole("alert");await expect(conflict).toContainText("重新载入会放弃本页未保存的修改",{timeout:10000});
    await expect(conflict).toBeInViewport({ratio:1});
  }finally{await f.close();}
});

test("the first checkbox edit does not move the remaining targets under the pointer",async({page})=>{
  const f=await fixture(page),p=panel(page);
  try {
    const beta=p.getByRole("checkbox",{name:"允许 研究助手 → 复核助手",exact:true});
    const before=await beta.boundingBox();
    await p.getByRole("checkbox",{name:"允许 研究助手 → 离线资料助手",exact:true}).check();
    await expect.poll(async()=>Math.abs((await beta.boundingBox())!.y-before!.y)).toBeLessThanOrEqual(1);
  }finally{await f.close();}
});

test("keyboard save keeps focus in the permissions panel when its button becomes disabled",async({page})=>{
  const f=await fixture(page),p=panel(page);
  try {
    const gamma=p.getByRole("checkbox",{name:"允许 研究助手 → 离线资料助手",exact:true});await gamma.check();
    // WebKit's platform Tab policy can skip buttons; test keyboard activation
    // and completion focus without depending on the host OS preference.
    const save=p.getByRole("button",{name:"保存授权",exact:true});await save.focus();await expect(save).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(p.getByText("已保存，并从主机核对生效。",{exact:true})).toBeVisible();
    await expect.poll(()=>p.evaluate(el=>el.contains(document.activeElement))).toBe(true);
    await expect(p.getByRole("group",{name:"消息授权状态",exact:true})).toHaveCSS("outline-style","solid");
  }finally{await f.close();}
});

test("discard interrupts a background read and restores keyboard focus without applying its late response",async({page})=>{
  const f=await fixture(page),p=panel(page);let release!:()=>void,started!:()=>void,releaseManual!:()=>void,startedManual!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});const arrived=new Promise<void>(resolve=>{started=resolve;});let gets=0;
  const manualHeld=new Promise<void>(resolve=>{releaseManual=resolve;});const manualArrived=new Promise<void>(resolve=>{startedManual=resolve;});
  try {
    await expect(page.getByRole("heading",{name:"Bot 消息授权",exact:true})).toBeFocused();
    const gamma=p.getByRole("checkbox",{name:"允许 研究助手 → 离线资料助手",exact:true});await gamma.check();
    await page.route("**/api/bot-messages/grants",async route=>{
      if(route.request().method()==="GET"&&++gets<=2){const ordinal=gets;const response=await route.fetch();if(ordinal===1){started();await held;}else{startedManual();await manualHeld;}await route.fulfill({response}).catch(()=>{});}else await route.continue();
    });
    await arrived;
    const discard=p.getByRole("button",{name:"放弃修改",exact:true});await expect(discard).toBeEnabled();await discard.focus();await page.keyboard.press("Enter");
    await manualArrived;await expect(p.getByRole("button",{name:"正在载入…",exact:true})).toBeDisabled();await expect(gamma).toBeDisabled();releaseManual();
    await expect(gamma).not.toBeChecked();
    await expect(p.getByRole("status")).toHaveText("已重新载入主机当前权限。");
    await expect.poll(()=>p.evaluate(el=>el.contains(document.activeElement))).toBe(true);
    release();await expect(gamma).not.toBeChecked();await expect(p.getByRole("button",{name:"保存授权",exact:true})).toBeDisabled();
    const refresh=p.getByRole("button",{name:"刷新消息授权",exact:true});await refresh.focus();await refresh.press("Enter");
    await expect(refresh).toHaveAttribute("aria-busy","false");await expect(refresh).toBeFocused();
  }finally{release();releaseManual();await f.close();}
});

test("a failed signing challenge keeps the draft and can retry after readback without discarding it",async({page})=>{
  const f=await fixture(page),p=panel(page);let posts=0;
  try {
    await page.route("**/api/bot-messages/grants",async route=>{if(route.request().method()==="POST")posts++;await route.continue();});
    await page.route("**/api/devices/challenge",route=>route.abort('failed'));
    const choice=p.getByRole("checkbox",{name:"允许 研究助手 → 离线资料助手",exact:true});await choice.check();
    await p.getByRole("button",{name:"保存授权",exact:true}).click();
    await expect(p.getByRole("alert")).toHaveText("无法核对主机权限，请恢复连接后重试。");
    expect(posts).toBe(0);await expect(choice).toBeChecked();
    await page.unroute("**/api/devices/challenge");
    await p.getByRole("button",{name:"重新核对",exact:true}).click();
    await expect(p.getByRole("button",{name:"保存授权",exact:true})).toBeEnabled();await expect(choice).toBeChecked();
    await p.getByRole("button",{name:"保存授权",exact:true}).click();
    await expect(p.getByRole("status")).toHaveText("已保存，并从主机核对生效。");expect(posts).toBe(1);
  }finally{await f.close();}
});


test("a late session cancellation after a committed grant stays unknown until readback", async ({ page }) => {
  const f = await fixture(page), p = panel(page); let posts = 0;
  try {
    await page.route("**/api/bot-messages/grants", async route => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      posts++; const response = await route.fetch(); expect(response.ok()).toBe(true);
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "device_action_cancelled" }) });
    });
    const choice = p.getByRole("checkbox", { name: "允许 研究助手 → 离线资料助手", exact: true });
    await choice.check(); await p.getByRole("button", { name: "保存授权", exact: true }).click();
    await expect(p.getByRole("alert")).toContainText("尚未确认保存结果");
    await expect(p.getByText(/其他位置已修改授权/)).toHaveCount(0);
    expect((await f.hub.botMessages.readGrants("owner", guard)).grants).toContainEqual({ sourceBot: "alpha", targetBot: "gamma" });
    await p.getByRole("button", { name: "重新载入并核对", exact: true }).click();
    await expect(choice).toBeChecked(); await expect(p.getByRole("alert")).toHaveCount(0);
    expect(posts).toBe(1);
  } finally { await f.close(); }
});
