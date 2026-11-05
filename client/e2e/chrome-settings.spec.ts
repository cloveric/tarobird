import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { openBotSettings } from "./fixtures/bot-settings.js";

test("Chrome setting works on phone/desktop with conflicts, offline and old-host feedback", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chrome-ui-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" }));
  await writeFile(path.join(stateDir, "session.json"), "preserved-session");
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','Claude 测试',?,'claude')", [hashSecret(secret)]);
  let engineCalls = 0;
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "alpha", engine: "claude", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => { engineCalls++; return { text: "unused" }; } } });
  const contexts = await Promise.all([1360, 390].map(width => browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" })));
  const [desktop, phone] = await Promise.all(contexts.map(context => context.newPage()));
  const errors: string[] = [];
  try {
    await hub.store.createConversation("owner", ["alpha"], "浏览器设置验收", "direct");
    for (const page of [desktop!, phone!]) {
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
      await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
      await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
      await waitForClientOnline(page); await selectConversation(page, "浏览器设置验收"); await openBotSettings(page);
      await page.getByRole("button", { name: "设置 Chrome 浏览器联动", exact: true }).click();
      await expect(page.getByRole("switch", { name: "允许此 Bot 使用 Chrome" })).not.toBeChecked();
    }
    await phone!.getByRole("switch").check();
    await phone!.getByRole("button", { name: "保存到此 Bot", exact: true }).click();
    await expect(phone!.getByRole("status")).toContainText("已保存");
    await desktop!.getByRole("switch").check();
    await desktop!.getByRole("button", { name: "保存到此 Bot", exact: true }).click();
    await expect(desktop!.getByRole("alert")).toContainText("其他设备或本机已修改设置");
    await desktop!.getByRole("button", { name: "重新读取", exact: true }).click();
    await expect(desktop!.getByRole("switch")).toBeChecked();
    for (const [page, name] of [[desktop!, "desktop"], [phone!, "phone"]] as const) {
      await expect(page.getByText("此开关控制 Bot 的联动权限，不代表扩展已连接。网站访问仍遵循 Claude 与扩展的权限设置。", { exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`chrome-${name}.png`) });
    }
    await phone!.getByRole("button", { name: "关闭浏览器联动设置", exact: true }).click();
    await phone!.getByRole("button", { name: "设置 Chrome 浏览器联动", exact: true }).click();
    await expect(phone!.getByRole("switch")).toBeChecked();
    await phone!.getByRole("switch").uncheck(); await phone!.getByRole("button", { name: "保存到此 Bot", exact: true }).click();
    await expect(phone!.getByRole("status")).toContainText("已保存");
    expect(JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")).claudeChrome).toBe(false);
    expect(await readFile(path.join(stateDir, "session.json"), "utf8")).toBe("preserved-session");
    expect(engineCalls).toBe(0); expect(await hub.store.db.get("SELECT COUNT(*) AS count FROM messages")).toEqual({ count: 0 });
    await phone!.getByRole("button", { name: "关闭浏览器联动设置", exact: true }).click();
    await phone!.route("**/api/bots/alpha/chrome", route => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) }));
    await phone!.getByRole("button", { name: "设置 Chrome 浏览器联动", exact: true }).click();
    await expect(phone!.getByRole("alert")).toContainText("请更新主机版本");
    await phone!.getByRole("button", { name: "关闭浏览器联动设置", exact: true }).click(); await phone!.unroute("**/api/bots/alpha/chrome");
    await gateway.disconnect();
    await phone!.getByRole("button", { name: "设置 Chrome 浏览器联动", exact: true }).click();
    await expect(phone!.getByRole("alert")).toContainText("Bot 当前离线"); expect(errors).toEqual([]);
  } finally { for (const context of contexts) await context.close().catch(() => undefined); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
