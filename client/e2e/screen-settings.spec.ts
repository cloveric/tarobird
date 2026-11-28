import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
let server:ViteDevServer;
test.beforeAll(async()=>{server=await createServer({server:{host:"127.0.0.1",port:0}});await server.listen();});
test.afterAll(async()=>server?.close());
const url=(query="")=>server.resolvedUrls!.local[0]+"e2e/fixtures/screen-settings.html"+query;
test("ungranted GUI device keeps a visible disabled entry and separate service diagnostics",async({page})=>{
 await page.goto(url());const entry=page.getByRole("button",{name:"查看屏幕",exact:true});await expect(entry).toBeVisible();await expect(entry).toBeDisabled();
 await expect(page.getByText("此设备尚未获得查看授权。",{exact:true})).toBeVisible();
 await expect(page.getByRole("button",{name:"重试屏幕服务",exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.configured)).toEqual([]);
});
test("explicit retry consumes the native contract without requesting permissions or changing grants",async({page})=>{
 await page.goto(url());await expect(page.getByText("启动失败",{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.native.filter((c:any)=>c.command!=="screen_service_status"))).toEqual([]);
 await page.getByRole("button",{name:"重试屏幕服务",exact:true}).click();
 await expect(page.getByText("正在连接主机",{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.native.filter((c:any)=>c.command!=="screen_service_status"))).toEqual([{command:"screen_service_retry",args:{}}]);
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.configured)).toEqual([]);
 await page.evaluate(()=>{const f=(window as any).screenSettingsFixture;Object.assign(f.state.local,{phase:"retrying",retryAt:Date.now()+30000,error:"screen_host_directory_conflict"});window.dispatchEvent(new Event("focus"));});
 await expect(page.getByText("等待重试",{exact:true})).toBeVisible();await expect(page.getByText(/自动重试时间：/)).toBeVisible();
 await expect(page.getByText("检测到多份主机数据，请先解决主机目录冲突，再重试屏幕服务。",{exact:true})).toBeVisible();
});
test("permission settings remain accessible when already granted for all three buttons",async({page})=>{
 await page.goto(url());
 for(const [label,key] of [["屏幕录制","capture"],["辅助功能","accessibility"],["输入监控","inputMonitoring"]]){
  await page.evaluate(key=>{const f=(window as any).screenSettingsFixture;f.state.local.permissions[key]=key==="capture"?"denied":false;},key);
  await page.getByRole("button",{name:`设置${label}权限`,exact:true}).click();
  await expect(page.getByText("已打开系统设置，是否授权以返回后的检测结果为准。",{exact:true})).toBeVisible();
  await expect(page.getByRole("group",{name:label,exact:true}).getByText("未授权",{exact:true})).toBeVisible();
  await page.evaluate(key=>{const f=(window as any).screenSettingsFixture;f.state.local.permissions[key]=key==="capture"?"granted":true;window.dispatchEvent(new Event("focus"));},key);
  await expect(page.getByRole("group",{name:label,exact:true}).getByText("已授权",{exact:true})).toBeVisible();await expect(page.getByText(/点击“\+”/)).toHaveCount(0);
  await page.getByRole("button",{name:`设置${label}权限`,exact:true}).click();
  await expect(page.getByText("已打开系统设置，是否授权以返回后的检测结果为准。",{exact:true})).toBeVisible();
  await expect(page.getByText("权限请求已发起，请完成系统提示后返回此处。",{exact:true})).toHaveCount(0);
 }
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.configured)).toEqual([]);
});
test("permission settings receipt is not a grant; focus refresh reads real values and denial can retry",async({page})=>{
 await page.goto(url());await page.getByRole("button",{name:"设置输入监控权限",exact:true}).click();
 await expect(page.getByRole("group",{name:"输入监控",exact:true}).getByText("未授权",{exact:true})).toBeVisible();await expect(page.getByText(/点击“\+”/)).toBeVisible();
 await page.evaluate(()=>{(window as any).screenSettingsFixture.state.permissionError=true;});await page.getByRole("button",{name:"设置输入监控权限",exact:true}).click();await expect(page.getByRole("alert")).toBeVisible();await expect(page.getByText("已打开系统设置，是否授权以返回后的检测结果为准。",{exact:true})).toHaveCount(0);
 await page.evaluate(()=>{const f=(window as any).screenSettingsFixture;f.state.permissionError=false;f.state.local.permissions.inputMonitoring=true;window.dispatchEvent(new Event("focus"));});
 await expect(page.getByRole("group",{name:"输入监控",exact:true}).getByText("已授权",{exact:true})).toBeVisible();await expect(page.getByText(/点击“\+”/)).toHaveCount(0);
 await page.getByRole("button",{name:"设置输入监控权限",exact:true}).click();await expect(page.getByRole("alert")).toHaveCount(0);
});
test("a caller without its own screen callback still opens the selected remote host",async({page})=>{
 await page.goto(url("?panel&remote&ready"));await page.getByRole("button",{name:"查看屏幕",exact:true}).click();
 const panel=page.getByRole("complementary",{name:"远程屏幕",exact:true});await expect(panel).toBeVisible();await expect(panel.getByText("Other Mac",{exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"展开屏幕",exact:true})).toHaveCount(0);
 await page.getByRole("button",{name:"连接屏幕",exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).screenSettingsFixture.state.opens)).toEqual(["host-b"]);
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.native.filter((c:any)=>c.command.startsWith("screen_service")))).toEqual([]);
 await page.getByRole("button",{name:"断开并关闭屏幕",exact:true}).click();await expect(page.getByRole("button",{name:"查看屏幕",exact:true})).toBeVisible();await expect(page.getByLabel("Local draft")).toHaveValue("keep draft");
});
test("dirty entry stays visible, and host changes never reuse the previous authorization",async({page})=>{
 await page.goto(url("?ready"));await expect(page.getByRole("button",{name:"查看屏幕",exact:true})).toBeEnabled();await page.getByRole("button",{name:"Toggle busy"}).click();await expect(page.getByRole("button",{name:"查看屏幕",exact:true})).toBeDisabled();
 await page.getByRole("button",{name:"Toggle busy"}).click();await page.evaluate(()=>{const f=(window as any).screenSettingsFixture;f.state.holdRead=true;f.state.status.permission="none";});
 await page.getByRole("button",{name:"Switch host"}).click();await expect(page.getByRole("button",{name:"查看屏幕",exact:true})).toBeDisabled();await page.evaluate(()=>(window as any).screenSettingsFixture.state.release());await expect(page.getByText("此设备尚未获得查看授权。",{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.configured)).toEqual([]);
});
test("service offline, capture denied, main switch and device grant are independent",async({page})=>{
 await page.goto(url("?ready"));const view=page.getByRole("button",{name:"查看屏幕",exact:true});await expect(view).toBeEnabled();
 await page.evaluate(()=>{const f=(window as any).screenSettingsFixture;f.state.status.desktop=null;window.dispatchEvent(new Event("focus"));});await expect(view).toBeDisabled();await expect(page.getByText("屏幕服务尚未注册，请在目标 Mac 检查或重试屏幕服务。",{exact:true})).toBeVisible();
 await page.evaluate(()=>{const f=(window as any).screenSettingsFixture;f.state.status.desktop={...f.desktop,capture:"denied"};window.dispatchEvent(new Event("focus"));});await expect(page.getByText("请在目标 Mac 允许 TaroBird 录制屏幕，再重新连接。",{exact:true})).toBeVisible();
 await page.evaluate(()=>{const f=(window as any).screenSettingsFixture;f.state.status.desktop=f.desktop;f.state.status.enabled=false;window.dispatchEvent(new Event("focus"));});await expect(page.getByText("请先在目标 Mac 开启允许远程屏幕。",{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.configured)).toEqual([]);
});
test("all permission buttons target their own kind and retry never changes grants",async({page},info)=>{
 await page.goto(url());
 for(const name of ["设置屏幕录制权限","设置辅助功能权限","设置输入监控权限"])await page.getByRole("button",{name,exact:true}).click();
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.native.filter((v:any)=>v.command==="screen_service_permission").map((v:any)=>v.args.kind))).toEqual(["capture","accessibility","input-monitoring"]);
 await page.getByRole("button",{name:"重试屏幕服务",exact:true}).click();
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.configured)).toEqual([]);
 await page.screenshot({path:info.outputPath("screen-readiness-settings.png")});
});
test("failed status refresh removes stale readiness and a later refresh recovers",async({page})=>{
 await page.goto(url("?ready"));const view=page.getByRole("button",{name:"查看屏幕",exact:true});await expect(view).toBeEnabled();
 await page.evaluate(()=>{(window as any).screenSettingsFixture.state.failRead=true;window.dispatchEvent(new Event("focus"));});await expect(view).toBeDisabled();await expect(page.getByRole("alert")).toBeVisible();
 await page.evaluate(()=>{(window as any).screenSettingsFixture.state.failRead=false;});await page.getByRole("button",{name:"刷新状态",exact:true}).click();await expect(view).toBeEnabled();await expect(page.getByRole("alert")).toHaveCount(0);
});
test("denied remote device cannot invoke local system permissions or local recovery",async({page})=>{
 await page.goto(url("?remote"));await expect(page.getByRole("button",{name:"查看屏幕",exact:true})).toBeDisabled();
 await expect(page.getByRole("button",{name:"设置屏幕录制权限",exact:true})).toHaveCount(0);await expect(page.getByRole("button",{name:"重试屏幕服务",exact:true})).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.native)).toEqual([]);
});

test("an open viewer recovers its display list after service recovery and checks grants again before connecting",async({page})=>{
 await page.goto(url("?panel&remote&ready"));await page.getByRole("button",{name:"查看屏幕",exact:true}).click();
 const connect=page.getByRole("button",{name:"连接屏幕",exact:true});await expect(connect).toBeEnabled();
 await page.evaluate(()=>{const f=(window as any).screenSettingsFixture;f.state.status.desktop=null;window.dispatchEvent(new Event("focus"));});await expect(connect).toBeDisabled();
 await page.evaluate(()=>{const f=(window as any).screenSettingsFixture;f.state.status.desktop=f.desktop;window.dispatchEvent(new Event("focus"));});await expect(connect).toBeEnabled();
 await page.evaluate(()=>(window as any).screenSettingsFixture.state.status.permission="none");await connect.click();
 await expect(page.getByText("请在目标 Mac 的远程屏幕设置中授权此设备。",{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.opens)).toEqual([]);
});

test("a failed native permission request keeps the manual settings path and a later retry clears the error",async({page})=>{
 await page.goto(url());await page.evaluate(()=>(window as any).screenSettingsFixture.state.requestError=true);
 await page.getByRole("button",{name:"设置输入监控权限",exact:true}).click();
 await expect(page.getByRole("alert")).toHaveText("系统权限请求未完成，请重试或在系统设置 → 隐私与安全性中添加 TaroBird。");
 await expect(page.getByText("已打开系统设置，是否授权以返回后的检测结果为准。",{exact:true})).toBeVisible();
 await expect(page.getByRole("group",{name:"输入监控",exact:true}).getByText("未授权",{exact:true})).toBeVisible();
 await page.evaluate(()=>(window as any).screenSettingsFixture.state.requestError=false);await page.getByRole("button",{name:"设置输入监控权限",exact:true}).click();await expect(page.getByRole("alert")).toHaveCount(0);
});

test("the desktop-only section does not poll the Host or native IPC in a mobile or web renderer",async({page})=>{
 await page.goto(url("?web"));await expect(page.getByLabel("Local draft")).toBeVisible();
 await expect(page.getByRole("region",{name:"远程屏幕",exact:true})).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.reads)).toEqual([]);
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.native)).toEqual([]);
});

test("local startup recovery remains available when Host reads fail and is disabled during registration",async({page})=>{
 await page.goto(url());await page.evaluate(()=>{(window as any).screenSettingsFixture.state.failRead=true;window.dispatchEvent(new Event("focus"));});
 await expect(page.getByRole("alert")).toBeVisible();const retry=page.getByRole("button",{name:"重试屏幕服务",exact:true});await expect(retry).toBeEnabled();await retry.click();await expect(retry).toBeDisabled();
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.configured)).toEqual([]);
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.native.filter((c:any)=>c.command!=="screen_service_status"))).toEqual([{command:"screen_service_retry",args:{}}]);
});
test("the screen control dialog stays movable after its embedded screen viewer closes",async({page})=>{
 await page.goto(url("?panel&remote&ready"));const dialog=page.locator("dialog.connection-dialog");
 // The fixture uses the real theme. Measure only after its entrance animation
 // settles, so a moving starting point cannot skew the pointer displacement.
 const settle=()=>dialog.evaluate(async node=>{await Promise.all(node.getAnimations().map(animation=>animation.finished.catch(()=>{})));});
 await settle();
 const left=()=>dialog.evaluate(node=>Math.round(node.getBoundingClientRect().left)),top=()=>dialog.evaluate(node=>Math.round(node.getBoundingClientRect().top)),translate=()=>dialog.evaluate(node=>(node as HTMLElement).style.translate);
 const drag=async(dx:number,dy:number)=>{const box=(await dialog.locator(":scope>header.preferences-header>h2").boundingBox())!;await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+dx,box.y+box.height/2+dy,{steps:6});await page.mouse.up();};
 const x0=await left(),y0=await top();await drag(-40,30);expect(await translate()).not.toBe("");expect([await left()-x0,await top()-y0]).toEqual([-40,30]);
 await page.getByRole("button",{name:"查看屏幕",exact:true}).click();await expect(page.getByRole("complementary",{name:"远程屏幕",exact:true})).toBeVisible();
 await page.getByRole("button",{name:"断开并关闭屏幕",exact:true}).click();await expect(dialog.locator(":scope>header.preferences-header")).toBeVisible();
 await settle();
 // The header is a new element after the viewer. Measure from where the dialog
 // is now, so a reset translate cannot pass for a successful drag.
 const before=await translate(),x1=await left(),y1=await top();
 await drag(-60,20);
 const after=await translate();expect(after).not.toBe("");expect(after).not.toBe(before);expect([await left()-x1,await top()-y1]).toEqual([-60,20]);
 // Header controls keep their own clicks; pressing one does not start a drag.
 await dialog.getByRole("button",{name:"关闭屏幕控制设置",exact:true}).click();await expect(dialog).toHaveCount(0);
});

test("the connection page keeps one row to Screen control and opens it as a sub-page with the same section",async({page})=>{
 await page.goto(url("?connection&remote&ready"));const connection=page.getByRole("dialog",{name:"连接状态与线路",exact:true});await expect(connection).toBeVisible();
 await expect(connection.locator(".screen-settings")).toHaveCount(0);await expect(connection.getByRole("region",{name:"远程屏幕",exact:true})).toHaveCount(0);
 const row=connection.getByRole("button",{name:/^屏幕控制设置/});await expect(row).toHaveCount(1);await row.click();
 const screen=page.getByRole("dialog",{name:"屏幕控制设置",exact:true});await expect(screen).toBeVisible();
 await expect(screen.getByRole("region",{name:"远程屏幕",exact:true})).toBeVisible();await expect(screen.getByRole("button",{name:"查看屏幕",exact:true})).toBeEnabled();
 await screen.getByRole("button",{name:"查看屏幕",exact:true}).click();await expect(page.getByRole("complementary",{name:"远程屏幕",exact:true})).toBeVisible();
 await page.getByRole("button",{name:"断开并关闭屏幕",exact:true}).click();await expect(screen.getByRole("button",{name:"查看屏幕",exact:true})).toBeVisible();
 await screen.getByRole("button",{name:"返回连接状态与线路",exact:true}).click();await expect(screen).toHaveCount(0);await expect(connection).toBeVisible();await expect(row).toBeFocused();
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.native.filter((c:any)=>/^screen_(service_permission|viewer_open)/.test(c.command)))).toEqual([]);
});

test("device access shortcut only reveals the current GUI device; saving stays explicit and targets the selected host",async({page})=>{
 await page.goto(url("?remote&configured"));
 const manage=page.getByRole("button",{name:"管理设备授权",exact:true});await expect(manage).toBeVisible();
 const access=page.getByRole("combobox",{name:"GUI device的屏幕权限",exact:true});await expect(access).not.toBeVisible();
 await manage.click();await expect(access).toBeVisible();await expect(access).toBeFocused();await expect(access).toHaveValue("none");
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.configured)).toEqual([]);
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.native.filter((c:any)=>c.command.startsWith("screen_service")))).toEqual([]);
 await access.selectOption("view");
 await expect.poll(()=>page.evaluate(()=>(window as any).screenSettingsFixture.state.configured.length)).toBe(1);
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.configured[0])).toMatchObject({key:"host-b",value:{operation:"screen.configure",expectedRevision:7,enabled:true,grants:[{deviceId:"gui-device",publicKey:"device-key",permission:"view"}]}});
});

test("the master switch retains device grants and blocks concurrent settings until the save finishes",async({page})=>{
 await page.goto(url("?configured"));
 await page.evaluate(()=>{const f=(window as any).screenSettingsFixture;f.state.status.policy.grants=[{deviceId:"other-device",publicKey:"other-key",permission:"view"}];f.state.holdConfigure=true;window.dispatchEvent(new Event("focus"));});
 const toggle=page.getByRole("checkbox",{name:"允许远程屏幕",exact:true});await expect(toggle).toBeChecked();await toggle.click();
 await expect(toggle).toBeDisabled();await expect(page.getByRole("button",{name:"设置屏幕录制权限",exact:true})).toBeDisabled();
 await expect(page.getByRole("button",{name:"管理设备授权",exact:true})).toBeDisabled();
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.configured)).toMatchObject([{key:"host-a",value:{enabled:false,grants:[{deviceId:"other-device",publicKey:"other-key",permission:"view"}]}}]);
 await page.evaluate(()=>(window as any).screenSettingsFixture.state.releaseConfigure());await expect(toggle).toBeEnabled();await expect(toggle).not.toBeChecked();
 await expect(page.getByRole("button",{name:"查看屏幕",exact:true})).toBeDisabled();
});

test("non-managers get actionable remote instructions without device grant or native permission controls",async({page})=>{
 await page.goto(url("?remote&configured"));await page.evaluate(()=>{const f=(window as any).screenSettingsFixture;f.state.status.canManage=false;window.dispatchEvent(new Event("focus"));});
 await expect(page.getByText("请在目标 Mac 的已配对设备列表中，明确允许此设备“仅查看”或“查看并控制”。",{exact:true})).toBeVisible();
 await expect(page.getByRole("button",{name:"管理设备授权",exact:true})).toHaveCount(0);await expect(page.getByRole("checkbox",{name:"允许远程屏幕",exact:true})).toHaveCount(0);
 await expect(page.getByRole("button",{name:"设置屏幕录制权限",exact:true})).toHaveCount(0);
 await expect(page.locator(".screen-settings-intro")).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.configured)).toEqual([]);
});

test("active sharing stays above permissions and disconnects only the selected session",async({page})=>{
 await page.goto(url("?configured"));await page.evaluate(()=>{const f=(window as any).screenSettingsFixture;f.state.status.sessions=[{id:"live-session",deviceName:"Viewer Mac",display:f.desktop.displays[0],state:"viewing"}];window.dispatchEvent(new Event("focus"));});
 const sessions=page.locator(".screen-active-sessions");await expect(sessions).toBeVisible();await expect(sessions.locator(".screen-setting-row>span")).toContainText("Viewer Mac");
 expect((await sessions.boundingBox())!.y).toBeLessThan((await page.locator(".screen-system-permissions").boundingBox())!.y);
 await sessions.getByRole("button",{name:"断开",exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).screenSettingsFixture.state.stops)).toEqual(["live-session"]);
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.configured)).toEqual([]);
});

test("failed reads show unknown access and switching hosts resets the device list",async({page})=>{
 await page.goto(url("?configured"));await page.getByRole("button",{name:"管理设备授权",exact:true}).click();
 await expect(page.getByRole("combobox",{name:"GUI device的屏幕权限",exact:true})).toBeFocused();
 await page.getByRole("button",{name:"Switch host",exact:true}).click();
 await expect(page.getByRole("combobox",{name:"GUI device的屏幕权限",exact:true})).not.toBeVisible();
 await page.evaluate(()=>{const f=(window as any).screenSettingsFixture;f.state.failRead=true;window.dispatchEvent(new Event("focus"));});
 await expect(page.locator(".screen-readiness dd").filter({hasText:"未知"})).toHaveCount(2);
 await expect(page.getByText("无法读取屏幕状态，请刷新重试。",{exact:true})).toBeVisible();
 await expect(page.getByRole("button",{name:"查看屏幕",exact:true})).toBeDisabled();
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.configured)).toEqual([]);
});

for(const english of [false,true])test(`compact settings distinguish system permissions and GUI access without overflow (${english?"en":"zh"})`,async({page},info)=>{
 await page.setViewportSize({width:980,height:860});await page.goto(url(`?panel&configured${english?"&en":""}`));
 const section=page.getByRole("region",{name:english?"Remote screen":"远程屏幕",exact:true});await expect(section).toBeVisible();
 const view=page.getByRole("button",{name:english?"View screen":"查看屏幕",exact:true});await expect(view).toBeDisabled();
 await expect(section.locator(".screen-readiness").getByText(english?"Registered":"已注册",{exact:true})).toHaveCount(1);
 await expect(section.locator(".screen-permission-value").filter({hasText:english?"Allowed":"已授权"})).toHaveCount(3);
 for(const button of await section.locator(".screen-permission-row>button").all())expect((await button.getAttribute("aria-label"))!.toLowerCase()).toContain((await button.innerText()).toLowerCase());
 // The shared theme contributes its decorative expansion marker to the name.
 await expect(section.locator(".screen-device-permissions>summary")).toHaveAccessibleName(english?/^(› )?Device access$/:/^(› )?设备授权$/);
 expect((await section.locator(".screen-entry-help").boundingBox())!.y).toBeLessThan((await section.locator(".screen-system-permissions").boundingBox())!.y);
 const dialog=page.locator("dialog.connection-dialog");await page.mouse.move(0,0);await page.screenshot({path:info.outputPath(`remote-screen-settings-${english?"en":"zh"}.png`),clip:(await dialog.boundingBox())!});
 for(const width of [780,390]){
  await page.setViewportSize({width,height:860});
  await expect.poll(()=>section.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
  for(const button of await section.locator(".screen-permission-row>button").all())await expect(button).toBeVisible();
 }
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.configured)).toEqual([]);
});

for(const english of [false,true])test(`a computer that cannot be a screen target says so and offers no switch, grants or reinstall advice (${english?"en":"zh"})`,async({page},info)=>{
 const text=english?{state:"Not supported",help:"This computer's system can't be viewed or controlled remotely yet. Viewing other computers from here still works.",view:"View screen",region:"Remote screen"}
  :{state:"暂不支持",help:"这台电脑的系统暂时不能被远程查看或控制。从这台电脑查看其他电脑不受影响。",view:"查看屏幕",region:"远程屏幕"};
 await page.goto(url(`?native=platform&platform=win32${english?"&en":""}`));
 const section=page.getByRole("region",{name:text.region,exact:true});
 await expect(section.locator(".screen-readiness").getByText(text.state,{exact:true})).toBeVisible();
 await expect(section.getByText(text.help,{exact:true})).toBeVisible();
 await expect(page.getByRole("button",{name:text.view,exact:true})).toBeDisabled();
 // The Host still reports a manageable policy; none of it is offered here.
 const absent=async()=>{
  await expect(section.getByRole("checkbox")).toHaveCount(0);await expect(section.locator(".screen-settings-intro")).toHaveCount(0);
  await expect(section.locator(".screen-device-permissions,.screen-system-permissions,.screen-service-recovery,.screen-permission-explanation")).toHaveCount(0);
  await expect(section.getByRole("button")).toHaveCount(2);
  for(const sentence of ["尚未注册","屏幕服务尚未注册，请在目标 Mac 检查或重试屏幕服务。","屏幕原生模块不可用，请重新安装完整的 TaroBird 桌面版。","Not registered","The native screen module is unavailable. Reinstall the complete TaroBird desktop app."])await expect(section.getByText(sentence,{exact:true})).toHaveCount(0);
 };
 await absent();
 // The reported case: a granted device on a Host whose own desktop never registers.
 await page.evaluate(()=>{const f=(window as any).screenSettingsFixture;f.state.status.permission="view";window.dispatchEvent(new Event("focus"));});
 await expect(section.locator(".screen-readiness dd").filter({hasText:english?"View only":"仅查看"})).toBeVisible();
 await expect(section.getByText(text.help,{exact:true})).toBeVisible();await absent();
 expect(await page.evaluate(()=>[...new Set((window as any).screenSettingsFixture.state.native.map((c:any)=>c.command))])).toEqual(["screen_service_status"]);
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.configured)).toEqual([]);
 await page.mouse.move(0,0);await page.screenshot({path:info.outputPath(`screen-target-unsupported-${english?"en":"zh"}.png`)});
});

test("target support follows the native service's verdict, not the platform name",async({page})=>{
 // A supported service on another platform shows the ordinary state and controls.
 await page.goto(url("?platform=win32&configured"));
 await expect(page.locator(".screen-readiness").getByText("已注册",{exact:true})).toBeVisible();
 await expect(page.getByRole("checkbox",{name:"允许远程屏幕",exact:true})).toBeVisible();
 await expect(page.getByRole("button",{name:"管理设备授权",exact:true})).toBeVisible();
 await expect(page.getByText("暂不支持",{exact:true})).toHaveCount(0);
 // macOS-only system permission controls stay macOS-only.
 await expect(page.locator(".screen-system-permissions")).toHaveCount(0);
 // A Windows computer has no permission to set: it says what its session allows, and offers no button for it.
 await expect(page.locator(".screen-local-state").getByText("这台电脑可以被查看和控制。Windows 不需要另外授予系统权限。",{exact:true})).toBeVisible();
 await expect(page.locator(".screen-local-state").getByRole("button")).toHaveCount(0);
 await page.getByText("权限说明",{exact:true}).click();
 await expect(page.getByText("Windows 不需要另外授予系统权限。锁屏和安全提示出现时共享会停止；以管理员身份运行的窗口能看到，但不能被远程控制。配对和总开关不会自动授权设备。",{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.native.filter((c:any)=>c.command==="screen_service_permission"))).toEqual([]);
 // Locked, or a release Windows has not taken yet: the same line says which.
 await page.evaluate(()=>{const f=(window as any).screenSettingsFixture;Object.assign(f.state.local.permissions,{capture:"unavailable",accessibility:false});window.dispatchEvent(new Event("focus"));});
 await expect(page.locator(".screen-local-state").getByText("这台电脑已锁定、会话已断开或正在显示安全提示，暂时不能被查看或控制。",{exact:true})).toBeVisible();
 await page.evaluate(()=>{const f=(window as any).screenSettingsFixture;Object.assign(f.state.local.permissions,{capture:"granted",accessibility:false});window.dispatchEvent(new Event("focus"));});
 await expect(page.locator(".screen-local-state").getByText("上一次远程控制按下的按键还没有全部松开，暂时不能被控制；回到桌面后会自动完成。",{exact:true})).toBeVisible();
 // The same "no target for this platform" verdict is honoured whatever the shell reports.
 await page.goto(url("?native=platform"));
 await expect(page.locator(".screen-readiness").getByText("暂不支持",{exact:true})).toBeVisible();
 await expect(page.getByRole("checkbox",{name:"允许远程屏幕",exact:true})).toHaveCount(0);
 await expect(page.locator(".screen-system-permissions,.screen-device-permissions")).toHaveCount(0);
});

test("a Mac without the native screen functions keeps its reinstall notice and controls",async({page})=>{
 await page.goto(url("?native=addon"));
 await expect(page.locator(".screen-readiness").getByText("不可用",{exact:true})).toBeVisible();
 await expect(page.getByRole("alert")).toHaveText("屏幕原生模块不可用，请重新安装完整的 TaroBird 桌面版。");
 await expect(page.getByRole("checkbox",{name:"允许远程屏幕",exact:true})).toBeVisible();
 await expect(page.locator(".screen-system-permissions")).toBeVisible();
 await expect(page.locator(".screen-device-permissions")).toHaveCount(1);
 await expect(page.getByRole("button",{name:"重试屏幕服务",exact:true})).toHaveCount(0);
 await expect(page.getByText("暂不支持",{exact:true})).toHaveCount(0);
 await expect(page.getByText("这台电脑的系统暂时不能被远程查看或控制。从这台电脑查看其他电脑不受影响。",{exact:true})).toHaveCount(0);
});

for(const english of [false,true])test(`a remote Host without a registered desktop points at that computer, not at a Mac (${english?"en":"zh"})`,async({page})=>{
 const sentence=english?"Screen service isn't registered. Open TaroBird on that computer.":"屏幕服务尚未注册。请在目标电脑上打开 TaroBird 并检查。";
 await page.goto(url(`?remote&ready${english?"&en":""}`));await expect(page.getByRole("button",{name:english?"View screen":"查看屏幕",exact:true})).toBeEnabled();
 await page.evaluate(()=>{const f=(window as any).screenSettingsFixture;f.state.status.desktop=null;window.dispatchEvent(new Event("focus"));});
 await expect(page.getByText(sentence,{exact:true})).toBeVisible();
 await expect(page.getByText(english?"The screen service is not registered. Check or retry it on the target Mac.":"屏幕服务尚未注册，请在目标 Mac 检查或重试屏幕服务。",{exact:true})).toHaveCount(0);
 // A remote Host is never probed through this computer's native service.
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.native)).toEqual([]);
});

for(const english of [false,true])test(`an unauthorized remote device gets platform-neutral guidance when its desktop is private (${english?"en":"zh"})`,async({page})=>{
 await page.goto(url(`?remote${english?"&en":""}`));
 await expect(page.getByRole("button",{name:english?"Refresh status":"刷新状态",exact:true})).toBeVisible();
 await page.evaluate(()=>{const state=(window as any).screenSettingsFixture.state.status;state.canManage=false;state.permission="none";state.desktop=null;delete state.policy;window.dispatchEvent(new Event("focus"));});
 const sentence=english?"On the target computer, explicitly allow View only or View and control for this device in the paired device list.":"请在目标电脑的已配对设备列表中，明确允许此设备“仅查看”或“查看并控制”。";
 await expect(page.getByText(sentence,{exact:true})).toBeVisible();
 await expect(page.locator(".screen-entry-help")).not.toContainText("Mac");
 await expect(page.getByRole("button",{name:english?"View screen":"查看屏幕",exact:true})).toBeDisabled();
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.native)).toEqual([]);
});

for(const english of [false,true])test(`a remote disabled screen with a private desktop uses neutral guidance (${english?"en":"zh"})`,async({page})=>{
 await page.goto(url(`?remote${english?"&en":""}`));
 await expect(page.getByRole("button",{name:english?"Refresh status":"刷新状态",exact:true})).toBeVisible();
 await page.evaluate(()=>{const state=(window as any).screenSettingsFixture.state.status;state.canManage=false;state.enabled=false;state.desktop=null;delete state.policy;window.dispatchEvent(new Event("focus"));});
 await expect(page.getByText(english?"Turn on Allow remote screen on the target computer first.":"请先在目标电脑开启允许远程屏幕。",{exact:true})).toBeVisible();
 await expect(page.locator(".screen-entry-help")).not.toContainText("Mac");
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.native)).toEqual([]);
});

test("UDP boost checkbox is capability-gated on older Hosts and never sends udpBoost in configure",async({page})=>{
 await page.goto(url("?no-udp-boost&configured"));
 const udpToggle=page.getByRole("checkbox",{name:"UDP 加速（实验性）",exact:true});
 await expect(udpToggle).toBeDisabled();
 await expect(udpToggle).not.toBeChecked();
 await expect(page.locator(".screen-udp-status")).toHaveText("需更新主机");
 await expect(page.locator(".screen-udp-boost")).toContainText("此主机需要更新后才能开启 UDP 加速。");
 // Changing another policy setting on an older Host must never attach udpBoost.
 await page.getByRole("checkbox",{name:"允许远程屏幕",exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).screenSettingsFixture.state.configured.length)).toBe(1);
 expect(await page.evaluate(()=>Object.hasOwn((window as any).screenSettingsFixture.state.configured[0].value,"udpBoost"))).toBe(false);
});

test("UDP boost settings accurately render disabled, connected, and all fallback_tcp reasons with detail",async({page})=>{
 await page.goto(url("?configured"));
 const udpToggle=page.getByRole("checkbox",{name:"UDP 加速（实验性）",exact:true});
 const badge=page.locator(".screen-udp-status");
 const card=page.locator(".screen-udp-boost");
 await expect(udpToggle).toBeEnabled();
 await expect(udpToggle).not.toBeChecked();
 await expect(badge).toHaveText("未开启 · 当前使用 TCP");

 // Enable UDP boost -> sends udpBoost: true.
 await udpToggle.click();
 await expect.poll(()=>page.evaluate(()=>(window as any).screenSettingsFixture.state.configured.length)).toBe(1);
 expect(await page.evaluate(()=>(window as any).screenSettingsFixture.state.configured[0].value.udpBoost)).toBe(true);

 // Connected state must show connected guidance (never contradictory TCP fallback text) and surface detail.
 await page.evaluate(()=>{const f=(window as any).screenSettingsFixture;f.state.status.policy.udpBoost=true;f.state.status.udpStatus={enabled:true,state:"connected",route:"udp_vps_relay",detail:"relay 9443/udp active"};window.dispatchEvent(new Event("focus"));});
 await expect(badge).toHaveText("已连通");
 await expect(card).toContainText("UDP 媒体通道已连通，对本机所有查看设备生效。");
 await expect(card).not.toContainText("已自动回退 TCP");
 await expect(card.locator(".screen-udp-detail")).toHaveText("relay 9443/udp active");

 // Fallback: udp_relay_port_closed (must not hardcode 8443/udp, and surfaces detail).
 await page.evaluate(()=>{const f=(window as any).screenSettingsFixture;f.state.status.udpStatus={enabled:true,state:"fallback_tcp",route:"tcp_vps_relay",reasonCode:"udp_relay_port_closed",detail:"9443/udp blocked"};window.dispatchEvent(new Event("focus"));});
 await expect(badge).toHaveText("未连通 · 已自动回退 TCP");
 await expect(card).toContainText("中继服务器的 UDP 端口未开放");
 await expect(card).not.toContainText("8443/udp");
 await expect(card.locator(".screen-udp-detail")).toHaveText("9443/udp blocked");

 // Fallback: peer_unsupported.
 await page.evaluate(()=>{const f=(window as any).screenSettingsFixture;f.state.status.udpStatus={enabled:true,state:"fallback_tcp",route:"tcp_lan_direct",reasonCode:"peer_unsupported"};window.dispatchEvent(new Event("focus"));});
 await expect(card).toContainText("当前查看端或对端暂不支持 UDP 媒体通道");
 await expect(card.locator(".screen-udp-detail")).toHaveCount(0);

 // Fallback: udp_transport_unavailable.
 await page.evaluate(()=>{const f=(window as any).screenSettingsFixture;f.state.status.udpStatus={enabled:true,state:"fallback_tcp",route:"tcp_tailscale",reasonCode:"udp_transport_unavailable"};window.dispatchEvent(new Event("focus"));});
 await expect(card).toContainText("当前没有收到 UDP 画面");
});
