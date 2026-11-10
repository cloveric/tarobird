import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

test("phone notice stays compact, preserves cached reading and clears on real reconnection", async ({ page }, info) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "compact-notice-"));
  const clientDir = path.resolve("dist");
  let hub = await HubServer.start({ stateDir: root, clientDir });
  try {
    const name = "macmini — 很长的主机名称，用来检查手机上不会挤占对话阅读空间";
    await hub.profile.update({ name, revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('notice','连接提示验收','fixture')");
    const chat = await hub.store.createConversation("owner", ["notice"], "断线时继续阅读", "notice-chat");
    await hub.store.publishBotMessage("notice", { conversationId: chat.id, blocks: [{ type: "text", text: "这条已缓存的正文应一直可读。" }], status: "complete" });
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto(hub.url);
    await page.getByLabel("主机名称", { exact: true }).fill(name);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, chat.title);
    const input = page.getByRole("textbox", { name: "消息", exact: true });
    await input.fill("保留草稿");
    const port = Number(new URL(hub.url).port);
    await hub.close();
    const notice = page.locator(".phone-connection-notice");
    await expect(notice).toBeVisible(); await expect(notice).toContainText("正在重连…");
    await expect(notice.getByRole("status")).toHaveText(`正在连接「${name}」`);
    await expect(page.locator(".offline-banner,.error-banner")).toHaveCount(0);
    expect((await notice.boundingBox())!.height).toBeLessThanOrEqual(46);
    expect(await notice.evaluate(n => n.scrollWidth <= n.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("compact-offline-phone.png") });
    await notice.locator("summary").focus(); await page.keyboard.press("Enter");
    await expect(notice.locator("div")).toContainText(name);
    await expect(notice.locator("div")).toContainText("已缓存的消息仍可阅读");
    await expect(notice.locator("div")).toContainText("手机断开连接不会取消已提交给主机的任务");
    await expect(page.getByText("这条已缓存的正文应一直可读。", { exact: true })).toBeVisible();
    await expect(input).toHaveValue("保留草稿");
    hub = await HubServer.start({ stateDir: root, port, clientDir });
    await expect(notice).toHaveCount(0, { timeout: 20_000 });
    await expect(input).toHaveValue("保留草稿");
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
