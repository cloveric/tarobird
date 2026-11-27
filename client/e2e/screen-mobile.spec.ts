import { test, expect, type Page } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
import en from "../src/locales/en.json" with { type: "json" };
let server: ViteDevServer;
test.beforeAll(async()=>{server=await createServer({server:{host:"127.0.0.1",port:0}});await server.listen();});
test.afterAll(async()=>{await server?.close();});
const url = (platform="ios") => server.resolvedUrls!.local[0]+`e2e/fixtures/screen-mobile.html?platform=${platform}`;
const log = (page: Page) => page.evaluate(()=>(window as any).screenMobileFixture);
test.use({hasTouch:true,viewport:{width:390,height:844}});

for(const [platform,width,height,english] of [["ios",320,568,false],["ios",320,568,true],["android",390,844,false],["android",390,844,true],["ios",844,390,true],["ios",768,1024,false],["android",1024,768,true],["ios",720,540,true]] as const) test(`mobile viewer fits ${platform} ${width}x${height} ${english?"en":"zh"}`,async({browser},info)=>{
  const context=await browser.newContext({viewport:{width,height},locale:english?"en-US":"zh-CN",hasTouch:true,isMobile:true});const page=await context.newPage();const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  const text=(key:string)=>english?(en as Record<string,string>)[key]??key:key;
  try {
    await page.goto(url(platform));const panel=page.getByRole("complementary",{name:text("远程屏幕")});await expect(panel).toBeVisible();
    expect((await log(page)).opens).toBe(0);await panel.getByRole("button",{name:text("连接屏幕"),exact:true}).click();await expect(panel.getByRole("button",{name:text("开始控制"),exact:true})).toBeEnabled();
    const box=await panel.boundingBox();expect(box).toMatchObject({x:0,y:0,width,height});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await panel.locator("button:visible").evaluateAll(nodes=>nodes.every(node=>{const box=node.getBoundingClientRect();return box.height>=44&&box.width>=44&&box.right<=innerWidth&&box.left>=0;}))).toBe(true);
    await page.screenshot({path:info.outputPath("viewer.png")});await panel.getByRole("button",{name:text("键盘与快捷键"),exact:true}).click();
    await expect(panel.getByLabel(text("发送到远端的文本"))).toBeVisible();
    await expect.poll(()=>panel.locator(".screen-viewport").evaluate(node=>{const a=node.getBoundingClientRect(),b=node.querySelector("canvas")!.getBoundingClientRect();return b.width<=a.width+1&&b.height<=a.height+1;})).toBe(true);
    await page.screenshot({path:info.outputPath("keyboard.png")});
    expect((await log(page)).documents).toBe(1);expect((await log(page)).commands.some((value:any)=>value.type==="control"||value.type==="input")).toBe(false);expect(errors).toEqual([]);
  }finally{await context.close();}
});

test("mobile background and lock clear pixels and require explicit reconnect and control",async({page})=>{
  await page.goto(url());await page.getByRole("button",{name:"连接屏幕",exact:true}).click();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
  await page.getByRole("button",{name:"开始控制",exact:true}).click();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();
  await page.evaluate(()=>(window as any).screenMobileActive(false));await expect(page.locator(".screen-mobile")).toBeHidden();await expect(page.locator("canvas")).toHaveAttribute("width","1");
  const before=(await log(page)).opens;await page.evaluate(()=>(window as any).screenMobileActive(true));await expect(page.getByRole("button",{name:"连接屏幕",exact:true})).toBeEnabled();expect((await log(page)).opens).toBe(before);
  await page.getByRole("button",{name:"连接屏幕",exact:true}).click();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toHaveCount(0);
  await page.evaluate(()=>{document.documentElement.dataset.mobileLocked="true";});await expect(page.locator(".screen-mobile")).toBeHidden();await expect(page.locator("canvas")).toHaveAttribute("width","1");
  await page.evaluate(()=>{document.documentElement.dataset.mobileLocked="false";});await expect(page.getByRole("button",{name:"连接屏幕",exact:true})).toBeEnabled();expect((await log(page)).opens).toBe(before+1);
});

test("mobile touches arbitrate tap, long press, drag, scroll and pinch without mouse duplication",async({page,context})=>{
  await page.goto(url("android"));await page.getByRole("button",{name:"连接屏幕",exact:true}).click();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
  const canvas=page.locator("canvas"), bounds=await canvas.boundingBox();const x=bounds!.x+bounds!.width/2,y=bounds!.y+bounds!.height/2;
  await page.touchscreen.tap(x,y);expect((await log(page)).commands.filter((v:any)=>v.type==="input")).toEqual([]);
  await page.getByRole("button",{name:"开始控制",exact:true}).click();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();await page.touchscreen.tap(x,y);
  await expect.poll(async()=> (await log(page)).commands.filter((v:any)=>v.type==="input"&&v.event.kind==="button").map((v:any)=>[v.event.button,v.event.down])).toEqual([[0,true],[0,false]]);
  const cdp=await context.newCDPSession(page);const touch=(type:string,points:{x:number;y:number;id:number}[])=>cdp.send("Input.dispatchTouchEvent",{type,touchPoints:points});
  await touch("touchStart",[{x,y,id:1}]);await page.waitForTimeout(600);await touch("touchEnd",[]);
  await expect.poll(async()=> (await log(page)).commands.filter((v:any)=>v.type==="input"&&v.event.kind==="button").slice(-2).map((v:any)=>[v.event.button,v.event.down])).toEqual([[2,true],[2,false]]);
  await touch("touchStart",[{x,y,id:1}]);await touch("touchMove",[{x:x+30,y:y+20,id:1}]);await touch("touchEnd",[]);
  await expect.poll(async()=> (await log(page)).commands.filter((v:any)=>v.type==="input"&&v.event.kind==="button").slice(-2).map((v:any)=>[v.event.button,v.event.down])).toEqual([[0,true],[0,false]]);
  await touch("touchStart",[{x:x-50,y,id:1},{x:x+50,y,id:2}]);await touch("touchMove",[{x:x-50,y:y+30,id:1},{x:x+50,y:y+30,id:2}]);await page.waitForTimeout(40);await touch("touchEnd",[]);
  await expect.poll(async()=> (await log(page)).commands.filter((v:any)=>v.type==="input"&&v.event.kind==="wheel").length).toBeGreaterThan(0);
  await touch("touchStart",[{x:x-50,y,id:1},{x:x+50,y,id:2}]);await touch("touchMove",[{x:x-70,y,id:1},{x:x+70,y,id:2}]);await page.waitForTimeout(40);await touch("touchEnd",[]);
  expect(await canvas.evaluate(node=>getComputedStyle(node).transform)).not.toContain("matrix(1,");
  expect((await log(page)).commands.filter((v:any)=>v.type==="input"&&v.event.kind==="button")).toHaveLength(6);
  await cdp.detach();
});

test("mobile IME sends only explicitly committed text and background drops the draft",async({page})=>{
  await page.goto(url());await page.getByRole("button",{name:"连接屏幕",exact:true}).click();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
  await page.getByRole("button",{name:"键盘与快捷键",exact:true}).click();const editor=page.getByLabel("发送到远端的文本");await editor.fill("中文候选");
  await expect(page.getByRole("button",{name:"发送到远端",exact:true})).toBeDisabled();await page.getByRole("button",{name:"开始控制",exact:true}).click();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();
  await editor.focus();await editor.dispatchEvent("compositionstart");await expect(page.getByRole("button",{name:"发送到远端",exact:true})).toBeDisabled();await expect(page.getByText("请先在键盘上确认候选词，再发送。",{exact:true})).toBeVisible();expect((await log(page)).commands.filter((v:any)=>v.type==="input"&&v.event.kind==="text")).toEqual([]);
  await editor.dispatchEvent("compositionend");await page.getByRole("button",{name:"发送到远端",exact:true}).click();
  await expect.poll(async()=> (await log(page)).commands.filter((v:any)=>v.type==="input"&&v.event.kind==="text").map((v:any)=>v.event.text)).toEqual(["中文候选"]);await expect(editor).toHaveValue("");
  await editor.fill("不应重发的草稿");await editor.dispatchEvent("compositionstart");await expect(page.getByText("请先在键盘上确认候选词，再发送。",{exact:true})).toBeVisible();await page.evaluate(()=>(window as any).screenMobileActive(false));await page.evaluate(()=>(window as any).screenMobileActive(true));await expect(editor).toHaveValue("");await expect(page.getByText("请先在键盘上确认候选词，再发送。",{exact:true})).toHaveCount(0);
  await expect(page.getByLabel("Local chat draft")).toHaveValue("Local draft stays local");
});

test("mobile native open completing after hide cannot revive its viewer",async({page})=>{
  await page.goto(url());await expect(page.getByRole("button",{name:"连接屏幕",exact:true})).toBeEnabled();await page.evaluate(()=>{(window as any).screenMobileFixture.delayOpen=true;});await page.getByRole("button",{name:"连接屏幕",exact:true}).click();
  await expect.poll(async()=> (await log(page)).opens).toBe(1);await page.evaluate(()=>(window as any).screenMobileFixture.hide());await expect(page.locator(".screen-mobile")).toBeHidden();
  await page.evaluate(()=>(window as any).screenMobileFixture.resumeOpen());await page.evaluate(()=>(window as any).screenMobileFixture.show());await expect(page.getByRole("button",{name:"连接屏幕",exact:true})).toBeEnabled();
  expect((await log(page)).opens).toBe(1);expect((await log(page)).commands.some((v:any)=>v.type==="control")).toBe(false);await expect(page.locator("canvas")).toHaveAttribute("width","1");
});

test("an older native App fails closed with an update explanation",async({page})=>{
  await page.goto(url()+"&old-native=1");await page.getByRole("button",{name:"连接屏幕",exact:true}).click();
  await expect(page.locator(".screen-state")).toContainText("请更新此设备上的 TaroBird");expect((await log(page)).opens).toBe(0);expect((await log(page)).documents).toBe(1);
  expect((await log(page)).calls.filter((v:any)=>v.method==="screenOpen"||v.method==="socketOpen")).toEqual([]);
});

for (const platform of ["android", "ios"]) test(`${platform} external keyboard maps hardware modifiers before sending to Mac`, async ({ page }) => {
  await page.goto(url(platform)); await page.getByRole("button", { name: "连接屏幕", exact: true }).click(); await expect(page.getByRole("button", { name: "开始控制", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "开始控制", exact: true }).click(); await expect(page.getByRole("button", { name: "停止控制", exact: true })).toBeVisible();
  const canvas = page.locator("canvas"); await canvas.focus();
  for (const code of ["ControlLeft", "MetaRight"]) { await canvas.dispatchEvent("keydown", { code }); await canvas.dispatchEvent("keyup", { code }); }
  await expect.poll(async () => (await log(page)).commands.filter((value: any) => value.type === "input" && value.event.kind === "key").map((value: any) => [value.event.code, value.event.down])).toEqual(platform === "android"
    ? [["MetaLeft", true], ["MetaLeft", false], ["ControlRight", true], ["ControlRight", false]]
    : [["ControlLeft", true], ["ControlLeft", false], ["MetaRight", true], ["MetaRight", false]]);
});

for (const platform of ["android", "ios"]) for (const pointer of ["mouse", "touch"] as const) test(`${platform} ${pointer} focus stays within the keyboard tray, and outside focus releases control`, async ({ page }, info) => {
  await page.goto(url(platform)); await page.getByRole("button", { name: "连接屏幕", exact: true }).click(); await page.getByRole("button", { name: "开始控制", exact: true }).click();
  const stop = page.getByRole("button", { name: "停止控制", exact: true }); await expect(stop).toBeVisible();
  await page.evaluate(() => {
    const trace: unknown[] = []; (window as any).screenFocusTrace = trace;
    const describe = (target: EventTarget | null) => target instanceof HTMLElement ? target.getAttribute("aria-label") || target.tagName : null;
    for (const type of ["pointerdown", "mousedown", "blur", "focusout", "focus", "focusin", "click"]) document.addEventListener(type, event => {
      const record = { type, target: describe(event.target), related: describe((event as FocusEvent).relatedTarget), active: describe(document.activeElement) }; trace.push(record);
      if (type === "blur" || type === "focusout") queueMicrotask(() => trace.push({ ...record, phase: "microtask", active: describe(document.activeElement) }));
    }, true);
  });
  try {
    const keyboard = page.getByRole("button", { name: "键盘与快捷键", exact: true });
    await (pointer === "touch" ? keyboard.tap() : keyboard.click()); await expect(stop).toBeVisible();
    const editor = page.getByLabel("发送到远端的文本"); await (pointer === "touch" ? editor.tap() : editor.click()); await editor.fill("中文明确提交"); await expect(stop).toBeVisible();
    const send = page.getByRole("button", { name: "发送到远端", exact: true });
    await editor.dispatchEvent("compositionstart"); await expect(send).toBeDisabled();
    const disabledSend = await send.boundingBox(); expect(disabledSend).not.toBeNull();
    const sendX = disabledSend!.x + disabledSend!.width / 2, sendY = disabledSend!.y + disabledSend!.height / 2;
    // A real pointer can hit a disabled element; locator.click/tap would wait for it to enable.
    await (pointer === "touch" ? page.touchscreen.tap(sendX, sendY) : page.mouse.click(sendX, sendY));
    await expect(editor).toBeFocused(); await expect(stop).toBeVisible(); await expect(send).toBeDisabled();
    expect((await log(page)).commands.filter((value: any) => value.type === "input" && value.event.kind === "text")).toEqual([]);
    await editor.dispatchEvent("compositionend"); await expect(send).toBeEnabled(); await (pointer === "touch" ? send.tap() : send.click());
    await expect.poll(async () => (await log(page)).commands.filter((value: any) => value.type === "input" && value.event.kind === "text").map((value: any) => value.event.text)).toEqual(["中文明确提交"]);
    await expect(stop).toBeVisible();
    await page.getByLabel("Local chat draft").focus(); await expect(page.getByRole("button", { name: "开始控制", exact: true })).toBeVisible();
    expect((await log(page)).commands.filter((value: any) => value.type === "release")).toHaveLength(1);
  } finally { await info.attach("focus-order", { body: JSON.stringify(await page.evaluate(() => (window as any).screenFocusTrace), null, 2), contentType: "application/json" }); }
});

for(const english of [false,true]) for(const [reason,zh] of [
  ["screen_disabled","请先在目标电脑开启允许远程屏幕。"],
  ["screen_not_authorized","请在目标电脑的远程屏幕设置中授权此设备。"],
  ["screen_service_offline","主机在线，但桌面服务未运行。请在目标电脑打开 TaroBird。"],
] as const) test(`unknown target ${reason} keeps mobile guidance neutral (${english?"en":"zh"})`,async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844},locale:english?"en-US":"zh-CN",hasTouch:true,isMobile:true}),page=await context.newPage();
  try {
    await page.goto(url("android")+`&blocked=${reason}`);
    await expect(page.locator(".screen-state").first()).toHaveText(english?en[zh]:zh);
    await expect(page.locator(".screen-state").first()).not.toContainText("Mac");
    await expect(page.getByRole("button",{name:english?en["连接屏幕"]:"连接屏幕",exact:true})).toBeDisabled();
    expect((await log(page)).opens).toBe(0);
  } finally {await context.close();}
});

test("completed touch capture preserves double and triple taps through the native transport",async({page})=>{
  await page.goto(url("ios"));await page.getByRole("button",{name:"连接屏幕",exact:true}).tap();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
  await page.getByRole("button",{name:"开始控制",exact:true}).tap();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();
  const bounds=await page.locator("canvas").boundingBox();const x=bounds!.x+bounds!.width/2,y=bounds!.y+bounds!.height/2;
  for(let i=0;i<3;i++)await page.touchscreen.tap(x,y);
  await expect.poll(async()=>(await log(page)).commands.filter((value:any)=>value.type==="input"&&value.event.kind==="button").map((value:any)=>[value.event.down,value.event.clicks])).toEqual([[true,1],[false,1],[true,2],[false,2],[true,3],[false,3]]);
});

test("unexpected touch capture loss cancels its owned drag and resets the click sequence",async({page,context})=>{
  await page.goto(url("android"));await page.getByRole("button",{name:"连接屏幕",exact:true}).tap();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
  await page.getByRole("button",{name:"开始控制",exact:true}).tap();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();
  const viewport=page.locator(".screen-viewport"),bounds=await page.locator("canvas").boundingBox();const x=bounds!.x+bounds!.width/2,y=bounds!.y+bounds!.height/2;
  await page.touchscreen.tap(x,y);
  await viewport.evaluate(node=>{node.addEventListener("gotpointercapture",event=>{(window as any).screenCapturedPointer=(event as PointerEvent).pointerId;},{once:true});});
  const cdp=await context.newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x,y,id:7}]});
    await cdp.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{x:x+20,y,id:7}]});
    await expect.poll(()=>page.evaluate(()=>(window as any).screenCapturedPointer)).toBeTruthy();
    await viewport.evaluate(node=>{node.releasePointerCapture((window as any).screenCapturedPointer);});
    // The browser dispatches lostpointercapture at the next pointer event.
    await cdp.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{x:x+21,y,id:7}]});
    await cdp.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
    await page.touchscreen.tap(x,y);
    await expect.poll(async()=>(await log(page)).commands.filter((value:any)=>value.type==="input"&&value.event.kind==="button").map((value:any)=>[value.event.down,value.event.clicks])).toEqual([[true,1],[false,1],[true,1],[false,1],[true,1],[false,1]]);
    await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();
  } finally {await cdp.detach();}
});

test("portrait mobile performance overlay has 44px More-menu hit target and lets touches pass through",async({page})=>{
  await page.goto(url("ios"));
  await page.getByRole("button",{name:"连接屏幕",exact:true}).click();
  await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
  await page.getByRole("button",{name:"屏幕更多操作",exact:true}).click();
  const toggleRow=page.locator(".screen-metrics-toggle"), checkbox=toggleRow.locator('input[type="checkbox"]');
  const sizes=await toggleRow.evaluate(node=>{const r=node.getBoundingClientRect(), input=node.querySelector("input")!.getBoundingClientRect();return{rowH:r.height,inputW:input.width,inputH:input.height};});
  expect(sizes.rowH).toBeGreaterThanOrEqual(43.99);
  expect(sizes.inputW).toBeGreaterThanOrEqual(43.99);
  expect(sizes.inputH).toBeGreaterThanOrEqual(43.99);
  await checkbox.click();
  await page.getByRole("button",{name:"屏幕更多操作",exact:true}).click();
  const overlay=page.getByRole("region",{name:"屏幕性能数据",exact:true});
  await expect(overlay).toBeVisible();
  const geometry=await overlay.evaluate(node=>{const o=node.getBoundingClientRect(), v=document.querySelector(".screen-viewport")!.getBoundingClientRect();return{pe:getComputedStyle(node).pointerEvents,inside:o.left>=v.left&&o.top>=v.top&&o.right<=v.right&&o.bottom<=v.bottom};});
  expect(geometry).toEqual({pe:"none",inside:true});
});
