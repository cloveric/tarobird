import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { waitForClientOnline, selectConversation } from "./fixtures/mobile.js";

// The test holds a preparation request; service-worker fetches bypass page routes.
test.use({ serviceWorkers: "block" });

async function expectReadablePrimary(button: Locator) {
  await expect(button).toBeVisible();
  // Accessible names alone cannot catch white text on a white button.
  await expect.poll(() => button.evaluate(node => {
    const style = getComputedStyle(node);
    const luminance = (color: string) => {
      const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
        const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
      });
      return rgb[0]! * .2126 + rgb[1]! * .7152 + rgb[2]! * .0722;
    };
    const foreground = luminance(style.color), background = luminance(style.backgroundColor);
    return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
  })).toBeGreaterThanOrEqual(4.5);
}

for (const phone of [false, true]) test(`guided collaboration setup on ${phone ? "phone" : "desktop"} retains task and limits grants`, async ({ page }, info) => {
  test.setTimeout(90_000);
  if (phone) await page.setViewportSize({width:390,height:844});
  const root=await mkdtemp(path.join(os.tmpdir(),"collaboration-setup-")),home=path.join(root,"home");await mkdir(home);
  const hub=await HubServer.start({stateDir:path.join(root,"hub"),clientDir:path.resolve("dist"),managedBots:{entrypoint:path.resolve("../dist/src/index.js"),env:{PATH:process.env.PATH,HOME:home,CODEX_EXECUTABLE:process.execPath}}});
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  let releasePreparation: (() => void) | undefined;
  const config=async(id:string)=>JSON.parse(await readFile(path.join(root,"hub","bots",id,"config.json"),"utf8"));
  const add=async(name:string)=>hub.botManager!.create("owner",{requestId:`setup_${crypto.randomUUID()}`,name,engine:"codex",model:"",effort:"",workspace:""});
  const open=async()=>{
    if(phone){await page.getByRole("button",{name:"更多聊天操作",exact:true}).click();await page.getByRole("dialog",{name:"聊天操作",exact:true}).getByRole("button",{name:"发起 Bot 协作",exact:true}).click();}
    else await page.getByRole("button",{name:"发起 Bot 协作",exact:true}).click();
    return page.getByRole("dialog",{name:"发起 Bot 协作",exact:true});
  };
  try{
    const main=await add("协调助手");const chat=await hub.store.createConversation("owner",[main.id],"协作验收","setup_chat");
    await expect.poll(async()=>(await hub.store.bots("owner")).filter(b=>b.online).length).toBe(1);
    await page.goto(hub.url);await preparePairing(page, hub); await page.getByRole("button",{name:"配对此设备",exact:true}).click();await hub.auth.approve(await page.getByLabel("配对码",{exact:true}).innerText(),"local-owner");await page.getByLabel("配对码",{exact:true}).waitFor({state:"hidden"});await waitForClientOnline(page);await selectConversation(page,chat.title);
    await page.getByRole("textbox",{name:"消息",exact:true}).fill("整理资料，保留我的草稿");
    let dialog=await open();await expect(dialog).toContainText("这台主机还没有其他可协作的 Bot");await expect(dialog.getByRole("combobox",{name:"协作对象",exact:true})).toHaveCount(0);
    await page.screenshot({path:info.outputPath("01-no-members.png")});
    const beta=await add("研究助手"),gamma=await add("复核助手");await expect.poll(async()=>(await hub.store.bots("owner")).filter(b=>b.online).length).toBe(3);
    await dialog.getByRole("button",{name:"刷新协作状态",exact:true}).click();await dialog.getByRole("combobox",{name:"协作对象",exact:true}).selectOption(beta.id);
    await expect(dialog).toContainText("尚未启用协作");await expect(dialog.getByRole("button",{name:"发送协作任务",exact:true})).toBeDisabled();
    await dialog.getByRole("button",{name:"准备这组协作",exact:true}).click();await expect(dialog).toContainText("不会发送任务");await dialog.getByRole("button",{name:"取消",exact:true}).click();expect((await config(main.id)).bus).toBeUndefined();
    await dialog.getByRole("button",{name:"准备这组协作",exact:true}).click();
    const enable = dialog.getByRole("button",{name:"启用并连接",exact:true});
    await expect(enable).toBeEnabled();
    for (const theme of ["light", "dark"]) for (const palette of ["white-green", "cli"]) {
      await page.evaluate(({ theme, palette }) => { document.documentElement.dataset.theme = theme; document.documentElement.dataset.palette = palette; }, { theme, palette });
      await page.mouse.move(0, 0); await expectReadablePrimary(enable);
      await enable.hover(); await expectReadablePrimary(enable);
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; document.documentElement.dataset.palette = "white-green"; });
    await page.mouse.move(0, 0);
    await page.screenshot({path:info.outputPath("02-review-permissions.png"),animations:"disabled"});
    const preparationHeld = new Promise<void>(resolve => { releasePreparation = resolve; });
    let held = false;
    await page.route(`**/api/bots/${main.id}/collaboration`, async route => {
      if (!held && route.request().method() === "GET") { held = true; await preparationHeld; }
      await route.continue();
    });
    await enable.click();
    const preparing = dialog.getByRole("button",{name:"正在准备…",exact:true});
    await expect(preparing).toBeDisabled(); await expectReadablePrimary(preparing);
    await expect(dialog.getByRole("button",{name:"取消",exact:true})).toBeDisabled();
    await expect.poll(() => held).toBe(true);
    expect((await config(main.id)).bus).toBeUndefined();
    await page.screenshot({path:info.outputPath("02-preparing-disabled.png"),animations:"disabled"});
    releasePreparation();
    await expect(dialog.getByRole("button",{name:"发送协作任务",exact:true})).toBeEnabled({timeout:25_000});
    expect((await config(main.id)).bus.peers).toEqual([beta.id]);expect((await config(beta.id)).bus.peers).toEqual([main.id]);expect((await config(gamma.id)).bus).toBeUndefined();expect((await hub.store.snapshot("owner",chat.id)).messages).toHaveLength(0);
    await page.screenshot({path:info.outputPath("03-ready.png")});
    await dialog.getByRole("combobox",{name:"协作方式",exact:true}).selectOption("chain");await dialog.getByRole("checkbox",{name:/研究助手/}).check();await dialog.getByRole("checkbox",{name:/复核助手/}).check();await dialog.getByRole("button",{name:"上移 复核助手",exact:true}).click();
    await expect(dialog.getByRole("list",{name:"执行顺序"}).locator("li").first()).toContainText("复核助手");
    await dialog.getByRole("button",{name:"编辑 协调助手 的协作设置",exact:true}).click();await expect(page.locator(".collaboration-panel")).toBeVisible();
    await page.getByRole("button",{name:"返回协作任务",exact:true}).first().click();dialog=page.getByRole("dialog",{name:"发起 Bot 协作",exact:true});
    await expect(dialog.getByRole("textbox",{name:"协作任务",exact:true})).toHaveValue("整理资料，保留我的草稿");await expect(dialog.getByRole("list",{name:"执行顺序"}).locator("li").first()).toContainText("复核助手");
    expect((await config(main.id)).bus.chain).toEqual([]);
    await dialog.getByRole("button",{name:"准备这组协作",exact:true}).click();await dialog.getByRole("button",{name:"启用并连接",exact:true}).click();await expect(dialog.getByRole("button",{name:"发送协作任务",exact:true})).toBeEnabled({timeout:25_000});
    if(phone){
      await page.evaluate(()=>{document.documentElement.style.setProperty("--app-safe-top","36px");document.documentElement.style.setProperty("--app-safe-bottom","24px");});
      // Phone collaboration is a full-screen surface; safe areas protect the
      // interactive content through padding, not an inset outer dialog.
      const header=await dialog.locator(":scope > header").boundingBox(), footer=await dialog.locator(".delegation-footer").boundingBox();
      expect(header!.y).toBeGreaterThanOrEqual(36);expect(footer!.y+footer!.height).toBeLessThanOrEqual(820);
      await page.setViewportSize({width:390,height:510});await dialog.getByRole("textbox",{name:"协作任务"}).focus();await expect(dialog.getByRole("textbox",{name:"协作任务"})).toBeInViewport();await page.screenshot({path:info.outputPath("04-keyboard.png")});await page.setViewportSize({width:390,height:844});
    }
    await dialog.getByRole("heading",{name:"发起 Bot 协作",exact:true}).focus();await dialog.locator(".delegation-scroll").evaluate(el=>el.scrollTop=0);await page.screenshot({path:info.outputPath("05-chain.png")});
    expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    await dialog.getByRole("button",{name:"关闭协作操作",exact:true}).click();await expect(page.getByRole("textbox",{name:"消息",exact:true})).toHaveValue("整理资料，保留我的草稿");expect(errors).toEqual([]);
  }finally{releasePreparation?.();await page.close();await hub.close();await rm(root,{recursive:true,force:true});}
});
