import { test, expect, type Page } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
let server: ViteDevServer;
test.beforeAll(async()=>{server=await createServer({server:{host:"127.0.0.1",port:0}});await server.listen();});
test.afterAll(async()=>{await server?.close();});
const entry=(page:Page)=>page.locator(".conversation-header").getByRole("button",{name:"查看屏幕",exact:true});
const panel=(page:Page)=>page.getByRole("complementary",{name:"远程屏幕",exact:true});

test("toolbar opens the current Host without capture; close/reopen and Host switching preserve scope and draft",async({page},info)=>{
 await page.goto(server.resolvedUrls!.local[0]+"e2e/fixtures/screen-entry.html");
 const draft=page.getByRole("textbox",{name:"消息",exact:true});await draft.fill("保留主聊天草稿");
 await expect(entry(page)).toBeVisible();await expect(entry(page)).toHaveAttribute("aria-expanded","false");
 const toolbar=page.locator(".conversation-header");await toolbar.screenshot({path:info.outputPath("screen-shortcut-header.png")});
 await entry(page).click();await expect(panel(page)).toBeVisible();await expect(entry(page)).toHaveAttribute("aria-expanded","true");
 await expect(panel(page).getByRole("button",{name:"连接屏幕",exact:true})).toBeEnabled();
 expect(await page.evaluate(()=>(window as any).screenEntryFixture.calls.filter((v:string)=>/^(open|configure):/.test(v)))).toEqual([]);
 await page.screenshot({path:info.outputPath("screen-shortcut-open.png")});
 await page.setViewportSize({width:1000,height:900});
 await expect(entry(page)).toBeInViewport();
 expect(await toolbar.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
 await toolbar.screenshot({path:info.outputPath("screen-shortcut-narrow-header.png")});
 await entry(page).click();await expect(panel(page)).toHaveCount(0);await expect(draft).toHaveValue("保留主聊天草稿");
 await entry(page).click();await panel(page).getByRole("button",{name:"连接屏幕",exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).screenEntryFixture.calls.filter((v:string)=>v.startsWith("open:")))).toEqual(["open:a"]);
 await page.getByRole("button",{name:"Switch fixture host"}).click();await expect(panel(page)).toHaveCount(0);
 await entry(page).click();await panel(page).getByRole("button",{name:"连接屏幕",exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).screenEntryFixture.calls.filter((v:string)=>v.startsWith("open:")))).toEqual(["open:a","open:b"]);
 expect(await page.evaluate(()=>(window as any).screenEntryFixture.calls.filter((v:string)=>v.startsWith("configure:")))).toEqual([]);
});

test("unready shortcut stays discoverable, explains readiness and opens settings without granting access",async({page})=>{
 await page.goto(server.resolvedUrls!.local[0]+"e2e/fixtures/screen-entry.html");await expect(entry(page)).toBeVisible();
 await page.evaluate(()=>{(window as any).screenEntryFixture.statuses.a.permission="none";});await entry(page).click();
 await expect(panel(page).getByText("请在目标 Mac 的远程屏幕设置中授权此设备。",{exact:true})).toBeVisible();
 await expect(panel(page).getByRole("button",{name:"连接屏幕",exact:true})).toBeDisabled();
 await panel(page).getByRole("button",{name:"连接设置",exact:true}).click();
 await expect(page.getByRole("dialog",{name:"连接状态与线路",exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).screenEntryFixture.calls.filter((v:string)=>/^(open|configure):/.test(v)))).toEqual([]);
 await page.getByRole("button",{name:"关闭连接状态与线路",exact:true}).click();
 await page.evaluate(()=>{const f=(window as any).screenEntryFixture;f.statuses.a.permission="view";f.statuses.a.desktop=null;window.dispatchEvent(new Event("focus"));});
 await expect(panel(page).getByText("主机在线，但桌面服务未运行。请在目标 Mac 打开 TaroBird。",{exact:true})).toBeVisible();
 await expect(panel(page).getByRole("button",{name:"连接屏幕",exact:true})).toBeDisabled();
});

test("phone and non-Electron headers do not offer an unsupported viewer",async({page})=>{
 await page.goto(server.resolvedUrls!.local[0]+"e2e/fixtures/screen-entry.html?web");
 await expect(page.locator(".conversation-header")).toBeVisible();await expect(entry(page)).toHaveCount(0);
 await page.setViewportSize({width:390,height:844});await page.goto(server.resolvedUrls!.local[0]+"e2e/fixtures/screen-entry.html");
 await page.getByRole("listitem").filter({hasText:"主机 A 的工作对话"}).getByRole("button").click();
 await expect(page.getByRole("textbox",{name:"消息",exact:true})).toBeVisible();await expect(entry(page)).toHaveCount(0);
});
