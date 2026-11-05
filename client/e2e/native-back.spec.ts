import { preparePairing } from "./fixtures/pairing-invite.js";
import { openMobileSearch } from "./fixtures/mobile.js";
import { openSettings, openDevicePairing, closeDevicePairing } from "./fixtures/settings.js";
import { enterMobileChat, mobileChatAction, mobileHome } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { listenForAndroidBack, type BackBridge } from "../src/back-navigation.js";

// The production bridge dispatches this same cancellable event. No model calls.
const back = (page: Page) => page.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })));

test("phone Back respects nested dialogs, unsaved settings, busy effort saves and chat drafts", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-back-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const stateDir = path.join(root, "bot"), secret = randomBytes(32).toString("base64url");
  await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", model: "gpt-5.5", effort: "high", locale: "zh" }));
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", ["alpha", "助手", hashSecret(secret)]);
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "alpha", engine: "codex", model: "gpt-5.5", effort: "high", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => { throw new Error("unexpected_model_call"); } } });
  try {
    await hub.store.createConversation("owner", ["alpha"], "返回操作", "back");
    await page.goto(hub.url); expect(await back(page)).toBe(false); // Pairing root minimizes.
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await expect(page.locator(".connection-pill.online")).toHaveCount(1);
    await enterMobileChat(page, "返回操作");
    await expect(page.getByRole("heading", { name: "返回操作", exact: true })).toBeVisible();
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await composer.fill("尚未发送的消息");
    await mobileChatAction(page, "打开连接设置");
    await page.getByRole("button", { name: "编辑线路", exact: true }).click();
    const address = page.getByLabel("主机的直连地址（可选）", { exact: true }); await address.fill("unsaved-address");
    expect(await back(page)).toBe(true); // Direct Connection -> chat is an exit; guard the draft.
    await expect(page.getByRole("heading", { name: "放弃未保存的修改？" })).toBeVisible();
    expect(await back(page)).toBe(true); // Confirmation only, no fall-through.
    await expect(page.getByRole("heading", { name: "放弃未保存的修改？" })).toHaveCount(0);
    await expect(address).toHaveValue("unsaved-address");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    expect(await back(page)).toBe(true);
    await expect(page.getByRole("button", { name: "更多聊天操作", exact: true })).toBeFocused();
    await openSettings(page, "devices"); await openDevicePairing(page);
    await page.getByRole("button", { name: "扫描新设备配对码", exact: true }).click();
    expect(await back(page)).toBe(true);
    await expect(page.getByRole("button", { name: "扫描新设备配对码", exact: true })).toBeFocused();
    await expect(page.getByRole("navigation", { name: "设置分类" })).toBeHidden();
    expect(await back(page)).toBe(true); // Approval -> share host.
    await expect(page.getByRole("heading",{name:"让新手机或电脑扫描二维码",exact:true})).toBeVisible();
    expect(await back(page)).toBe(true); // Wizard -> device settings.
    await expect(page.getByRole("button",{name:"添加设备",exact:true})).toBeFocused();
    expect(await back(page)).toBe(true); expect(await back(page)).toBe(true);
    await expect(page.getByRole("button", { name: "关闭设置", exact: true })).toHaveCount(0);

    await mobileHome(page).getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "消息", exact: true }).click();
    await enterMobileChat(page, "返回操作");
    await mobileChatAction(page, "调整 Bot 思考强度");
    await expect(page.getByLabel("Effort 档位", { exact: true })).toHaveValue("high");
    let release!: () => void, held = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/bots/alpha/effort", async (route) => { held = true; await gate; await route.continue(); }, { times: 1 });
    try {
      await page.getByLabel("Effort 档位", { exact: true }).selectOption("xhigh");
      await page.getByRole("button", { name: "保存到此 Bot", exact: true }).click(); await expect.poll(() => held).toBe(true);
      expect(await back(page)).toBe(true);
      await expect(page.getByRole("dialog", { name: "思考强度", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "关闭思考强度", exact: true })).toBeDisabled();
    } finally { release(); }
    await expect(page.getByRole("dialog", { name: "思考强度", exact: true }).getByRole("status")).toContainText("已保存为 xhigh");
    expect(await back(page)).toBe(true);
    await expect(page.getByRole("dialog", { name: "思考强度", exact: true })).toHaveCount(0);

    expect(await back(page)).toBe(true); // Shared Bot settings -> conversation details.
    await mobileChatAction(page, "对话设置");
    await page.getByLabel("对话名称", { exact: true }).fill("未保存名称");
    expect(await back(page)).toBe(true);
    await expect(page.getByRole("dialog",{name:"放弃尚未保存的对话名称？",exact:true})).toBeVisible();
    expect(await back(page)).toBe(true);
    await expect(page.getByLabel("对话名称", { exact: true })).toHaveValue("未保存名称");
    expect(await back(page)).toBe(true);
    await page.getByRole("dialog",{name:"放弃尚未保存的对话名称？",exact:true}).getByRole("button",{name:"确认",exact:true}).click();
    await expect(page.getByRole("dialog", { name: "对话设置", exact: true })).toHaveCount(0);

    expect(await back(page)).toBe(true); // Conversation details -> chat.
    await page.getByRole("button", { name: "打开会话列表", exact: true }).click();
    expect(await back(page)).toBe(false); // Inbox is the mobile root.
    await openMobileSearch(page); await mobileHome(page).getByLabel("查找会话或 Bot", { exact: true }).fill("missing");
    await mobileHome(page).getByRole("button", { name: "搜索历史消息", exact: true }).click();
    await expect(page.locator(".search-results")).toBeVisible(); expect(await back(page)).toBe(true);
    await expect(page.locator(".search-results")).toHaveCount(0); await expect(mobileHome(page)).toBeVisible();
    await openMobileSearch(page); await mobileHome(page).getByLabel("查找会话或 Bot", { exact: true }).fill("");
    expect(await back(page)).toBe(true); // Close the expanded search before leaving the inbox.
    await expect(mobileHome(page).locator(".mh-search")).toHaveCount(0);
    expect(await back(page)).toBe(false);
    await enterMobileChat(page, "返回操作");
    await expect(composer).toHaveValue("尚未发送的消息");
    await page.evaluate(() => { document.documentElement.dataset.mobileLocked = "true"; });
    expect(await back(page)).toBe(false); // Locked app cannot mutate underlying navigation.
    await page.evaluate(() => { delete document.documentElement.dataset.mobileLocked; });
    await page.setViewportSize({ width: 1360, height: 900 });
    await expect(page.getByRole("button", { name: "打开连接设置", exact: true })).toBeVisible();
    // CSS responds before React handles the media-query event. Wait for the
    // desktop-only sidebar to mount before testing its Back policy.
    await expect(page.locator(".host-workspace:not([hidden]) .sidebar")).toBeVisible();
    expect(await back(page)).toBe(false);
    await page.screenshot({ path: info.outputPath("back-chat-preserved.png") });
    expect(errors).toEqual([]);
    expect(await hub.store.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM messages")).toEqual({ count: 0 });
  } finally { await context.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("Android bridge only minimizes unhandled Back and removes its listener on cleanup", async () => {
  let callback!: () => void, minimized = 0, removed = 0, handled = true;
  const bridge: BackBridge = { addListener: async (_, cb) => { callback = cb; return { remove: async () => { removed++; } }; }, minimizeApp: async () => { minimized++; } };
  const stop = listenForAndroidBack(bridge, () => handled); await Promise.resolve();
  callback(); expect(minimized).toBe(0);
  handled = false; callback(); expect(minimized).toBe(1);
  stop(); callback(); expect(minimized).toBe(1); expect(removed).toBe(1);
});
test("Android listener cleanup is safe when native registration finishes after unmount", async () => {
  let callback!: () => void, registered!: (value: { remove(): Promise<void> }) => void, removed = 0, minimized = 0;
  const bridge: BackBridge = { addListener: (_, cb) => { callback = cb; return new Promise((resolve) => { registered = resolve; }); }, minimizeApp: async () => { minimized++; } };
  const stop = listenForAndroidBack(bridge, () => false); stop(); callback();
  registered({ remove: async () => { removed++; } }); await Promise.resolve();
  callback(); expect(removed).toBe(1); expect(minimized).toBe(0);
});
