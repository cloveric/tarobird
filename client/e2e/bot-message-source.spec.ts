import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { HubPromptQueue } from "../../src/hub/prompt-queue.js";
import { showDisconnectedBots, waitForClientOnline, selectConversation, mobileHome } from "./fixtures/mobile.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";
import { settleReadingLayout } from "./fixtures/reading-position.js";

test("signed Bot origin remains visible after sync and reload on desktop and phone", async ({ browser }, info) => {
  test.setTimeout(120_000); // Three paired layouts, navigation, attachments and both locales.
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-origin-ui-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.profile.update({ name: "example-host", revision: 0 });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('receiver','接收助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["receiver"], "来自 example-mac 助手的协作", "origin-ui");
    const source = { hostId: "hub_source", hostName: "example-mac", botId: "source_bot", botName: "发送助手", requestId: "ui_fixture", hops: 2 };
    const text = "请核对这份协作任务。" + "这是用于验证协作记录的完整正文。".repeat(20) + "\n\n完整报告末尾 / Full report ending";
    const bytes = Buffer.from("完整协作附件 / Complete collaboration attachment");
    const attachment = await hub.attachments.importForBot("receiver", { conversationId: chat.id, name: "report.txt", mime: "text/plain", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
    const sent = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "origin", text, attachments: [attachment], botSource: source });
    const failed = await hub.store.publishBotMessage("receiver", { conversationId: chat.id, replyTo: sent.message.id, status: "error", blocks: [{ type: "text", text: "协作处理失败" }] });
    const other = await hub.store.createConversation("owner", ["receiver"], "普通对话", "ordinary-ui");
    await hub.store.sendMessage("owner", { conversationId: other.id, clientMsgId: "ordinary", text: "普通消息始终展开", attachments: [] });
    for (const width of [1360, 390, 320]) {
      const phone = width < 760;
      const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone });
      const page = await context.newPage();
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      try {
        await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
        await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
        await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
        await waitForClientOnline(page); await selectConversation(page, chat.title);
        const message = page.locator(`[data-message-id="${sent.message.id}"]`), badge = message.locator(".bot-message-source");
        await expect(badge).toContainText("来自 example-mac · 发送助手"); await expect(badge).toContainText("转发 2 层");
        await expect(badge).toHaveAttribute("title", "hub_source/source_bot"); await expect(badge).toBeInViewport();
        const disclosure = message.getByRole("region", { name: "协作消息", exact: true });
        const toggle = disclosure.locator(".bot-message-disclosure-toggle");
        const settledRows = () => expect.poll(async () => {
          const first = await message.boundingBox(), next = await page.locator(`[data-message-id="${failed.id}"]`).boundingBox();
          return !!first && !!next && next.y >= first.y + first.height - 1;
        }).toBe(true);
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await expect(disclosure.locator(".message-blocks")).toHaveCount(0);
        await expect(disclosure.locator(".bot-message-disclosure-preview")).toContainText("请核对这份协作任务。");
        await expect(page.locator(`[data-message-id="${failed.id}"]`).getByText("协作处理失败", { exact: true })).toBeVisible();
        await toggle.click();
        await settledRows();
        await expect(disclosure.getByText("完整报告末尾 / Full report ending", { exact: true })).toBeVisible();
        await disclosure.getByRole("region", { name: "report.txt", exact: true }).getByRole("button", { name: phone ? "预览 report.txt" : "预览", exact: true }).click();
        const preview = page.getByRole("dialog", { name: "文件预览", exact: true });
        await expect(preview.locator("pre")).toHaveText(bytes.toString());
        await page.keyboard.press("Escape"); await expect(preview).toBeHidden();
        await toggle.click();
        await expect(disclosure.locator(".message-blocks")).toHaveCount(1);
        await expect(disclosure.locator(".message-blocks")).toBeHidden();
        // Reply ownership navigation reveals the requested original, once.
        await page.locator(`[data-message-id="${failed.id}"]`).getByRole("button", { name: "查看回复对应的消息", exact: true }).click();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await toggle.click();
        await selectConversation(page, other.title);
        await expect(page.getByRole("main").getByText("普通消息始终展开", { exact: true })).toBeVisible();
        await expect(page.locator(".bot-message-disclosure")).toHaveCount(0);
        await selectConversation(page, chat.title);
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        // Conversation navigation animates on phones; inspect the settled box.
        await expect.poll(async () => { const box = await disclosure.boundingBox(); return box ? box.x >= 0 && box.x + box.width <= page.viewportSize()!.width : false; }).toBe(true);
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
        await page.screenshot({ path: info.outputPath(`bot-origin-${width}.png`), animations: "disabled" });
        await page.reload(); await waitForClientOnline(page); await selectConversation(page, chat.title);
        await expect(badge).toBeVisible(); await expect(message).toContainText("请核对这份协作任务。");
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await expect(disclosure.locator(".message-blocks")).toHaveCount(0);
        await openSettings(page); await page.locator("#language").selectOption("en"); await closeSettings(page, true);
        if (phone) {
          await mobileHome(page).getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /^Message/ }).click();
          await mobileHome(page).locator(".mh-row").filter({ has: page.getByText(chat.title, { exact: true }) }).click();
        }
        const english = message.getByRole("region", { name: "Collaboration message", exact: true });
        await english.getByRole("button", { name: "Expand collaboration message", exact: true }).click();
        await expect(english.getByRole("button", { name: "Collapse collaboration message", exact: true })).toBeVisible();
        await expect(english.getByRole("region", { name: "report.txt", exact: true }).getByRole("button", { name: phone ? "Preview report.txt" : "Preview", exact: true })).toBeVisible();
        await settledRows();
        await page.screenshot({ path: info.outputPath(`bot-origin-en-${width}.png`), animations: "disabled" });
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    }
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const state of ["cancelled", "unsupported"] as const) test(`Bot input status remains visible when ${state}`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-input-status-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.profile.update({ name: "example-host", revision: 0 });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('receiver','接收助手','fixture','codex')");
    const queue = new HubPromptQueue(hub.store); await queue.registerWorker("receiver", true);
    const chat = await hub.store.createConversation("owner", ["receiver"], "协作状态", "status-ui");
    const sent = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "origin", text: "长协作报告。".repeat(60), attachments: [], botSource: { hostId: "hub_source", hostName: "example-host", botId: "sender", botName: "发送助手", requestId: "status_fixture", hops: 1 } });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page); await selectConversation(page, chat.title);
    const row = page.locator(`[data-message-id="${sent.message.id}"]`);
    await expect(row.getByRole("button", { name: "展开协作消息", exact: true })).toBeVisible();
    if (state === "cancelled") {
      const snapshot = await queue.read("owner", "receiver", chat.id);
      await queue.mutate("owner", chat.id, { botId: "receiver", requestId: "cancel-fixture", revision: snapshot.revision, action: { type: "cancel", messageId: sent.message.id } });
    } else await queue.claim("receiver", true, false, () => true, false);
    await expect(row.locator(".bot-message-disclosure")).toHaveCount(0);
    const notice = row.getByText(state === "cancelled" ? "已取消排队，未发送给 Bot。" : "目标 Bot 的运行环境尚不支持 Bot 间消息，此消息未作为普通输入派发。请更新目标 Bot 后再发送。", { exact: true });
    await expect(notice).toBeAttached(); await settleReadingLayout(page.locator(".message-scroll"));
    await notice.scrollIntoViewIfNeeded(); await expect(notice).toBeVisible();
    expect(await hub.store.db.get("SELECT status FROM deliveries WHERE message_id=?", [sent.message.id])).toEqual({ status: state === "cancelled" ? "cancelled" : "failed" });
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});
