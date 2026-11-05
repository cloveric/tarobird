import { preparePairing } from "./fixtures/pairing-invite.js";
import { expectOneDisclosure } from "./fixtures/disclosure-assertions.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { CronStore } from "../../src/state/cron-store.js";
import { CronScheduler } from "../../src/runtime/cron-scheduler.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { openWorkspacePage, waitForClientOnline } from "./fixtures/mobile.js";
async function pair(page:Page,hub:HubServer) {
  await page.goto(hub.url);await preparePairing(page, hub); await page.getByRole("button",{name:"配对此设备",exact:true}).click();
  await hub.auth.approve(await page.getByLabel("配对码",{exact:true}).innerText(),"local-owner");
  await page.getByLabel("配对码",{exact:true}).waitFor({state:"hidden"});await waitForClientOnline(page);
}
test("create from the plus menu, retry a lost receipt, edit and pause across desktop and phone",async({browser},info)=>{
  test.setTimeout(90_000);
  const root=await mkdtemp(path.join(os.tmpdir(),"schedules-ui-")),stateDir=path.join(root,"bot");await mkdir(stateDir);
  await writeFile(path.join(stateDir,"config.json"),JSON.stringify({engine:"codex",locale:"zh",timezone:"Asia/Shanghai"}));
  const hub=await HubServer.start({stateDir:path.join(root,"hub"),clientDir:path.resolve("dist")}),secret=randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手',?)",[hashSecret(secret)]);
  const runtime=createCoreServiceRuntime();
  const gateway=await attachGateway({stateDir,botId:"alpha",secret,url:hub.url.replace("http","ws")+"/instance",runtime,bridge:{handleAuthorizedMessage:async()=>({text:"scheduled fixture reply"})}});
  const store=new CronStore(stateDir),scheduler=new CronScheduler({store,stateDir,executor:(job,signal)=>gateway.runCron!(job,signal)});await scheduler.start();runtime.cronRuntime={store,scheduler};
  const desktopContext=await browser.newContext({serviceWorkers:"block",viewport:{width:1360,height:900}}),phoneContext=await browser.newContext({serviceWorkers:"block",viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const desktop=await desktopContext.newPage(),phone=await phoneContext.newPage();
  const errors:string[]=[];for(const p of [desktop,phone])p.on("pageerror",e=>errors.push(e.message));
  try {
    await pair(desktop,hub);await clickAppAction(desktop,"新建定时任务");
    const dialog=desktop.locator(".scheduled-tasks");
    await dialog.getByLabel("任务名称",{exact:true}).fill("每天整理项目进展");
    await dialog.getByLabel("任务内容",{exact:true}).fill("检查项目进展，生成一份简短日报。");
    await dialog.getByLabel("任务时区",{exact:true}).fill("Asia/Shanghai");
    await dialog.getByLabel("执行频率",{exact:true}).selectOption("weekdays");
    await dialog.getByLabel("执行时间",{exact:true}).fill("09:30");
    await desktop.screenshot({path:info.outputPath("schedule-create-desktop.png"),animations:"disabled"});
    let allowReply=false;
    await desktop.route("**/api/bots/alpha/schedules",async route=>{
      if(route.request().method()==="POST"&&!allowReply){await route.fetch();await route.abort();}else await route.continue();
    });
    await dialog.getByRole("button",{name:"创建定时任务",exact:true}).click();await expect(dialog.getByRole("button",{name:"重试保存",exact:true})).toBeVisible();
    await expect(dialog.getByRole("button", { name: "执行 Bot", exact: true })).toBeDisabled();
    await expect(dialog.locator(".schedule-bot-restriction")).toHaveText("保存尚未确认，暂不能更换 Bot");
    allowReply=true;await dialog.getByRole("button",{name:"重试保存",exact:true}).click();await expect(dialog.getByText("定时任务已保存。",{exact:true})).toBeVisible();
    expect(await store.list()).toHaveLength(1);expect(await hub.store.conversations("owner")).toHaveLength(1);
    await expectOneDisclosure(dialog.locator(".schedule-details > summary"));
    expect((await store.list())[0]).toMatchObject({cronExpr:"30 9 * * 1-5",timezone:"Asia/Shanghai",sessionMode:"new_per_run",deliveryMode:"agent"});
    await pair(phone,hub);await openWorkspacePage(phone,"定时任务");
    const mobile=phone.locator(".scheduled-tasks");await expect(mobile.locator(".schedule-item")).toHaveCount(1);
    await mobile.getByRole("button",{name:"暂停任务",exact:true}).click();await expect(mobile.getByRole("button",{name:"启用任务",exact:true})).toBeVisible();
    await dialog.getByRole("button",{name:"刷新",exact:true}).click();await expect(dialog.getByRole("button",{name:"启用任务",exact:true})).toBeVisible();
    // A lost toggle response may already have applied. Each click is a new
    // request, so the dialog reads the actual task instead of replaying it.
    let toggles=0,reject=false;
    await desktop.route("**/api/bots/alpha/schedules",async route=>{
      if(route.request().method()!=="POST"){await route.continue();return;}
      toggles++;
      if(reject)await route.fulfill({status:403,contentType:"application/json",body:JSON.stringify({error:"conversation_forbidden"})});
      else{await route.fetch();await route.abort();}
    });
    await dialog.getByRole("button",{name:"启用任务",exact:true}).click();
    await expect(dialog.getByRole("alert")).toHaveText("未能确认操作结果，请核对最新状态后再试。");
    await expect(dialog.getByRole("button",{name:"暂停任务",exact:true})).toBeVisible();
    expect(toggles).toBe(1);expect((await store.list())[0]?.enabled).toBe(true);
    // A rejection did not apply and is not reported as unknown.
    reject=true;await dialog.getByRole("button",{name:"暂停任务",exact:true}).click();
    await expect(dialog.getByRole("alert")).toHaveText("操作未完成，请重试。");
    await expect(dialog.getByRole("button",{name:"暂停任务",exact:true})).toBeVisible();
    expect(toggles).toBe(2);expect((await store.list())[0]?.enabled).toBe(true);
    await desktop.unroute("**/api/bots/alpha/schedules");
    await dialog.getByRole("button",{name:"暂停任务",exact:true}).click();await expect(dialog.getByRole("button",{name:"启用任务",exact:true})).toBeVisible();
    await expect(dialog.getByRole("alert")).toHaveCount(0);expect((await store.list())[0]?.enabled).toBe(false);
    await dialog.getByRole("button",{name:"编辑",exact:true}).click();await dialog.getByLabel("任务名称",{exact:true}).fill("修改后的日报");
    await expect(dialog.getByRole("button", { name: "执行 Bot", exact: true })).toBeDisabled();
    await expect(dialog.locator(".schedule-bot-restriction")).toHaveText("编辑时不能更换执行 Bot");
    await dialog.getByLabel("执行时间",{exact:true}).fill("10:15");await dialog.getByRole("button",{name:"保存修改",exact:true}).click();
    await expect(dialog.locator(".schedule-item")).toContainText("修改后的日报");
    // Converting a loaded daily/workday task to weekly must offer a real
    // weekday and save that selection even when the user does not touch it.
    for (const frequency of ["daily", "weekdays"]) {
      await dialog.getByRole("button",{name:"编辑",exact:true}).click();
      await dialog.getByLabel("执行频率",{exact:true}).selectOption(frequency);
      await dialog.getByRole("button",{name:"保存修改",exact:true}).click();
      await expect(dialog.locator(".schedule-item")).toHaveCount(1);
      await dialog.getByRole("button",{name:"编辑",exact:true}).click();
      await dialog.getByLabel("执行频率",{exact:true}).selectOption("weekly");
      await expect.soft(dialog.getByLabel("星期",{exact:true}), `${frequency} converts to a valid default weekday`).toHaveValue("1");
      await dialog.getByRole("button",{name:"保存修改",exact:true}).click();
      await expect(dialog.locator(".schedule-item")).toHaveCount(1);
      expect.soft((await store.list())[0]?.cronExpr, `${frequency} converts to a weekly schedule`).toBe("15 10 * * 1");
    }
    await mobile.getByRole("button",{name:"刷新",exact:true}).click();await expect(mobile.locator(".schedule-item")).toContainText("修改后的日报");
    await phone.screenshot({path:info.outputPath("schedule-list-mobile.png"),animations:"disabled"});
    await mobile.getByRole("button",{name:"新建定时任务",exact:true}).click();
    await mobile.getByLabel("任务名称",{exact:true}).fill("单次任务");await mobile.getByLabel("任务内容",{exact:true}).fill("执行一次检查");
    await mobile.getByLabel("任务时区",{exact:true}).fill("Asia/Shanghai");await mobile.getByLabel("执行频率",{exact:true}).selectOption("once");
    await mobile.getByLabel("执行日期与时间",{exact:true}).fill("2035-01-02T09:00");
    await phone.screenshot({path:info.outputPath("schedule-create-mobile.png"),animations:"disabled"});
    expect(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await mobile.getByRole("button",{name:"创建定时任务",exact:true}).click();await expect(mobile.locator(".schedule-item")).toHaveCount(2);
    const once=(await store.list()).find(j=>j.description==="单次任务");expect(once).toMatchObject({targetAt:"2035-01-02T01:00:00.000Z",runOnce:true,deliveryMode:"agent"});
    await mobile.locator(".schedule-item").filter({hasText:"单次任务"}).getByRole("button",{name:"删除",exact:true}).click();
    await mobile.getByRole("button",{name:"确认删除任务",exact:true}).click();await expect(mobile.locator(".schedule-item")).toHaveCount(1);expect(await hub.store.conversations("owner")).toHaveLength(2);
    // A supported legacy record with no targetAt stays visible alongside healthy
    // jobs and opens an empty time input, without inventing a next execution.
    const healthy = (await store.list())[0]!;
    const legacy = await store.add({ channel:"lark",chatId:healthy.chatId,userId:healthy.userId,larkChatId:healthy.larkChatId,cronExpr:healthy.cronExpr,prompt:"保留旧提醒内容",description:"旧单次任务",runOnce:true,enabled:false,timezone:"Asia/Shanghai" });
    await mobile.getByRole("button",{name:"刷新",exact:true}).click();await expect(mobile.locator(".schedule-item")).toHaveCount(2);
    const missing = mobile.locator(".schedule-item").filter({hasText:"旧单次任务"});
    await expect(missing.getByRole("alert")).toHaveText("执行时间缺失，请编辑或删除此任务。");
    await expect(missing.locator(".schedule-next")).toContainText("需要修复");
    await expect(missing.getByRole("button",{name:"启用任务",exact:true})).toBeDisabled();
    await missing.getByRole("button",{name:"编辑",exact:true}).click();
    await expect(mobile.getByLabel("执行日期与时间",{exact:true})).toHaveValue("");
    await mobile.getByLabel("执行日期与时间",{exact:true}).fill("2036-01-02T09:00");
    await mobile.getByRole("button",{name:"保存修改",exact:true}).click();await expect(missing).toBeVisible();
    await expect(missing.getByRole("alert")).toHaveCount(0);
    expect((await store.get(legacy.id))?.targetAt).toBe("2036-01-02T01:00:00.000Z");
    await missing.getByRole("button",{name:"删除",exact:true}).click();
    await mobile.getByRole("button",{name:"确认删除任务",exact:true}).click();await expect(mobile.locator(".schedule-item")).toHaveCount(1);
    expect(await store.get(healthy.id)).toEqual(healthy);
    await gateway.disconnect();await mobile.getByRole("button",{name:"刷新",exact:true}).click();await expect(mobile.getByRole("alert")).toContainText("调度器尚未连接");await expect(mobile.getByRole("button",{name:"启用任务",exact:true})).toBeDisabled();
    expect(errors).toEqual([]);
  } finally {await Promise.allSettled([desktopContext.close(),phoneContext.close()]);await scheduler.stop();await gateway.disconnect();await hub.close();await rm(root,{recursive:true,force:true});}
});
