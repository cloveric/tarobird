import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { enterMobileChat, mobileHome } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
for (const phone of [false, true]) test(`${phone ? "phone" : "desktop"}: task-list requests are consumed before navigation`, async ({ page }) => {
  await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1360, height: 900 });
  const root = await mkdtemp(path.join(os.tmpdir(), "task-nav-")), stateDir = path.join(root, "bot");
  await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Claude',?,'claude')", [hashSecret(secret)]);
  let gateway: GatewayChannel | undefined;
  try {
    gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "bot", engine: "claude", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: "已收到" }) } });
    const a = await hub.store.createConversation("owner", ["bot"], "对话甲", "a");
    const b = await hub.store.createConversation("owner", ["bot"], "对话乙", "b");
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    const select = async (title: string) => {
      if (phone) {
        if (!await mobileHome(page).isVisible()) await page.getByRole("button", { name: "打开会话列表", exact: true }).click();
        await enterMobileChat(page, title);
      } else await page.locator(".conversation-row").filter({ hasText: title }).click();
    };
    await select(a.title);
    const field = page.getByRole("textbox", { name: "消息", exact: true });
    const dialog = page.getByRole("dialog", { name: "子代理与后台任务", exact: true });
    await field.fill("/tasks"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(dialog).toBeVisible(); await dialog.getByRole("button", { name: "关闭任务列表", exact: true }).click();
    await select(b.title); await select(a.title);
    await expect(field).toBeVisible(); await expect(dialog).toHaveCount(0);
    // A new deliberate menu request must still work after the previous one was consumed.
    await page.getByRole("button", { name: "更多聊天操作", exact: true }).click();
    await page.getByRole("button", { name: "子代理与后台任务", exact: true }).click();
    await expect(dialog).toBeVisible(); await dialog.getByRole("button", { name: "关闭任务列表", exact: true }).click();
    await select(b.title); await select(a.title); await expect(dialog).toHaveCount(0);
    if (!phone) {
      const search = page.getByRole("textbox", { name: "搜索历史消息", exact: true });
      await search.fill("尚无历史的查找"); await search.press("Enter");
      await expect(page.locator(".search-results")).toBeVisible();
      await page.getByRole("button", { name: "关闭搜索", exact: true }).click();
      await expect(field).toBeVisible(); await expect(dialog).toHaveCount(0);
    }
    expect((await hub.store.snapshot("owner", a.id)).messages).toHaveLength(0);
  } finally { await page.close(); await gateway?.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
