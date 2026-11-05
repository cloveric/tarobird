import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { UsageStore } from "../../src/state/usage-store.js";
import { waitForClientOnline, enterMobileChat } from "./fixtures/mobile.js";

for (const [profile, width, locale] of [["desktop", 1360, "zh"], ["phone", 390, "zh"], ["phone-en", 320, "en"]] as const) {
  test(`${profile}: command results stay readable in cards, including existing text history`, async ({ browser }, info) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "command-cards-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "kimi", locale }));
    const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','用量助手',?)", [hashSecret(secret)]);
    let modelCalls = 0;
    const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "alpha", secret, runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => { modelCalls++; return { text: "Unexpected model request" }; } } });
    const context = await browser.newContext({ viewport: { width, height: 844 }, ...(width < 760 ? { isMobile: true, hasTouch: true } : {}) });
    const page = await context.newPage();
    try {
      const chat = await hub.store.createConversation("owner", ["alpha"], "命令卡片", "cards");
      const old = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text: "累计用量（本实例）：\n• 可计量请求数：0\n• 未返回 token 明细的请求：5\n• 说明：没有返回 token 明细，不会假算为 0。" }] });
      const reset = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text: "当前聊天的会话已重置。" }] });
      await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
      await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
      await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page); await enterMobileChat(page, chat.title);
      const oldCard = page.locator(`[data-message-id="${old.id}"] .rich-card`);
      await expect(oldCard.locator("p")).toContainText("未返回 token 明细的请求：5");
      await expect(oldCard.locator("p")).toHaveCSS("white-space", "pre-line");
      await expect(page.locator(`[data-message-id="${reset.id}"] .rich-card`)).toHaveText("当前聊天的会话已重置。");
      // The receipt remains the original text in the store, so copy/forward and
      // cross-device history do not depend on a database migration.
      expect((await hub.store.snapshot("owner", chat.id)).messages.find(m => m.id === old.id)?.blocks[0]?.type).toBe("text");
      const send = async (command: string) => {
        await page.getByRole("textbox", { name: "消息", exact: true }).fill(command);
        await page.getByRole("button", { name: "发送消息", exact: true }).click();
        await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("");
        await expect.poll(async () => (await hub.store.pendingForBot("alpha")).length).toBe(0);
      };
      const usageCards = page.locator(".rich-card").filter({ has: page.locator(".card-header", { hasText: "/usage" }) });
      await send("/usage");
      await expect(usageCards.last()).toContainText(locale === "zh" ? "暂无用量数据" : "No usage data yet");
      const usage = new UsageStore(stateDir);
      for (let i = 0; i < 5; i++) await usage.recordUnmetered(new Date("2026-10-11T13:08:36.723Z"));
      await send("/usage");
      const latest = usageCards.last();
      await expect(latest).toContainText(locale === "zh" ? "不能按 0 计算" : "unknown, not zero");
      await expect(latest).toContainText("Kimi ACP"); await expect(latest).not.toContainText("$0");
      await expect(latest.locator(".card-column strong").last()).toHaveText("5");
      await expect(latest).toContainText("2026-10-11 13:08:36 UTC");
      await latest.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`${profile}-unknown.png`) });
      await usage.record({ inputTokens: 12345, outputTokens: 678, cachedTokens: 90, costUsd: 0.125 });
      await send("/usage"); await expect(latest).toContainText("12,345"); await expect(latest).toContainText("$0.1250");
      await expect(latest.locator(".markdown-pending")).toHaveCount(0);
      const overflow = await latest.evaluate(card => [...card.querySelectorAll<HTMLElement>(".card-column")].some(column => column.scrollWidth > column.clientWidth + 1));
      expect(overflow).toBe(false);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await latest.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`${profile}-measured.png`) });
      if (width < 760) { await page.evaluate(() => document.documentElement.dataset.theme = "dark"); await page.screenshot({ path: info.outputPath(`${profile}-dark.png`) }); }
      await send("/status");
      const status = page.locator(".rich-card").filter({ has: page.locator(".card-header", { hasText: "/status" }) }).last();
      await expect(status).toContainText(locale === "zh" ? "会话状态" : "Conversation status");
      await expect(status.getByRole("button", { name: locale === "zh" ? "打开配置" : "Open config", exact: true })).toHaveCount(1);
      await send("/help");
      const help = page.locator(".rich-card").filter({ has: page.locator(".card-header", { hasText: "/help" }) }).last();
      await expect(help.locator("li").filter({ hasText: "/usage" })).toHaveCount(1);
      await expect(help.locator("li").filter({ hasText: "/cron" })).toHaveCount(1);
      const own = page.locator(".message.user").last();
      await expect(own).toContainText("/help"); await expect(own.locator(".rich-card")).toHaveCount(0);
      expect(modelCalls).toBe(0);
      await page.reload(); await waitForClientOnline(page); await enterMobileChat(page, chat.title);
      await expect(help.locator("li").filter({ hasText: "/usage" })).toHaveCount(1);
    } finally { await context.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
  });
}
