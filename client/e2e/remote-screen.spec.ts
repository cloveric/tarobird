import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
let server:ViteDevServer;
test.beforeAll(async()=>{server=await createServer({server:{host:"127.0.0.1",port:0}});await server.listen();});
test.afterAll(async()=>{await server?.close();});
test.beforeEach(async({page})=>{await page.goto(server.resolvedUrls!.local[0]+"e2e/fixtures/remote-screen.html");await page.getByRole("button",{name:"连接屏幕",exact:true}).click();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();});
test("right pane has a compact header; expansion keeps chat draft",async({page},info)=>{
 const panel=page.getByRole("complementary",{name:"远程屏幕"});await expect(panel).toBeVisible();await expect(panel.getByText("Mac mini",{exact:true})).toBeVisible();
 const sizes=await page.evaluate(()=>{const a=document.querySelector(".screen-heading")!.getBoundingClientRect(),b=document.querySelector(".conversation-header")!.getBoundingClientRect();return{a:a.height,b:b.height,right:document.querySelector(".remote-screen-panel")!.getBoundingClientRect().right};});expect(sizes.a).toBeLessThanOrEqual(96);expect(sizes.right).toBeLessThanOrEqual(1361);
 await page.getByRole("button",{name:"展开屏幕",exact:true}).click();await expect(page.getByLabel("本地聊天草稿")).toHaveValue("保留草稿");await page.getByRole("button",{name:"返回并排",exact:true}).click();await page.screenshot({path:info.outputPath("remote-screen-desktop.png")});
});
test("live permission changes hide control immediately and a new grant does not regain control",async({page})=>{
 await page.getByRole("button",{name:"开始控制",exact:true}).click();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();
 await page.evaluate(()=>(window as any).screenControlPermission(false));
 await expect(page.getByRole("button",{name:"开始控制",exact:true})).toHaveCount(0);
 await expect(page.getByRole("button",{name:"停止控制",exact:true})).toHaveCount(0);
 await expect(page.getByRole("button",{name:"连接屏幕",exact:true})).toHaveCount(0);
 await expect(page.locator("canvas")).toBeVisible();
 await page.evaluate(()=>(window as any).screenControlPermission(true));
 await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
 await expect(page.getByRole("button",{name:"停止控制",exact:true})).toHaveCount(0);
});
test("control waits for new keyframe; local typing releases control and never becomes remote text",async({page})=>{
 await page.getByRole("button",{name:"开始控制",exact:true}).click();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();await page.keyboard.press("ArrowRight");
 await page.getByLabel("本地聊天草稿").fill("只在本地聊天中输入");await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeVisible();
 await expect.poll(()=>page.evaluate(()=>(window as any).screenFixture.commands.some((c:any)=>c.type==="input"&&c.event.code==="ArrowRight"))).toBe(true);const commands=await page.evaluate(()=>(window as any).screenFixture.commands);expect(commands.some((c:any)=>c.type==="input"&&c.event.code==="ArrowRight")).toBe(true);expect(commands.some((c:any)=>c.type==="input"&&c.event.text)).toBe(false);expect(commands.some((c:any)=>c.type==="release")).toBe(true);
});
test("hide releases control and resume does not silently regain it",async({page})=>{
 await page.getByRole("button",{name:"开始控制",exact:true}).click();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();await page.getByRole("button",{name:"切换面板"}).click();await expect(page.getByRole("complementary",{name:"远程屏幕"})).toBeHidden();await page.getByRole("button",{name:"切换面板"}).click();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toHaveCount(0);
});
test("Chinese text is explicitly submitted once; disconnect preserves the local draft",async({page})=>{
 await page.getByRole("button",{name:"屏幕更多操作",exact:true}).click();await page.getByRole("button",{name:"发送文本",exact:true}).click();await page.getByLabel("发送到远端的文本").fill("中文输入验收");await page.getByRole("button",{name:"开始控制",exact:true}).click();await expect(page.getByRole("button",{name:"发送到远端",exact:true})).toBeEnabled();await page.getByRole("button",{name:"发送到远端",exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).screenFixture.commands.filter((v:any)=>v.type==="input"&&v.event.kind==="text").map((v:any)=>v.event.text))).toEqual(["中文输入验收"]);await page.getByRole("button",{name:"断开并关闭屏幕"}).click();await expect(page.getByLabel("本地聊天草稿")).toHaveValue("保留草稿");
});

test("native hide retires the decoder and show resumes viewing without control",async({page})=>{
 await page.getByRole("button",{name:"开始控制",exact:true}).click();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();
 await page.evaluate(()=>(window as any).screenNativeVisibility(false));await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeDisabled();
 await page.evaluate(()=>(window as any).screenNativeVisibility(true));await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
 await expect(page.getByRole("button",{name:"停止控制",exact:true})).toHaveCount(0);
});

test("double and triple clicks preserve counts; line and page wheel deltas become bounded W3C pixels",async({page})=>{
 await page.getByRole("button",{name:"开始控制",exact:true}).click();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();
 const target=page.locator("canvas");await target.click({clickCount:3});
 await expect.poll(()=>page.evaluate(()=>(window as any).screenFixture.commands.filter((c:any)=>c.type==="input"&&c.event.kind==="button"&&c.event.down).map((c:any)=>c.event.clicks))).toEqual([1,2,3]);
 const wheel=await target.evaluate(el=>{const a=new WheelEvent("wheel",{deltaMode:1,deltaX:-2,deltaY:3,cancelable:true});el.dispatchEvent(a);const b=new WheelEvent("wheel",{deltaMode:2,deltaY:100,cancelable:true});el.dispatchEvent(b);return[a.defaultPrevented,b.defaultPrevented];});expect(wheel).toEqual([true,true]);
 await expect.poll(()=>page.evaluate(()=>(window as any).screenFixture.commands.filter((c:any)=>c.type==="input"&&c.event.kind==="wheel").map((c:any)=>[c.event.dx,c.event.dy]))).toEqual([[-32,2000]]);
});

test("held key repeat reaches the target but IME composition keystrokes do not",async({page})=>{
 await page.getByRole("button",{name:"开始控制",exact:true}).click();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();
 await page.locator("canvas").evaluate(el=>{for(const repeat of [false,true,true])el.dispatchEvent(new KeyboardEvent("keydown",{code:"Backspace",repeat,bubbles:true,cancelable:true}));el.dispatchEvent(new KeyboardEvent("keyup",{code:"Backspace",bubbles:true}));el.dispatchEvent(new KeyboardEvent("keydown",{code:"KeyA",isComposing:true,bubbles:true}));});
 await expect.poll(()=>page.evaluate(()=>(window as any).screenFixture.commands.filter((c:any)=>c.type==="input"&&c.event.kind==="key").map((c:any)=>[c.event.code,c.event.down]))).toEqual([["Backspace",true],["Backspace",true],["Backspace",true],["Backspace",false]]);
});

test("clicking Stop control cannot turn into a fresh control request after canvas blur",async({page})=>{
 await page.getByRole("button",{name:"开始控制",exact:true}).click();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();
 await page.getByRole("button",{name:"停止控制",exact:true}).click();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
 await expect.poll(()=>page.evaluate(()=>(window as any).screenFixture.commands.filter((c:any)=>c.type==="control").length)).toBe(1);
});

test("a delayed controlling state cannot restore input after the user returned to local chat",async({page})=>{
 await page.getByRole("button",{name:"开始控制",exact:true}).click();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();
 await page.getByLabel("本地聊天草稿").fill("local");await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
 await page.evaluate(()=>(window as any).screenReemitControlling());await page.locator("canvas").focus();await page.keyboard.press("KeyA");
 await expect(page.getByRole("button",{name:"停止控制",exact:true})).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).screenFixture.commands.filter((c:any)=>c.type==="input"))).toEqual([]);
});


test("hiding the pane while native open is pending cannot resume a hidden stream",async({page})=>{
 await page.getByRole("button",{name:"断开",exact:true}).click();
 await page.evaluate(()=>{(window as any).screenFixture.delayOpen=true;});
 await page.getByRole("button",{name:"连接屏幕",exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>!!(window as any).screenFixture.resumeOpen)).toBe(true);
 await page.getByRole("button",{name:"切换面板"}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).screenFixture.active)).toBe(false);
 await page.evaluate(()=>(window as any).screenFixture.resumeOpen());
 await page.waitForTimeout(100);
 expect(await page.evaluate(()=>(window as any).screenFixture.active)).toBe(false);
 await expect(page.getByRole("complementary",{name:"远程屏幕"})).toBeHidden();
});


test("Escape reaches the remote desktop; the explicit exit chord releases control",async({page})=>{
 await page.getByRole("button",{name:"开始控制",exact:true}).click();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();
 await page.keyboard.press("Escape");
 await expect.poll(()=>page.evaluate(()=>(window as any).screenFixture.commands.filter((c:any)=>c.type==="input"&&c.event.code==="Escape").map((c:any)=>c.event.down))).toEqual([true,false]);
 await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();
 await page.keyboard.press("Control+Alt+Shift+Escape");
 await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
});

test("coalesced wheel data is discarded on local release instead of leaking into a new lease",async({page})=>{
 await page.getByRole("button",{name:"开始控制",exact:true}).click();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();
 await page.locator("canvas").evaluate(el=>{for(let i=0;i<120;i++)el.dispatchEvent(new WheelEvent("wheel",{deltaY:5,cancelable:true}));(document.querySelector('[aria-label="本地聊天草稿"]') as HTMLTextAreaElement).focus();});
 await page.waitForTimeout(60);
 expect(await page.evaluate(()=>(window as any).screenFixture.commands.filter((c:any)=>c.type==="input"&&c.event.kind==="wheel"))).toEqual([]);
});


test("unavailable local takeover monitor reports its permissions while retaining view mode",async({page})=>{
 await page.getByRole("button",{name:"开始控制",exact:true}).click();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();
 await page.evaluate(()=>(window as any).screenDenyControl("screen_takeover_unavailable"));
 await expect(page.getByText("目标 Mac 的本机接管检测未就绪。请在目标 Mac 检查辅助功能和输入监控权限，再重新连接。",{exact:true})).toBeVisible();
 await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
 await expect(page.getByRole("button",{name:"连接屏幕",exact:true})).toHaveCount(0);
 await expect(page.locator("canvas")).toBeVisible();
});

test("expanded remote screen uses a compact toolbar and real fullscreen can be exited", async ({ page }) => {
 await page.getByRole("button", { name: "展开屏幕", exact: true }).click();
 const top = await page.evaluate(() => { const panel = document.querySelector('.remote-screen-panel')!.getBoundingClientRect(); const viewport = document.querySelector('.screen-viewport')!.getBoundingClientRect(); return viewport.top - panel.top; });
 expect(top).toBeLessThanOrEqual(80);
 await page.getByRole("button", { name: "全屏", exact: true }).click();
 await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('remote-screen-panel') ?? false)).toBe(true);
 await expect(page.getByRole("button", { name: "退出全屏", exact: true })).toBeVisible();
 await page.getByRole("button", { name: "退出全屏", exact: true }).click();
 await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
 await expect(page.getByRole("button", { name: "开始控制", exact: true })).toBeEnabled();
 await expect(page.getByLabel("本地聊天草稿")).toHaveValue("保留草稿");
});

test("quality reconnect waits for old Host session to close and never carries a control lease",async({page})=>{
 await page.getByRole("button",{name:"开始控制",exact:true}).click();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();
 await page.evaluate(()=>{(window as any).screenFixture.delayStop=true;});
 await page.getByLabel("画面清晰度",{exact:true}).selectOption("sharp");
 await expect.poll(()=>page.evaluate(()=>!!(window as any).screenFixture.resumeStop)).toBe(true);
 expect(await page.evaluate(()=>(window as any).screenFixture.requests.length)).toBe(1);
 await expect(page.getByLabel("画面清晰度",{exact:true})).toBeDisabled();
 await page.evaluate(()=>{const s=(window as any).screenFixture;s.delayStop=false;s.resumeStop();});
 await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
 expect(await page.evaluate(()=>(window as any).screenFixture.requests.map((r:any)=>r.quality))).toEqual(["balanced","sharp"]);
 const events=await page.evaluate(()=>(window as any).screenFixture.events);expect(events.indexOf("stop:done")).toBeLessThan(events.indexOf("open:sharp"));
 expect(await page.evaluate(()=>(window as any).screenFixture.commands.filter((c:any)=>c.type==="control").length)).toBe(1);
 await page.getByLabel("画面清晰度",{exact:true}).selectOption("smooth");await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
 expect(await page.evaluate(()=>(window as any).screenFixture.requests.at(-1).quality)).toBe("smooth");
 await expect(page.getByLabel("本地聊天草稿")).toHaveValue("保留草稿");
});

test("old target quality refusal requires explicit default fallback; old Hosts never receive the new field",async({page})=>{
 await page.getByRole("button",{name:"断开",exact:true}).click();await page.evaluate(()=>{(window as any).screenFixture.rejectQuality=true;});
 await page.getByLabel("画面清晰度",{exact:true}).selectOption("sharp");await page.getByRole("button",{name:"连接屏幕",exact:true}).click();
 await expect(page.getByRole("status")).toContainText("目标 Mac 的 App 暂不支持画质选择");
 expect(await page.evaluate(()=>(window as any).screenFixture.requests.length)).toBe(2);
 await page.getByRole("button",{name:"以默认画质连接",exact:true}).click();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
 await expect(page.getByLabel("画面清晰度",{exact:true})).toHaveValue("balanced");await expect(page.getByLabel("画面清晰度",{exact:true})).toBeDisabled();
 expect(await page.evaluate(()=>Object.hasOwn((window as any).screenFixture.requests.at(-1),"quality"))).toBe(false);
 await page.getByRole("button",{name:"断开",exact:true}).click();await page.evaluate(()=>{(window as any).screenFixture.rejectQuality=false;});
 await expect(page.getByLabel("画面清晰度",{exact:true})).toBeEnabled();
 await page.getByRole("button",{name:"连接屏幕",exact:true}).click();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
 expect(await page.evaluate(()=>(window as any).screenFixture.requests.at(-1).quality)).toBe("balanced");
 await page.reload();await page.evaluate(()=>{(window as any).screenConnection.state.screenQualityAvailable=false;});
 await page.getByRole("button",{name:"连接屏幕",exact:true}).click();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
 expect(await page.evaluate(()=>Object.hasOwn((window as any).screenFixture.requests.at(-1),"quality"))).toBe(false);
});

test("missing quality confirmation retires the returned session instead of silently displaying another profile",async({page})=>{
 await page.getByRole("button",{name:"断开",exact:true}).click();await page.evaluate(()=>{(window as any).screenFixture.unconfirmedQuality=true;});
 await page.getByRole("button",{name:"连接屏幕",exact:true}).click();await expect(page.getByRole("status")).toContainText("主机未确认所选画质");
 expect(await page.evaluate(()=>(window as any).screenFixture.opens.length)).toBe(1);
 await expect.poll(()=>page.evaluate(()=>(window as any).screenFixture.events.filter((v:string)=>v==="stop:done").length)).toBe(2);
});

test("fullscreen fills the display, hides idle controls, keeps focusable tools visible, and exits on pane hide",async({page},info)=>{
 await page.getByRole("button",{name:"全屏",exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(true);
 const size=await page.evaluate(()=>{const v=document.querySelector(".screen-viewport")!.getBoundingClientRect();return{w:v.width,h:v.height,iw:innerWidth,ih:innerHeight};});expect(size.w).toBeCloseTo(size.iw,0);expect(size.h).toBeCloseTo(size.ih,0);
 await page.mouse.move(500,400);await expect(page.getByRole("button",{name:"显示屏幕工具栏",exact:true})).toBeVisible({timeout:6000});
 await page.screenshot({path:info.outputPath("fullscreen-canvas.png")});
 await page.getByRole("button",{name:"显示屏幕工具栏",exact:true}).click();await page.getByLabel("画面清晰度",{exact:true}).focus();await page.waitForTimeout(2700);
 await expect(page.getByRole("button",{name:"退出全屏",exact:true})).toBeVisible();
 // Programmatic fixture hide models switching away from this host, not a user input to the target.
 await page.getByRole("button",{name:"切换面板"}).evaluate((el:HTMLButtonElement)=>el.click());
 await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(false);
 await expect(page.getByRole("complementary",{name:"远程屏幕"})).toBeHidden();
});

test("fullscreen denial is recoverable and the selected host, stream and draft remain intact",async({page})=>{
 await page.evaluate(()=>{const panel=document.querySelector(".remote-screen-panel") as HTMLElement;(window as any).originalFullscreen=panel.requestFullscreen;panel.requestFullscreen=async()=>{throw new Error("denied");};});
 await page.getByRole("button",{name:"全屏",exact:true}).click();await expect(page.getByRole("status")).toContainText("无法切换全屏");
 expect(await page.evaluate(()=>!!document.fullscreenElement)).toBe(false);await expect(page.getByLabel("本地聊天草稿")).toHaveValue("保留草稿");
 await page.evaluate(()=>{(document.querySelector(".remote-screen-panel") as HTMLElement).requestFullscreen=(window as any).originalFullscreen;});
 await page.getByRole("button",{name:"全屏",exact:true}).click();await expect(page.getByRole("button",{name:"退出全屏",exact:true})).toBeVisible();
 await page.keyboard.press("Escape");await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(false);
 await expect(page.getByRole("complementary",{name:"远程屏幕"})).toBeVisible();
});

test("standalone viewer fullscreen Escape leaves the dialog and viewing session open",async({page})=>{
 await page.goto(server.resolvedUrls!.local[0]+"e2e/fixtures/remote-screen.html?standalone");
 await page.getByRole("button",{name:"连接屏幕",exact:true}).click();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
 await expect(page.getByRole("button",{name:"展开屏幕",exact:true})).toHaveCount(0);
 await page.getByRole("button",{name:"全屏",exact:true}).click();await expect(page.getByRole("button",{name:"退出全屏",exact:true})).toBeVisible();
 await page.keyboard.press("Escape");await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(false);
 await expect(page.getByRole("dialog")).toBeVisible();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
});

test("a hidden pane cannot finish a pending fullscreen entry",async({page})=>{
 await page.evaluate(()=>{const panel=document.querySelector(".remote-screen-panel") as HTMLElement;const original=panel.requestFullscreen.bind(panel);panel.requestFullscreen=async()=>{await original();await new Promise<void>(resolve=>(window as any).finishFullscreen=resolve);};});
 await page.getByRole("button",{name:"全屏",exact:true}).click();await expect.poll(()=>page.evaluate(()=>!!(window as any).finishFullscreen)).toBe(true);
 await page.getByRole("button",{name:"切换面板"}).evaluate((el:HTMLButtonElement)=>el.click());await page.evaluate(()=>(window as any).finishFullscreen());
 await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(false);await expect(page.getByRole("complementary",{name:"远程屏幕"})).toBeHidden();
});

test("closing fullscreen waits for exit before removing the viewer, and stops remote input immediately",async({page})=>{
 await page.getByRole("button",{name:"全屏",exact:true}).click();await expect(page.getByRole("button",{name:"退出全屏",exact:true})).toBeVisible();
 await page.evaluate(()=>{const exit=document.exitFullscreen.bind(document);document.exitFullscreen=async()=>{await new Promise<void>(resolve=>(window as any).finishScreenExit=resolve);await exit();};});
 await page.getByRole("button",{name:"断开并关闭屏幕",exact:true}).click();
 await expect(page.getByRole("complementary",{name:"远程屏幕"})).toBeVisible();
 await expect.poll(()=>page.evaluate(()=>(window as any).screenFixture.active)).toBe(false);
 await expect.poll(()=>page.evaluate(()=>typeof (window as any).finishScreenExit)).toBe("function");
 await page.evaluate(()=>(window as any).finishScreenExit());
 await expect(page.getByRole("complementary",{name:"远程屏幕"})).toHaveCount(0);
 await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(false);
 await page.getByLabel("本地聊天草稿").fill("点叉后继续聊天");
 await expect(page.getByLabel("本地聊天草稿")).toHaveValue("点叉后继续聊天");
});

test("a rejected fullscreen close keeps the exit controls available for retry",async({page})=>{
 await page.getByRole("button",{name:"全屏",exact:true}).click();await expect(page.getByRole("button",{name:"退出全屏",exact:true})).toBeVisible();
 await page.evaluate(()=>{(window as any).screenExit=document.exitFullscreen;document.exitFullscreen=async()=>{throw new Error("exit failed");};});
 await page.getByRole("button",{name:"断开并关闭屏幕",exact:true}).click();
 await expect(page.getByRole("status")).toContainText("无法切换全屏");
 await expect(page.getByRole("button",{name:"断开并关闭屏幕",exact:true})).toBeEnabled();
 await expect.poll(()=>page.evaluate(()=>(window as any).screenFixture.active)).toBe(false);
 await page.evaluate(()=>{document.exitFullscreen=(window as any).screenExit;});
 await page.getByRole("button",{name:"断开并关闭屏幕",exact:true}).click();
 await expect(page.getByRole("complementary",{name:"远程屏幕"})).toHaveCount(0);
 await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(false);
});

test("closing during pending fullscreen entry waits for it and exits without leaving a surface behind",async({page})=>{
 await page.evaluate(()=>{const panel=document.querySelector(".remote-screen-panel") as HTMLElement;const enter=panel.requestFullscreen.bind(panel);panel.requestFullscreen=async()=>{await enter();await new Promise<void>(resolve=>(window as any).finishScreenEntry=resolve);};});
 await page.getByRole("button",{name:"全屏",exact:true}).click();await expect.poll(()=>page.evaluate(()=>typeof (window as any).finishScreenEntry)).toBe("function");
 await page.getByRole("button",{name:"断开并关闭屏幕",exact:true}).click();
 await expect(page.getByRole("complementary",{name:"远程屏幕"})).toBeVisible();
 await expect(page.getByRole("button",{name:"断开并关闭屏幕",exact:true})).toBeDisabled();
 await page.evaluate(()=>(window as any).finishScreenEntry());
 await expect(page.getByRole("complementary",{name:"远程屏幕"})).toHaveCount(0);
 await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(false);
});

test("close waits for macOS fullscreen entry even after the HTML request has resolved",async({page})=>{
 await page.evaluate(()=>{(window as any).nativeEntryPending=true;(window as any).screenReadNativeWindow=async()=>({fullscreen:true,fullscreenTransitioning:(window as any).nativeEntryPending});});
 await page.getByRole("button",{name:"全屏",exact:true}).click();await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(true);
 await page.getByRole("button",{name:"断开并关闭屏幕",exact:true}).click();
 await expect(page.getByRole("button",{name:"断开并关闭屏幕",exact:true})).toBeDisabled();
 await expect.poll(()=>page.evaluate(()=>(window as any).screenFixture.active)).toBe(false);
 expect(await page.evaluate(()=>!!document.fullscreenElement)).toBe(true);
 await page.evaluate(()=>{(window as any).nativeEntryPending=false;});
 await expect(page.getByRole("complementary",{name:"远程屏幕"})).toHaveCount(0);
 await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(false);
});

test("the viewer remains mounted until macOS exit finishes after HTML fullscreen has ended",async({page})=>{
 await page.getByRole("button",{name:"全屏",exact:true}).click();await expect(page.getByRole("button",{name:"退出全屏",exact:true})).toBeVisible();
 await page.evaluate(()=>{(window as any).nativeExitPending=true;(window as any).screenReadNativeWindow=async()=>({fullscreen:!!document.fullscreenElement,fullscreenTransitioning:(window as any).nativeExitPending&&!document.fullscreenElement});});
 await page.getByRole("button",{name:"断开并关闭屏幕",exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(false);
 await expect(page.getByRole("complementary",{name:"远程屏幕"})).toBeVisible();
 await expect(page.getByRole("button",{name:"断开并关闭屏幕",exact:true})).toBeDisabled();
 await page.evaluate(()=>{(window as any).nativeExitPending=false;});
 await expect(page.getByRole("complementary",{name:"远程屏幕"})).toHaveCount(0);
});

test("a late fullscreen close cannot remove a newly selected host's viewer",async({page})=>{
 await page.getByRole("button",{name:"全屏",exact:true}).click();await expect(page.getByRole("button",{name:"退出全屏",exact:true})).toBeVisible();
 await page.evaluate(()=>{const exit=document.exitFullscreen.bind(document);document.exitFullscreen=async()=>{await new Promise<void>(resolve=>(window as any).finishScreenExit=resolve);await exit();};});
 await page.getByRole("button",{name:"断开并关闭屏幕",exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>typeof (window as any).finishScreenExit)).toBe("function");
 await page.evaluate(()=>(window as any).screenSwitchHost());
 await expect(page.locator(".screen-title small")).toHaveText("Other Mac");
 await page.evaluate(()=>(window as any).finishScreenExit());
 await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(false);
 await expect(page.getByRole("complementary",{name:"远程屏幕"})).toBeVisible();
 await page.getByRole("button",{name:"连接屏幕",exact:true}).click();
 await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
});

test("closing after an external HTML exit still waits for the native exit transition",async({page})=>{
 await page.getByRole("button",{name:"全屏",exact:true}).click();await expect(page.getByRole("button",{name:"退出全屏",exact:true})).toBeVisible();
 await page.evaluate(async()=>{
  (window as any).nativeExitPending=true;
  (window as any).screenReadNativeWindow=async()=>({fullscreen:false,fullscreenTransitioning:(window as any).nativeExitPending});
  await document.exitFullscreen();
 });
 await expect(page.getByRole("button",{name:"全屏",exact:true})).toBeVisible();
 await page.getByRole("button",{name:"断开并关闭屏幕",exact:true}).click();
 await expect(page.getByRole("complementary",{name:"远程屏幕"})).toBeVisible();
 await expect(page.getByRole("button",{name:"断开并关闭屏幕",exact:true})).toBeDisabled();
 await page.evaluate(()=>{(window as any).nativeExitPending=false;});
 await expect(page.getByRole("complementary",{name:"远程屏幕"})).toHaveCount(0);
});

test("a late fullscreen close cannot remove the same Host viewer reopened after navigation",async({page})=>{
 await page.getByRole("button",{name:"全屏",exact:true}).click();await expect(page.getByRole("button",{name:"退出全屏",exact:true})).toBeVisible();
 await page.evaluate(()=>{
  (window as any).nativeExitPending=true;
  (window as any).screenReadNativeWindow=async()=>({fullscreen:!!document.fullscreenElement,fullscreenTransitioning:(window as any).nativeExitPending&&!document.fullscreenElement});
 });
 await page.getByRole("button",{name:"断开并关闭屏幕",exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(false);
 await page.getByRole("button",{name:"切换面板",exact:true}).click();
 await expect(page.getByRole("complementary",{name:"远程屏幕"})).toBeHidden();
 await page.getByRole("button",{name:"切换面板",exact:true}).click();
 await page.evaluate(()=>{(window as any).nativeExitPending=false;});
 await expect(page.getByRole("button",{name:"连接屏幕",exact:true})).toBeEnabled();
 await page.getByRole("button",{name:"连接屏幕",exact:true}).click();
 await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
});

test("Sharp requires a compatible high-resolution decoder before any replacement session is created",async({page})=>{
 await page.evaluate(()=>{const original=VideoDecoder.isConfigSupported.bind(VideoDecoder);VideoDecoder.isConfigSupported=async config=>config.codec==="avc1.640033"?{supported:false,config}:original(config);});
 await page.getByLabel("画面清晰度",{exact:true}).selectOption("sharp");await expect(page.getByRole("status")).toContainText("此设备不支持清晰画质解码");
 expect(await page.evaluate(()=>(window as any).screenFixture.requests.length)).toBe(1);
 await page.getByLabel("画面清晰度",{exact:true}).selectOption("smooth");await page.getByRole("button",{name:"连接屏幕",exact:true}).click();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
 expect(await page.evaluate(()=>(window as any).screenFixture.requests.at(-1).quality)).toBe("smooth");
});

test("renderer rejects streams larger than the accepted quality before allocating their decoder",async({page})=>{
 await page.evaluate(()=>(window as any).screenStream({type:"stream",streamGeneration:2,geometryRevision:1,codec:"h264",codecString:"avc1.640033",width:2880,height:1800,contentRect:{x:0,y:0,width:2880,height:1800}}));
 await expect(page.getByRole("button",{name:"连接屏幕",exact:true})).toBeVisible();
 expect(await page.locator("canvas").evaluate((c:HTMLCanvasElement)=>[c.width,c.height])).toEqual([1280,720]);
 expect(await page.evaluate(()=>(window as any).screenFixture.active)).toBe(false);
});

test("an unreachable old Host cannot block opening the newly selected Host",async({page})=>{
 await page.evaluate(()=>{(window as any).screenFixture.failStop=true;(window as any).screenSwitchHost();});
 await expect(page.getByText("Other Mac",{exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"连接屏幕",exact:true})).toBeEnabled();
 await page.getByRole("button",{name:"连接屏幕",exact:true}).click();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
 expect(await page.evaluate(()=>(window as any).screenFixture.requests.at(-1).desktopId)).toBe("desktop_other");
});

test("a device without the high-resolution decoder disables Sharp while keeping standard viewing usable",async({page})=>{
 await page.goto(server.resolvedUrls!.local[0]+"e2e/fixtures/remote-screen.html?no-sharp");
 await expect(page.getByLabel("画面清晰度",{exact:true}).locator('option[value="sharp"]')).toBeDisabled();
 await page.getByRole("button",{name:"连接屏幕",exact:true}).click();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
});

test("Fit fills a large fullscreen proportionally and keeps remote pointer coordinates on the actual picture",async({page})=>{
 await page.setViewportSize({width:1800,height:1100});
 await page.getByRole("button",{name:"全屏",exact:true}).click();await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(true);
 const measure=()=>page.evaluate(()=>{const v=document.querySelector('.screen-viewport')!.getBoundingClientRect(),c=document.querySelector('canvas')!.getBoundingClientRect();const factor=Math.min(v.width/1280,v.height/720);return{w:c.width,h:c.height,expectedW:1280*factor,expectedH:720*factor};});
 await expect.poll(async()=>{const s=await measure();return Math.abs(s.w-s.expectedW)+Math.abs(s.h-s.expectedH);}).toBeLessThan(3);
 await page.getByRole("button",{name:"开始控制",exact:true}).click();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();
 const c=await page.locator('canvas').boundingBox();await page.mouse.click(c!.x+c!.width*.25,c!.y+c!.height*.75);
 await expect.poll(()=>page.evaluate(()=>(window as any).screenFixture.commands.some((v:any)=>v.type==='input'&&v.event.kind==='button'&&v.event.down))).toBe(true);
 const input=await page.evaluate(()=>(window as any).screenFixture.commands.filter((v:any)=>v.type==='input'&&v.event.kind==='button'&&v.event.down).at(-1).event);
 expect(input.x).toBeCloseTo(.25,2);expect(input.y).toBeCloseTo(.75,2);
 await page.getByLabel("画面缩放",{exact:true}).selectOption('1');
 await expect.poll(()=>page.locator('canvas').evaluate(c=>c.getBoundingClientRect().width)).toBe(1280);
 await page.getByLabel("画面缩放",{exact:true}).selectOption('fit');
 await expect.poll(async()=>{const s=await measure();return Math.abs(s.w-s.expectedW)+Math.abs(s.h-s.expectedH);}).toBeLessThan(3);
});

test("fullscreen can send an explicit remote Esc without exiting the local fullscreen",async({page})=>{
 await page.getByRole('button',{name:'全屏',exact:true}).click();await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(true);
 await page.getByRole('button',{name:'屏幕更多操作',exact:true}).click();await page.getByText('发送组合键',{exact:true}).click();
 await page.getByRole('button',{name:'开始控制',exact:true}).click();await expect(page.getByRole('button',{name:'停止控制',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Esc',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).screenFixture.commands.filter((c:any)=>c.type==='input'&&c.event.code==='Escape').map((c:any)=>c.event.down))).toEqual([true,false]);
 expect(await page.evaluate(()=>!!document.fullscreenElement)).toBe(true);
 await page.keyboard.press('Escape');await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(false);
});

test("switching Host clears remote text drafts and a failed same-Host stop remains retryable",async({page})=>{
 await page.getByRole('button',{name:'屏幕更多操作',exact:true}).click();await page.getByRole('button',{name:'发送文本',exact:true}).click();
 await page.getByLabel('发送到远端的文本').fill('只给原主机');
 await page.evaluate(()=>(window as any).screenSwitchHost());await expect(page.getByText('Other Mac',{exact:true})).toBeVisible();
 await expect(page.getByRole('region',{name:'屏幕更多操作',exact:true})).toBeHidden();
 await page.getByRole('button',{name:'屏幕更多操作',exact:true}).click();await page.getByRole('button',{name:'发送文本',exact:true}).click();
 await expect(page.getByLabel('发送到远端的文本')).toHaveValue('');
 await page.reload();await page.getByRole('button',{name:'连接屏幕',exact:true}).click();await expect(page.getByRole('button',{name:'开始控制',exact:true})).toBeEnabled();
 await page.evaluate(()=>{const s=(window as any).screenFixture,c=(window as any).screenConnection,original=c.screenStop.bind(c);s.stopAttempts=0;c.screenStop=(id:string)=>{s.stopAttempts++;return original(id);};s.failStop=true;});await page.getByRole('button',{name:'断开',exact:true}).click();await page.getByRole('button',{name:'连接屏幕',exact:true}).click();
 await expect(page.getByRole('status')).toContainText('old_host_offline');expect(await page.evaluate(()=>(window as any).screenFixture.requests.length)).toBe(1);
 expect(await page.evaluate(()=>(window as any).screenFixture.stopAttempts)).toBe(2);
 await page.evaluate(()=>(window as any).screenFixture.failStop=false);await page.getByRole('button',{name:'连接屏幕',exact:true}).click();await expect(page.getByRole('button',{name:'开始控制',exact:true})).toBeEnabled();
 expect(await page.evaluate(()=>(window as any).screenFixture.requests.length)).toBe(2);
});

test("a cancelled HTTP open retires its late join before a same-Host replacement is created",async({page})=>{
 await page.getByRole('button',{name:'断开',exact:true}).click();
 await page.evaluate(()=>{const c=(window as any).screenConnection,s=(window as any).screenFixture,original=c.screenOpen.bind(c);s.delayHttp=true;c.screenOpen=async(input:any)=>{const result=await original(input);if(s.delayHttp)await new Promise<void>(resolve=>s.finishHttp=resolve);return result;};});
 await page.getByRole('button',{name:'连接屏幕',exact:true}).click();await expect.poll(()=>page.evaluate(()=>typeof (window as any).screenFixture.finishHttp)).toBe('function');
 await page.getByRole('button',{name:'断开',exact:true}).click();await page.getByRole('button',{name:'连接屏幕',exact:true}).click();
 expect(await page.evaluate(()=>(window as any).screenFixture.requests.length)).toBe(2);
 await page.evaluate(()=>{const s=(window as any).screenFixture;s.delayHttp=false;s.finishHttp();});
 await expect(page.getByRole('button',{name:'开始控制',exact:true})).toBeEnabled();
 expect(await page.evaluate(()=>(window as any).screenFixture.requests.length)).toBe(3);
 expect(await page.evaluate(()=>(window as any).screenFixture.opens.length)).toBe(2);
 expect(await page.evaluate(()=>(window as any).screenFixture.events.filter((v:string)=>v==='stop:done').length)).toBe(2);
});

test("remote shortcuts keep the active control lease but local text editing releases it",async({page})=>{
 await page.getByRole('button',{name:'开始控制',exact:true}).click();await expect(page.getByRole('button',{name:'停止控制',exact:true})).toBeVisible();
 await expect(page.locator('canvas')).toBeFocused();
 await page.getByRole('button',{name:'屏幕更多操作',exact:true}).click();
 await expect(page.getByRole('button',{name:'停止控制',exact:true})).toBeVisible();
 await page.getByText('发送组合键',{exact:true}).click();await page.getByRole('button',{name:'Esc',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).screenFixture.commands.filter((c:any)=>c.type==='input'&&c.event.code==='Escape').map((c:any)=>c.event.down))).toEqual([true,false]);
 expect(await page.evaluate(()=>(window as any).screenFixture.commands.filter((c:any)=>c.type==='control').length)).toBe(1);
 await page.getByRole('button',{name:'发送文本',exact:true}).click();await page.getByLabel('发送到远端的文本').fill('仅编辑，不自动发送');
 await expect(page.getByRole('button',{name:'开始控制',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).screenFixture.commands.some((c:any)=>c.type==='input'&&c.event.kind==='text'))).toBe(false);
});

test("an ended legacy stream restores quality negotiation for the next connection",async({page})=>{
 await page.getByRole('button',{name:'断开',exact:true}).click();await page.evaluate(()=>(window as any).screenFixture.rejectQuality=true);
 await page.getByRole('button',{name:'连接屏幕',exact:true}).click();await page.getByRole('button',{name:'以默认画质连接',exact:true}).click();
 await expect(page.getByRole('button',{name:'开始控制',exact:true})).toBeEnabled();await expect(page.getByLabel('画面清晰度',{exact:true})).toBeDisabled();
 await page.evaluate(()=>{const s=(window as any).screenFixture;s.rejectQuality=false;s.port.postMessage({type:'error',code:'screen_capture_failed'});});
 await expect(page.getByRole('button',{name:'连接屏幕',exact:true})).toBeVisible();await expect(page.getByLabel('画面清晰度',{exact:true})).toBeEnabled();
 await page.getByLabel('画面清晰度',{exact:true}).selectOption('smooth');await page.getByRole('button',{name:'连接屏幕',exact:true}).click();
 await expect(page.getByRole('button',{name:'开始控制',exact:true})).toBeEnabled();expect(await page.evaluate(()=>(window as any).screenFixture.requests.at(-1).quality)).toBe('smooth');
});

test("a pointer burst sends its latest position before drag release, preserving both button edges", async ({page}) => {
 await page.getByRole("button", {name:"开始控制",exact:true}).click();
 await expect(page.getByRole("button", {name:"停止控制",exact:true})).toBeVisible();
 const target=page.locator("canvas");await target.hover();await page.waitForTimeout(50);
 await target.evaluate(el=>{
  (window as any).screenFixture.commands.length=0;
  const rect=el.getBoundingClientRect(), x=rect.left+rect.width*.2, y=rect.top+rect.height*.5;
  el.dispatchEvent(new PointerEvent("pointerdown",{pointerId:1,clientX:x,clientY:y,button:0,bubbles:true,cancelable:true}));
  for(let i=0;i<3;i++)el.dispatchEvent(new PointerEvent("pointermove",{pointerId:1,clientX:rect.left+rect.width*(.2+.6*i/2),clientY:y,buttons:1,bubbles:true}));
  el.dispatchEvent(new PointerEvent("pointerup",{pointerId:1,clientX:rect.left+rect.width*.8,clientY:y,button:0,bubbles:true,cancelable:true}));
 });
 await expect.poll(()=>page.evaluate(()=>(window as any).screenFixture.commands.filter((c:any)=>c.type==="input").length)).toBe(4);
 const events=await page.evaluate(()=>(window as any).screenFixture.commands.filter((c:any)=>c.type==="input").map((c:any)=>c.event));
 expect(events.map((e:any)=>[e.kind,e.down])).toEqual([["button",true],["move",undefined],["move",undefined],["button",false]]);
 expect(events[2].x).toBeCloseTo(.8,3);expect(events[2].y).toBeCloseTo(.5,3);
});

test("a pointer burst cannot escape after focus moves back to the chat", async ({page}) => {
 await page.getByRole("button", {name:"开始控制",exact:true}).click();
 await expect(page.getByRole("button", {name:"停止控制",exact:true})).toBeVisible();
 const target=page.locator("canvas");await target.hover();await page.waitForTimeout(50);
 await target.evaluate(el=>{
  (window as any).screenFixture.commands.length=0;
  const rect=el.getBoundingClientRect();
  for(let i=0;i<3;i++)el.dispatchEvent(new PointerEvent("pointermove",{clientX:rect.left+rect.width*.8,clientY:rect.top+rect.height*.5,bubbles:true}));
  (document.querySelector('[aria-label="本地聊天草稿"]') as HTMLTextAreaElement).focus();
 });
 await expect(page.getByRole("button", {name:"开始控制",exact:true})).toBeVisible();await page.waitForTimeout(50);
 expect(await page.evaluate(()=>(window as any).screenFixture.commands.filter((c:any)=>c.type==="input"))).toHaveLength(1);
});

test("stopping a short pointer burst still delivers the final hover position", async ({page}) => {
 await page.getByRole("button", {name:"开始控制",exact:true}).click();
 await expect(page.getByRole("button", {name:"停止控制",exact:true})).toBeVisible();
 const target=page.locator("canvas");await target.hover();await page.waitForTimeout(50);
 await target.evaluate(el=>{
  (window as any).screenFixture.commands.length=0;const rect=el.getBoundingClientRect();
  for(const x of [.2,.5,.8])el.dispatchEvent(new PointerEvent("pointermove",{clientX:rect.left+rect.width*x,clientY:rect.top+rect.height*.5,bubbles:true}));
 });
 await expect.poll(()=>page.evaluate(()=>(window as any).screenFixture.commands.filter((c:any)=>c.type==="input").at(-1)?.event.x)).toBeCloseTo(.8,3);
 expect(await page.evaluate(()=>(window as any).screenFixture.commands.filter((c:any)=>c.type==="input").length)).toBe(2);
});
