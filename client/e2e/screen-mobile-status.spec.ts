import { test, expect, type Page } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
import en from "../src/locales/en.json" with { type: "json" };
// Real RemoteScreenPanel, Capacitor JS dispatch and screen transport over the
// native plugin double (fixtures/screen-mobile.tsx); synthetic Hub responses.
let server: ViteDevServer;
test.beforeAll(async()=>{server=await createServer({server:{host:"127.0.0.1",port:0}});await server.listen();});
test.afterAll(async()=>{await server?.close();});
test.use({hasTouch:true,viewport:{width:390,height:844}});
const url=(platform="ios")=>server.resolvedUrls!.local[0]+`e2e/fixtures/screen-mobile.html?platform=${platform}`;
const log=(page:Page)=>page.evaluate(()=>(window as any).screenMobileFixture);
const status=(page:Page)=>page.locator(".screen-mobile .screen-state[role=status]");
const BACKGROUND="App 已进入后台或设备已锁定。返回后请重新连接，再单独开始控制。";
const HOST_STOPPED="主机已停止运行，屏幕连接已断开。请在主机恢复后重新连接。";
const GENERIC="屏幕连接已结束，请检查主机状态后重试。";
const CONGESTED="连接拥塞，屏幕已断开。请检查线路后重新连接。";
const REVOKED="远程屏幕已关闭，或此设备的授权已撤销。请检查目标电脑的授权后重新连接。";
const CLOSED="屏幕连接已关闭。请重新连接，再单独开始控制。";
const LEASE_EXPIRED="控制授权已过期，请重新点击开始控制。";
const PROTOCOL="屏幕服务协议不兼容，请检查 App 与主机版本后重试。";
const ready=(page:Page)=>page.waitForFunction(()=>!!(window as any).screenMobileFixture);
const refresh=(page:Page)=>page.evaluate(()=>window.dispatchEvent(new Event("focus")));

test("returning from background or lock explains why the session ended, until the next connect",async({page})=>{
  await page.goto(url());await page.getByRole("button",{name:"连接屏幕",exact:true}).click();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
  await page.getByRole("button",{name:"开始控制",exact:true}).click();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();
  await page.evaluate(()=>(window as any).screenMobileActive(false));await expect(page.locator(".screen-mobile")).toBeHidden();
  // Further lifecycle events while away must not erase the explanation.
  await page.evaluate(()=>{document.documentElement.dataset.mobileLocked="true";});await page.evaluate(()=>{document.documentElement.dataset.mobileLocked="false";});
  const before=(await log(page)).opens;await page.evaluate(()=>(window as any).screenMobileActive(true));
  await expect(status(page)).toHaveText(BACKGROUND);
  // Unchanged design: no automatic reconnect, control is not restored.
  await expect(page.getByRole("button",{name:"连接屏幕",exact:true})).toBeEnabled();expect((await log(page)).opens).toBe(before);
  await expect(page.getByRole("button",{name:"屏幕控制设置",exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"连接屏幕",exact:true}).click();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
  await expect(status(page)).not.toHaveText(BACKGROUND);await expect(page.getByRole("button",{name:"停止控制",exact:true})).toHaveCount(0);
  // A lock during a session explains itself the same way.
  await page.evaluate(()=>{document.documentElement.dataset.mobileLocked="true";});await expect(page.locator(".screen-mobile")).toBeHidden();
  await page.evaluate(()=>{document.documentElement.dataset.mobileLocked="false";});await expect(status(page)).toHaveText(BACKGROUND);
  expect((await log(page)).opens).toBe(before+1);
  // Without a session there is nothing to explain.
  await page.evaluate(()=>(window as any).screenMobileFixture.hide());await page.evaluate(()=>(window as any).screenMobileFixture.show());
  await expect(status(page)).toHaveText("尚未连接");
  await page.evaluate(()=>(window as any).screenMobileActive(false));await page.evaluate(()=>(window as any).screenMobileActive(true));
  await expect(status(page)).toHaveText("尚未连接");
});

test("a dropped Host keeps its localized reason and never shows the client's raw error",async({page})=>{
  await page.goto(url());await page.getByRole("button",{name:"连接屏幕",exact:true}).click();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
  // The Host stops; its status endpoint then fails the way the client reports a dropped route.
  await page.evaluate(()=>{(window as any).screenMobileFixture.statusFailure="abort";(window as any).screenMobileHostClose("screen_host_stopped");});
  for(const failure of ["abort","offline"]){
    await page.evaluate(value=>{(window as any).screenMobileFixture.statusFailure=value;},failure);await refresh(page);await page.waitForTimeout(200);
    await expect(status(page),failure).toHaveText(HOST_STOPPED);
  }
  await expect(page.getByText("The request was aborted.")).toHaveCount(0);
  // Without a Host reason the failure is an ordinary, localized disconnect.
  await page.reload();await ready(page);await page.evaluate(()=>{(window as any).screenMobileFixture.statusFailure="abort";});await refresh(page);
  await expect(status(page)).toHaveText(GENERIC);
  await page.evaluate(()=>{(window as any).screenMobileFixture.statusFailure="offline";});await refresh(page);
  await expect(status(page)).toHaveText(GENERIC);
  // Host recovers: the ordinary state returns.
  await page.evaluate(()=>{(window as any).screenMobileFixture.statusFailure="";});await refresh(page);
  await expect(status(page)).toHaveText("尚未连接");
});

test("a view-only phone session says it is view only, in Chinese and English",async({browser})=>{
  for(const english of [false,true]){
    const context=await browser.newContext({viewport:{width:390,height:844},locale:english?"en-US":"zh-CN",hasTouch:true,isMobile:true});const page=await context.newPage();
    const text=(key:string)=>english?(en as Record<string,string>)[key]??key:key;
    // The status line ends with the stream size (" · 1280 × 720").
    const line=(key:string)=>new RegExp("^"+text(key)+" · ");
    try{
      await page.goto(url());await ready(page);await page.evaluate(()=>{(window as any).screenMobileFixture.viewOnly=true;});await refresh(page);
      await page.getByRole("button",{name:text("连接屏幕"),exact:true}).click();
      await expect(status(page)).toHaveText(line("查看中 · 仅查看"));
      await expect(page.getByRole("button",{name:text("开始控制"),exact:true})).toHaveCount(0);
      // A control grant on the next session restores the ordinary hint and button.
      await page.evaluate(()=>{(window as any).screenMobileFixture.viewOnly=false;});
      await page.reload();await ready(page);
      await page.getByRole("button",{name:text("连接屏幕"),exact:true}).click();await expect(page.getByRole("button",{name:text("开始控制"),exact:true})).toBeEnabled();
      await expect(status(page)).toHaveText(line("查看中 · 点击开始控制后操作"));
    }finally{await context.close();}
  }
});

test("English UI shows the same reasons in English, without raw client text",async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844},locale:"en-US",hasTouch:true,isMobile:true});const page=await context.newPage();
  const text=(key:string)=>(en as Record<string,string>)[key]??key;
  try{
    await page.goto(url("android"));await ready(page);await page.evaluate(()=>{(window as any).screenMobileFixture.statusFailure="abort";});await refresh(page);
    await expect(status(page)).toHaveText(text(GENERIC));
    await page.evaluate(()=>{(window as any).screenMobileFixture.statusFailure="";});await refresh(page);
    await page.getByRole("button",{name:text("连接屏幕"),exact:true}).click();await expect(page.getByRole("button",{name:text("开始控制"),exact:true})).toBeEnabled();
    await page.evaluate(()=>(window as any).screenMobileActive(false));await page.evaluate(()=>(window as any).screenMobileActive(true));
    await expect(status(page)).toHaveText(text(BACKGROUND));
  }finally{await context.close();}
});

// F-AND-2(b): a call native rejects because its session just ended must not replace the
// reason native sends right behind it, including native's own local reason.
test("a page call rejected as an Android session ends never hides why it ended",async({page})=>{
  await page.goto(url("android"));
  for(const [method,code,reason,text] of [["screenAck","native_document_retired","screen_viewer_congested",CONGESTED],["screenSend","native_request_cancelled","screen_permission_revoked",REVOKED],["screenRead","native_request_cancelled","screen_network_closed",CLOSED]] as const){
    await page.getByRole("button",{name:"连接屏幕",exact:true}).click();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
    await page.evaluate(value=>{(window as any).screenMobileFixture.endBehind=value;},{method,code,reason});
    await expect.poll(async()=>(await log(page)).endBehind,method).toBeUndefined();
    await expect(status(page),method).toHaveText(text);await expect(page.getByText(/native_/)).toHaveCount(0);
    await expect(page.getByRole("button",{name:"连接屏幕",exact:true})).toBeEnabled();
  }
  // An ordinary reconnect follows, and the next session's state replaces the old reason.
  await page.getByRole("button",{name:"连接屏幕",exact:true}).click();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
  await expect(status(page)).not.toHaveText(CLOSED);
});

// F-AND-3: control withdrawn by the Hub while a renew is on its way ends control, not the session.
// Android and iOS native refuse it with the same screen_control_ended; both page paths keep viewing.
for(const platform of ["android","ios"]) test(`a renew refused because the Hub already withdrew control returns to viewing (${platform})`,async({page})=>{
  await page.goto(url(platform));await page.getByRole("button",{name:"连接屏幕",exact:true}).click();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
  await page.getByRole("button",{name:"开始控制",exact:true}).click();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();
  const opens=(await log(page)).opens;await page.evaluate(()=>{(window as any).screenMobileFixture.withdrawOnRenew=true;});
  await expect.poll(async()=>(await log(page)).withdrawOnRenew,{timeout:5000}).toBe(false);
  await expect(status(page)).toHaveText(LEASE_EXPIRED);await expect(page.getByText(PROTOCOL)).toHaveCount(0);
  await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toHaveCount(0);
  // Still the same viewing session: nothing closed it and no reconnect was needed.
  expect((await log(page)).calls.filter((call:any)=>call.method==="screenClose")).toHaveLength(0);expect((await log(page)).opens).toBe(opens);
  await expect(page.getByRole("button",{name:"断开",exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"连接屏幕",exact:true})).toHaveCount(0);
});

for(const english of [false,true]) test(`mobile quality menu shows actual stream resolution before and after lease expiry (${english?"en":"zh"})`,async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844},locale:english?"en-US":"zh-CN",hasTouch:true,isMobile:true});const page=await context.newPage();
  const text=(key:string)=>english?(en as Record<string,string>)[key]??key:key;
  const actual=english?"Current 1280×720":"当前 1280×720";
  const hint=text("720p 节省带宽，最高 3K 保留更多文字细节");
  try{
    await page.goto(url("ios"));await ready(page);
    await page.getByRole("button",{name:text("屏幕更多操作"),exact:true}).click();
    const select=page.getByLabel(text("画面清晰度"),{exact:true});
    await expect(select).toHaveValue("smooth");
    await expect(select.locator("option")).toHaveText(["720p","1080p",text("2K（1440p）"),text("最高 3K")]);
    await expect(page.locator(".screen-quality-actual")).toHaveCount(0);
    await expect(select).toHaveAttribute("title",hint);
    await page.getByRole("button",{name:text("连接屏幕"),exact:true}).click();
    await expect(page.getByRole("button",{name:text("开始控制"),exact:true})).toBeEnabled();
    await expect(page.locator(".screen-quality-actual")).toHaveText(actual);
    await expect(select).toHaveAttribute("title",`${actual} · ${hint}`);
    await page.getByRole("button",{name:text("开始控制"),exact:true}).click();
    await expect(page.getByRole("button",{name:text("停止控制"),exact:true})).toBeVisible();
    await page.evaluate(()=>{(window as any).screenMobileFixture.withdrawOnRenew=true;});
    await expect.poll(async()=>(await log(page)).withdrawOnRenew,{timeout:5000}).toBe(false);
    await expect(status(page)).toHaveText(text(LEASE_EXPIRED));
    await expect(page.getByRole("button",{name:text("断开"),exact:true})).toBeVisible();
    await expect(page.locator(".screen-quality-actual")).toHaveText(actual);
    await expect(select).toHaveAttribute("title",`${actual} · ${hint}`);
    await page.getByRole("button",{name:text("断开"),exact:true}).click();
    await expect(page.locator(".screen-quality-actual")).toHaveCount(0);
    await expect(select).toHaveAttribute("title",hint);
  }finally{await context.close();}
});

for(const platform of ["ios","android"] as const) test(`mobile ${platform} passes the accepted 2K quality to the native transport`,async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844},locale:"zh-CN",hasTouch:true,isMobile:true});
  const page=await context.newPage();
  try{
    await page.goto(url(platform));await ready(page);
    await page.getByRole("button",{name:"屏幕更多操作",exact:true}).click();
    await page.getByLabel("画面清晰度",{exact:true}).selectOption("qhd");
    await page.getByRole("button",{name:"连接屏幕",exact:true}).click();
    await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled();
    expect(await page.evaluate(()=>(window as any).screenMobileFixture.calls.find((v:any)=>v.method==="screenOpen")?.args.join.quality)).toBe("qhd");
    await expect(page.locator(".screen-quality-actual")).toHaveText("当前 1280×720");
  }finally{await context.close();}
});
