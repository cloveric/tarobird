import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { PERSONAL_BROWSER_SCOPE } from "../shared/personal-browser.mjs";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
async function fixture(page: Page, personal = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "browser-extensions-ui-"));
  const hub = await HubServer.start({ stateDir: directory, clientDir: path.resolve("dist") });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','网页助手','fixture')");
  const conversation = await hub.store.createConversation("owner", ["alpha"], "扩展验收", "extensions_chat");
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, conversation.title);
  await page.evaluate(() => {
    const tabs = new Map<string, any>(), listeners = new Set<(event: any) => void>();
    const f = { calls: [] as any[], tabs, listeners, entries: [] as any[], modes: new Map<string, boolean>(), modeOutcome: "cancelled", installError: "", oldNative: false, externalFails: false, widen: false };
    const emit = (event: any) => listeners.forEach(receive => receive(event));
    Object.assign(window, { extensionsFixture: f, tarobotDesktop: {
      version: 1, engine: "electron", platform: "darwin", openSocket: async () => { throw Error("unexpected_socket"); },
      on: (event: string, receive: (payload: any) => void) => { if (event === "workbench-browser") listeners.add(receive); return () => listeners.delete(receive); },
      invoke: async (command: string, args: any) => {
        f.calls.push({ command, args: structuredClone(args) });
        if (command === "desktop_open_url") { if (f.externalFails) throw Error("open_failed"); return; }
        if (command === "workbench_browser_extensions") {
          if (f.oldNative) throw Error("unknown_desktop_command");
          const key = JSON.stringify(args.scope);
          if (args.action === "list") return { status: "ok", extensions: structuredClone(f.entries) };
          if (args.action === "compat") return { status: "ok", enabled: f.modes.get(key) === true, active: f.modes.get(key) === true };
          if (args.action === "compat_set") { if (args.enabled && f.modeOutcome === "cancelled") return { status: "cancelled" }; f.modes.set(key, args.enabled); emit({ kind: "extensions" }); return { status: "ok", enabled: args.enabled, active: args.enabled }; }
          if (args.action === "install") {
            if (f.installError) return { status: f.installError === "extension_changed" ? "cancelled" : "failed", error: f.installError };
            const entry = { id: "a".repeat(32), name: "Example blocker", version: "1.0", enabled: true, scope: "personal", source: args.source, signature: args.source === "store" ? "store" : "none", loaded: 1, installedAt: 1,
              optionsAvailable: true, report: { manifestVersion: 3, description: "Example extension", hostAccess: "all", hosts: ["<all_urls>"], verdict: "limited", warnings: [], features: [{ code: "network_rules", status: "not_enforced" }, { code: "toolbar", status: "unavailable" }, { code: "options_page", status: "supported" }] } };
            f.entries = [entry]; emit({ kind: "extensions" }); return { status: "ok", extension: entry };
          }
          if (args.action === "set") { if (args.scope === "all" && !f.widen) return { status: "cancelled" }; const entry = f.entries.find(e => e.id === args.id); Object.assign(entry, args.scope ? { scope: args.scope } : { enabled: args.enabled }); emit({ kind: "extensions" }); return { status: "ok", extension: entry }; }
          if (args.action === "remove") { f.entries = []; emit({ kind: "extensions" }); return { status: "ok" }; }
          return { status: "ok" };
        }
        if (command !== "workbench_browser") return;
        if (args.action === "capabilities") return { status: "ok", window: "native-window", actions: ["settings", "history"] };
        if (args.action === "settings") return { status: "ok", settings: { searchEngine: "google", defaultZoom: 1, recordHistory: true } };
        if (args.action === "list") return { status: "ok", tabs: [...tabs.values()].filter(t => JSON.stringify(t.scope) === JSON.stringify(args.scope)) };
        if (args.action === "open" || args.action === "navigate") { const old = tabs.get(args.tab); const tab = { tab: args.tab, scope: args.scope, url: args.url === "about:blank" ? "https://example.test/" : args.url, title: "扩展测试网页", state: "live", navigation: (old?.navigation ?? 0) + 1 }; tabs.set(args.tab, tab); queueMicrotask(() => emit({ ...tab, kind: "state" })); return { status: "ok", ...tab }; }
        return { status: "ok" };
      },
    }});
  });
  if (personal) { await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click(); await page.locator(".adhd-toolbar .adhd-browser-entry").click(); }
  else { await page.getByRole("button", { name: "工作台", exact: true }).click(); await page.getByRole("complementary", { name: "工作台", exact: true }).getByRole("button", { name: "网页", exact: true }).click(); }
  const pane = page.getByRole("tabpanel", { name: "扩展测试网页", exact: true }); await expect(pane).toBeVisible();
  const open = async () => { await pane.getByRole("button", { name: "网页工具与下载", exact: true }).click(); await page.getByRole("menu", { name: "网页工具", exact: true }).getByRole("button", { name: "扩展程序", exact: true }).click(); return page.getByRole("dialog", { name: "扩展程序", exact: true }); };
  return { pane, open, conversation, close: async () => { await page.close(); await hub.close(); await rm(directory, { recursive: true, force: true }); } };
}

for (const personal of [false, true]) test(`extension mode starts off, cancellation retains it, and targets the ${personal ? "personal" : "conversation"} scope`, async ({page}, info) => {
  const f = await fixture(page, personal);
  try {
    const dialog = await f.open(), checkbox = dialog.getByRole("checkbox", {name: "扩展兼容模式", exact: true});
    await expect(checkbox).not.toBeChecked(); await expect(checkbox).toBeEnabled();
    expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
    const label=dialog.getByLabel("Chrome 应用商店链接或扩展 ID");
    expect((await label.boundingBox())!.width).toBeGreaterThan(200);
    await checkbox.click(); await expect(checkbox).not.toBeChecked();
    await page.evaluate(() => { (window as any).extensionsFixture.modeOutcome = "ok"; });
    await checkbox.check(); await expect(checkbox).toBeChecked();
    const calls = await page.evaluate(() => (window as any).extensionsFixture.calls.filter((c:any) => c.args?.action === "compat_set"));
    expect(calls).toHaveLength(2); for (const c of calls) { expect(c.command).toBe("workbench_browser_extensions"); expect(c.args.scope).toEqual(personal ? PERSONAL_BROWSER_SCOPE : expect.objectContaining({conversation:f.conversation.id})); }
    await checkbox.uncheck(); await expect(checkbox).not.toBeChecked();
    await page.screenshot({path:info.outputPath(`extensions-${personal ? "personal" : "conversation"}.png`)});
  } finally { await f.close(); }
});

test("store installation keeps compatibility off, explains restrictions, and confirms removal", async ({page},info) => {
  const f = await fixture(page);
  try {
    const dialog=await f.open(), url="https://chromewebstore.google.com/detail/example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await dialog.getByLabel("Chrome 应用商店链接或扩展 ID").fill(url); await dialog.getByRole("button",{name:"从应用商店添加",exact:true}).click();
    await expect(dialog.getByText("Example blocker",{exact:true})).toBeVisible(); await expect(dialog.getByRole("checkbox",{name:"扩展兼容模式",exact:true})).not.toBeChecked();
    await dialog.getByText("权限与兼容性",{exact:true}).click(); await expect(dialog.getByText("需先授权此浏览器",{exact:true})).toBeVisible(); await expect(dialog.getByText("已验证 Chrome 应用商店签名。",{exact:true})).toBeVisible();
    const calls=await page.evaluate(()=>(window as any).extensionsFixture.calls); expect(calls.filter((c:any)=>c.args?.action==='install')[0].args).toEqual({action:"install",source:"store",store:url,english:false});expect(calls.some((c:any)=>c.args?.action==='compat_set')).toBe(false);
    await dialog.getByLabel("运行位置").selectOption("all"); await expect(dialog.getByLabel("运行位置")).toHaveValue("personal");
    await dialog.getByRole("button",{name:"移除 Example blocker",exact:true}).click(); await dialog.getByRole("button",{name:"取消",exact:true}).click();await expect(dialog.getByText("Example blocker",{exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath("extension-review.png")});
    await dialog.getByRole("button",{name:"移除 Example blocker",exact:true}).click();await dialog.getByRole("button",{name:"确认移除",exact:true}).click();await expect(dialog.getByText("尚未添加扩展",{exact:true})).toBeVisible();
  }finally{await f.close();}
});

test("failed installs can retry and old native binaries show actionable feedback",async({page})=>{
  const f=await fixture(page);
  try{
    const dialog=await f.open();await dialog.getByLabel("Chrome 应用商店链接或扩展 ID").fill("a".repeat(32));
    await page.evaluate(()=>(window as any).extensionsFixture.installError="store_download_failed");await dialog.getByRole("button",{name:"从应用商店添加",exact:true}).click();await expect(dialog.getByRole("alert")).toContainText("无法下载扩展");
    await page.evaluate(()=>(window as any).extensionsFixture.installError="");await dialog.getByRole("button",{name:"从应用商店添加",exact:true}).click();await expect(dialog.getByText("Example blocker",{exact:true})).toBeVisible();
    await dialog.getByRole("button",{name:"关闭",exact:true}).last().click();await page.evaluate(()=>(window as any).extensionsFixture.oldNative=true);await f.open();await expect(dialog.getByRole("alert")).toContainText("此版本桌面 App 不支持扩展");await expect(dialog.getByRole("checkbox",{name:"扩展兼容模式",exact:true})).toBeDisabled();
  }finally{await f.close();}
});

for (const personal of [false, true]) test(`extension settings use the exact ${personal ? "personal" : "conversation"} scope without changing compatibility`, async ({ page }) => {
  const f = await fixture(page, personal);
  try {
    let dialog = await f.open();
    await dialog.getByLabel("Chrome 应用商店链接或扩展 ID").fill("a".repeat(32));
    await dialog.getByRole("button", { name: "从应用商店添加", exact: true }).click();
    const settings = () => dialog.getByRole("button", { name: "设置 Example blocker", exact: true });
    if (!personal) {
      const personalSettings = dialog.getByRole("button", { name: "在个人浏览器中设置 Example blocker", exact: true });
      await expect(personalSettings).toBeEnabled();
      await personalSettings.click();
      await expect.poll(() => page.evaluate(() => (window as any).extensionsFixture.calls.filter((c: any) => c.args?.action === "options").length)).toBe(1);
      const call = await page.evaluate(() => (window as any).extensionsFixture.calls.find((c: any) => c.args?.action === "options"));
      expect(call.args.scope).toEqual(PERSONAL_BROWSER_SCOPE);
      await expect(dialog.getByLabel("运行位置")).toHaveValue("personal");
      await page.evaluate(() => { (window as any).extensionsFixture.widen = true; });
      await dialog.getByLabel("运行位置").selectOption("all");
    }
    await expect(settings()).toBeEnabled();
    await settings().click();
    await expect.poll(() => page.evaluate(() => (window as any).extensionsFixture.calls.filter((c: any) => c.args?.action === "options").length)).toBe(personal ? 1 : 2);
    const calls = await page.evaluate(() => (window as any).extensionsFixture.calls);
    const args = calls.filter((c: any) => c.args?.action === "options").at(-1).args;
    expect(args.id).toBe("a".repeat(32));
    expect(args.scope).toEqual(personal ? PERSONAL_BROWSER_SCOPE : expect.objectContaining({ conversation: f.conversation.id }));
    expect(calls.some((c: any) => c.args?.action === "compat_set")).toBe(false);
    await dialog.getByRole("checkbox", { name: "启用", exact: true }).uncheck();
    await expect(settings()).toBeDisabled();
    await expect(dialog.getByText("先启用扩展，再打开设置。", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "关闭", exact: true }).last().click();
    await page.evaluate(() => { (window as any).extensionsFixture.entries[0].optionsAvailable = false; });
    dialog = await f.open();
    await expect(settings()).toBeDisabled();
    await expect(dialog.getByText("此扩展未提供可用的独立设置页。", { exact: true })).toBeVisible();
  } finally { await f.close(); }
});

test("an installation cancelled by another window explains how to retry and keeps the current extension", async ({ page }) => {
  const f = await fixture(page);
  try {
    const dialog = await f.open(), add = dialog.getByRole("button", { name: "从应用商店添加", exact: true });
    await dialog.getByLabel("Chrome 应用商店链接或扩展 ID").fill("a".repeat(32));
    await add.click();
    await expect(dialog.getByText("Example blocker", { exact: true })).toBeVisible();
    await page.evaluate(() => (window as any).extensionsFixture.installError = "extension_changed");
    await add.click();
    await expect(dialog.getByRole("status")).toHaveText("扩展已在其他窗口更改，本次安装已取消。请重新发起安装并确认。");
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(dialog.locator("[data-extension]")).toHaveCount(1);
    await expect(add).toBeEnabled();
    await page.evaluate(() => (window as any).extensionsFixture.installError = "");
    await add.click();
    await expect(dialog.getByRole("status")).toContainText("已添加");
    await expect(dialog.locator("[data-extension]")).toHaveCount(1);
  } finally { await f.close(); }
});

test("Google rejection offers an explicit system-browser action, never claims embedded login, and follows navigation",async({page},info)=>{
  const f=await fixture(page);
  try{
    const address=f.pane.getByRole("textbox",{name:"网址或搜索",exact:true});
    const navigate=async(url:string)=>{await address.fill(url);await address.press("Enter");};
    await navigate("https://accounts.google.com/v3/signin/rejected?continue=https%3A%2F%2Fdocs.google.com%2Fdocument%2F");
    const banner=f.pane.locator(".browser-signin-notice");await expect(banner).toContainText("登录状态不会同步回这里");expect(await page.evaluate(()=>(window as any).extensionsFixture.calls.filter((c:any)=>c.command==='desktop_open_url').length)).toBe(0);
    await banner.getByRole("button",{name:"在系统浏览器继续",exact:true}).click();expect(await page.evaluate(()=>(window as any).extensionsFixture.calls.filter((c:any)=>c.command==='desktop_open_url').at(-1).args.url)).toBe("https://docs.google.com/document/");
    await page.screenshot({path:info.outputPath("google-signin-notice.png")});await banner.getByRole("button",{name:"关闭登录提示",exact:true}).click();await expect(banner).toHaveCount(0);
    await navigate("https://accounts.google.com/v3/signin/rejected?continue=https%3A%2F%2Fevil.test%2F");await expect(banner).toBeVisible();await banner.getByRole("button",{name:"在系统浏览器继续",exact:true}).click();expect(await page.evaluate(()=>(window as any).extensionsFixture.calls.filter((c:any)=>c.command==='desktop_open_url').at(-1).args.url)).toBe("https://accounts.google.com/");
    await navigate("https://accounts.google.com.evil.test/v3/signin/rejected");await expect(banner).toHaveCount(0);
    await navigate("https://example.test/");await expect(banner).toHaveCount(0);
  }finally{await f.close();}
});


test("current browser status distinguishes extension access from compatibility and never grants either automatically", async ({ page }) => {
  const f = await fixture(page);
  try {
    const dialog = await f.open();
    await dialog.getByLabel("Chrome 应用商店链接或扩展 ID").fill("a".repeat(32));
    await dialog.getByRole("button", { name: "从应用商店添加", exact: true }).click();
    const entry = dialog.locator("[data-extension]");
    await expect(entry.locator(".browser-extension-head")).toContainText("当前网页未授权");
    await expect(entry).toContainText("开启兼容模式不会授予运行权限");
    await page.evaluate(() => { (window as any).extensionsFixture.modeOutcome = "ok"; });
    const compatibility = dialog.getByRole("checkbox", { name: "扩展兼容模式", exact: true });
    await compatibility.check();
    await expect(dialog).toContainText("当前浏览器没有获准运行的已启用扩展");
    await entry.getByText("权限与兼容性", { exact: true }).click();
    await expect(entry.getByText("需先授权此浏览器", { exact: true })).toBeVisible();
    await expect(entry.getByText("需兼容模式", { exact: true })).toHaveCount(0);
    await expect(entry.locator(".browser-extension-head")).toContainText("当前网页未授权");
    await expect(dialog.getByLabel("运行位置")).toHaveValue("personal");
    // Cancelling the native scope confirmation must keep the same warning.
    await dialog.getByLabel("运行位置").selectOption("all");
    await expect(dialog.getByLabel("运行位置")).toHaveValue("personal");
    await expect(entry.locator(".browser-extension-head")).toContainText("当前网页未授权");
    await page.evaluate(() => { (window as any).extensionsFixture.widen = true; });
    await dialog.getByLabel("运行位置").selectOption("all");
    await expect(entry.locator(".browser-extension-head")).toContainText("已启用");
    await expect(dialog.getByRole("status")).toContainText("运行位置已更新，请刷新");
    await expect(dialog).not.toContainText("当前浏览器没有获准运行的已启用扩展");
    await expect(entry).not.toContainText("此扩展不会在当前对话网页运行");
    await compatibility.uncheck();
    await expect(entry).toContainText("此浏览器尚未开启网络拦截");
    await expect(dialog.getByLabel("运行位置")).toHaveValue("all");
    // Presentation-only change: no scope/compatibility mutation beyond these user actions.
    const calls = await page.evaluate(() => (window as any).extensionsFixture.calls);
    expect(calls.filter((c: any) => c.args?.action === "set").map((c: any) => c.args.scope)).toEqual(["all", "all"]);
    expect(calls.filter((c: any) => c.args?.action === "compat_set").map((c: any) => c.args.enabled)).toEqual([true, false]);
    await dialog.getByRole("checkbox", { name: "启用", exact: true }).uncheck();
    await expect(entry.locator(".browser-extension-head")).toContainText("已停用");
    await expect(entry).not.toContainText("此浏览器尚未开启网络拦截");
  } finally { await f.close(); }
});
