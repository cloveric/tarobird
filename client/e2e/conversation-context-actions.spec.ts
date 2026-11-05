import { setListOption } from "./fixtures/mobile.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots, openWorkspacePage } from "./fixtures/mobile.js";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";

test.use({ serviceWorkers: "block" });
const workspace = (page: Page) => page.locator(".host-workspace:not([hidden])");
const row = (scope: Page | Locator, title: string) => scope.locator(".conversation-row").filter({ hasText: title });
const menu = (page: Page) => page.getByRole("menu", { name: /^(对话|群组)操作$/ });
const pinned = (scope: Page | Locator) => scope.locator(".global-pin-section");
async function pair(page: Page, hub: HubServer, name = "测试主机", add = false) {
  await hub.profile.update({ name, revision: (await hub.profile.read()).revision });
  if (add) await clickAppAction(page,"连接另一台主机",workspace(page).getByRole("button",{name:"连接另一台主机",exact:true})); else await page.goto(hub.url);
  await page.getByLabel("主机名称",{exact:true}).fill(name); await page.getByLabel("Hub 地址",{exact:true}).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole("button",{name:"配对此设备",exact:true}).click();
  await hub.auth.approve(await page.getByLabel("配对码",{exact:true}).innerText(),"local-owner");
  await page.getByLabel("配对码",{exact:true}).waitFor({state:"hidden"}); await showDisconnectedBots(page);await expect(workspace(page).locator(".connection-pill.online")).toBeVisible();
}
async function seed(hub: HubServer) {
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','测试助手','fixture')");
  await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id,session_id,binding_id) VALUES('same_chat','direct','待整理对话','owner',1,'same_action','existing_session','existing_binding')");
  await hub.store.db.run("INSERT INTO conversation_members VALUES('same_chat','user','owner',0)");
  await hub.store.db.run("INSERT INTO conversation_members VALUES('same_chat','bot','bot',0)");
  await hub.store.publishBotMessage("bot",{conversationId:"same_chat",blocks:[{type:"text",text:"保留的历史消息"}]});
}
async function removeDialog(page: Page, title: string) {
  await row(workspace(page),title).click({button:"right"});await menu(page).getByRole("menuitem",{name:/^删除(对话|群组)$/}).click();
  return page.getByRole("dialog",{name:"删除对话",exact:true});
}
async function restore(page: Page, title: string) {
  await clickAppAction(page,"已归档对话",workspace(page).getByRole("button",{name:/^已归档对话/}));
  const dialog=page.getByRole("dialog",{name:"已归档对话",exact:true});
  await dialog.getByRole("article",{name:title,exact:true}).getByRole("button",{name:"恢复",exact:true}).click();
  await expect(dialog).toHaveCount(0);
}

test("archive dialog keeps its title horizontal and close action at the right edge",async({page},info)=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"archive-dialog-layout-"));
  const hub=await HubServer.start({stateDir:root,clientDir:path.resolve("dist")});
  try {
    await seed(hub);
    await hub.store.updateConversation("owner","same_chat",{archived:true});
    for(let index=0;index<12;index++) {
      const chat=await hub.store.createConversation("owner",["bot"],`归档项目 ${index+1}：较长的对话名称与历史记录`, `archive-${index}`);
      await hub.store.updateConversation("owner",chat.id,{archived:true});
    }
    await pair(page,hub);
    await clickAppAction(page,"已归档对话",workspace(page).getByRole("button",{name:/^已归档对话/}));
    const dialog=page.getByRole("dialog",{name:"已归档对话",exact:true});
    const close=dialog.getByRole("button",{name:"关闭已归档对话",exact:true});
    for(const width of [1360,900,390,320]) {
      await page.setViewportSize({width,height:900});
      await expect(dialog).toBeVisible();
      await dialog.screenshot({path:info.outputPath(`archive-dialog-${width}.png`),animations:"disabled"});
      const geometry=await dialog.evaluate(node=>{
        const heading=node.querySelector("h2")!,header=node.querySelector("header")!;
        const close=header.querySelector("button")!;
        return {titleHeight:heading.getBoundingClientRect().height,fontSize:parseFloat(getComputedStyle(heading).fontSize),
          headerRight:header.getBoundingClientRect().right,closeRight:close.getBoundingClientRect().right,
          closeWidth:close.getBoundingClientRect().width,noOverflow:node.scrollWidth<=node.clientWidth};
      });
      expect(geometry.titleHeight).toBeLessThan(geometry.fontSize*2);
      expect(geometry.closeWidth).toBeLessThanOrEqual(48);
      expect(Math.abs(geometry.headerRight-geometry.closeRight)).toBeLessThanOrEqual(10);
      expect(geometry.noOverflow).toBe(true);
      await expect(close).toBeInViewport();
      const last=dialog.getByRole("article").last();
      await last.getByRole("button",{name:"查看记录",exact:true}).scrollIntoViewIfNeeded();
      await expect(last.getByRole("button",{name:"恢复",exact:true})).toBeInViewport();
      await close.scrollIntoViewIfNeeded();
    }
    await close.click();await expect(dialog).toHaveCount(0);
  }finally{await hub.close();await rm(root,{recursive:true,force:true});}
});

test("phone archives expose history and restore with a durable receipt and offline guard",async({page},info)=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"phone-archives-"));
  const hub=await HubServer.start({stateDir:root,clientDir:path.resolve("dist")});
  let release:(()=>void)|undefined;
  try {
    await seed(hub);
    const other=await hub.store.createConversation("owner",["bot"],"另一条归档对话","other");
    const shared=await hub.store.createConversation("owner",["bot"],"其他成员的对话","shared");
    const history=await hub.store.createConversation("owner",["bot"],"Bot 已删除的历史","history");
    await hub.store.db.run("INSERT INTO users(id,name,role) VALUES('another','另一位成员','member')");
    await hub.store.db.run("UPDATE conversations SET owner_id='another',archived=1 WHERE id=?",[shared.id]);
    await hub.store.updateConversation("owner",history.id,{archived:true});
    await hub.store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='bot'",[history.id]);
    await hub.store.updateConversation("owner","same_chat",{archived:true});
    await hub.store.updateConversation("owner",other.id,{archived:true});
    await pair(page,hub);await page.setViewportSize({width:390,height:844});
    await openWorkspacePage(page,"已归档对话");
    let dialog=page.getByRole("dialog",{name:"已归档对话",exact:true});
    let archived=dialog.getByRole("article",{name:"待整理对话",exact:true});
    await expect(archived.getByRole("button",{name:"恢复",exact:true})).toBeEnabled();
    const sharedRow=dialog.getByRole("article",{name:shared.title,exact:true}), historyRow=dialog.getByRole("article",{name:history.title,exact:true});
    await expect(sharedRow.getByRole("button",{name:"恢复",exact:true})).toBeDisabled();
    await expect(sharedRow).toContainText("仅对话创建者可恢复此对话");
    await expect(historyRow.getByRole("button",{name:"恢复",exact:true})).toBeDisabled();
    await expect(historyRow.getByRole("button",{name:"查看记录",exact:true})).toBeEnabled();
    await archived.getByRole("button",{name:"查看记录",exact:true}).click();
    await expect(workspace(page).getByText("保留的历史消息",{exact:true}).last()).toBeVisible();
    await expect(page.getByRole("dialog",{name:"对话设置",exact:true})).toHaveCount(0);
    expect((await hub.store.conversations("owner")).find(c=>c.id==="same_chat")!.archived).toBe(true);
    await openWorkspacePage(page,"已归档对话");
    dialog=page.getByRole("dialog",{name:"已归档对话",exact:true});
    archived=dialog.getByRole("article",{name:"待整理对话",exact:true});
    await expect(archived.getByRole("button",{name:"恢复",exact:true})).toBeVisible();
    await page.setViewportSize({width:320,height:844});
    expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
    await page.screenshot({path:info.outputPath("phone-archives.png"),animations:"disabled"});
    await expect(archived.getByRole("button",{name:"恢复",exact:true})).toBeInViewport();
    const original=hub.store.updateConversation.bind(hub.store),gate=new Promise<void>(resolve=>{release=resolve;});let restores=0;
    hub.store.updateConversation=async(...args)=>{if(args[1]==="same_chat"&&args[2].archived===false){restores++;await gate;}return original(...args);};
    await archived.getByRole("button",{name:"恢复",exact:true}).evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
    await expect(archived.getByRole("button",{name:"正在恢复…",exact:true})).toBeDisabled();
    await expect(dialog.getByRole("button",{name:"关闭已归档对话",exact:true})).toBeDisabled();
    expect((await hub.store.conversations("owner")).find(c=>c.id==="same_chat")!.archived).toBe(true);
    await expect.poll(()=>restores).toBe(1);release();
    await expect(dialog).toHaveCount(0);
    await expect(workspace(page).getByRole("heading",{name:"待整理对话",exact:true,level:1})).toBeVisible();
    expect((await hub.store.conversations("owner")).find(c=>c.id==="same_chat")).toMatchObject({archived:false,sessionId:"existing_session",bindingId:"existing_binding"});
    await openWorkspacePage(page,"已归档对话");
    dialog=page.getByRole("dialog",{name:"已归档对话",exact:true});
    await expect(dialog.getByRole("article",{name:"待整理对话",exact:true})).toHaveCount(0);
    await hub.close();
    const remaining=dialog.getByRole("article",{name:other.title,exact:true});
    await expect(remaining.getByRole("button",{name:"恢复",exact:true})).toBeDisabled();
    await expect(remaining.getByRole("button",{name:"查看记录",exact:true})).toBeEnabled();
    await expect(dialog).toContainText("连接恢复后即可操作");
  }finally{release?.();await hub.close();await rm(root,{recursive:true,force:true});}
});

test("conversation menu pins durably, confirms recoverable deletion and keeps history, bindings and another draft",async({page,browser},info)=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"conversation-actions-"));
  const hub=await HubServer.start({stateDir:root,clientDir:path.resolve("dist")});const context=await browser.newContext(),observer=await context.newPage();
  let release: (()=>void)|undefined;
  try {
    await seed(hub);await hub.store.createConversation("owner",["bot"],"当前草稿对话","other");
    await pair(page,hub);await pair(observer,hub);
    await row(workspace(page),"当前草稿对话").click();await workspace(page).getByLabel("消息",{exact:true}).fill("不要丢失草稿");
    await row(workspace(page),"待整理对话").locator("strong").click({button:"right"});
    await expect(menu(page).getByRole("menuitem")).toHaveText(["多选","全局置顶","分组置顶","移至分组","重命名F2","删除对话"]);
    await page.screenshot({path:info.outputPath("conversation-menu.png")});await menu(page).getByRole("menuitem",{name:"全局置顶",exact:true}).click();
    await expect(row(pinned(workspace(page)),"待整理对话")).toBeVisible();await expect(row(workspace(page),"待整理对话")).toBeFocused();await expect(workspace(page).getByLabel("消息",{exact:true})).toHaveValue("不要丢失草稿");
    await page.reload();await expect(row(pinned(workspace(page)),"待整理对话")).toBeVisible();
    await row(workspace(page),"待整理对话").press("Shift+F10");await menu(page).getByRole("menuitem",{name:"取消全局置顶",exact:true}).click();await expect(pinned(workspace(page))).toHaveCount(0);
    let dialog=await removeDialog(page,"待整理对话");await expect(dialog.getByRole("button",{name:"取消",exact:true})).toBeFocused();await page.screenshot({path:info.outputPath("delete-dialog-desktop.png"),animations:"disabled"});await dialog.getByRole("button",{name:"取消",exact:true}).click();
    await expect(row(workspace(page),"待整理对话")).toBeFocused();expect((await hub.store.conversations("owner")).find(c=>c.id==="same_chat")!.archived).toBe(false);
    const original=hub.store.updateConversation.bind(hub.store);const gate=new Promise<void>(resolve=>{release=resolve;});
    hub.store.updateConversation=async(...args)=>{if(args[1]==="same_chat" && args[2].archived) await gate;return original(...args);};
    dialog=await removeDialog(page,"待整理对话");await dialog.getByRole("button",{name:"删除对话",exact:true}).click();await expect(dialog.getByRole("button",{name:"正在处理…",exact:true})).toBeDisabled();
    expect((await hub.store.conversations("owner")).find(c=>c.id==="same_chat")!.archived).toBe(false);await expect(dialog).toBeVisible();release();
    await expect(dialog).toHaveCount(0);await expect(row(workspace(page),"待整理对话")).toHaveCount(0);await expect(row(workspace(observer),"待整理对话")).toHaveCount(0);
    await expect(workspace(page).getByLabel("消息",{exact:true})).toHaveValue("不要丢失草稿");
    expect((await hub.store.conversations("owner")).find(c=>c.id==="same_chat")).toMatchObject({archived:true,sessionId:"existing_session",bindingId:"existing_binding",botIds:["bot"]});
    expect(await hub.store.db.get("SELECT COUNT(*) AS count FROM messages WHERE conversation_id='same_chat'")).toEqual({count:1});
    await restore(page,"待整理对话");await expect(row(workspace(observer),"待整理对话")).toBeVisible();await expect(workspace(page).getByText("保留的历史消息",{exact:true}).last()).toBeVisible();
    // Removing the selected chat selects another active chat; removing the last
    // one leaves the welcome view, including after reload, not the archived chat.
    dialog=await removeDialog(page,"待整理对话");await dialog.getByRole("button",{name:"删除对话",exact:true}).click();await expect(dialog).toHaveCount(0);
    await expect(workspace(page).getByRole("heading",{name:"当前草稿对话",exact:true})).toBeVisible();
    dialog=await removeDialog(page,"当前草稿对话");await dialog.getByRole("button",{name:"删除对话",exact:true}).click();await expect(dialog).toHaveCount(0);await expect(workspace(page).getByRole("heading",{name:"欢迎回来",exact:true})).toBeVisible();
    await page.reload();await expect(workspace(page).getByRole("heading",{name:"欢迎回来",exact:true})).toBeVisible();
  } finally {release?.();await context.close();await hub.close();await rm(root,{recursive:true,force:true});}
});

test("context actions use the clicked host even with duplicate conversation IDs",async({page})=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"conversation-action-hosts-"));
  const a=await HubServer.start({stateDir:path.join(root,"a"),clientDir:path.resolve("dist")}),b=await HubServer.start({stateDir:path.join(root,"b"),origins:[a.url]});
  try {
    await seed(a);await seed(b);await pair(page,a,"主机甲");await pair(page,b,"主机乙",true);
    await setListOption(page, '按主机分组', true);
    const target=workspace(page).getByRole("region",{name:"主机：主机甲",exact:true}),other=workspace(page).getByRole("region",{name:"主机：主机乙",exact:true});
    await workspace(page).getByLabel("消息",{exact:true}).fill("乙的草稿");
    await row(target,"待整理对话").click({button:"right"});await menu(page).getByRole("menuitem",{name:"全局置顶",exact:true}).click();
    await expect(row(pinned(workspace(page)),"待整理对话")).toHaveCount(1);await expect(row(pinned(workspace(page)),"待整理对话")).toContainText("主机甲");await expect(row(other,"待整理对话")).toBeVisible();
    await row(pinned(workspace(page)),"待整理对话").click({button:"right"});await menu(page).getByRole("menuitem",{name:/^删除(对话|群组)$/}).click();
    const dialog=page.getByRole("dialog",{name:"删除对话",exact:true});await expect(dialog).toContainText("运行于 主机甲");await dialog.getByRole("button",{name:"删除对话",exact:true}).click();await expect(dialog).toHaveCount(0);
    await expect(row(target,"待整理对话")).toHaveCount(0);await expect(row(other,"待整理对话")).toBeVisible();await expect(workspace(page).getByLabel("消息",{exact:true})).toHaveValue("乙的草稿");
    expect((await a.store.conversations("owner"))[0]!.archived).toBe(true);expect((await b.store.conversations("owner"))[0]!.archived).toBe(false);
  }finally{await a.close();await b.close();await rm(root,{recursive:true,force:true});}
});

test("group removal hides its topics reversibly and offline menus keep local pins usable",async({page})=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"conversation-action-group-")),hub=await HubServer.start({stateDir:root,clientDir:path.resolve("dist")});
  try {
    await seed(hub);const group=await hub.store.createConversation("owner",["bot"],"产品群","group",{type:"group"});
    const topic=await hub.store.createConversation("owner",["bot"],"发布话题","topic",{type:"group",parentId:group.id});
    await pair(page,hub);await row(workspace(page),"发布话题").click();const dialog=await removeDialog(page,"产品群");await expect(dialog).toContainText("一并隐藏，恢复群组后重新显示");await dialog.getByRole("button",{name:"删除对话",exact:true}).click();await expect(dialog).toHaveCount(0);
    await expect(row(workspace(page),"产品群")).toHaveCount(0);await expect(row(workspace(page),"发布话题")).toHaveCount(0);
    expect((await hub.store.conversations("owner")).find(c=>c.id===topic.id)).toMatchObject({archived:false,parentId:group.id});
    await restore(page,"产品群");await expect(row(workspace(page),"发布话题")).toBeVisible();
    await hub.close();await expect(workspace(page).locator(".connection-pill.online")).toHaveCount(0);
    await row(workspace(page),"待整理对话").click({button:"right"});await expect(menu(page).getByRole("menuitem",{name:"删除对话",exact:true})).toBeDisabled();await expect(menu(page).getByRole("menuitem",{name:/^重命名/})).toBeDisabled();
    await menu(page).getByRole("menuitem",{name:"全局置顶",exact:true}).click();await expect(row(pinned(workspace(page)),"待整理对话")).toBeVisible();
  }finally{await hub.close();await rm(root,{recursive:true,force:true});}
});
