import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";

test.use({ serviceWorkers: "block" });
async function fixture(page: Page, english = false, legacy = false, options: { recoveredPreview?: boolean; settingsUnavailable?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "browser-page-tools-"));
  const hub = await HubServer.start({ stateDir: directory, clientDir: path.resolve("dist") });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','网页助手','fixture')");
  const conversation = await hub.store.createConversation("owner", ["alpha"], "网页工具验收", "browser_tools_chat");
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, conversation.title);
  await page.evaluate(({ legacy, options }) => {
    const tabs = new Map<string, any>(), listeners = new Set<(event: any) => void>(); let requestId = 0;
    const data = { calls: [] as any[], layouts: [] as any[], tabs, listeners, settingsUnavailable: !!options.settingsUnavailable, receiptFind: false, cancelReason: "", failClear: false, holdSave: false, cancelSave: false, printError: false, releaseSave: undefined as (() => void) | undefined,
      settings: { searchEngine: "google", defaultZoom: 1, recordHistory: true }, history: [{id:"visit-1",url:"https://example.com/reference",title:"参考文档",visitedAt:1700000000000},{id:"visit-2",url:"https://example.com/another",title:"其他页面",visitedAt:1700000001000}], clearCount:0 };
    const emit = (event: any) => listeners.forEach(receive => receive(event));
    Object.assign(window, { pageToolsFixture:data, tarobotDesktop: {
      version: 1, engine: "electron", platform: "darwin", openSocket: async () => { throw Error("unexpected_socket"); },
      on: (event: string, receive: (payload: any) => void) => { if (event === "workbench-browser") listeners.add(receive); return () => listeners.delete(receive); },
      invoke: async (command: string, args: any) => {
        if (command === "workbench_browser_layout") { data.layouts.push(args); return; }
        if (command !== "workbench_browser") return;
        data.calls.push(structuredClone(args));
        const result = (extra: any = {}) => ({status:"ok",...extra});
        const state = (tab: any) => { emit({...tab,kind:"state"}); return result(tab); };
        if (args.action === "capabilities") { if (options.recoveredPreview && !tabs.size) tabs.set("recovered-page",{tab:"recovered-page",scope:args.scope,url:"https://example.test/recovered",title:"已恢复网页",state:"live",navigation:1,zoomFactor:1,devicePreview:{preset:"phone",landscape:false,width:390,height:844,scale:.75}}); return result({window:"native-window",actions:legacy?[]:["find","stop_find","zoom","device","print","save_screenshot","history","clear_history","settings","settings_set"]}); }
        if (args.action === "list") return result({tabs:[...tabs.values()]});
        if (args.action === "settings") return data.settingsUnavailable ? {status:"failed",error:"settings_unavailable"} : result({settings:data.settings});
        if (args.action === "settings_set") { data.settingsUnavailable=false; data.settings=structuredClone(args.settings); emit({kind:"settings",scope:args.scope,settings:data.settings}); return result({settings:data.settings}); }
        if (args.action === "history") return result({entries:data.history});
        if (args.action === "clear_history") {data.history=[];data.clearCount++;return result();}
        if (args.action === "downloads") return result({downloads:[{download:"item-1",name:"报告.pdf",state:"completed",received:2048,total:2048}]});
        if (args.action === "clear_data") return data.failClear ? {status:"failed",error:"browser_clear_failed"} : result();
        if (args.action === "open") { const tab={tab:args.tab,scope:args.scope,url:args.url === "about:blank" ? `https://example.test/page-${tabs.size+1}` : args.url,title:`示例网页 ${tabs.size+1}`,state:"live",navigation:1,zoomFactor:data.settings.defaultZoom,canGoBack:false,canGoForward:false};tabs.set(args.tab,tab);queueMicrotask(()=>state(tab));return result(tab); }
        const tab=tabs.get(args.tab);
        if (args.action === "navigate") {tab.url=args.url;tab.navigation++;return state(tab);}
        if (args.action === "zoom") {tab.zoomFactor=args.factor;return state(tab);}
        if (args.action === "device") {let width=args.preset==='phone'?390:args.preset==='tablet'?768:0,height=args.preset==='phone'?844:args.preset==='tablet'?1024:0;if(args.landscape)[width,height]=[height,width];tab.devicePreview={preset:args.preset,landscape:!!args.landscape,width,height,scale:1};return state(tab);}
        if (args.action === "find") {const id=requestId++,find={requestId:id,matches:args.text==='missing'?0:3,activeMatchOrdinal:args.text==='missing'?0:args.findNext?1:2,finalUpdate:true};if (!data.receiptFind) queueMicrotask(()=>emit({kind:"find",tab:args.tab,scope:args.scope,navigation:tab.navigation,...find}));return result({findRequestId:id,...(data.receiptFind?{find,navigation:tab.navigation}:{})});}
        if ((args.action === "print" || args.action === "save_screenshot") && data.holdSave) await new Promise<void>(resolve=>{data.releaseSave=resolve;});
        if ((args.action === "print" || args.action === "save_screenshot") && data.cancelSave) return {status:"cancelled",...(data.cancelReason?{error:data.cancelReason}:{})};
        if (args.action === "print" && args.mode !== "pdf" && data.printError) return {status:"failed",error:"print_no_printers"};
        if (args.action === "print") return result({saved:args.mode==='pdf'});
        if (args.action === "save_screenshot") return result({saved:true,name:"page.png"});
        return result();
      },
    }});
  }, { legacy, options });
  if (english) { await openSettings(page,"general"); await page.locator("#language").selectOption("en"); await closeSettings(page,true); }
  await page.getByRole("button", { name: english ? "Workbench" : "工作台", exact: true }).click();
  const wb=page.getByRole("complementary",{name:english?"Workbench":"工作台",exact:true});
  if (options.recoveredPreview) await wb.getByRole("tab",{name:"已恢复网页",exact:true}).click();
  else { await wb.getByRole("button", {name:english?"Webpage":"网页",exact:true}).click(); await expect(wb.getByRole("tab",{name:"示例网页 1",exact:true})).toBeVisible(); }
  return {wb, conversationId:conversation.id, close:async()=>{await page.close();await hub.close();await rm(directory,{recursive:true,force:true});}};
}
const current = (page:Page,name="示例网页 1") => page.getByRole("tabpanel",{name,exact:true});
async function tools(page:Page, title="示例网页 1", english=false) {await current(page,title).getByRole("button",{name:english?"Page tools and downloads":"网页工具与下载",exact:true}).click();return page.getByRole("menu",{name:english?"Page tools":"网页工具",exact:true});}

test("page menu exposes tools without password import; find keeps the page target and ignores late results",async({page},info)=>{
  const f=await fixture(page);
  try {
    const menu=await tools(page);
    for(const name of ["在页面中查找","打印…","保存为 PDF…","设备预览","保存网页截图…","下载","历史记录","清除浏览数据…","浏览器设置"]) await expect(menu.getByRole("button",{name,exact:true})).toBeVisible();
    await expect(menu.getByText(/密码|自动填充|导入/)).toHaveCount(0);
    await page.screenshot({path:info.outputPath("browser-tools-menu.png")});
    await menu.getByRole("button",{name:"在页面中查找",exact:true}).click();
    const input=current(page).getByRole("textbox",{name:"查找内容",exact:true}); await expect(input).toBeFocused();await input.fill("apple");
    await expect(current(page).getByRole("status")).toHaveText("1 / 3");
    await current(page).getByRole("button",{name:"下一个匹配",exact:true}).click();await expect(current(page).getByRole("status")).toHaveText("2 / 3");
    await input.fill("missing");await expect(current(page).getByRole("status")).toHaveText("无匹配");
    await page.evaluate(()=>{const f=(window as any).pageToolsFixture,tab=[...f.tabs.values()][0] as any;f.listeners.forEach((send:any)=>send({kind:"find",tab:tab.tab,scope:tab.scope,navigation:tab.navigation,requestId:1,matches:99,activeMatchOrdinal:99,finalUpdate:true}));});
    await expect(current(page).getByRole("status")).toHaveText("无匹配");
    await input.press("Escape");await expect(input).toHaveCount(0);await expect(current(page).getByRole("button",{name:"网页工具与下载",exact:true})).toBeFocused();
    await expect.poll(()=>page.evaluate(()=>(window as any).pageToolsFixture.calls.filter((c:any)=>c.action==='stop_find').length)).toBeGreaterThan(0);
    await current(page).getByRole("textbox",{name:"网址或搜索",exact:true}).focus();await page.keyboard.press("Control+f");await expect(input).toBeVisible();
  }finally{await f.close();}
});

test("zoom and device preview apply only to their split page and can be reset",async({page},info)=>{
  const f=await fixture(page);
  try{
    await f.wb.getByRole("button",{name:"新建内容",exact:true}).click();await f.wb.getByRole("button",{name:"新建网页",exact:true}).click();
    await f.wb.getByRole("button",{name:"分屏",exact:true}).click();
    // Splitting first asks which tabs to show (3e597a0); the new page is preselected.
    const picker=page.getByRole("dialog",{name:"选择分屏标签",exact:true});await picker.getByRole("checkbox",{name:"示例网页 1",exact:true}).check();await picker.getByRole("button",{name:"应用分屏",exact:true}).click();
    let menu=await tools(page);
    await menu.getByRole("button",{name:"放大网页",exact:true}).click();await expect(menu.getByRole("button",{name:"重置网页缩放",exact:true})).toHaveText("110%");
    const zooms=await page.evaluate(()=>[...(window as any).pageToolsFixture.tabs.values()].map((t:any)=>t.zoomFactor));expect(zooms).toEqual([1.1,1]);
    await menu.getByRole("button",{name:"重置网页缩放",exact:true}).click();await expect(menu.getByRole("button",{name:"重置网页缩放",exact:true})).toHaveText("100%");
    await menu.getByRole("button",{name:"设备预览",exact:true}).click();await current(page).getByRole("combobox",{name:"预览设备",exact:true}).selectOption("phone");
    await expect(current(page).locator(".browser-device-bar")).toContainText("390 × 844");await current(page).getByRole("button",{name:"切换横竖屏",exact:true}).click();await expect(current(page).locator(".browser-device-bar>span")).toHaveText("844 × 390");
    await page.screenshot({path:info.outputPath("browser-device-preview.png")});
    await current(page).getByRole("button",{name:"关闭设备预览",exact:true}).click();await expect(current(page).locator(".browser-device-bar")).toHaveCount(0);
    expect(await page.evaluate(()=>[...(window as any).pageToolsFixture.tabs.values()].map((t:any)=>t.devicePreview?.preset))).toEqual(["desktop",undefined]);
    expect(await page.evaluate(()=>(window as any).pageToolsFixture.calls.filter((c:any)=>['zoom','device'].includes(c.action)).every((c:any)=>c.source==='user'))).toBe(true);
  }finally{await f.close();}
});

test("browser settings change address search and scoped history opens a new tab",async({page},info)=>{
  const f=await fixture(page);
  try{
    let menu=await tools(page);await menu.getByRole("button",{name:"浏览器设置",exact:true}).click();
    const dialog=current(page).getByRole("dialog");await expect(dialog.getByRole("button",{name:"保存",exact:true})).toBeEnabled();
    await dialog.getByRole("combobox",{name:"地址栏搜索引擎",exact:true}).selectOption("duckduckgo");await dialog.getByRole("combobox",{name:"新网页的默认缩放",exact:true}).selectOption("1.25");await dialog.getByLabel("记录浏览历史",{exact:true}).uncheck();
    await page.screenshot({path:info.outputPath("browser-settings.png")});
    await dialog.getByRole("button",{name:"保存",exact:true}).click();await expect(dialog).not.toBeVisible();
    await current(page).getByRole("textbox",{name:"网址或搜索",exact:true}).fill("浏览器测试");await current(page).getByRole("button",{name:"打开网址",exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window as any).pageToolsFixture.calls.findLast((c:any)=>c.action==='navigate')?.url)).toBe("https://duckduckgo.com/?q=%E6%B5%8F%E8%A7%88%E5%99%A8%E6%B5%8B%E8%AF%95");
    menu=await tools(page);await menu.getByRole("button",{name:"历史记录",exact:true}).click();
    await dialog.getByRole("textbox",{name:"搜索浏览历史",exact:true}).fill("参考");await expect(dialog.locator(".browser-history-list>li")).toHaveCount(1);
    await dialog.locator(".browser-history-list button").click();await expect(f.wb.getByRole("tab")).toHaveCount(2);
    const last=await page.evaluate(()=>(window as any).pageToolsFixture.calls.findLast((c:any)=>c.action==='open'));expect(last.url).toBe("https://example.com/reference");expect(last.scope.conversation).toBe(f.conversationId);
  }finally{await f.close();}
});

test("partial data clearing reports success precisely and retries only the remaining data",async({page})=>{
  const f=await fixture(page);
  try{
    await page.evaluate(()=>(window as any).pageToolsFixture.failClear=true);
    let menu=await tools(page);await menu.getByRole("button",{name:"清除浏览数据…",exact:true}).click();
    const dialog=current(page).getByRole("dialog");await dialog.getByLabel("网站与部分扩展数据",{exact:true}).check();
    await expect(dialog).toContainText("扩展安装与访问授权保留");
    await dialog.getByRole("button",{name:"清理所选数据",exact:true}).click();await expect(dialog.getByRole("alert")).toContainText("网站数据清理未完成");
    await expect(dialog.getByRole("status")).toHaveText("历史记录已清理");await expect(dialog.getByLabel("浏览历史",{exact:true})).not.toBeChecked();
    await expect(dialog.getByLabel("网站与部分扩展数据",{exact:true})).toBeChecked();
    await page.evaluate(()=>(window as any).pageToolsFixture.failClear=false);
    await dialog.getByRole("button",{name:"清理所选数据",exact:true}).click();await expect(dialog).not.toBeVisible();
    expect(await page.evaluate(()=>(window as any).pageToolsFixture.clearCount)).toBe(1);
    menu=await tools(page);await menu.getByRole("button",{name:"下载",exact:true}).click();await expect(dialog.getByText("报告.pdf",{exact:true})).toBeVisible();
    await dialog.getByRole("button",{name:"显示文件",exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).pageToolsFixture.calls.findLast((c:any)=>c.action==='download_reveal')?.download)).toBe("item-1");
  }finally{await f.close();}
});

test("PDF saving, cancellation and late screenshot completion do not claim success on another page",async({page})=>{
  const f=await fixture(page);
  try{
    await page.evaluate(()=>(window as any).pageToolsFixture.printError=true);
    let menu=await tools(page);await menu.getByRole("button",{name:"打印…",exact:true}).click();
    await expect(current(page).getByRole("alert")).toContainText("未找到可用打印机");
    await expect(current(page).getByRole("alert")).toContainText("保存为 PDF");
    await current(page).getByRole("button",{name:"关闭提示",exact:true}).click();
    menu=await tools(page);await menu.getByRole("button",{name:"保存为 PDF…",exact:true}).click();await expect(current(page).getByRole("status")).toHaveText("PDF 已保存");
    await current(page).getByRole("button",{name:"关闭提示",exact:true}).click();
    await page.evaluate(()=>(window as any).pageToolsFixture.cancelSave=true);
    menu=await tools(page);await menu.getByRole("button",{name:"保存网页截图…",exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window as any).pageToolsFixture.calls.filter((c:any)=>c.action==='save_screenshot').length)).toBe(1);
    await expect(current(page).getByText("截图已保存",{exact:true})).toHaveCount(0);
    await page.evaluate(()=>{(window as any).pageToolsFixture.cancelSave=false;(window as any).pageToolsFixture.holdSave=true;});
    menu=await tools(page);await menu.getByRole("button",{name:"保存网页截图…",exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>typeof (window as any).pageToolsFixture.releaseSave)).toBe("function");
    await f.wb.getByRole("button",{name:"新建内容",exact:true}).click();await f.wb.getByRole("button",{name:"新建网页",exact:true}).click();await expect(current(page)).toBeHidden();
    await page.evaluate(()=>(window as any).pageToolsFixture.releaseSave());await expect(current(page,"示例网页 2").getByText("截图已保存",{exact:true})).toHaveCount(0);
    await f.wb.getByRole("tab",{name:"示例网页 1",exact:true}).click();await expect(current(page).getByText("截图已保存",{exact:true})).toHaveCount(0);
  }finally{await f.close();}
});

test("English tools stay inside a narrow viewport and old native versions keep existing downloads usable",async({page},info)=>{
  const f=await fixture(page,true);
  try{
    await page.setViewportSize({width:1000,height:800});let menu=await tools(page,"示例网页 1",true);
    expect(await menu.evaluate(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})).toBe(true);
    await page.screenshot({path:info.outputPath("browser-tools-english.png")});await page.keyboard.press("Escape");
    await page.setViewportSize({width:390,height:844});menu=await tools(page,"示例网页 1",true);await menu.getByRole("button",{name:"Browser settings",exact:true}).click();
    const dialog=current(page).getByRole("dialog");await expect(dialog).toBeVisible();expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);await page.screenshot({path:info.outputPath("browser-settings-narrow.png")});
  }finally{await f.close();}
});

test("legacy native capabilities leave new tools disabled and retain download access",async({page})=>{
  const f=await fixture(page,false,true);
  try{const menu=await tools(page);await expect(menu.getByRole("button",{name:"在页面中查找",exact:true})).toBeDisabled();await expect(menu.getByText(/请更新桌面版/)).toBeVisible();await menu.getByRole("button",{name:"下载",exact:true}).click();await expect(current(page).getByRole("dialog").getByText("报告.pdf",{exact:true})).toBeVisible();}finally{await f.close();}
});


test("native shortcuts preserve page focus and find receipts fill in missing events", async ({page}) => {
  const f=await fixture(page);
  try {
    await page.evaluate(()=>{const f=(window as any).pageToolsFixture;f.receiptFind=true;const tab=[...f.tabs.values()][0] as any;f.listeners.forEach((send:any)=>send({kind:"shortcut",scope:tab.scope,tab:tab.tab,command:"find"}));});
    const input=current(page).getByRole("textbox",{name:"查找内容",exact:true});await expect(input).toBeFocused();await input.fill("needle");
    await expect(current(page).getByRole("status")).toHaveText("1 / 3");
    await input.press("Control+g");await expect(current(page).getByRole("status")).toHaveText("2 / 3");
    await input.press("Control+Shift+g");await expect.poll(()=>page.evaluate(()=>(window as any).pageToolsFixture.calls.findLast((c:any)=>c.action==='find')?.forward)).toBe(false);
    await current(page).getByRole("textbox",{name:"网址或搜索",exact:true}).focus();
    await page.evaluate(()=>{const f=(window as any).pageToolsFixture,tab=[...f.tabs.values()][0] as any;f.listeners.forEach((send:any)=>send({kind:"shortcut",scope:tab.scope,tab:tab.tab,command:"escape"}));});
    await expect(input).toHaveCount(0);await expect(current(page).getByRole("textbox",{name:"网址或搜索",exact:true})).toBeFocused();
    await expect(current(page).getByRole("button",{name:"网页工具与下载",exact:true})).not.toBeFocused();
  } finally {await f.close();}
});

test("recovered native preview exposes its exit bar and sleeping pages explain unavailable actions",async({page})=>{
  const f=await fixture(page,false,false,{recoveredPreview:true});
  try {
    const pane=current(page,"已恢复网页");await expect(pane.getByRole("combobox",{name:"预览设备",exact:true})).toHaveValue("phone");await expect(pane.getByRole("button",{name:"关闭设备预览",exact:true})).toBeVisible();
    await page.evaluate(()=>{const f=(window as any).pageToolsFixture,tab=f.tabs.get("recovered-page");tab.state="sleeping";f.listeners.forEach((send:any)=>send({...tab,kind:"state"}));});
    const menu=await tools(page,"已恢复网页");for(const name of ["在页面中查找","打印…","保存网页截图…"])await expect(menu.getByRole("button",{name,exact:true})).toBeDisabled();await expect(menu.getByText(/网页已休眠/)).toBeVisible();await expect(menu.getByRole("button",{name:"下载",exact:true})).toBeEnabled();
    await page.keyboard.press("Escape");
    await page.evaluate(()=>{const f=(window as any).pageToolsFixture,tab=f.tabs.get("recovered-page");tab.state="live";f.listeners.forEach((send:any)=>{send({...tab,kind:"state"});send({kind:"gone",tab:tab.tab,scope:tab.scope,reason:"unresponsive"});});});
    const crashedMenu=await tools(page,"已恢复网页");await expect(crashedMenu.getByRole("button",{name:"打印…",exact:true})).toBeDisabled();await expect(crashedMenu.getByText("网页暂时无响应，可以重新加载。",{exact:true})).toBeVisible();
    await page.evaluate(()=>{const f=(window as any).pageToolsFixture,tab=f.tabs.get("recovered-page");f.listeners.forEach((send:any)=>send({kind:"state",tab:tab.tab,scope:tab.scope,responsive:true}));});await expect(crashedMenu.getByRole("button",{name:"打印…",exact:true})).toBeEnabled();
  }finally{await f.close();}
});

test("unreadable settings require explicit recovery with history off and reset cancellation is visible",async({page})=>{
  const f=await fixture(page,false,false,{settingsUnavailable:true});
  try {
    let menu=await tools(page);await menu.getByRole("button",{name:"浏览器设置",exact:true}).click();const dialog=current(page).getByRole("dialog");
    await expect(dialog.getByRole("button",{name:"保存",exact:true})).toBeDisabled();await dialog.getByRole("button",{name:"重新读取",exact:true}).click();await expect(dialog.getByRole("alert")).toContainText("无法读取浏览器设置");
    expect(await page.evaluate(()=>(window as any).pageToolsFixture.calls.filter((c:any)=>c.action==='settings_set').length)).toBe(0);
    await dialog.getByRole("button",{name:"重置设置并停用历史记录",exact:true}).click();await expect(dialog.getByLabel("记录浏览历史",{exact:true})).not.toBeChecked();await expect(dialog.getByRole("button",{name:"保存",exact:true})).toBeEnabled();
    expect(await page.evaluate(()=>(window as any).pageToolsFixture.history.length)).toBe(2);await dialog.getByRole("button",{name:"关闭",exact:true}).click();
    await page.evaluate(()=>{const f=(window as any).pageToolsFixture;f.cancelSave=true;f.cancelReason="scope_reset";});menu=await tools(page);await menu.getByRole("button",{name:"保存为 PDF…",exact:true}).click();await expect(current(page).getByRole("alert")).toContainText("本次操作未完成");await expect(current(page).getByText("PDF 已保存",{exact:true})).toHaveCount(0);
  }finally{await f.close();}
});


test("settings broadcasts sync untouched fields without re-enabling history or losing local edits",async({page})=>{
  const f=await fixture(page,false,false,{settingsUnavailable:true});
  try {
    let menu=await tools(page);await menu.getByRole("button",{name:"浏览器设置",exact:true}).click();const dialog=current(page).getByRole("dialog");await expect(dialog.getByRole("button",{name:"保存",exact:true})).toBeDisabled();
    await page.evaluate(()=>{const f=(window as any).pageToolsFixture,tab=[...f.tabs.values()][0] as any;f.settingsUnavailable=false;f.settings={searchEngine:"bing",defaultZoom:1.25,recordHistory:false};f.listeners.forEach((send:any)=>send({kind:"settings",scope:tab.scope,settings:f.settings}));});
    await expect(dialog.getByRole("button",{name:"保存",exact:true})).toBeEnabled();await expect(dialog.getByLabel("记录浏览历史",{exact:true})).not.toBeChecked();await expect(dialog.getByRole("combobox",{name:"地址栏搜索引擎",exact:true})).toHaveValue("bing");
    await dialog.getByRole("combobox",{name:"地址栏搜索引擎",exact:true}).selectOption("duckduckgo");
    await page.evaluate(()=>{const f=(window as any).pageToolsFixture,tab=[...f.tabs.values()][0] as any;f.settings={searchEngine:"baidu",defaultZoom:1.5,recordHistory:false};f.listeners.forEach((send:any)=>send({kind:"settings",scope:tab.scope,settings:f.settings}));});
    await expect(dialog.getByRole("combobox",{name:"地址栏搜索引擎",exact:true})).toHaveValue("duckduckgo");await expect(dialog.getByRole("combobox",{name:"新网页的默认缩放",exact:true})).toHaveValue("1.5");await expect(dialog.getByText(/设置已在其他位置更新/)).toBeVisible();
    await dialog.getByRole("button",{name:"保存",exact:true}).click();expect(await page.evaluate(()=>(window as any).pageToolsFixture.calls.findLast((c:any)=>c.action==='settings_set').settings)).toEqual({searchEngine:"duckduckgo",defaultZoom:1.5,recordHistory:false});
  }finally{await f.close();}
});
