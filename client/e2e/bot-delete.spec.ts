import { preparePairing } from "./fixtures/pairing-invite.js";
import { revealDesktopAction } from "./fixtures/desktop-actions.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import type { BotManager } from "../../src/hub/bot-manager.js";
import { mobileHome, waitForClientOnline, selectConversation, openWorkspacePage } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
const settings = (page: Page) => page.getByRole("dialog", { name: "Bot 设置", exact: true });
const confirmation = (page: Page) => page.getByRole("dialog", { name: "删除 Bot", exact: true });
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
}
async function openSettings(page: Page, id: string, name: string) {
  if (page.viewportSize()!.width <= 760) {
    await mobileHome(page).getByRole("navigation").getByRole("button", { name: "Bot", exact: true }).click();
    await mobileHome(page).getByRole("button", { name: `${name} 的 Bot 设置`, exact: true }).click();
  } else {
    await page.locator(`.host-workspace:not([hidden]) [data-bot-id="${id}"] .bot-identity`).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Bot 设置", exact: true }).click();
  }
}
for (const phoneDeletes of [true, false]) test(`Bot deletion confirms effects and synchronizes on both devices (phone: ${phoneDeletes})`, async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "delete-bot-ui-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), managedBots: { entrypoint: path.resolve("../tests/fixtures/managed-bot-worker.mjs"), env: { ...process.env, CODEX_EXECUTABLE: process.execPath } } });
  const manager = (hub as unknown as { botManager: BotManager }).botManager;
  const bot = await manager.create("owner", { requestId: "delete", name: "待删除助手", engine: "codex", model: "", effort: "", workspace: "" });
  const peer = await manager.create("owner", { requestId: "keep", name: "保留助手", engine: "codex", model: "", effort: "", workspace: "" });
  const chat = await hub.store.createConversation("owner", [bot.id], "历史仍在", "history");
  await hub.store.publishBotMessage(bot.id, { conversationId: chat.id, blocks: [{ type: "text", text: "要保留的回答" }], status: "complete" });
  const group = await hub.store.createConversation("owner", [bot.id, peer.id], "继续协作", "group");
  const desktop = await browser.newPage(), phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const source = phoneDeletes ? phone : desktop, other = phoneDeletes ? desktop : phone;
  try {
    await pair(desktop, hub); await pair(phone, hub);
    await openSettings(source, bot.id, bot.name);
    await settings(source).getByRole("button", { name: "删除 Bot", exact: true }).click();
    await expect(confirmation(source)).toContainText("历史消息、附件和主机工作区文件保留");
    await expect(confirmation(source)).toContainText(bot.name);
    await source.screenshot({ path: info.outputPath("delete-confirmation.png"), animations: "disabled" });
    await confirmation(source).getByRole("button", { name: "取消", exact: true }).click();
    expect(await hub.store.bots("owner")).toHaveLength(2);
    await settings(source).getByRole("button", { name: "删除 Bot", exact: true }).click();
    await confirmation(source).getByRole("button", { name: "确认删除 Bot", exact: true }).click();
    await expect(settings(source)).toHaveCount(0);
    await expect.poll(async () => (await hub.store.bots("owner")).map(b => b.id)).toEqual([peer.id]);
    await expect.poll(async () => (await hub.store.conversations("owner")).find(c => c.id === chat.id)?.archived).toBe(true);
    await selectConversation(other, group.title);
    await expect(other.locator('.conversation-header')).not.toContainText(bot.name);
    // A refreshed ready frame must keep the Bot retired, not just hide it locally.
    for (const page of [desktop, phone]) {
      await page.reload(); await waitForClientOnline(page);
      await openSettings(page, peer.id, peer.name);
      await expect(settings(page)).toContainText(peer.name);
      await settings(page).getByRole("button", { name: "关闭 Bot 设置", exact: true }).click();
      if (page.viewportSize()!.width <= 760) await openWorkspacePage(page, "已归档对话");
      else { await revealDesktopAction(page, "已归档对话"); await page.getByRole("button", { name: /^已归档对话/ }).filter({ visible: true }).click(); }
      const archived = page.getByRole("dialog", { name: "已归档对话", exact: true }).getByRole("article", { name: chat.title, exact: true });
      await expect(archived.getByRole("button", { name: "恢复", exact: true })).toBeDisabled();
      await archived.getByRole("button", { name: "查看记录", exact: true }).click();
      await expect(page.locator(".message-body").getByText("要保留的回答", { exact: true })).toBeVisible();
      await expect(page.locator(".message-meta")).toContainText(bot.name);
      await expect(page.locator(".archived-notice")).toContainText("Bot 已删除");
      await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveCount(0);
    }
    expect((await hub.store.conversations("owner")).find(c => c.id === group.id)?.botIds).toEqual([peer.id]);
    expect(await hub.store.db.get("SELECT id FROM messages WHERE conversation_id=? AND blocks_json LIKE '%要保留的回答%'", [chat.id])).toBeTruthy();
  } finally { await desktop.close(); await phone.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
