import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { openGoogleDocs } from "../../src/gdocs/cli.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { messageAction } from "./fixtures/message-actions.js";
import { openSettings } from "./fixtures/settings.js";

for (const device of ["desktop", "phone", "ios-wide", "android-wide"] as const) test(`Google Docs setup is discoverable and missing config is actionable (${device})`, async ({ page }, info) => {
  const phone = device === "phone", mobile = device !== "desktop";
  const root = await mkdtemp(path.join(os.tmpdir(), "gdocs-ui-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), googleDocs: () => openGoogleDocs(root) });
  try {
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["bot"], "文档导出", "docs");
    const message = await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: "Google 文档导出测试" }] });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page); await showDisconnectedBots(page);
    await selectConversation(page, chat.title);
    await messageAction(page, page.locator(`[data-message-id="${message.id}"]`), "导出到 Google 文档");
    await expect(page.getByRole("alert")).toContainText("尚未配置 Google 文档");
    await expect(page.getByText("internal_error", { exact: true })).toHaveCount(0);
    if (phone) await page.getByRole("button", { name: "关闭消息操作", exact: true }).click();
    // Simulate native platform identity at a wide viewport: rotation/tablet
    // size must not expose terminal setup on iOS/Android. No native OAuth test.
    if (device.endsWith("-wide")) await page.evaluate(platform => {
      (window as unknown as { Capacitor: { getPlatform: () => string } }).Capacitor.getPlatform = () => platform;
    }, device.split("-")[0]!);
    await openSettings(page, "general");
    const panel = page.locator(".google-docs-settings");
    if (mobile) {
      await expect(panel).toContainText("请在主机的桌面版完成配置，配置后即可在手机上导出。");
      await expect(panel.locator("button, details, pre")).toHaveCount(0);
    } else {
      await panel.getByRole("button", { name: "检查 Google 文档配置" }).click();
      await expect(panel.getByRole("status")).toContainText("尚未配置 Google 文档");
      await panel.locator("summary").click();
      await expect(panel).toContainText("OAuth 登录仍在主机终端发起");
      await expect(panel).toContainText("tarobot gdocs configure --client-file");
      await expect(panel.getByRole("link", { name: "Google 官方配置说明" })).toHaveAttribute("href", /^https:\/\/developers\.google\.com\//);
    }
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await panel.screenshot({ path: info.outputPath(`google-docs-${device}.png`) });
    await page.getByLabel("语言", { exact: true }).selectOption("en");
    if (mobile) {
      await expect(panel).toContainText("Complete setup in the desktop app on your host. You can then export from your phone.");
      await expect(panel.locator("button, details, pre")).toHaveCount(0);
    } else {
      await expect(panel.getByRole("button", { name: "Check Google Docs setup" })).toBeVisible();
      await expect(panel).toContainText("Google Docs is not configured");
    }
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
