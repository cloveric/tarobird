import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, waitForClientOnline, selectConversation } from "./fixtures/mobile.js";

test("signed Bot origin remains visible after sync and reload on desktop and phone", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-origin-ui-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('receiver','接收助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["receiver"], "来自 example-mac 助手的协作", "origin-ui");
    const source = { hostId: "hub_source", hostName: "example-mac", botId: "source_bot", botName: "发送助手", requestId: "ui_fixture", hops: 2 };
    const sent = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "origin", text: "请核对这份协作任务。", attachments: [], botSource: source });
    const failed = await hub.store.publishBotMessage("receiver", { conversationId: chat.id, replyTo: sent.message.id, status: "error", blocks: [{ type: "text", text: "协作处理失败" }] });
    for (const phone of [false, true]) {
      const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1360, height: 900 }, isMobile: phone, hasTouch: phone });
      const page = await context.newPage();
      try {
        await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
        await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
        await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
        await waitForClientOnline(page); await selectConversation(page, chat.title);
        const message = page.locator(`[data-message-id="${sent.message.id}"]`), badge = message.locator(".bot-message-source");
        await expect(badge).toContainText("来自 example-mac · 发送助手"); await expect(badge).toContainText("转发 2 层");
        await expect(badge).toHaveAttribute("title", "hub_source/source_bot"); await expect(badge).toBeInViewport();
        for (const id of [sent.message.id, failed.id]) {
          const row = page.locator(`[data-message-id="${id}"]`);
          if (phone) {
            await row.focus(); await page.keyboard.press("Enter");
            const sheet = page.getByRole("dialog", { name: "消息操作", exact: true });
            await expect(sheet).toBeVisible();
            await expect(sheet.getByRole("button", { name: "重新发送消息", exact: true })).toHaveCount(0);
            await page.keyboard.press("Escape");
          } else await expect(row.getByRole("button", { name: "重新发送消息", exact: true })).toHaveCount(0);
        }
        expect((await hub.store.snapshot("owner", chat.id)).messages.filter(m => m.authorType === "user")).toHaveLength(1);
        await page.screenshot({ path: info.outputPath(`bot-origin-${phone ? "phone" : "desktop"}.png`), animations: "disabled" });
        await page.reload(); await waitForClientOnline(page); await selectConversation(page, chat.title);
        await expect(badge).toBeVisible(); await expect(message).toContainText("请核对这份协作任务。");
      } finally { await context.close(); }
    }
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});
