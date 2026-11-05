import { preparePairing } from "./fixtures/pairing-invite.js";
import { waitForClientOnline, enterMobileChat } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { GatewayGroupModeStore } from "../../src/gateway/group-mode.js";

async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page);
}
test("desktop and phone share native group settings without exposing Feishu access controls", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "client-command-parity-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  const config = JSON.stringify({ engine: "codex", locale: "zh", groupMode: { enabled: false } }); await writeFile(path.join(stateDir, "config.json"), config);
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手',?)", [hashSecret(secret)]);
  const gateway = await attachGateway({ stateDir, url: hub.url.replace("http", "ws") + "/instance", botId: "alpha", secret, runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: "共享处理器回复" }) } });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage();
  try {
    const c = await hub.store.createConversation("owner", ["alpha"], "群回复设置", "group", { type: "group" });
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "config", text: "/config", attachments: [], mentions: ["alpha"] });
    for (const page of [desktop, phone]) {
      await pair(page, hub); await enterMobileChat(page, c.title);
      await expect(page.getByRole("button", { name: "全量监听", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /允许本群/ })).toHaveCount(0);
      await expect(page.locator(".message-blocks").last()).not.toContainText("/invite user");
    }
    const store = new GatewayGroupModeStore(stateDir);
    await desktop.getByRole("button", { name: "全量监听", exact: true }).click();
    await expect.poll(() => store.mode(c.id)).toBe("all");
    await expect(phone.locator(".message-blocks").last()).toContainText("回复模式为「all」（仅为兼容保留，不改变投递）");
    await phone.getByRole("button", { name: "仅 @", exact: true }).click();
    await expect.poll(() => store.mode(c.id)).toBe("at");
    await expect(desktop.locator(".message-blocks").last()).toContainText("回复模式为「at」");
    expect(await readFile(path.join(stateDir, "config.json"), "utf8")).toBe(config);
    for (const [page, device] of [[desktop, "desktop"], [phone, "phone"]] as const) {
      await page.screenshot({ path: info.outputPath(`command-parity-${device}.png`) });
      await page.reload(); await waitForClientOnline(page); await enterMobileChat(page, c.title);
      await expect(page.locator(".message-blocks").last()).toContainText("回复模式为「at」");
    }
    for (const page of [desktop, phone]) {
      await page.getByRole("textbox", { name: "消息", exact: true }).fill("/help");
      await expect(page.locator(".command-menu").getByRole("button", { name: /^\/help\s/ })).toBeVisible();
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("");
      await expect(page.locator(".command-menu")).toHaveCount(0);
    }
  } finally { await desktopContext.close(); await phoneContext.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
