import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

test("message right-click quotes and forwards rich content, with selection, keyboard and lifecycle guards", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "message-context-"));
  const hub = await HubServer.start({stateDir:root,clientDir:path.resolve("dist")});
  const errors:string[]=[]; page.on("pageerror", error=>errors.push(error.message));
  try {
    // Keep this fixture scrollable even with compact message spacing.
    await page.setViewportSize({ width: 1360, height: 600 });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture')");
    const source=await hub.store.createConversation("owner",["alpha"],"天气与行程","source");
    const destination=await hub.store.createConversation("owner",["alpha"],"资料收藏","destination");
    const data=Buffer.from("文件内的行程说明"), name="上海下周天气与行程说明.txt";
    const attachmentId=await hub.attachments.importForBot("alpha",{conversationId:source.id,name,mime:"text/plain",size:data.length,sha256:createHash("sha256").update(data).digest("hex")},data);
    const text="下周天气预报\n\n| 日期 | 天气 | 温度 |\n|---|---|---|\n| 周一 | 晴 | 17–26°C |\n\n```js\nconst forecast = 'sunny';\n```\n\n[数据来源](https://example.com)";
    const message=await hub.store.publishBotMessage("alpha",{conversationId:source.id,blocks:[{type:"card",title:"已完成",elements:[{type:"markdown",text}]},{type:"file",attachmentId,name,mime:"text/plain",size:data.length}]});
    await page.goto(hub.url);await preparePairing(page, hub); await page.getByRole("button",{name:"配对此设备",exact:true}).click();
    await hub.auth.approve(await page.getByLabel("配对码",{exact:true}).innerText(),"local-owner");
    await page.getByLabel("配对码",{exact:true}).waitFor({state:"hidden"}); await showDisconnectedBots(page);await waitForClientOnline(page);await selectConversation(page,source.title);
    await page.evaluate(()=>Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async(text:string)=>{(window as any).copied=text;}}}));
    const row=page.locator(`[data-message-id="${message.id}"]`), menu=page.getByRole("menu",{name:"消息操作",exact:true}), composer=page.getByRole("textbox",{name:"消息",exact:true});
    await composer.fill("保留的草稿");
    for (const surface of [row.locator("td").first(),row.locator("pre"),row.getByRole("region",{name,exact:true}),row.getByRole("link",{name:"数据来源"})]) {
      const viewport = page.locator(".message-scroll"), before = (await viewport.boundingBox())!;
      await surface.click({button:"right"});await expect(menu.getByRole("menuitem",{name:"回复",exact:true})).toBeVisible();await expect(menu.getByRole("menuitem",{name:"转发",exact:true})).toBeEnabled();
      const after = (await viewport.boundingBox())!; expect(after.y).toBe(before.y); expect(after.height).toBe(before.height);
      await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);await expect(row).toBeFocused();
    }
    await row.locator("td").first().click({button:"right"});await page.screenshot({path:info.outputPath("message-context-desktop.png")});
    await menu.getByRole("menuitem",{name:"回复",exact:true}).click();await expect(menu).toHaveCount(0);await expect(composer).toBeFocused();await expect(composer).toHaveValue("保留的草稿");
    await expect(page.locator(".reply-preview")).toContainText(name);
    await composer.fill("请结合引用的行程安排");await page.getByRole("button",{name:"发送消息",exact:true}).click();
    await expect.poll(async()=>(await hub.store.snapshot("owner",source.id)).messages.some(m=>m.replyTo===message.id&&m.authorType==="user")).toBe(true);
    const sent=(await hub.store.snapshot("owner",source.id)).messages.find(m=>m.authorType==="user")!;
    await page.locator(`[data-message-id="${sent.id}"]`).click({button:"right"});await expect(menu.getByRole("menuitem",{name:"回复",exact:true})).toBeEnabled();await page.keyboard.press("Escape");
    await row.locator("pre").click({button:"right"});await menu.getByRole("menuitem",{name:"转发",exact:true}).click();
    const forward=page.getByRole("dialog",{name:"转发消息",exact:true});await expect(forward).toBeVisible();await expect(menu).toHaveCount(0);
    await forward.getByRole("button",{name:destination.title,exact:true}).click();await forward.getByRole("button",{name:"确认转发",exact:true}).click();
    await expect(page.getByRole("heading",{name:destination.title,exact:true})).toBeVisible();
    const forwarded=(await hub.store.snapshot("owner",destination.id)).messages[0]!;expect(forwarded.forwardedFrom?.messageId).toBe(message.id);expect(forwarded.blocks[0]).toEqual(message.blocks[0]);
    expect(forwarded.blocks[1]).toMatchObject({type:"file",name,mime:"text/plain",size:data.length});
    // Forwarding clones the attachment into the target conversation's access scope.
    const forwardedFile=page.locator(`[data-message-id="${forwarded.id}"]`).getByRole("region",{name,exact:true});
    await forwardedFile.getByRole("button",{name:/^预览(?: |$)/}).click();
    await expect(page.getByRole("dialog",{name:"文件预览"}).locator("pre")).toHaveText(data.toString());await page.keyboard.press("Escape");
    await selectConversation(page,source.title);await row.focus();await page.keyboard.press("Shift+F10");await expect(menu.getByRole("menuitem",{name:"回复",exact:true})).toBeFocused();
    await page.keyboard.press("ArrowDown");await expect(menu.getByRole("menuitem",{name:"转发",exact:true})).toBeFocused();await page.keyboard.press("Escape");
    await row.locator("td").first().evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);const s=document.getSelection()!;s.removeAllRanges();s.addRange(range);});
    await row.locator("td").first().getByText("周一",{exact:true}).click({button:"right"});await menu.getByRole("menuitem",{name:"复制所选文本",exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).copied)).toBe("周一");
    await row.click({button:"right"});await menu.getByRole("menuitem",{name:"复制消息",exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).copied)).toContain("const forecast");
    await row.click({button:"right"});await row.locator("td").first().click();await expect(menu).toHaveCount(0);
    await composer.click({button:"right"});await expect(menu).toHaveCount(0);
    // Compact messages may fit at 900px. Require a genuinely scrollable viewport
    // before asserting that a real scroll (rather than a clamped no-op) dismisses.
    await expect.poll(() => page.locator('.message-scroll').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await row.dispatchEvent("contextmenu",{clientX:1357,clientY:897,bubbles:true,cancelable:true});await expect(menu).toBeVisible();
    const bounds=(await menu.boundingBox())!;expect(bounds.x+bounds.width).toBeLessThanOrEqual(1353);expect(bounds.y+bounds.height).toBeLessThanOrEqual(593);
    // A delayed notification of an already-applied scroll must keep the menu.
    await page.locator(".message-scroll").dispatchEvent("scroll"); await expect(menu).toBeVisible();
    await page.locator(".message-scroll").evaluate(element => { element.scrollTop = element.scrollTop > 0 ? 0 : 1; });await expect(menu).toHaveCount(0);
    await row.click({button:"right"});await page.evaluate(id=>window.dispatchEvent(new CustomEvent("tarocub-navigate",{detail:{conversationId:id}})),destination.id);await expect(menu).toHaveCount(0);
    await selectConversation(page,source.title);await row.click({button:"right"});await page.setViewportSize({width:390,height:844});await expect(menu).toHaveCount(0);
    await page.setViewportSize({width:1360,height:900});await row.click({button:"right"});
    await hub.store.publishBotMessage("alpha",{id:message.id,conversationId:source.id,blocks:message.blocks,status:"streaming"});await expect(menu.getByRole("menuitem",{name:"转发",exact:true})).toBeDisabled();
    await hub.store.publishBotMessage("alpha",{id:message.id,conversationId:source.id,blocks:[],status:"deleted"});await expect(menu).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {await hub.close();await rm(root,{recursive:true,force:true});}
});
